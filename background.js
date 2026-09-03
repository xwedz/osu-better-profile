// background.js

// Your own deployed Worker's URL — see worker/worker.js and the README for
// deployment steps. This is a public URL, so it's fine for it to be here;
// the actual secret lives only in the Worker's environment variables.
const TOKEN_ENDPOINT = 'https://osu-better-profile-token.law5616583.workers.dev/token';

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
 * Returns a cached, still-valid token if we have one, otherwise fetches a
 * fresh one from our own Worker.
 *
 * Note this extension no longer runs osu!'s interactive OAuth login flow at
 * all — this extension only ever reads PUBLIC data (other players' scores),
 * never anything tied to whoever is using the extension, so there's no need
 * to make them log into their own osu! account. Our Worker fetches an
 * app-level "guest" token via the client-credentials grant instead, which
 * needs the app's client secret — which is why that step has to happen on
 * a server we control rather than in this extension.
 */
async function getValidToken() {
    const { osu_token, osu_token_expires_at } = await chrome.storage.local.get([
        'osu_token',
        'osu_token_expires_at'
    ]);

    if (osu_token && osu_token_expires_at && Date.now() < osu_token_expires_at - EXPIRY_BUFFER_MS) {
        return osu_token;
    }

    return fetchTokenFromWorker();
}

async function fetchTokenFromWorker() {
    const res = await fetch(TOKEN_ENDPOINT, { method: 'GET' });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Token request failed (${res.status}): ${detail}`);
    }

    const data = await res.json();
    if (!data.access_token) {
        throw new Error('Worker response did not include an access_token.');
    }

    // osu!'s client-credentials tokens last 24h by default; we don't get an
    // expires_in back from our own worker response currently, so just cache
    // for a conservative period and let getValidToken() re-check regardless.
    const expiresAt = Date.now() + 23 * 60 * 60 * 1000; // ~23h, safely under osu!'s 24h
    await chrome.storage.local.set({
        osu_token: data.access_token,
        osu_token_expires_at: expiresAt
    });

    return data.access_token;
}