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
                const state = window.__PRELOADED_STATE__;
                if (!state) return { debugKeys: null, debugProductKeys: null };

                const keys = Object.keys(state);
                const product = (state.simpleProductForDetailPage && state.simpleProductForDetailPage.A) || {};
                const productKeys = Object.keys(product);

                let originProductNo = product.originProductNo
                    || product.productNo
                    || product.channelProductNo
                    || null;

                let checkoutMerchantNo = product.checkoutMerchantNo
                    || product.merchantNo
                    || product.naPaySellerNo
                    || product.storeNo
                    || product.channelNo
                    || null;

                // state 다른 최상위 키에서 탐색
                if (!checkoutMerchantNo || !originProductNo) {
                    const searchKeys = ['channel', 'channelInfo', 'storeInfo', 'sellerInfo', 'productDetail'];
                    for (const sk of searchKeys) {
                        let obj = state[sk];
                        if (!obj) continue;
                        if (obj.A && typeof obj.A === 'object') obj = obj.A;
                        if (!checkoutMerchantNo) {
                            checkoutMerchantNo = obj.checkoutMerchantNo
                                || obj.merchantNo || obj.naPaySellerNo
                                || obj.channelNo || null;
                        }
                        if (!originProductNo) {
                            originProductNo = obj.originProductNo
                                || obj.productNo || null;
                        }
                        if (originProductNo && checkoutMerchantNo) break;
                    }
                }

                // state JSON 문자열 검색
                if (!originProductNo || !checkoutMerchantNo) {
                    const stateStr = JSON.stringify(state);
                    if (!originProductNo) {
                        for (const k of ['originProductNo', 'productNo']) {
                            const m = stateStr.match(new RegExp(`"${k}"\\s*:\\s*"?(\\d+)"?`));
                            if (m) { originProductNo = Number(m[1]); break; }
                        }
                    }
                    if (!checkoutMerchantNo) {
                        for (const k of ['checkoutMerchantNo', 'merchantNo', 'naPaySellerNo', 'storeNo']) {
                            const m = stateStr.match(new RegExp(`"${k}"\\s*:\\s*"?(\\d+)"?`));
                            if (m) { checkoutMerchantNo = Number(m[1]); break; }
                        }
                    }
                }

                // __NEXT_DATA__ 검색
                if (!checkoutMerchantNo) {
                    try {
                        const nd = window.__NEXT_DATA__;
                        if (nd) {
                            const ndStr = JSON.stringify(nd);
                            for (const k of ['storeNo', 'checkoutMerchantNo', 'merchantNo', 'channelNo', 'naPaySellerNo']) {
                                const m = ndStr.match(new RegExp(`"${k}"\\s*:\\s*"?(\\d+)"?`));
                                if (m && Number(m[1]) > 0) { checkoutMerchantNo = Number(m[1]); break; }
                            }
                        }
                    } catch(e) {}
                }

                // 모든 인라인 script 태그 검색
                if (!checkoutMerchantNo) {
                    const scripts = document.querySelectorAll('script:not([src])');
                    for (const sc of scripts) {
                        const text = sc.textContent || '';
                        if (!text || text.length < 10) continue;
                        for (const k of ['storeNo', 'checkoutMerchantNo', 'merchantNo', 'channelNo']) {
                            const m = text.match(new RegExp(`["']?${k}["']?\\s*[:=]\\s*["']?(\\d{5,})["']?`));
                            if (m) { checkoutMerchantNo = Number(m[1]); break; }
                        }
                        if (checkoutMerchantNo) break;
                    }
                }

                // product 키 중 merchant/seller/channel/pay/store/no 포함하는 키-값 덤프
                const suspectKeys = {};
                for (const pk of productKeys) {
                    const lk = pk.toLowerCase();
                    if (lk.includes('merchant') || lk.includes('seller') || lk.includes('channel')
                        || lk.includes('checkout') || lk.includes('pay') || lk.includes('store')
                        || lk.includes('shop') || (lk.endsWith('no') && product[pk])) {
                        suspectKeys[pk] = product[pk];
                    }
                }

                return {
                    originProductNo,
                    checkoutMerchantNo,
                    productName: product.name || '',
                    salePrice: product.discountedSalePrice || product.salePrice || '',
                    debugKeys: keys,
                    debugProductKeys: productKeys,
                    debugSuspectKeys: suspectKeys
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
