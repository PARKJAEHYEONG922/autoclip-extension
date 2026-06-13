// 네이버 관련 메시지 핸들러

import { getOrCreateTab, waitForTabLoad, fetchInTab } from './bg-utils.js';

// 네이버 로그인 체크
export function handleNaverLoginCheck(message, sendResponse) {
    chrome.cookies.get({ url: "https://naver.com", name: "NID_SES" }, (cookie) => {
        sendResponse(cookie ? { success: true, loggedIn: true } : { success: true, loggedIn: false });
    });
}

/**
 * 서비스 워커에서 직접 네이버 쇼핑 API 호출 (탭 불필요)
 * - 탭을 열지 않아 차단 페이지 우회
 * - credentials: "include"로 네이버 쿠키 자동 포함 (host_permissions 필요)
 */
async function fetchNaverShoppingAPI(apiUrl) {
    try {
        const response = await fetch(apiUrl, {
            method: "GET",
            credentials: "include",
            headers: {
                "accept": "application/json, text/plain, */*",
                "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
                "referer": "https://search.shopping.naver.com/",
                "logic": "PART"
            }
        });

        if (!response.ok) {
            console.log(`[NaverTags] Direct API returned ${response.status}`);
            return { success: false, status: response.status, error: `HTTP ${response.status}` };
        }

        const text = await response.text();
        try {
            const body = JSON.parse(text);
            return { success: true, status: response.status, body };
        } catch {
            // JSON이 아님 = 차단 페이지 HTML
            console.log(`[NaverTags] Response is not JSON (blocked page?)`);
            return { success: false, status: response.status, error: "Not JSON response" };
        }
    } catch (e) {
        console.error(`[NaverTags] Direct fetch error:`, e);
        return { success: false, status: 0, error: String(e) };
    }
}

// 네이버 쇼핑 검색 API - 태그 가져오기 (여러 페이지 지원)
export async function handleGetNaverShoppingTags(message, sendResponse) {
    try {
        const { keyword, pageSize = 40, pages = 2 } = message.payload;

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

            // 서비스 워커에서 직접 API 호출 (탭 불필요)
            let result = await fetchNaverShoppingAPI(apiUrl);

            // 직접 호출 실패 시 탭 방식 폴백
            if (!result.success) {
                console.log(`[NaverTags] Direct fetch failed (${result.status}), falling back to tab`);
                const searchUrl = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(keyword)}`;
                const tabId = await getOrCreateTab(searchUrl, "reuse");
                await waitForTabLoad(tabId);

                result = await fetchInTab(tabId, apiUrl, {
                    method: "GET",
                    headers: {
                        "accept": "application/json, text/plain, */*",
                        "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
                        "logic": "PART"
                    }
                });
            }

            console.log(`[NaverTags] Page ${page} result:`, result.success);

            if (result.success && result.body) {
                const products = result.body?.shoppingResult?.products || [];
                console.log(`[NaverTags] Page ${page} products:`, products.length);

                if (products.length === 0) break;

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
                console.error(`[NaverTags] Page ${page} failed:`, result.error);
                break;
            }

            // 페이지 간 딜레이 (차단 방지용 1~2초 랜덤)
            if (page < pages) {
                const delay = 1000 + Math.random() * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        // 태그 빈도순 정렬
        const sortedTags = Object.entries(tagCount)
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count);

        console.log(`[NaverTags] Total products: ${allProducts.length}, Total unique tags: ${sortedTags.length}`);

        sendResponse({
            success: true,
            data: {
                keyword: keyword,
                totalProducts: allProducts.length,
                tags: sortedTags,
                rawTags: allTags
            }
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

        const apiUrl = `https://search.shopping.naver.com/api/search/all?sort=rel&pagingIndex=${page}&pagingSize=${pageSize}&viewType=list&productSet=total&query=${encodeURIComponent(keyword)}&iq=&eq=&xq=&window=&fo=true`;

        // 서비스 워커에서 직접 API 호출
        let result = await fetchNaverShoppingAPI(apiUrl);

        // 직접 호출 실패 시 탭 방식 폴백
        if (!result.success) {
            console.log(`[NaverData] Direct fetch failed (${result.status}), falling back to tab`);
            const searchUrl = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(keyword)}`;
            const tabId = await getOrCreateTab(searchUrl, "reuse");
            await waitForTabLoad(tabId);

            result = await fetchInTab(tabId, apiUrl, {
                method: "GET",
                headers: {
                    "accept": "application/json, text/plain, */*",
                    "logic": "PART"
                }
            });
        }

        sendResponse({
            success: result.success,
            data: result.body,
            status: result.status
        });
    } catch (e) {
        sendResponse({
            success: false,
            error: String(e)
        });
    }
}
