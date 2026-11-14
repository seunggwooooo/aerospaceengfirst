// Shared geometry + canvas drawing for primitives in world (mm) coordinates.
//
// Primitive kinds (field `t`):
//   L line    x1 y1 x2 y2 w
//   A arc     cx cy r a0 a1 ccw w
//   C circle  cx cy r w fill
//   P poly    pts[x0,y0,x1,y1...] w fill closed
//   R pad     x y ang w h rr          (filled rounded rectangle, ang in degrees)
//   T text    x y ang text h hj vj mirror bold italic
// Optional on any: color, fillColor, alpha, dash.

export const DEG = Math.PI / 180;

export function arcFrom3(sx, sy, mx, my, ex, ey) {
  const d = 2 * (sx * (my - ey) + mx * (ey - sy) + ex * (sy - my));
  if (Math.abs(d) < 1e-9) return null;
  const s2 = sx * sx + sy * sy;
  const m2 = mx * mx + my * my;
  const e2 = ex * ex + ey * ey;
  const cx = (s2 * (my - ey) + m2 * (ey - sy) + e2 * (sy - my)) / d;
  const cy = (s2 * (ex - mx) + m2 * (sx - ex) + e2 * (mx - sx)) / d;
  const r = Math.hypot(sx - cx, sy - cy);
  const a0 = Math.atan2(sy - cy, sx - cx);
  const a1 = Math.atan2(ey - cy, ex - cx);
  const cross = (mx - sx) * (ey - my) - (my - sy) * (ex - mx);
  return { cx, cy, r, a0, a1, ccw: cross < 0 };
}

export function bezierPts(p, steps = 16) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push(a * p[0] + b * p[2] + c * p[4] + d * p[6], a * p[1] + b * p[3] + c * p[5] + d * p[7]);
  }
  return out;
}

export function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function angleOnArc(a, p) {
  const tau = Math.PI * 2;
  const norm = (v) => ((v % tau) + tau) % tau;
  const span = p.ccw ? norm(p.a0 - p.a1) : norm(p.a1 - p.a0);
  const off = p.ccw ? norm(p.a0 - a) : norm(a - p.a0);
  return off <= span;
}

export function textSize(p) {
  const lines = String(p.text).split('\n');
  let len = 0;
  for (const l of lines) len = Math.max(len, l.length);
  return { w: len * p.h * 0.82, h: lines.length * p.h * 1.6 };
}

function textLocal(px, py, p) {
  const a = p.ang * DEG;
  const dx = px - p.x, dy = py - p.y;
  let lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  if (p.mirror) lx = -lx;
  return [lx, ly];
}

// Distance from a point to a primitive (0 when inside a filled shape).
export function primDist(px, py, p) {
  switch (p.t) {
    case 'L': return Math.max(0, distToSeg(px, py, p.x1, p.y1, p.x2, p.y2) - p.w / 2);
    case 'C': {
      const d = Math.hypot(px - p.cx, py - p.cy);
      return p.fill ? Math.max(0, d - p.r) : Math.max(0, Math.abs(d - p.r) - p.w / 2);
    }
    case 'A': {
      const a = Math.atan2(py - p.cy, px - p.cx);
      if (angleOnArc(a, p)) return Math.max(0, Math.abs(Math.hypot(px - p.cx, py - p.cy) - p.r) - p.w / 2);
      return Math.min(
        Math.hypot(px - (p.cx + p.r * Math.cos(p.a0)), py - (p.cy + p.r * Math.sin(p.a0))),
        Math.hypot(px - (p.cx + p.r * Math.cos(p.a1)), py - (p.cy + p.r * Math.sin(p.a1))),
      );
    }
    case 'P': {
      const pts = p.pts;
      if (p.fill && pointInPoly(px, py, pts)) return 0;
      let d = Infinity;
      for (let i = 0; i + 3 < pts.length; i += 2) d = Math.min(d, distToSeg(px, py, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]));
      if (p.closed && pts.length >= 4) d = Math.min(d, distToSeg(px, py, pts[pts.length - 2], pts[pts.length - 1], pts[0], pts[1]));
      return Math.max(0, d - (p.w || 0) / 2);
    }
    case 'R': {
      const a = p.ang * DEG;
      const dx = px - p.x, dy = py - p.y;
      const lx = Math.abs(dx * Math.cos(a) - dy * Math.sin(a)) - p.w / 2;
      const ly = Math.abs(dx * Math.sin(a) + dy * Math.cos(a)) - p.h / 2;
      return Math.max(0, lx, ly);
    }
    case 'T': {
      const [lx, ly] = textLocal(px, py, p);
      const s = textSize(p);
      const x0 = p.hj === 'l' ? 0 : p.hj === 'r' ? -s.w : -s.w / 2;
      const y0 = p.vj === 't' ? 0 : p.vj === 'b' ? -s.h : -s.h / 2;
      return Math.max(0, x0 - lx, lx - (x0 + s.w), y0 - ly, ly - (y0 + s.h));
    }
  }
  return Infinity;
}

export function primBounds(p, bb) {
  const add = (x, y, m = 0) => {
    if (x - m < bb[0]) bb[0] = x - m;
    if (y - m < bb[1]) bb[1] = y - m;
    if (x + m > bb[2]) bb[2] = x + m;
    if (y + m > bb[3]) bb[3] = y + m;
  };
  switch (p.t) {
    case 'L': add(p.x1, p.y1, p.w / 2); add(p.x2, p.y2, p.w / 2); break;
    case 'C': case 'A': add(p.cx, p.cy, p.r + (p.w || 0) / 2); break;
    case 'P': for (let i = 0; i < p.pts.length; i += 2) add(p.pts[i], p.pts[i + 1]); break;
    case 'R': add(p.x, p.y, Math.hypot(p.w, p.h) / 2); break;
    case 'T': add(p.x, p.y, p.h); break;
  }
  return bb;
}

export const emptyBounds = () => [Infinity, Infinity, -Infinity, -Infinity];

function roundRectPath(ctx, w, h, r) {
  const x = -w / 2, y = -h / 2;
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0) { ctx.rect(x, y, w, h); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const FONT = '"Helvetica Neue", Helvetica, Arial, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

export function drawText(ctx, view, p, color, force) {
  const px = p.h * 1.38 * view.k;
  if (px < 2.2) return;
  const dpr = view.dpr;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(p.x * view.k + view.tx, p.y * view.k + view.ty);
  if (p.ang) ctx.rotate(-p.ang * DEG);
  if (p.mirror || p.sx) ctx.scale((p.mirror ? -1 : 1) * (p.sx || 1), 1);
  ctx.font = (p.italic ? 'italic ' : '') + (p.bold ? '600 ' : '') + px + 'px ' + FONT;
  ctx.fillStyle = force ? color : (p.color || color);
  ctx.textAlign = p.hj === 'l' ? 'left' : p.hj === 'r' ? 'right' : 'center';
  let text = String(p.text);
  if (text.indexOf('{') >= 0) text = text.replace(/\{slash\}/g, '/').replace(/\{backslash\}/g, '\\').replace(/\{space\}/g, ' ');
  if (text.indexOf('\n') < 0) {
    ctx.textBaseline = p.vj === 't' ? 'top' : p.vj === 'b' ? 'alphabetic' : 'middle';
    ctx.fillText(text, 0, p.vj === 'b' ? -px * 0.12 : 0);
  } else {
    const lines = text.split('\n');
    const lh = p.h * 1.62 * view.k;
    const total = lh * lines.length;
    let y0 = p.vj === 't' ? 0 : p.vj === 'b' ? -total : -total / 2;
    ctx.textBaseline = 'middle';
    for (const l of lines) { ctx.fillText(l, 0, y0 + lh / 2); y0 += lh; }
  }
  ctx.restore();
}

// Draw primitives. ctx must already carry the world transform.
// `color` is the default stroke/fill; opts.filter(p) can skip primitives.
export function drawPrims(ctx, view, prims, color, opts) {
  const minW = 1 / view.k;
  const filter = opts && opts.filter;
  const texts = [];
  let curW = -1;
  let curColor = null;
  let open = false;
  const flush = () => { if (open) { ctx.stroke(); open = false; } };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  curColor = color;
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    if (filter && !filter(p)) continue;
    if (p.t === 'T') { texts.push(p); continue; }
    const col = (opts && opts.force) ? color : (p.color || color);
    if (p.t === 'L' && !p.dash) {
      const w = p.w > minW ? p.w : minW;
      if (w !== curW || col !== curColor || !open) {
        flush();
        ctx.beginPath();
        ctx.lineWidth = w;
        ctx.strokeStyle = col;
        curW = w; curColor = col; open = true;
      }
      ctx.moveTo(p.x1, p.y1);
      ctx.lineTo(p.x2, p.y2);
      continue;
    }
    flush();
    curW = -1;
    const fillCol = (opts && opts.force) ? color : (p.fillColor || col);
    ctx.strokeStyle = col;
    ctx.fillStyle = fillCol;
    ctx.lineWidth = Math.max(p.w || 0, minW);
    if (p.dash) ctx.setLineDash([p.dash, p.dash]);
    switch (p.t) {
      case 'L':
        ctx.beginPath(); ctx.moveTo(p.x1, p.y1); ctx.lineTo(p.x2, p.y2); ctx.stroke();
        break;
      case 'A':
        ctx.beginPath(); ctx.arc(p.cx, p.cy, p.r, p.a0, p.a1, p.ccw); ctx.stroke();
        break;
      case 'C':
        ctx.beginPath(); ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
        if (p.fill) ctx.fill();
        if (p.w > 0 || !p.fill) ctx.stroke();
        break;
      case 'P': {
        const pts = p.pts;
        if (pts.length < 4) break;
        ctx.beginPath();
        ctx.moveTo(pts[0], pts[1]);
        for (let j = 2; j < pts.length; j += 2) ctx.lineTo(pts[j], pts[j + 1]);
        if (p.closed) ctx.closePath();
        if (p.fill) {
          if (p.alpha != null) { const ga = ctx.globalAlpha; ctx.globalAlpha = ga * p.alpha; ctx.fill(); ctx.globalAlpha = ga; }
          else ctx.fill();
        }
        if (p.w > 0 || !p.fill) ctx.stroke();
        break;
      }
      case 'R':
        ctx.save();
        ctx.translate(p.x, p.y);
        if (p.ang) ctx.rotate(-p.ang * DEG);
        ctx.beginPath();
        roundRectPath(ctx, p.w, p.h, p.rr);
        ctx.fill();
        ctx.restore();
        break;
    }
    if (p.dash) ctx.setLineDash([]);
  }
  flush();
  for (const p of texts) drawText(ctx, view, p, color, opts && opts.force);
}

export function snap(v, g) { return g > 0 ? Math.round(v / g) * g : v; }

let mctx = null;
const mcache = new Map();
// Width of a single-line string drawn at text height h (mm).
export function measure(text, h) {
  let w = mcache.get(text);
  if (w === undefined) {
    if (!mctx && typeof document !== 'undefined') {
      mctx = document.createElement('canvas').getContext('2d');
      mctx.font = '100px ' + FONT;
    }
    w = mctx ? mctx.measureText(text).width / 100 : text.length * 0.58;
    if (mcache.size > 5000) mcache.clear();
    mcache.set(text, w);
  }
  return w * h * 1.38;
}

// ---------- shape distance (used by snapping, connectivity and DRC) ----------
// A copper shape is a point / segment / convex polygon `pts` inflated by radius `r`.

function segsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

export function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(distToSeg(ax, ay, cx, cy, dx, dy), distToSeg(bx, by, cx, cy, dx, dy),
    distToSeg(cx, cy, ax, ay, bx, by), distToSeg(dx, dy, ax, ay, bx, by));
}

// Minimum distance between two point lists read as point / segment / closed polygon.
export function polyDist(P, Q) {
  const np = P.length >> 1, nq = Q.length >> 1;
  if (np >= 3 && pointInPoly(Q[0], Q[1], P)) return 0;
  if (nq >= 3 && pointInPoly(P[0], P[1], Q)) return 0;
  const ep = np >= 3 ? np : Math.max(1, np - 1);
  const eq = nq >= 3 ? nq : Math.max(1, nq - 1);
  let best = Infinity;
  for (let i = 0; i < ep; i++) {
    const i2 = (i + 1) % np;
    const ax = P[2 * i], ay = P[2 * i + 1], bx = P[2 * i2], by = P[2 * i2 + 1];
    for (let j = 0; j < eq; j++) {
      const j2 = (j + 1) % nq;
      const d = segSegDist(ax, ay, bx, by, Q[2 * j], Q[2 * j + 1], Q[2 * j2], Q[2 * j2 + 1]);
      if (d < best) { best = d; if (d === 0) return 0; }
    }
  }
  return best;
}

export function shapeDist(a, b) { return polyDist(a.pts, b.pts) - a.r - b.r; }
export function shapePointDist(s, x, y) { return polyDist(s.pts, [x, y]) - s.r; }
export function shapeCenter(s) {
  let x = 0, y = 0;
  const n = s.pts.length >> 1;
  for (let i = 0; i < n; i++) { x += s.pts[2 * i]; y += s.pts[2 * i + 1]; }
  return [x / n, y / n];
}
