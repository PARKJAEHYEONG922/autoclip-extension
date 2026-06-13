// AutoClip Marketing Helper - Background Service Worker (Message Router)

import { handleNaverLoginCheck, handleGetNaverShoppingTags, handleGetNaverShoppingData } from './bg-naver.js';
import { handleFetchCoupangAdsReport } from './bg-coupang-report.js';
import { handleCoupangRankCheckStart, handleCoupangRankCheckKeyword, handleCoupangRankCheckEnd } from './bg-coupang-rank.js';
import { handleCloseTab, handleGetVersion, handleCoupangAdsLoginCheck, handleWingLoginCheck, handleCoupangWingProductSearch, handleCoupangAutoKeyword, handleCoupangWingApi } from './bg-simple.js';
import { setupImageDownloaderMenu, handleImageDownloaderClick, handleDownloadImage, handleDownloadImages } from './bg-image-downloader.js';
import { setupReviewExtractorMenu, handleReviewExtractorClick, extractNaverProductData } from './bg-review.js';
import { getOrCreateTab, waitForTabLoad, fetchInTab, closeTab } from './bg-utils.js';

// 컨텍스트 메뉴 등록 (설치/업데이트 시)
chrome.runtime.onInstalled.addListener(() => {
    setupImageDownloaderMenu();
    setupReviewExtractorMenu();
});

// 컨텍스트 메뉴 클릭 핸들러
chrome.contextMenus.onClicked.addListener((info, tab) => {
    handleImageDownloaderClick(info, tab);
    handleReviewExtractorClick(info, tab);
});

// 메시지 리스너
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        // 네이버
        case "naverLoginCheck":
            handleNaverLoginCheck(message, sendResponse);
            return true;
        case "getNaverShoppingTags":
            handleGetNaverShoppingTags(message, sendResponse);
            return true;
        case "getNaverShoppingData":
            handleGetNaverShoppingData(message, sendResponse);
            return true;

        // 쿠팡 광고 보고서
        case "fetchCoupangAdsReport":
            handleFetchCoupangAdsReport(message, sendResponse, sender?.tab?.id);
            return true;

        // 쿠팡 순위 체크
        case "coupangRankCheckStart":
            handleCoupangRankCheckStart(message, sendResponse);
            return true;
        case "coupangRankCheckKeyword":
            handleCoupangRankCheckKeyword(message, sendResponse);
            return true;
        case "coupangRankCheckEnd":
            handleCoupangRankCheckEnd(message, sendResponse);
            return true;

        // 쿠팡 광고 / Wing
        case "coupangAdsLoginCheck":
            handleCoupangAdsLoginCheck(message, sendResponse);
            return true;
        case "wingLoginCheck":
            handleWingLoginCheck(message, sendResponse);
            return true;
        case "coupangWingProductSearch":
            handleCoupangWingProductSearch(message, sendResponse);
            return true;
        case "coupangAutoKeyword":
            handleCoupangAutoKeyword(message, sendResponse);
            return true;
        case "coupangWingApi":
            handleCoupangWingApi(message, sendResponse);
            return true;

        // 이미지 다운로더
        case "downloadImage":
            handleDownloadImage(message, sendResponse);
            return true;
        case "downloadImages":
            handleDownloadImages(message, sendResponse);
            return true;

        // review-sync 서버 전송 (content script에서 직접 호출)
        case "REVIEW_SYNC_SEND":
            fetch('http://localhost:3000/api/reviews/receive', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(message.data)
            })
            .then(r => r.json())
            .then(data => {
                console.log(`[ReviewSync] ${data.new}개 새 리뷰 전송 (총 ${data.total}개)`);
                sendResponse(data);
            })
            .catch(e => {
                console.log('[ReviewSync] 서버 미실행 또는 오류:', e.message);
                sendResponse({ success: false });
            });
            return true;

        // review-sync 상품 수집
        case "FETCH_PRODUCTS":
            handleFetchProducts(message.payload, sendResponse, sender?.tab?.id);
            return true;

        // review-sync에서 자동 리뷰 수집 요청
        case "REVIEW_SYNC_AUTO_FETCH":
            handleAutoReviewFetch(message.payload, sendResponse);
            return true;

        // 유틸리티
        case "closeTab":
            handleCloseTab(message, sendResponse);
            return true;
        case "getVersion":
            handleGetVersion(message, sendResponse);
            return true;
    }
});

// 자동 리뷰 수집 - 상품 페이지 열고 → merchantNo 추출 → 리뷰 API 호출 → 서버 전송
async function handleAutoReviewFetch(payload, sendResponse) {
    const { products, storeUrl, maxReviews = 1000, minRating = 1, syncServerUrl = 'http://localhost:3000' } = payload;
    const pageSize = 20;
    const results = [];

    for (const product of products) {
        const productUrl = `${storeUrl.replace(/\/$/, '')}/products/${product.productId}`;
        let tabId = null;

        try {
            // 0. 서버에서 기존 리뷰 요약 가져오기 (중복 조기 중단용)
            let latestDate = '';
            let recentKeys = new Set();
            let existingCount = 0;
            try {
                const sumRes = await fetch(`${syncServerUrl}/api/reviews/summary/${product.productId}`);
                const sumData = await sumRes.json();
                latestDate = sumData.latestDate || '';
                recentKeys = new Set(sumData.recentKeys || []);
                existingCount = sumData.count || 0;
            } catch (e) { /* 서버 미실행 시 무시 */ }

            // 1. 상품 페이지 열기
            console.log(`[ReviewSync] 수집 시작: ${product.name || product.productId} (기존 ${existingCount}개, 최신 ${latestDate})`);
            tabId = await getOrCreateTab(productUrl, 'reuse');
            await waitForTabLoad(tabId, 30000);
            await new Promise(r => setTimeout(r, 3000));

            // 2. MAIN world에서 merchantNo 추출
            const productData = await extractNaverProductData(tabId);
            if (!productData || productData.checkoutMerchantNos.length === 0) {
                console.log(`[ReviewSync] ${product.productId}: merchantNo 없음`);
                results.push({ productId: product.productId, name: product.name, total: 0, new: 0, error: 'merchantNo 없음' });
                continue;
            }

            const originProductNo = productData.originProductNo || Number(product.productId);
            const isBrand = storeUrl.includes('brand.naver.com');
            const apiPath = isBrand ? '/n/v1/contents/reviews/query-pages' : '/i/v1/contents/reviews/query-pages';
            const apiBase = isBrand ? 'https://brand.naver.com' : 'https://smartstore.naver.com';

            // 3. 리뷰 API 호출 (최신순, 중복 시 조기 중단)
            const allReviews = [];
            let workingMerchantNo = null;
            const maxPages = Math.ceil(maxReviews / pageSize);
            let stopFetching = false;

            // 페이지별 리뷰 파싱 헬퍼
            function parseReviewPage(contents) {
                let dupCount = 0;
                for (const item of contents) {
                    const content = (item.reviewContent || item.body || '').trim();
                    if (!content) continue;
                    const reviewDate = item.createDate ? item.createDate.split('T')[0] : '';
                    const key = `${content.substring(0, 50)}_${reviewDate}`;

                    // 최근 20개 키와 비교하거나, 최신 날짜보다 오래된 리뷰면 중단
                    if (recentKeys.has(key)) {
                        dupCount++;
                        if (dupCount >= 3) { stopFetching = true; break; }
                        continue;
                    }
                    if (latestDate && reviewDate < latestDate) {
                        // 최신 저장 날짜보다 오래된 리뷰 → 이후는 전부 기존 리뷰
                        stopFetching = true;
                        break;
                    }
                    dupCount = 0;
                    allReviews.push({
                        rating: item.reviewScore || 0,
                        content,
                        date: reviewDate,
                        author: item.writerId || item.maskedWriterId || item.writerNickname || '',
                        images: (item.reviewAttaches || []).map(a => a.attachUrl).filter(Boolean),
                        option: item.productOptionContent || ''
                    });
                    if (allReviews.length >= maxReviews) { stopFetching = true; break; }
                }
            }

            // 올바른 merchantNo 찾기 (1페이지)
            for (const candidate of productData.checkoutMerchantNos) {
                const testResult = await fetchInTab(tabId, `${apiBase}${apiPath}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
                    body: JSON.stringify({
                        checkoutMerchantNo: Number(candidate),
                        originProductNo: Number(originProductNo),
                        page: 1, pageSize,
                        isMultiProfile: true,
                        reviewSearchSortType: 'REVIEW_CREATE_DATE'
                    })
                });

                if (testResult.success && testResult.body?.contents?.length > 0) {
                    workingMerchantNo = candidate;
                    parseReviewPage(testResult.body.contents);
                    break;
                }
            }

            // 2페이지부터 계속 (중복 3연속이면 중단)
            if (workingMerchantNo && !stopFetching) {
                for (let p = 2; p <= maxPages; p++) {
                    const pageResult = await fetchInTab(tabId, `${apiBase}${apiPath}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
                        body: JSON.stringify({
                            checkoutMerchantNo: Number(workingMerchantNo),
                            originProductNo: Number(originProductNo),
                            page: p, pageSize,
                            isMultiProfile: true,
                            reviewSearchSortType: 'REVIEW_CREATE_DATE'
                        })
                    });
                    if (!pageResult.success || !pageResult.body?.contents?.length) break;
                    parseReviewPage(pageResult.body.contents);
                    if (stopFetching) {
                        console.log(`[ReviewSync] ${product.name}: ${p}페이지에서 중복 감지, 수집 중단`);
                        break;
                    }
                    if (pageResult.body.contents.length < pageSize) break;
                }
            }

            // 4. review-sync 서버로 전송
            if (allReviews.length > 0) {
                const syncRes = await fetch(`${syncServerUrl}/api/reviews/receive`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        productId: String(product.productId),
                        productName: productData.productName || product.name || '',
                        storeUrl,
                        minRating,
                        reviews: allReviews
                    })
                });
                const syncData = await syncRes.json();
                console.log(`[ReviewSync] ${product.name}: ${syncData.new}개 새 리뷰 (총 ${syncData.total}개)`);
                results.push({ productId: product.productId, name: product.name, total: syncData.total, new: syncData.new });
            } else {
                results.push({ productId: product.productId, name: product.name, total: 0, new: 0 });
            }
        } catch (e) {
            console.error(`[ReviewSync] ${product.productId} 에러:`, e);
            results.push({ productId: product.productId, name: product.name, total: 0, new: 0, error: e.message });
        } finally {
            if (tabId) await closeTab(tabId);
        }
    }

    sendResponse({ success: true, results });
}

console.log("AutoClip Marketing Helper loaded");
