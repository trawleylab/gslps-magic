// =============================================================================
// GSLPS Magic — Substitution Manager (PWA, vanilla JS)
//
// Reactive flow:
//   user taps something → handler mutates `gameState` → persist() → render()
//   render() rewrites the relevant DOM subtrees from gameState. No diffing,
//   no virtual DOM. Simple enough that you can grep for any UI string and
//   trace it back to the state field that drives it.
//
// Sections in this file:
//   1.  Constants & default rule config
//   2.  State (default factory + load/save to localStorage)
//   3.  Helpers (clock format, lookup, time math)
//   4.  Rule engine (RULES array + runRules())
//   5.  Clock (start / stop / tick / half transitions)
//   6.  Substitution flow (selection toggle, auto 1-for-1, batch confirm)
//   7.  Roster & settings mutations
//   8.  Render functions (one per panel; render() is the entrypoint)
//   9.  Event delegation (one click + one change handler at the document level)
//   10. Init + service worker registration
// =============================================================================

'use strict';

// -- 1. CONSTANTS -------------------------------------------------------------

const STORAGE_KEY   = 'gslps_magic_state_v1';
const ROSTER_URL    = 'roster.json';
const TICK_INTERVAL = 1000; // ms between clock ticks while running

// User-facing rule config. The check() functions live in section 4.
const DEFAULT_RULES = {
  consecutiveMinutes: { enabled: true, limitMinutes: 5 },
  minutesSpread:      { enabled: true, toleranceMinutes: 4 }
};

const DEFAULT_FORMAT = { halves: 2, halfMinutes: 20 };
const DEFAULT_SUB_INTERVAL_MIN = 4;  // target minutes between substitutions


// -- 2. STATE -----------------------------------------------------------------
//
// gameState is the SINGLE source of truth. Mutating it without calling
// persist() + render() afterwards is a bug — the UI will fall out of sync.

let gameState  = null;
let tickHandle = null;  // setInterval id while clock is running
let pendingSub = null;  // { courtSel, benchSel, failures } when warning modal is open

function createDefaultGameState(roster) {
  // Players default to "active" = playing today. Only active players go on
  // the court / bench; inactive ones sit out the game entirely.
  const seed = roster.map(p => ({ active: true, ...p }));
  const active = seed.filter(p => p.active);
  return {
    teamName: 'GSLPS Magic',
    format: { ...DEFAULT_FORMAT },
    currentHalf: 1,
    clockSeconds: DEFAULT_FORMAT.halfMinutes * 60,
    clockRunning: false,
    gameEnded: false,
    roster: seed,
    onCourtIds: active.slice(0, 5).map(p => p.id),
    benchIds:   active.slice(5).map(p => p.id),
    playerStats: Object.fromEntries(
      seed.map(p => [p.id, { secondsPlayed: 0, secondsSinceChange: 0, breaksTaken: 0 }])
    ),
    rules: structuredClone(DEFAULT_RULES),
    subIntervalMinutes: DEFAULT_SUB_INTERVAL_MIN,
    // Game-clock seconds at which the most recent sub (or halftime) happened.
    // Drives the "next sub due" indicator. 0 = no subs yet this game.
    lastSubGameSec: 0,
    selectedCourtIds: [],
    selectedBenchIds: [],
    view: 'court'  // 'court' | 'settings'
  };
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState));
  } catch (e) {
    console.warn('Could not persist game state:', e);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('Could not load saved state:', e);
    return null;
  }
}


// -- 3. HELPERS ---------------------------------------------------------------

function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtMinutes(seconds) {
  return Math.floor(Math.max(0, seconds) / 60).toString();
}

function getPlayer(id) {
  return gameState.roster.find(p => p.id === id);
}

function activeRoster() {
  return gameState.roster.filter(p => p.active !== false);
}

function totalElapsedSeconds() {
  const halfSec = gameState.format.halfMinutes * 60;
  return (gameState.currentHalf - 1) * halfSec + (halfSec - gameState.clockSeconds);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Display helper — coach calls kids by first name, so that's all we show.
function firstName(name) {
  const s = String(name || '').trim();
  return s ? s.split(/\s+/)[0] : '?';
}


// -- 4. RULE ENGINE -----------------------------------------------------------
//
// Each rule has: id, label, and check(proposedOnCourt, state) which returns
//   { passed: bool, severity: 'warning' | 'info', message: string }
//
// To add a new rule:
//   1. Append a rule object to RULES below.
//   2. Add a default config entry to DEFAULT_RULES (top of file).
//   3. (Optional) If the rule has tunable thresholds, add a number input in
//      renderSettings() with data-action="set-rule-param".
//
// runRules() iterates only enabled rules and returns the failures.

const RULES = [
  {
    id: 'consecutiveMinutes',
    label: 'Rest — flag players past the consecutive-minutes limit',
    check(proposed, state) {
      const limitSec = state.rules.consecutiveMinutes.limitMinutes * 60;
      // Only flag players who would STAY on court (incoming subs reset to 0).
      const offenders = proposed.filter(p =>
        state.onCourtIds.includes(p.id) &&
        state.playerStats[p.id].secondsSinceChange >= limitSec
      );
      if (offenders.length === 0) return { passed: true };
      return {
        passed: false,
        severity: 'warning',
        message: `${offenders.map(p => firstName(p.name)).join(', ')} ` +
                 `${offenders.length === 1 ? 'has' : 'have'} been on for over ` +
                 `${state.rules.consecutiveMinutes.limitMinutes} min — needs a rest.`
      };
    }
  },
  {
    id: 'minutesSpread',
    label: 'Even minutes — flag players too far from team average',
    check(proposed, state) {
      const tol = state.rules.minutesSpread.toleranceMinutes;
      const elapsedMin = totalElapsedSeconds() / 60;
      // Skip the rule too early — everyone's at 0 and the math is meaningless.
      if (elapsedMin < tol) return { passed: true };

      const minutes = state.roster.map(p => state.playerStats[p.id].secondsPlayed / 60);
      const avg = minutes.reduce((a, b) => a + b, 0) / minutes.length;
      const outliers = state.roster
        .map(p => ({ p, mins: state.playerStats[p.id].secondsPlayed / 60 }))
        .filter(({ mins }) => Math.abs(mins - avg) > tol);
      if (outliers.length === 0) return { passed: true };

      const names = outliers
        .map(({ p, mins }) => `${firstName(p.name)} (${mins.toFixed(0)} min)`)
        .join(', ');
      return {
        passed: false,
        severity: 'warning',
        message: `Minutes spread is uneven (avg ${avg.toFixed(0)} min): ${names}.`
      };
    }
  }
];

function runRules(proposedOnCourt) {
  return RULES
    .filter(r => gameState.rules[r.id]?.enabled)
    .map(r => ({ rule: r, result: r.check(proposedOnCourt, gameState) }))
    .filter(x => !x.result.passed);
}


// -- 4b. SUGGESTION ENGINE ----------------------------------------------------
//
// Picks ONE NEXT OFF + ONE NEXT ON each render, used by the hero panel and
// the per-card "NEXT" badges.
//
// Court "next off": longest current shift wins. Tiebreaker: fewest breaks
// taken (so the same kid doesn't always come off first). Final tiebreaker:
// roster order, so the suggestion is stable within a render.
//
// Bench "next on": longest current rest wins. Tiebreaker: least minutes played
// overall (fairness — the kids who haven't had much court time get priority).
// Final tiebreaker: roster order.

function getSuggestion() {
  if (gameState.gameEnded) return null;
  const onCourt = gameState.onCourtIds;
  const bench   = gameState.benchIds;
  if (onCourt.length === 0 || bench.length === 0) return null;

  // Block-rotation rule: rotate the entire bench each substitution.
  //   8 active → bench 3 → 3-for-3 swap
  //   7 active → bench 2 → 2-for-2 swap
  //   6 active → bench 1 → 1-for-1 swap (current single-sub case)
  //   5 active → bench 0 → no swap possible
  // Capped at min(bench, court) just in case bench somehow exceeds court size.
  const N = Math.min(bench.length, onCourt.length);

  const idx  = id => gameState.roster.findIndex(p => p.id === id);
  const stat = id => gameState.playerStats[id] || { secondsPlayed: 0, secondsSinceChange: 0, breaksTaken: 0 };

  const off = onCourt.slice().sort((a, b) => {
    const sa = stat(a), sb = stat(b);
    return sb.secondsSinceChange - sa.secondsSinceChange   // longest shift first
        || sa.breaksTaken         - sb.breaksTaken          // fewer breaks → overdue for one
        || idx(a)                 - idx(b);                  // stable
  }).slice(0, N);

  const on = bench.slice().sort((a, b) => {
    const sa = stat(a), sb = stat(b);
    return sb.secondsSinceChange - sa.secondsSinceChange   // longest rest first
        || sa.secondsPlayed       - sb.secondsPlayed         // less court time = more deserving
        || idx(a)                 - idx(b);
  }).slice(0, N);

  return { off, on, n: N };
}


// -- 5. CLOCK -----------------------------------------------------------------

function startClock() {
  if (gameState.clockRunning || gameState.gameEnded) return;
  if (gameState.clockSeconds <= 0) return;
  gameState.clockRunning = true;
  scheduleTick();
  persist();
  render();
}

function stopClock() {
  if (!gameState.clockRunning) return;
  gameState.clockRunning = false;
  cancelTick();
  persist();
  render();
}

function scheduleTick() {
  cancelTick();
  tickHandle = setInterval(tick, TICK_INTERVAL);
}

function cancelTick() {
  if (tickHandle != null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

function tick() {
  if (!gameState.clockRunning) return;
  gameState.clockSeconds -= 1;
  // Tick everyone's secondsSinceChange; on-court players also tick secondsPlayed.
  for (const p of gameState.roster) {
    const stat = gameState.playerStats[p.id];
    stat.secondsSinceChange += 1;
    if (gameState.onCourtIds.includes(p.id)) stat.secondsPlayed += 1;
  }
  if (gameState.clockSeconds <= 0) {
    gameState.clockSeconds = 0;
    gameState.clockRunning = false;
    cancelTick();
    if (gameState.currentHalf >= gameState.format.halves) {
      gameState.gameEnded = true;
    } else {
      // Halftime — reset consecutive counters since the break is a real rest.
      for (const p of gameState.roster) {
        gameState.playerStats[p.id].secondsSinceChange = 0;
      }
    }
  }
  persist();
  render();
}

function advanceHalf() {
  if (gameState.gameEnded) return;
  if (gameState.currentHalf >= gameState.format.halves) return;
  gameState.currentHalf += 1;
  gameState.clockSeconds = gameState.format.halfMinutes * 60;
  gameState.clockRunning = false;
  // Halftime counts as a fresh sub baseline — the break itself is a rest, so
  // the "next sub due" indicator shouldn't carry over from the previous half.
  gameState.lastSubGameSec = totalElapsedSeconds();
  persist();
  render();
}

function resetClock() {
  if (!confirm('Reset the current half clock back to full?')) return;
  cancelTick();
  gameState.clockRunning = false;
  gameState.clockSeconds = gameState.format.halfMinutes * 60;
  persist();
  render();
}


// -- 6. SUBSTITUTION FLOW -----------------------------------------------------

function toggleSelectCourt(id) {
  const sel = gameState.selectedCourtIds;
  const idx = sel.indexOf(id);
  if (idx >= 0) sel.splice(idx, 1); else sel.push(id);
  maybeAutoCommit();
  persist();
  render();
}

function toggleSelectBench(id) {
  const sel = gameState.selectedBenchIds;
  const idx = sel.indexOf(id);
  if (idx >= 0) sel.splice(idx, 1); else sel.push(id);
  maybeAutoCommit();
  persist();
  render();
}

function clearSelection() {
  gameState.selectedCourtIds = [];
  gameState.selectedBenchIds = [];
  persist();
  render();
}

// Auto-commit a clean 1-for-1 swap as soon as exactly one of each is picked.
// (Coach opted into this; multi-subs require the explicit Confirm button.)
function maybeAutoCommit() {
  if (gameState.selectedCourtIds.length === 1 &&
      gameState.selectedBenchIds.length === 1) {
    attemptCommitSubs();
  }
}

function attemptCommitSubs() {
  const courtSel = gameState.selectedCourtIds.slice();
  const benchSel = gameState.selectedBenchIds.slice();
  if (courtSel.length === 0 || courtSel.length !== benchSel.length) return;

  const newOnCourtIds = gameState.onCourtIds
    .filter(id => !courtSel.includes(id))
    .concat(benchSel);
  const proposedOnCourt = newOnCourtIds.map(getPlayer);

  const failures = runRules(proposedOnCourt);
  if (failures.length === 0) {
    commitSubs();
  } else {
    pendingSub = { courtSel, benchSel, failures };
    render();
  }
}

function commitSubs() {
  // Use pendingSub if present (override path), otherwise the live selection.
  const courtSel = pendingSub ? pendingSub.courtSel : gameState.selectedCourtIds.slice();
  const benchSel = pendingSub ? pendingSub.benchSel : gameState.selectedBenchIds.slice();

  gameState.onCourtIds = gameState.onCourtIds
    .filter(id => !courtSel.includes(id))
    .concat(benchSel);
  gameState.benchIds = gameState.benchIds
    .filter(id => !benchSel.includes(id))
    .concat(courtSel);

  for (const id of [...courtSel, ...benchSel]) {
    gameState.playerStats[id].secondsSinceChange = 0;
  }
  // A "break" = a sub OFF the court. Used to keep rotations fair so the same
  // player isn't always picked first to come off.
  for (const id of courtSel) {
    gameState.playerStats[id].breaksTaken = (gameState.playerStats[id].breaksTaken || 0) + 1;
  }
  gameState.lastSubGameSec = totalElapsedSeconds();

  gameState.selectedCourtIds = [];
  gameState.selectedBenchIds = [];
  pendingSub = null;
  persist();
  render();
}

function cancelPendingSub() {
  pendingSub = null;
  render();
}

// Commit the suggestion shown in the hero panel — sets the selection to the
// suggested group and runs the same commit path as a manual sub (so warnings
// still surface).
function commitSuggestion() {
  const sug = getSuggestion();
  if (!sug) return;
  gameState.selectedCourtIds = sug.off.slice();
  gameState.selectedBenchIds = sug.on.slice();
  attemptCommitSubs();
}


// -- 7. ROSTER & SETTINGS MUTATIONS -------------------------------------------

function updatePlayer(id, patch) {
  const p = getPlayer(id);
  if (!p) return;
  Object.assign(p, patch);
  persist();
  render();
}

function addPlayer() {
  const nextNumber = Math.max(0, ...gameState.roster.map(p => p.number)) + 1;
  const newId = 'p' + Date.now().toString(36);
  gameState.roster.push({ id: newId, name: 'New Player', number: nextNumber, active: true });
  gameState.benchIds.push(newId);
  gameState.playerStats[newId] = { secondsPlayed: 0, secondsSinceChange: 0, breaksTaken: 0 };
  persist();
  render();
}

function removePlayer(id) {
  if (!confirm('Remove this player from the roster permanently? (For "not playing today" use the Playing today checkbox instead.)')) return;
  gameState.roster      = gameState.roster.filter(p => p.id !== id);
  gameState.onCourtIds  = gameState.onCourtIds.filter(x => x !== id);
  gameState.benchIds    = gameState.benchIds.filter(x => x !== id);
  delete gameState.playerStats[id];
  persist();
  render();
}

// Toggle "playing today" for a player. Inactive players are pulled off the
// court / bench (so they don't show up in the rotation) but their roster
// entry and stats are preserved. Reactivating drops them back on the bench.
function setPlayerActive(id, active) {
  const p = getPlayer(id);
  if (!p) return;
  p.active = active;
  if (!active) {
    const wasOnCourt = gameState.onCourtIds.includes(id);
    gameState.onCourtIds = gameState.onCourtIds.filter(x => x !== id);
    gameState.benchIds   = gameState.benchIds.filter(x => x !== id);
    gameState.selectedCourtIds = gameState.selectedCourtIds.filter(x => x !== id);
    gameState.selectedBenchIds = gameState.selectedBenchIds.filter(x => x !== id);
    // Pull a bench player up to fill the empty court slot — otherwise we'd
    // leave the team short and the suggestion engine would compute against a
    // 4-player court. Pick by the same "longest rest first" heuristic as the
    // suggestion engine, so the promotion is fair.
    if (wasOnCourt && gameState.benchIds.length > 0 && gameState.onCourtIds.length < 5) {
      const idx  = pid => gameState.roster.findIndex(p => p.id === pid);
      const stat = pid => gameState.playerStats[pid] || { secondsPlayed: 0, secondsSinceChange: 0, breaksTaken: 0 };
      const pick = gameState.benchIds.slice().sort((a, b) => {
        const sa = stat(a), sb = stat(b);
        return sb.secondsSinceChange - sa.secondsSinceChange
            || sa.secondsPlayed       - sb.secondsPlayed
            || idx(a)                 - idx(b);
      })[0];
      gameState.benchIds   = gameState.benchIds.filter(x => x !== pick);
      gameState.onCourtIds.push(pick);
      gameState.playerStats[pick].secondsSinceChange = 0;
    }
  } else {
    if (!gameState.onCourtIds.includes(id) && !gameState.benchIds.includes(id)) {
      gameState.benchIds.push(id);
    }
  }
  persist();
  render();
}

function setRuleEnabled(ruleId, enabled) {
  if (!gameState.rules[ruleId]) return;
  gameState.rules[ruleId].enabled = enabled;
  persist();
  render();
}

function setRuleParam(ruleId, key, value) {
  if (!gameState.rules[ruleId]) return;
  gameState.rules[ruleId][key] = value;
  persist();
  render();
}

function setFormat(halfMinutes, halves) {
  // If we're at the start of a fresh half (clock at full, not running), update
  // the live clock to match the new half length. Otherwise leave the running /
  // partial clock alone so we don't disturb a game in progress.
  const wasAtFullHalf = !gameState.clockRunning &&
    gameState.clockSeconds === gameState.format.halfMinutes * 60;
  gameState.format = { halves, halfMinutes };
  if (wasAtFullHalf) gameState.clockSeconds = halfMinutes * 60;
  if (gameState.currentHalf > halves) gameState.currentHalf = halves;
  persist();
  render();
}

function startNewGame() {
  if (!confirm('Start a new game? Minutes and clock will reset (roster is kept).')) return;
  const roster = gameState.roster.slice();
  const rules  = gameState.rules;
  const format = gameState.format;
  cancelTick();
  pendingSub = null;
  gameState = createDefaultGameState(roster);
  gameState.rules = rules;
  gameState.format = format;
  gameState.clockSeconds = format.halfMinutes * 60;
  persist();
  render();
}

function setView(view) {
  gameState.view = view;
  if (view !== 'court') {
    gameState.selectedCourtIds = [];
    gameState.selectedBenchIds = [];
    pendingSub = null;
  }
  persist();
  render();
}


// -- 8. RENDER ----------------------------------------------------------------
//
// Single render() entrypoint, called after every state mutation. Each
// renderXxx() owns one DOM subtree and rewrites it from scratch from gameState.

function $(sel) { return document.querySelector(sel); }

function render() {
  if (!gameState) return;
  document.body.dataset.view = gameState.view;
  renderHeader();
  if (gameState.view === 'court') {
    $('#court-view').hidden = false;
    $('#settings-view').hidden = true;
    renderHeroPanel();
    renderCourt();
    renderBench();
    renderActionBar();
    renderSidebar();
  } else {
    $('#court-view').hidden = true;
    $('#settings-view').hidden = false;
    renderSettings();
  }
  renderModal();
}

// Hero "next swap" panel. Shows the single recommended swap as the focal
// point of the screen so the coach has one obvious thing to do.
//
// Visual urgency mirrors the sub-due indicator state:
//   - fresh   → dimmed (recommendation is ready, but no rush)
//   - warn    → highlighted amber (sub due in <30s)
//   - over    → pulsing red (overdue)
//
// Hides while the coach has any manual selection in progress (the action bar
// takes over — one thing at a time on screen).
function renderHeroPanel() {
  const wrap = $('#hero-panel');
  const sug = getSuggestion();
  const hasSelection = gameState.selectedCourtIds.length > 0 ||
                       gameState.selectedBenchIds.length > 0;
  if (!sug || hasSelection) {
    wrap.hidden = true;
    wrap.innerHTML = '';
    return;
  }
  wrap.hidden = false;

  // Visual urgency mirrors the sub-due indicator.
  const intervalSec = (gameState.subIntervalMinutes || DEFAULT_SUB_INTERVAL_MIN) * 60;
  const since = totalElapsedSeconds() - (gameState.lastSubGameSec || 0);
  const remaining = intervalSec - since;
  const urgency = remaining <= 0 ? 'overdue' : remaining <= 30 ? 'due' : 'fresh';

  const fmtList = ids => ids
    .map(id => escapeHtml(firstName(getPlayer(id).name)))
    .join(', ');

  wrap.className = 'hero-panel ' + urgency;
  wrap.innerHTML = `
    <div class="hero-content">
      <div class="hero-label">NEXT SWAP — ${sug.n} for ${sug.n}</div>
      <div class="hero-line">
        <span class="hero-side-label off">OFF</span>
        <span class="hero-names">${fmtList(sug.off)}</span>
      </div>
      <div class="hero-line">
        <span class="hero-side-label on">ON</span>
        <span class="hero-names">${fmtList(sug.on)}</span>
      </div>
    </div>
    <button class="btn btn-primary hero-action" data-action="commit-suggestion">Make this swap</button>
  `;
}

function renderHeader() {
  $('#team-name').textContent  = gameState.teamName;
  $('#half-label').textContent = gameState.gameEnded
    ? 'Final'
    : `Half ${gameState.currentHalf} of ${gameState.format.halves}`;
  $('#clock-display').textContent = fmtClock(gameState.clockSeconds);
  $('#clock-display').classList.toggle('running', gameState.clockRunning);

  const clockBtn = $('#clock-btn');
  clockBtn.textContent =
    gameState.gameEnded                                   ? 'Game over' :
    gameState.clockRunning                                ? 'Pause' :
    gameState.clockSeconds === 0                          ? 'Half over' :
                                                            'Start';
  clockBtn.disabled = gameState.gameEnded || gameState.clockSeconds === 0;

  $('#next-half-btn').hidden = !(
    gameState.clockSeconds === 0 &&
    !gameState.gameEnded &&
    gameState.currentHalf < gameState.format.halves
  );

  // Active view tab.
  for (const btn of document.querySelectorAll('.hdr-views .btn')) {
    btn.classList.toggle('active', btn.dataset.action === 'view-' + gameState.view);
  }

  renderSubIndicator();
}

// "Next sub due" indicator. Time since the most recent sub (or halftime) in
// game-clock seconds, vs. the configured target interval.
function renderSubIndicator() {
  const el = $('#sub-indicator');
  if (gameState.gameEnded) { el.textContent = ''; el.className = 'sub-indicator'; return; }
  const intervalSec = (gameState.subIntervalMinutes || DEFAULT_SUB_INTERVAL_MIN) * 60;
  const since = totalElapsedSeconds() - (gameState.lastSubGameSec || 0);
  const remaining = intervalSec - since;
  let label, cls;
  if (remaining > 30)      { label = `Next sub in ${fmtClock(remaining)}`;       cls = 'fresh'; }
  else if (remaining > 0)  { label = `Sub due in ${fmtClock(remaining)}`;         cls = 'warn'; }
  else                     { label = `Sub overdue ${fmtClock(-remaining)}`;       cls = 'over'; }
  el.textContent = label;
  el.className = 'sub-indicator ' + cls;
}

function renderCourt() {
  const sug = getSuggestion();
  const wrap = $('#court');
  wrap.innerHTML = '';
  for (const id of gameState.onCourtIds) wrap.appendChild(playerCard(id, 'court', sug));
  while (wrap.children.length < 5) {
    const empty = document.createElement('div');
    empty.className = 'player-card empty';
    empty.textContent = '— empty —';
    wrap.appendChild(empty);
  }
}

function renderBench() {
  const sug = getSuggestion();
  const wrap = $('#bench');
  wrap.innerHTML = '';
  if (gameState.benchIds.length === 0) {
    wrap.innerHTML = '<div class="empty-note">Bench empty</div>';
    return;
  }
  for (const id of gameState.benchIds) wrap.appendChild(playerCard(id, 'bench', sug));
}

// Compact player card: just number + name. All numerical detail (minutes,
// breaks, on/off time) lives in the sidebar to keep the main view scannable.
// The NEXT badge marks the player the suggestion engine has picked.
function playerCard(id, location, sug) {
  const p = getPlayer(id);
  const div = document.createElement('div');
  if (!p) {
    div.className = 'player-card empty';
    div.textContent = '— missing —';
    return div;
  }
  const stat = gameState.playerStats[id] || { secondsPlayed: 0, secondsSinceChange: 0 };
  const selected = location === 'court'
    ? gameState.selectedCourtIds.includes(id)
    : gameState.selectedBenchIds.includes(id);

  // Fatigue colour: warn 1 min before limit, alert at limit.
  const limitMin = gameState.rules.consecutiveMinutes.limitMinutes;
  const consMin  = stat.secondsSinceChange / 60;
  let fatigueClass = '';
  if (location === 'court') {
    if (consMin >= limitMin)          fatigueClass = 'fatigue-over';
    else if (consMin >= limitMin - 1) fatigueClass = 'fatigue-warn';
  }

  const isNext = sug && (
    (location === 'court' && sug.off.includes(id)) ||
    (location === 'bench' && sug.on.includes(id))
  );

  div.className = `player-card ${location} ${selected ? 'selected' : ''} ${fatigueClass} ${isNext ? 'next' : ''}`.trim();
  div.dataset.action = location === 'court' ? 'select-court' : 'select-bench';
  div.dataset.id = id;
  div.innerHTML = `
    ${isNext ? `<span class="next-badge">${location === 'court' ? 'NEXT OFF' : 'NEXT ON'}</span>` : ''}
    <span class="pc-name">${escapeHtml(firstName(p.name))}</span>
  `;
  return div;
}

function renderActionBar() {
  const bar = $('#action-bar');
  const c = gameState.selectedCourtIds.length;
  const b = gameState.selectedBenchIds.length;
  if (c === 0 && b === 0) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = '';

  const status = document.createElement('div');
  status.className = 'action-status';
  status.textContent = `Selected: ${c} on court, ${b} on bench`;
  bar.appendChild(status);

  // 1-for-1 auto-commits, so the manual Confirm button is only useful for 2+.
  if (c >= 2 && c === b) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = `Confirm ${c}-for-${c} sub`;
    btn.dataset.action = 'confirm-subs';
    bar.appendChild(btn);
  } else if (c >= 1 && c !== b) {
    const hint = document.createElement('div');
    hint.className = 'action-hint';
    hint.textContent = c > b
      ? `Pick ${c - b} more bench player${c - b === 1 ? '' : 's'} to swap.`
      : `Pick ${b - c} more court player${b - c === 1 ? '' : 's'} to swap.`;
    bar.appendChild(hint);
  }

  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn btn-ghost';
  clearBtn.textContent = 'Clear selection';
  clearBtn.dataset.action = 'clear-selection';
  bar.appendChild(clearBtn);
}

function renderSidebar() {
  const tbody = $('#minutes-tbody');
  tbody.innerHTML = '';
  // Active players only — inactive ones aren't rotating today.
  // Sort: most-played first so the rotation imbalance is glanceable.
  const rows = activeRoster()
    .map(p => ({ p, stat: gameState.playerStats[p.id] || { secondsPlayed: 0, secondsSinceChange: 0, breaksTaken: 0 } }))
    .sort((a, b) => b.stat.secondsPlayed - a.stat.secondsPlayed);

  const limitMin = gameState.rules.consecutiveMinutes.limitMinutes;
  for (const { p, stat } of rows) {
    const onCourt = gameState.onCourtIds.includes(p.id);
    const consMin = stat.secondsSinceChange / 60;
    let dotClass = onCourt ? 'on' : 'off';
    if (onCourt && consMin >= limitMin)         dotClass = 'over';
    else if (onCourt && consMin >= limitMin - 1) dotClass = 'warn';
    const stateLabel = onCourt
      ? `${Math.floor(consMin)}m on`
      : `${Math.floor(consMin)}m rest`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="cell-name"><span class="status-dot ${dotClass}"></span>${escapeHtml(firstName(p.name))}</td>
      <td class="cell-num">${fmtMinutes(stat.secondsPlayed)}</td>
      <td class="cell-num">${stat.breaksTaken || 0}</td>
      <td class="cell-state">${stateLabel}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderSettings() {
  const view = $('#settings-view');
  view.innerHTML = `
    <h2>Settings</h2>

    <section class="settings-section">
      <h3>Game format</h3>
      <div class="settings-row">
        <label>Halves
          <input type="number" min="1" max="4" value="${gameState.format.halves}"
                 data-action="set-halves" class="num-input">
        </label>
        <label>Minutes per half
          <input type="number" min="1" max="40" value="${gameState.format.halfMinutes}"
                 data-action="set-halfmins" class="num-input">
        </label>
        <label>Target sub interval (min)
          <input type="number" min="1" max="20" value="${gameState.subIntervalMinutes}"
                 data-action="set-sub-interval" class="num-input">
        </label>
      </div>
    </section>

    <section class="settings-section">
      <h3>Rules</h3>
      ${RULES.map(r => `
        <div class="rule-row">
          <label class="rule-toggle">
            <input type="checkbox" ${gameState.rules[r.id]?.enabled ? 'checked' : ''}
                   data-action="toggle-rule" data-rule="${r.id}">
            <span>${escapeHtml(r.label)}</span>
          </label>
          ${r.id === 'consecutiveMinutes' ? `
            <label class="rule-param">Limit (min)
              <input type="number" min="1" max="20"
                     value="${gameState.rules.consecutiveMinutes.limitMinutes}"
                     data-action="set-rule-param" data-rule="consecutiveMinutes"
                     data-key="limitMinutes" class="num-input">
            </label>` : ''}
          ${r.id === 'minutesSpread' ? `
            <label class="rule-param">Tolerance (min)
              <input type="number" min="1" max="15"
                     value="${gameState.rules.minutesSpread.toleranceMinutes}"
                     data-action="set-rule-param" data-rule="minutesSpread"
                     data-key="toleranceMinutes" class="num-input">
            </label>` : ''}
        </div>
      `).join('')}
    </section>

    <section class="settings-section">
      <h3>Roster</h3>
      <table class="roster-edit">
        <thead><tr>
          <th>Playing<br>today</th><th>#</th><th>Name</th><th></th>
        </tr></thead>
        <tbody>
          ${gameState.roster.map(p => `
            <tr class="${p.active === false ? 'inactive' : ''}">
              <td class="cell-active"><input type="checkbox" ${p.active !== false ? 'checked' : ''}
                         data-action="toggle-active" data-id="${p.id}"></td>
              <td><input type="number" value="${p.number}"
                         data-action="edit-number" data-id="${p.id}" class="num-input"></td>
              <td><input type="text" value="${escapeHtml(p.name)}"
                         data-action="edit-name" data-id="${p.id}" class="text-input"></td>
              <td><button class="btn btn-ghost btn-small"
                          data-action="remove-player" data-id="${p.id}">remove</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="settings-hint">Untick "Playing today" to sit a player out for this game without removing them from the roster. Their stats are preserved if they come back.</p>
      <button class="btn" data-action="add-player">+ Add player</button>
    </section>

    <section class="settings-section">
      <h3>Game</h3>
      <button class="btn btn-danger" data-action="new-game">
        Start new game (reset minutes &amp; clock, keep roster)
      </button>
    </section>
  `;
}

function renderModal() {
  const modal = $('#modal');
  if (!pendingSub) {
    modal.hidden = true;
    return;
  }
  modal.hidden = false;
  const list = pendingSub.failures.map(f =>
    `<li class="warn-${f.result.severity}">
       <strong>${escapeHtml(f.rule.label)}:</strong>
       ${escapeHtml(f.result.message)}
     </li>`
  ).join('');
  $('#modal-body').innerHTML = `
    <h3>Heads up — this sub triggers warnings:</h3>
    <ul class="warn-list">${list}</ul>
  `;
}


// -- 9. EVENT DELEGATION ------------------------------------------------------
//
// Two listeners at the document level. Every interactive element carries
// data-action; the dispatch is one switch per listener. Keeps wiring local.

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  const id = t.dataset.id;
  switch (action) {
    case 'select-court':     toggleSelectCourt(id); break;
    case 'select-bench':     toggleSelectBench(id); break;
    case 'confirm-subs':     attemptCommitSubs(); break;
    case 'clear-selection':  clearSelection(); break;
    case 'override-confirm': commitSubs(); break;
    case 'cancel-sub':       cancelPendingSub(); break;
    case 'commit-suggestion': commitSuggestion(); break;
    case 'toggle-clock':     gameState.clockRunning ? stopClock() : startClock(); break;
    case 'reset-clock':      resetClock(); break;
    case 'next-half':        advanceHalf(); break;
    case 'view-court':       setView('court'); break;
    case 'view-settings':    setView('settings'); break;
    case 'add-player':       addPlayer(); break;
    case 'remove-player':    removePlayer(id); break;
    case 'new-game':         startNewGame(); break;
  }
});

document.addEventListener('change', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  const id = t.dataset.id;
  const intVal = () => {
    const v = parseInt(t.value, 10);
    return Number.isFinite(v) ? v : null;
  };
  switch (action) {
    case 'edit-number':    { const v = intVal(); if (v !== null) updatePlayer(id, { number: v }); break; }
    case 'edit-name':        updatePlayer(id, { name: t.value }); break;
    case 'toggle-active':    setPlayerActive(id, t.checked); break;
    case 'toggle-rule':      setRuleEnabled(t.dataset.rule, t.checked); break;
    case 'set-rule-param':   { const v = intVal(); if (v !== null && v > 0) setRuleParam(t.dataset.rule, t.dataset.key, v); break; }
    case 'set-halves':       { const v = intVal(); if (v !== null && v >= 1 && v <= 4) setFormat(gameState.format.halfMinutes, v); break; }
    case 'set-halfmins':     { const v = intVal(); if (v !== null && v >= 1 && v <= 40) setFormat(v, gameState.format.halves); break; }
    case 'set-sub-interval': { const v = intVal(); if (v !== null && v >= 1 && v <= 20) { gameState.subIntervalMinutes = v; persist(); render(); } break; }
  }
});


// -- 10. INIT -----------------------------------------------------------------

async function init() {
  const saved = loadState();
  if (saved && Array.isArray(saved.roster) && saved.roster.length > 0) {
    gameState = saved;
    // Forward-compat: rehydrate fields added since the saved version was written.
    if (!gameState.rules) gameState.rules = structuredClone(DEFAULT_RULES);
    for (const r of Object.keys(DEFAULT_RULES)) {
      if (!gameState.rules[r]) gameState.rules[r] = { ...DEFAULT_RULES[r] };
    }
    if (!gameState.playerStats) gameState.playerStats = {};
    for (const p of gameState.roster) {
      if (p.active === undefined) p.active = true;
      if (!gameState.playerStats[p.id]) {
        gameState.playerStats[p.id] = { secondsPlayed: 0, secondsSinceChange: 0, breaksTaken: 0 };
      }
      if (gameState.playerStats[p.id].breaksTaken == null) {
        gameState.playerStats[p.id].breaksTaken = 0;
      }
    }
    if (!gameState.format) gameState.format = { ...DEFAULT_FORMAT };
    if (gameState.subIntervalMinutes == null) gameState.subIntervalMinutes = DEFAULT_SUB_INTERVAL_MIN;
    if (gameState.lastSubGameSec == null) gameState.lastSubGameSec = 0;
    if (!Array.isArray(gameState.selectedCourtIds)) gameState.selectedCourtIds = [];
    if (!Array.isArray(gameState.selectedBenchIds)) gameState.selectedBenchIds = [];
    if (!gameState.view) gameState.view = 'court';
    // Resume the tick if the saved state had the clock running.
    if (gameState.clockRunning) scheduleTick();
  } else {
    let roster;
    try {
      const res = await fetch(ROSTER_URL, { cache: 'no-store' });
      const json = await res.json();
      roster = json.players;
    } catch (e) {
      console.warn('Failed to load roster.json, using stub roster:', e);
      roster = [{ id: 'p1', name: 'Player 1', number: 1 }];
    }
    gameState = createDefaultGameState(roster);
    persist();
  }
  render();

  // Service worker last so a registration error doesn't block the rest of init.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js')
      .catch(err => console.warn('SW registration failed:', err));
  }
}

init();
