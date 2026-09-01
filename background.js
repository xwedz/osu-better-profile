const REDIRECT_URL = chrome.identity.getRedirectURL();

// Small safety buffer so we refresh slightly before the token truly expires
const EXPIRY_BUFFER_MS = 60 * 1000;

// 監聽來自 content.js 的訊息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "authenticate") {
        getValidToken()
            .then(token => sendResponse({ success: true, token: token }))
            .catch(error => sendResponse({ success: false, error: error.message }));

        // Return true to indicate that sendResponse will be called asynchronously
        return true;
    }
});

/**
 * Returns a cached, still-valid token if we have one, otherwise runs the
 * interactive OAuth flow once and caches the result.
 *
 * This matters a lot now that content.js can legitimately ask for a token
 * on *every* SPA navigation (see content.js) — without this cache, every
 * profile you visit would pop up a brand new osu! login window, which
 * would be awful UX.
 */
async function getValidToken() {
    const { osu_token, osu_token_expires_at } = await chrome.storage.local.get([
        'osu_token',
        'osu_token_expires_at'
    ]);

    if (osu_token && osu_token_expires_at && Date.now() < osu_token_expires_at - EXPIRY_BUFFER_MS) {
        return osu_token;
    }

    return authenticateOsu();
}

/**
 * Handles the OAuth 2.0 flow with osu! API
 */
async function authenticateOsu() {
    // 1. 建構授權網址
    const authUrl = new URL('https://osu.ppy.sh/oauth/authorize');
    authUrl.searchParams.append('client_id', CLIENT_ID);
    authUrl.searchParams.append('redirect_uri', REDIRECT_URL);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('scope', 'public');

    return new Promise((resolve, reject) => {
        // 2. 彈出 Chrome 內建的安全授權視窗
        chrome.identity.launchWebAuthFlow({
            url: authUrl.href,
            interactive: true // 允許彈出視窗讓使用者點擊
        }, async (redirectUrl) => {
            if (chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
            }
            if (!redirectUrl) {
                return reject(new Error("No redirect URL returned (popup closed?)."));
            }

            // 3. 從回傳的網址中擷取「授權碼 (Auth Code)」
            const urlObj = new URL(redirectUrl);
            const code = urlObj.searchParams.get('code');

            if (!code) {
                return reject(new Error("Authorization code not found."));
            }

            // 4. 拿授權碼去換取真正的 Access Token
            try {
                const response = await fetch('https://osu.ppy.sh/oauth/token', {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        client_id: CLIENT_ID,
                        client_secret: CLIENT_SECRET,
                        code: code,
                        grant_type: 'authorization_code',
                        redirect_uri: REDIRECT_URL
                    })
                });

                const data = await response.json();

                if (data.access_token) {
                    // 將 Token 和過期時間安全地儲存在 Chrome 擴充功能專屬的空間
                    const expiresAt = Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600 * 1000);
                    await chrome.storage.local.set({
                        osu_token: data.access_token,
                        osu_token_expires_at: expiresAt
                    });
                    resolve(data.access_token);
                } else {
                    reject(new Error("Failed to exchange token: " + JSON.stringify(data)));
                }
            } catch (error) {
                reject(error);
            }
        });
    });
}