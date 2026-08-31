/*
 * AI 文件工具平台 - 網站執行設定
 *
 * 同一份前端可同時用於：
 * 1. Render 等平台的同源部署：apiBaseUrl 留白。
 * 2. GitHub Pages 前端：填入公開 HTTPS 後端網址。
 *
 * 請勿在此檔案放入 API Key 或其他機密資訊。
 */
(function configureApiRouting() {
    const configuredBase = "https://ai-document-tools.onrender.com";
    const apiBaseUrl = configuredBase.replace(/\/+$/, "");

    window.AI_TOOLS_CONFIG = Object.assign(
        {
            apiBaseUrl,
            version: "3.0-online"
        },
        window.AI_TOOLS_CONFIG || {}
    );

    const nativeFetch = window.fetch.bind(window);

    // 將既有頁面的 /api/* 請求導向遠端後端，保留同源部署的相容性。
    window.fetch = function routedFetch(resource, init) {
        const base = String(window.AI_TOOLS_CONFIG.apiBaseUrl || "").replace(/\/+$/, "");
        if (!base) return nativeFetch(resource, init);

        const isRequest = resource instanceof Request;
        const rawUrl = isRequest ? resource.url : String(resource);
        const requestUrl = new URL(rawUrl, window.location.href);

        if (!requestUrl.pathname.startsWith("/api/")) {
            return nativeFetch(resource, init);
        }

        const baseUrl = new URL(base);
        const basePath = baseUrl.pathname.replace(/\/+$/, "");
        requestUrl.protocol = baseUrl.protocol;
        requestUrl.host = baseUrl.host;
        requestUrl.pathname = `${basePath}${requestUrl.pathname}`;

        if (isRequest) {
            return nativeFetch(new Request(requestUrl.toString(), resource), init);
        }
        return nativeFetch(requestUrl.toString(), init);
    };
})();
