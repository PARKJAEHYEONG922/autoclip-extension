// 쿠팡 순위 체크 핸들러 (시크릿 모드 + executeScript)

import { startKeepAlive, stopKeepAlive } from './bg-utils.js';

// 순위 체크 시작 - 쿠키 초기화 + 시크릿 윈도우 생성
export async function handleCoupangRankCheckStart(message, sendResponse) {
    startKeepAlive();
    try {
        // 쿠팡 쿠키 초기화 (깨끗한 세션)
        const coupangDomains = ["coupang.com", ".coupang.com"];
        for (const domain of coupangDomains) {
            try {
                const cookies = await chrome.cookies.getAll({ domain });
                for (const cookie of cookies) {
                    const url = `https://${cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain}${cookie.path}`;
                    try {
                        await chrome.cookies.remove({ url, name: cookie.name });
                    } catch (e) { /* ignore */ }
                }
            } catch (e) { /* ignore */ }
        }

        // 시크릿 윈도우 생성 (모바일 크기 → 즉시 최소화)
        const win = await chrome.windows.create({
            incognito: true,
            width: 406,
            height: 900,
            url: "about:blank"
        });
        // 모바일 viewport 유지하면서 최소화
        await chrome.windows.update(win.id, { state: "minimized" });

        const windowId = win.id;
        const tabId = win.tabs[0].id;

        console.log("[Background] 쿠팡 순위 체크 시작 (시크릿 모드)", { windowId, tabId });
        sendResponse({ success: true, windowId, tabId });
    } catch (e) {
        stopKeepAlive();
        console.error("[Background] coupangRankCheckStart error:", e);
        sendResponse({ success: false, error: String(e) });
    }
}

// 순위 체크 - 단일 키워드 검색 (executeScript로 DOM 추출)
export async function handleCoupangRankCheckKeyword(message, sendResponse) {
    try {
        const { tabId, keyword, productId, itemId, searchDepth, isAdProduct } = message.payload;

        let adRank = null;
        let organicRank = null;
        let currentAdPosition = 0;
        let currentOrganicPosition = 0;
        let actualPages = 0;

        const maxPages = searchDepth <= 10
            ? searchDepth
            : Math.ceil(searchDepth / 45);

        const encodedKeyword = encodeURIComponent(keyword);
        let foundTarget = false;

        for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
            if (foundTarget) break;

            const searchUrl = pageNum === 1
                ? `https://www.coupang.com/np/search?q=${encodedKeyword}`
                : `https://www.coupang.com/np/search?q=${encodedKeyword}&page=${pageNum}`;

            // 탭 네비게이션
            await chrome.tabs.update(tabId, { url: searchUrl });

            // 페이지 로드 완료 대기
            await new Promise((resolve) => {
                const onUpdated = (updatedTabId, changeInfo) => {
                    if (updatedTabId === tabId && changeInfo.status === "complete") {
                        chrome.tabs.onUpdated.removeListener(onUpdated);
                        resolve();
                    }
                };
                chrome.tabs.onUpdated.addListener(onUpdated);
                // 타임아웃 15초
                setTimeout(() => {
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    resolve();
                }, 15000);
            });

            // 상품 요소 로드 대기 (최대 10초, 500ms 폴링)
            let pageProducts = [];
            for (let attempt = 0; attempt < 20; attempt++) {
                await new Promise(r => setTimeout(r, 500));
                try {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId },
                        world: "MAIN",
                        func: () => {
                            const products = [];
                            let productElements = document.querySelectorAll('li.ProductUnit_productUnit__Qd6sv');
                            if (productElements.length === 0) productElements = document.querySelectorAll('#product-list > li');
                            if (productElements.length === 0) productElements = document.querySelectorAll('li[class*="search-product"]');
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
                                    isAd: adBadge !== null
                                });
                            }
                            return products;
                        }
                    });
                    if (results && results[0] && results[0].result) {
                        pageProducts = results[0].result;
                        if (pageProducts.length >= 20) break;
                    }
                } catch (e) {
                    console.log(`[Background] executeScript 시도 ${attempt + 1} 실패:`, e.message);
                }
            }

            if (pageProducts.length === 0) {
                console.log(`[Background] 페이지 ${pageNum}: 상품 없음, 검색 종료`);
                break;
            }

            actualPages = pageNum;
            console.log(`[Background] 페이지 ${pageNum}: ${pageProducts.length}개 상품`);

            // 상품 매칭
            for (const product of pageProducts) {
                let isMatch = false;
                if (product.productId === productId) {
                    if (itemId) {
                        if (product.itemId === itemId) isMatch = true;
                    } else {
                        isMatch = true;
                    }
                }

                if (product.isAd) {
                    if (isAdProduct) {
                        currentAdPosition++;
                        if (isMatch && adRank === null) {
                            adRank = currentAdPosition;
                            console.log(`[Background] 광고 순위 발견: ${adRank}위`);
                        }
                    }
                } else {
                    currentOrganicPosition++;
                    if (isMatch && organicRank === null) {
                        organicRank = currentOrganicPosition;
                        console.log(`[Background] 자연 순위 발견: ${organicRank}위`);
                    }
                }

                if (isAdProduct) {
                    if (adRank !== null && organicRank !== null) { foundTarget = true; break; }
                } else {
                    if (organicRank !== null) { foundTarget = true; break; }
                }

                if (searchDepth > 10) {
                    if (currentAdPosition + currentOrganicPosition >= searchDepth) {
                        foundTarget = true; break;
                    }
                }
            }

            // 페이지 간 딜레이
            if (pageNum < maxPages && !foundTarget) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        const rankToPageInfo = (rank) => {
            if (rank === null) return null;
            if (rank <= 49) return { page: 1, position: rank };
            const remaining = rank - 49;
            return {
                page: 2 + Math.floor((remaining - 1) / 45),
                position: ((remaining - 1) % 45) + 1
            };
        };

        console.log(`[Background] 키워드 "${keyword}" 완료 - 광고: ${currentAdPosition}개, 자연: ${currentOrganicPosition}개`);

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
                deviceType: "Mobile"
            }
        });
    } catch (e) {
        console.error("[Background] coupangRankCheckKeyword error:", e);
        sendResponse({ success: false, error: String(e) });
    }
}

// 순위 체크 종료 - 시크릿 윈도우 닫기
export async function handleCoupangRankCheckEnd(message, sendResponse) {
    try {
        stopKeepAlive();

        const { windowId } = message.payload || {};
        if (windowId) {
            try {
                await chrome.windows.remove(windowId);
            } catch (e) {
                console.log("[Background] 시크릿 윈도우 닫기 실패:", e.message);
            }
        }

        console.log("[Background] 쿠팡 순위 체크 종료");
        sendResponse({ success: true });
    } catch (e) {
        sendResponse({ success: true }); // best-effort cleanup
    }
}
