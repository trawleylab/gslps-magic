# Stick Flight ✈️

A fast, offline-capable 3D flight game for kids — sibling to *Times Table Blast*.
Built as a static PWA with Three.js (r128, vendored locally). No build step, no
internet needed after the first load.

## What it is

A chunky low-poly plane carrying **your stick figure** auto-flies across a
low-poly city. You only **weave** — up, down, left, right — to dodge the
oncoming military planes. Reach the giant chequered **finish arch** and you
**WIN** and earn Stick Tokens 🪙. Get hit and the plane **explodes** and your
stick figure **ragdolls** to the ground (crashing is half the fun).

A run is about 75 seconds, single life, fixed distance. The first few seconds
are a safe "grace" zone with no enemies so you can learn the controls.

## How to play

- **iPad (touch):** drag anywhere on the screen to steer — drag up to fly up,
  left to go left, and so on. Let go and the plane gently levels itself out.
- **Chromebook / keyboard:** Arrow keys **or** WASD. W/↑ up, S/↓ down,
  A/← left, D/→ right. **Space** or **Enter** starts and restarts; **Esc**
  quits to the home screen.
- **Mouse:** click-and-drag works just like touch.

Fly through the finish arch to win. Touch any enemy and you crash — but you
still keep the tokens you earned on the way.

## Stick Tokens 🪙 + customizing

Every run pays tokens:

- **Distance:** 1 token per 100 units flown (you always keep these, even on a
  crash — a run is never a total loss).
- **Near-misses:** +1 each for a close squeak past an enemy (up to 15 per run).
- **Finish bonus:** +25 for crossing the finish arch.

A finished run is roughly 40–60 tokens; a crash is roughly 15–30.

Spend tokens in the **🎨 Customize** shop. A slowly-spinning hero figure shows
your stick person live as you shop. Four slots, one item equipped per slot:

- **Hat:** No Hat, Cap, Party Hat, Helmet, Crown
- **Colour:** Blue, Red, Green, Hot Pink, Gold
- **Cape:** No Cape, Red Cape, Rainbow Cape
- **Trail:** White, Fire, Rainbow plane exhaust

Owned items show a ✓ and equip on tap; locked items show their price and buy on
tap if you can afford them. Your look rides along everywhere — in the cockpit
while flying, on the win screen, and on the ragdoll when you crash. Your tokens,
best distance, owned items, and equipped look are all saved on the device.

## Running it

It's a static site — serve the folder over HTTP (service workers need
`http://localhost` or HTTPS, not `file://`):

```bash
cd pwa-stickflight
python3 -m http.server 8000
# open http://localhost:8000
```

## Installing on the iPad

1. Host the folder somewhere HTTPS (GitHub Pages, Netlify, etc.) or serve it on
   the local network.
2. Open the URL in Safari on the iPad.
3. Share button → **Add to Home Screen**. It runs full-screen in landscape and
   works offline after the first load.

## Updating

The service worker precaches everything (including the vendored Three.js, which
is required for offline play). After changing any file, bump `CACHE_VERSION` in
`service-worker.js` (e.g. `stickflight-v1` → `stickflight-v2`) so installed
iPads pick up the new version on next launch.

## Sounds

Little WebAudio chimes for start, near-misses, the boom, the win fanfare, and
shop buys — no audio files needed. The 🔊 button on the home screen mutes them
(remembered between sessions).
