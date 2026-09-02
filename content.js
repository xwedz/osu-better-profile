console.log("🟢 [osu! Better Profile] Extension loaded successfully.");

let lastProcessedPath = null;
let cachedToken = null;
let domObserver = null;

// Cache of beatmap_id -> max_combo, shared across the whole browsing session
// so we never re-fetch a beatmap's max combo twice, even across navigations.
const beatmapMaxComboCache = new Map();

/**
 * Extracts the osu! user ID from the current URL (used only to detect when
 * we've navigated to a different profile — no longer needed for API calls).
 */
function getUserIdFromUrl() {
    const pathParts = window.location.pathname.split('/');
    const usersIndex = pathParts.indexOf('users');

    if (usersIndex !== -1 && pathParts.length > usersIndex + 1) {
        return pathParts[usersIndex + 1];
    }
    return null;
}

/**
 * Normalizes a score's `statistics` object into a common shape.
 *
 * Classic/stable-client scores come back with the old-style keys
 * (count_300 / count_100 / count_50 / count_miss). Native lazer scores use
 * the newer HitResult names instead (great / ok / meh / miss).
 */
function getHitCounts(statistics = {}) {
    return {
        great: statistics.count_300 ?? statistics.great ?? 0,
        ok: statistics.count_100 ?? statistics.ok ?? 0,
        meh: statistics.count_50 ?? statistics.meh ?? 0,
        miss: statistics.count_miss ?? statistics.miss ?? 0,
    };
}

/**
 * Gets a valid OAuth token, asking background.js for one. background.js
 * caches it in chrome.storage.local, so this is cheap — we additionally
 * cache it here in memory for the lifetime of this content script so we're
 * not even sending a runtime message for every single score lookup.
 */
function getToken() {
    if (cachedToken) return Promise.resolve(cachedToken);

    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: "authenticate" }, (response) => {
            if (chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
            }
            if (response && response.success) {
                cachedToken = response.token;
                resolve(cachedToken);
            } else {
                reject(new Error(response?.error || "Authentication failed"));
            }
        });
    });
}

function buildHeaders(token) {
    return {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        // Without this, osu! silently falls back to a legacy-dated API
        // behavior (tied to whenever this OAuth app was registered), which
        // returns pre-migration score IDs that no longer match the site's
        // real permalink IDs. Any date newer than 20220705 opts into the
        // current ID scheme.
        'x-api-version': '20241022'
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wraps fetch() with automatic retry on HTTP 429 (Too Many Requests).
 * Honors the Retry-After header when osu! sends one; otherwise backs off
 * exponentially. Without this, a burst of requests (e.g. 50 scores appearing
 * at once after clicking "Show More") reliably gets rate-limited.
 */
async function fetchWithRetry(url, headers, { maxRetries = 5 } = {}) {
    let attempt = 0;
    while (true) {
        const res = await fetch(url, { method: 'GET', headers });
        if (res.status !== 429) return res;

        attempt++;
        if (attempt > maxRetries) return res; // give up, let the caller treat this as a failure

        const retryAfterHeader = res.headers.get('Retry-After');
        const waitMs = retryAfterHeader
            ? parseFloat(retryAfterHeader) * 1000
            : Math.min(500 * 2 ** attempt, 8000); // exponential backoff, capped at 8s

        console.warn(`⏳ Rate limited — waiting ${Math.round(waitMs)}ms before retry ${attempt}/${maxRetries} (${url})`);
        await sleep(waitMs);
    }
}

/**
 * Runs `worker` over `items` with at most `limit` running concurrently,
 * instead of firing everything at once. This is what actually prevents the
 * 429s in the first place — retries alone just delay the same burst.
 */
async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runner() {
        while (nextIndex < items.length) {
            const current = nextIndex++;
            results[current] = await worker(items[current], current);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
    return results;
}

/**
 * Fetches a single score by its exact ID — the same ID that's in the
 * score's permalink on the page (https://osu.ppy.sh/scores/{id}). This
 * replaces the old approach of bulk-downloading every pinned/best/firsts
 * score and trying to match IDs, which was both slow (fetching way more
 * data than was ever shown) and unreliable (osu!'s bulk endpoints can
 * return a different, legacy-era ID for older scores than what the score's
 * own page uses).
 */
async function fetchScoreById(scoreId, headers) {
    try {
        const res = await fetchWithRetry(`https://osu.ppy.sh/api/v2/scores/${scoreId}`, headers);
        if (!res.ok) {
            console.warn(`⚠️ Score ${scoreId} lookup failed (${res.status})`);
            return null;
        }
        return await res.json();
    } catch (err) {
        console.error(`⚠️ Score ${scoreId} lookup errored:`, err);
        return null;
    }
}

/**
 * osu!'s score endpoints only return the PLAYER's combo (score.max_combo) —
 * the beatmap's maximum POSSIBLE combo isn't included there at all (see
 * ppy/osu-web#8536). To show "player combo / max combo" we separately fetch
 * each beatmap via /beatmaps (up to 50 ids per request). Results are cached
 * in beatmapMaxComboCache so repeat maps across scores/navigations are free.
 */
async function fetchMissingBeatmapMaxCombos(beatmapIds, headers) {
    const missing = [...new Set(beatmapIds.filter(id => id && !beatmapMaxComboCache.has(id)))];
    if (missing.length === 0) return;

    const BATCH_SIZE = 50;
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
        const batch = missing.slice(i, i + BATCH_SIZE);
        const params = batch.map(id => `ids[]=${id}`).join('&');

        try {
            const res = await fetchWithRetry(`https://osu.ppy.sh/api/v2/beatmaps?${params}`, headers);
            if (!res.ok) continue;

            const data = await res.json();
            (data.beatmaps || []).forEach(bm => beatmapMaxComboCache.set(bm.id, bm.max_combo ?? null));
        } catch (err) {
            console.error('⚠️ Failed to fetch a batch of beatmap max combos:', err);
        }
    }
}

/**
 * Computes the combo display text for a score. If we don't have the
 * beatmap's max combo cached yet, falls back to just the player's combo —
 * callers can call this again later (via updateComboText) once the max
 * combo has been fetched, to patch it in without a full re-render.
 */
function getComboText(scoreData) {
    const playerCombo = scoreData.max_combo;
    const beatmapMaxCombo = beatmapMaxComboCache.get(scoreData.beatmap_id);
    return beatmapMaxCombo
        ? `${playerCombo}<span style="font-size: 10px; color: rgba(255, 255, 255, 0.5);">x / ${beatmapMaxCombo}x</span>`
        : `${playerCombo}<span style="font-size: 10px; color: rgba(255, 255, 255, 0.5);">x</span>`;
}

/**
 * Builds and inserts the stats block for one score element. Renders
 * immediately with whatever combo info is available right now (see
 * getComboText) — if the beatmap's max combo isn't cached yet, the caller
 * is expected to call updateComboText() on this element once it is, rather
 * than waiting to render at all.
 */
function renderStats(element, scoreData) {
    const comboText = getComboText(scoreData);
    const { great, ok, meh, miss } = getHitCounts(scoreData.statistics);

    const statsDiv = document.createElement('div');
    statsDiv.className = 'custom-osu-stats';
    statsDiv.style.cssText = `
        display: flex; 
        flex-direction: column; 
        align-items: flex-end; 
        justify-content: center;
        
        width: max-content; /* let the box grow to fit long numbers instead of wrapping */
        min-width: 110px; /* keep short scores visually aligned with each other */
        margin-right: 20px; /* 與右邊的「準確率」保持一點距離 */
        flex-shrink: 0; /* 防止被擠壓 */
        
        font-size: 13px; 
        font-weight: 700; 
        line-height: 1.3;
        letter-spacing: 0.5px;
    `;

    const slash = `<span style="color: rgba(255, 255, 255, 0.3); margin: 0 2px;">/</span>`;

    statsDiv.innerHTML = `
        <div class="custom-osu-combo" style="color: #a6e3a1; margin-bottom: 2px; white-space: nowrap; text-align: right;">
            ${comboText}
        </div>
        <div style="white-space: nowrap; text-align: right;">
            <span style="color: #89b4fa;">${great}</span>${slash}
            <span style="color: #a6e3a1;">${ok}</span>${slash}
            <span style="color: #f9e2af;">${meh}</span>${slash}
            <span style="color: #f38ba8;">${miss}</span>
        </div>
    `;

    const targetContainer = element.querySelector('.play-detail__score-detail');
    if (targetContainer) {
        targetContainer.insertBefore(statsDiv, targetContainer.firstChild);
    }
}

/**
 * Patches just the combo line of an already-rendered score once its
 * beatmap's max combo becomes available, instead of re-rendering the whole
 * stats block.
 */
function updateComboText(element, scoreData) {
    const comboDiv = element.querySelector('.custom-osu-combo');
    if (comboDiv) {
        comboDiv.innerHTML = getComboText(scoreData);
    }
}

/**
 * Takes a batch of freshly-seen `.play-detail--highlightable` elements
 * (whether from the initial page render or a later "Show More" click),
 * fetches ONLY the scores those elements represent, and injects stats.
 *
 * This is the core of the lazy-loading approach: nothing is fetched for
 * scores that aren't currently visible on the page. Each score is also
 * rendered the moment ITS OWN fetch completes (inside the concurrency
 * worker below), rather than waiting for the whole batch to finish — so
 * with "Show More" pulling in 50 scores, you'll see them appear in a
 * steady trickle instead of all popping in at once after several seconds.
 */
async function processScoreElements(elements) {
    // De-dupe and immediately mark everything "pending" so a second
    // mutation event firing before this batch finishes can't queue the
    // same elements twice.
    const toProcess = [];
    for (const element of elements) {
        if (element.dataset.injected) continue; // "pending", "true", or "failed" — skip
        const linkElement = element.querySelector('.play-detail__bg-link');
        if (!linkElement) continue;

        const href = linkElement.getAttribute('href');
        const scoreId = href.split('/').filter(Boolean).pop();
        if (!scoreId) continue;

        element.dataset.injected = "pending";
        toProcess.push({ element, scoreId });
    }

    if (toProcess.length === 0) return;

    console.log(`🔎 Fetching ${toProcess.length} newly visible score(s)...`);

    let headers;
    try {
        const token = await getToken();
        headers = buildHeaders(token);
    } catch (err) {
        console.error("❌ Authentication failed:", err);
        toProcess.forEach(({ element }) => { element.dataset.injected = "failed"; });
        return;
    }

    // Beatmaps whose max combo we didn't already have cached when we
    // rendered a score against them — we'll batch-fetch these once and
    // patch the affected elements afterward.
    const pendingComboUpdates = [];

    // Fetch each visible score, but throttled — a burst of 30-50 scores
    // appearing at once (e.g. after "Show More") will get rate-limited if
    // fired all in parallel, so only a handful run concurrently. Each score
    // is rendered as soon as ITS fetch resolves, not after the whole batch.
    const SCORE_FETCH_CONCURRENCY = 5;
    await runWithConcurrency(toProcess, SCORE_FETCH_CONCURRENCY, async ({ element, scoreId }) => {
        const scoreData = await fetchScoreById(scoreId, headers);

        if (!scoreData) {
            element.dataset.injected = "failed";
            return;
        }

        try {
            renderStats(element, scoreData);
            element.dataset.injected = "true";

            if (!beatmapMaxComboCache.has(scoreData.beatmap_id)) {
                pendingComboUpdates.push({ element, scoreData });
            }
        } catch (err) {
            console.error("⚠️ Failed to render stats for a score element:", err);
            element.dataset.injected = "failed";
        }
    });

    // Backfill "/max combo" for whichever beatmaps weren't already cached —
    // this happens after the fact so it doesn't hold up the initial render.
    if (pendingComboUpdates.length > 0) {
        const beatmapIds = pendingComboUpdates.map(p => p.scoreData.beatmap_id);
        await fetchMissingBeatmapMaxCombos(beatmapIds, headers);
        pendingComboUpdates.forEach(({ element, scoreData }) => updateComboText(element, scoreData));
    }
}

/**
 * Sets up a single persistent MutationObserver that watches for
 * `.play-detail--highlightable` elements appearing anywhere on the page —
 * whether that's the initial batch on page load, more revealed by clicking
 * "Show More", or an entirely new set swapped in after navigating to a
 * different profile (Vue re-renders the DOM in place without a full page
 * reload, see the pushState hook below).
 */
function setupScoreObserver() {
    if (domObserver) {
        domObserver.disconnect();
    }

    // Process whatever's already rendered right now.
    processNewNodes(document.querySelectorAll('.play-detail--highlightable'));

    domObserver = new MutationObserver((mutations) => {
        const newElements = [];
        for (const mutation of mutations) {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                if (node.matches?.('.play-detail--highlightable')) {
                    newElements.push(node);
                }
                node.querySelectorAll?.('.play-detail--highlightable')
                    .forEach(el => newElements.push(el));
            });
        }
        if (newElements.length > 0) {
            processNewNodes(newElements);
        }
    });

    domObserver.observe(document.body, { childList: true, subtree: true });
}

function processNewNodes(nodeList) {
    processScoreElements(Array.from(nodeList)).catch(err => {
        console.error("⚠️ Unexpected error processing score elements:", err);
    });
}

/**
 * osu!'s profile page is a Vue single-page app: navigating to a different
 * user's profile (or switching the mode tab) updates the URL via
 * history.pushState WITHOUT a full page reload. We patch pushState /
 * replaceState and listen for popstate to detect these in-page route
 * changes, mainly so we can clear stale `injected` markers in case Vue
 * reuses a DOM node across the navigation (rare, but cheap to guard against)
 * — actual data loading is handled by the MutationObserver above either way.
 */
function patchHistoryForSpaNavigation() {
    const fireLocationChange = () => window.dispatchEvent(new Event('osu-profile-locationchange'));

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
        const result = originalPushState.apply(this, args);
        fireLocationChange();
        return result;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
        const result = originalReplaceState.apply(this, args);
        fireLocationChange();
        return result;
    };

    window.addEventListener('popstate', fireLocationChange);
    window.addEventListener('osu-profile-locationchange', handlePossibleNavigation);
}

function handlePossibleNavigation() {
    const userId = getUserIdFromUrl();
    const path = window.location.pathname;

    if (!userId) {
        lastProcessedPath = null;
        return;
    }

    if (path === lastProcessedPath) return;
    lastProcessedPath = path;

    console.log(`🎯 Navigated to user ${userId} (path: ${path})`);

    // Guard against Vue reusing a DOM node across the navigation: clear any
    // leftover markers so processScoreElements is willing to re-check them.
    document.querySelectorAll('.play-detail--highlightable[data-injected]').forEach(el => {
        delete el.dataset.injected;
    });
    processNewNodes(document.querySelectorAll('.play-detail--highlightable'));
}

// Initialization
patchHistoryForSpaNavigation();
handlePossibleNavigation();
setupScoreObserver();