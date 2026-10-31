// metrics.js — rep detection and all measurements. Pure functions, no DOM.
//
// COORDINATES: every point is in raw (UNMIRRORED) camera pixels: x to the
// right of the camera image, y DOWN. The preview is mirrored only when drawn.
//
// CAMERA GEOMETRY (phone front-on, where the bowler would be, ~1 m high):
//  - Moving TOWARDS the camera along the ground makes a foot move DOWN the
//    image (bigger y). So "stepping towards the bowler" = front ankle y grows.
//  - Sideways movement (towards cover or towards leg) = change in x.
//  - A ground distance d along the camera's line shows up only k = h/D times
//    as long as the same distance sideways (h = camera height, D = distance),
//    because we look at the ground at a shallow angle. k ≈ 1.0/3.5 ≈ 0.29.
//
// SCALE: all distances are divided by H = your body height in pixels, so
// results don't change when you stand closer or further.
//   H ≈ (heel y − nose y) / 0.88   (nose sits ~88% of standing height above the heel point in a batting stance)
//
// "offSign" (+1 or −1) tells which image direction (x) is your OFF side.
// It is measured at calibration from the direction your feet point in stance
// (both toes point towards point/cover). Positive "signed" values below
// always mean "towards the off side".

import { LM, frontSide, backSide } from './pose.js';

const NOSE_TO_HEIGHT = 0.88;
const MAX_HIDDEN = 1.5;   // s the front leg may stay hidden (bat in front of the pad) during a rep
const HIDDEN_LAND = 0.15; // s hidden after a real step → it has landed where it was last seen

// ---------------------------------------------------------------------------
// Averaging helpers
// ---------------------------------------------------------------------------
function avgPoint(frames, idx, visMin) {
  let sx = 0, sy = 0, n = 0;
  for (const f of frames) {
    const p = f.lm && f.lm[idx];
    if (p && p.v >= visMin) { sx += p.x; sy += p.y; n++; }
  }
  return n ? { x: sx / n, y: sy / n, n } : null;
}

// F = front-leg landmarks, B = back-leg landmarks (see frontSide in pose.js).
function bodyHeightPx(frames, visMin, F, B) {
  const nose = avgPoint(frames, LM.NOSE, visMin);
  const heelF = avgPoint(frames, F.HEEL, visMin);
  const heelB = avgPoint(frames, B.HEEL, visMin);
  if (!nose || !heelF) return null;
  const heelY = heelB ? (heelF.y + heelB.y) / 2 : heelF.y;
  const h = (heelY - nose.y) / NOSE_TO_HEIGHT;
  return h > 10 ? h : null;
}

// Same for MediaPipe WORLD landmarks (metres, 3D). Visibility from the image point.
function avgWorld(frames, idx, visMin) {
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (const f of frames) {
    const p = f.world && f.world[idx];
    const q = f.lm && f.lm[idx];
    if (p && q && q.v >= visMin) { sx += p.x; sy += p.y; sz += p.z; n++; }
  }
  return n >= 2 ? { x: sx / n, y: sy / n, z: sz / n, n } : null;
}

/** Body height in metres from world landmarks (same 0.88 rule as bodyHeightPx). */
function bodyHeightM(frames, visMin, F, B) {
  const nose = avgWorld(frames, LM.NOSE, visMin);
  const heelF = avgWorld(frames, F.HEEL, visMin);
  const heelB = avgWorld(frames, B.HEEL, visMin);
  if (!nose || !heelF) return null;
  const heelY = heelB ? (heelF.y + heelB.y) / 2 : heelF.y;
  const h = (heelY - nose.y) / NOSE_TO_HEIGHT;
  return h > 0.5 && h < 2.6 ? h : null;
}

/**
 * How side-on you stand, from the 3D shoulders: 90° = side-on (front shoulder
 * at the camera, like facing a bowler), 0° = chest square to the camera.
 * null without world landmarks.
 */
export function shoulderTurn(frames, visMin) {
  const l = avgWorld(frames, LM.L_SHOULDER, visMin), r = avgWorld(frames, LM.R_SHOULDER, visMin);
  if (!l || !r) return null;
  return (Math.atan2(Math.abs(l.z - r.z), Math.abs(l.x - r.x)) * 180) / Math.PI;
}

/** Front-toe direction in 3D (deg, 0 = at the camera, + = off side), or null. */
export function stanceToe(frames, visMin, cfg, offSign) {
  const F = frontSide(cfg.handedness);
  const h = avgWorld(frames, F.HEEL, visMin), t = avgWorld(frames, F.TOE, visMin);
  return h && t ? (Math.atan2((t.x - h.x) * offSign, -(t.z - h.z)) * 180) / Math.PI : null;
}

/** Distance between the ankles in 3D (metres). */
function ankleGap3d(frames, visMin, F, B) {
  const a = avgWorld(frames, F.ANKLE, visMin), b = avgWorld(frames, B.ANKLE, visMin);
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : null;
}

// Frames with a pose in [t0, t1]. Not only "ok" frames: at landing the bat
// often hides the front leg, but the head/hips/back leg are still useful.
// Every measurement checks the visibility of the points it uses.
function between(frames, t0, t1) {
  return frames.filter((f) => f.lm && f.t >= t0 && f.t <= t1);
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------
/**
 * Baseline from ~2 s of you standing still in your stance.
 * Records: body height H (px), stance width, head and hip position, and the
 * off-side direction (offSign).
 */
export function computeBaseline(frames, cfg) {
  const vis = cfg.visibilityMin;
  const F = frontSide(cfg.handedness), B = backSide(cfg.handedness);
  const good = frames.filter((f) => f.ok);
  const heightPx = bodyHeightPx(good, vis, F, B);
  if (!heightPx) return null;

  const ankleF = avgPoint(good, F.ANKLE, vis);
  const ankleB = avgPoint(good, B.ANKLE, vis);
  const heelF = avgPoint(good, F.HEEL, vis);
  const toeF = avgPoint(good, F.TOE, vis);
  const heelB = avgPoint(good, B.HEEL, vis);
  const toeB = avgPoint(good, B.TOE, vis);
  const nose = avgPoint(good, LM.NOSE, vis);
  const hipL = avgPoint(good, LM.L_HIP, vis);
  const hipR = avgPoint(good, LM.R_HIP, vis);

  // Off-side direction: in a side-on stance both toes point to the off side,
  // so the heel→toe x direction tells us which way "off" is in the image.
  // Default (if feet look straight on): a right-hander's off side is on the
  // image LEFT (−x) of the raw camera picture; left-hander's on the right.
  const defaultSign = cfg.handedness === 'left' ? 1 : -1;
  let s = 0;
  if (heelF && toeF) s += toeF.x - heelF.x;
  if (heelB && toeB) s += toeB.x - heelB.x;
  let offSign = defaultSign;
  let offSource = 'default';
  if (Math.abs(s) > 0.03 * heightPx) { offSign = Math.sign(s); offSource = 'feet'; }

  const heightM = bodyHeightM(good, vis, F, B); // null if no world landmarks
  const gap3 = heightM ? ankleGap3d(good, vis, F, B) : null;
  return {
    heightPx,
    heightM,
    turn: shoulderTurn(good, vis),         // how side-on the stance is (deg)
    stanceWidth3: gap3 ? gap3 / heightM : null, // stance width in 3D, in H
    stanceWidth: ankleF && ankleB ? Math.hypot(ankleF.x - ankleB.x, ankleF.y - ankleB.y) / heightPx : null,
    nose,
    hipY: hipL && hipR ? (hipL.y + hipR.y) / 2 : hipL ? hipL.y : null,
    ankleF,
    offSign,
    offSource,
    // Mirrored preview: raw −x shows on the SCREEN RIGHT.
    offScreenSide: offSign < 0 ? 'right' : 'left',
  };
}

/** Quick stillness test used during calibration (nose + front ankle). */
export function isStill(frames, nowT, heightPx, ankleIdx = LM.L_ANKLE, maxSpeed = 0.08, window = 0.25) {
  let recent = frames.filter((f) => f.ok && f.t >= nowT - window);
  if (recent.length < 3) {
    // slow phone (< 12 fps): use the last 3 good frames if they are recent enough
    const ok = frames.filter((f) => f.ok);
    recent = ok.slice(-3);
    if (recent.length < 3 || nowT - recent[0].t > 0.75) return false;
  }
  const a = recent[0], b = recent[recent.length - 1];
  const dt = b.t - a.t;
  if (dt <= 0) return false;
  for (const idx of [LM.NOSE, ankleIdx]) {
    const v = Math.hypot(b.lm[idx].x - a.lm[idx].x, b.lm[idx].y - a.lm[idx].y) / dt / heightPx;
    if (v > maxSpeed) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rep detection — a small state machine on the FRONT (left) ankle.
//
//   settling → armed → stepping → landed → (rep) → rearm → armed …
//
// armed:    foot still in stance; "ref" = stance position of the front ankle.
// stepping: foot left the stance (moved > startDisp AND speed > startSpeed).
// landed:   foot still again for settleFrames, moved > minStep and ended
//           closer to the camera (y grew by > minForward). Landing time = the
//           first still frame.
// finish:   landing + finishDelay (your hold). Then a 'rep' event is emitted.
// rearm:    wait until you're back in stance (within returnDist of the old
//           stance and still), or still anywhere for rearmLongStill seconds.
// ---------------------------------------------------------------------------
export class RepDetector {
  constructor(cfg, heightPx) {
    this.cfg = cfg;
    this.H = heightPx;
    this.A = frontSide(cfg.handedness).ANKLE; // the front ankle drives everything
    this.speed = 0;
    this.reset();
  }
  reset() {
    this.state = 'settling';
    this.hist = [];
    this.ref = null;
    this.prevRef = null;
    this.stillSince = null;
    this.step = null;
    this.lastOkT = null;
    this.lastOkFrame = null;
  }
  setScale(heightPx) { this.H = heightPx; }

  _speed(now) {
    // Speed of the front ankle over the last speedWindow seconds, in H/s.
    const w = this.cfg.rep.speedWindow;
    let old = null;
    for (let i = this.hist.length - 1; i >= 0; i--) {
      const f = this.hist[i];
      if (!f.ok) continue;
      old = f;
      if (now.t - f.t >= w) break;
    }
    if (!old || old === now) return 0;
    const a = old.lm[this.A], b = now.lm[this.A];
    return Math.hypot(b.x - a.x, b.y - a.y) / (now.t - old.t) / this.H;
  }

  _avgAnkle(t0, t1) {
    return avgPoint(this.hist.filter((f) => f.ok && f.t >= t0 && f.t <= t1), this.A, 0);
  }

  /** Feed one frame {t, lm, ok}. Returns null or an event object. */
  update(frame) {
    const R = this.cfg.rep;
    this.hist.push(frame);
    while (this.hist.length && frame.t - this.hist[0].t > 5) this.hist.shift();

    if (!frame.ok) {
      // Front leg hidden while the body is still seen: in a front-foot
      // defence the bat comes down in front of the front pad, so from the
      // bowler's end it covers the knee/ankle/foot right at landing.
      const vis = this.cfg.visibilityMin;
      const coreOk = !!frame.lm && [LM.NOSE, LM.L_HIP, LM.R_HIP].every((i) => frame.lm[i].v >= vis);
      if (coreOk && (this.state === 'stepping' || this.state === 'landed')) {
        const s = this.step;
        if (s.hiddenSince == null) s.hiddenSince = frame.t;
        if (this.state === 'landed') {
          return frame.t >= s.landT + R.finishDelay ? this._emitRep(frame.t) : null;
        }
        if (frame.t - s.hiddenSince > MAX_HIDDEN) {
          this.state = 'settling'; this.stillSince = null; this.step = null;
          return { type: 'abort', reason: 'lost' };
        }
        // Covered after a real step forward: it has landed where last seen.
        const ls = s.lastSeen;
        if (ls && frame.t - s.hiddenSince >= HIDDEN_LAND && ls.disp >= R.minStep && ls.forward >= R.minForward) {
          s.landT = ls.t; s.hidden = true;
          this.state = 'landed';
          return { type: 'land', t: s.landT, hidden: true };
        }
        return null;
      }
      // Ready, the foot stepped (slowly, so no 'start' yet) and then the bat
      // covered it: if the last time we saw it, it had already moved a real
      // step forward, the step happened — it landed where it was last seen.
      if (coreOk && this.state === 'armed' && this.lastOkFrame && this.ref) {
        const lo = this.lastOkFrame, q = lo.lm[this.A];
        const disp = Math.hypot(q.x - this.ref.x, q.y - this.ref.y) / this.H;
        const forward = (q.y - this.ref.y) / this.H;
        if (frame.t - lo.t >= HIDDEN_LAND && disp >= R.minStep && forward >= R.minForward) {
          this.step = { startT: this._findStart(lo.t), ref: { ...this.ref }, lowCount: 0, landCandidate: null, landT: lo.t, hidden: true };
          this.state = 'landed';
          return { type: 'land', t: lo.t, hidden: true };
        }
      }
      if (this.state === 'stepping' || this.state === 'landed') {
        this.state = 'settling'; this.stillSince = null; this.step = null;
        return { type: 'abort', reason: 'lost' };
      }
      this.stillSince = null;
      return null;
    }

    // If the feet were hidden for a while, we don't know what happened in
    // between — start fresh instead of guessing a step across the gap.
    const gap = this.lastOkT != null ? frame.t - this.lastOkT : 0;
    this.lastOkT = frame.t;
    this.lastOkFrame = frame;
    if (gap > 0.25 && this.state === 'armed') {
      this.state = 'settling'; this.stillSince = null;
      return { type: 'abort', reason: 'lost' };
    }

    const p = frame.lm[this.A];
    const speed = this._speed(frame);
    this.speed = speed;
    const still = speed < R.stillSpeed;
    const t = frame.t;

    switch (this.state) {
      case 'settling':
      case 'rearm': {
        if (!still) { this.stillSince = null; return null; }
        if (this.stillSince === null) this.stillSince = t;
        const held = t - this.stillSince;
        const near = this.prevRef ? Math.hypot(p.x - this.prevRef.x, p.y - this.prevRef.y) / this.H < R.returnDist : true;
        const ready = this.state === 'settling'
          ? held >= R.stillTime
          : (near && held >= R.stillTime) || held >= R.rearmLongStill;
        if (ready) {
          this.ref = this._avgAnkle(this.stillSince, t) || { x: p.x, y: p.y };
          this.state = 'armed';
          return { type: 'armed' };
        }
        return null;
      }
      case 'armed': {
        const disp = Math.hypot(p.x - this.ref.x, p.y - this.ref.y) / this.H;
        if (still) {
          // follow tiny drifts of your stance
          this.ref = { x: this.ref.x * 0.9 + p.x * 0.1, y: this.ref.y * 0.9 + p.y * 0.1 };
        }
        if (disp > R.startDisp && speed > R.startSpeed) {
          const startT = this._findStart(t);
          this.step = { startT, ref: { ...this.ref }, lowCount: 0, landCandidate: null };
          this.state = 'stepping';
          return { type: 'start', t: startT };
        }
        return null;
      }
      case 'stepping': {
        const s = this.step;
        s.hiddenSince = null;
        s.lastSeen = { t, disp: Math.hypot(p.x - s.ref.x, p.y - s.ref.y) / this.H, forward: (p.y - s.ref.y) / this.H };
        if (t - s.startT > R.maxStepTime) {
          this.state = 'settling'; this.stillSince = null; this.prevRef = s.ref;
          return { type: 'abort', reason: 'slow' };
        }
        if (!still) { s.lowCount = 0; s.landCandidate = null; return null; }
        if (s.lowCount === 0) s.landCandidate = t;
        s.lowCount++;
        if (s.lowCount < R.settleFrames) return null;
        const disp = Math.hypot(p.x - s.ref.x, p.y - s.ref.y) / this.H;
        const forward = (p.y - s.ref.y) / this.H;
        // Paused part-way (still out of the stance, not a full step yet): some
        // batters step in two slow stages — keep waiting (until maxStepTime).
        if (disp < R.minStep && disp >= R.startDisp && forward >= 0) { s.lowCount = 0; s.landCandidate = null; return null; }
        if (disp < R.minStep || forward < R.minForward) {
          // foot came back, or moved backwards (e.g. returning to stance)
          this.state = 'settling'; this.stillSince = s.landCandidate;
          return { type: 'abort', reason: disp < R.minStep ? 'small' : 'backward' };
        }
        s.landT = s.landCandidate;
        this.state = 'landed';
        return { type: 'land', t: s.landT };
      }
      case 'landed': {
        const s = this.step;
        if (t < s.landT + R.finishDelay) return null;
        return this._emitRep(t);
      }
      default:
        return null;
    }
  }

  /** Walk back from time t to when the front foot really left the stance. */
  _findStart(t) {
    const R = this.cfg.rep;
    let startT = t;
    for (let i = this.hist.length - 1; i >= 0; i--) {
      const f = this.hist[i];
      if (f.t > t) continue;
      if (!f.ok) break;
      const q = f.lm[this.A];
      if (Math.hypot(q.x - this.ref.x, q.y - this.ref.y) / this.H < R.startDisp * 0.3) break;
      startT = f.t;
    }
    return startT;
  }

  /** Landed + held the finish: hand over the rep (frames from just before the step). */
  _emitRep(t) {
    const R = this.cfg.rep;
    const s = this.step;
    const rep = {
      startT: s.startT,
      landT: s.landT,
      finishT: t,
      ref: s.ref,
      hidden: !!s.hidden, // front foot was covered (by the bat) at landing
      frames: this.hist.filter((f) => f.t >= s.startT - R.preWindow - 0.05 && f.t <= t),
    };
    this.prevRef = s.ref;
    this.state = 'rearm';
    this.stillSince = null;
    this.step = null;
    return { type: 'rep', rep };
  }
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------
export const METRICS = [
  // Order = priority when choosing the ONE cue to show (coach's priorities).
  { id: 'toe', name: 'Front toe', unit: '°' },
  { id: 'stepWide', name: 'Step line', unit: 'H' },
  { id: 'headOverFoot', name: 'Head over foot', unit: 'H' },
  { id: 'kneeLift', name: 'Knee lift', unit: 'H' },
  { id: 'headBob', name: 'Head bob', unit: 'H' },
  // experimental = measured and recorded, but NOT used for the cue or score
  // unless Settings → Experimental checks is on. Both rely on 3D depth, which
  // real sessions showed to be unreliable for distances (stride read 0 or less).
  { id: 'baseWidth', name: 'Base', unit: 'H', experimental: true },
  // New in v1.1 (3D, needs tuning on real reps) — last, so it is the main cue only when nothing else is off.
  { id: 'headForward', name: 'Head forward', unit: 'H', experimental: true },
];

const GRADE_POINTS = { good: 2, warn: 1, bad: 0 };

export function grade(absValue, th) {
  if (absValue == null || Number.isNaN(absValue)) return null;
  if (absValue <= th.good) return 'good';
  if (absValue <= th.warn) return 'warn';
  return 'bad';
}

// ---------------------------------------------------------------------------
// Per-rep measurement
// ---------------------------------------------------------------------------
/**
 * Measure one rep. rep = output of RepDetector ('rep' event), baseline from
 * computeBaseline, cfg = settings. Returns { metrics, worst, cue, score }.
 */
export function computeRepMetrics(rep, baseline, cfg) {
  const vis = cfg.visibilityMin;
  const th = cfg.thresholds;
  const off = baseline.offSign;
  const k = cfg.camHeightM / cfg.camDistM; // ground foreshortening factor (see top)
  const R = cfg.rep;
  const F = frontSide(cfg.handedness), B = backSide(cfg.handedness);

  const frames = rep.frames;
  let pre = between(frames, rep.startT - R.preWindow, rep.startT - 0.03);
  if (pre.length < 2) pre = between(frames, -Infinity, rep.startT);
  const stepFr = between(frames, rep.startT, rep.landT);
  const plant = between(frames, rep.landT, rep.finishT);
  const fin = between(frames, rep.finishT - 0.12, rep.finishT);

  // Scale for this rep: your height in px just before the step.
  const H = bodyHeightPx(pre, vis, F, B) || baseline.heightPx;
  const m = {};

  // 1) FRONT-TOE DIRECTION (at landing; averaged over the planted frames).
  //    3D (default when MediaPipe gives world landmarks): heel→toe in metres.
  //      sideways = dx · offSign,  towards the camera = −dz  (smaller z = closer)
  //      angle = atan2(sideways, towards). No camera height/distance needed.
  //    2D fallback: v = heel→toe vector of the front foot in the image.
  //    sideways part  = v.x · offSign            (true size)
  //    towards-camera = v.y / k                   (undo ground foreshortening)
  //    angle = atan2(sideways, towards-camera)    0° = toe at the bowler,
  //    +90° = toe pointing square to the off side (cover/point), − = leg side.
  {
    let deg = null, method = null;
    const wHeel = cfg.toeMethod !== '2d' ? avgWorld(plant, F.HEEL, vis) : null;
    const wToe = cfg.toeMethod !== '2d' ? avgWorld(plant, F.TOE, vis) : null;
    if (wHeel && wToe) {
      deg = (Math.atan2((wToe.x - wHeel.x) * off, -(wToe.z - wHeel.z)) * 180) / Math.PI;
      method = '3d';
    } else {
      const heel = avgPoint(plant, F.HEEL, vis);
      const toe = avgPoint(plant, F.TOE, vis);
      if (heel && toe) {
        deg = (Math.atan2((toe.x - heel.x) * off, (toe.y - heel.y) / k) * 180) / Math.PI;
        method = '2d';
      }
    }
    if (deg !== null) {
      let g;
      if (deg >= -th.toeAngle.good && deg <= th.toeAngle.good) g = 'good';
      else g = grade(Math.abs(deg), th.toeAngle);
      const label = g === 'good' ? 'Towards bowler'
        : deg > 0 ? (g === 'warn' ? 'Slightly open' : 'Pointing to cover')
        : (g === 'warn' ? 'Toe to leg side' : 'Toe far to leg');
      m.toe = { value: deg, grade: g, label, dir: deg >= 0 ? 'off' : 'leg', method };
    } else m.toe = null;
  }

  // 2) STEP DIRECTION / WIDTH.
  //    Sideways movement of the front ankle RELATIVE TO THE BACK ANKLE
  //    (so a whole-body sway doesn't count), landing minus stance, / H.
  //    If the back ankle is hidden, the front ankle alone is used.
  {
    const aLpre = avgPoint(pre, F.ANKLE, vis);
    const aLland = avgPoint(plant, F.ANKLE, vis);
    const aRpre = avgPoint(pre, B.ANKLE, vis);
    const aRland = avgPoint(plant, B.ANKLE, vis);
    if (aLpre && aLland) {
      let dx = aLland.x - aLpre.x;
      if (aRpre && aRland) dx -= aRland.x - aRpre.x;
      const v = (dx * off) / H;
      // A little across to the off side is normal (step to the line of a ball
      // on or outside off stump); stepping to leg is graded strictly.
      const g = grade(Math.abs(v), v >= 0 ? th.stepWideOff : th.stepWide);
      const label = g === 'good' ? 'In line'
        : (g === 'warn' ? 'Slightly wide' : 'Wide') + (v >= 0 ? ' (off)' : ' (leg)');
      m.stepWide = { value: v, grade: g, label, dir: v >= 0 ? 'off' : 'leg' };
    } else m.stepWide = null;
  }

  // 3) KNEE LIFT: highest point of the front knee during the step vs stance.
  //    lift = (stance knee y − smallest knee y during step+plant) / H
  //    (y is down, so a smaller y = higher knee).
  {
    const kPre = avgPoint(pre, F.KNEE, vis);
    let minY = Infinity;
    for (const f of stepFr.concat(plant)) {
      const q = f.lm[F.KNEE];
      if (q.v >= vis && q.y < minY) minY = q.y;
    }
    if (kPre && minY < Infinity) {
      const v = Math.max(0, (kPre.y - minY) / H);
      const g = grade(v, th.kneeLift);
      m.kneeLift = { value: v, grade: g, label: g === 'good' ? 'Low and smooth' : g === 'warn' ? 'Bit high' : 'High stamp' };
    } else m.kneeLift = null;
  }

  // 4) HEAD BOB: up-and-down of the nose from step start to finish.
  //    The head is ALLOWED to travel smoothly (forward/down), so we remove the
  //    straight line from the start height to the finish height, then take the
  //    range (max − min) of what's left, / H.
  {
    const fr = between(frames, rep.startT, rep.finishT).filter((f) => f.lm[LM.NOSE].v >= vis);
    if (fr.length >= 4) {
      const n = Math.min(3, Math.floor(fr.length / 3));
      const y0 = fr.slice(0, n).reduce((s, f) => s + f.lm[LM.NOSE].y, 0) / n;
      const y1 = fr.slice(-n).reduce((s, f) => s + f.lm[LM.NOSE].y, 0) / n;
      const t0 = fr[0].t, t1 = fr[fr.length - 1].t;
      let lo = Infinity, hi = -Infinity;
      for (const f of fr) {
        const line = y0 + ((y1 - y0) * (f.t - t0)) / Math.max(1e-6, t1 - t0);
        const r = f.lm[LM.NOSE].y - line;
        if (r < lo) lo = r;
        if (r > hi) hi = r;
      }
      const v = (hi - lo) / H;
      const g = grade(v, th.headBob);
      m.headBob = { value: v, grade: g, label: g === 'good' ? 'Level' : g === 'warn' ? 'Some bob' : 'Head bobbing' };
    } else m.headBob = null;
  }

  // 5) HEAD OVER FRONT FOOT at the finish.
  //    Sideways gap between nose and the middle of front knee + front ankle,
  //    signed so + = head towards the off side, − = towards leg ("falling away").
  //    Note: from front-on we can only see sideways; forward lean is not measured.
  {
    const nose = avgPoint(fin, LM.NOSE, vis);
    const knee = avgPoint(fin, F.KNEE, vis);
    const ankle = avgPoint(fin, F.ANKLE, vis);
    if (nose && knee && ankle) {
      const footX = (knee.x + ankle.x) / 2;
      const v = ((nose.x - footX) * off) / H;
      // Off side gets more room: the ball is met just in front of / outside the
      // front pad, so a head slightly to the off side is right. Leg side is strict.
      const g = grade(Math.abs(v), v >= 0 ? th.headOverFootOff : th.headOverFoot);
      const label = g === 'good' ? 'Over front foot' : v < 0 ? 'Falling to leg' : 'Too far to off';
      m.headOverFoot = { value: v, grade: g, label, dir: v >= 0 ? 'off' : 'leg' };
    } else m.headOverFoot = null;
  }

  // 6) BASE STABILITY: stance width just before this rep vs calibration.
  //    change = | width_now − width_calibration |  in H.
  //    3D ankle distance when available: from the front the feet are one
  //    behind the other, so the flat picture shows only a sliver of the width.
  {
    const hm = bodyHeightM(pre, vis, F, B) || baseline.heightM;
    const g3 = hm && baseline.stanceWidth3 ? ankleGap3d(pre, vis, F, B) : null;
    const aL = avgPoint(pre, F.ANKLE, vis);
    const aR = avgPoint(pre, B.ANKLE, vis);
    let v = null;
    if (g3) v = Math.abs(g3 / hm - baseline.stanceWidth3);
    else if (aL && aR && baseline.stanceWidth) v = Math.abs(Math.hypot(aL.x - aR.x, aL.y - aR.y) / H - baseline.stanceWidth);
    if (v !== null) {
      const g = grade(v, th.baseWidth);
      m.baseWidth = { value: v, grade: g, label: g === 'good' ? 'Same base' : g === 'warn' ? 'Base changed' : 'Base very different' };
    } else m.baseWidth = null;
  }

  // 7) HEAD FORWARD (3D only): at the finish, is the head over the front knee
  //    or behind it (falling back)? Uses depth (z) of nose vs front knee.
  //      ahead = (knee z − nose z) / body height   (+ = head nearer the bowler)
  //    Graded on how far BEHIND the knee the head is; being over or a bit
  //    ahead of the knee is good.
  {
    const nose = avgWorld(fin, LM.NOSE, vis);
    const knee = avgWorld(fin, F.KNEE, vis);
    const hm = bodyHeightM(pre, vis, F, B) || baseline.heightM;
    if (nose && knee && hm) {
      const v = (knee.z - nose.z) / hm;
      const g = grade(Math.max(0, -v), th.headForward);
      m.headForward = { value: v, grade: g, label: g === 'good' ? 'Head over knee' : g === 'warn' ? 'Head a bit back' : 'Head behind knee' };
    } else m.headForward = null;
  }

  return finishRep(m, cfg);
}

// Cues are spoken and shown big, so: short, plain words, and they say which
// way to move. "The phone" = where the bowler is.
const CUES = {
  toe: (x) => (x.dir === 'leg' ? 'Front toe turned in — open it a little' : 'Point your front toe more at the phone'),
  stepWide: (x) => (x.dir === 'off' ? 'Step straighter, towards the phone' : 'Don’t step across — step towards the phone'),
  headOverFoot: (x) => (x.dir === 'leg' ? 'Head falling away — keep it over your front knee' : 'Head too far over — keep it above your front knee'),
  kneeLift: () => 'Smaller step — slide the foot, don’t lift the knee',
  headBob: () => 'Keep your head level as you step',
  baseWidth: () => 'Go back to the same stance width',
  headForward: () => 'Lean forward — head over your front knee',
};

/** Pick worst fault (red before amber, then priority order) and score. */
/** The checks that are graded (cue + score) with these settings. */
export function activeMetrics(cfg) {
  return METRICS.filter((x) => !x.experimental || (cfg && cfg.experimental));
}

export function finishRep(m, cfg = null) {
  const ACTIVE = activeMetrics(cfg);
  let worst = null;
  for (const level of ['bad', 'warn']) {
    for (const { id } of ACTIVE) {
      if (m[id] && m[id].grade === level) { worst = id; break; }
    }
    if (worst) break;
  }
  let pts = 0, max = 0;
  for (const { id } of ACTIVE) {
    if (m[id] && m[id].grade) { pts += GRADE_POINTS[m[id].grade]; max += 2; }
  }
  const score = max ? Math.round((pts / max) * 100) : 0;
  return {
    metrics: m,
    worst,
    worstGrade: worst ? m[worst].grade : 'good',
    cue: worst ? CUES[worst](m[worst]) : 'Good rep!',
    headline: worst ? m[worst].label : 'All good',
    score,
  };
}

// ---------------------------------------------------------------------------
// Session summary
// ---------------------------------------------------------------------------
export function summarizeSession(reps) {
  const out = { reps: reps.length, avgScore: 0, perMetric: {}, faults: {} };
  if (!reps.length) return out;
  out.avgScore = Math.round(reps.reduce((s, r) => s + r.score, 0) / reps.length);
  for (const { id } of METRICS) {
    // works on live results ({grade}) and on saved reps ({g})
    const graded = reps.map((r) => r.metrics[id]).map((x) => x && (x.grade || x.g)).filter(Boolean);
    const good = graded.filter((g) => g === 'good').length;
    out.perMetric[id] = graded.length ? Math.round((good / graded.length) * 100) : null;
  }
  for (const r of reps) if (r.worst) out.faults[r.worst] = (out.faults[r.worst] || 0) + 1;
  return out;
}
