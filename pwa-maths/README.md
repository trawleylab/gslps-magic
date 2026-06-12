# Times Table Blast! 🚀

A fun, offline-capable PWA for practising multiplication tables — built for a 9-year-old on an iPad.

## How it works

1. **Pick a set** on the home screen:
   - **Set A** — 1× and 2× tables
   - **Set B** — 3× and 4× tables
   - **Set C** — 5× and 6× tables
   - **Set D** — 7× and 8× tables
   - **Set E** — 9× and 10× tables
   - **Set F** — 11× and 12× tables
2. A 3-2-1-GO countdown starts a **2-minute sprint**. Random questions from the
   set's two tables appear (shown either way round, e.g. `4 × 6` or `6 × 4`).
3. Type the answer on the big on-screen number pad and hit **GO!** (or Enter on
   a keyboard). Correct answers get instant praise and a streak counter;
   wrong answers briefly show the right answer, then move on.
4. When time's up: total score (n/N and %), a star rating, an encouraging
   message, a list of everything answered right, and a "ones to practise"
   list showing what they typed vs the real answer. Confetti for great scores,
   and a per-set best score is saved on the device.
5. **Leaderboard** — after a game, type your name to save your score. The
   top 10 (with medals for the top 3) live under the 🏆 Leaderboard button on
   the home screen. Scores are stored on the device; there's a small
   "Clear all scores" link at the bottom of the board.

## Personalisation

The app is personalised via the `PLAYER` constant at the top of `app.js`:

```js
const PLAYER = { name: 'Henry', nick: 'Winkles' };
```

The title, tagline, countdown, praise, streaks and results messages all use
the name or nickname (picked at random where `%N` appears in a message).
Change those two values to re-personalise for someone else.

## Running it

It's a static site — serve the folder over HTTP (service workers need
`http://localhost` or HTTPS, not `file://`):

```bash
cd pwa-maths
python3 -m http.server 8000
# open http://localhost:8000
```

## Installing on the iPad

1. Host the folder somewhere HTTPS (GitHub Pages, Netlify, etc.) or serve it
   on the local network.
2. Open the URL in Safari on the iPad.
3. Share button → **Add to Home Screen**. It runs full-screen and works
   offline after the first load.

## Updating

The service worker precaches everything. After changing any file, bump
`CACHE_VERSION` in `service-worker.js` (e.g. `ttblast-v1` → `ttblast-v2`) so
installed iPads pick up the new version on next launch.

## Sounds

Little WebAudio chimes for right/wrong/fanfare — no audio files needed.
The 🔊 button on the home screen mutes them (remembered between sessions).
