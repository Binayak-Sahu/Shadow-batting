// config.js — every number you might want to tune lives here.
// The Settings screen edits a copy of DEFAULTS and saves it in localStorage,
// so you normally tune from the app, not by editing this file.

export const APP_VERSION = '1.6.0';
export const APP_BUILD = '__BUILD__'; // commit id, filled in by the GitHub Pages workflow

// MediaPipe Tasks Vision, pinned to an exact version (not "latest").
// If you ever change this, change MP_VERSION in sw.js too.
export const MP_VERSION = '0.10.14';
export const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
export const MP_BUNDLE_URL = `${MP_BASE}/vision_bundle.mjs`;
export const MP_WASM_URL = `${MP_BASE}/wasm`;

export const MODEL_URLS = {
  heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};

// Shots shown on the home screen. Only "ffd" is built for now.
export const SHOTS = [
  { id: 'ffd', name: 'Front-foot defence', ready: true },
  { id: 'bfd', name: 'Back-foot defence', ready: false },
  { id: 'drive', name: 'Straight drive', ready: false },
  { id: 'leave', name: 'Leave', ready: false },
];

// Units used below:
//   "H"  = your body height in the image (measured at calibration and
//          re-measured just before every rep). 0.05 H ≈ 9 cm for a 183 cm person.
//   deg  = degrees.
export const DEFAULTS = {
  settingsVersion: 1,       // see SETTINGS_VERSION below
  handedness: 'right',      // 'right' or 'left' — the FRONT foot is the left foot for a right-hander
  heightCm: 183,            // only used to show values in cm
  model: 'heavy',           // 'heavy' (most accurate, ~30 MB), 'full', or 'lite' (fastest)
  autoFallback: true,       // heavy too slow (< minFps for 5 s) → switch to full for this session
  minFps: 18,
  targetReps: 30,
  beep: true,
  voice: true,              // say "Rep 7. Toe to mid-off" — you can't read the screen from 3–4 m
  gestures: true,           // both hands above head 2 s = finish, one hand = recalibrate
  camera: 'front',          // 'front' (see yourself) or 'back' (sharper; voice is then always on)
  replay: true,
  record: true,             // keep this session's landmarks (no video) for "Download recording"
  debug: false,
  stanceCheck: true,        // before every rep: same stance as calibrated? then "Ready"
  experimental: false,      // also grade Base + Head forward (3D depth — not reliable yet)
  cardDetails: false,       // result card: show every check's number (otherwise just the one cue)             // start with the debug numbers shown (or tap the fps line)
  replaySpeed: 0.4,         // 0.4 = 40% speed slow motion
  cardSeconds: 3,           // result card time when replay is off
  toeMethod: '3d',          // '3d' = MediaPipe world landmarks (no camera numbers needed), '2d' = flat picture
  camHeightM: 1.0,          // 2D method only: phone lens height above the floor
  camDistM: 3.5,            // 2D method only: phone distance from your front foot
  visibilityMin: 0.5,       // MediaPipe visibility score needed to trust a point

  // One-Euro smoothing (see pose.js). Lower minCutoff = smoother but more lag.
  smoothing: { minCutoff: 1.5, beta: 4.0, dCutoff: 1.0 },

  // Automatic rep detection (see RepDetector in metrics.js). Speeds are in H per second.
  rep: {
    speedWindow: 0.12,   // s — speed is measured over this time window
    stillSpeed: 0.10,    // below this the front foot counts as still
    startSpeed: 0.14,    // front foot faster than this = step has started (0.18 missed slow real steps)
    startDisp: 0.025,    // H — and has moved at least this far from stance
    minStep: 0.04,       // H — a real step moves the foot at least this far
    minForward: 0.02,    // H — the foot must end closer to the camera (lower in the image)
    settleFrames: 3,     // frames of a still foot = landed
    finishDelay: 0.4,    // s after landing = "finish" (hold position)
    maxStepTime: 1.6,    // s — slower than this is not a step
    preWindow: 0.5,      // s of stance before the step used as the reference
    stillTime: 0.4,      // s still in stance to arm the next rep
    returnDist: 0.06,    // H — "back in stance" means within this distance of the old stance
    rearmLongStill: 2.5, // s — if you never go back to stance, re-arm after this long still
  },

  // Green if |value| <= good, amber if <= warn, red above.
  thresholds: {
    toeAngle:     { good: 25,   warn: 45 },   // deg, 0 = toe straight at the camera/bowler
    // deg, front knee at the finish (3D). Green low–high = middle half of 64 pro
    // forward defences (CricketShotQualityAI, MIT); amber within tol outside it.
    frontKnee:    { low: 122, high: 154, tol: 12 },
    stepWide:     { good: 0.05, warn: 0.10 }, // H sideways to the LEG side vs stance
    stepWideOff:  { good: 0.09, warn: 0.15 }, // H sideways to the OFF side (a little across is normal)
    kneeLift:     { good: 0.05, warn: 0.10 }, // H the front knee rises
    headBob:      { good: 0.025, warn: 0.045 },// H up-and-down of the nose during the step
    headOverFoot: { good: 0.05, warn: 0.09 }, // H head to the LEG side of front knee/ankle at finish
    headOverFootOff: { good: 0.10, warn: 0.16 }, // H head to the OFF side (more room: ball is met beside the pad)
    baseWidth:    { good: 0.05, warn: 0.10 }, // H change of stance width vs calibration (3D)
    headForward:  { good: 0.03, warn: 0.07 }, // H the head is BEHIND the front knee at finish (3D)
  },
};

// Fields shown on the Settings screen. key = path inside the settings object.
export const SETTINGS_FIELDS = [
  { group: 'You' },
  { key: 'handedness', label: 'Batting hand', type: 'select', options: [['right', 'Right-handed'], ['left', 'Left-handed']] },
  { key: 'heightCm', label: 'Your height (cm)', type: 'number', min: 120, max: 220, step: 1 },
  { group: 'Session' },
  { key: 'targetReps', label: 'Target reps', type: 'number', min: 5, max: 200, step: 1 },
  { key: 'beep', label: 'Beep after each rep', type: 'toggle' },
  { key: 'voice', label: 'Speak rep number + cue (voice)', type: 'toggle' },
  { key: 'gestures', label: 'Hands-up gestures (finish / recalibrate)', type: 'toggle' },
  { key: 'stanceCheck', label: 'Stance check + "Ready" before every rep', type: 'toggle' },
  { key: 'replay', label: 'Slow-motion replay', type: 'toggle' },
  { key: 'record', label: 'Keep recording for download (no video)', type: 'toggle' },
  { key: 'debug', label: 'Show debug numbers', type: 'toggle' },
  { key: 'cardDetails', label: 'Result card: show all numbers', type: 'toggle' },
  { key: 'experimental', label: 'Experimental checks (Base, Head forward)', type: 'toggle' },
  { key: 'replaySpeed', label: 'Replay speed (0.2–1)', type: 'number', min: 0.2, max: 1, step: 0.05 },
  { key: 'cardSeconds', label: 'Result card seconds (replay off)', type: 'number', min: 1, max: 10, step: 0.5 },
  { group: 'Camera & model' },
  { key: 'camera', label: 'Camera', type: 'select', options: [['front', 'Front (see yourself)'], ['back', 'Back (sharper, voice on)']] },
  { key: 'model', label: 'Pose model', type: 'select', options: [['heavy', 'Heavy (most accurate)'], ['full', 'Full (balanced)'], ['lite', 'Lite (fastest)']] },
  { key: 'autoFallback', label: 'Auto-switch Heavy → Full if slow', type: 'toggle' },
  { key: 'toeMethod', label: 'Toe angle method', type: 'select', options: [['3d', '3D (recommended)'], ['2d', '2D flat picture']] },
  { key: 'camHeightM', label: 'Phone height (m) — 2D method only', type: 'number', min: 0.3, max: 2, step: 0.05 },
  { key: 'camDistM', label: 'Phone distance (m) — 2D method only', type: 'number', min: 1.5, max: 6, step: 0.1 },
  { key: 'visibilityMin', label: 'Min visibility (0–1)', type: 'number', min: 0.1, max: 0.95, step: 0.05 },
  { group: 'Thresholds — green / amber limits' },
  { key: 'thresholds.toeAngle.good', label: 'Toe angle green ≤ (deg)', type: 'number', min: 5, max: 60, step: 1 },
  { key: 'thresholds.toeAngle.warn', label: 'Toe angle amber ≤ (deg)', type: 'number', min: 10, max: 80, step: 1 },
  { key: 'thresholds.frontKnee.high', label: 'Front knee green up to (deg, straighter = higher)', type: 'number', min: 130, max: 180, step: 1 },
  { key: 'thresholds.frontKnee.low', label: 'Front knee green from (deg)', type: 'number', min: 80, max: 150, step: 1 },
  { key: 'thresholds.frontKnee.tol', label: 'Front knee amber margin (deg)', type: 'number', min: 2, max: 40, step: 1 },
  { key: 'thresholds.stepWide.good', label: 'Step to leg side green ≤ (H)', type: 'number', min: 0.01, max: 0.3, step: 0.005 },
  { key: 'thresholds.stepWide.warn', label: 'Step to leg side amber ≤ (H)', type: 'number', min: 0.02, max: 0.4, step: 0.005 },
  { key: 'thresholds.stepWideOff.good', label: 'Step to off side green ≤ (H)', type: 'number', min: 0.01, max: 0.4, step: 0.005 },
  { key: 'thresholds.stepWideOff.warn', label: 'Step to off side amber ≤ (H)', type: 'number', min: 0.02, max: 0.5, step: 0.005 },
  { key: 'thresholds.kneeLift.good', label: 'Knee lift green ≤ (H)', type: 'number', min: 0.01, max: 0.3, step: 0.005 },
  { key: 'thresholds.kneeLift.warn', label: 'Knee lift amber ≤ (H)', type: 'number', min: 0.02, max: 0.4, step: 0.005 },
  { key: 'thresholds.headBob.good', label: 'Head bob green ≤ (H)', type: 'number', min: 0.005, max: 0.2, step: 0.005 },
  { key: 'thresholds.headBob.warn', label: 'Head bob amber ≤ (H)', type: 'number', min: 0.01, max: 0.3, step: 0.005 },
  { key: 'thresholds.headOverFoot.good', label: 'Head to leg side green ≤ (H)', type: 'number', min: 0.01, max: 0.3, step: 0.005 },
  { key: 'thresholds.headOverFoot.warn', label: 'Head to leg side amber ≤ (H)', type: 'number', min: 0.02, max: 0.4, step: 0.005 },
  { key: 'thresholds.headOverFootOff.good', label: 'Head to off side green ≤ (H)', type: 'number', min: 0.01, max: 0.4, step: 0.005 },
  { key: 'thresholds.headOverFootOff.warn', label: 'Head to off side amber ≤ (H)', type: 'number', min: 0.02, max: 0.5, step: 0.005 },
  { key: 'thresholds.baseWidth.good', label: 'Base change green ≤ (H)', type: 'number', min: 0.01, max: 0.3, step: 0.005 },
  { key: 'thresholds.baseWidth.warn', label: 'Base change amber ≤ (H)', type: 'number', min: 0.02, max: 0.4, step: 0.005 },
  { key: 'thresholds.headForward.good', label: 'Head behind knee green ≤ (H)', type: 'number', min: 0.005, max: 0.3, step: 0.005 },
  { key: 'thresholds.headForward.warn', label: 'Head behind knee amber ≤ (H)', type: 'number', min: 0.01, max: 0.4, step: 0.005 },
  { group: 'Rep detection (advanced)' },
  { key: 'rep.startSpeed', label: 'Step start speed (H/s)', type: 'number', min: 0.05, max: 1, step: 0.01 },
  { key: 'rep.stillSpeed', label: 'Still speed (H/s)', type: 'number', min: 0.02, max: 0.5, step: 0.01 },
  { key: 'rep.minStep', label: 'Minimum step (H)', type: 'number', min: 0.01, max: 0.3, step: 0.005 },
  { key: 'rep.finishDelay', label: 'Finish after landing (s)', type: 'number', min: 0.1, max: 1.5, step: 0.05 },
  { key: 'smoothing.minCutoff', label: 'Smoothing (lower = smoother)', type: 'number', min: 0.2, max: 5, step: 0.1 },
];

// Deep copy + merge helpers used by app.js and test.html.
export function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}
// Bump SETTINGS_VERSION when a new default must override what an older
// version of the app saved on the phone; add the change to MIGRATIONS.
export const SETTINGS_VERSION = 4;
const MIGRATIONS = {
  2: (s) => { s.model = 'heavy'; s.voice = true; }, // v1.1: Heavy model + spoken cues are the new defaults
  3: (s) => { if (s.thresholds) delete s.thresholds.baseWidth; }, // v1.2: base is now measured in H, not a fraction
  4: (s) => { if (s.rep && s.rep.startSpeed === 0.18) s.rep.startSpeed = 0.14; }, // v1.5: slow real steps were missed
};
export function mergeSettings(saved) {
  if (saved && typeof saved === 'object') {
    saved = JSON.parse(JSON.stringify(saved));
    for (let v = (saved.settingsVersion || 1) + 1; v <= SETTINGS_VERSION; v++) MIGRATIONS[v] && MIGRATIONS[v](saved);
  }
  const out = cloneDefaults();
  const walk = (dst, src) => {
    if (!src || typeof src !== 'object') return;
    for (const k of Object.keys(dst)) {
      if (!(k in src)) continue;
      if (dst[k] && typeof dst[k] === 'object') walk(dst[k], src[k]);
      else if (typeof src[k] === typeof dst[k]) dst[k] = src[k];
    }
  };
  walk(out, saved);
  out.settingsVersion = SETTINGS_VERSION;
  return out;
}
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}
