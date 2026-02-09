// 쿠팡 이미지 다운로더 - 컨텍스트 메뉴 + 다운로드 핸들러

// 컨텍스트 메뉴 등록
export function setupImageDownloaderMenu() {
    chrome.contextMenus.create({
        id: "autoclip-image-downloader",
        title: "AutoClip 이미지 다운로더",
        contexts: ["page"],
        documentUrlPatterns: [
            "https://www.coupang.com/*",
            "https://smartstore.naver.com/*/products/*",
            "https://brand.naver.com/*/products/*"
        ]
    });
}

// 컨텍스트 메뉴 클릭 → content script 주입 + 토글 메시지
export async function handleImageDownloaderClick(info, tab) {
    if (info.menuItemId !== "autoclip-image-downloader") return;

    try {
        // content script가 아직 주입 안 됐으면 주입
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content-image-downloader.js']
        });
    } catch (e) {
        // 이미 주입되어 있을 수 있음 (무시)
    }

    // 토글 메시지 전송
    try {
        await chrome.tabs.sendMessage(tab.id, { type: 'PICKER_TOGGLE' });
    } catch (e) {
        console.error('[Background] Image downloader toggle error:', e);
    }
}

// 단일 이미지 다운로드
export async function handleDownloadImage(message, sendResponse) {
    try {
        const { url, filename } = message.payload;
        const downloadId = await chrome.downloads.download({
            url,
            filename: filename || undefined,
            saveAs: false
        });
        sendResponse({ success: true, downloadId });
    } catch (e) {
        sendResponse({ success: false, error: String(e) });
    }
}

// 다중 이미지 다운로드
export async function handleDownloadImages(message, sendResponse) {
    try {
        const { images } = message.payload;
        let completed = 0;
        for (const img of images) {
            try {
                await chrome.downloads.download({
                    url: img.url,
                    filename: img.filename || undefined,
                    saveAs: false
                });
                completed++;
            } catch (e) {
                console.error('[Background] Download failed:', img.url, e);
            }
            // 다운로드 간 딜레이 (브라우저 부하 방지)
            if (images.length > 5) {
                await new Promise(r => setTimeout(r, 100));
            }
        }
        sendResponse({ success: true, completed, total: images.length });
    } catch (e) {
        sendResponse({ success: false, error: String(e) });
    }
}
