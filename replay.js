// replay.js — rolling buffer of the last few seconds (small video frames +
// landmarks) and the slow-motion replay with skeleton and guide lines.

import { LM, BONES } from './pose.js';

const COLORS = {
  bone: 'rgba(255,255,255,0.85)',
  front: '#ffd400',        // front (left) leg in yellow
  joint: '#ffffff',
  bowler: '#4fc3ff',       // line to the bowler
  toe: '#ff5cf0',          // toe direction arrow
  plumb: '#7CFF6B',        // vertical line from front foot (head check)
  nose: '#ff8a00',
};

const FRONT_LEG = new Set([25, 27, 29, 31]);

/**
 * Maps raw camera pixels → canvas pixels with "cover" fit and optional
 * mirroring (so the screen behaves like a mirror). Used for live + replay.
 */
export function makeView(canvasW, canvasH, srcW, srcH, mirror = true) {
  const s = Math.max(canvasW / srcW, canvasH / srcH);
  const dw = srcW * s, dh = srcH * s;
  const ox = (canvasW - dw) / 2, oy = (canvasH - dh) / 2;
  return {
    s, dw, dh, ox, oy, mirror,
    x: (px) => (mirror ? canvasW - (ox + px * s) : ox + px * s),
    y: (py) => oy + py * s,
  };
}

export function drawSkeleton(ctx, lm, view, visMin, scale = 1) {
  if (!lm) return;
  ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    const p = lm[a], q = lm[b];
    if (!p || !q || p.v < visMin * 0.6 || q.v < visMin * 0.6) continue;
    const front = FRONT_LEG.has(a) && FRONT_LEG.has(b) || (a === 23 && b === 25);
    ctx.strokeStyle = front ? COLORS.front : COLORS.bone;
    ctx.lineWidth = (front ? 7 : 5) * scale;
    ctx.beginPath();
    ctx.moveTo(view.x(p.x), view.y(p.y));
    ctx.lineTo(view.x(q.x), view.y(q.y));
    ctx.stroke();
  }
  for (const i of [0, 11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]) {
    const p = lm[i];
    if (!p || p.v < visMin * 0.6) continue;
    ctx.fillStyle = i === 0 ? COLORS.nose : FRONT_LEG.has(i) ? COLORS.front : COLORS.joint;
    ctx.beginPath();
    ctx.arc(view.x(p.x), view.y(p.y), (i === 0 ? 9 : 6) * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}

function arrow(ctx, x0, y0, x1, y1, color, w) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  const h = w * 3.2;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - h * Math.cos(a - 0.45), y1 - h * Math.sin(a - 0.45));
  ctx.lineTo(x1 - h * Math.cos(a + 0.45), y1 - h * Math.sin(a + 0.45));
  ctx.closePath(); ctx.fill();
}

/**
 * Guide lines:
 *  - Line to the bowler (blue): a line on the ground pointing straight at the
 *    camera passes through the image centre (the camera's aim point), so we
 *    draw from the image centre through your stance front-ankle and beyond.
 *  - Toe arrow (pink): heel → toe of the front foot, stretched ×2.5.
 *  - Plumb line (green): vertical from the front ankle up — your nose should
 *    be on it at the finish.
 */
export function drawGuides(ctx, frame, rep, view, srcW, srcH, visMin, scale = 1) {
  const lm = frame.lm;
  if (!lm) return;
  // line to bowler
  if (rep.ref) {
    const cx = srcW / 2, cy = srcH / 2;
    const dx = rep.ref.x - cx, dy = rep.ref.y - cy;
    if (dy > 1) {
      const t = (srcH - cy) / dy; // extend to the bottom of the image
      ctx.setLineDash([14 * scale, 10 * scale]);
      ctx.strokeStyle = COLORS.bowler; ctx.lineWidth = 4 * scale;
      ctx.beginPath();
      ctx.moveTo(view.x(rep.ref.x - dx * 0.6), view.y(rep.ref.y - dy * 0.6));
      ctx.lineTo(view.x(cx + dx * t), view.y(cy + dy * t));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  const heel = lm[LM.L_HEEL], toe = lm[LM.L_TOE], ankle = lm[LM.L_ANKLE];
  if (frame.t >= rep.landT && heel.v >= visMin && toe.v >= visMin) {
    const ex = heel.x + (toe.x - heel.x) * 2.5;
    const ey = heel.y + (toe.y - heel.y) * 2.5;
    arrow(ctx, view.x(heel.x), view.y(heel.y), view.x(ex), view.y(ey), COLORS.toe, 5 * scale);
  }
  if (frame.t >= rep.landT && ankle.v >= visMin) {
    ctx.strokeStyle = COLORS.plumb; ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.moveTo(view.x(ankle.x), view.y(ankle.y));
    ctx.lineTo(view.x(ankle.x), view.y(Math.max(0, lm[LM.NOSE].y - 40)));
    ctx.stroke();
  }
}

/**
 * Rolling buffer of small video frames (ImageBitmaps) attached to the same
 * frame objects the rep detector uses. Old bitmaps are freed (close()) unless
 * a replay is still holding them.
 */
export class ReplayBuffer {
  constructor(seconds = 4, fps = 20, width = 240) {
    this.seconds = seconds;
    this.minGap = 1 / fps;
    this.width = width;
    this.items = [];
    this.lastCapture = -1;
    this.busy = false;
    this.supported = typeof createImageBitmap === 'function';
  }
  capture(video, frame) {
    if (!this.supported || this.busy) return;
    if (frame.t - this.lastCapture < this.minGap) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    this.lastCapture = frame.t;
    this.busy = true;
    const h = Math.round((this.width * vh) / vw);
    createImageBitmap(video, { resizeWidth: this.width, resizeHeight: h, resizeQuality: 'low' })
      .then((bmp) => {
        frame.bmp = bmp;
        frame.hold = frame.hold || 0;
        this.items.push(frame);
        this._trim(frame.t);
      })
      .catch(() => { this.supported = false; })
      .finally(() => { this.busy = false; });
  }
  _trim(now) {
    while (this.items.length && now - this.items[0].t > this.seconds) {
      const f = this.items.shift();
      if (!f.hold && f.bmp) { f.bmp.close(); f.bmp = null; }
    }
  }
  hold(frames) { for (const f of frames) f.hold = (f.hold || 0) + 1; }
  release(frames) {
    for (const f of frames) {
      f.hold = Math.max(0, (f.hold || 0) - 1);
      if (!f.hold && f.bmp && !this.items.includes(f)) { f.bmp.close(); f.bmp = null; }
    }
  }
  clear() {
    for (const f of this.items) if (f.bmp && !f.hold) { f.bmp.close(); f.bmp = null; }
    this.items = [];
  }
}

/**
 * Slow-motion replay of one rep on a canvas. Plays from 0.3 s before the
 * step to the finish, holds the last frame briefly, then calls onDone.
 */
export class ReplayPlayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.raf = 0;
    this.active = false;
  }
  play({ rep, srcW, srcH, speed, visMin, buffer, onDone }) {
    this.stop();
    const frames = rep.frames.filter((f) => f.lm && f.t >= rep.startT - 0.3);
    if (!frames.length) { onDone && onDone(); return; }
    buffer && buffer.hold(frames);
    this.active = true;
    this._release = () => { buffer && buffer.release(frames); };
    this._done = () => {
      if (!this.active) return;
      this.active = false;
      cancelAnimationFrame(this.raf);
      this._release();
      this.canvas.classList.add('hidden');
      onDone && onDone();
    };
    this.canvas.classList.remove('hidden');
    const t0 = frames[0].t, t1 = frames[frames.length - 1].t;
    const dur = (t1 - t0) / speed;
    const holdEnd = 0.8;
    const start = performance.now();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let lastBmp = null;

    const tick = () => {
      if (!this.active) return;
      const cw = this.canvas.clientWidth * dpr, ch = this.canvas.clientHeight * dpr;
      if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
      const el = (performance.now() - start) / 1000;
      if (el > dur + holdEnd) { this._done(); return; }
      const tt = t0 + Math.min(el, dur) * speed;
      // frame at or just before tt
      let f = frames[0];
      for (const x of frames) { if (x.t <= tt) f = x; else break; }
      // nearest earlier frame that has a picture
      let pic = null;
      for (const x of frames) { if (x.t <= tt && x.bmp) pic = x.bmp; if (x.t > tt) break; }
      if (pic) lastBmp = pic;
      const ctx = this.ctx;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
      const view = makeView(cw, ch, srcW, srcH, true);
      if (lastBmp) {
        ctx.save();
        ctx.translate(cw, 0); ctx.scale(-1, 1); // mirror like the live view
        ctx.drawImage(lastBmp, view.ox, view.oy, view.dw, view.dh);
        ctx.restore();
      }
      drawGuides(ctx, f, rep, view, srcW, srcH, visMin, dpr);
      drawSkeleton(ctx, f.lm, view, visMin, dpr);
      // label
      // label sits above the bottom button bar
      const by = ch - 120 * dpr;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, by, cw, 44 * dpr);
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${19 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      const phase = f.t < rep.startT ? 'Stance' : f.t < rep.landT ? 'Step' : 'Landed / finish';
      ctx.fillText(`REPLAY ${Math.round(speed * 100)}% · ${phase} · tap to skip`, cw / 2, by + 29 * dpr);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  skip() { if (this.active) this._done(); }
  /** Stop without calling onDone (used when leaving the screen). */
  stop() {
    if (!this.active) return;
    this.active = false;
    cancelAnimationFrame(this.raf);
    this._release && this._release();
    this.canvas.classList.add('hidden');
  }
}
