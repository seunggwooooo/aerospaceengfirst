// PCB connectivity, ratsnest and design-rule checks.
import { shapeDist, shapeCenter, pointInPoly, segSegDist } from './draw.js';

export const DEFAULT_RULES = { clearance: 0.2, trackWidth: 0.2, viaSize: 0.5, viaDrill: 0.3, annular: 0.1, edge: 0.3 };

export const RULE_LABELS = {
  clearance: '최소 간격', trackWidth: '최소 배선 폭', viaSize: '최소 비아 지름',
  viaDrill: '최소 비아 드릴', annular: '최소 애뉼러 링', edge: '보드 외곽 간격',
};

const CELL = 2.5;
const MAX_VIOLATIONS = 400;
const EPS = 1e-4;

function bbOf(s, m) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < s.pts.length; i += 2) {
    const x = s.pts[i], y = s.pts[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const r = s.r + m;
  return [x0 - r, y0 - r, x1 + r, y1 + r];
}

function shareLayer(a, b) {
  if (a.layers === '*' || b.layers === '*') return true;
  for (const l of a.layers) if (b.layers.has(l)) return true;
  return false;
}

function label(s) {
  const it = s.it;
  if (it.k === 'fp') return (it.ref || '?') + ' 패드 ' + s.pad;
  if (it.k === 'pad') return '패드 ' + s.pad;
  if (it.k === 'via') return '비아';
  return '배선';
}

// Edges of a filled polygon bucketed into horizontal strips, so a shape only
// looks at the few edges near it (fills can have many thousands of points).
const STRIP = 1.0;
function fillIndex(f) {
  if (f._idx) return f._idx;
  const pts = f.pts;
  const strips = new Map();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const ax = pts[j], ay = pts[j + 1], bx = pts[i], by = pts[i + 1];
    if (ax < x0) x0 = ax; if (ax > x1) x1 = ax;
    if (ay < y0) y0 = ay; if (ay > y1) y1 = ay;
    const s0 = Math.floor(Math.min(ay, by) / STRIP), s1 = Math.floor(Math.max(ay, by) / STRIP);
    for (let st = s0; st <= s1; st++) {
      let row = strips.get(st);
      if (!row) strips.set(st, (row = []));
      row.push(ax, ay, bx, by);
    }
  }
  return (f._idx = { strips, bb: [x0, y0, x1, y1] });
}

// True when copper shape `s` overlaps the filled polygon (inside it, or reached by
// its outline — thermal-relief spokes end inside the pad).
function touchesFill(s, sb, f) {
  const idx = fillIndex(f);
  const b = idx.bb;
  if (sb[0] > b[2] || b[0] > sb[2] || sb[1] > b[3] || b[1] > sb[3]) return false;
  const px = s.pts[0], py = s.pts[1];
  let row = idx.strips.get(Math.floor(py / STRIP));
  if (row) {
    let inside = false;
    for (let k = 0; k < row.length; k += 4) {
      const ay = row[k + 1], by = row[k + 3];
      if ((ay > py) !== (by > py) && px < ((row[k + 2] - row[k]) * (py - ay)) / (by - ay) + row[k]) inside = !inside;
    }
    if (inside) return true;
  }
  const np = s.pts.length >> 1;
  const edges = np >= 3 ? np : Math.max(1, np - 1);
  const lim = s.r + 0.005;
  for (let st = Math.floor(sb[1] / STRIP); st <= Math.floor(sb[3] / STRIP); st++) {
    row = idx.strips.get(st);
    if (!row) continue;
    for (let k = 0; k < row.length; k += 4) {
      const ax = row[k], ay = row[k + 1], bx = row[k + 2], by = row[k + 3];
      if ((ax < sb[0] && bx < sb[0]) || (ax > sb[2] && bx > sb[2]) || (ay < sb[1] && by < sb[1]) || (ay > sb[3] && by > sb[3])) continue;
      for (let e = 0; e < edges; e++) {
        const e2 = (e + 1) % np;
        if (segSegDist(ax, ay, bx, by, s.pts[2 * e], s.pts[2 * e + 1], s.pts[2 * e2], s.pts[2 * e2 + 1]) <= lim) return true;
      }
    }
  }
  return false;
}

// Board outline pieces as zero-width shapes.
export function edgeShapes(doc, fine) {
  const out = [];
  const seg = (x1, y1, x2, y2, it) => out.push({ it, edge: true, layers: '*', pts: [x1, y1, x2, y2], r: 0, net: null });
  for (const it of doc.items) {
    if (it.k !== 'gr' || it.layer !== 'Edge.Cuts') continue;
    for (const p of it.prims) {
      if (p.t === 'L') seg(p.x1, p.y1, p.x2, p.y2, it);
      else if (p.t === 'P') {
        const n = p.pts.length >> 1;
        for (let i = 0; i < (p.closed ? n : n - 1); i++) { const j = (i + 1) % n; seg(p.pts[2 * i], p.pts[2 * i + 1], p.pts[2 * j], p.pts[2 * j + 1], it); }
      } else if (p.t === 'C' || p.t === 'A') {
        const tau = Math.PI * 2;
        let a0 = 0, span = tau, dir = 1;
        if (p.t === 'A') { a0 = p.a0; dir = p.ccw ? -1 : 1; span = p.ccw ? p.a0 - p.a1 : p.a1 - p.a0; span = ((span % tau) + tau) % tau; }
        const steps = Math.max(4, Math.ceil(span / (fine ? 0.1 : 0.26)));
        let px = p.cx + p.r * Math.cos(a0), py = p.cy + p.r * Math.sin(a0);
        for (let i = 1; i <= steps; i++) {
          const a = a0 + dir * span * i / steps;
          const qx = p.cx + p.r * Math.cos(a), qy = p.cy + p.r * Math.sin(a);
          seg(px, py, qx, qy, it);
          px = qx; py = qy;
        }
      }
    }
  }
  return out;
}

export function analyze(doc, rules) {
  const R = { ...DEFAULT_RULES, ...rules };
  const t0 = Date.now();
  const shapes = [];
  const zones = [];
  for (const it of doc.items) {
    if (it.k === 'zone') { if (it.net) zones.push(it); continue; }
    if (!it.cu) continue;
    for (const s of it.cu) { s.it = it; shapes.push(s); }
  }
  const nCopper = shapes.length;
  for (const s of edgeShapes(doc)) shapes.push(s);
  const n = shapes.length;

  // union-find over copper shapes (+ one node per zone)
  const parent = new Int32Array(nCopper + zones.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };

  const violations = [];
  const push = (v) => { if (violations.length < MAX_VIOLATIONS) violations.push(v); };
  const margin = Math.max(R.clearance, R.edge);

  // pieces of one arc belong together
  let prev = null, prevI = -1;
  for (let i = 0; i < nCopper; i++) {
    const s = shapes[i];
    s.i = i;
    s.minGap = Infinity;
    if (prev && prev.it === s.it && s.it.k === 'arc') union(i, prevI);
    prev = s; prevI = i;
  }

  // uniform grid
  const grid = new Map();
  const bbs = new Array(n);
  for (let i = 0; i < n; i++) {
    const bb = bbs[i] = bbOf(shapes[i], margin / 2);
    const cx0 = Math.floor(bb[0] / CELL), cx1 = Math.floor(bb[2] / CELL), cy0 = Math.floor(bb[1] / CELL), cy1 = Math.floor(bb[3] / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const key = cx * 100003 + cy;
      let arr = grid.get(key);
      if (!arr) grid.set(key, (arr = []));
      arr.push(i);
    }
  }
  const stamp = new Int32Array(n).fill(-1);
  for (const arr of grid.values()) {
    for (let x = 0; x < arr.length; x++) {
      const i = arr[x];
      const a = shapes[i];
      const ba = bbs[i];
      for (let y = x + 1; y < arr.length; y++) {
        const j = arr[y];
        const b = shapes[j];
        if (a.edge && b.edge) continue;
        const bb = bbs[j];
        if (ba[0] > bb[2] || bb[0] > ba[2] || ba[1] > bb[3] || bb[1] > ba[3]) continue;
        // each pair once: only in the cell holding the top-left of their overlap
        const ox = Math.max(ba[0], bb[0]), oy = Math.max(ba[1], bb[1]);
        if (grid.get(Math.floor(ox / CELL) * 100003 + Math.floor(oy / CELL)) !== arr) continue;
        if (!shareLayer(a, b)) continue;
        const edge = a.edge || b.edge;
        if (!edge && a.it === b.it && a.it.k !== 'fp') continue;
        if (!edge && a.net && a.net === b.net) {
          if (shapeDist(a, b) <= 1e-6) union(i, j);
          continue;
        }
        if (!edge && !a.net && !b.net) continue;
        const d = shapeDist(a, b);
        const cu = a.edge ? b : a;
        if (edge) {
          if (d < R.edge - EPS) {
            const c = shapeCenter(cu);
            push({ type: 'edge', sev: 'error', x: c[0], y: c[1], items: [cu.it], msg: `보드 외곽과 간격 ${Math.max(d, 0).toFixed(3)} mm < ${R.edge} mm — ${label(cu)}${cu.net ? ' (' + cu.net + ')' : ''}` });
          }
          continue;
        }
        if (d < a.minGap) a.minGap = d;
        if (d < b.minGap) b.minGap = d;
        if (d < R.clearance - EPS) {
          const ca = shapeCenter(a), cb = shapeCenter(b);
          const short = d <= 1e-6;
          push({ type: short ? 'short' : 'clearance', sev: 'error', x: (ca[0] + cb[0]) / 2, y: (ca[1] + cb[1]) / 2, items: [a.it, b.it],
            msg: short
              ? `단락: ${label(a)} (${a.net || '네트 없음'}) ↔ ${label(b)} (${b.net || '네트 없음'})`
              : `간격 ${d.toFixed(3)} mm < ${R.clearance} mm: ${label(a)} (${a.net || '네트 없음'}) ↔ ${label(b)} (${b.net || '네트 없음'})` });
        }
      }
    }
  }

  const tight = new Array(nCopper);
  // zone fills connect same-net copper lying inside them
  let unfilled = 0;
  zones.forEach((z, zi) => {
    const fills = z.prims.filter((p) => p.zf);
    if (!fills.length) { unfilled++; return; }
    const node = nCopper + zi;
    for (let i = 0; i < nCopper; i++) {
      const s = shapes[i];
      if (s.net !== z.net) continue;
      for (let k = 0; k < fills.length; k++) {
        const f = fills[k];
        if (s.layers !== '*' && !s.layers.has(f.layer)) continue;
        if (touchesFill(s, tight[i] || (tight[i] = bbOf(s, 0.01)), f)) { union(i, node); break; }
      }
    }
  });

  // copper of another net lying on a (stale) zone fill: the pour was computed before this copper was there
  const seenZone = new Set();
  for (const z of zones) {
    for (const f of z.prims) {
      if (!f.zf) continue;
      for (let i = 0; i < nCopper; i++) {
        const s = shapes[i];
        if (s.net === z.net) continue;
        if (s.layers !== '*' && !s.layers.has(f.layer)) continue;
        if (seenZone.has(s.it) && s.it.k !== 'fp') continue;
        if (!touchesFill(s, tight[i] || (tight[i] = bbOf(s, 0.01)), f)) continue;
        seenZone.add(s.it);
        const c = shapeCenter(s);
        push({ type: 'zone', sev: 'warn', x: c[0], y: c[1], items: [s.it],
          msg: `구리 채움(${z.net})과 겹침: ${label(s)} (${s.net || '네트 없음'}) — KiCad에서 영역을 다시 채우면(B) 피해서 깔립니다` });
      }
    }
  }

  // widths, vias
  for (const it of doc.items) {
    if ((it.k === 'seg' || it.k === 'arc') && it.w < R.trackWidth - EPS) {
      const c = shapeCenter(it.cu[0]);
      push({ type: 'width', sev: 'error', x: c[0], y: c[1], items: [it], msg: `배선 폭 ${it.w} mm < ${R.trackWidth} mm${it.net ? ' (' + it.net + ')' : ''}` });
    } else if (it.k === 'via') {
      const ring = (it.size - it.drill) / 2;
      if (it.size < R.viaSize - EPS) push({ type: 'via', sev: 'error', x: it.x, y: it.y, items: [it], msg: `비아 지름 ${it.size} mm < ${R.viaSize} mm` });
      if (it.drill < R.viaDrill - EPS) push({ type: 'via', sev: 'error', x: it.x, y: it.y, items: [it], msg: `비아 드릴 ${it.drill} mm < ${R.viaDrill} mm` });
      if (ring < R.annular - EPS) push({ type: 'via', sev: 'error', x: it.x, y: it.y, items: [it], msg: `애뉼러 링 ${ring.toFixed(3)} mm < ${R.annular} mm` });
    }
  }

  // ratsnest: per net, join the groups of connected pads with shortest links
  const byNet = new Map();
  for (let i = 0; i < nCopper; i++) {
    const s = shapes[i];
    if (s.pad === undefined || !s.net) continue;
    let arr = byNet.get(s.net);
    if (!arr) byNet.set(s.net, (arr = []));
    arr.push(s);
  }
  const ratsnest = [];
  let unconnected = 0;
  for (const [net, pads] of byNet) {
    const groups = new Map();
    for (const s of pads) {
      const root = find(s.i);
      let g = groups.get(root);
      if (!g) groups.set(root, (g = []));
      const c = shapeCenter(s);
      g.push({ s, x: c[0], y: c[1] });
    }
    if (groups.size < 2) continue;
    const comps = [...groups.values()];
    const done = [comps.shift()];
    while (comps.length) {
      let best = null;
      for (const g of done) for (const p of g) {
        for (let ci = 0; ci < comps.length; ci++) for (const q of comps[ci]) {
          const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
          if (!best || d < best.d) best = { d, p, q, ci };
        }
      }
      ratsnest.push([best.p.x, best.p.y, best.q.x, best.q.y, net]);
      unconnected++;
      push({ type: 'unconnected', sev: 'warn', x: (best.p.x + best.q.x) / 2, y: (best.p.y + best.q.y) / 2, items: [best.p.s.it, best.q.s.it],
        msg: `미연결 (${net}): ${label(best.p.s)} ↔ ${label(best.q.s)}` });
      done.push(comps.splice(best.ci, 1)[0]);
    }
  }

  // per-item nearest foreign copper
  const gap = new Map();
  for (let i = 0; i < nCopper; i++) {
    const s = shapes[i];
    const g = gap.get(s.it);
    if (g === undefined || s.minGap < g) gap.set(s.it, s.minGap);
  }
  const order = { short: 0, clearance: 1, edge: 2, width: 3, via: 4, zone: 5, unconnected: 6 };
  violations.sort((a, b) => order[a.type] - order[b.type]);
  return { kind: 'drc', rules: R, violations, ratsnest, unconnected, gap, unfilledZones: unfilled, truncated: violations.length >= MAX_VIOLATIONS,
    errors: violations.filter((v) => v.sev === 'error').length, shapes: nCopper, ms: Date.now() - t0, rev: doc.rev || 0 };
}
