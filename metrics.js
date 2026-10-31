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

import { LM } from './pose.js';

const NOSE_TO_HEIGHT = 0.88;

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

function bodyHeightPx(frames, visMin) {
  const nose = avgPoint(frames, LM.NOSE, visMin);
  const heelL = avgPoint(frames, LM.L_HEEL, visMin);
  const heelR = avgPoint(frames, LM.R_HEEL, visMin);
  if (!nose || !heelL) return null;
  const heelY = heelR ? (heelL.y + heelR.y) / 2 : heelL.y;
  const h = (heelY - nose.y) / NOSE_TO_HEIGHT;
  return h > 10 ? h : null;
}

function between(frames, t0, t1) {
  return frames.filter((f) => f.ok && f.t >= t0 && f.t <= t1);
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
  const good = frames.filter((f) => f.ok);
  const heightPx = bodyHeightPx(good, vis);
  if (!heightPx) return null;

  const ankleL = avgPoint(good, LM.L_ANKLE, vis);
  const ankleR = avgPoint(good, LM.R_ANKLE, vis);
  const heelL = avgPoint(good, LM.L_HEEL, vis);
  const toeL = avgPoint(good, LM.L_TOE, vis);
  const heelR = avgPoint(good, LM.R_HEEL, vis);
  const toeR = avgPoint(good, LM.R_TOE, vis);
  const nose = avgPoint(good, LM.NOSE, vis);
  const hipL = avgPoint(good, LM.L_HIP, vis);
  const hipR = avgPoint(good, LM.R_HIP, vis);

  // Off-side direction: in a side-on stance both toes point to the off side,
  // so the heel→toe x direction tells us which way "off" is in the image.
  // Default (if feet look straight on): a right-hander's off side is on the
  // image LEFT (−x) of the raw camera picture; left-hander's on the right.
  const defaultSign = cfg.handedness === 'left' ? 1 : -1;
  let s = 0;
  if (heelL && toeL) s += toeL.x - heelL.x;
  if (heelR && toeR) s += toeR.x - heelR.x;
  let offSign = defaultSign;
  let offSource = 'default';
  if (Math.abs(s) > 0.03 * heightPx) { offSign = Math.sign(s); offSource = 'feet'; }

  return {
    heightPx,
    stanceWidth: ankleL && ankleR ? Math.hypot(ankleL.x - ankleR.x, ankleL.y - ankleR.y) / heightPx : null,
    nose,
    hipY: hipL && hipR ? (hipL.y + hipR.y) / 2 : hipL ? hipL.y : null,
    ankleL,
    offSign,
    offSource,
    // Mirrored preview: raw −x shows on the SCREEN RIGHT.
    offScreenSide: offSign < 0 ? 'right' : 'left',
  };
}

/** Quick stillness test used during calibration (nose + front ankle). */
export function isStill(frames, nowT, heightPx, maxSpeed = 0.08, window = 0.25) {
  const recent = frames.filter((f) => f.ok && f.t >= nowT - window);
  if (recent.length < 3) return false;
  const a = recent[0], b = recent[recent.length - 1];
  const dt = b.t - a.t;
  if (dt <= 0) return false;
  for (const idx of [LM.NOSE, LM.L_ANKLE]) {
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
    const a = old.lm[LM.L_ANKLE], b = now.lm[LM.L_ANKLE];
    return Math.hypot(b.x - a.x, b.y - a.y) / (now.t - old.t) / this.H;
  }

  _avgAnkle(t0, t1) {
    return avgPoint(this.hist.filter((f) => f.ok && f.t >= t0 && f.t <= t1), LM.L_ANKLE, 0);
  }

  /** Feed one frame {t, lm, ok}. Returns null or an event object. */
  update(frame) {
    const R = this.cfg.rep;
    this.hist.push(frame);
    while (this.hist.length && frame.t - this.hist[0].t > 5) this.hist.shift();

    if (!frame.ok) {
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
    if (gap > 0.25 && this.state === 'armed') {
      this.state = 'settling'; this.stillSince = null;
      return { type: 'abort', reason: 'lost' };
    }

    const p = frame.lm[LM.L_ANKLE];
    const speed = this._speed(frame);
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
          // Walk back to find when the foot really started to move.
          let startT = t;
          for (let i = this.hist.length - 1; i >= 0; i--) {
            const f = this.hist[i];
            if (!f.ok) break;
            const q = f.lm[LM.L_ANKLE];
            if (Math.hypot(q.x - this.ref.x, q.y - this.ref.y) / this.H < R.startDisp * 0.3) break;
            startT = f.t;
          }
          this.step = { startT, ref: { ...this.ref }, lowCount: 0, landCandidate: null };
          this.state = 'stepping';
          return { type: 'start', t: startT };
        }
        return null;
      }
      case 'stepping': {
        const s = this.step;
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
        const rep = {
          startT: s.startT,
          landT: s.landT,
          finishT: t,
          ref: s.ref,
          frames: this.hist.filter((f) => f.t >= s.startT - R.preWindow - 0.05 && f.t <= t),
        };
        this.prevRef = s.ref;
        this.state = 'rearm';
        this.stillSince = null;
        this.step = null;
        return { type: 'rep', rep };
      }
      default:
        return null;
    }
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
  { id: 'baseWidth', name: 'Base', unit: '×' },
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

  const frames = rep.frames;
  let pre = between(frames, rep.startT - R.preWindow, rep.startT - 0.03);
  if (pre.length < 2) pre = between(frames, -Infinity, rep.startT);
  const stepFr = between(frames, rep.startT, rep.landT);
  const plant = between(frames, rep.landT, rep.finishT);
  const fin = between(frames, rep.finishT - 0.12, rep.finishT);

  // Scale for this rep: your height in px just before the step.
  const H = bodyHeightPx(pre, vis) || baseline.heightPx;
  const m = {};

  // 1) FRONT-TOE DIRECTION (at landing; averaged over the planted frames).
  //    v = heel→toe vector of the LEFT foot in the image.
  //    sideways part  = v.x · offSign            (true size)
  //    towards-camera = v.y / k                   (undo ground foreshortening)
  //    angle = atan2(sideways, towards-camera)    0° = toe at the bowler,
  //    +90° = toe pointing square to the off side (cover/point), − = leg side.
  {
    const heel = avgPoint(plant, LM.L_HEEL, vis);
    const toe = avgPoint(plant, LM.L_TOE, vis);
    if (heel && toe) {
      const side = (toe.x - heel.x) * off;
      const towards = (toe.y - heel.y) / k;
      const deg = (Math.atan2(side, towards) * 180) / Math.PI;
      let g;
      if (deg >= -th.toeAngle.good && deg <= th.toeAngle.good) g = 'good';
      else g = grade(Math.abs(deg), th.toeAngle);
      const label = g === 'good' ? 'Towards bowler'
        : deg > 0 ? (g === 'warn' ? 'Slightly open' : 'Pointing to cover')
        : (g === 'warn' ? 'Toe to leg side' : 'Toe far to leg');
      m.toe = { value: deg, grade: g, label, dir: deg >= 0 ? 'off' : 'leg' };
    } else m.toe = null;
  }

  // 2) STEP DIRECTION / WIDTH.
  //    Sideways movement of the front ankle RELATIVE TO THE BACK ANKLE
  //    (so a whole-body sway doesn't count), landing minus stance, / H.
  //    If the back ankle is hidden, the front ankle alone is used.
  {
    const aLpre = avgPoint(pre, LM.L_ANKLE, vis);
    const aLland = avgPoint(plant, LM.L_ANKLE, vis);
    const aRpre = avgPoint(pre, LM.R_ANKLE, vis);
    const aRland = avgPoint(plant, LM.R_ANKLE, vis);
    if (aLpre && aLland) {
      let dx = aLland.x - aLpre.x;
      if (aRpre && aRland) dx -= aRland.x - aRpre.x;
      const v = (dx * off) / H;
      const g = grade(Math.abs(v), th.stepWide);
      const label = g === 'good' ? 'In line'
        : (g === 'warn' ? 'Slightly wide' : 'Wide') + (v >= 0 ? ' (off)' : ' (leg)');
      m.stepWide = { value: v, grade: g, label, dir: v >= 0 ? 'off' : 'leg' };
    } else m.stepWide = null;
  }

  // 3) KNEE LIFT: highest point of the front knee during the step vs stance.
  //    lift = (stance knee y − smallest knee y during step+plant) / H
  //    (y is down, so a smaller y = higher knee).
  {
    const kPre = avgPoint(pre, LM.L_KNEE, vis);
    let minY = Infinity;
    for (const f of stepFr.concat(plant)) {
      const q = f.lm[LM.L_KNEE];
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
    const knee = avgPoint(fin, LM.L_KNEE, vis);
    const ankle = avgPoint(fin, LM.L_ANKLE, vis);
    if (nose && knee && ankle) {
      const footX = (knee.x + ankle.x) / 2;
      const v = ((nose.x - footX) * off) / H;
      const g = grade(Math.abs(v), th.headOverFoot);
      const label = g === 'good' ? 'Over front foot' : v < 0 ? 'Falling to leg' : 'Leaning to off';
      m.headOverFoot = { value: v, grade: g, label, dir: v >= 0 ? 'off' : 'leg' };
    } else m.headOverFoot = null;
  }

  // 6) BASE STABILITY: stance width just before this rep vs calibration.
  //    change = | width_now / width_calibration − 1 |
  {
    const aL = avgPoint(pre, LM.L_ANKLE, vis);
    const aR = avgPoint(pre, LM.R_ANKLE, vis);
    if (aL && aR && baseline.stanceWidth) {
      const w = Math.hypot(aL.x - aR.x, aL.y - aR.y) / H;
      const v = Math.abs(w / baseline.stanceWidth - 1);
      const g = grade(v, th.baseWidth);
      m.baseWidth = { value: v, grade: g, label: g === 'good' ? 'Same base' : g === 'warn' ? 'Base changed' : 'Base very different' };
    } else m.baseWidth = null;
  }

  return finishRep(m);
}

const CUES = {
  toe: (x) => (x.dir === 'leg' ? 'Toe to the bowler' : 'Toe to mid-off'),
  stepWide: (x) => (x.dir === 'off' ? 'Step straight, not wide' : 'Step to the line'),
  headOverFoot: () => 'Head to the ball',
  kneeLift: () => 'Smaller step, slide it',
  headBob: () => 'Head level, glide forward',
  baseWidth: () => 'Reset your stance',
};

/** Pick worst fault (red before amber, then priority order) and score. */
export function finishRep(m) {
  let worst = null;
  for (const level of ['bad', 'warn']) {
    for (const { id } of METRICS) {
      if (m[id] && m[id].grade === level) { worst = id; break; }
    }
    if (worst) break;
  }
  let pts = 0, max = 0;
  for (const { id } of METRICS) {
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
