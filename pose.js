// pose.js — MediaPipe setup, landmark smoothing, framing checks.
// Nothing here runs on import; the MediaPipe library is loaded only when
// createPoseTracker() is called, so test.html can import the helpers offline.

import { MP_BUNDLE_URL, MP_WASM_URL, MODEL_URLS } from './config.js';

// MediaPipe's 33 pose landmarks (the ones we use).
// LEFT/RIGHT are YOUR anatomical left/right, not screen sides.
export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_TOE: 31, R_TOE: 32, // "foot index" in MediaPipe = tip of the foot
};

// Lines drawn for the skeleton.
export const BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];

/**
 * Load MediaPipe and create a PoseLandmarker.
 * Tries the GPU first, falls back to CPU. Throws a friendly Error on failure.
 * Returns { detect(video, timestampMs), close(), delegate }.
 */
export async function createPoseTracker(modelKey = 'full', onStatus = () => {}) {
  let mp;
  try {
    onStatus('Loading pose library…');
    mp = await import(MP_BUNDLE_URL);
  } catch (e) {
    throw new Error('Could not download the pose library. Connect to the internet once, then it works offline.');
  }
  let fileset;
  try {
    fileset = await mp.FilesetResolver.forVisionTasks(MP_WASM_URL);
  } catch (e) {
    throw new Error('Could not load the pose engine files (WASM). Check your internet and tap Retry.');
  }
  const modelUrl = MODEL_URLS[modelKey] || MODEL_URLS.full;
  let landmarker = null;
  let delegate = 'GPU';
  for (const d of ['GPU', 'CPU']) {
    try {
      onStatus(`Loading ${modelKey} model (${d})…`);
      landmarker = await mp.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl, delegate: d },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      delegate = d;
      break;
    } catch (e) {
      console.warn(`PoseLandmarker ${d} failed:`, e);
      landmarker = null;
    }
  }
  if (!landmarker) {
    throw new Error('Could not load the pose model. Connect to the internet once (about 10 MB), then tap Retry.');
  }
  return {
    delegate,
    detect(video, timestampMs) {
      return landmarker.detectForVideo(video, timestampMs);
    },
    close() {
      try { landmarker.close(); } catch (e) { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------
// One-Euro filter (Casiez et al. 2012): a low-pass filter whose cutoff rises
// with speed, so still poses are very smooth but fast moves don't lag much.
//   alpha(cutoff) = 1 / (1 + tau/dt), tau = 1 / (2π·cutoff)
//   cutoff = minCutoff + beta · |speed|
// ---------------------------------------------------------------------------
class OneEuro {
  constructor(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value, t) {
    if (this.x === null || this.t === null || t <= this.t) {
      this.x = value; this.t = t; this.dx = 0;
      return value;
    }
    const dt = Math.min(t - this.t, 0.5);
    this.t = t;
    const rawDx = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/**
 * Smooths all 33 landmarks. Input: MediaPipe normalized landmarks (0..1).
 * Output: array of {x, y, v} in VIDEO PIXELS (square pixels, so angles are
 * correct), unmirrored — exactly as the camera sees it.
 * beta is given in "per H" units; we convert using a rough pixel scale.
 */
export class LandmarkSmoother {
  constructor(params) {
    this.params = params;
    this.reset();
  }
  reset() {
    this.fx = []; this.fy = []; this.v = [];
  }
  apply(raw, tSec, width, height) {
    const { minCutoff, beta, dCutoff } = this.params;
    const pxBeta = beta / Math.max(1, height * 0.6); // speed in px/s → H/s approx
    const out = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      if (!this.fx[i]) {
        this.fx[i] = new OneEuro(minCutoff, pxBeta, dCutoff);
        this.fy[i] = new OneEuro(minCutoff, pxBeta, dCutoff);
        this.v[i] = raw[i].visibility ?? 1;
      }
      const vis = raw[i].visibility ?? 1;
      this.v[i] = this.v[i] * 0.6 + vis * 0.4; // simple EMA on visibility
      out[i] = {
        x: this.fx[i].filter(raw[i].x * width, tSec),
        y: this.fy[i].filter(raw[i].y * height, tSec),
        v: this.v[i],
      };
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
export const ESSENTIAL = [LM.NOSE, LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.L_ANKLE, LM.L_HEEL, LM.L_TOE];

export function isVisible(lm, idx, min) {
  return !!(lm && lm[idx] && lm[idx].v >= min);
}
export function allVisible(lm, idxs, min) {
  return idxs.every((i) => isVisible(lm, i, min));
}
export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Framing check for the Setup screen. lm in pixels, w/h = video size.
 * Returns { ok, msg }. Directions are given for YOU (person facing the phone).
 * In the raw camera image your own LEFT side appears on the image RIGHT.
 */
export function framingCheck(lm, w, h, visMin) {
  if (!lm) return { ok: false, msg: 'Can’t see you — stand in front of the phone' };
  if (!isVisible(lm, LM.NOSE, visMin)) return { ok: false, msg: 'Head not visible — face the phone' };
  const feet = [LM.L_ANKLE, LM.L_HEEL, LM.L_TOE];
  if (!allVisible(lm, feet, visMin)) return { ok: false, msg: 'Step back — feet not visible' };
  const nose = lm[LM.NOSE];
  const footY = Math.max(lm[LM.L_HEEL].y, lm[LM.L_TOE].y);
  // leave room below the feet: the front foot moves DOWN the picture when you step forward
  if (footY > h * 0.92) return { ok: false, msg: 'Step back — leave space below your feet' };
  if (nose.y < h * 0.04) return { ok: false, msg: 'Step back — head at the top edge' };
  const frac = (footY - nose.y) / h;
  if (frac < 0.45) return { ok: false, msg: 'Too small — move the phone closer' };
  if (frac > 0.9) return { ok: false, msg: 'Too big — move the phone back' };
  const cx = (lm[LM.L_HIP].x + lm[LM.R_HIP].x) / 2 / w;
  if (cx > 0.7) return { ok: false, msg: 'Step to your RIGHT' };
  if (cx < 0.3) return { ok: false, msg: 'Step to your LEFT' };
  return { ok: true, msg: 'Good framing' };
}
