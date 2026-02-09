// 공유 유틸리티 함수들

// 서비스 워커 keepAlive (Manifest V3에서 서비스 워커가 비활성화되는 것 방지)
let keepAliveInterval = null;

export function startKeepAlive() {
    if (keepAliveInterval) return;
    // 25초마다 빈 작업 수행 (30초 타임아웃 전에)
    keepAliveInterval = setInterval(() => {
        chrome.runtime.getPlatformInfo(() => {});
    }, 25000);
    console.log("[Background] KeepAlive started");
}

export function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
        console.log("[Background] KeepAlive stopped");
    }
}

// 탭 로딩 완료 대기
export async function waitForTabLoad(tabId, timeout = 30000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        try {
            const tab = await chrome.tabs.get(tabId);
            if (!tab) throw new Error("Tab not found");
            if (tab.status === "complete") return;
        } catch (e) {
            // Tab might not exist yet
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

// 탭 재사용 또는 생성
export async function getOrCreateTab(url, strategy = "reuse") {
    const urlObj = new URL(url);

    if (strategy === "reuse") {
        try {
            const tabs = await chrome.tabs.query({ url: `*://${urlObj.host}/*` });
            if (tabs.length > 0) {
                const tab = tabs[0];
                await chrome.tabs.update(tab.id, { url: url, active: false });
                return tab.id;
            }
        } catch (e) {
            console.error("Tab query failed:", e);
        }
    }

    const newTab = await chrome.tabs.create({ url: url, active: false });
    return newTab.id;
}

// 탭 닫기
export async function closeTab(tabId) {
    if (typeof tabId !== "number" || !Number.isFinite(tabId)) return false;
    try {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) return false;
        await chrome.tabs.remove(tabId);
        return true;
    } catch (e) {
        return false;
    }
}

// 서비스 워커에서 직접 fetch (쿠키 포함, 탭 불필요)
export async function backgroundFetch(url, options = {}) {
    try {
        const response = await fetch(url, {
            ...options,
            credentials: "include"
        });

        let body;
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            body = await response.json();
        } else {
            body = await response.text();
        }

        return {
            success: response.ok,
            status: response.status,
            body
        };
    } catch (e) {
        return {
            success: false,
            status: 9999,
            error: String(e)
        };
    }
}

// 탭 내에서 fetch 실행 (사용자 쿠키/세션 사용)
export async function fetchInTab(tabId, url, options = {}) {
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: "MAIN",
        func: async (fetchUrl, fetchOptions) => {
            try {
                const response = await fetch(fetchUrl, {
                    ...fetchOptions,
                    credentials: "include"
                });

                let body;
                const contentType = response.headers.get("content-type") || "";
                if (contentType.includes("application/json")) {
                    body = await response.json();
                } else {
                    body = await response.text();
                }

                return {
                    success: response.ok,
                    status: response.status,
                    body: body
                };
            } catch (e) {
                return {
                    success: false,
                    status: 9999,
                    error: String(e)
                };
            }
        },
        args: [url, options]
    });

    return result;
}
