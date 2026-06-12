# Times Table Blast! 🚀

A fun, offline-capable PWA for practising multiplication tables — built for a 9-year-old on an iPad.

## How it works

1. **Name screen** — whoever's playing types their name first. All the
   encouragement through the game uses that name, and their score goes on
   the leaderboard under it automatically. A "Change player" link on the
   home screen swaps players (great for friends taking turns). Special
   recognition: if the name is **Henry**, his nickname **"Winkles"** gets
   mixed into the encouragement at random.
2. **Pick a set** on the home screen:
   - **Set A** — 1× and 2× tables
   - **Set B** — 3× and 4× tables
   - **Set C** — 5× and 6× tables
   - **Set D** — 7× and 8× tables
   - **Set E** — 9× and 10× tables
   - **Set F** — 11× and 12× tables
3. A 3-2-1-GO countdown starts the round: **50 questions, 2 minutes**.
   Random questions from the set's two tables appear (shown either way
   round, e.g. `4 × 6` or `6 × 4`). The round ends the moment the 50th
   question is answered, or when the 2 minutes run out — whichever comes
   first. A progress pill shows how far through the 50 they are.
4. Type the answer on the big on-screen number pad and hit **GO!** (or Enter
   on a keyboard). Correct answers get instant praise and a streak counter;
   wrong answers briefly show the right answer, then move on.
5. **Results** — always scored out of 50 (e.g. "37/50"), with a star rating,
   an encouraging message, how much time was left if they finished early,
   a list of everything answered right, and a "ones to practise" list
   showing what they typed vs the real answer. Per-set best scores are
   saved on the device. **50/50 is the target** — a perfect round gets a
   special celebration: rainbow score, pulsing PERFECT 50 banner, a mega
   confetti storm and a longer victory fanfare.
6. **Leaderboard** — every finished round is added automatically under the
   player's name. The top 10 (with medals for the top 3) live under the 🏆
   Leaderboard button on the home screen. Scores are stored on the device;
   there's a small "Clear all scores" link at the bottom of the board.

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
