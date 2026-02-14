import { startKeepAlive, stopKeepAlive } from './bg-utils.js';

const KEEP_ALIVE_SAFETY_TIMEOUT_MS = 30 * 60 * 1000;
let keepAliveSafetyTimer = null;

function armKeepAliveSafetyTimer() {
  if (keepAliveSafetyTimer) {
    clearTimeout(keepAliveSafetyTimer);
  }
  keepAliveSafetyTimer = setTimeout(() => {
    console.warn('[Background] KeepAlive safety timeout reached. Stopping rank-check session.');
    stopKeepAlive();
    keepAliveSafetyTimer = null;
  }, KEEP_ALIVE_SAFETY_TIMEOUT_MS);
}

function clearKeepAliveSafetyTimer() {
  if (keepAliveSafetyTimer) {
    clearTimeout(keepAliveSafetyTimer);
    keepAliveSafetyTimer = null;
  }
}

function waitForTabNavigation(tabId, url, timeoutMs = 15000) {
  return new Promise(async (resolve) => {
    let settled = false;
    let timeoutId = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (timeoutId) clearTimeout(timeoutId);
      resolve();
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    timeoutId = setTimeout(finish, timeoutMs);

    try {
      await chrome.tabs.update(tabId, { url });
    } catch {
      finish();
    }
  });
}

export async function handleCoupangRankCheckStart(message, sendResponse) {
  startKeepAlive();
  armKeepAliveSafetyTimer();

  try {
    const win = await chrome.windows.create({
      incognito: true,
      width: 406,
      height: 900,
      url: 'about:blank',
    });

    await chrome.windows.update(win.id, { state: 'minimized' });

    const windowId = win.id;
    const tabId = win.tabs?.[0]?.id;

    if (!windowId || !tabId) {
      throw new Error('Failed to create rank check window/tab');
    }

    console.log('[Background] Coupang rank check started', { windowId, tabId });
    sendResponse({ success: true, windowId, tabId });
  } catch (e) {
    clearKeepAliveSafetyTimer();
    stopKeepAlive();
    console.error('[Background] coupangRankCheckStart error:', e);
    sendResponse({ success: false, error: String(e) });
  }
}

export async function handleCoupangRankCheckKeyword(message, sendResponse) {
  try {
    armKeepAliveSafetyTimer();

    const { tabId, keyword, productId, itemId, searchDepth, isAdProduct } = message.payload;

    if (!tabId || !keyword || !productId) {
      throw new Error('Missing required payload fields');
    }

    const targetProductId = String(productId);
    const targetItemId = itemId != null ? String(itemId) : null;

    let adRank = null;
    let organicRank = null;
    let currentAdPosition = 0;
    let currentOrganicPosition = 0;
    let actualPages = 0;

    const maxPages = searchDepth <= 10 ? searchDepth : Math.ceil(searchDepth / 45);

    const encodedKeyword = encodeURIComponent(keyword);
    let foundTarget = false;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (foundTarget) break;

      const searchUrl =
        pageNum === 1
          ? `https://www.coupang.com/np/search?q=${encodedKeyword}`
          : `https://www.coupang.com/np/search?q=${encodedKeyword}&page=${pageNum}`;

      await waitForTabNavigation(tabId, searchUrl, 15000);

      let pageProducts = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
              const products = [];
              let productElements = document.querySelectorAll('li.ProductUnit_productUnit__Qd6sv');
              if (productElements.length === 0) {
                productElements = document.querySelectorAll('#product-list > li');
              }
              if (productElements.length === 0) {
                productElements = document.querySelectorAll('li[class*="search-product"]');
              }

              for (const el of productElements) {
                const link = el.querySelector('a[href*="/vp/products/"], a[href*="/products/"]');
                if (!link) continue;

                const href = link.getAttribute('href') || '';
                const pidMatch = href.match(/\/(?:vp\/)?products\/(\d+)/);
                if (!pidMatch) continue;

                const itemIdMatch = href.match(/itemId=(\d+)/);
                const vendorItemIdMatch = href.match(/vendorItemId=(\d+)/);
                let adBadge = el.querySelector('.AdMark_adMark__KPMsC');
                if (!adBadge) adBadge = el.querySelector('[class*="AdMark_adMark"]');

                products.push({
                  productId: pidMatch[1],
                  itemId: itemIdMatch ? itemIdMatch[1] : null,
                  vendorItemId: vendorItemIdMatch ? vendorItemIdMatch[1] : null,
                  isAd: adBadge !== null,
                });
              }

              return products;
            },
          });

          if (results?.[0]?.result) {
            pageProducts = results[0].result;
            if (pageProducts.length >= 20) break;
          }
        } catch (e) {
          console.log(`[Background] executeScript attempt ${attempt + 1} failed:`, e?.message || e);
        }
      }

      if (pageProducts.length === 0) {
        console.log(`[Background] page ${pageNum}: no products, stopping`);
        break;
      }

      actualPages = pageNum;
      console.log(`[Background] page ${pageNum}: ${pageProducts.length} products`);

      for (const product of pageProducts) {
        let isMatch = false;
        if (String(product.productId) === targetProductId) {
          if (targetItemId) {
            if (product.itemId && String(product.itemId) === targetItemId) isMatch = true;
          } else {
            isMatch = true;
          }
        }

        if (product.isAd) {
          if (isAdProduct) {
            currentAdPosition += 1;
            if (isMatch && adRank === null) {
              adRank = currentAdPosition;
              console.log(`[Background] ad rank found: ${adRank}`);
            }
          }
        } else {
          currentOrganicPosition += 1;
          if (isMatch && organicRank === null) {
            organicRank = currentOrganicPosition;
            console.log(`[Background] organic rank found: ${organicRank}`);
          }
        }

        if (isAdProduct) {
          if (adRank !== null && organicRank !== null) {
            foundTarget = true;
            break;
          }
        } else if (organicRank !== null) {
          foundTarget = true;
          break;
        }

        if (searchDepth > 10 && currentAdPosition + currentOrganicPosition >= searchDepth) {
          foundTarget = true;
          break;
        }
      }

      if (pageNum < maxPages && !foundTarget) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const rankToPageInfo = (rank) => {
      if (rank === null) return null;
      if (rank <= 49) return { page: 1, position: rank };
      const remaining = rank - 49;
      return {
        page: 2 + Math.floor((remaining - 1) / 45),
        position: ((remaining - 1) % 45) + 1,
      };
    };

    console.log(
      `[Background] keyword "${keyword}" done - ad: ${currentAdPosition}, organic: ${currentOrganicPosition}`,
    );

    sendResponse({
      success: true,
      data: {
        keyword,
        productId,
        adRank,
        organicRank,
        adPageInfo: rankToPageInfo(adRank),
        organicPageInfo: rankToPageInfo(organicRank),
        totalAdCount: currentAdPosition,
        totalOrganicCount: currentOrganicPosition,
        searchedPages: actualPages,
        searchDepth,
        deviceType: 'Mobile',
      },
    });
  } catch (e) {
    console.error('[Background] coupangRankCheckKeyword error:', e);
    sendResponse({ success: false, error: String(e) });
  }
}

export async function handleCoupangRankCheckEnd(message, sendResponse) {
  try {
    clearKeepAliveSafetyTimer();
    stopKeepAlive();

    const { windowId } = message.payload || {};
    if (windowId) {
      try {
        await chrome.windows.remove(windowId);
      } catch (e) {
        console.log('[Background] failed to close incognito window:', e?.message || e);
      }
    }

    console.log('[Background] Coupang rank check ended');
    sendResponse({ success: true });
  } catch {
    clearKeepAliveSafetyTimer();
    sendResponse({ success: true });
  }
}
