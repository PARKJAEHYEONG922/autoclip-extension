// AutoClip Marketing Helper - Content Script
// 웹페이지와 확장프로그램 간의 통신을 담당

(function() {
    // 확장프로그램 설치 여부를 페이지에 알림
    window.postMessage({ type: "AUTOCLIP_EXTENSION_READY", version: chrome.runtime.getManifest().version }, window.location.origin);

    // 페이지에서 오는 메시지 수신
    window.addEventListener("message", async (event) => {
        // 같은 origin에서 온 메시지만 처리
        if (event.source !== window) return;

        const message = event.data;
        if (!message || !message.type) return;

        // AUTOCLIP_ 접두사가 있는 메시지만 처리
        if (!message.type.startsWith("AUTOCLIP_REQUEST_")) return;

        const requestId = message.requestId;
        const actualType = message.type.replace("AUTOCLIP_REQUEST_", "");

        try {
            // background.js로 메시지 전달
            const response = await chrome.runtime.sendMessage({
                type: actualType,
                payload: message.payload
            });

            // 결과를 페이지로 전달
            window.postMessage({
                type: "AUTOCLIP_RESPONSE",
                requestId: requestId,
                success: true,
                data: response
            }, window.location.origin);
        } catch (error) {
            window.postMessage({
                type: "AUTOCLIP_RESPONSE",
                requestId: requestId,
                success: false,
                error: String(error)
            }, window.location.origin);
        }
    });

    console.log("[AutoClip Extension] Content script loaded");
})();
