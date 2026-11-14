// .kicad_pcb / .kicad_mod document: extraction, rendering, hit-testing, edits.
import { child, children, str, num, hasAtom, isHidden, ptsOf, setNum, setStr, setRaw, remove, quote } from './sexpr.js';
import { DEG, arcFrom3, bezierPts, primDist, primBounds, emptyBounds, drawPrims } from './draw.js';

const COLORS = {
  'F.Cu': '#c83434', 'B.Cu': '#4d7fc4', 'In1.Cu': '#7fc87f', 'In2.Cu': '#ce7d2c',
  'In3.Cu': '#4fcbcb', 'In4.Cu': '#db628b', 'In5.Cu': '#a7a5c6', 'In6.Cu': '#28ccd9',
  'F.SilkS': '#f2eda1', 'B.SilkS': '#e8b2a7', 'F.Mask': '#d864ff', 'B.Mask': '#02ffee',
  'F.Paste': '#b4a09a', 'B.Paste': '#00c2c2', 'F.Adhes': '#840084', 'B.Adhes': '#000084',
  'F.Fab': '#afafaf', 'B.Fab': '#585d84', 'F.CrtYd': '#ff26e2', 'B.CrtYd': '#26e9ff',
  'Edge.Cuts': '#d0d2cd', 'Margin': '#ff26e2', 'Dwgs.User': '#c2c2c2', 'Cmts.User': '#5994dc',
  'Eco1.User': '#b4dbd2', 'Eco2.User': '#d8c852',
  '@TH': '#e3b72e', '@Via': '#ececec', '@Holes': '#1b1d22',
};
const EXTRA = ['#5fa8a1', '#b98bd6', '#8fb35c', '#d69a6a', '#7f9bd8', '#cf7a9b'];
const BACKGROUND = '#001023';

const DEFAULT_LAYERS = ['F.Cu', 'B.Cu', 'F.Adhes', 'B.Adhes', 'F.Paste', 'B.Paste', 'F.SilkS', 'B.SilkS',
  'F.Mask', 'B.Mask', 'Dwgs.User', 'Cmts.User', 'Eco1.User', 'Eco2.User', 'Edge.Cuts', 'Margin',
  'F.CrtYd', 'B.CrtYd', 'F.Fab', 'B.Fab'];

function zRank(name) {
  const fixed = ['B.CrtYd', 'B.Fab', 'B.Adhes', 'B.Paste', 'B.Mask', 'B.SilkS', 'B.Cu'];
  const top = ['F.Cu', 'F.Mask', 'F.Paste', 'F.Adhes', 'F.SilkS', 'F.Fab', 'F.CrtYd', 'Dwgs.User', 'Cmts.User',
    'Eco1.User', 'Eco2.User', 'Margin', 'Edge.Cuts'];
  let i = fixed.indexOf(name);
  if (i >= 0) return i;
  const m = /^In(\d+)\.Cu$/.exec(name);
  if (m) return 100 - parseInt(m[1], 10) * 0.01;
  i = top.indexOf(name);
  if (i >= 0) return 200 + i;
  return 150; // user layers between copper stacks and the top
}

const normAng = (a) => { a = ((a % 360) + 360) % 360; return a; };
const upright = (a) => { a = normAng(a); if (a > 90 && a <= 270) a -= 180; return a; };

function strokeW(c) {
  const st = child(c, 'stroke');
  if (st) return num(child(st, 'width'), 1, 0);
  return num(child(c, 'width'), 1, 0);
}

function isFilled(c) {
  const f = child(c, 'fill');
  if (!f) return false;
  const v = str(f);
  if (v === 'solid' || v === 'yes') return true;
  const t = child(f, 'type');
  return t ? str(t) === 'solid' : false;
}

function netOf(n, netNames) {
  const c = child(n, 'net');
  if (!c) return null;
  if (c.items.length >= 3) return str(c, 2);
  const a = c.items[1];
  if (!a) return null;
  if (a.q) return str(c, 1);
  return netNames.get(a.raw) ?? ('net ' + a.raw);
}

function textPrim(c, textIdx, T, vars) {
  const at = child(c, 'at');
  if (!at) return null;
  const layerNode = child(c, 'layer');
  if (!layerNode) return null;
  const fx = child(c, 'effects');
  const font = child(fx, 'font');
  const size = child(font, 'size');
  const just = child(fx, 'justify');
  let text = str(c, textIdx) ?? '';
  if (vars && text.indexOf('${') >= 0) text = text.replace(/\$\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  const [x, y] = T(num(at, 1), num(at, 2));
  return {
    t: 'T', layer: str(layerNode), x, y, ang: upright(num(at, 3)), text,
    h: size ? num(size, 1, 1) : 1,
    sx: size && num(size, 1) > 0 && num(size, 2) > 0 ? Math.min(2, Math.max(0.5, num(size, 2) / num(size, 1))) : 1,
    hj: hasAtom(just, 'left') ? 'l' : hasAtom(just, 'right') ? 'r' : 'c',
    vj: hasAtom(just, 'top') ? 't' : hasAtom(just, 'bottom') ? 'b' : 'c',
    mirror: hasAtom(just, 'mirror') || (just && str(child(just, 'mirror')) === 'yes') || false,
    bold: hasAtom(font, 'bold') || str(child(font, 'bold')) === 'yes',
    italic: hasAtom(font, 'italic') || str(child(font, 'italic')) === 'yes',
  };
}

// Graphic shape (gr_* / fp_*) -> primitives through transform T.
function graphicPrims(c, T, out, layerOverride) {
  const shape = c.h.replace(/^(gr|fp)_/, '');
  const layer = layerOverride || str(child(c, 'layer'));
  if (!layer) return;
  const w = strokeW(c);
  const fill = isFilled(c);
  const P = (h) => { const p = child(c, h); return p ? T(num(p, 1), num(p, 2)) : null; };
  if (shape === 'line') {
    const a = P('start'), b = P('end');
    if (a && b) out.push({ t: 'L', layer, x1: a[0], y1: a[1], x2: b[0], y2: b[1], w });
  } else if (shape === 'rect') {
    const s = child(c, 'start'), e = child(c, 'end');
    if (!s || !e) return;
    const x1 = num(s, 1), y1 = num(s, 2), x2 = num(e, 1), y2 = num(e, 2);
    const pts = [...T(x1, y1), ...T(x2, y1), ...T(x2, y2), ...T(x1, y2)];
    out.push({ t: 'P', layer, pts, w, fill, closed: true });
  } else if (shape === 'circle') {
    const ce = P('center'), e = P('end');
    if (ce && e) out.push({ t: 'C', layer, cx: ce[0], cy: ce[1], r: Math.hypot(e[0] - ce[0], e[1] - ce[1]), w, fill });
  } else if (shape === 'arc') {
    const s = P('start'), m = P('mid'), e = P('end');
    if (s && m && e) {
      const a = arcFrom3(s[0], s[1], m[0], m[1], e[0], e[1]);
      if (a) out.push({ t: 'A', layer, ...a, w });
      else out.push({ t: 'L', layer, x1: s[0], y1: s[1], x2: e[0], y2: e[1], w });
    }
  } else if (shape === 'poly') {
    const raw = ptsOf(c);
    const pts = [];
    for (let i = 0; i < raw.length; i += 2) pts.push(...T(raw[i], raw[i + 1]));
    out.push({ t: 'P', layer, pts, w, fill, closed: true });
  } else if (shape === 'curve') {
    const raw = ptsOf(c);
    if (raw.length >= 8) {
      const b = bezierPts(raw);
      const pts = [];
      for (let i = 0; i < b.length; i += 2) pts.push(...T(b[i], b[i + 1]));
      out.push({ t: 'P', layer, pts, w, fill: false, closed: false });
    }
  }
}

function expandLayers(list, all) {
  const out = new Set();
  for (const l of list) {
    if (l.indexOf('*') >= 0) {
      const suffix = l.slice(1);
      for (const a of all) if (a.endsWith(suffix)) out.add(a);
    } else if (l.startsWith('F&B.')) {
      out.add('F.' + l.slice(4)); out.add('B.' + l.slice(4));
    } else out.add(l);
  }
  return out;
}

const ident = (x, y) => [x, y];

export class PcbDoc {
  constructor(root) {
    this.kind = 'pcb';
    this.root = root;
    this.isFootprintFile = root.h !== 'kicad_pcb';
    this.background = BACKGROUND;
    this.gridOptions = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 1.27, 2.54];
    this.grid = 0.1;
    this.digits = 6;
    this.showZoneFill = true;
    this.hlNet = null;
    this.netNames = new Map();
    this.items = [];
    this._buckets = null;

    const names = [];
    const ln = child(root, 'layers');
    if (ln && !this.isFootprintFile) for (const l of ln.items) if (l.t === 'l') names.push(str(l, 1));
    if (!names.length) names.push(...DEFAULT_LAYERS);
    this.layerNames = names;
    let extra = 0;
    const saved = PcbDoc.savedVisibility || {};
    this.layers = names.map((name) => ({
      name,
      color: COLORS[name] || EXTRA[extra++ % EXTRA.length],
      visible: saved[name] !== undefined ? saved[name] : !/\.(Mask|Paste|Adhes|Fab)$/.test(name),
    })).sort((a, b) => zRank(b.name) - zRank(a.name));
    this.copper = names.filter((n) => n.endsWith('.Cu'));

    if (this.isFootprintFile) {
      this.items.push(this.build(root));
    } else {
      for (const c of root.items) {
        if (c.t !== 'l') continue;
        if (c.h === 'net') { if (c.items.length >= 3) this.netNames.set(c.items[1].raw, str(c, 2)); continue; }
        const it = this.build(c);
        if (it) this.items.push(it);
      }
    }
  }

  // ---------- extraction ----------

  build(n) {
    switch (n.h) {
      case 'footprint': case 'module': return this.buildFp(n);
      case 'segment': {
        const s = child(n, 'start'), e = child(n, 'end');
        if (!s || !e) return null;
        const it = { k: 'seg', n, layer: str(child(n, 'layer')), net: netOf(n, this.netNames), w: num(child(n, 'width'), 1, 0.2),
          x1: num(s, 1), y1: num(s, 2), x2: num(e, 1), y2: num(e, 2) };
        it.prims = [{ t: 'L', layer: it.layer, x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2, w: it.w, net: it.net }];
        return it;
      }
      case 'arc': {
        const s = child(n, 'start'), m = child(n, 'mid'), e = child(n, 'end');
        if (!s || !m || !e) return null;
        const it = { k: 'arc', n, layer: str(child(n, 'layer')), net: netOf(n, this.netNames), w: num(child(n, 'width'), 1, 0.2) };
        const a = arcFrom3(num(s, 1), num(s, 2), num(m, 1), num(m, 2), num(e, 1), num(e, 2));
        it.prims = a
          ? [{ t: 'A', layer: it.layer, ...a, w: it.w, net: it.net }]
          : [{ t: 'L', layer: it.layer, x1: num(s, 1), y1: num(s, 2), x2: num(e, 1), y2: num(e, 2), w: it.w, net: it.net }];
        return it;
      }
      case 'via': {
        const at = child(n, 'at');
        if (!at) return null;
        const ls = child(n, 'layers');
        const it = { k: 'via', n, x: num(at, 1), y: num(at, 2), size: num(child(n, 'size'), 1, 0.6), drill: num(child(n, 'drill'), 1, 0.3),
          net: netOf(n, this.netNames), layers: ls ? [str(ls, 1), str(ls, 2)] : ['F.Cu', 'B.Cu'] };
        it.prims = [
          { t: 'C', layer: '@Via', cx: it.x, cy: it.y, r: it.size / 2, w: 0, fill: true, net: it.net },
          { t: 'C', layer: '@Holes', cx: it.x, cy: it.y, r: it.drill / 2, w: 0, fill: true },
        ];
        return it;
      }
      case 'zone': {
        const it = { k: 'zone', n, net: netOf(n, this.netNames) || str(child(n, 'net_name')) || null, prims: [] };
        const ls = child(n, 'layers');
        const layers = ls ? ls.items.slice(1).map((a) => a.raw.replace(/"/g, '')) : [str(child(n, 'layer'))];
        const real = [...expandLayers(layers.filter(Boolean), this.layerNames)];
        const poly = child(n, 'polygon');
        if (poly) {
          const pts = ptsOf(poly);
          for (const layer of real) it.prims.push({ t: 'P', layer, pts, w: 0.1, fill: false, closed: true, dash: 0.6 });
        }
        for (const f of n.items) {
          if (f.h !== 'filled_polygon') continue;
          const lm = /\(layer\s+"?([^"\s)]+)"?\)/.exec(f.src.slice(f.s, Math.min(f.e, f.s + 120)));
          it.prims.push({ t: 'P', layer: lm ? lm[1] : real[0], pts: ptsOf(f), w: 0, fill: true, closed: true, alpha: 0.42, net: it.net, zf: true });
        }
        return it;
      }
      case 'gr_text': {
        const p = textPrim(n, 1, ident);
        if (!p) return null;
        return { k: 'text', n, layer: p.layer, prims: [p] };
      }
      case 'gr_line': case 'gr_rect': case 'gr_circle': case 'gr_arc': case 'gr_poly': case 'gr_curve': {
        const prims = [];
        graphicPrims(n, ident, prims);
        if (!prims.length) return null;
        return { k: 'gr', n, layer: prims[0].layer, prims };
      }
    }
    return null;
  }

  buildFp(n) {
    const at = child(n, 'at');
    const x = num(at, 1), y = num(at, 2), ang = num(at, 3);
    const cs = Math.cos(ang * DEG), sn = Math.sin(ang * DEG);
    const T = (lx, ly) => [x + lx * cs + ly * sn, y - lx * sn + ly * cs];
    const it = { k: 'fp', n, x, y, ang, layer: str(child(n, 'layer')) || 'F.Cu', name: str(n, 1) || '', ref: '', value: '',
      prims: [], pads: 0, fixed: this.isFootprintFile };
    // reference / value first, they feed ${REFERENCE} substitution
    for (const c of n.items) {
      if (c.h === 'property') {
        const k = str(c, 1);
        if (k === 'Reference') it.ref = str(c, 2) || '';
        else if (k === 'Value') it.value = str(c, 2) || '';
      } else if (c.h === 'fp_text') {
        const k = str(c, 1);
        if (k === 'reference') it.ref = str(c, 2) || '';
        else if (k === 'value') it.value = str(c, 2) || '';
      }
    }
    const vars = { REFERENCE: it.ref, VALUE: it.value };
    const body = [];
    for (const c of n.items) {
      if (c.t !== 'l') continue;
      if (c.h === 'pad') { this.padPrims(c, T, it); continue; }
      if (c.h === 'fp_text' || c.h === 'property') {
        if (isHidden(c)) continue;
        const p = textPrim(c, 2, T, vars);
        if (p) it.prims.push(p);
        continue;
      }
      if (c.h.startsWith('fp_')) graphicPrims(c, T, body);
    }
    for (const p of body) it.prims.push(p);
    // selection box: pads + body graphics (no text)
    const bb = emptyBounds();
    for (const p of it.prims) if (p.t !== 'T') primBounds(p, bb);
    if (bb[0] === Infinity) { bb[0] = x - 1; bb[1] = y - 1; bb[2] = x + 1; bb[3] = y + 1; }
    it.bb = bb;
    return it;
  }

  padPrims(c, T, it) {
    const at = child(c, 'at');
    const size = child(c, 'size');
    if (!at || !size) return;
    const type = str(c, 2), shape = str(c, 3);
    const pang = num(at, 3);
    const [px, py] = T(num(at, 1), num(at, 2));
    const w = num(size, 1), h = num(size, 2, num(size, 1));
    const net = netOf(c, this.netNames);
    const drill = child(c, 'drill');
    let dw = 0, dh = 0, ox = 0, oy = 0;
    if (drill) {
      const nums = drill.items.filter((a) => a.t === 'a' && a.raw !== 'oval').slice(1);
      dw = nums[0] ? parseFloat(nums[0].raw) : 0;
      dh = nums[1] ? parseFloat(nums[1].raw) : dw;
      const off = child(drill, 'offset');
      if (off) { ox = num(off, 1); oy = num(off, 2); }
    }
    const pc = Math.cos(pang * DEG), ps = Math.sin(pang * DEG);
    const PT = (lx, ly) => [px + lx * pc + ly * ps, py - lx * ps + ly * pc];
    const [cx, cy] = PT(ox, oy);
    let rr = 0;
    if (shape === 'circle') rr = w / 2;
    else if (shape === 'oval') rr = Math.min(w, h) / 2;
    else if (shape === 'roundrect') rr = Math.min(w, h) * num(child(c, 'roundrect_rratio'), 1, 0.25);
    const ls = child(c, 'layers');
    const layers = ls ? expandLayers(ls.items.slice(1).map((a) => a.raw.replace(/"/g, '')), this.layerNames) : new Set();
    const number = str(c, 1) || '';
    const mk = (layer) => {
      it.prims.push({ t: 'R', layer, x: cx, y: cy, ang: pang, w, h: shape === 'circle' ? w : h, rr, net, pad: number });
      if (shape === 'custom') {
        const pr = child(c, 'primitives');
        if (pr) for (const g of pr.items) if (g.t === 'l') {
          const before = it.prims.length;
          graphicPrims(g, PT, it.prims, layer);
          for (let i = before; i < it.prims.length; i++) { it.prims[i].net = net; it.prims[i].pad = number; if (it.prims[i].t === 'P') it.prims[i].fill = true; }
        }
      }
    };
    it.pads++;
    if (type === 'thru_hole') {
      mk('@TH');
      for (const l of layers) if (!l.endsWith('.Cu')) mk(l);
    } else if (type !== 'np_thru_hole') {
      for (const l of layers) mk(l);
    } else {
      for (const l of layers) if (!l.endsWith('.Cu')) mk(l);
    }
    if (dw > 0) it.prims.push({ t: 'R', layer: '@Holes', x: px, y: py, ang: pang, w: dw, h: dh, rr: Math.min(dw, dh) / 2, pad: number, hole: true });
  }

  refresh(item) {
    const fresh = this.build(item.n);
    if (fresh) Object.assign(item, fresh);
    this._buckets = null;
  }

  // ---------- rendering ----------

  buckets() {
    if (this._buckets) return this._buckets;
    const b = new Map();
    for (const it of this.items) {
      for (const p of it.prims) {
        let arr = b.get(p.layer);
        if (!arr) b.set(p.layer, (arr = []));
        arr.push(p);
      }
    }
    return (this._buckets = b);
  }

  layerVisible(name) {
    if (name === '@Holes') return true;
    if (name === '@TH' || name === '@Via') return this.layers.some((l) => l.visible && l.name.endsWith('.Cu'));
    const l = this.layers.find((x) => x.name === name);
    return l ? l.visible : false;
  }

  bounds() {
    const edge = emptyBounds();
    const all = emptyBounds();
    for (const it of this.items) {
      for (const p of it.prims) {
        if (p.zf) continue;
        primBounds(p, all);
        if (p.layer === 'Edge.Cuts') primBounds(p, edge);
      }
    }
    const bb = edge[0] !== Infinity ? edge : all;
    return bb[0] === Infinity ? [0, 0, 100, 80] : bb;
  }

  draw(ctx, view, sel) {
    const b = this.buckets();
    const hl = this.hlNet;
    const zf = this.showZoneFill;
    const pass = (name, color) => {
      const prims = b.get(name);
      if (!prims) return;
      if (hl && (name.endsWith('.Cu') || name === '@TH' || name === '@Via')) {
        ctx.globalAlpha = 0.22;
        drawPrims(ctx, view, prims, color, { filter: (p) => p.net !== hl && (zf || !p.zf) });
        ctx.globalAlpha = 1;
        drawPrims(ctx, view, prims, '#ffffff', { filter: (p) => p.net === hl && (zf || !p.zf), force: true });
      } else {
        drawPrims(ctx, view, prims, color, zf ? null : { filter: (p) => !p.zf });
      }
    };
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i];
      if (l.visible) pass(l.name, l.color);
    }
    if (this.layerVisible('@TH')) { pass('@TH', COLORS['@TH']); pass('@Via', COLORS['@Via']); }
    pass('@Holes', COLORS['@Holes']);

    for (const it of sel) {
      ctx.globalAlpha = 0.9;
      drawPrims(ctx, view, it.prims, '#ffffff', { force: true, filter: (p) => !p.zf && !p.hole });
      ctx.globalAlpha = 1;
      if (it.k === 'fp') {
        ctx.strokeStyle = '#ffd24d';
        ctx.lineWidth = 1.5 / view.k;
        ctx.setLineDash([4 / view.k, 3 / view.k]);
        ctx.strokeRect(it.bb[0], it.bb[1], it.bb[2] - it.bb[0], it.bb[3] - it.bb[1]);
        ctx.setLineDash([]);
      }
    }
  }

  // ---------- hit testing ----------

  hitAll(x, y, tol) {
    const strong = [], vias = [], segs = [], texts = [], grs = [], weak = [];
    for (const it of this.items) {
      if (it.k === 'zone') continue;
      if (it.k === 'fp') {
        let hitPad = false;
        for (const p of it.prims) {
          if (p.t === 'R' && !p.hole && this.layerVisible(p.layer) && primDist(x, y, p) <= tol * 0.3) { hitPad = true; break; }
        }
        if (hitPad) strong.push(it);
        else if (x >= it.bb[0] - tol && x <= it.bb[2] + tol && y >= it.bb[1] - tol && y <= it.bb[3] + tol) weak.push(it);
        continue;
      }
      if (it.k === 'via') { if (this.layerVisible('@Via') && primDist(x, y, it.prims[0]) <= tol * 0.5) vias.push(it); continue; }
      if (!this.layerVisible(it.layer)) continue;
      let d = Infinity;
      for (const p of it.prims) d = Math.min(d, primDist(x, y, p));
      if (d > tol) continue;
      if (it.k === 'seg' || it.k === 'arc') segs.push(it);
      else if (it.k === 'text') texts.push(it);
      else grs.push(it);
    }
    const order = new Map(this.layers.map((l, i) => [l.name, i]));
    segs.sort((a, b) => (order.get(a.layer) ?? 99) - (order.get(b.layer) ?? 99));
    weak.sort((a, b) => (a.bb[2] - a.bb[0]) * (a.bb[3] - a.bb[1]) - (b.bb[2] - b.bb[0]) * (b.bb[3] - b.bb[1]));
    return [...strong, ...vias, ...segs, ...texts, ...weak, ...grs];
  }

  padAt(item, x, y) {
    if (item.k !== 'fp') return null;
    for (const p of item.prims) if (p.t === 'R' && !p.hole && primDist(x, y, p) === 0) return p;
    return null;
  }

  // ---------- edits ----------

  canMove(item) { return !item.fixed; }
  canRotate(item) { return (item.k === 'fp' && !item.fixed) || item.k === 'text'; }

  shiftNode(n, dx, dy) {
    for (const c of n.items) {
      if (c.t !== 'l') continue;
      if (c.h === 'at' || c.h === 'start' || c.h === 'end' || c.h === 'mid' || c.h === 'center') {
        setNum(c, 1, num(c, 1) + dx, this.digits);
        setNum(c, 2, num(c, 2) + dy, this.digits);
      } else if (c.h === 'pts') {
        for (const p of c.items) if (p.h === 'xy') { setNum(p, 1, num(p, 1) + dx, this.digits); setNum(p, 2, num(p, 2) + dy, this.digits); }
      }
    }
  }

  moveBy(item, dx, dy) {
    if (item.k === 'fp') {
      const at = child(item.n, 'at');
      setNum(at, 1, num(at, 1) + dx, this.digits);
      setNum(at, 2, num(at, 2) + dy, this.digits);
    } else this.shiftNode(item.n, dx, dy);
    this.refresh(item);
  }

  rotate(item) {
    if (item.k === 'text') {
      const at = child(item.n, 'at');
      setNum(at, 3, normAng(num(at, 3) + 90), 4);
    } else if (item.k === 'fp') {
      this.setFpAngle(item, item.ang + 90);
      return;
    }
    this.refresh(item);
  }

  // Pad and text angles are stored absolute, so they turn with the footprint.
  setFpAngle(item, ang) {
    const at = child(item.n, 'at');
    const old = num(at, 3);
    const d = ang - old;
    if (!d) return;
    setNum(at, 3, normAng(ang), 4);
    for (const c of item.n.items) {
      if (c.h === 'pad' || c.h === 'fp_text' || c.h === 'property') {
        const a = child(c, 'at');
        if (a) setNum(a, 3, normAng(num(a, 3) + d), 4);
      }
    }
    this.refresh(item);
  }

  remove(item) {
    remove(item.n);
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    this._buckets = null;
  }

  handles(item) {
    if (item.k === 'seg') return [[item.x1, item.y1], [item.x2, item.y2]];
    return [];
  }

  moveHandle(item, idx, x, y) {
    const c = child(item.n, idx === 0 ? 'start' : 'end');
    setNum(c, 1, x, this.digits);
    setNum(c, 2, y, this.digits);
    this.refresh(item);
  }

  title(item) {
    switch (item.k) {
      case 'fp': return '풋프린트 ' + (item.ref || '');
      case 'seg': return '배선 (트랙)';
      case 'arc': return '원호 배선';
      case 'via': return '비아';
      case 'text': return '텍스트';
      case 'gr': return '도형 (' + item.n.h.replace('gr_', '') + ')';
    }
    return item.k;
  }

  props(item) {
    const n = item.n;
    const self = this;
    const xy = (node, label) => [
      { label: label + ' X', type: 'number', value: num(node, 1), set(v) { setNum(node, 1, v, self.digits); self.refresh(item); } },
      { label: label + ' Y', type: 'number', value: num(node, 2), set(v) { setNum(node, 2, v, self.digits); self.refresh(item); } },
    ];
    const netInfo = item.net ? [{ label: '네트', type: 'info', value: item.net }] : [];
    if (item.k === 'fp') {
      const fields = [];
      const setField = (key, v) => {
        for (const c of n.items) {
          if ((c.h === 'property' && str(c, 1) === key) || (c.h === 'fp_text' && str(c, 1) === key.toLowerCase())) setStr(c, 2, v);
        }
        self.refresh(item);
      };
      fields.push({ label: '참조 (Reference)', type: 'text', value: item.ref, set: (v) => setField('Reference', v) });
      fields.push({ label: '값 (Value)', type: 'text', value: item.value, set: (v) => setField('Value', v) });
      if (!item.fixed) {
        fields.push(...xy(child(n, 'at'), '위치'));
        fields.push({ label: '각도 (°)', type: 'number', value: item.ang, set(v) { self.setFpAngle(item, v); } });
      }
      fields.push({ label: '면', type: 'info', value: item.layer });
      fields.push({ label: '패드 수', type: 'info', value: String(item.pads) });
      fields.push({ label: '풋프린트', type: 'info', value: item.name });
      return fields;
    }
    if (item.k === 'seg') {
      const wn = child(n, 'width'), ln = child(n, 'layer');
      return [
        ...netInfo,
        { label: '레이어', type: 'select', options: this.copper, value: item.layer, set(v) { setRaw(ln, 1, quote(v)); self.refresh(item); } },
        { label: '폭 (mm)', type: 'number', value: item.w, set(v) { if (v > 0) { setNum(wn, 1, v, self.digits); self.refresh(item); } } },
        ...xy(child(n, 'start'), '시작'),
        ...xy(child(n, 'end'), '끝'),
        { label: '길이 (mm)', type: 'info', value: Math.hypot(item.x2 - item.x1, item.y2 - item.y1).toFixed(3) },
      ];
    }
    if (item.k === 'arc') {
      const wn = child(n, 'width');
      return [...netInfo, { label: '레이어', type: 'info', value: item.layer },
        { label: '폭 (mm)', type: 'number', value: item.w, set(v) { if (v > 0) { setNum(wn, 1, v, self.digits); self.refresh(item); } } }];
    }
    if (item.k === 'via') {
      const sn = child(n, 'size'), dn = child(n, 'drill');
      return [
        ...netInfo,
        ...xy(child(n, 'at'), '위치'),
        { label: '지름 (mm)', type: 'number', value: item.size, set(v) { if (v > 0 && sn) { setNum(sn, 1, v, self.digits); self.refresh(item); } } },
        { label: '드릴 (mm)', type: 'number', value: item.drill, set(v) { if (v > 0 && dn) { setNum(dn, 1, v, self.digits); self.refresh(item); } } },
        { label: '레이어', type: 'info', value: item.layers.join(' – ') },
      ];
    }
    if (item.k === 'text') {
      const at = child(n, 'at'), ln = child(n, 'layer');
      const size = child(child(child(n, 'effects'), 'font'), 'size');
      const f = [
        { label: '내용', type: 'textarea', value: str(n, 1) || '', set(v) { setStr(n, 1, v); self.refresh(item); } },
        ...xy(at, '위치'),
        { label: '각도 (°)', type: 'number', value: num(at, 3), set(v) { setNum(at, 3, normAng(v), 4); self.refresh(item); } },
        { label: '레이어', type: 'select', options: this.layerNames, value: item.layer, set(v) { setRaw(ln, 1, quote(v)); self.refresh(item); } },
      ];
      if (size) f.push({ label: '글자 높이 (mm)', type: 'number', value: num(size, 1), set(v) { if (v > 0) { setNum(size, 1, v, self.digits); setNum(size, 2, v, self.digits); self.refresh(item); } } });
      return f;
    }
    if (item.k === 'gr') {
      const ln = child(n, 'layer');
      return [{ label: '레이어', type: 'select', options: this.layerNames, value: item.layer, set(v) { setRaw(ln, 1, quote(v)); self.refresh(item); } }];
    }
    return [];
  }

  summary() {
    const c = {};
    for (const it of this.items) c[it.k] = (c[it.k] || 0) + 1;
    const parts = [];
    if (c.fp) parts.push('풋프린트 ' + c.fp);
    if (c.seg || c.arc) parts.push('트랙 ' + ((c.seg || 0) + (c.arc || 0)));
    if (c.via) parts.push('비아 ' + c.via);
    if (c.zone) parts.push('영역 ' + c.zone);
    return parts.join(' · ');
  }
}
