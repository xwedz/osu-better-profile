# osu! Better Profile

A Chrome extension that enhances osu! profile pages by injecting detailed score
stats — combo, hit counts (300/100/50/Miss), and beatmap max combo — directly
into pinned, top, and #1 scores, without you ever having to open each score's
page individually.

![manifest version](https://img.shields.io/badge/manifest-v3-blue)

## Features

- 🎯 Adds detailed hit-count breakdowns (300/100/50/Miss) to every score box
  on a player's profile
- 🔗 Shows player combo alongside the beatmap's max possible combo (`923/1024`)
- ⚡ Works across pinned scores, top ("best") scores, and #1 ("firsts") scores
- 🌐 Supports both classic/stable and lazer scoring formats
- 🔒 Uses osu!'s official OAuth flow — your credentials never leave osu!'s own
  login page

## Screenshots

![example](assets/example1.png)

## How it works

This extension talks directly to the [osu! API v2](https://osu.ppy.sh/docs/index.html).
When you're on a profile page, it:

1. Watches the page for score boxes as they appear (initial load, "Show More"
   clicks, or navigating to a different profile)
2. Looks up each visible score by its ID via the osu! API
3. Injects the extra stats directly into the page next to the existing
   accuracy/pp info

Only scores that are actually visible on screen are fetched — nothing is
downloaded in bulk up front.

Since this extension only ever reads **public** data (other players' scores
and beatmaps, not anything tied to whoever is using the extension), it
authenticates with osu! using the **client credentials** grant — an
app-level "guest" token that requires no user login at all. Minting that
token requires the app's client secret, which can't safely live inside a
browser extension (anyone can read an extension's source), so a small
Cloudflare Worker (see `worker/worker.js`) holds the secret and hands out
fresh tokens on request. The extension itself never sees or stores the
secret.

## ✅Installation

1. Download this repository (green **Code → Download ZIP** button on GitHub,
   then unzip it — or `git clone` if you prefer)
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the unzipped project folder
5. Visit any osu! profile page (`https://osu.ppy.sh/users/...`) and stats
   should start appearing on score boxes — no login, no setup, no API keys
 
That's it — this extension talks to a token-issuing server that's already
deployed and configured, so there's nothing else to set up on your end.


## Self-hosting your own backend (optional)

You don't need this section unless you want to run your own copy of the
token-issuing Worker instead of relying on the one this extension ships
pointing at (e.g. you forked this project, or just want your own
infrastructure).

This extension needs an osu! OAuth application and a small server-side
piece to hold that application's secret:

1. Register a new OAuth application at
   [osu!'s OAuth settings page](https://osu.ppy.sh/home/account/edit#new-oauth-application).
   The callback URL doesn't matter for this setup since we're not using the
   interactive login flow — any placeholder value works.
2. Deploy `worker/worker.js` as a Cloudflare Worker:
   - Cloudflare dashboard → **Workers & Pages** → **Create Worker**
   - Paste in the contents of `worker/worker.js`
   - Under that worker's **Settings → Variables**, add `OSU_CLIENT_ID` and
     `OSU_CLIENT_SECRET` (mark the secret one as **Encrypt**)
   - Deploy, and note the worker's URL (something like
     `https://osu-better-profile-token.<your-subdomain>.workers.dev`)
3. In `background.js`, change `TOKEN_ENDPOINT` to point at your own Worker's
   URL instead

After that, your copy of the extension will fetch tokens from your own
Worker instead of the default one.

## Project structure

```
.
├── manifest.json     # Chrome extension manifest (Manifest V3)
├── background.js     # Fetches/caches an API token from our Worker
├── content.js        # Injected into osu! profile pages; fetches and renders stats
├── worker/
│   └── worker.js      # Cloudflare Worker — holds the OAuth secret, mints tokens
└── README.md
```

## Permissions

| Permission  | Why it's needed                                      |
| ----------- | ----------------------------------------------------- |
| `storage`   | Caches the osu! API access token locally between sessions |

## Known limitations

- Beatmap max combo isn't available for every beatmap (e.g. some converts);
  in those cases only the player's combo is shown
- Relies on osu!'s internal page structure (CSS class names); if osu!
  redesigns their profile page, the injection points may need updating

## Contributing

Issues and pull requests are welcome!

## License

MIT — see [LICENSE](./LICENSE) for the full text.

## Disclaimer

This is an unofficial, fan-made project and isn't affiliated with or endorsed
by osu! or ppy Pty Ltd.
