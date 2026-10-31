// app.js — screens, camera, main loop, session, storage.
import { APP_VERSION, SHOTS, SETTINGS_FIELDS, cloneDefaults, mergeSettings, getPath, setPath } from './config.js';
import { createPoseTracker, LandmarkSmoother, ESSENTIAL, allVisible, framingCheck, LM } from './pose.js';
import { RepDetector, computeBaseline, computeRepMetrics, summarizeSession, isStill, METRICS } from './metrics.js';
import { ReplayBuffer, ReplayPlayer, makeView, drawSkeleton } from './replay.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- storage
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  },
};

let settings = mergeSettings(store.get('sm.settings', null));
let shotId = 'ffd';

// ---------------------------------------------------------------- state
const S = {
  stream: null, tracker: null, trackerModel: null, smoother: null,
  phase: 'idle', raf: 0, lastVideoTime: -1, lastTs: 0, detectErrors: 0,
  recent: [], baseline: null, detector: null, calibFrames: [], calibStart: null,
  session: null, buffer: null, player: null, cardTimer: 0, notOkSince: null,
  fpsCount: 0, fpsT: 0, fps: 0, slowSecs: 0, slowTipShown: false,
  wakeLock: null, audio: null, pendingEnd: false, starting: false,
};

// ---------------------------------------------------------------- screens
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
}

// grade icon: colour + SHAPE (circle ✓ / triangle ! / square ✕) for colour-blind safety
function gradeIcon(g, size = 28) {
  const s = size;
  if (g === 'good') return `<svg class="gi" width="${s}" height="${s}" viewBox="0 0 24 24" aria-label="good"><circle cx="12" cy="12" r="11" fill="#22c55e"/><path d="M6.5 12.5l3.5 3.5 7.5-8" stroke="#06210f" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (g === 'warn') return `<svg class="gi" width="${s}" height="${s}" viewBox="0 0 24 24" aria-label="warning"><path d="M12 1.5L23 22H1z" fill="#f5b400"/><rect x="10.6" y="8" width="2.8" height="8" rx="1" fill="#2a1d00"/><circle cx="12" cy="19" r="1.6" fill="#2a1d00"/></svg>`;
  if (g === 'bad') return `<svg class="gi" width="${s}" height="${s}" viewBox="0 0 24 24" aria-label="fault"><rect x="1" y="1" width="22" height="22" rx="3" fill="#ef4444"/><path d="M7 7l10 10M17 7L7 17" stroke="#2b0505" stroke-width="3" stroke-linecap="round"/></svg>`;
  return `<svg class="gi" width="${s}" height="${s}" viewBox="0 0 24 24" aria-label="not measured"><circle cx="12" cy="12" r="10" fill="none" stroke="#6b7280" stroke-width="2" stroke-dasharray="3 3"/></svg>`;
}
const pctGrade = (p) => (p == null ? null : p >= 80 ? 'good' : p >= 50 ? 'warn' : 'bad');

// ---------------------------------------------------------------- home
function renderHome() {
  const box = $('shots');
  box.innerHTML = '';
  for (const s of SHOTS) {
    const b = document.createElement('button');
    b.className = 'shot' + (s.id === shotId ? ' selected' : '');
    b.disabled = !s.ready;
    b.innerHTML = `<span class="shot-name">${s.name}</span>${s.ready ? '' : '<span class="soon">Coming soon</span>'}`;
    b.addEventListener('click', () => { shotId = s.id; renderHome(); });
    box.appendChild(b);
  }
  $('version').textContent = `v${APP_VERSION} · video never leaves your phone`;
  $('btnLast').disabled = !store.get('sm.sessions', []).length;
}

// ---------------------------------------------------------------- loading / errors
function loading(text) {
  $('loading').classList.remove('hidden');
  $('loadText').textContent = text;
  $('loadError').classList.add('hidden');
  $('loadSpinner').classList.remove('hidden');
}
function loadingDone() { $('loading').classList.add('hidden'); }
function loadingError(text) {
  $('loading').classList.remove('hidden');
  $('loadSpinner').classList.add('hidden');
  $('loadText').textContent = 'Problem';
  $('loadError').classList.remove('hidden');
  $('loadErrorText').textContent = text;
}

// ---------------------------------------------------------------- camera
async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera needs a secure (https://) page. Open the app from your GitHub Pages link.');
  }
  const tries = [
    { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false },
    { video: { facingMode: 'user' }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr;
  for (const c of tries) {
    try {
      S.stream = await navigator.mediaDevices.getUserMedia(c);
      break;
    } catch (e) {
      lastErr = e;
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break;
    }
  }
  if (!S.stream) {
    const n = lastErr && lastErr.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      throw new Error('Camera permission was denied. In Chrome: tap the icon left of the address bar → Permissions → Camera → Allow. Then tap Retry.');
    }
    if (n === 'NotReadableError') throw new Error('The camera is busy in another app. Close that app and tap Retry.');
    if (n === 'NotFoundError' || n === 'OverconstrainedError') throw new Error('No front camera found on this device.');
    throw new Error('Could not start the camera' + (lastErr ? ` (${lastErr.name || lastErr.message})` : '') + '.');
  }
  const v = $('video');
  v.srcObject = S.stream;
  await v.play().catch(() => {});
  await new Promise((res) => {
    if (v.readyState >= 2 && v.videoWidth) return res();
    v.addEventListener('loadeddata', res, { once: true });
    setTimeout(res, 3000);
  });
}
function stopCamera() {
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
  $('video').srcObject = null;
}

async function ensureTracker() {
  if (S.tracker && S.trackerModel === settings.model) return;
  if (S.tracker) { S.tracker.close(); S.tracker = null; }
  S.tracker = await createPoseTracker(settings.model, (t) => loading(t));
  S.trackerModel = settings.model;
}

// ---------------------------------------------------------------- wake lock
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !S.wakeLock) {
      S.wakeLock = await navigator.wakeLock.request('screen');
      S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
    }
  } catch (e) { S.wakeLock = null; /* not supported or refused — fine */ }
}
function releaseAwake() { try { S.wakeLock && S.wakeLock.release(); } catch (e) { /* ignore */ } S.wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.phase !== 'idle') keepAwake();
});

// ---------------------------------------------------------------- sound / voice
function initAudio() {
  try { S.audio = S.audio || new (window.AudioContext || window.webkitAudioContext)(); S.audio.resume(); } catch (e) { S.audio = null; }
}
function beep(g) {
  if (!settings.beep || !S.audio) return;
  try {
    const notes = g === 'good' ? [[880, 0.12]] : g === 'warn' ? [[560, 0.1], [560, 0.1]] : [[300, 0.28]];
    let t = S.audio.currentTime;
    for (const [f, d] of notes) {
      const o = S.audio.createOscillator(), gain = S.audio.createGain();
      o.frequency.value = f; o.type = 'sine';
      gain.gain.setValueAtTime(0.25, t); gain.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(gain).connect(S.audio.destination);
      o.start(t); o.stop(t + d);
      t += d + 0.06;
    }
  } catch (e) { /* ignore */ }
}
function speak(text) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; speechSynthesis.speak(u); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- session flow
async function startSession() {
  if (S.starting) return;
  S.starting = true;
  initAudio();
  show('live');
  hideCard();
  $('lastResult').classList.add('hidden');
  setSideLabels(null);
  try {
    loading('Starting camera…');
    await startCamera();
    await ensureTracker();
  } catch (e) {
    console.warn(e);
    stopCamera();
    loadingError(e.message || String(e));
    S.starting = false;
    return;
  }
  loadingDone();
  S.smoother = new LandmarkSmoother(settings.smoothing);
  S.buffer = S.buffer || new ReplayBuffer(4, 20, 240);
  S.player = S.player || new ReplayPlayer($('replayCanvas'));
  S.session = {
    id: Date.now().toString(36), date: new Date().toISOString(), shot: shotId,
    target: settings.targetReps, reps: [], avgScore: 0,
  };
  S.pendingEnd = false;
  S.recent = [];
  S.lastTs = 0; S.lastVideoTime = -1; S.detectErrors = 0;
  updateTopbar();
  setPhase('setup');
  keepAwake();
  cancelAnimationFrame(S.raf);
  S.raf = requestAnimationFrame(loop);
  S.starting = false;
}

function setPhase(p) {
  S.phase = p;
  const live = $('live');
  live.dataset.phase = p;
  $('silhouette').classList.toggle('hidden', !(p === 'setup' || p === 'calib'));
  $('calibRing').classList.toggle('hidden', p !== 'calib');
  if (p === 'setup') { msg('Stand side-on in your stance, whole body inside the outline'); $('phaseLabel').textContent = 'SETUP'; }
  if (p === 'calib') { S.calibFrames = []; S.calibStart = null; $('phaseLabel').textContent = 'CALIBRATE'; }
  if (p === 'live') { $('phaseLabel').textContent = 'GET SET'; }
}

function msg(text, kind = '') {
  const m = $('msg');
  if (!text) { m.classList.add('hidden'); return; }
  m.textContent = text;
  m.className = 'msg ' + kind;
}

function setSideLabels(baseline) {
  const L = $('sideL'), R = $('sideR');
  if (!baseline) { L.classList.add('hidden'); R.classList.add('hidden'); return; }
  const offRight = baseline.offScreenSide === 'right';
  R.textContent = offRight ? 'OFF ▸' : 'LEG ▸';
  L.textContent = offRight ? '◂ LEG' : '◂ OFF';
  L.classList.remove('hidden'); R.classList.remove('hidden');
}

async function endSession() {
  cancelAnimationFrame(S.raf);
  S.player && S.player.stop();
  S.buffer && S.buffer.clear();
  clearTimeout(S.cardTimer);
  stopCamera();
  releaseAwake();
  S.phase = 'idle';
  const sess = S.session;
  S.session = null;
  if (sess && sess.reps.length) {
    saveSession(sess);
    renderSummary(sess);
  } else {
    renderSummary(null);
  }
  show('summary');
}

function saveSession(sess) {
  const sum = summarizeSession(sess.reps);
  sess.avgScore = sum.avgScore;
  const all = store.get('sm.sessions', []).filter((s) => s.id !== sess.id);
  all.push(sess);
  while (all.length > 60) all.shift();
  if (!store.set('sm.sessions', all)) console.warn('Could not save session (storage full or blocked).');
}

// ---------------------------------------------------------------- main loop
function loop() {
  S.raf = requestAnimationFrame(loop);
  const video = $('video');
  if (!S.tracker || video.readyState < 2 || !video.videoWidth) return;
  if (video.currentTime === S.lastVideoTime) return;
  S.lastVideoTime = video.currentTime;

  const ts = Math.max(performance.now(), S.lastTs + 1); // must strictly increase
  S.lastTs = ts;
  let res;
  try {
    res = S.tracker.detect(video, ts);
    S.detectErrors = 0;
  } catch (e) {
    console.warn('detect failed', e);
    if (++S.detectErrors > 10) {
      cancelAnimationFrame(S.raf);
      loadingError('Pose tracking stopped working on this phone. Try Settings → Model: Lite, then start again.');
    }
    return;
  }
  countFps(ts);

  const vw = video.videoWidth, vh = video.videoHeight;
  const raw = res && res.landmarks && res.landmarks[0];
  const frame = { t: ts / 1000, w: vw, h: vh, lm: null, ok: false };
  if (raw) {
    frame.lm = S.smoother.apply(raw, frame.t, vw, vh);
    frame.ok = allVisible(frame.lm, ESSENTIAL, settings.visibilityMin);
  } else {
    S.smoother.reset();
  }
  S.recent.push(frame);
  while (S.recent.length && frame.t - S.recent[0].t > 1.5) S.recent.shift();

  if (settings.replay && frame.lm && S.phase === 'live') S.buffer.capture(video, frame);
  handleFrame(frame);
  if (!S.player.active) drawLive(frame);
}

function countFps(ts) {
  S.fpsCount++;
  if (!S.fpsT) S.fpsT = ts;
  if (ts - S.fpsT >= 1000) {
    S.fps = Math.round((S.fpsCount * 1000) / (ts - S.fpsT));
    S.fpsCount = 0; S.fpsT = ts;
    $('fps').textContent = `${S.fps} fps · ${S.tracker.delegate}`;
    S.slowSecs = S.fps < 15 ? S.slowSecs + 1 : 0;
    if (S.slowSecs >= 5 && !S.slowTipShown && settings.model === 'full') {
      S.slowTipShown = true;
      flashTip('Phone is slow (' + S.fps + ' fps). Try Settings → Model: Lite.');
    }
  }
}
function flashTip(text) {
  const t = $('tip');
  t.textContent = text;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 6000);
}

function bodyHeightQuick(lm) {
  return Math.max(10, (lm[LM.L_HEEL].y - lm[LM.NOSE].y) / 0.88);
}

function handleFrame(frame) {
  const vis = settings.visibilityMin;
  if (S.phase === 'setup') {
    const fc = framingCheck(frame.lm, frame.w, frame.h, vis);
    if (fc.ok && frame.ok) setPhase('calib');
    else msg(fc.msg, 'warn');
    return;
  }
  if (S.phase === 'calib') {
    const fc = framingCheck(frame.lm, frame.w, frame.h, vis);
    if (!fc.ok || !frame.ok) { setPhase('setup'); msg(fc.msg, 'warn'); return; }
    const still = isStill(S.recent, frame.t, bodyHeightQuick(frame.lm));
    if (!still) {
      S.calibFrames = []; S.calibStart = null;
      msg('Get in your stance and hold still');
      setRing(0);
      return;
    }
    if (S.calibStart === null) S.calibStart = frame.t;
    S.calibFrames.push(frame);
    const prog = (frame.t - S.calibStart) / 2;
    setRing(prog);
    msg('Hold still… measuring your stance');
    if (prog >= 1) {
      const base = computeBaseline(S.calibFrames, settings);
      if (!base) { S.calibFrames = []; S.calibStart = null; return; }
      S.baseline = base;
      S.detector = new RepDetector(settings, base.heightPx);
      setSideLabels(base);
      setPhase('live');
      const side = base.offScreenSide.toUpperCase();
      msg(`Ready! Off side is on the ${side} of the screen. Play your shot.`, 'good');
      speak('Ready');
      beep('good');
      setTimeout(() => { if (S.phase === 'live' && $('msg').classList.contains('good')) msg(''); }, 3500);
    }
    return;
  }
  if (S.phase === 'live') {
    if (!frame.ok) {
      if (S.notOkSince === null) S.notOkSince = frame.t;
      if (frame.t - S.notOkSince > 0.7) msg(frame.lm ? 'Step back / feet not visible' : 'Can’t see you — step into frame', 'warn');
    } else if (S.notOkSince !== null) {
      S.notOkSince = null;
      if ($('msg').classList.contains('warn')) msg('');
    }
    const ev = S.detector.update(frame);
    if (!ev) return;
    if (ev.type === 'armed') $('phaseLabel').textContent = 'READY';
    else if (ev.type === 'start') $('phaseLabel').textContent = 'STEP…';
    else if (ev.type === 'land') $('phaseLabel').textContent = 'HOLD';
    else if (ev.type === 'abort') $('phaseLabel').textContent = 'GET SET';
    else if (ev.type === 'rep') { $('phaseLabel').textContent = 'GET SET'; onRep(ev.rep, frame); }
  }
}

function setRing(p) {
  const c = $('ringArc');
  const len = 2 * Math.PI * 45;
  c.style.strokeDasharray = `${len}`;
  c.style.strokeDashoffset = `${len * (1 - Math.max(0, Math.min(1, p)))}`;
  $('ringNum').textContent = p > 0 ? Math.max(0, Math.ceil(2 - p * 2)) : '';
}

function drawLive(frame) {
  const cv = $('overlay');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.round(cv.clientWidth * dpr), ch = Math.round(cv.clientHeight * dpr);
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  if (!frame.lm) return;
  const view = makeView(cw, ch, frame.w, frame.h, true);
  // faint line to the bowler from your stance front foot (after calibration)
  if (S.baseline && S.baseline.ankleL && S.phase === 'live') {
    const a = S.baseline.ankleL, cx = frame.w / 2, cy = frame.h / 2;
    const dy = a.y - cy;
    if (dy > 1) {
      const t = (frame.h - cy) / dy;
      ctx.setLineDash([12 * dpr, 10 * dpr]);
      ctx.strokeStyle = 'rgba(79,195,255,0.6)'; ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.moveTo(view.x(a.x), view.y(a.y));
      ctx.lineTo(view.x(cx + (a.x - cx) * t), view.y(frame.h));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  drawSkeleton(ctx, frame.lm, view, settings.visibilityMin, dpr);
}

// ---------------------------------------------------------------- per rep
function onRep(rep, frame) {
  const res = computeRepMetrics(rep, S.baseline, settings);
  const compact = {};
  for (const { id } of METRICS) {
    const m = res.metrics[id];
    compact[id] = m ? { v: +m.value.toFixed(4), g: m.grade, l: m.label } : null;
  }
  S.session.reps.push({ n: S.session.reps.length + 1, at: Date.now(), score: res.score, worst: res.worst, cue: res.cue, metrics: compact });
  saveSession(S.session); // save as we go, in case the tab is closed
  updateTopbar();
  showCard(res);
  showLastStrip(res);
  beep(res.worstGrade);
  speak(res.cue);

  const done = S.session.reps.length >= S.session.target;
  const after = () => {
    hideCard();
    if (done) endSession();
  };
  clearTimeout(S.cardTimer);
  if (settings.replay) {
    // after a moment, shrink the card so the replay shows your whole body
    S.cardTimer = setTimeout(() => $('card').classList.add('compact'), 1800);
    S.player.play({
      rep, srcW: frame.w, srcH: frame.h, speed: settings.replaySpeed,
      visMin: settings.visibilityMin, buffer: S.buffer, onDone: after,
    });
  } else {
    S.cardTimer = setTimeout(after, settings.cardSeconds * 1000);
  }
}

function metricText(id, m) {
  if (!m) return '—';
  const cm = (v) => `${Math.round(Math.abs(v) * settings.heightCm)} cm`;
  if (id === 'toe') return `${Math.round(m.value)}°`;
  if (id === 'baseWidth') return `${Math.round(m.value * 100)}%`;
  return cm(m.value);
}

function showCard(res) {
  const card = $('card');
  card.className = 'card ' + (res.worst ? res.worstGrade : 'good'); // also removes 'compact' / 'hidden'
  $('cardIcon').innerHTML = gradeIcon(res.worst ? res.worstGrade : 'good', 64);
  $('cardHead').textContent = res.headline;
  $('cardCue').textContent = res.cue;
  $('cardScore').textContent = `Rep ${S.session.reps.length} · ${res.score}%`;
  $('cardChips').innerHTML = METRICS.map(({ id, name }) => {
    const m = res.metrics[id];
    return `<div class="chip">${gradeIcon(m && m.grade, 26)}<span>${name}<b>${metricText(id, m)}</b></span></div>`;
  }).join('');
}
function hideCard() { $('card').classList.add('hidden'); }

function showLastStrip(res) {
  const el = $('lastResult');
  el.classList.remove('hidden');
  el.innerHTML = `${gradeIcon(res.worst ? res.worstGrade : 'good', 30)}<span>${res.cue}</span>` +
    METRICS.map(({ id }) => gradeIcon(res.metrics[id] && res.metrics[id].grade, 22)).join('');
}

function updateTopbar() {
  const s = S.session;
  if (!s) return;
  $('repCount').textContent = `${s.reps.length}/${s.target}`;
  const sum = summarizeSession(s.reps);
  $('scoreNow').textContent = s.reps.length ? `${sum.avgScore}%` : '–';
}

// ---------------------------------------------------------------- summary
let shownSession = null;

function renderSummary(sess) {
  shownSession = sess;
  const box = $('sumBody');
  if (!sess) {
    box.innerHTML = '<p class="big-note">No reps recorded this time.</p>';
    $('sumActions').classList.add('hidden');
    return;
  }
  $('sumActions').classList.remove('hidden');
  const sum = summarizeSession(sess.reps);
  const shot = (SHOTS.find((x) => x.id === sess.shot) || SHOTS[0]).name;
  const date = new Date(sess.date);
  const faults = Object.entries(sum.faults).sort((a, b) => b[1] - a[1]);
  const metricRows = METRICS.map(({ id, name }) => {
    const p = sum.perMetric[id];
    const g = pctGrade(p);
    return `<div class="mrow">${gradeIcon(g, 26)}<span class="mname">${name}</span>
      <span class="bar"><span class="fill ${g || ''}" style="width:${p || 0}%"></span></span>
      <span class="mpct">${p == null ? '—' : p + '%'}</span></div>`;
  }).join('');
  const nameOf = (id) => (METRICS.find((m) => m.id === id) || {}).name || id;
  box.innerHTML = `
    <p class="sub">${shot} · ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
    <div class="score-big ${pctGrade(sum.avgScore)}">${sum.avgScore}%</div>
    <p class="sub">${sum.reps} reps · average rep score</p>
    <h3>Green reps per check</h3>
    ${metricRows}
    <h3>Main faults</h3>
    ${faults.length ? '<ul class="faults">' + faults.slice(0, 3).map(([id, n]) => `<li><b>${nameOf(id)}</b> — ${n} rep${n > 1 ? "s" : ""}</li>`).join('') + '</ul>' : '<p>No faults — great session!</p>'}
    <h3>Last 10 sessions</h3>
    ${trendSvg()}
  `;
}

function trendSvg() {
  const all = store.get('sm.sessions', []).filter((s) => s.reps && s.reps.length).slice(-10);
  if (all.length < 2) return '<p class="sub">Trend appears after 2 sessions.</p>';
  const W = 320, H = 120, pad = 24;
  const xs = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, all.length - 1);
  const ys = (v) => H - pad - (v / 100) * (H - 2 * pad);
  const pts = all.map((s, i) => `${xs(i).toFixed(1)},${ys(s.avgScore).toFixed(1)}`).join(' ');
  const dots = all.map((s, i) => `<circle cx="${xs(i)}" cy="${ys(s.avgScore)}" r="5" fill="#4fc3ff"/><text x="${xs(i)}" y="${ys(s.avgScore) - 10}" fill="#cfd8e3" font-size="12" text-anchor="middle">${s.avgScore}</text>`).join('');
  return `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Average score of last sessions">
    <line x1="${pad}" y1="${ys(80)}" x2="${W - pad}" y2="${ys(80)}" stroke="#22c55e" stroke-dasharray="4 4" opacity="0.5"/>
    <polyline points="${pts}" fill="none" stroke="#4fc3ff" stroke-width="3"/>${dots}</svg>`;
}

function csvFor(sessions) {
  const head = ['session_date', 'shot', 'rep', 'score', 'worst', 'cue'];
  for (const { id } of METRICS) head.push(`${id}_value`, `${id}_grade`);
  const lines = [head.join(',')];
  for (const s of sessions) {
    for (const r of s.reps) {
      const row = [s.date, s.shot, r.n, r.score, r.worst || '', `"${r.cue}"`];
      for (const { id } of METRICS) {
        const m = r.metrics[id];
        row.push(m ? m.v : '', m ? m.g : '');
      }
      lines.push(row.join(','));
    }
  }
  return lines.join('\n');
}
function download(name, text) {
  const blob = new Blob([text], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function summaryText(sess) {
  const sum = summarizeSession(sess.reps);
  const shot = (SHOTS.find((x) => x.id === sess.shot) || SHOTS[0]).name;
  const d = new Date(sess.date);
  const avg = (id) => {
    const v = sess.reps.map((r) => r.metrics[id]).filter(Boolean).map((m) => Math.abs(m.v));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const cm = (v) => (v == null ? '—' : `${Math.round(v * settings.heightCm)} cm`);
  const faults = Object.entries(sum.faults).sort((a, b) => b[1] - a[1]);
  const nameOf = (id) => (METRICS.find((m) => m.id === id) || {}).name || id;
  const top = faults[0];
  const topCue = top ? (sess.reps.find((r) => r.worst === top[0]) || {}).cue : '';
  return [
    `Shadow Mirror — ${shot} — ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    `Reps: ${sum.reps} · Avg score: ${sum.avgScore}%`,
    'Green %: ' + METRICS.map(({ id, name }) => `${name} ${sum.perMetric[id] == null ? '—' : sum.perMetric[id] + '%'}`).join(' · '),
    top ? `Main fault: ${nameOf(top[0])} (${top[1]} reps) — cue: ${topCue}` : 'Main fault: none',
    `Averages: toe ${avg('toe') == null ? '—' : Math.round(avg('toe')) + '°'} · step off-line ${cm(avg('stepWide'))} · knee lift ${cm(avg('kneeLift'))} · head bob ${cm(avg('headBob'))} · head off foot ${cm(avg('headOverFoot'))}`,
  ].join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    return ok;
  }
}

// ---------------------------------------------------------------- settings
function renderSettings() {
  const form = $('settingsForm');
  form.innerHTML = '';
  for (const f of SETTINGS_FIELDS) {
    if (f.group) {
      const h = document.createElement('h3'); h.textContent = f.group; form.appendChild(h);
      continue;
    }
    const row = document.createElement('label');
    row.className = 'srow';
    const val = getPath(settings, f.key);
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const [v, t] of f.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; input.appendChild(o); }
      input.value = val;
    } else if (f.type === 'toggle') {
      input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!val;
    } else {
      input = document.createElement('input'); input.type = 'number'; input.inputMode = 'decimal';
      input.min = f.min; input.max = f.max; input.step = f.step; input.value = val;
    }
    input.dataset.key = f.key; input.dataset.type = f.type;
    const span = document.createElement('span'); span.textContent = f.label;
    row.appendChild(span); row.appendChild(input);
    form.appendChild(row);
  }
}
function saveSettingsFromForm() {
  const next = mergeSettings(settings);
  for (const el of $('settingsForm').querySelectorAll('[data-key]')) {
    const key = el.dataset.key, t = el.dataset.type;
    if (t === 'toggle') setPath(next, key, el.checked);
    else if (t === 'select') setPath(next, key, el.value);
    else {
      const f = SETTINGS_FIELDS.find((x) => x.key === key);
      let v = parseFloat(el.value);
      if (!Number.isFinite(v)) v = getPath(settings, key);
      v = Math.min(f.max, Math.max(f.min, v));
      setPath(next, key, v);
    }
  }
  // keep amber limits above green limits
  for (const k of Object.keys(next.thresholds)) {
    const th = next.thresholds[k];
    if (th.warn < th.good) th.warn = th.good;
  }
  settings = next;
  const ok = store.set('sm.settings', settings);
  $('settingsNote').textContent = ok ? 'Saved ✓' : 'Could not save (storage blocked) — used for this visit only.';
}

// ---------------------------------------------------------------- wire up
function wire() {
  $('btnStart').addEventListener('click', startSession);
  $('btnSettings').addEventListener('click', () => { renderSettings(); $('settingsNote').textContent = ''; show('settings'); });
  $('btnHelp').addEventListener('click', () => show('help'));
  $('btnLast').addEventListener('click', () => {
    const all = store.get('sm.sessions', []);
    renderSummary(all.length ? all[all.length - 1] : null);
    show('summary');
  });
  document.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', () => { renderHome(); show('home'); }));

  $('btnStop').addEventListener('click', endSession);
  $('btnRecal').addEventListener('click', () => {
    S.player && S.player.stop(); hideCard(); setSideLabels(null); S.baseline = null; setPhase('setup');
  });
  $('replayCanvas').addEventListener('click', () => S.player && S.player.skip());
  $('card').addEventListener('click', () => { if (S.player && S.player.active) S.player.skip(); else hideCard(); });
  $('btnRetry').addEventListener('click', startSession);
  $('btnLoadHome').addEventListener('click', () => {
    cancelAnimationFrame(S.raf); stopCamera(); releaseAwake(); S.phase = 'idle';
    loadingDone(); renderHome(); show('home');
  });

  $('btnCsv').addEventListener('click', () => {
    if (!shownSession) return;
    download(`shadow-mirror-${shownSession.date.slice(0, 10)}.csv`, csvFor([shownSession]));
  });
  $('btnCsvAll').addEventListener('click', () => {
    const all = store.get('sm.sessions', []);
    if (all.length) download('shadow-mirror-all.csv', csvFor(all));
  });
  $('btnCopy').addEventListener('click', async () => {
    if (!shownSession) return;
    const ok = await copyText(summaryText(shownSession));
    $('copyNote').textContent = ok ? 'Copied ✓ — paste it to your coach' : 'Copy failed — long-press to select instead';
    if (!ok) { $('copyFallback').value = summaryText(shownSession); $('copyFallback').classList.remove('hidden'); }
  });
  $('btnAgain').addEventListener('click', startSession);

  $('btnSaveSettings').addEventListener('click', saveSettingsFromForm);
  $('btnResetSettings').addEventListener('click', () => {
    settings = cloneDefaults(); store.set('sm.settings', settings); renderSettings();
    $('settingsNote').textContent = 'Defaults restored ✓';
  });
}

// ---------------------------------------------------------------- boot
wire();
renderHome();
show('home');
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker not registered', e));
}
