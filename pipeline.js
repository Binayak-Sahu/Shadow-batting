// pipeline.js — everything between "MediaPipe found a pose" and "here is your
// rep result": smoothing → framing check → calibration → rep detection →
// measurements. No DOM, no camera, so the SAME code runs live on the phone,
// in lab.html (re-running a recorded session) and in test.html.
//
// Also: the session recorder (raw landmarks, no video) and its file format.

import { APP_VERSION, mergeSettings } from './config.js';
import { LandmarkSmoother, allVisible, framingCheck, essentialFor, frontSide, FOOT_OFF_EDGE } from './pose.js';
import { RepDetector, computeBaseline, computeRepMetrics, isStill, shoulderTurn, stanceToe } from './metrics.js';

const CALIB_SECONDS = 2;
// Side-on check (3D shoulders): 90° = side-on like facing a bowler, 0° = chest to the phone.
const MIN_TURN_CALIB = 40;   // calibrate only if at least this side-on
const TURNED_TURN = 35;      // below this = facing the phone: a rep can't start / isn't graded
const FACING_MSG_SECONDS = 3; // facing the phone this long between reps → show a hint
const GESTURE_SECONDS = 2;

/**
 * Hands-free control. A wrist counts as "up" when it is clearly above the
 * nose (0.05 H). Hold for 2 s:  both hands = finish,  one hand = recalibrate.
 * After firing, both hands must come down before the next gesture.
 */
export class GestureDetector {
  constructor(visMin) { this.visMin = visMin; this.reset(); }
  reset() { this.kind = null; this.since = null; this.needDown = false; }
  update(lm, t, Hpx) {
    const nose = lm && lm[0];
    const up = (i) => !!(lm && nose && lm[i] && lm[i].v >= this.visMin && nose.v >= this.visMin && lm[i].y < nose.y - 0.05 * Hpx);
    const n = (up(15) ? 1 : 0) + (up(16) ? 1 : 0);
    if (this.needDown) { if (n === 0) this.needDown = false; return null; }
    const kind = n === 2 ? 'finish' : n === 1 ? 'recal' : null;
    if (kind !== this.kind) { this.kind = kind; this.since = kind ? t : null; }
    if (!kind) return null;
    const p = (t - this.since) / GESTURE_SECONDS;
    if (p >= 1) { this.needDown = true; this.kind = null; this.since = null; return { kind, fire: true, p: 1 }; }
    return { kind, fire: false, p };
  }
}

/**
 * Round raw MediaPipe output to the precision we record, so a recording
 * replays to exactly the same numbers as the live session.
 *   x, y: 1e-4 of the image (0.13 px at 1280)   visibility: 0.01
 *   world x, y, z: 0.1 mm                        time: 0.1 ms
 */
export function quantizeRaw(lms) {
  if (!lms) return null;
  return lms.map((p) => ({
    x: Math.round(p.x * 1e4) / 1e4,
    y: Math.round(p.y * 1e4) / 1e4,
    z: 0,
    visibility: Math.round((p.visibility ?? 1) * 100) / 100,
  }));
}
export function quantizeWorld(lms) {
  if (!lms) return null;
  return lms.map((p) => ({
    x: Math.round(p.x * 1e4) / 1e4,
    y: Math.round(p.y * 1e4) / 1e4,
    z: Math.round(p.z * 1e4) / 1e4,
  }));
}
export const quantizeTime = (sec) => Math.round(sec * 1e4) / 1e4;

export class Pipeline {
  constructor(cfg) {
    this.cfg = cfg;
    this.smoother = new LandmarkSmoother(cfg.smoothing);
    this.worldSmoother = new LandmarkSmoother(cfg.smoothing, 1);
    this.recent = [];
    this.baseline = null;
    this.detector = null;
    this.notOkSince = null;
    this.facingSince = null;
    this.facingMsg = false;
    this.phase = 'setup';
    this.calibFrames = [];
    this.calibStart = null;
    this.F = frontSide(cfg.handedness);
    this.gestures = cfg.gestures ? new GestureDetector(cfg.visibilityMin) : null;
    this.essential = essentialFor(cfg.handedness);
  }

  /** Reasons not to grade a rep (it would only give nonsense). null = fine. */
  _implausible(rep) {
    const vis = this.cfg.visibilityMin;
    // Front foot off the bottom of the picture at landing: MediaPipe still
    // reports it as "visible" but only guesses → toe/step/head numbers are junk.
    const plant = rep.frames.filter((f) => f.ok && f.t >= rep.landT);
    const low = plant.filter((f) => Math.max(f.lm[this.F.HEEL].y, f.lm[this.F.TOE].y) > FOOT_OFF_EDGE * f.h).length;
    if (plant.length && low / plant.length > 0.3) {
      return { reason: 'offscreen', text: 'Not counted — your front foot left the picture. Move the phone back' };
    }
    const pre = rep.frames.filter((f) => f.ok && f.t < rep.startT && f.t > rep.startT - this.cfg.rep.preWindow);
    if (this.baseline.turn !== null && this.baseline.turn >= MIN_TURN_CALIB) {
      const turn = shoulderTurn(pre, vis);
      if (turn !== null && turn < TURNED_TURN) return { reason: 'turned', text: 'Not counted — start the rep side-on' };
    }
    const toe = stanceToe(pre, vis, this.cfg, this.baseline.offSign);
    if (toe !== null && toe < -20) return { reason: 'stance', text: 'Not counted — stance not recognised, recalibrate?' };
    return null;
  }

  recalibrate() {
    this.facingSince = null;
    this.facingMsg = false;
    this.baseline = null;
    this.detector = null;
    this.phase = 'setup';
    this.calibFrames = []; this.calibStart = null;
  }

  /**
   * Feed one camera frame. raw/world = quantized MediaPipe landmarks (or null
   * when nobody is seen), t = seconds, w/h = video size in px.
   * Returns { frame, phase, phaseChanged, msg, ring, calibrated, ev, result }.
   *   msg: undefined = leave as is, null = clear, {text, kind} = show.
   */
  push(raw, world, t, w, h) {
    const cfg = this.cfg;
    const frame = { t, w, h, lm: null, world: null, ok: false };
    if (raw) {
      frame.lm = this.smoother.apply(raw, t, w, h);
      frame.ok = allVisible(frame.lm, this.essential, cfg.visibilityMin);
      if (world) frame.world = this.worldSmoother.applyWorld(world, raw, t);
    } else {
      this.smoother.reset();
      this.worldSmoother.reset();
    }
    this.recent.push(frame);
    while (this.recent.length && t - this.recent[0].t > 1.5) this.recent.shift();

    const out = { frame, phase: this.phase, phaseChanged: false };
    const go = (p) => { this.phase = p; out.phase = p; out.phaseChanged = true; };
    const vis = cfg.visibilityMin;

    // Gestures: not while stepping; recalibrate only makes sense once live.
    if (this.gestures && frame.lm) {
      const stepping = this.detector && (this.detector.state === 'stepping' || this.detector.state === 'landed');
      const Hpx = this.baseline ? this.baseline.heightPx : h * 0.6;
      const g = stepping ? null : this.gestures.update(frame.lm, t, Hpx);
      if (g && (g.kind === 'finish' || this.phase === 'live')) {
        out.gesture = g;
        if (g.fire) {
          if (g.kind === 'recal') { this.recalibrate(); go('setup'); }
          return out;
        }
      }
    }

    if (this.phase === 'setup') {
      const fc = framingCheck(frame.lm, w, h, vis, cfg.handedness);
      if (fc.ok && frame.ok) { go('calib'); this.calibFrames = []; this.calibStart = null; }
      else out.msg = { text: fc.msg, kind: 'warn' };
      return out;
    }

    if (this.phase === 'calib') {
      const fc = framingCheck(frame.lm, w, h, vis, cfg.handedness);
      if (!fc.ok || !frame.ok) { go('setup'); out.msg = { text: fc.msg, kind: 'warn' }; return out; }
      const H = Math.max(10, (frame.lm[this.F.HEEL].y - frame.lm[0].y) / 0.88);
      const turn = shoulderTurn(this.recent.filter((f) => f.t > t - 0.5), vis);
      if (turn !== null && turn < MIN_TURN_CALIB) {
        this.calibFrames = []; this.calibStart = null;
        out.msg = { text: 'Stand side-on: front shoulder pointing at the phone', kind: 'warn' };
        out.ring = 0;
        return out;
      }
      if (!isStill(this.recent, t, H, this.F.ANKLE)) {
        this.calibFrames = []; this.calibStart = null;
        out.msg = { text: 'Get in your stance and hold still', kind: '' };
        out.ring = 0;
        return out;
      }
      if (this.calibStart === null) this.calibStart = t;
      this.calibFrames.push(frame);
      const prog = (t - this.calibStart) / CALIB_SECONDS;
      out.ring = prog;
      out.msg = { text: 'Hold still… measuring your stance', kind: '' };
      if (prog >= 1) {
        const base = computeBaseline(this.calibFrames, cfg);
        if (!base) { this.calibFrames = []; this.calibStart = null; return out; }
        this.baseline = base;
        this.detector = new RepDetector(cfg, base.heightPx);
        this.notOkSince = null;
        go('live');
        out.calibrated = base;
        out.msg = undefined;
      }
      return out;
    }

    // live
    if (!frame.ok) {
      if (this.notOkSince === null) this.notOkSince = t;
      if (t - this.notOkSince > 0.7) out.msg = { text: frame.lm ? 'Step back / feet not visible' : 'Can’t see you — step into frame', kind: 'warn' };
    } else if (this.notOkSince !== null) {
      this.notOkSince = null;
      out.clearWarn = true;
    }
    let ev = this.detector.update(frame);
    const d = this.detector;
    // Side-on check between reps. We never recalibrate for it: holding the
    // finish opens the shoulders for a moment, and when you turn back side-on
    // the calibration is still valid. A rep just can't START square-on.
    const sideOnCalib = this.baseline.turn !== null && this.baseline.turn >= MIN_TURN_CALIB;
    if (sideOnCalib && d.state !== 'stepping' && d.state !== 'landed') {
      const turn = shoulderTurn(this.recent.filter((f) => f.t > t - 0.5), vis);
      const facing = turn !== null && turn < TURNED_TURN;
      if (facing && ev && ev.type === 'armed') { d.state = 'settling'; d.stillSince = null; ev = null; }
      if (facing && frame.ok) {
        if (this.facingSince === null) this.facingSince = t;
        if (t - this.facingSince > FACING_MSG_SECONDS && !this.facingMsg) {
          this.facingMsg = true;
          out.msg = { text: 'Turn side-on to start the next rep', kind: 'warn' };
        }
      } else if (!facing) {
        this.facingSince = null;
        if (this.facingMsg) { this.facingMsg = false; out.clearWarn = true; }
      }
    }
    if (ev) {
      if (ev.type === 'rep') {
        const why = this._implausible(ev.rep);
        if (why) {
          out.ev = { type: 'abort', reason: why.reason };
          out.rejected = why.text;
          out.msg = { text: why.text, kind: 'warn' };
          return out;
        }
      }
      out.ev = ev;
      if (ev.type === 'rep') out.result = computeRepMetrics(ev.rep, this.baseline, cfg);
    }
    return out;
  }
}

/** Compact per-rep result (what the app stores and the recording keeps). */
export function compactResult(res, metricIds) {
  const metrics = {};
  for (const id of metricIds) {
    const m = res.metrics[id];
    metrics[id] = m ? { v: +m.value.toFixed(4), g: m.grade, l: m.label } : null;
  }
  return { score: res.score, worst: res.worst, cue: res.cue, metrics };
}

// ---------------------------------------------------------------------------
// Session recording — landmarks only, never video.
// Each frame: [t·1e4, x0·1e4, y0·1e4, v0·100, … for REC_POINTS] or [t·1e4]
// when nobody was seen. World points (if any): [x·1e4, y·1e4, z·1e4, …].
// ---------------------------------------------------------------------------
export const REC_POINTS = [0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
export const REC_FORMAT = 'shadow-mirror-recording';
const MAX_REC_SECONDS = 40 * 60;

export class Recorder {
  constructor(settings, info = {}) {
    this.data = {
      format: REC_FORMAT, version: 1, app: APP_VERSION, date: new Date().toISOString(),
      settings: JSON.parse(JSON.stringify(settings)), info,
      w: 0, h: 0, frames: [], world: [], events: [], results: [],
    };
    this.t0 = null;
    this.full = false;
  }
  frame(raw, world, t, w, h) {
    if (this.full) return;
    const d = this.data;
    if (this.t0 === null) this.t0 = t;
    if (t - this.t0 > MAX_REC_SECONDS) { this.full = true; return; }
    if (w !== d.w || h !== d.h) { d.events.push({ t, type: 'size', w, h }); d.w = d.w || w; d.h = d.h || h; }
    const row = [Math.round(t * 1e4)];
    if (raw) for (const i of REC_POINTS) row.push(Math.round(raw[i].x * 1e4), Math.round(raw[i].y * 1e4), Math.round(raw[i].visibility * 100));
    d.frames.push(row);
    const wr = [];
    if (raw && world) for (const i of REC_POINTS) wr.push(Math.round(world[i].x * 1e4), Math.round(world[i].y * 1e4), Math.round(world[i].z * 1e4));
    d.world.push(wr);
  }
  event(t, type, extra = {}) { this.data.events.push({ t, type, ...extra }); }
  result(t, compact) { this.data.results.push({ t, ...compact }); }
  get frameCount() { return this.data.frames.length; }

  /** Returns a Blob (gzip if the browser can, else plain JSON). */
  async blob() {
    const json = JSON.stringify(this.data);
    if (typeof CompressionStream === 'function') {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
      return { blob: await new Response(stream).blob(), ext: 'json.gz' };
    }
    return { blob: new Blob([json], { type: 'application/json' }), ext: 'json' };
  }
}

/** Read a recording from a File/Blob (.json or .json.gz). */
export async function readRecording(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  let text;
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = await file.text();
  }
  const d = JSON.parse(text);
  if (d.format !== REC_FORMAT) throw new Error('Not a Shadow Mirror recording');
  return d;
}

function unpackFrame(row, wrow) {
  const t = row[0] / 1e4;
  if (row.length === 1) return { t, raw: null, world: null };
  const raw = new Array(33);
  const world = wrow && wrow.length ? new Array(33) : null;
  for (let i = 0; i < 33; i++) {
    raw[i] = { x: 0, y: 0, z: 0, visibility: 0 };
    if (world) world[i] = { x: 0, y: 0, z: 0 };
  }
  REC_POINTS.forEach((idx, k) => {
    raw[idx] = { x: row[1 + k * 3] / 1e4, y: row[2 + k * 3] / 1e4, z: 0, visibility: row[3 + k * 3] / 100 };
    if (world) world[idx] = { x: wrow[k * 3] / 1e4, y: wrow[k * 3 + 1] / 1e4, z: wrow[k * 3 + 2] / 1e4 };
  });
  return { t, raw, world };
}

/**
 * Re-run a recording through the Pipeline. settings: null = the settings
 * saved in the recording; otherwise these (e.g. your current Settings).
 * Returns { results: [{t, ...compact, full}], baselines, frames }.
 */
export function runRecording(rec, metricIds, settings = null) {
  const cfg = mergeSettings(settings || rec.settings);
  let pipe = new Pipeline(cfg);
  const events = (rec.events || []).filter((e) => e.type === 'recal');
  let ei = 0;
  const results = [], baselines = [];
  let w = rec.w, h = rec.h;
  const sizes = (rec.events || []).filter((e) => e.type === 'size');
  let si = 0;
  for (let i = 0; i < rec.frames.length; i++) {
    const f = unpackFrame(rec.frames[i], rec.world && rec.world[i]);
    while (si < sizes.length && sizes[si].t <= f.t) { w = sizes[si].w; h = sizes[si].h; si++; }
    while (ei < events.length && events[ei].t <= f.t) { pipe.recalibrate(); ei++; }
    const out = pipe.push(f.raw, f.world, f.t, w, h);
    if (out.calibrated) baselines.push({ t: f.t, ...out.calibrated });
    if (out.result) results.push({ t: f.t, ...compactResult(out.result, metricIds), full: out.result });
  }
  return { results, baselines, frames: rec.frames.length, cfg };
}
