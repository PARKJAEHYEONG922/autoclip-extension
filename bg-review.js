// 리뷰 추출기 - 컨텍스트 메뉴 + content script 주입 (쿠팡 + 스마트스토어)

// 컨텍스트 메뉴 등록
export function setupReviewExtractorMenu() {
    chrome.contextMenus.create({
        id: "autoclip-review-extractor",
        title: "AutoClip 리뷰 추출",
        contexts: ["page"],
        documentUrlPatterns: [
            "https://www.coupang.com/vp/products/*",
            "https://smartstore.naver.com/*/products/*",
            "https://brand.naver.com/*/products/*"
        ]
    });
}

// 네이버 상품 페이지에서 MAIN world로 __PRELOADED_STATE__ 추출
async function extractNaverProductData(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
                const product = (window.__PRELOADED_STATE__?.simpleProductForDetailPage?.A) || {};
                const allMerchantNos = new Set();
                const merchantKeys = ['payReferenceKey', 'checkoutMerchantNo', 'merchantNo', 'naPaySellerNo'];

                let originProductNo = product.originProductNo
                    || product.productNo
                    || product.channelProductNo
                    || null;

                // 1) __PRELOADED_STATE__ 전체 JSON 검색
                if (window.__PRELOADED_STATE__) {
                    const s = JSON.stringify(window.__PRELOADED_STATE__);
                    for (const k of merchantKeys) {
                        for (const m of s.matchAll(new RegExp(`"${k}"\\s*:\\s*"?(\\d+)"?`, 'g'))) {
                            allMerchantNos.add(Number(m[1]));
                        }
                    }
                    if (!originProductNo) {
                        const m = s.match(/"originProductNo"\s*:\s*"?(\d+)"?/);
                        if (m) originProductNo = Number(m[1]);
                    }
                }

                // 2) __NEXT_DATA__ 검색
                if (window.__NEXT_DATA__) {
                    try {
                        const s = JSON.stringify(window.__NEXT_DATA__);
                        for (const k of merchantKeys) {
                            for (const m of s.matchAll(new RegExp(`"${k}"\\s*:\\s*"?(\\d+)"?`, 'g'))) {
                                allMerchantNos.add(Number(m[1]));
                            }
                        }
                    } catch(e) {}
                }

                // 3) 모든 인라인 script 태그 검색
                for (const sc of document.querySelectorAll('script:not([src])')) {
                    const text = sc.textContent || '';
                    if (text.length < 20) continue;
                    for (const k of merchantKeys) {
                        const m = text.match(new RegExp(`["']?${k}["']?\\s*[:=]\\s*["']?(\\d{5,})["']?`));
                        if (m) allMerchantNos.add(Number(m[1]));
                    }
                }

                const merchantNos = [...allMerchantNos].filter(n => n > 0);
                console.log('[AutoClip] merchantNo 후보:', merchantNos, '(sources: state/next/scripts)');

                return {
                    originProductNo,
                    checkoutMerchantNos: merchantNos,
                    checkoutMerchantNo: merchantNos[0] || null,
                    productName: product.name || '',
                    salePrice: product.discountedSalePrice || product.salePrice || '',
                };
            }
        });
        return results?.[0]?.result || null;
    } catch (e) {
        console.error('[Background] MAIN world extraction error:', e);
        return null;
    }
}

// 컨텍스트 메뉴 클릭 → URL에 따라 적절한 content script 주입
export async function handleReviewExtractorClick(info, tab) {
    if (info.menuItemId !== "autoclip-review-extractor") return;

    const url = tab.url || '';
    const isNaver = /smartstore\.naver\.com|brand\.naver\.com/.test(url);
    const scriptFile = isNaver ? 'content-review-extractor-naver.js' : 'content-review-extractor.js';

    // 네이버: MAIN world에서 상품 데이터 먼저 추출 (CSP 우회)
    let productData = null;
    if (isNaver) {
        productData = await extractNaverProductData(tab.id);
        console.log('[Background] Naver product data:', productData);
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: [scriptFile]
        });
    } catch (e) {
        // 이미 주입되어 있을 수 있음
    }

    try {
        await chrome.tabs.sendMessage(tab.id, {
            type: 'START_REVIEW_EXTRACT',
            productData
        });
    } catch (e) {
        console.error('[Background] Review extractor error:', e);
    }
}
