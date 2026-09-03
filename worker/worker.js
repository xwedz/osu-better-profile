// worker.js — Cloudflare Worker
//
// This is the ONLY place your osu! CLIENT_SECRET should ever live. It never
// gets shipped to users' browsers. The extension calls this worker's /token
// endpoint to get a short-lived osu! API access token; this worker is the
// only thing that actually talks to osu!'s /oauth/token endpoint.
//
// Deploy: Cloudflare dashboard → Workers & Pages → Create Worker → paste
// this file's contents in, then add OSU_CLIENT_ID and OSU_CLIENT_SECRET
// under that worker's Settings → Variables (mark OSU_CLIENT_SECRET as
// "Encrypt" so it isn't visible in the dashboard after saving).
//
// This uses the "client credentials" grant instead of the interactive
// login flow the extension used before. Since this extension only ever
// reads PUBLIC data (other players' scores/beatmaps) and never needs
// anything tied to the person using the extension, there's no reason to
// make them log into their own osu! account at all — client credentials
// gets an app-level "guest" token with no user interaction required.

// Cached in memory for the lifetime of this Worker isolate. Cloudflare may
// recycle isolates periodically, at which point this just refetches — no
// correctness issue, just an occasional extra request to osu!.
let cachedToken = null;
let cachedExpiresAt = 0;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        if (request.method !== 'GET') {
            return json({ error: 'Method not allowed' }, 405);
        }

        // Soft check only — a non-browser client can fake this header, so
        // don't treat it as real security, just a filter against casual
        // scraping of this endpoint by browsers/crawlers.
        const origin = request.headers.get('Origin') || '';
        if (origin && !origin.startsWith('chrome-extension://')) {
            return json({ error: 'Forbidden' }, 403);
        }

        const now = Date.now();
        if (cachedToken && now < cachedExpiresAt) {
            return json({ access_token: cachedToken });
        }

        let tokenRes;
        try {
            tokenRes = await fetch('https://osu.ppy.sh/oauth/token', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    client_id: env.OSU_CLIENT_ID,
                    client_secret: env.OSU_CLIENT_SECRET,
                    grant_type: 'client_credentials',
                    scope: 'public', // the only scope available under this grant
                }),
            });
        } catch (err) {
            return json({ error: 'Failed to reach osu!', detail: String(err) }, 502);
        }

        if (!tokenRes.ok) {
            const detail = await tokenRes.text();
            return json({ error: 'osu! rejected the token request', detail }, 502);
        }

        const data = await tokenRes.json();
        cachedToken = data.access_token;
        // Refresh a minute early to be safe against edge-of-expiry races.
        cachedExpiresAt = now + (data.expires_in - 60) * 1000;

        return json({ access_token: cachedToken });
    },
};

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}