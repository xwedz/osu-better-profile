console.log("🟢 [osu! Better Profile] Extension loaded successfully.");

let currentInjectInterval = null;
let lastProcessedPath = null;

/**
 * Extracts the osu! user ID from the current URL.
 * @returns {string|null} The user ID or null if not found.
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
 * 從網址中解析出目前的遊戲模式 (osu, taiko, fruits, mania)
 */
function getGameModeFromUrl() {
    const pathParts = window.location.pathname.split('/');
    // 網址結構通常為 /users/{userId}/{mode}
    const usersIndex = pathParts.indexOf('users');
    if (usersIndex !== -1 && pathParts.length > usersIndex + 2) {
        const mode = pathParts[usersIndex + 2];
        const validModes = ['osu', 'taiko', 'fruits', 'mania'];
        if (validModes.includes(mode)) {
            return mode;
        }
    }
    return 'osu'; // 預設回傳 osu 標準模式
}

/**
 * Normalizes a score's `statistics` object into a common shape.
 *
 * Classic/stable-client scores come back with the old-style keys
 * (count_300 / count_100 / count_50 / count_miss). Native lazer scores use
 * the newer HitResult names instead (great / ok / meh / miss). Previously
 * the code only checked the classic keys, so lazer scores silently rendered
 * as 0/0/0/0 instead of throwing — which is why it looked like lazer scores
 * "just don't show up".
 *
 * If you inspect the console log below and find osu! is using different key
 * names than expected, add them here.
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
 * 完整獲取玩家的所有成績（動態對應當前遊戲模式）
 */
async function fetchTopScores(userId, token) {
    const currentMode = getGameModeFromUrl();
    console.log(`📡 正在獲取玩家 ${userId} 在 [${currentMode}] 模式下的成績資料...`);

    try {
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            // Without this, osu! silently falls back to a legacy-dated API
            // behavior (tied to whenever this OAuth app was registered),
            // which returns pre-migration score IDs for classic/stable
            // scores that no longer match the site's real permalink IDs.
            // Any date newer than 20220705 opts into the current ID scheme.
            'x-api-version': '20241022'
        };

        // 動態帶入當前模式參數
        const [pinnedRes, bestPage1Res, bestPage2Res] = await Promise.all([
            fetch(`https://osu.ppy.sh/api/v2/users/${userId}/scores/pinned?mode=${currentMode}`, { method: 'GET', headers }),
            fetch(`https://osu.ppy.sh/api/v2/users/${userId}/scores/best?mode=${currentMode}&limit=100&offset=0`, { method: 'GET', headers }),
            fetch(`https://osu.ppy.sh/api/v2/users/${userId}/scores/best?mode=${currentMode}&limit=100&offset=100`, { method: 'GET', headers })
        ]);

        const pinnedScores = pinnedRes.ok ? await pinnedRes.json() : [];
        const bestPage1 = bestPage1Res.ok ? await bestPage1Res.json() : [];
        const bestPage2 = bestPage2Res.ok ? await bestPage2Res.json() : [];

        const scoreMap = new Map();
        [...pinnedScores, ...bestPage1, ...bestPage2].forEach(score => {
            scoreMap.set(score.id, score);
        });

        const allScores = Array.from(scoreMap.values());
        console.log(`📊 [成功] 總共整合了 ${allScores.length} 筆 [${currentMode}] 成績資料！`);

        // TEMP DEBUG: confirm the real key names osu! sends for statistics,
        // especially on a profile that has lazer plays. Safe to delete once verified.
        allScores.slice(0, 3).forEach(s => console.log('🔍 raw statistics for score', s.id, s.statistics));

        injectDataIntoDOM(allScores);

    } catch (error) {
        console.error("⚠️ 抓取完整成績失敗:", error);
    }
}

/**
 * Asks the background script to handle authentication.
 * Thanks to background.js caching the token, this is cheap to call on
 * every navigation — it will NOT pop up a new login window unless the
 * cached token is missing or expired.
 */
function requestAuthentication(userId) {
    console.log("⏳ Asking background script to handle authentication...");

    chrome.runtime.sendMessage({ action: "authenticate" }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("⚠️ Communication error:", chrome.runtime.lastError);
            return;
        }

        if (response && response.success) {
            console.log("✅ Authentication successful!");
            fetchTopScores(userId, response.token);
        } else {
            console.error("❌ Authentication failed:", response?.error);
        }
    });
}

/**
 * 將 API 取得的成績資料，透過 Score ID 精準對接到網頁對應的 DOM 元素中
 * @param {Array} apiScores - 從 API 獲取的成績陣列
 */
function injectDataIntoDOM(apiScores) {
    console.log("🛠️ 開始尋找網頁元素，準備精準對接資料...");

    // If we navigated to a new profile while a previous polling loop was
    // still running, kill it first so we don't end up with multiple
    // intervals fighting over the page at once.
    if (currentInjectInterval) {
        clearInterval(currentInjectInterval);
        currentInjectInterval = null;
    }

    let attempts = 0;
    const MAX_ATTEMPTS = 30; // stop polling after ~30s so it doesn't run forever

    currentInjectInterval = setInterval(() => {
        attempts++;

        // 抓取網頁上所有的成績框框 (包含置頂、最佳、甚至是最近遊玩)
        const scoreElements = document.querySelectorAll('.play-detail--highlightable');

        if (scoreElements.length > 0) {
            scoreElements.forEach((element) => {
                // 1. 防止重複注入
                if (element.dataset.injected === "true") return;

                try {
                    // 2. 尋找框框內的背景連結，用來提取 Score ID
                    const linkElement = element.querySelector('.play-detail__bg-link');
                    if (!linkElement) return;

                    const href = linkElement.getAttribute('href');
                    const scoreIdOnPage = href.split('/').filter(Boolean).pop();

                    // 3. 全方位比對：同時包容新版 ID、舊版 Legacy ID、以及當事人專屬的 pin ID
                    const scoreData = apiScores.find(score => {
                        const pageId = String(scoreIdOnPage);
                        return (
                            String(score.id) === pageId ||
                            String(score.legacy_score_id) === pageId ||
                            String(score.current_user_attributes?.pin?.score_id) === pageId
                        );
                    });

                    if (!scoreData) {
                        // TEMP DEBUG: tells us WHICH scores never even get matched to a
                        // DOM element, and what IDs were available to compare against.
                        console.warn('❓ No API match for on-page score', {
                            href,
                            scoreIdOnPage,
                            availableIds: apiScores.map(s => ({
                                id: s.id,
                                legacy_score_id: s.legacy_score_id,
                                mods: s.mods
                            }))
                        });
                        return; // 找不到就安靜跳過
                    }

                    // TEMP DEBUG: for scores that DID match, show their mods + raw
                    // statistics so we can see exactly how "classic mod" scores differ
                    // from lazer scores in shape.
                    console.log('✅ Matched score', {
                        id: scoreData.id,
                        legacy_score_id: scoreData.legacy_score_id,
                        mods: scoreData.mods,
                        statistics: scoreData.statistics
                    });

                    // 標記為已注入
                    element.dataset.injected = "true";

                    // 4. 提取黃金數據 (normalized across classic + lazer statistics)
                    const maxCombo = scoreData.max_combo;
                    const { great, ok, meh, miss } = getHitCounts(scoreData.statistics);

                    // 5. 建立自訂的 HTML 區塊 (純淨對齊版)
                    const statsDiv = document.createElement('div');
                    statsDiv.className = 'custom-osu-stats';
                    statsDiv.style.cssText = `
                        display: flex; 
                        flex-direction: column; 
                        align-items: flex-end; 
                        justify-content: center;
                        
                        width: 110px; /* 固定寬度，確保直向完美對齊 */
                        margin-right: 20px; /* 與右邊的「準確率」保持一點距離 */
                        flex-shrink: 0; /* 防止被擠壓 */
                        
                        font-size: 13px; 
                        font-weight: 700; 
                        line-height: 1.3;
                        letter-spacing: 0.5px;
                    `;

                    const slash = `<span style="color: rgba(255, 255, 255, 0.3); margin: 0 2px;">/</span>`;

                    statsDiv.innerHTML = `
                        <div style="color: #a6e3a1; margin-bottom: 2px;">
                            ${maxCombo}<span style="font-size: 10px; color: rgba(255, 255, 255, 0.5);">x</span>
                        </div>
                        <div>
                            <span style="color: #89b4fa;">${great}</span>${slash}
                            <span style="color: #a6e3a1;">${ok}</span>${slash}
                            <span style="color: #f9e2af;">${meh}</span>${slash}
                            <span style="color: #f38ba8;">${miss}</span>
                        </div>
                    `;

                    // 6. 將區塊安插到 play-detail__score-detail 的最前面
                    const targetContainer = element.querySelector('.play-detail__score-detail');
                    if (targetContainer) {
                        targetContainer.insertBefore(statsDiv, targetContainer.firstChild);
                    }
                } catch (err) {
                    // Don't let one bad/unexpected score element kill the whole batch —
                    // previously an uncaught error here would silently stop processing
                    // of every element that came after it in the DOM.
                    console.error("⚠️ Failed to inject stats for one score element:", err);
                }
            });
        }

        if (attempts >= MAX_ATTEMPTS && currentInjectInterval) {
            clearInterval(currentInjectInterval);
            currentInjectInterval = null;
        }
    }, 1000);
}

/**
 * osu!'s profile page is a Vue single-page app: navigating to a different
 * user's profile (or switching the mode tab) updates the URL via
 * history.pushState WITHOUT a full page reload. Chrome only re-injects
 * content scripts on real navigations, so without this, content.js would
 * only ever run once and keep showing stats for whichever profile you
 * first loaded — which is why a hard refresh (F5) was needed every time.
 *
 * We patch pushState/replaceState and listen for popstate to detect these
 * in-page route changes ourselves and re-run the fetch/inject flow.
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

    // Only re-run when we've actually landed on a new path (new user id or
    // mode), not on every incidental pushState the page might fire.
    if (path === lastProcessedPath) return;
    lastProcessedPath = path;

    console.log(`🎯 Target User ID: ${userId} (path: ${path})`);
    requestAuthentication(userId);
}

// Initialization — covers both the first real page load and, from here on,
// every subsequent in-page SPA navigation.
patchHistoryForSpaNavigation();
handlePossibleNavigation();