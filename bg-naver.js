// 네이버 관련 메시지 핸들러

import { getOrCreateTab, waitForTabLoad, fetchInTab } from './bg-utils.js';

// 네이버 로그인 체크
export function handleNaverLoginCheck(message, sendResponse) {
    chrome.cookies.get({ url: "https://naver.com", name: "NID_SES" }, (cookie) => {
        sendResponse(cookie ? { success: true, loggedIn: true } : { success: true, loggedIn: false });
    });
}

// 네이버 쇼핑 검색 API - 태그 가져오기 (여러 페이지 지원)
export async function handleGetNaverShoppingTags(message, sendResponse) {
    try {
        const { keyword, pageSize = 40, pages = 2 } = message.payload;

        // 네이버 쇼핑 페이지 탭 열기/재사용
        const searchUrl = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(keyword)}`;
        const tabId = await getOrCreateTab(searchUrl, "reuse");

        await waitForTabLoad(tabId);

        const allProducts = [];
        const allTags = [];
        const tagCount = {};

        // 제외할 기본 태그 목록
        const excludeTags = new Set([
            "오늘출발", "오늘발송", "무료교환", "무료반품", "무료교환반품", "무료반품교환",
            "정기구독", "정기배달", "정기배송"
        ]);

        // 여러 페이지 순회
        for (let page = 1; page <= pages; page++) {
            const apiUrl = `https://search.shopping.naver.com/api/search/all?sort=rel&pagingIndex=${page}&pagingSize=${pageSize}&viewType=list&productSet=total&query=${encodeURIComponent(keyword)}&iq=&eq=&xq=&window=&fo=true`;

            const result = await fetchInTab(tabId, apiUrl, {
                method: "GET",
                headers: {
                    "accept": "application/json, text/plain, */*",
                    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
                    "logic": "PART"
                }
            });

            console.log(`[Background] Page ${page} result:`, result.success);

            if (result.success && result.body) {
                const products = result.body?.shoppingResult?.products || [];
                console.log(`[Background] Page ${page} products:`, products.length);

                if (products.length === 0) break; // 더 이상 상품이 없으면 중단

                products.forEach((product, index) => {
                    const globalRank = allProducts.length + index + 1;
                    allProducts.push(product);

                    // manuTag는 쉼표로 구분된 문자열
                    let rawTags = product.manuTag || product.manutag || "";
                    let tags = [];

                    if (typeof rawTags === "string" && rawTags.length > 0) {
                        tags = rawTags.split(",").map(t => t.trim()).filter(t => t);
                    } else if (Array.isArray(rawTags)) {
                        tags = rawTags;
                    }

                    tags.forEach(tag => {
                        if (tag && typeof tag === "string" && !excludeTags.has(tag)) {
                            allTags.push({
                                tag: tag,
                                rank: globalRank,
                                productName: product.productTitle || ""
                            });
                            tagCount[tag] = (tagCount[tag] || 0) + 1;
                        }
                    });
                });
            } else {
                console.error(`[Background] Page ${page} failed:`, result.error);
                break;
            }

            // 페이지 간 딜레이 (너무 빠른 요청 방지)
            if (page < pages) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }

        // 태그 빈도순 정렬
        const sortedTags = Object.entries(tagCount)
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count);

        console.log(`[Background] Total products: ${allProducts.length}, Total unique tags: ${sortedTags.length}`);

        sendResponse({
            success: true,
            data: {
                keyword: keyword,
                totalProducts: allProducts.length,
                tags: sortedTags,
                rawTags: allTags
            },
            tabId: tabId
        });
    } catch (e) {
        console.error("getNaverShoppingTags error:", e);
        sendResponse({
            success: false,
            error: String(e)
        });
    }
}

// 네이버 쇼핑 검색 전체 데이터 (순위, 카테고리 등)
export async function handleGetNaverShoppingData(message, sendResponse) {
    try {
        const { keyword, page = 1, pageSize = 40 } = message.payload;

        const searchUrl = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(keyword)}`;
        const tabId = await getOrCreateTab(searchUrl, "reuse");

        await waitForTabLoad(tabId);

        const apiUrl = `https://search.shopping.naver.com/api/search/all?sort=rel&pagingIndex=${page}&pagingSize=${pageSize}&viewType=list&productSet=total&query=${encodeURIComponent(keyword)}&iq=&eq=&xq=&window=&fo=true`;

        const result = await fetchInTab(tabId, apiUrl, {
            method: "GET",
            headers: {
                "accept": "application/json, text/plain, */*",
                "logic": "PART"
            }
        });

        sendResponse({
            success: result.success,
            data: result.body,
            status: result.status,
            tabId: tabId
        });
    } catch (e) {
        sendResponse({
            success: false,
            error: String(e)
        });
    }
}
