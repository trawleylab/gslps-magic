# GSLPS Magic — Sub Manager (PWA)

Courtside substitution manager for the **GSLPS Magic** junior basketball team.
Built for a default game of **2 halves × 20 minutes** — the format used by the
GSLPS Magic — with editable settings if your league differs.

This is a Progressive Web App: plain HTML, CSS, and vanilla JavaScript with a
service worker for offline use. No build step, no frameworks, no `npm`.
Drop the files on any static host, "Add to Home Screen" on an iPad, and
you've got a courtside app that keeps working when the wifi drops.

> Note: the repo also contains an R Shiny version of the same app (at the
> repo root). The PWA lives in this `pwa/` subdirectory so the two don't
> collide.

## Roster fields

Each player has just two fields:

| field    | type    | notes          |
|----------|---------|----------------|
| `name`   | string  |                |
| `number` | int     | jersey number  |

(Player IDs are auto-generated and stable across edits.)

---

## File structure

```
pwa/
├── index.html          single-page app shell
├── styles.css          all styling (dark theme, landscape)
├── app.js              game state, UI rendering, rule engine
├── manifest.json       PWA manifest
├── service-worker.js   offline cache
├── icons/              192/512 icons + 180 apple-touch-icon
├── roster.json         default roster (editable in-app, persisted to localStorage)
└── README.md
```

## How to host it

The PWA is just static files. Any static host works. Two easy options:

### GitHub Pages

1. Push the repo to GitHub.
2. Settings → Pages → Source: **Deploy from branch** → branch `main`, folder `/ (root)`.
3. Wait a minute. The PWA will be live at:
   `https://<your-user>.github.io/<your-repo>/pwa/`
4. On the iPad, open that URL in **Safari** (not Chrome — iOS Add to Home
   Screen only fully supports Safari). Tap the **Share** icon → **Add to
   Home Screen**. Name it "Magic" and tap **Add**.

> **Subpath gotcha:** because the PWA lives at `/pwa/`, the manifest's
> `start_url` and `scope` are relative (`./`). That's already set correctly.
> If you move the folder elsewhere (e.g. host it at the repo root), nothing
> needs to change — the relative paths just work.

### Any other static host

- **Netlify / Vercel / Cloudflare Pages:** drag the `pwa/` folder into their
  drag-and-drop deploy area. Done.
- **Self-hosted:** copy `pwa/` to any web server (Apache, nginx, Caddy).
  Just make sure `service-worker.js` is served with `Content-Type:
  application/javascript` (every modern host does this by default).
- **Local dev:** from the `pwa/` folder, run `python3 -m http.server 8000`
  and visit `http://localhost:8000`. The service worker only registers over
  `https://` or `http://localhost`, so opening `index.html` directly via
  `file://` won't give you the offline behaviour.

## Installing on an iPad

1. Open the hosted URL in **Safari** on the iPad.
2. Tap the **Share** icon (square with up-arrow) in the toolbar.
3. Tap **Add to Home Screen**.
4. The default name is "Magic" — leave it or rename. Tap **Add**.
5. Launch the app from the home screen icon. It'll open full-screen, in
   landscape, with no Safari chrome — just the app.
6. Once installed, you can put the iPad in airplane mode and the app will
   keep working. Game state is held in `localStorage` and the app shell is
   cached by the service worker.

## How offline caching works (and how to force an update)

On first load the service worker (`service-worker.js`) precaches the entire
app shell — `index.html`, `styles.css`, `app.js`, `manifest.json`,
`roster.json`, and the icons. From then on the app loads from cache first
and falls back to network. That's why it works fully offline.

**To ship an update:** open `service-worker.js` and bump the cache version
string at the top:

```js
const CACHE_VERSION = 'gslps-magic-v1';   // → 'gslps-magic-v2'
```

When the iPad next opens the app while online, the new service worker
installs, deletes the old cache, and takes over. The new files are visible
on the next launch (or after a pull-to-refresh inside the app's standalone
window — Safari supports this in PWA mode).

If you want the change to apply immediately on the iPad, you can also:
- Long-press the home-screen icon → **Remove App** → re-add from Safari, or
- Settings → Safari → Advanced → Website Data → search "magic" → delete.

## How the rule engine works

Rules live in the `RULES` array near the top of `app.js`. Each rule is a
plain object:

```js
{
  id: 'myRule',
  label: 'Short user-facing label, shown in the warning modal & settings',
  check(proposedOnCourt, gameState) {
    // proposedOnCourt: array of player objects (5 of them) for the lineup
    //                  the coach is about to commit to
    // gameState: the full live state (roster, playerStats, currentHalf, …)
    if (/* the lineup is fine */) {
      return { passed: true };
    }
    return {
      passed: false,
      severity: 'warning',                 // or 'info'
      message: 'Human-readable explanation shown in the warning modal.'
    };
  }
}
```

Before each substitution, every enabled rule runs over the proposed lineup.
If any return `passed: false`, a modal lists the warnings and the coach
chooses **Override and confirm** or **Cancel**. Rules are *soft warnings* —
never hard blocks — because the coach is the source of truth.

### Adding a new rule

1. Open `app.js`.
2. Append a new object to the `RULES` array following the contract above.
3. Add a default config entry to `DEFAULT_RULES` at the top of the file:
   ```js
   const DEFAULT_RULES = {
     // …existing…
     myRule: { enabled: true }            // add tunable params here too
   };
   ```
4. (Optional, if your rule has tunable thresholds) — render an input in
   `renderSettings()` with `data-action="set-rule-param"`,
   `data-rule="myRule"`, `data-key="yourParamName"`. The change handler
   in section 9 will pick it up automatically.

The settings panel iterates `RULES`, so the new rule's enable/disable toggle
shows up with no other wiring needed.

### Disabling a rule at runtime

Open the **Settings** screen and untick its checkbox. Disabled rules are
skipped entirely by `runRules()`.

### Built-in rules

| ID                    | What it checks                                                                |
|-----------------------|-------------------------------------------------------------------------------|
| `consecutiveMinutes`  | No on-court player past the consecutive-minutes limit (default 5 min)         |
| `minutesSpread`       | No player more than ±N min from team average (default 4 min, gated early-game)|

## How the substitution flow works

- Tap a player on court → they're selected (cyan border).
- Tap a player on bench → they're selected.
- **As soon as exactly 1 court + 1 bench are selected, the swap commits
  immediately** (after the rule check). This is the fast path for the most
  common case.
- For multi-subs: tap multiple court players first (or multiple bench
  first). When you have matching counts ≥ 2 each, a **Confirm n-for-n**
  button appears in the action bar. Tap to commit.
- If a rule fails, the warning modal opens. **Override and confirm** still
  commits; **Cancel** closes the modal and leaves your selection intact so
  you can pick someone else.
- Tap a selected player to deselect, or use **Clear selection**.

## Game format

Default: **2 halves of 20 minutes**. Edit in **Settings → Game format**.
Halves: 1–4. Minutes per half: 1–40. Changes take effect at the start of
a fresh half (a running clock is left alone). Halftime resets every
player's "consecutive on court" counter, since the break is a real rest.

## Keeping subs frequent — the "next sub due" indicator

Under the half label in the header, the app shows a small countdown:

- **`Next sub in M:SS`** (muted) — plenty of time before the next planned sub.
- **`Sub due in 0:25`** (amber) — within 30s of the target interval.
- **`Sub overdue 0:15`** (red, pulsing) — past the target.

The target interval defaults to **3 minutes** (kids on the bench get bored
fast). Edit it in **Settings → Game format → Target sub interval (min)**.
The countdown is in *game-clock* time (a paused clock pauses the indicator)
and resets on every committed sub and at halftime.

## State persistence

Every state mutation calls `persist()`, which writes the whole `gameState`
object to `localStorage` under the key `gslps_magic_state_v1`. On launch,
the app restores that state. A refresh, an accidental close, or an iPad
sleep won't lose the game.

To start completely fresh: **Settings → Game → Start new game**. (Or, if
you want to wipe everything including the roster, clear Safari's website
data for the site.)

## Editing in `app.js`

The file is organised into ten clearly-marked sections. The reactive flow
is intentionally trivial:

```
user taps   →   handler mutates gameState   →   persist()   →   render()
```

`render()` rewrites the relevant DOM subtrees from `gameState`. There's no
diffing and no virtual DOM — if the UI is wrong, the bug is either in the
state mutation or the render function for that subtree.
