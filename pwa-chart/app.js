// =============================================================================
// GSLPS Magic — Rotation Chart (PWA, vanilla JS)
//
// Sister app to ../pwa/ but with a totally different UX: instead of live
// suggestions and per-player minute tracking, the WHOLE GAME's rotation is
// pre-computed at game start and shown as a static schedule. Coach reads it
// off the wall clock — no tapping required during play.
//
// Reactive flow: state mutation → persist() → render(). Same simple model as
// the interactive app.
//
// Sections:
//   1. Constants & defaults
//   2. State (default factory + load/save to localStorage)
//   3. Helpers
//   4. Schedule generator (queue right-rotation by bench-size each block)
//   5. Clock
//   6. Roster mutations
//   7. Render
//   8. Event delegation
//   9. Init + service worker
// =============================================================================

'use strict';

// -- 1. CONSTANTS -------------------------------------------------------------

const STORAGE_KEY   = 'gslps_magic_chart_state_v1';
const ROSTER_URL    = 'roster.json';
const TICK_INTERVAL = 1000;

const DEFAULTS = {
  halves: 2,
  halfMinutes: 20,
  blocksPerHalf: 4   // 4 × 5-min blocks for a 20-min half
};


// -- 2. STATE -----------------------------------------------------------------

let gameState  = null;
let tickHandle = null;

function createDefaultGameState(roster) {
  const seed = roster.map(p => ({ active: true, ...p }));
  return {
    teamName: 'GSLPS Magic',
    halves: DEFAULTS.halves,
    halfMinutes: DEFAULTS.halfMinutes,
    blocksPerHalf: DEFAULTS.blocksPerHalf,
    currentHalf: 1,
    clockSeconds: DEFAULTS.halfMinutes * 60,
    clockRunning: false,
    gameEnded: false,
    roster: seed,
    view: 'chart'   // 'chart' | 'settings'
  };
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState)); }
  catch (e) { console.warn('persist failed:', e); }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}


// -- 3. HELPERS ---------------------------------------------------------------

function $(sel) { return document.querySelector(sel); }

function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtMinSec(min) {
  // Convert a fractional minute count into "MM:SS" for the schedule labels.
  const totalSec = Math.round(min * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Coach calls kids by first name — that's what we display.
function firstName(name) {
  const s = String(name || '').trim();
  return s ? s.split(/\s+/)[0] : '?';
}

function getPlayer(id) { return gameState.roster.find(p => p.id === id); }
function activeRoster() { return gameState.roster.filter(p => p.active !== false); }


// -- 4. SCHEDULE GENERATOR ----------------------------------------------------
//
// Queue right-rotation by bench-size each block produces an even rotation
// that mirrors the standard "pairs come on/off" junior basketball pattern.
//
//   7 active → bench 2 → swap 2 every block
//   8 active → bench 3 → swap 3 every block
//   6 active → bench 1 → swap 1 every block
//   5 active → bench 0 → no rotation
//
// Continuous rotation across both halves spreads minutes as evenly as the
// math allows (perfectly even when blocks % active == 0, e.g. 8 blocks ÷ 8).

function generateSchedule() {
  const active = activeRoster();
  const N = active.length;
  const totalBlocks = gameState.halves * gameState.blocksPerHalf;
  const blockMin = gameState.halfMinutes / gameState.blocksPerHalf;
  if (N < 5) return { blocks: [], blockMin, error: `Need at least 5 active players (have ${N}).` };

  const benchSize = N - 5;
  let queue = active.slice();
  const blocks = [];
  for (let i = 0; i < totalBlocks; i++) {
    const half = Math.floor(i / gameState.blocksPerHalf) + 1;
    const inHalf = i % gameState.blocksPerHalf;
    const startMin = gameState.halfMinutes - inHalf * blockMin;
    const endMin   = startMin - blockMin;
    blocks.push({
      idx: i, half, inHalf,
      startMin, endMin,
      court: queue.slice(0, 5),
      bench: queue.slice(5)
    });
    if (benchSize > 0) {
      // Rotate right by bench-size: last `benchSize` players become the new
      // court, the previous court shifts down toward the bench.
      queue = queue.slice(-benchSize).concat(queue.slice(0, queue.length - benchSize));
    }
  }
  return { blocks, blockMin };
}

function currentBlockIndex() {
  if (gameState.gameEnded) return null;
  const blockSec = (gameState.halfMinutes / gameState.blocksPerHalf) * 60;
  const elapsedThisHalf = gameState.halfMinutes * 60 - gameState.clockSeconds;
  const inHalf = Math.min(gameState.blocksPerHalf - 1, Math.floor(elapsedThisHalf / blockSec));
  return (gameState.currentHalf - 1) * gameState.blocksPerHalf + inHalf;
}

// Diff between the current block and the next: who's coming OFF, who's coming ON.
function nextSubInfo(sched) {
  const idx = currentBlockIndex();
  if (idx == null) return null;
  if (idx >= sched.blocks.length - 1) return null;   // last block of game — no next sub
  const cur = sched.blocks[idx];
  const next = sched.blocks[idx + 1];
  const off = cur.court.filter(p => !next.court.find(q => q.id === p.id));
  const on  = next.court.filter(p => !cur.court.find(q => q.id === p.id));
  return { off, on, next };
}


// -- 5. CLOCK -----------------------------------------------------------------

function startClock() {
  if (gameState.clockRunning || gameState.gameEnded) return;
  if (gameState.clockSeconds <= 0) return;
  gameState.clockRunning = true;
  scheduleTick();
  persist(); render();
}

function stopClock() {
  if (!gameState.clockRunning) return;
  gameState.clockRunning = false;
  cancelTick();
  persist(); render();
}

function scheduleTick() { cancelTick(); tickHandle = setInterval(tick, TICK_INTERVAL); }
function cancelTick() { if (tickHandle != null) { clearInterval(tickHandle); tickHandle = null; } }

function tick() {
  if (!gameState.clockRunning) return;
  gameState.clockSeconds -= 1;
  if (gameState.clockSeconds <= 0) {
    gameState.clockSeconds = 0;
    gameState.clockRunning = false;
    cancelTick();
    if (gameState.currentHalf >= gameState.halves) gameState.gameEnded = true;
  }
  persist(); render();
}

function advanceHalf() {
  if (gameState.gameEnded) return;
  if (gameState.currentHalf >= gameState.halves) return;
  gameState.currentHalf += 1;
  gameState.clockSeconds = gameState.halfMinutes * 60;
  gameState.clockRunning = false;
  persist(); render();
}

function resetClock() {
  if (!confirm('Reset the current half clock back to full?')) return;
  cancelTick();
  gameState.clockRunning = false;
  gameState.clockSeconds = gameState.halfMinutes * 60;
  persist(); render();
}

function startNewGame() {
  if (!confirm('Start a new game? Clock and current half will reset (roster is kept).')) return;
  cancelTick();
  gameState.currentHalf = 1;
  gameState.clockSeconds = gameState.halfMinutes * 60;
  gameState.clockRunning = false;
  gameState.gameEnded = false;
  persist(); render();
}


// -- 6. ROSTER MUTATIONS ------------------------------------------------------

function updatePlayer(id, patch) {
  const p = getPlayer(id);
  if (!p) return;
  Object.assign(p, patch);
  persist(); render();
}

function setPlayerActive(id, active) {
  const p = getPlayer(id);
  if (!p) return;
  p.active = active;
  persist(); render();
}

function addPlayer() {
  const nextNumber = Math.max(0, ...gameState.roster.map(p => p.number)) + 1;
  const newId = 'p' + Date.now().toString(36);
  gameState.roster.push({ id: newId, name: 'New Player', number: nextNumber, active: true });
  persist(); render();
}

function removePlayer(id) {
  if (!confirm('Remove this player from the roster permanently? Use "Playing today" to sit them out for one game.')) return;
  gameState.roster = gameState.roster.filter(p => p.id !== id);
  persist(); render();
}

// Reorder a player up or down in the roster. The roster order IS the rotation
// order — the top 5 active players are the starting 5, and positions 6+
// determine who comes on first at the next block.
function movePlayer(id, direction) {
  const i = gameState.roster.findIndex(p => p.id === id);
  if (i < 0) return;
  const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= gameState.roster.length) return;
  const r = gameState.roster;
  [r[i], r[j]] = [r[j], r[i]];
  persist(); render();
}

function setHalves(v) {
  if (v < 1 || v > 4) return;
  gameState.halves = v;
  if (gameState.currentHalf > v) gameState.currentHalf = v;
  persist(); render();
}

function setHalfMinutes(v) {
  if (v < 1 || v > 40) return;
  gameState.halfMinutes = v;
  if (!gameState.clockRunning && gameState.clockSeconds === DEFAULTS.halfMinutes * 60) {
    gameState.clockSeconds = v * 60;
  }
  persist(); render();
}

function setBlocksPerHalf(v) {
  if (v < 1 || v > 8) return;
  gameState.blocksPerHalf = v;
  persist(); render();
}

function setView(view) {
  gameState.view = view;
  persist(); render();
}


// -- 7. RENDER ----------------------------------------------------------------

function render() {
  if (!gameState) return;
  document.body.dataset.view = gameState.view;
  renderHeader();
  if (gameState.view === 'chart') {
    $('#chart-view').hidden = false;
    $('#settings-view').hidden = true;
    const sched = generateSchedule();
    renderNowPanel(sched);
    renderNextPanel(sched);
    renderSchedule(sched);
    renderLegend();
  } else {
    $('#chart-view').hidden = true;
    $('#settings-view').hidden = false;
    renderSettings();
  }
}

function renderHeader() {
  $('#team-name').textContent  = gameState.teamName;
  $('#half-label').textContent = gameState.gameEnded
    ? 'Final'
    : `Half ${gameState.currentHalf} of ${gameState.halves}`;
  $('#clock-display').textContent = fmtClock(gameState.clockSeconds);
  $('#clock-display').classList.toggle('running', gameState.clockRunning);

  const clockBtn = $('#clock-btn');
  clockBtn.textContent =
    gameState.gameEnded            ? 'Game over' :
    gameState.clockRunning         ? 'Pause' :
    gameState.clockSeconds === 0   ? 'Half over' : 'Start';
  clockBtn.disabled = gameState.gameEnded || gameState.clockSeconds === 0;

  $('#next-half-btn').hidden = !(
    gameState.clockSeconds === 0 &&
    !gameState.gameEnded &&
    gameState.currentHalf < gameState.halves
  );

  for (const btn of document.querySelectorAll('.hdr-views .btn')) {
    btn.classList.toggle('active', btn.dataset.action === 'view-' + gameState.view);
  }
}

function fmtPlayerList(players) {
  return players.map(p => `<span class="chip">${escapeHtml(firstName(p.name))}</span>`).join('');
}

function renderNowPanel(sched) {
  const wrap = $('#now-panel');
  if (sched.error) {
    wrap.innerHTML = `<div class="now-error">${escapeHtml(sched.error)}</div>`;
    return;
  }
  if (gameState.gameEnded) {
    wrap.innerHTML = `<div class="now-label">Game over</div>`;
    return;
  }
  const idx = currentBlockIndex();
  const block = sched.blocks[idx];
  if (!block) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `
    <div class="now-label">NOW — Half ${block.half}, Block ${block.inHalf + 1}
      <span class="now-time">${fmtMinSec(block.startMin)} – ${fmtMinSec(block.endMin)}</span>
    </div>
    <div class="now-row">
      <span class="now-side off">ON COURT</span>
      <div class="chip-list">${fmtPlayerList(block.court)}</div>
    </div>
    <div class="now-row">
      <span class="now-side bench">BENCH</span>
      <div class="chip-list">${block.bench.length ? fmtPlayerList(block.bench) : '<em>(no bench — everyone plays)</em>'}</div>
    </div>
  `;
}

function renderNextPanel(sched) {
  const wrap = $('#next-panel');
  if (sched.error || gameState.gameEnded) { wrap.hidden = true; wrap.innerHTML = ''; return; }
  const info = nextSubInfo(sched);
  if (!info || (info.off.length === 0 && info.on.length === 0)) {
    wrap.hidden = true;
    wrap.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  wrap.innerHTML = `
    <div class="next-label">NEXT SUB <span class="next-time">at ${fmtMinSec(info.next.startMin)}</span></div>
    <div class="next-row">
      <span class="next-side off">OFF</span>
      <div class="chip-list">${fmtPlayerList(info.off)}</div>
    </div>
    <div class="next-row">
      <span class="next-side on">ON</span>
      <div class="chip-list">${fmtPlayerList(info.on)}</div>
    </div>
  `;
}

function renderSchedule(sched) {
  const wrap = $('#schedule');
  if (sched.error) { wrap.innerHTML = ''; return; }
  const currentIdx = currentBlockIndex();

  // Group blocks by half.
  const byHalf = {};
  for (const b of sched.blocks) {
    (byHalf[b.half] = byHalf[b.half] || []).push(b);
  }

  const halfNames = ['First Half', 'Second Half', 'Third Period', 'Fourth Period'];
  let html = '';
  for (const halfStr of Object.keys(byHalf)) {
    const half = parseInt(halfStr, 10);
    html += `<h3 class="schedule-half">${halfNames[half - 1] || `Half ${half}`}</h3>`;
    html += `<table class="schedule-table">
      <thead><tr><th>Time</th><th>On Court</th><th>On Bench</th></tr></thead><tbody>`;
    for (const b of byHalf[half]) {
      const cls = b.idx === currentIdx ? 'current' : '';
      html += `<tr class="${cls}">
        <td class="cell-time">${fmtMinSec(b.startMin)} – ${fmtMinSec(b.endMin)}</td>
        <td>${b.court.map(p => escapeHtml(firstName(p.name))).join(', ')}</td>
        <td>${b.bench.length ? b.bench.map(p => escapeHtml(firstName(p.name))).join(', ') : '—'}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }
  wrap.innerHTML = html;
}

function renderLegend() {
  const wrap = $('#legend');
  const active = activeRoster();
  wrap.innerHTML = active.map(p =>
    `<span class="legend-item">${escapeHtml(firstName(p.name))}</span>`
  ).join('');
}

function renderSettings() {
  const view = $('#settings-view');
  view.innerHTML = `
    <h2>Settings</h2>
    <section class="settings-section">
      <h3>Game format</h3>
      <div class="settings-row">
        <label>Halves
          <input type="number" min="1" max="4" value="${gameState.halves}"
                 data-action="set-halves" class="num-input">
        </label>
        <label>Minutes per half
          <input type="number" min="1" max="40" value="${gameState.halfMinutes}"
                 data-action="set-halfmins" class="num-input">
        </label>
        <label>Blocks per half
          <input type="number" min="1" max="8" value="${gameState.blocksPerHalf}"
                 data-action="set-blocks" class="num-input">
        </label>
      </div>
      <p class="settings-hint">Blocks divide the half into equal slices. With 4 blocks per 20-min half you get 5-min blocks (the standard junior pattern).</p>
    </section>

    <section class="settings-section">
      <h3>Roster &amp; lineup order</h3>
      <p class="settings-hint">
        The roster order IS the lineup order. The top 5 <em>active</em> players are
        the starting 5; the rest come on in order at each block. Use the
        ↑ ↓ buttons to change who starts.
      </p>
      <table class="roster-edit">
        <thead><tr>
          <th>Order</th><th>Playing<br>today</th><th>#</th><th>Name</th><th></th>
        </tr></thead>
        <tbody>
          ${(() => {
            // Mark the dividing line: which row is the LAST starter (5th active).
            // Anything above is starting 5; anything below is bench rotation.
            let activeSeen = 0, lastStarterIdx = -1;
            for (let i = 0; i < gameState.roster.length; i++) {
              if (gameState.roster[i].active !== false) {
                activeSeen++;
                if (activeSeen === 5) { lastStarterIdx = i; break; }
              }
            }
            return gameState.roster.map((p, i) => {
              const cls = (p.active === false ? 'inactive ' : '') +
                          (i === lastStarterIdx ? 'last-starter' : '');
              return `
                <tr class="${cls.trim()}">
                  <td class="cell-order">
                    <button class="btn-arrow" data-action="move-up" data-id="${p.id}"
                            ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
                    <button class="btn-arrow" data-action="move-down" data-id="${p.id}"
                            ${i === gameState.roster.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
                  </td>
                  <td class="cell-active"><input type="checkbox" ${p.active !== false ? 'checked' : ''}
                             data-action="toggle-active" data-id="${p.id}"></td>
                  <td><input type="number" value="${p.number}"
                             data-action="edit-number" data-id="${p.id}" class="num-input"></td>
                  <td><input type="text" value="${escapeHtml(p.name)}"
                             data-action="edit-name" data-id="${p.id}" class="text-input"></td>
                  <td><button class="btn btn-ghost btn-small"
                              data-action="remove-player" data-id="${p.id}">remove</button></td>
                </tr>`;
            }).join('');
          })()}
        </tbody>
      </table>
      <button class="btn" data-action="add-player">+ Add player</button>
    </section>

    <section class="settings-section">
      <h3>Game</h3>
      <button class="btn btn-danger" data-action="new-game">Reset clock to start of game</button>
    </section>
  `;
}


// -- 8. EVENT DELEGATION ------------------------------------------------------

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  const id = t.dataset.id;
  switch (action) {
    case 'toggle-clock': gameState.clockRunning ? stopClock() : startClock(); break;
    case 'reset-clock':  resetClock(); break;
    case 'next-half':    advanceHalf(); break;
    case 'view-chart':   setView('chart'); break;
    case 'view-settings': setView('settings'); break;
    case 'add-player':   addPlayer(); break;
    case 'remove-player': removePlayer(id); break;
    case 'move-up':      movePlayer(id, 'up'); break;
    case 'move-down':    movePlayer(id, 'down'); break;
    case 'new-game':     startNewGame(); break;
  }
});

document.addEventListener('change', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  const id = t.dataset.id;
  const intVal = () => { const v = parseInt(t.value, 10); return Number.isFinite(v) ? v : null; };
  switch (action) {
    case 'edit-number': { const v = intVal(); if (v !== null) updatePlayer(id, { number: v }); break; }
    case 'edit-name':     updatePlayer(id, { name: t.value }); break;
    case 'toggle-active': setPlayerActive(id, t.checked); break;
    case 'set-halves':    { const v = intVal(); if (v !== null && v >= 1 && v <= 4) setHalves(v); break; }
    case 'set-halfmins':  { const v = intVal(); if (v !== null && v >= 1 && v <= 40) setHalfMinutes(v); break; }
    case 'set-blocks':    { const v = intVal(); if (v !== null && v >= 1 && v <= 8) setBlocksPerHalf(v); break; }
  }
});


// -- 9. INIT ------------------------------------------------------------------

async function init() {
  const saved = loadState();
  if (saved && Array.isArray(saved.roster) && saved.roster.length > 0) {
    gameState = saved;
    // Forward-compat
    if (gameState.halves == null)        gameState.halves = DEFAULTS.halves;
    if (gameState.halfMinutes == null)   gameState.halfMinutes = DEFAULTS.halfMinutes;
    if (gameState.blocksPerHalf == null) gameState.blocksPerHalf = DEFAULTS.blocksPerHalf;
    if (!gameState.view)                 gameState.view = 'chart';
    for (const p of gameState.roster) if (p.active === undefined) p.active = true;
    if (gameState.clockRunning) scheduleTick();
  } else {
    let roster;
    try {
      const res = await fetch(ROSTER_URL, { cache: 'no-store' });
      const json = await res.json();
      roster = json.players;
    } catch (e) {
      console.warn('roster.json failed; using stub:', e);
      roster = [{ id: 'p1', name: 'Player 1', number: 1 }];
    }
    gameState = createDefaultGameState(roster);
    persist();
  }
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js')
      .catch(err => console.warn('SW registration failed:', err));
  }
}

init();
