'use strict';

/* ===================== Times Table Blast! =====================
   A 2-minute multiplication sprint. Pick a set (two times tables),
   answer as many as you can, get cheered on the whole way. */

const GAME_SECONDS = 120;
const QUESTION_TARGET = 50; // a round ends at 50 questions — 50/50 is the big prize
const MAX_DIGITS = 3; // biggest answer is 12 x 12 = 144

// Who's playing — asked for on the name screen and used to personalise all
// the encouragement. %N in any message becomes the player's name; if the
// player is Henry, his nickname "Winkles" gets mixed in at random too.
let playerName = (localStorage.getItem('ttblast-player') || '').trim();

function who() {
  const isHenry = playerName.toLowerCase() === 'henry';
  return (isHenry && Math.random() < 0.5) ? 'Winkles' : playerName;
}

function personalise(s) {
  return s.replace('%N', who());
}

const SETS = [
  { id: 'A', tables: [1, 2],   emoji: '🐣', color: '#ef4444', dark: '#b91c1c' },
  { id: 'B', tables: [3, 4],   emoji: '🐰', color: '#f97316', dark: '#c2410c' },
  { id: 'C', tables: [5, 6],   emoji: '🦊', color: '#eab308', dark: '#a16207' },
  { id: 'D', tables: [7, 8],   emoji: '🦁', color: '#22c55e', dark: '#15803d' },
  { id: 'E', tables: [9, 10],  emoji: '🚀', color: '#3b82f6', dark: '#1d4ed8' },
  { id: 'F', tables: [11, 12], emoji: '🌟', color: '#a855f7', dark: '#7e22ce' },
];

const PRAISE = [
  'Awesome, %N! ✨', 'Brilliant, %N! 🌟', 'You rock, %N! 🎸', 'Super, %N! 💫',
  'Nailed it! 🎯', 'Boom, %N! 💥', 'Maths magic, %N! 🪄', 'Genius! 🧠',
  'Yes, %N! Keep going! 🚀', 'Speedy, %N! ⚡', 'Too good, %N! 😎', 'Wow! 🤩',
];

const NEARLY = [
  'Good try, %N!', 'So close, %N!', 'Nearly, %N!', 'Tricky one!',
  'You’ll get the next one, %N!',
];

const $ = (sel) => document.querySelector(sel);

const els = {
  name: $('#name-screen'),
  home: $('#home-screen'),
  game: $('#game-screen'),
  results: $('#results-screen'),
  board: $('#board-screen'),
  boardList: $('#board-list'),
  progressPill: $('#progress-pill'),
  setGrid: $('#set-grid'),
  timer: $('#timer'),
  timerFill: $('#timer-fill'),
  scorePill: $('#score-pill'),
  streakPill: $('#streak-pill'),
  card: $('#question-card'),
  questionText: $('#question-text'),
  entry: $('#entry'),
  entryBox: document.querySelector('.entry-box'),
  feedback: $('#feedback'),
  overlay: $('#overlay'),
  overlayText: $('#overlay-text'),
  confetti: $('#confetti'),
  resultsBody: $('#results-body'),
};

let soundOn = localStorage.getItem('ttblast-sound') !== 'off';
let game = null; // active game state, null when not playing

function formatTime(ms) {
  const totalSecs = Math.ceil(ms / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ===================== screens ===================== */

function showScreen(name) {
  els.name.hidden = name !== 'name';
  els.home.hidden = name !== 'home';
  els.game.hidden = name !== 'game';
  els.results.hidden = name !== 'results';
  els.board.hidden = name !== 'board';
}

/* ===================== name screen ===================== */

function showNameScreen() {
  const input = document.getElementById('name-input');
  input.value = playerName;
  showScreen('name');
  setTimeout(() => input.focus(), 100);
}

function startApp() {
  const input = document.getElementById('name-input');
  let name = input.value.trim().slice(0, 12);
  if (!name) {
    input.classList.remove('nudge');
    void input.offsetWidth;
    input.classList.add('nudge');
    input.focus();
    return;
  }
  name = name.charAt(0).toUpperCase() + name.slice(1);
  playerName = name;
  localStorage.setItem('ttblast-player', name);
  input.blur();
  renderHome();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bestKey(setId) { return 'ttblast-best-' + setId; }

function loadBest(setId) {
  try {
    const raw = localStorage.getItem(bestKey(setId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function renderHome() {
  document.title = `${playerName}’s Times Table Blast!`;
  document.querySelector('#home-screen .title').innerHTML =
    `<span class="title-emoji">🚀</span> ${escapeHtml(playerName)}’s Times Table Blast!`;
  document.querySelector('#home-screen .tagline').textContent =
    `Ready, ${who()}? You've got 2 minutes to blast through 50 questions!`;
  document.querySelector('.change-player').textContent = `Not ${playerName}? Change player`;
  els.setGrid.innerHTML = '';
  for (const set of SETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'set-btn';
    btn.style.setProperty('--c', set.color);
    btn.style.setProperty('--c-dark', set.dark);
    const best = loadBest(set.id);
    btn.innerHTML =
      `<span class="set-emoji">${set.emoji}</span>` +
      `<span class="set-name">Set ${set.id}</span>` +
      `<span class="set-tables">${set.tables[0]}× and ${set.tables[1]}× tables</span>` +
      `<span class="set-best">${best ? `🏆 Best: ${best.score}/${QUESTION_TARGET}` : 'Not played yet'}</span>`;
    btn.addEventListener('click', () => startGame(set));
    els.setGrid.appendChild(btn);
  }
  updateSoundButtons();
  showScreen('home');
}

/* ===================== game flow ===================== */

function startGame(set) {
  game = {
    set,
    q: null,
    lastPairKey: '',
    entry: '',
    score: 0,
    attempts: [],
    streak: 0,
    locked: true,
    over: false,
    completed: false,
    timeLeftMs: 0,
    endTime: 0,
    timerId: null,
    feedbackId: null,
  };
  els.scorePill.textContent = '⭐ 0';
  els.progressPill.textContent = `0/${QUESTION_TARGET}`;
  els.streakPill.hidden = true;
  els.feedback.textContent = ' ';
  els.feedback.className = 'feedback';
  els.card.className = 'question-card';
  els.questionText.textContent = ' ';
  els.entry.textContent = '';
  els.timer.textContent = formatTime(GAME_SECONDS * 1000);
  els.timer.classList.remove('critical');
  els.timerFill.style.width = '100%';
  els.timerFill.className = '';
  showScreen('game');
  runCountdown(['3', '2', '1', `GO, ${playerName.toUpperCase()}! 🚀`], () => {
    game.locked = false;
    nextQuestion();
    game.endTime = Date.now() + GAME_SECONDS * 1000;
    game.timerId = setInterval(tick, 100);
  });
}

function runCountdown(steps, done) {
  els.overlay.hidden = false;
  let i = 0;
  const show = () => {
    if (!game) { els.overlay.hidden = true; return; } // quit during countdown
    if (i >= steps.length) {
      els.overlay.hidden = true;
      done();
      return;
    }
    els.overlayText.className = steps[i].length > 4 ? 'small' : '';
    els.overlayText.textContent = steps[i];
    // retrigger the pop animation
    void els.overlayText.offsetWidth;
    playTick(i === steps.length - 1);
    i += 1;
    setTimeout(show, 650);
  };
  show();
}

function tick() {
  if (!game || game.over) return;
  const remaining = Math.max(0, game.endTime - Date.now());
  els.timer.textContent = formatTime(remaining);
  const frac = remaining / (GAME_SECONDS * 1000);
  els.timerFill.style.width = (frac * 100) + '%';
  els.timerFill.className = remaining <= 10000 ? 'critical' : remaining <= 30000 ? 'low' : '';
  els.timer.classList.toggle('critical', remaining <= 10000);
  if (remaining <= 0) finishGame(false);
}

function finishGame(completed) {
  if (!game || game.over) return;
  game.over = true;
  game.locked = true;
  game.completed = completed;
  clearInterval(game.timerId);
  clearTimeout(game.feedbackId);
  const perfect = completed && game.score === QUESTION_TARGET;
  els.overlayText.className = 'small';
  els.overlayText.textContent = perfect
    ? `🌟 PERFECT 50, ${who().toUpperCase()}! 🌟`
    : completed
      ? `🏁 ALL 50 DONE, ${who().toUpperCase()}!`
      : `⏰ TIME’S UP, ${who().toUpperCase()}!`;
  els.overlay.hidden = false;
  if (perfect) playMegaFanfare();
  else if (completed) playFanfare();
  else playTimesUp();
  setTimeout(() => {
    els.overlay.hidden = true;
    showResults();
  }, perfect ? 1900 : 1400);
}

function quitGame() {
  if (game) {
    clearInterval(game.timerId);
    clearTimeout(game.feedbackId);
    game = null;
  }
  els.overlay.hidden = true;
  renderHome();
}

/* ===================== questions ===================== */

function nextQuestion() {
  const { tables } = game.set;
  let a, b, pairKey;
  do {
    const table = tables[Math.floor(Math.random() * tables.length)];
    const mult = 1 + Math.floor(Math.random() * 12);
    // show the question either way round so 6 x 4 and 4 x 6 both appear
    [a, b] = Math.random() < 0.5 ? [table, mult] : [mult, table];
    pairKey = Math.min(a, b) + 'x' + Math.max(a, b);
  } while (pairKey === game.lastPairKey);
  game.lastPairKey = pairKey;
  game.q = { a, b, ans: a * b };
  game.entry = '';
  els.questionText.textContent = `${a} × ${b} =`;
  els.entry.textContent = '';
  els.card.className = 'question-card';
  els.feedback.textContent = ' ';
  els.feedback.className = 'feedback';
}

function handleKey(key) {
  if (!game || game.locked || game.over) return;
  if (key === 'back') {
    game.entry = game.entry.slice(0, -1);
  } else if (key === 'go') {
    submitAnswer();
    return;
  } else if (/^[0-9]$/.test(key) && game.entry.length < MAX_DIGITS) {
    // don't allow a pile of leading zeros
    game.entry = game.entry === '0' ? key : game.entry + key;
  }
  els.entry.textContent = game.entry;
}

function submitAnswer() {
  if (game.entry === '') {
    els.entryBox.classList.remove('nudge');
    void els.entryBox.offsetWidth;
    els.entryBox.classList.add('nudge');
    return;
  }
  const { a, b, ans } = game.q;
  const given = parseInt(game.entry, 10);
  const correct = given === ans;
  game.attempts.push({ a, b, ans, given, correct });
  game.locked = true;
  els.progressPill.textContent = `${game.attempts.length}/${QUESTION_TARGET}`;

  // hit the 50-question target: freeze the clock now, finish after feedback
  const hitTarget = game.attempts.length >= QUESTION_TARGET;
  if (hitTarget) {
    clearInterval(game.timerId);
    game.timeLeftMs = Math.max(0, game.endTime - Date.now());
  }
  const after = hitTarget ? () => finishGame(true) : advance;

  if (correct) {
    game.score += 1;
    game.streak += 1;
    els.scorePill.textContent = `⭐ ${game.score}`;
    if (game.streak >= 3) {
      els.streakPill.hidden = false;
      els.streakPill.textContent = `🔥 ${game.streak}`;
    }
    els.card.classList.add('right');
    els.feedback.className = 'feedback good';
    els.feedback.textContent = (game.streak >= 5 && game.streak % 5 === 0)
      ? personalise(`🔥 ${game.streak} IN A ROW, %N! 🔥`)
      : personalise(PRAISE[Math.floor(Math.random() * PRAISE.length)]);
    playCorrect();
    game.feedbackId = setTimeout(after, 650);
  } else {
    game.streak = 0;
    els.streakPill.hidden = true;
    els.card.classList.add('wrong');
    els.feedback.className = 'feedback bad';
    els.feedback.textContent =
      `${personalise(NEARLY[Math.floor(Math.random() * NEARLY.length)])} ${a} × ${b} = ${ans}`;
    playWrong();
    game.feedbackId = setTimeout(after, 2000);
  }
}

function advance() {
  if (!game || game.over) return;
  game.locked = false;
  nextQuestion();
}

/* ===================== results ===================== */

function showResults() {
  const { attempts, score, set, completed } = game;
  const attempted = attempts.length;
  const pct = Math.round((score / QUESTION_TARGET) * 100);
  const perfect = score === QUESTION_TARGET;

  const prevBest = loadBest(set.id);
  const newBest = attempted > 0 && score > (prevBest ? prevBest.score : 0);
  if (newBest) {
    localStorage.setItem(bestKey(set.id), JSON.stringify({ score, total: QUESTION_TARGET, pct }));
  }

  const stars = perfect ? 3 : pct >= 80 ? 3 : pct >= 50 ? 2 : pct >= 20 ? 1 : 0;
  const starsHtml = '★'.repeat(stars) + `<span class="dim">${'★'.repeat(3 - stars)}</span>`;

  let message;
  if (perfect)            message = '🏆 PERFECT, %N! ALL 50 RIGHT — YOU HIT THE TARGET! 🏆';
  else if (attempted === 0) message = 'The clock beat you this time, %N — jump back in! 😄';
  else if (pct >= 80)     message = 'WOW, %N! You’re a times-table superstar! 🌟';
  else if (pct >= 50)     message = 'Amazing work, %N! You really know your stuff! 💪';
  else if (pct >= 20)     message = 'Great effort, %N! You’re getting stronger every game! 🚀';
  else                    message = 'Good practising, %N! Every go makes your brain bigger! 🧠';
  message = personalise(message);

  const right = attempts.filter(x => x.correct);
  const wrong = attempts.filter(x => !x.correct);

  let html = '';
  if (perfect) html += `<div class="perfect-banner">🌟 PERFECT 50! 🌟</div>`;
  if (newBest && !perfect) html += `<div class="new-best">🏆 NEW BEST SCORE! 🏆</div>`;
  html += `<div class="big-pct${perfect ? ' perfect' : ''}">${score}/${QUESTION_TARGET}</div>`;
  html += `<div class="score-frac">${score} out of ${QUESTION_TARGET} correct (${pct}%) · Set ${set.id} (${set.tables[0]}× and ${set.tables[1]}×)</div>`;
  if (completed) {
    html += `<div class="results-sub">🏁 Finished all 50 with ${formatTime(game.timeLeftMs)} to spare!</div>`;
  } else if (attempted > 0) {
    html += `<div class="results-sub">You got through ${attempted} questions in 2 minutes — race to 50 next time!</div>`;
  }
  html += `<div class="stars">${starsHtml}</div>`;
  html += `<div class="results-message">${message}</div>`;

  if (attempted > 0) {
    const rank = autoSaveScore();
    html += `<div class="chip-section save-card" id="save-card">` +
      `<h2>🎉 ${escapeHtml(playerName)}, you're #${rank} on the leaderboard!</h2>` +
      `<div class="save-row">` +
      `<button type="button" class="big-btn save-btn" data-action="show-board">See Leaderboard</button>` +
      `</div></div>`;
  }

  if (right.length) {
    html += `<div class="chip-section"><h2>✅ You got these right (${right.length})</h2><div class="chips">` +
      right.map(x => `<span class="chip">${x.a} × ${x.b} = ${x.ans}</span>`).join('') +
      `</div></div>`;
  }
  if (wrong.length) {
    html += `<div class="chip-section"><h2>🤔 Ones to practise (${wrong.length})</h2><div class="chips">` +
      wrong.map(x =>
        `<span class="chip bad">${x.a} × ${x.b} = ${x.ans} <span class="said">(you said ${x.given})</span></span>`
      ).join('') +
      `</div></div>`;
  }

  els.resultsBody.innerHTML = html;
  showScreen('results');
  document.querySelector('#results-screen .results-scroll').scrollTop = 0;

  if (perfect) {
    playMegaFanfare();
    launchConfetti(380, 7000);
  } else {
    playFanfare();
    if (pct >= 50 || (newBest && score >= 3)) launchConfetti();
  }
}

/* ===================== leaderboard ===================== */

let lastSavedId = null;

function loadBoard() {
  try { return JSON.parse(localStorage.getItem('ttblast-board')) || []; }
  catch { return []; }
}

function sortBoard(board) {
  board.sort((a, b) => b.score - a.score || b.pct - a.pct || a.when - b.when);
  return board;
}

// Adds the finished game to the leaderboard under the start-screen name.
// Returns the entry's rank (1-based).
function autoSaveScore() {
  const entry = {
    id: String(Date.now()) + '-' + Math.floor(Math.random() * 1e6),
    name: playerName,
    score: game.score,
    total: QUESTION_TARGET,
    pct: Math.round((game.score / QUESTION_TARGET) * 100),
    set: game.set.id,
    when: Date.now(),
  };
  const board = sortBoard([...loadBoard(), entry]);
  const rank = board.findIndex(e => e.id === entry.id) + 1;
  localStorage.setItem('ttblast-board', JSON.stringify(board.slice(0, 50)));
  lastSavedId = entry.id;
  return rank;
}

function renderBoard() {
  const board = sortBoard(loadBoard());
  const medals = ['🥇', '🥈', '🥉'];
  if (!board.length) {
    els.boardList.innerHTML =
      '<p class="board-empty">No scores yet — play a game and be the first! 🚀</p>';
  } else {
    els.boardList.innerHTML = board.slice(0, 10).map((e, i) => {
      const set = SETS.find(s => s.id === e.set);
      return `<div class="board-row${e.id === lastSavedId ? ' me' : ''}">` +
        `<span class="board-rank">${medals[i] || (i + 1)}</span>` +
        `<span class="board-name">${escapeHtml(e.name)}</span>` +
        `<span class="board-set" style="background:${set ? set.color : '#64748b'}">Set ${escapeHtml(String(e.set))}</span>` +
        `<span class="board-score">⭐ ${e.score} <span class="board-pct">${e.pct}%</span></span>` +
        `</div>`;
    }).join('');
  }
  showScreen('board');
  document.querySelector('#board-screen .results-scroll').scrollTop = 0;
}

/* ===================== confetti ===================== */

function launchConfetti(count = 160, duration = 3200) {
  const canvas = els.confetti;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const colors = ['#fbbf24', '#34d399', '#60a5fa', '#f472b6', '#a78bfa', '#fff'];
  const pieces = [];
  for (let i = 0; i < count; i++) {
    pieces.push({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.5,
      w: 6 + Math.random() * 8,
      h: 8 + Math.random() * 10,
      vx: (Math.random() - 0.5) * 2.4,
      vy: 2.2 + Math.random() * 3.4,
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 0.25,
      color: colors[Math.floor(Math.random() * colors.length)],
    });
  }
  const start = performance.now();
  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vrot;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < duration) {
      requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
  requestAnimationFrame(frame);
}

/* ===================== sound (WebAudio, no files) ===================== */

let audioCtx = null;

function tone(freq, startAt, dur, type = 'sine', gain = 0.18) {
  if (!soundOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + startAt;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  } catch { /* no sound available — fine */ }
}

function playCorrect() { tone(660, 0, 0.1); tone(880, 0.09, 0.18); }
function playWrong()   { tone(196, 0, 0.3, 'square', 0.06); }
function playTick(isGo) { isGo ? tone(784, 0, 0.25, 'triangle') : tone(523, 0, 0.12, 'triangle', 0.12); }
function playTimesUp() { tone(523, 0, 0.15, 'triangle'); tone(392, 0.18, 0.3, 'triangle'); }
function playFanfare() {
  [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.13, 0.22, 'triangle'));
}

function playMegaFanfare() {
  // a longer, bigger victory tune for the perfect 50
  [523, 659, 784, 1047, 784, 1047, 1319, 1047, 1319, 1568]
    .forEach((f, i) => tone(f, i * 0.14, 0.26, 'triangle'));
}

function updateSoundButtons() {
  document.querySelectorAll('[data-action="toggle-sound"]').forEach(b => {
    b.textContent = soundOn ? '🔊' : '🔇';
  });
}

/* ===================== input wiring ===================== */

document.getElementById('numpad').addEventListener('click', (e) => {
  const key = e.target.closest('.key')?.dataset.key;
  if (key) handleKey(key);
});

document.addEventListener('keydown', (e) => {
  if (!els.game.hidden) {
    if (e.key >= '0' && e.key <= '9') handleKey(e.key);
    else if (e.key === 'Backspace') handleKey('back');
    else if (e.key === 'Enter') handleKey('go');
  } else if (!els.name.hidden && e.key === 'Enter' && e.target.id === 'name-input') {
    startApp();
  }
});

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'quit') quitGame();
  else if (action === 'play-again') { const set = game.set; startGame(set); }
  else if (action === 'pick-set') { game = null; renderHome(); }
  else if (action === 'show-board') renderBoard();
  else if (action === 'board-home') { game = null; renderHome(); }
  else if (action === 'start-app') startApp();
  else if (action === 'change-player') showNameScreen();
  else if (action === 'clear-board') {
    if (confirm('Clear all leaderboard scores?')) {
      localStorage.removeItem('ttblast-board');
      lastSavedId = null;
      renderBoard();
    }
  }
  else if (action === 'toggle-sound') {
    soundOn = !soundOn;
    localStorage.setItem('ttblast-sound', soundOn ? 'on' : 'off');
    updateSoundButtons();
    if (soundOn) playCorrect();
  }
});

/* ===================== boot ===================== */

if (playerName) renderHome();
else showNameScreen();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}
