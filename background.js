// AutoClip Marketing Helper - Background Service Worker (Message Router)

import { handleNaverLoginCheck, handleGetNaverShoppingTags, handleGetNaverShoppingData } from './bg-naver.js';
import { handleFetchCoupangAdsReport } from './bg-coupang-report.js';
import { handleCoupangRankCheckStart, handleCoupangRankCheckKeyword, handleCoupangRankCheckEnd } from './bg-coupang-rank.js';
import { handleCloseTab, handleGetVersion, handleCoupangAdsLoginCheck, handleWingLoginCheck, handleCoupangWingProductSearch, handleCoupangAutoKeyword, handleCoupangWingApi } from './bg-simple.js';
import { setupImageDownloaderMenu, handleImageDownloaderClick, handleDownloadImage, handleDownloadImages } from './bg-image-downloader.js';
import { setupReviewExtractorMenu, handleReviewExtractorClick } from './bg-review.js';

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
            handleFetchCoupangAdsReport(message, sendResponse);
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

        // 유틸리티
        case "closeTab":
            handleCloseTab(message, sendResponse);
            return true;
        case "getVersion":
            handleGetVersion(message, sendResponse);
            return true;
    }
});

console.log("AutoClip Marketing Helper loaded");
