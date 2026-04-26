# GSLPS Magic — Rotation Chart (PWA)

Sister app to [`../pwa/`](../pwa/). Same team, same offline behaviour, but a
totally different UX: instead of live "next sub" suggestions and per-player
minute tracking, the **whole game's rotation is pre-computed at game start**
and shown as a static schedule. Coach reads it off the wall clock — no
tapping required during play.

This matches the standard junior-basketball "block rotation" rules:

| Active players | Bench | Pattern                     |
|----------------|-------|-----------------------------|
| 5              | 0     | everyone plays the full game |
| 6              | 1     | sub 1 every block            |
| 7              | 2     | sub 2 every block            |
| 8              | 3     | sub 3 every block            |

Default block size is **5 minutes** (4 blocks per 20-min half), so you only
think about subs at the 15:00, 10:00 and 5:00 marks of each half.

## Which app should I use?

Use **whichever you like** — both work fully offline, both can be installed
on the iPad, both share the same roster of players (but each holds its own
copy in `localStorage`, so changes in one don't affect the other).

| Feature                          | `pwa/` (Sub Manager)            | `pwa-chart/` (this one) |
|----------------------------------|---------------------------------|---------------------------|
| Live "Next Off / Next On" panel  | yes                             | —                         |
| Pre-computed game schedule       | —                               | yes                       |
| Per-player minute tracking       | yes                             | —                         |
| Soft rule warnings on each sub   | yes                             | —                         |
| Tap-to-swap UI                   | yes                             | —                         |
| Best for…                        | reactive coaching, edge cases   | predictable, low-stress   |

## Telling the icons apart on the iPad

The chart app's icon is hue-shifted from the Sub Manager's: **teal
basketball with orange glowing text** (vs orange basketball with cyan text).
Same logo, complementary colours. The home-screen label is **"Chart"** vs
**"Magic"**.

## File structure

```
pwa-chart/
├── index.html          single-page shell
├── styles.css          dark theme, table-focused layout
├── app.js              state, schedule generator, render
├── manifest.json
├── service-worker.js
├── icons/
├── roster.json         starter roster (editable in-app)
└── README.md
```

## How the rotation is generated

The schedule generator is a single function near the top of `app.js`. It uses
**queue right-rotation by bench-size** each block, which produces the same
pattern as the standard "pairs come on/off" rotation in the Collingwood
Basketball coaching guide:

1. Start with all active players in roster order: e.g. `[1,2,3,4,5,6,7]`.
2. **Block 1:** the first 5 are on court (`1,2,3,4,5`), the last 2 are
   bench (`6,7`).
3. Rotate the queue to the right by `bench-size` (= 2): the queue becomes
   `[6,7,1,2,3,4,5]`.
4. **Block 2:** first 5 on court (`6,7,1,2,3`), last 2 bench (`4,5`).
5. Repeat for each block, continuously across both halves. Continuous
   rotation across the whole game spreads minutes as evenly as the math
   allows.

For an 8-block game (2 halves × 4 blocks) with 8 players, every kid plays
exactly 5 blocks. With 7 players, 5 play 6 blocks (30 min) and 2 play 5
blocks (25 min) — about as fair as 7-into-40 can divide.

## How to host it

Identical to the sister app — the PWA is just static files. With both apps
in the same repo, GitHub Pages serves them at:

```
https://<user>.github.io/<repo>/pwa/
https://<user>.github.io/<repo>/pwa-chart/
```

Open each in Safari on the iPad and **Add to Home Screen** separately.
You'll get two icons. The one with the **teal basketball + "Chart"** label
is this app.

## Forcing an update

Same trick as the sister app: bump `CACHE_VERSION` at the top of
`service-worker.js`. The next time the iPad opens the app while online, the
new SW installs, drops the old cache, and takes over.
