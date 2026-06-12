'use strict';

/* ===================== Times Table Blast! =====================
   A 2-minute multiplication sprint. Pick a set (two times tables),
   answer as many as you can, get cheered on the whole way. */

const GAME_SECONDS = 120;
const MAX_DIGITS = 3; // biggest answer is 12 x 12 = 144

// Who's playing — used to personalise all the encouragement.
// %N in any message becomes the name or the nickname (random pick).
const PLAYER = { name: 'Henry', nick: 'Winkles' };

function personalise(s) {
  return s.replace('%N', Math.random() < 0.5 ? PLAYER.name : PLAYER.nick);
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
  home: $('#home-screen'),
  game: $('#game-screen'),
  results: $('#results-screen'),
  board: $('#board-screen'),
  boardList: $('#board-list'),
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
  els.home.hidden = name !== 'home';
  els.game.hidden = name !== 'game';
  els.results.hidden = name !== 'results';
  els.board.hidden = name !== 'board';
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
  document.title = `${PLAYER.name}’s Times Table Blast!`;
  document.querySelector('.title').innerHTML =
    `<span class="title-emoji">🚀</span> ${escapeHtml(PLAYER.name)}’s Times Table Blast!`;
  document.querySelector('.tagline').textContent =
    `Ready, ${PLAYER.nick}? 2 minutes on the clock — how many can you get right?`;
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
      `<span class="set-best">${best ? `🏆 Best: ${best.score}` : 'Not played yet'}</span>`;
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
    endTime: 0,
    timerId: null,
    feedbackId: null,
  };
  els.scorePill.textContent = '⭐ 0';
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
  runCountdown(['3', '2', '1', `GO, ${PLAYER.name.toUpperCase()}! 🚀`], () => {
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
  if (remaining <= 0) finishGame();
}

function finishGame() {
  if (!game || game.over) return;
  game.over = true;
  game.locked = true;
  clearInterval(game.timerId);
  clearTimeout(game.feedbackId);
  els.overlayText.className = 'small';
  els.overlayText.textContent = `⏰ TIME’S UP, ${PLAYER.nick.toUpperCase()}!`;
  els.overlay.hidden = false;
  playTimesUp();
  setTimeout(() => {
    els.overlay.hidden = true;
    showResults();
  }, 1400);
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
    game.feedbackId = setTimeout(advance, 650);
  } else {
    game.streak = 0;
    els.streakPill.hidden = true;
    els.card.classList.add('wrong');
    els.feedback.className = 'feedback bad';
    els.feedback.textContent =
      `${personalise(NEARLY[Math.floor(Math.random() * NEARLY.length)])} ${a} × ${b} = ${ans}`;
    playWrong();
    game.feedbackId = setTimeout(advance, 2000);
  }
}

function advance() {
  if (!game || game.over) return;
  game.locked = false;
  nextQuestion();
}

/* ===================== results ===================== */

function showResults() {
  const { attempts, score, set } = game;
  const total = attempts.length;
  const pct = total ? Math.round((score / total) * 100) : 0;

  const prevBest = loadBest(set.id);
  const newBest = total > 0 && score > (prevBest ? prevBest.score : 0);
  if (newBest) {
    localStorage.setItem(bestKey(set.id), JSON.stringify({ score, total, pct }));
  }

  const stars = total === 0 ? 0 : pct >= 90 ? 3 : pct >= 70 ? 2 : pct >= 40 ? 1 : 0;
  const starsHtml = '★'.repeat(stars) + `<span class="dim">${'★'.repeat(3 - stars)}</span>`;

  let message;
  if (total === 0)      message = 'The clock beat you this time, %N — jump back in! 😄';
  else if (pct >= 90)   message = 'WOW, %N! You’re a times-table superstar! 🌟';
  else if (pct >= 70)   message = 'Amazing work, %N! You really know your stuff! 💪';
  else if (pct >= 40)   message = 'Great effort, %N! You’re getting stronger every game! 🚀';
  else                  message = 'Good practising, %N! Every go makes your brain bigger! 🧠';
  message = personalise(message);

  const right = attempts.filter(x => x.correct);
  const wrong = attempts.filter(x => !x.correct);

  let html = '';
  if (newBest) html += `<div class="new-best">🏆 NEW BEST SCORE! 🏆</div>`;
  html += `<div class="big-pct">${total ? pct + '%' : '—'}</div>`;
  html += `<div class="score-frac">${score} out of ${total} correct · Set ${set.id} (${set.tables[0]}× and ${set.tables[1]}×)</div>`;
  html += `<div class="stars">${starsHtml}</div>`;
  html += `<div class="results-message">${message}</div>`;

  if (total > 0) {
    const lastName = localStorage.getItem('ttblast-player') || PLAYER.name;
    html += `<div class="chip-section save-card" id="save-card">` +
      `<h2>🏆 Add your score to the leaderboard!</h2>` +
      `<div class="save-row">` +
      `<input id="player-name" maxlength="12" placeholder="Type your name" autocomplete="off" value="${escapeHtml(lastName)}">` +
      `<button type="button" class="big-btn save-btn" data-action="save-score">Save</button>` +
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
  document.querySelector('.results-scroll').scrollTop = 0;

  playFanfare();
  if ((total > 0 && pct >= 70) || (newBest && score >= 3)) launchConfetti();
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

function saveScore() {
  const input = document.getElementById('player-name');
  if (!input || !game) return;
  const name = input.value.trim().slice(0, 12);
  if (!name) {
    input.classList.remove('nudge');
    void input.offsetWidth;
    input.classList.add('nudge');
    input.focus();
    return;
  }
  localStorage.setItem('ttblast-player', name);

  const total = game.attempts.length;
  const entry = {
    id: String(Date.now()) + '-' + Math.floor(Math.random() * 1e6),
    name,
    score: game.score,
    total,
    pct: total ? Math.round((game.score / total) * 100) : 0,
    set: game.set.id,
    when: Date.now(),
  };
  const board = sortBoard([...loadBoard(), entry]).slice(0, 50);
  localStorage.setItem('ttblast-board', JSON.stringify(board));
  lastSavedId = entry.id;

  const rank = board.findIndex(e => e.id === entry.id) + 1;
  const card = document.getElementById('save-card');
  card.innerHTML =
    `<h2>🎉 ${escapeHtml(name)}, you're #${rank} on the leaderboard!</h2>` +
    `<div class="save-row"><button type="button" class="big-btn save-btn" data-action="show-board">See Leaderboard</button></div>`;
  playFanfare();
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

function launchConfetti() {
  const canvas = els.confetti;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const colors = ['#fbbf24', '#34d399', '#60a5fa', '#f472b6', '#a78bfa', '#fff'];
  const pieces = [];
  for (let i = 0; i < 160; i++) {
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
    if (t < 3200) {
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
  } else if (!els.results.hidden && e.key === 'Enter' && e.target.id === 'player-name') {
    saveScore();
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
  else if (action === 'save-score') saveScore();
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

renderHome();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}
