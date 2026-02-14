// 간단한 메시지 핸들러 모음

import { closeTab } from './bg-utils.js';

// 탭 닫기
export async function handleCloseTab(message, sendResponse) {
    const { tabId } = message.payload;
    await closeTab(tabId);
    sendResponse({ success: true });
}

// 확장프로그램 버전 확인
export function handleGetVersion(message, sendResponse) {
    const version = chrome.runtime.getManifest().version;
    sendResponse({ success: true, version: version });
}

// 쿠팡 광고 로그인 상태 확인
export function handleCoupangAdsLoginCheck(message, sendResponse) {
    chrome.cookies.get({ url: "https://advertising.coupang.com", name: "SESSION" }, (cookie) => {
        sendResponse(cookie ? { success: true, loggedIn: true } : { success: true, loggedIn: false });
    });
}

// Wing 로그인 상태 확인 (XSRF-TOKEN 쿠키 존재 + 만료 여부)
export async function handleWingLoginCheck(message, sendResponse) {
    try {
        const tokenCookie = await chrome.cookies.get({
            url: "https://wing.coupang.com/",
            name: "XSRF-TOKEN"
        });
        if (!tokenCookie) {
            sendResponse({ success: true, loggedIn: false });
            return;
        }

        // 쿠키 만료 확인
        if (tokenCookie.expirationDate && tokenCookie.expirationDate < Date.now() / 1000) {
            sendResponse({ success: true, loggedIn: false });
            return;
        }

        sendResponse({ success: true, loggedIn: true });
    } catch {
        sendResponse({ success: true, loggedIn: false });
    }
}

// Wing 상품 검색 (키워드 분석)
export async function handleCoupangWingProductSearch(message, sendResponse) {
    try {
        // XSRF 토큰 가져오기
        const tokenCookie = await chrome.cookies.get({
            url: "https://wing.coupang.com/",
            name: "XSRF-TOKEN"
        });

        if (!tokenCookie) {
            sendResponse({ success: false, error: "Wing 로그인이 필요합니다." });
            return;
        }

        const xsrfToken = decodeURIComponent(tokenCookie.value);

        const res = await fetch("https://wing.coupang.com/tenants/seller-web/pre-matching/search", {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                "x-xsrf-token": xsrfToken
            },
            body: JSON.stringify(message.payload)
        });

        if (!res.ok) {
            sendResponse({ success: false, error: `HTTP ${res.status}` });
            return;
        }

        const data = await res.json();
        sendResponse({ success: true, data });
    } catch (e) {
        console.error("[Background] coupangWingProductSearch error:", e);
        const msg = String(e);
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
            sendResponse({ success: false, error: "Wing 로그인이 만료되었습니다. wing.coupang.com에 다시 로그인해주세요." });
        } else {
            sendResponse({ success: false, error: msg });
        }
    }
}

// 쿠팡 자동완성 키워드
export async function handleCoupangAutoKeyword(message, sendResponse) {
    try {
        const { keyword } = message.payload;
        const res = await fetch(`https://www.coupang.com/n-api/web-adapter/search?keyword=${encodeURIComponent(keyword)}`, {
            headers: { "Accept": "application/json" }
        });

        if (!res.ok) {
            sendResponse({ success: false, error: `HTTP ${res.status}` });
            return;
        }

        const data = await res.json();
        sendResponse({ success: true, data });
    } catch (e) {
        console.error("[Background] coupangAutoKeyword error:", e);
        sendResponse({ success: false, error: String(e) });
    }
}

// Wing 범용 API 호출 (path, method, payload 지정 가능)
export async function handleCoupangWingApi(message, sendResponse) {
    try {
        const tokenCookie = await chrome.cookies.get({
            url: "https://wing.coupang.com/",
            name: "XSRF-TOKEN"
        });

        if (!tokenCookie) {
            sendResponse({ success: false, error: "Wing 로그인이 필요합니다." });
            return;
        }

        const xsrfToken = decodeURIComponent(tokenCookie.value);
        const { path, method = "GET", body: reqBody } = message.payload;
        const url = `https://wing.coupang.com${path}`;

        const options = {
            method,
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                "x-xsrf-token": xsrfToken
            },
        };

        if (method !== "GET" && reqBody) {
            options.body = JSON.stringify(reqBody);
        }

        const res = await fetch(url, options);
        const data = await res.json().catch(() => null);

        if (!res.ok) {
            sendResponse({ success: false, error: `HTTP ${res.status}`, data });
            return;
        }

        sendResponse({ success: true, data });
    } catch (e) {
        console.error("[Background] coupangWingApi error:", e);
        sendResponse({ success: false, error: String(e) });
    }
}
