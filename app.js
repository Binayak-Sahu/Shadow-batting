// app.js — screens, camera, main loop, session, storage.
import { APP_VERSION, APP_BUILD, SHOTS, SETTINGS_FIELDS, cloneDefaults, mergeSettings, getPath, setPath } from './config.js';
import { createPoseTracker, LM, frontSide } from './pose.js';
import { summarizeSession, METRICS } from './metrics.js';
import { ReplayBuffer, ReplayPlayer, makeView, drawSkeleton } from './replay.js';
import { Pipeline, Recorder, quantizeRaw, quantizeWorld, quantizeTime, compactResult } from './pipeline.js';
import { getGh, setGh, ghReady, testConnection, queueAdd, flushQueue, recordingPath } from './upload.js';

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
  phase: 'idle', raf: 0, vfc: 0, timeSource: '', lastVideoTime: -1, lastTs: 0, detectErrors: 0,
  recent: [], baseline: null, detector: null, calibFrames: [], calibStart: null,
  session: null, buffer: null, player: null, cardTimer: 0, notOkSince: null,
  fpsCount: 0, fpsT: 0, fps: 0, slowSecs: 0, slowTipShown: false,
  pipe: null, rec: null, lastRec: null, lastT: 0, debug: false, debugT: 0, lastResult: null,
  lastRecFile: null, paused: false, gestureShown: false, gestureTimer: 0,
  wakeLock: null, audio: null, pendingEnd: false, starting: false,
  modelOverride: null, switching: false, fpsFrom: 0,
};
// Model actually used: Settings choice, unless this session auto-switched away from Heavy.
const activeModel = () => S.modelOverride || settings.model;

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
  const build = APP_BUILD.startsWith('__') ? 'dev' : APP_BUILD;
  $('version').textContent = `v${APP_VERSION} (${build}) · video never leaves your phone`;
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
  const facingMode = settings.camera === 'back' ? 'environment' : 'user';
  const tries = [
    // 1280×720: more pixels on the feet (the hardest points to track).
    { video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false },
    { video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false },
    { video: { facingMode }, audio: false },
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
    if (n === 'NotFoundError' || n === 'OverconstrainedError') throw new Error(`No ${settings.camera === 'back' ? 'back' : 'front'} camera found on this device.`);
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
  const model = activeModel();
  if (S.tracker && S.trackerModel === model) return;
  if (S.tracker) { S.tracker.close(); S.tracker = null; }
  S.tracker = await createPoseTracker(model, (t) => loading(t));
  S.trackerModel = model;
}

// Heavy is too slow right now (e.g. phone got hot) → switch to Full for the
// rest of this session. The Settings choice is not changed.
async function fallbackToFull() {
  if (S.switching) return;
  S.switching = true;
  const fps = S.fps;
  S.modelOverride = 'full';
  const old = S.tracker;
  S.tracker = null; // the loop skips frames while switching
  try {
    S.tracker = await createPoseTracker('full', () => {});
    S.trackerModel = 'full';
    if (old) old.close();
    flashTip(`Heavy model too slow (${fps} fps) — switched to Full for this session.`);
  } catch (e) {
    S.tracker = old; S.modelOverride = null; // keep going on Heavy
  }
  S.slowSecs = 0; S.fpsFrom = performance.now() + 3000;
  S.switching = false;
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
// Leaving the app (home button, screen off, call): stop the camera cleanly.
// Coming back: restart it and recalibrate, keeping the reps done so far.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { if (S.session && S.stream && !S.paused) pauseSession(); return; }
  if (S.paused) resumeSession();
  else if (S.phase !== 'idle') keepAwake();
});
function pauseSession() {
  S.paused = true;
  stopLoop();
  S.player && S.player.stop();
  S.buffer && S.buffer.clear();
  clearTimeout(S.cardTimer);
  hideCard();
  stopCamera();
  releaseAwake();
  try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
}
async function resumeSession() {
  S.paused = false;
  if (!S.session) return;
  try {
    loading('Resuming camera…');
    await startCamera();
    await ensureTracker();
  } catch (e) {
    loadingError(e.message || String(e));
    return;
  }
  loadingDone();
  resetCalibrationUi();
  S.pipe.recalibrate();
  if (S.rec) S.rec.event(S.lastT, 'recal');
  setPhase('setup');
  msg('Welcome back — take your stance to recalibrate', 'warn');
  S.fpsFrom = performance.now() + 3000; S.slowSecs = 0;
  keepAwake();
  startLoop();
}

// ---------------------------------------------------------------- sound / voice
function initAudio() {
  try { S.audio = S.audio || new (window.AudioContext || window.webkitAudioContext)(); S.audio.resume(); } catch (e) { S.audio = null; }
  // Android Chrome only speaks after speech was started from a tap: unlock it now (silently).
  try {
    if (voiceOn() && 'speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }
  } catch (e) { /* ignore */ }
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
// Voice is always on with the back camera: you can't see the screen then.
const voiceOn = () => settings.voice || settings.camera === 'back';
function speak(text) {
  if (!voiceOn() || !('speechSynthesis' in window)) return;
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
    S.modelOverride = null;
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
  S.pipe = new Pipeline(settings);
  S.rec = settings.record ? new Recorder(settings, { ua: navigator.userAgent, shot: shotId }) : null;
  S.lastT = 0;
  S.buffer = S.buffer || new ReplayBuffer(4, 20, 240);
  S.player = S.player || new ReplayPlayer($('replayCanvas'));
  S.session = {
    id: Date.now().toString(36), date: new Date().toISOString(), shot: shotId,
    target: settings.targetReps, reps: [], avgScore: 0,
  };
  S.pendingEnd = false;
  S.lastTs = 0; S.lastVideoTime = -1; S.detectErrors = 0;
  S.slowSecs = 0; S.fpsCount = 0; S.fpsT = 0;
  S.fpsFrom = performance.now() + 3000; // ignore the first seconds (model warm-up)
  updateTopbar();
  setPhase('setup');
  keepAwake();
  toggleDebug(settings.debug);
  startLoop();
  S.starting = false;
}

function setPhase(p) {
  S.phase = p;
  const live = $('live');
  live.dataset.phase = p;
  $('silhouette').classList.toggle('hidden', !(p === 'setup' || p === 'calib'));
  $('calibRing').classList.toggle('hidden', p !== 'calib');
  if (p === 'setup') { msg('Stand side-on like facing a bowler: front shoulder to the phone'); $('phaseLabel').textContent = 'SETUP'; }
  if (p === 'calib') { $('phaseLabel').textContent = 'CALIBRATE'; }
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
  S.paused = false;
  stopLoop();
  S.player && S.player.stop();
  S.buffer && S.buffer.clear();
  clearTimeout(S.cardTimer);
  stopCamera();
  releaseAwake();
  S.phase = 'idle';
  const sess = S.session;
  S.session = null;
  S.lastRec = S.rec && S.rec.frameCount ? S.rec : null;
  S.rec = null;
  S.lastRecFile = null;
  $('recRow').classList.toggle('hidden', !S.lastRec);
  $('upNote').textContent = '';
  if (S.lastRec) {
    $('recNote').textContent = `${S.lastRec.frameCount} frames, landmarks only (no video). Open it in Lab to re-run with new settings.`;
    queueRecording(S.lastRec, sess ? sess.reps : []);
  }
  if (sess && sess.reps.length) {
    saveSession(sess);
    renderSummary(sess);
  } else {
    renderSummary(null);
  }
  show('summary');
}

// ---------------------------------------------------------------- recordings → GitHub
function upStatus(text, kind = '') {
  for (const id of ['upNote', 'upHome']) {
    const el = $(id);
    el.textContent = text;
    el.className = 'tiny up ' + kind;
  }
}
/** The recording as a File (gzip), made once per session. */
async function recordingFile(rec) {
  if (S.lastRecFile && S.lastRecFile.rec === rec) return S.lastRecFile;
  const { blob, ext } = await rec.blob();
  const name = `shadow-mirror-rec-${rec.data.date.slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;
  S.lastRecFile = { rec, blob, ext, name, file: new File([blob], name, { type: ext.endsWith('gz') ? 'application/gzip' : 'application/json' }) };
  return S.lastRecFile;
}
async function queueRecording(rec, reps) {
  if (!ghReady()) {
    upStatus('Tip: Settings → GitHub upload sends recordings to your private repo automatically.');
    return;
  }
  try {
    const f = await recordingFile(rec);
    const avg = reps.length ? summarizeSession(reps).avgScore : 0;
    await queueAdd({
      path: recordingPath(rec, f.ext, reps.length), blob: f.blob, added: Date.now(),
      message: `Recording ${rec.data.date.slice(0, 16).replace('T', ' ')} · ${reps.length} reps · avg ${avg}%`,
    });
    flushQueue(upStatus);
  } catch (e) {
    console.warn('queue failed', e);
    upStatus('Could not queue the upload (storage blocked?) — use Share or Download.', 'warn');
  }
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
// One callback per NEW camera frame (requestVideoFrameCallback), so no frame
// is processed twice and each gets the camera's own capture time. Older
// browsers fall back to requestAnimationFrame + the page clock.
function startLoop() {
  stopLoop();
  const video = $('video');
  if (typeof video.requestVideoFrameCallback === 'function') {
    const cb = (now, meta) => { S.vfc = video.requestVideoFrameCallback(cb); loop(meta); };
    S.vfc = video.requestVideoFrameCallback(cb);
  } else {
    const cb = () => { S.raf = requestAnimationFrame(cb); loop(null); };
    S.raf = requestAnimationFrame(cb);
  }
}
function stopLoop() {
  cancelAnimationFrame(S.raf); S.raf = 0;
  if (S.vfc) { try { $('video').cancelVideoFrameCallback(S.vfc); } catch (e) { /* ignore */ } S.vfc = 0; }
}

/** Frame time in ms on the performance.now() clock: camera capture time if the browser gives it. */
function frameTimeMs(meta) {
  const now = performance.now();
  const ct = meta && meta.captureTime;
  if (typeof ct === 'number' && ct > 0 && Math.abs(now - ct) < 1000) return ct;
  return now;
}

function loop(meta) {
  const video = $('video');
  if (!S.tracker || video.readyState < 2 || !video.videoWidth) return;
  if (!meta) {
    if (video.currentTime === S.lastVideoTime) return;
    S.lastVideoTime = video.currentTime;
  }

  const ts = Math.max(frameTimeMs(meta), S.lastTs + 1); // must strictly increase
  S.lastTs = ts;
  S.timeSource = meta && meta.captureTime ? 'cam' : 'page';
  let res;
  try {
    res = S.tracker.detect(video, ts);
    S.detectErrors = 0;
  } catch (e) {
    console.warn('detect failed', e);
    if (++S.detectErrors > 10) {
      stopLoop();
      loadingError('Pose tracking stopped working on this phone. Try Settings → Model: Lite, then start again.');
    }
    return;
  }
  countFps(ts);

  const vw = video.videoWidth, vh = video.videoHeight;
  // Quantize first: the recording then replays to exactly the same numbers.
  const raw = quantizeRaw(res && res.landmarks && res.landmarks[0]);
  const world = raw ? quantizeWorld(res.worldLandmarks && res.worldLandmarks[0]) : null;
  const t = quantizeTime(ts / 1000);
  S.lastT = t;
  if (S.rec) S.rec.frame(raw, world, t, vw, vh);

  const out = S.pipe.push(raw, world, t, vw, vh);
  const frame = out.frame;
  if (settings.replay && frame.lm && S.phase === 'live') S.buffer.capture(video, frame);
  handleOut(out);
  if (!S.player.active) drawLive(frame);
  if (S.debug) drawDebug(frame, out);
}

function countFps(ts) {
  S.fpsCount++;
  if (!S.fpsT) S.fpsT = ts;
  if (ts - S.fpsT >= 1000) {
    S.fps = Math.round((S.fpsCount * 1000) / (ts - S.fpsT));
    S.fpsCount = 0; S.fpsT = ts;
    const model = activeModel();
    const v = $('video');
    $('fps').textContent = `${S.fps} fps · ${model} · ${S.tracker ? S.tracker.delegate : ''} · ${v.videoWidth}×${v.videoHeight}`;
    if (ts < S.fpsFrom) return;
    S.slowSecs = S.fps < settings.minFps ? S.slowSecs + 1 : 0;
    if (S.slowSecs >= 5 && model === 'heavy' && settings.autoFallback) { fallbackToFull(); return; }
    if (S.slowSecs >= 5 && !S.slowTipShown && model !== 'lite') {
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

// Apply what the pipeline decided to the screen.
function handleOut(out) {
  if (out.gesture) onGesture(out.gesture);
  if (out.turned) { resetCalibrationUi(); speak('You turned. Stand side-on and hold still.'); beep('warn'); }
  if (out.phaseChanged) setPhase(out.phase);
  const gestureMsg = out.gesture && !out.gesture.fire;
  if (out.msg !== undefined && !gestureMsg) msg(out.msg && out.msg.text, out.msg && out.msg.kind);
  if (out.clearWarn && $('msg').classList.contains('warn')) msg('');
  if (out.ring !== undefined) setRing(out.ring);
  if (out.calibrated) {
    const base = out.calibrated;
    S.baseline = base;
    setSideLabels(base);
    if (S.rec) S.rec.event(out.frame.t, 'calibrated', { offSign: base.offSign, heightPx: Math.round(base.heightPx) });
    const side = base.offScreenSide.toUpperCase();
    msg(`Ready! Off side is on the ${side} of the screen. Play your shot.`, 'good');
    speak('Ready');
    beep('good');
    setTimeout(() => { if (S.phase === 'live' && $('msg').classList.contains('good')) msg(''); }, 3500);
  }
  const ev = out.ev;
  if (!ev) return;
  if (ev.type === 'armed') $('phaseLabel').textContent = 'READY';
  else if (ev.type === 'start') $('phaseLabel').textContent = 'STEP…';
  else if (ev.type === 'land') $('phaseLabel').textContent = 'HOLD';
  else if (ev.type === 'abort') $('phaseLabel').textContent = 'GET SET';
  else if (ev.type === 'rep') { $('phaseLabel').textContent = 'GET SET'; onRep(ev.rep, out.result, out.frame); }
}

// Hands-up gestures: show progress, then finish or recalibrate.
function onGesture(g) {
  const what = g.kind === 'finish' ? 'Both hands up — finishing' : 'One hand up — recalibrating';
  if (!g.fire) {
    if (!S.gestureShown) beep('warn');
    S.gestureShown = true;
    msg(`${what} in ${Math.max(0, Math.ceil(2 - g.p * 2))}…`, 'warn');
    clearTimeout(S.gestureTimer);
    S.gestureTimer = setTimeout(() => { S.gestureShown = false; if ($('msg').textContent.startsWith(what)) msg(''); }, 400);
    return;
  }
  S.gestureShown = false;
  clearTimeout(S.gestureTimer);
  msg('');
  if (g.kind === 'finish') { speak('Session finished'); endSession(); return; }
  speak('Recalibrate. Take your stance.');
  resetCalibrationUi(); // the pipeline already recalibrated (and does so again when a recording is re-run)
}
function resetCalibrationUi() {
  S.player && S.player.stop(); hideCard(); setSideLabels(null); S.baseline = null;
}

// ---------------------------------------------------------------- debug overlay
// Tap the fps line (bottom) to show/hide. Shows what the app is measuring right now.
function toggleDebug(on = !S.debug) {
  S.debug = on;
  $('debug').classList.toggle('hidden', !on);
}
function drawDebug(frame, out) {
  const now = performance.now();
  if (now - (S.debugT || 0) < 200) return; // 5× a second is enough to read
  S.debugT = now;
  const p = S.pipe, d = p.detector, b = p.baseline, F = frontSide(settings.handedness);
  const lm = frame.lm;
  const vis = (i) => (lm && lm[i] ? lm[i].v.toFixed(2) : '–');
  const lines = [
    `phase ${p.phase}${d ? ' · rep ' + d.state : ''} · frame ${frame.ok ? 'OK' : 'NOT OK'} · time ${S.timeSource}`,
    `vis nose ${vis(LM.NOSE)} · front knee ${vis(F.KNEE)} ankle ${vis(F.ANKLE)} heel ${vis(F.HEEL)} toe ${vis(F.TOE)}`,
    `world ${frame.world ? 'yes' : 'no'} · rec ${S.rec ? S.rec.frameCount + ' fr' : 'off'}`,
  ];
  if (b) lines.push(`H ${Math.round(b.heightPx)} px · off ${b.offSign > 0 ? '+x' : '−x'} (${b.offSource}) · stance ${b.stanceWidth ? b.stanceWidth.toFixed(3) : '–'} H`);
  if (d) {
    const R = settings.rep;
    const ref = d.ref, a = lm && lm[F.ANKLE];
    const disp = ref && a ? Math.hypot(a.x - ref.x, a.y - ref.y) / d.H : 0;
    lines.push(`ankle speed ${d.speed.toFixed(2)} H/s (start > ${R.startSpeed}, still < ${R.stillSpeed}) · moved ${disp.toFixed(3)} H`);
  }
  if (S.lastResult) {
    lines.push('last rep: ' + METRICS.map(({ id }) => {
      const m = S.lastResult.metrics[id];
      return `${id} ${m ? (+m.value).toFixed(id === 'toe' ? 0 : 3) + ' ' + m.grade[0] : '–'}`;
    }).join(' · '));
  }
  $('debug').textContent = lines.join('\n');
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
  if (S.baseline && S.baseline.ankleF && S.phase === 'live') {
    const a = S.baseline.ankleF, cx = frame.w / 2, cy = frame.h / 2;
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
  drawSkeleton(ctx, frame.lm, view, settings.visibilityMin, dpr, settings.handedness);
}

// ---------------------------------------------------------------- per rep
function onRep(rep, res, frame) {
  S.lastResult = res;
  const c = compactResult(res, METRICS.map((m) => m.id));
  if (S.rec) S.rec.result(frame.t, c);
  S.session.reps.push({ n: S.session.reps.length + 1, at: Date.now(), ...c });
  saveSession(S.session); // save as we go, in case the tab is closed
  updateTopbar();
  showCard(res);
  showLastStrip(res);
  beep(res.worstGrade);
  speak(`Rep ${S.session.reps.length}. ${res.cue}`);

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
      visMin: settings.visibilityMin, buffer: S.buffer, onDone: after, handedness: settings.handedness,
    });
  } else {
    S.cardTimer = setTimeout(after, settings.cardSeconds * 1000);
  }
}

function metricText(id, m) {
  if (!m) return '—';
  const cm = (v) => `${Math.round(Math.abs(v) * settings.heightCm)} cm`;
  if (id === 'toe') return `${Math.round(m.value)}°`;
  if (id === 'headForward') return `${cm(m.value)} ${m.value >= 0 ? 'ahead' : 'back'}`;
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
  downloadBlob(name, new Blob([text], { type: 'text/csv' }));
}
function downloadBlob(name, blob) {
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
  const headFwd = () => {
    const v = sess.reps.map((r) => r.metrics.headForward).filter(Boolean).map((m) => m.v);
    if (!v.length) return '—';
    const a = v.reduce((x, y) => x + y, 0) / v.length;
    return `${Math.round(Math.abs(a) * settings.heightCm)} cm ${a >= 0 ? 'ahead' : 'back'}`;
  };
  const faults = Object.entries(sum.faults).sort((a, b) => b[1] - a[1]);
  const nameOf = (id) => (METRICS.find((m) => m.id === id) || {}).name || id;
  const top = faults[0];
  const topCue = top ? (sess.reps.find((r) => r.worst === top[0]) || {}).cue : '';
  return [
    `Shadow Mirror — ${shot} — ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    `Reps: ${sum.reps} · Avg score: ${sum.avgScore}%`,
    'Green %: ' + METRICS.map(({ id, name }) => `${name} ${sum.perMetric[id] == null ? '—' : sum.perMetric[id] + '%'}`).join(' · '),
    top ? `Main fault: ${nameOf(top[0])} (${top[1]} reps) — cue: ${topCue}` : 'Main fault: none',
    `Averages: toe ${avg('toe') == null ? '—' : Math.round(avg('toe')) + '°'} · step off-line ${cm(avg('stepWide'))} · knee lift ${cm(avg('kneeLift'))} · head bob ${cm(avg('headBob'))} · head off foot ${cm(avg('headOverFoot'))} · head vs knee ${headFwd()}`,
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
function renderGh() {
  const gh = getGh();
  $('ghRepo').value = gh.repo;
  $('ghToken').value = gh.token;
  $('ghAuto').checked = gh.auto;
  $('ghNote').textContent = gh.token ? 'Token saved on this phone only.' : 'Not set up yet.';
  $('ghNote').className = 'tiny';
}
function saveGhFromForm() {
  setGh({ repo: $('ghRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, ''), token: $('ghToken').value.trim(), auto: $('ghAuto').checked });
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
  saveGhFromForm();
  const ok = store.set('sm.settings', settings);
  $('settingsNote').textContent = ok ? 'Saved ✓' : 'Could not save (storage blocked) — used for this visit only.';
}

// ---------------------------------------------------------------- wire up
function wire() {
  $('btnStart').addEventListener('click', startSession);
  $('btnSettings').addEventListener('click', () => { renderSettings(); renderGh(); $('settingsNote').textContent = ''; show('settings'); });
  $('btnHelp').addEventListener('click', () => show('help'));
  $('btnLast').addEventListener('click', () => {
    const all = store.get('sm.sessions', []);
    $('recRow').classList.add('hidden');
    renderSummary(all.length ? all[all.length - 1] : null);
    show('summary');
  });
  document.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', () => { renderHome(); show('home'); }));

  $('btnStop').addEventListener('click', endSession);
  $('btnRecal').addEventListener('click', () => {
    resetCalibrationUi();
    if (S.pipe) S.pipe.recalibrate();
    if (S.rec) S.rec.event(S.lastT, 'recal');
    setPhase('setup');
  });
  $('replayCanvas').addEventListener('click', () => S.player && S.player.skip());
  $('card').addEventListener('click', () => { if (S.player && S.player.active) S.player.skip(); else hideCard(); });
  $('btnRetry').addEventListener('click', startSession);
  $('btnLoadHome').addEventListener('click', () => {
    stopLoop(); stopCamera(); releaseAwake(); S.phase = 'idle';
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
  $('fps').addEventListener('click', () => toggleDebug());
  $('btnRec').addEventListener('click', async () => {
    if (!S.lastRec) return;
    const f = await recordingFile(S.lastRec);
    downloadBlob(f.name, f.blob);
  });
  $('btnShare').addEventListener('click', async () => {
    if (!S.lastRec) return;
    const f = await recordingFile(S.lastRec);
    try {
      if (navigator.canShare && navigator.canShare({ files: [f.file] })) {
        await navigator.share({ files: [f.file], title: 'Shadow Mirror recording' });
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return; // closed the share menu
    }
    downloadBlob(f.name, f.blob); // sharing files not supported → download instead
  });
  $('btnGhTest').addEventListener('click', async () => {
    saveGhFromForm();
    $('ghNote').textContent = 'Checking…';
    const r = await testConnection();
    $('ghNote').textContent = r.msg;
    $('ghNote').className = 'tiny ' + (r.ok ? 'good' : 'warn');
    if (r.ok) flushQueue(upStatus);
  });
  window.addEventListener('online', () => flushQueue(upStatus));

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
flushQueue(upStatus); // anything left from an offline session
// Updates: the service worker installs a new version in the background. When it
// takes over, offer a reload (never in the middle of a session).
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && S.phase === 'idle') reg.update().catch(() => {});
    });
  }).catch((e) => console.warn('Service worker not registered', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) $('updateBar').classList.remove('hidden'); // first install isn't an "update"
  });
  $('btnReload').addEventListener('click', () => location.reload());
}
