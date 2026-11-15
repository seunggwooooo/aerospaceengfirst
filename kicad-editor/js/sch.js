// .kicad_sch / .kicad_sym document: extraction, rendering, hit-testing, edits.
import { parse, child, children, str, num, hasAtom, isHidden, ptsOf, setNum, setStr, setRaw, remove, insert, quote, uuid, fmt, reId, clone } from './sexpr.js';
import { partKind, pinType, refCompare } from './parts.js';
import { DEG, arcFrom3, bezierPts, primDist, primBounds, emptyBounds, drawPrims, measure } from './draw.js';

const C = {
  bg: '#f5f4ef', wire: '#009600', bus: '#000084', junction: '#009600', noconnect: '#000084',
  sym: '#840000', symFill: '#ffffc2', pin: '#840000', pinName: '#006464', pinNum: '#a90000',
  ref: '#006464', field: '#840084', label: '#0f0f0f', glabel: '#840000', hlabel: '#725600',
  note: '#0000c2', sheet: '#840000', sheetFill: 'rgba(255,255,194,0.45)', sheetName: '#006464', sheetFile: '#725600',
};
const DEFAULT_W = 0.1524;

const normAng = (a) => ((Math.round(a) % 360) + 360) % 360;

function strokeOf(c, defColor) {
  const st = child(c, 'stroke');
  let w = st ? num(child(st, 'width'), 1, 0) : 0;
  if (!(w > 0)) w = DEFAULT_W;
  let color = defColor;
  const col = st && child(st, 'color');
  if (col && num(col, 4) > 0) color = `rgba(${num(col, 1)},${num(col, 2)},${num(col, 3)},${num(col, 4)})`;
  const type = st ? str(child(st, 'type')) : null;
  const dash = type === 'dash' || type === 'dash_dot' || type === 'dash_dot_dot' ? 1.2 : type === 'dot' ? 0.4 : 0;
  return { w, color, dash };
}

function fillOf(c, strokeColor) {
  const f = child(c, 'fill');
  if (!f) return null;
  const type = str(child(f, 'type'));
  if (type === 'outline') return strokeColor;
  if (type === 'background') return C.symFill;
  if (type === 'color') {
    const col = child(f, 'color');
    if (col) return `rgba(${num(col, 1)},${num(col, 2)},${num(col, 3)},${num(col, 4, 1)})`;
  }
  return null;
}

function fontOf(n) {
  const fx = child(n, 'effects');
  const font = child(fx, 'font');
  const size = child(font, 'size');
  const just = child(fx, 'justify');
  return {
    h: size ? num(size, 1, 1.27) : 1.27,
    hj: hasAtom(just, 'left') ? 'l' : hasAtom(just, 'right') ? 'r' : 'c',
    vj: hasAtom(just, 'top') ? 't' : hasAtom(just, 'bottom') ? 'b' : 'c',
    bold: hasAtom(font, 'bold') || str(child(font, 'bold')) === 'yes',
    italic: hasAtom(font, 'italic') || str(child(font, 'italic')) === 'yes',
  };
}

// Generic graphic node (polyline/rectangle/circle/arc/bezier) -> prims via T.
function shapePrims(c, T, out, defColor) {
  const st = strokeOf(c, defColor);
  const fillColor = fillOf(c, st.color);
  const base = { w: st.w, color: st.color, dash: st.dash || undefined, fill: !!fillColor, fillColor: fillColor || undefined };
  if (c.h === 'polyline' || c.h === 'bezier') {
    let raw = ptsOf(c);
    if (c.h === 'bezier' && raw.length >= 8) raw = bezierPts(raw);
    const pts = [];
    for (let i = 0; i < raw.length; i += 2) pts.push(...T(raw[i], raw[i + 1]));
    if (pts.length >= 4) out.push({ t: 'P', pts, closed: false, ...base });
  } else if (c.h === 'rectangle') {
    const s = child(c, 'start'), e = child(c, 'end');
    if (!s || !e) return;
    const x1 = num(s, 1), y1 = num(s, 2), x2 = num(e, 1), y2 = num(e, 2);
    out.push({ t: 'P', pts: [...T(x1, y1), ...T(x2, y1), ...T(x2, y2), ...T(x1, y2)], closed: true, ...base });
  } else if (c.h === 'circle') {
    const ce = child(c, 'center');
    if (!ce) return;
    const [cx, cy] = T(num(ce, 1), num(ce, 2));
    out.push({ t: 'C', cx, cy, r: num(child(c, 'radius'), 1, 1), ...base });
  } else if (c.h === 'arc') {
    const s = child(c, 'start'), m = child(c, 'mid'), e = child(c, 'end');
    if (!s || !m || !e) return;
    const a = T(num(s, 1), num(s, 2)), b = T(num(m, 1), num(m, 2)), d = T(num(e, 1), num(e, 2));
    const arc = arcFrom3(a[0], a[1], b[0], b[1], d[0], d[1]);
    if (arc) out.push({ t: 'A', ...arc, w: st.w, color: st.color });
    else out.push({ t: 'L', x1: a[0], y1: a[1], x2: d[0], y2: d[1], w: st.w, color: st.color });
  }
}

function parseLib(n, lookup) {
  const lib = { name: str(n, 1) || '', node: n, units: [], unitCount: 1, pinNameOffset: 0.508, hidePinNames: false, hidePinNumbers: false };
  const pn = child(n, 'pin_names');
  if (pn) {
    const off = child(pn, 'offset');
    if (off) lib.pinNameOffset = num(off, 1, 0.508);
    lib.hidePinNames = isHidden(pn);
  }
  const pnum = child(n, 'pin_numbers');
  if (pnum) lib.hidePinNumbers = isHidden(pnum);
  const ext = child(n, 'extends');
  let src = n;
  if (ext && lookup) {
    const parent = lookup(str(ext));
    if (parent) {
      src = parent.node;
      lib.units = parent.units;
      lib.unitCount = parent.unitCount;
      lib.pinNameOffset = parent.pinNameOffset;
      lib.hidePinNames = parent.hidePinNames;
      lib.hidePinNumbers = parent.hidePinNumbers;
      return lib;
    }
  }
  const direct = { unit: 0, style: 0, nodes: [] };
  for (const c of src.items) {
    if (c.t !== 'l') continue;
    if (c.h === 'symbol') {
      const m = /_(\d+)_(\d+)$/.exec(str(c, 1) || '');
      const u = { unit: m ? +m[1] : 0, style: m ? +m[2] : 0, nodes: c.items.filter((x) => x.t === 'l') };
      lib.units.push(u);
      if (u.unit > lib.unitCount) lib.unitCount = u.unit;
    } else if (c.h === 'pin' || c.h === 'polyline' || c.h === 'rectangle' || c.h === 'circle' || c.h === 'arc' || c.h === 'bezier' || c.h === 'text') {
      direct.nodes.push(c);
    }
  }
  if (direct.nodes.length) lib.units.push(direct);
  return lib;
}

// Label direction by stored angle: unit vector along the text, text angle, justification.
function spin(ang) {
  switch (normAng(ang)) {
    case 90: return { ux: 0, uy: -1, ang: 90, hj: 'l' };
    case 180: return { ux: -1, uy: 0, ang: 0, hj: 'r' };
    case 270: return { ux: 0, uy: 1, ang: 90, hj: 'r' };
    default: return { ux: 1, uy: 0, ang: 0, hj: 'l' };
  }
}

function flagShape(shape, len, hh, small) {
  const tip = hh;
  switch (shape) {
    case 'input': return [0, 0, tip, -hh, len, -hh, len, hh, tip, hh];
    case 'output': return [0, -hh, len - tip, -hh, len, 0, len - tip, hh, 0, hh];
    case 'bidirectional': case 'tri_state': return [0, 0, tip, -hh, len - tip, -hh, len, 0, len - tip, hh, tip, hh];
    default: return small ? [0, -hh, len, -hh, len, hh, 0, hh] : [0, -hh, len, -hh, len, hh, 0, hh];
  }
}

export class SchDoc {
  constructor(root) {
    this.kind = 'sch';
    this.root = root;
    this.isLibFile = root.h === 'kicad_symbol_lib';
    this.background = C.bg;
    this.gridOptions = [0.254, 0.635, 1.27, 2.54];
    this.grid = 1.27;
    this.digits = 4;
    this.items = [];
    this.libs = new Map();
    const u = child(root, 'uuid');
    this.quoteUuid = u && u.items[1] ? u.items[1].q : true;
    this.version = num(child(root, 'version'), 1, 20230121);

    const libRoot = this.isLibFile ? root : child(root, 'lib_symbols');
    this.libNodes = new Map();
    if (libRoot) for (const c of libRoot.items) if (c.h === 'symbol') this.libNodes.set(str(c, 1), c);

    if (this.isLibFile) {
      this.symbolNames = [...this.libNodes.keys()];
      this.showLibSymbol(this.symbolNames[0]);
      return;
    }
    const paper = child(root, 'paper');
    this.paper = paper ? str(paper, 1) : 'A4';
    for (const c of root.items) {
      if (c.t !== 'l') continue;
      const it = this.build(c);
      if (it) this.items.push(it);
    }
  }

  lib(name) {
    if (!name) return null;
    let l = this.libs.get(name);
    if (l === undefined) {
      const n = this.libNodes.get(name);
      l = n ? parseLib(n, (p) => this.lib(p) || this.lib(name.split(':')[0] + ':' + p)) : null;
      this.libs.set(name, l);
    }
    return l;
  }

  showLibSymbol(name) {
    this.currentSymbol = name;
    this.items = [];
    const lib = this.lib(name);
    if (!lib) return;
    const it = { k: 'libsym', n: lib.node, fixed: true, x: 0, y: 0, prims: [], name };
    const T = (lx, ly) => [lx, -ly];
    const RM = (u, v) => [u, v];
    this.symbolBody(lib, 1, 1, T, RM, it.prims);
    for (const p of children(lib.node, 'property')) {
      if (isHidden(p) || !str(p, 2)) continue;
      const at = child(p, 'at');
      const f = fontOf(p);
      const [x, y] = T(num(at, 1), num(at, 2));
      it.prims.push({ t: 'T', x, y, ang: num(at, 3) === 90 ? 90 : 0, text: str(p, 2), ...f, color: str(p, 1) === 'Reference' || str(p, 1) === 'Value' ? C.ref : C.field });
    }
    this.finishBounds(it);
    this.items.push(it);
  }

  // ---------- extraction ----------

  symbolBody(lib, unit, style, T, RM, prims) {
    const pins = [];
    for (const u of lib.units) {
      if (u.unit !== 0 && u.unit !== unit) continue;
      if (u.style !== 0 && u.style !== style) continue;
      for (const c of u.nodes) {
        if (c.h === 'pin') { pins.push(c); continue; }
        if (c.h === 'text') {
          const at = child(c, 'at');
          if (!at) continue;
          let a = num(at, 3);
          if (Math.abs(a) > 360) a /= 10;
          const f = fontOf(c);
          const [x, y] = T(num(at, 1), num(at, 2));
          const e = RM(Math.cos(a * DEG), -Math.sin(a * DEG));
          prims.push({ t: 'T', x, y, ang: Math.abs(e[0]) >= Math.abs(e[1]) ? 0 : 90, text: str(c, 1) || '', ...f, color: C.sym });
          continue;
        }
        shapePrims(c, T, prims, C.sym);
      }
    }
    // filled shapes first so outlines and pins stay visible
    prims.sort((a, b) => (b.fillColor === C.symFill ? 1 : 0) - (a.fillColor === C.symFill ? 1 : 0));
    const pinPts = [];
    for (const c of pins) {
      const at = child(c, 'at');
      if (!at) continue;
      const px = num(at, 1), py = num(at, 2), pa = num(at, 3) * DEG;
      const len = num(child(c, 'length'), 1, 2.54);
      const a = T(px, py);
      if (isHidden(c)) {   // not drawn, but still a connection point (power symbols)
        pinPts.push({ x: a[0], y: a[1], number: str(child(c, 'number')) || '', name: str(child(c, 'name')) || '', type: str(c, 1), hidden: true });
        continue;
      }
      const b = T(px + len * Math.cos(pa), py + len * Math.sin(pa));
      const shape = str(c, 2);
      pinPts.push({ x: a[0], y: a[1], number: str(child(c, 'number')) || '', name: str(child(c, 'name')) || '', type: str(c, 1) });
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      dx /= L; dy /= L;
      if (shape && shape.indexOf('inverted') >= 0 && len > 1.3) {
        const r = 0.635;
        prims.push({ t: 'L', x1: a[0], y1: a[1], x2: b[0] - dx * 2 * r, y2: b[1] - dy * 2 * r, w: DEFAULT_W, color: C.pin });
        prims.push({ t: 'C', cx: b[0] - dx * r, cy: b[1] - dy * r, r, w: DEFAULT_W, color: C.pin });
      } else if (len > 0) {
        prims.push({ t: 'L', x1: a[0], y1: a[1], x2: b[0], y2: b[1], w: DEFAULT_W, color: C.pin });
      }
      const horiz = Math.abs(dx) >= Math.abs(dy);
      const nameNode = child(c, 'name'), numNode = child(c, 'number');
      const name = str(nameNode) || '';
      if (!lib.hidePinNames && name && name !== '~') {
        const h = fontOf(nameNode).h;
        if (lib.pinNameOffset > 0) {
          const o = lib.pinNameOffset;
          prims.push({ t: 'T', x: b[0] + dx * o, y: b[1] + dy * o, ang: horiz ? 0 : 90, text: name, h, vj: 'c',
            hj: horiz ? (dx > 0 ? 'l' : 'r') : (dy < 0 ? 'l' : 'r'), color: C.pinName });
        } else {
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          prims.push({ t: 'T', x: horiz ? mx : mx - 0.3, y: horiz ? my - 0.3 : my, ang: horiz ? 0 : 90, text: name, h, vj: 'b', hj: 'c', color: C.pinName });
        }
      }
      const number = str(numNode) || '';
      if (!lib.hidePinNumbers && number && len > 0) {
        const h = fontOf(numNode).h;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const below = !lib.hidePinNames && lib.pinNameOffset <= 0 && name && name !== '~';
        prims.push({ t: 'T', x: horiz ? mx : mx + (below ? 0.3 : -0.3), y: horiz ? my + (below ? 0.3 : -0.3) : my, ang: horiz ? 0 : 90, text: number, h,
          vj: below ? 't' : 'b', hj: 'c', color: C.pinNum });
      }
    }
    return pinPts;
  }

  build(n) {
    switch (n.h) {
      case 'symbol': return this.buildSymbol(n);
      case 'wire': case 'bus': case 'polyline': {
        const st = strokeOf(n, n.h === 'wire' ? C.wire : n.h === 'bus' ? C.bus : C.note);
        const pts = ptsOf(n);
        if (pts.length < 4) return null;
        const w = n.h === 'bus' && st.w === DEFAULT_W ? 0.3048 : st.w;
        const it = { k: n.h === 'polyline' ? 'line' : n.h, n, pts, prims: [] };
        for (let i = 0; i + 3 < pts.length; i += 2) {
          it.prims.push({ t: 'L', x1: pts[i], y1: pts[i + 1], x2: pts[i + 2], y2: pts[i + 3], w, color: st.color, dash: st.dash || undefined });
        }
        return it;
      }
      case 'bus_entry': {
        const at = child(n, 'at'), sz = child(n, 'size');
        if (!at || !sz) return null;
        const x = num(at, 1), y = num(at, 2);
        return { k: 'entry', n, prims: [{ t: 'L', x1: x, y1: y, x2: x + num(sz, 1), y2: y + num(sz, 2), w: DEFAULT_W, color: C.wire }] };
      }
      case 'junction': {
        const at = child(n, 'at');
        if (!at) return null;
        const d = num(child(n, 'diameter'), 1, 0) || 0.9144;
        const x = num(at, 1), y = num(at, 2);
        return { k: 'junction', n, x, y, prims: [{ t: 'C', cx: x, cy: y, r: d / 2, w: 0, fill: true, color: C.junction }] };
      }
      case 'no_connect': {
        const at = child(n, 'at');
        if (!at) return null;
        const x = num(at, 1), y = num(at, 2), s = 0.6096;
        return { k: 'nc', n, x, y, prims: [
          { t: 'L', x1: x - s, y1: y - s, x2: x + s, y2: y + s, w: DEFAULT_W, color: C.noconnect },
          { t: 'L', x1: x - s, y1: y + s, x2: x + s, y2: y - s, w: DEFAULT_W, color: C.noconnect }] };
      }
      case 'text': {
        const at = child(n, 'at');
        if (!at) return null;
        const f = fontOf(n);
        const sp = spin(num(at, 3));
        return { k: 'text', n, x: num(at, 1), y: num(at, 2),
          prims: [{ t: 'T', x: num(at, 1), y: num(at, 2), ang: sp.ang, text: str(n, 1) || '', h: f.h, hj: sp.hj, vj: f.vj === 'c' ? 'b' : f.vj, bold: f.bold, italic: f.italic, color: C.note }] };
      }
      case 'text_box': {
        const at = child(n, 'at'), sz = child(n, 'size');
        if (!at || !sz) return null;
        const x = num(at, 1), y = num(at, 2), w = num(sz, 1), h = num(sz, 2);
        const f = fontOf(n);
        const st = strokeOf(n, C.note);
        const fillColor = fillOf(n, st.color);
        return { k: 'textbox', n, x, y, prims: [
          { t: 'P', pts: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true, w: st.w, color: st.color, fill: !!fillColor, fillColor: fillColor || undefined },
          { t: 'T', x: x + 0.6, y: y + 0.6, ang: 0, text: str(n, 1) || '', h: f.h, hj: 'l', vj: 't', color: C.note }] };
      }
      case 'label': case 'global_label': case 'hierarchical_label': case 'directive_label': case 'netclass_flag':
        return this.buildLabel(n);
      case 'sheet': return this.buildSheet(n);
      case 'rectangle': case 'circle': case 'arc': case 'bezier': {
        const prims = [];
        shapePrims(n, (x, y) => [x, y], prims, C.note);
        return prims.length ? { k: 'shape', n, prims } : null;
      }
    }
    return null;
  }

  labelPrims(kind, text, x, y, ang, h, shape, out) {
    const sp = spin(ang);
    const U = (u, v) => [x + u * sp.ux - v * sp.uy, y + u * sp.uy + v * sp.ux];
    if (kind === 'global_label') {
      const hh = h * 0.95;
      const lead = shape === 'input' || shape === 'bidirectional' || shape === 'tri_state' ? hh + 0.2 : 0.5;
      const tail = shape === 'output' || shape === 'bidirectional' || shape === 'tri_state' ? hh + 0.2 : 0.5;
      const len = lead + measure(text, h) + tail;
      const loc = flagShape(shape, len, hh);
      const pts = [];
      for (let i = 0; i < loc.length; i += 2) pts.push(...U(loc[i], loc[i + 1]));
      out.push({ t: 'P', pts, closed: true, w: DEFAULT_W, color: C.glabel });
      const [tx, ty] = U(lead, 0);
      out.push({ t: 'T', x: tx, y: ty, ang: sp.ang, text, h, hj: sp.hj, vj: 'c', color: C.glabel });
    } else if (kind === 'hierarchical_label' || kind === 'sheet_pin') {
      const s = h;
      let loc;
      if (shape === 'input') loc = [0, 0, s / 2, -s / 2, s, -s / 2, s, s / 2, s / 2, s / 2];
      else if (shape === 'output') loc = [0, -s / 2, s / 2, -s / 2, s, 0, s / 2, s / 2, 0, s / 2];
      else if (shape === 'bidirectional' || shape === 'tri_state') loc = [0, 0, s / 2, -s / 2, s, 0, s / 2, s / 2];
      else loc = [0, -s / 2, s, -s / 2, s, s / 2, 0, s / 2];
      const pts = [];
      for (let i = 0; i < loc.length; i += 2) pts.push(...U(loc[i], loc[i + 1]));
      out.push({ t: 'P', pts, closed: true, w: DEFAULT_W, color: C.hlabel });
      const [tx, ty] = U(s + 0.4, 0);
      out.push({ t: 'T', x: tx, y: ty, ang: sp.ang, text, h, hj: sp.hj, vj: 'c', color: C.hlabel });
    } else {
      out.push({ t: 'T', x: sp.ang ? x - 0.25 : x, y: sp.ang ? y : y - 0.25, ang: sp.ang, text, h, hj: sp.hj, vj: 'b', color: C.label });
    }
  }

  buildLabel(n) {
    const at = child(n, 'at');
    if (!at) return null;
    const it = { k: 'label', kind: n.h, n, x: num(at, 1), y: num(at, 2), ang: num(at, 3), prims: [] };
    this.labelPrims(n.h, str(n, 1) || '', it.x, it.y, it.ang, fontOf(n).h, str(child(n, 'shape')), it.prims);
    return it;
  }

  buildSheet(n) {
    const at = child(n, 'at'), sz = child(n, 'size');
    if (!at || !sz) return null;
    const x = num(at, 1), y = num(at, 2), w = num(sz, 1), h = num(sz, 2);
    const st = strokeOf(n, C.sheet);
    const it = { k: 'sheet', n, x, y, bb: [x, y, x + w, y + h], prims: [] };
    it.prims.push({ t: 'P', pts: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true, w: st.w, color: st.color, fill: true, fillColor: C.sheetFill });
    for (const p of children(n, 'property')) {
      if (isHidden(p)) continue;
      const pa = child(p, 'at');
      if (!pa) continue;
      const key = str(p, 1) || '';
      const f = fontOf(p);
      const isFile = /file/i.test(key);
      it.prims.push({ t: 'T', x: num(pa, 1), y: num(pa, 2), ang: num(pa, 3) === 90 ? 90 : 0, text: (isFile ? 'File: ' : '') + (str(p, 2) || ''),
        ...f, color: isFile ? C.sheetFile : C.sheetName });
      if (/name/i.test(key)) it.name = str(p, 2);
    }
    it.pinPts = [];
    for (const p of children(n, 'pin')) {
      const pa = child(p, 'at');
      if (!pa) continue;
      it.pinPts.push([num(pa, 1), num(pa, 2)]);
      this.labelPrims('sheet_pin', str(p, 1) || '', num(pa, 1), num(pa, 2), num(pa, 3) + 180, fontOf(p).h, str(p, 2), it.prims);
    }
    return it;
  }

  buildSymbol(n) {
    const at = child(n, 'at');
    if (!at) return null;
    const x = num(at, 1), y = num(at, 2), ang = normAng(num(at, 3));
    const mirror = str(child(n, 'mirror')) || null;
    const unit = num(child(n, 'unit'), 1, 1);
    const style = num(child(n, 'body_style') || child(n, 'convert'), 1, 1);
    const libId = str(child(n, 'lib_id')) || '';
    const lib = this.lib(str(child(n, 'lib_name'))) || this.lib(libId);
    const cs = Math.cos(ang * DEG), sn = Math.sin(ang * DEG);
    const RM = (u, v) => {
      let rx = u * cs + v * sn, ry = -u * sn + v * cs;
      if (mirror === 'y') rx = -rx; else if (mirror === 'x') ry = -ry;
      return [rx, ry];
    };
    const T = (lx, ly) => { const r = RM(lx, -ly); return [x + r[0], y + r[1]]; };
    const it = { k: 'symbol', n, x, y, ang, mirror, unit, libId, ref: '', value: '', prims: [], pins: [] };
    if (lib) it.pins = this.symbolBody(lib, unit, style, T, RM, it.prims);
    else it.prims.push({ t: 'P', pts: [x - 2.54, y - 2.54, x + 2.54, y - 2.54, x + 2.54, y + 2.54, x - 2.54, y + 2.54], closed: true, w: DEFAULT_W, color: C.sym, dash: 0.5 });
    const bb = emptyBounds();
    for (const p of it.prims) if (p.t !== 'T') primBounds(p, bb);
    if (bb[0] === Infinity) { bb[0] = x - 1.27; bb[1] = y - 1.27; bb[2] = x + 1.27; bb[3] = y + 1.27; }
    it.bb = bb;

    for (const p of children(n, 'property')) {
      const key = str(p, 1) || '';
      let val = str(p, 2) || '';
      if (key === 'Reference') it.ref = val; else if (key === 'Value') it.value = val;
      if (isHidden(p) || !val || key.startsWith('ki_')) continue;
      const pa = child(p, 'at');
      if (!pa) continue;
      if (key === 'Reference' && lib && lib.unitCount > 1) val += String.fromCharCode(64 + unit);
      const sn2 = child(p, 'show_name');
      if (sn2 && str(sn2) !== 'no' && key !== 'Reference' && key !== 'Value') val = key + ': ' + val;
      const f = fontOf(p);
      const ta = num(pa, 3) * DEG;
      const e = RM(Math.cos(ta), -Math.sin(ta));   // text "right" direction after the symbol transform
      const d = RM(Math.sin(ta), Math.cos(ta));    // text "down" direction
      const horiz = Math.abs(e[0]) >= Math.abs(e[1]);
      let hj = f.hj, vj = f.vj;
      if (horiz ? e[0] < 0 : e[1] > 0) hj = hj === 'l' ? 'r' : hj === 'r' ? 'l' : 'c';
      if (horiz ? d[1] < 0 : d[0] < 0) vj = vj === 't' ? 'b' : vj === 'b' ? 't' : 'c';
      it.prims.push({ t: 'T', x: num(pa, 1), y: num(pa, 2), ang: horiz ? 0 : 90, text: val, h: f.h, hj, vj, bold: f.bold, italic: f.italic,
        color: key === 'Reference' || key === 'Value' ? C.ref : C.field });
    }
    return it;
  }

  finishBounds(it) {
    const bb = emptyBounds();
    for (const p of it.prims) primBounds(p, bb);
    it.bb = bb;
  }

  refresh(item) {
    const fresh = this.build(item.n);
    if (fresh) Object.assign(item, fresh);
    this.rev = (this.rev || 0) + 1;
  }

  // ---------- rendering ----------

  bounds() {
    const bb = emptyBounds();
    for (const it of this.items) for (const p of it.prims) primBounds(p, bb);
    return bb[0] === Infinity ? [0, 0, 297, 210] : bb;
  }

  draw(ctx, view, sel) {
    const order = { sheet: 0, shape: 1, textbox: 1, line: 1, symbol: 2, libsym: 2, bus: 3, entry: 3, wire: 3, junction: 4, nc: 4, label: 5, text: 5 };
    const groups = [[], [], [], [], [], []];
    for (const it of this.items) groups[order[it.k] ?? 1].push(it);
    for (const g of groups) for (const it of g) drawPrims(ctx, view, it.prims, C.sym);
    for (const it of sel) {
      drawPrims(ctx, view, it.prims, '#e8590c', { force: true, filter: (p) => !(p.fill && p.t === 'P' && p.fillColor) || it.k !== 'sheet' });
      if (it.bb && it.k !== 'sheet') {
        ctx.strokeStyle = '#e8590c';
        ctx.lineWidth = 1.2 / view.k;
        ctx.setLineDash([4 / view.k, 3 / view.k]);
        const m = 0.6;
        ctx.strokeRect(it.bb[0] - m, it.bb[1] - m, it.bb[2] - it.bb[0] + 2 * m, it.bb[3] - it.bb[1] + 2 * m);
        ctx.setLineDash([]);
      }
    }
  }

  // ---------- hit testing ----------

  hitAll(x, y, tol) {
    const small = [], wires = [], boxes = [], rest = [];
    for (const it of this.items) {
      if (it.k === 'symbol' || it.k === 'sheet' || it.k === 'libsym') {
        const b = it.bb;
        if (x >= b[0] - tol * 0.3 && x <= b[2] + tol * 0.3 && y >= b[1] - tol * 0.3 && y <= b[3] + tol * 0.3) boxes.push(it);
        continue;
      }
      let d = Infinity;
      for (const p of it.prims) d = Math.min(d, primDist(x, y, p));
      if (d > tol) continue;
      if (it.k === 'label' || it.k === 'text' || it.k === 'junction' || it.k === 'nc') small.push(it);
      else if (it.k === 'wire' || it.k === 'bus' || it.k === 'entry') wires.push(it);
      else rest.push(it);
    }
    boxes.sort((a, b) => (a.bb[2] - a.bb[0]) * (a.bb[3] - a.bb[1]) - (b.bb[2] - b.bb[0]) * (b.bb[3] - b.bb[1]));
    return [...small, ...wires, ...boxes, ...rest];
  }

  // ---------- edits ----------

  canMove(item) { return !item.fixed; }
  canRotate(item) { return item.k === 'symbol' || item.k === 'label' || item.k === 'text'; }

  shift(n, dx, dy) {
    for (const c of n.items) {
      if (c.t !== 'l') continue;
      if (c.h === 'at' || c.h === 'start' || c.h === 'end' || c.h === 'mid' || c.h === 'center') {
        setNum(c, 1, num(c, 1) + dx, this.digits);
        setNum(c, 2, num(c, 2) + dy, this.digits);
      } else if (c.h === 'pts') {
        for (const p of c.items) if (p.h === 'xy') { setNum(p, 1, num(p, 1) + dx, this.digits); setNum(p, 2, num(p, 2) + dy, this.digits); }
      } else if (c.h === 'property' || (c.h === 'pin' && n.h === 'sheet')) {
        const a = child(c, 'at');
        if (a) { setNum(a, 1, num(a, 1) + dx, this.digits); setNum(a, 2, num(a, 2) + dy, this.digits); }
      }
    }
  }

  moveBy(item, dx, dy) {
    this.followPins(item, () => {
      this.shift(item.n, dx, dy);
      this.refresh(item);
    });
  }

  // Wire ends sitting on a symbol's pins stay on those pins when it moves or turns.
  followPins(item, fn) {
    if (item.k !== 'symbol' || this.followWires === false || !item.pins.length) { fn(); return; }
    const att = [];
    for (const w of this.items) {
      if (w.k === 'label' || w.k === 'nc') {   // a label or no-connect sitting on a pin belongs to that pin
        const idx = item.pins.findIndex((p) => Math.abs(p.x - w.x) < 0.005 && Math.abs(p.y - w.y) < 0.005);
        if (idx >= 0) att.push({ w, e: -1, idx });
        continue;
      }
      if ((w.k !== 'wire' && w.k !== 'bus') || w.pts.length !== 4) continue;
      for (let e = 0; e < 2; e++) {
        const x = w.pts[2 * e], y = w.pts[2 * e + 1];
        const idx = item.pins.findIndex((p) => Math.abs(p.x - x) < 0.005 && Math.abs(p.y - y) < 0.005);
        if (idx >= 0) att.push({ w, e, idx });
      }
    }
    fn();
    const touched = new Set();
    for (const a of att) {
      const p = item.pins[a.idx];
      const xy = a.e < 0 ? child(a.w.n, 'at') : children(child(a.w.n, 'pts'), 'xy')[a.e];
      if (!p || !xy) continue;
      setNum(xy, 1, p.x, this.digits);
      setNum(xy, 2, p.y, this.digits);
      touched.add(a.w);
    }
    for (const w of touched) this.refresh(w);
  }

  rotate(item) {
    if (item.k === 'symbol') { this.followPins(item, () => this.rotateNode(item)); return; }
    this.rotateNode(item);
  }

  rotateNode(item) {
    const n = item.n;
    const at = child(n, 'at');
    if (item.k === 'symbol') {
      const x = num(at, 1), y = num(at, 2);
      setNum(at, 3, normAng(num(at, 3) + (item.mirror ? -90 : 90)), 0);
      for (const p of children(n, 'property')) {
        const a = child(p, 'at');
        if (!a) continue;
        const dx = num(a, 1) - x, dy = num(a, 2) - y;
        setNum(a, 1, x + dy, this.digits);
        setNum(a, 2, y - dx, this.digits);
      }
    } else if (item.k === 'label' || item.k === 'text') {
      const a = normAng(num(at, 3) + 90);
      setNum(at, 3, a, 0);
      const just = child(child(n, 'effects'), 'justify');
      if (just) {
        const want = a === 180 || a === 270 ? 'right' : 'left';
        for (let i = 1; i < just.items.length; i++) {
          const r = just.items[i].raw;
          if ((r === 'left' || r === 'right') && r !== want) setRaw(just, i, want);
        }
      }
    }
    this.refresh(item);
  }

  remove(item) {
    remove(item.n);
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    this.rev = (this.rev || 0) + 1;
  }

  handles(item) {
    if ((item.k === 'wire' || item.k === 'bus' || item.k === 'line') && item.pts.length === 4) {
      return [[item.pts[0], item.pts[1]], [item.pts[2], item.pts[3]]];
    }
    return [];
  }

  moveHandle(item, idx, x, y) {
    const xy = children(child(item.n, 'pts'), 'xy')[idx];
    if (!xy) return;
    setNum(xy, 1, x, this.digits);
    setNum(xy, 2, y, this.digits);
    this.refresh(item);
  }

  // ---------- adding ----------

  add(text) {
    const node = typeof text === 'string' ? parse(text) : text;
    insert(this.root, node, ['sheet_instances', 'symbol_instances', 'embedded_fonts']);
    const it = this.build(node);
    if (it) this.items.push(it);
    this.rev = (this.rev || 0) + 1;
    return it;
  }

  uid() { const u = uuid(); return this.quoteUuid ? '"' + u + '"' : u; }
  f(v) { return fmt(v, this.digits); }

  addWire(x1, y1, x2, y2) {
    if (x1 === x2 && y1 === y2) return null;
    return this.add(`(wire (pts (xy ${this.f(x1)} ${this.f(y1)}) (xy ${this.f(x2)} ${this.f(y2)})) (stroke (width 0) (type default)) (uuid ${this.uid()}))`);
  }

  addJunction(x, y) {
    return this.add(`(junction (at ${this.f(x)} ${this.f(y)}) (diameter 0) (color 0 0 0 0) (uuid ${this.uid()}))`);
  }

  addNoConnect(x, y) {
    return this.add(`(no_connect (at ${this.f(x)} ${this.f(y)}) (uuid ${this.uid()}))`);
  }

  addLabel(x, y, text) {
    return this.add(`(label ${quote(text)} (at ${this.f(x)} ${this.f(y)} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid ${this.uid()}))`);
  }

  addText(x, y, text) {
    return this.add(`(text ${quote(text)} (at ${this.f(x)} ${this.f(y)} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid ${this.uid()}))`);
  }

  // ---------- properties ----------

  title(item) {
    switch (item.k) {
      case 'symbol': return '심볼 ' + (item.ref || '');
      case 'libsym': return '라이브러리 심볼';
      case 'wire': return '배선';
      case 'bus': return '버스';
      case 'line': return '선';
      case 'junction': return '접점';
      case 'nc': return '미연결 표시';
      case 'text': return '텍스트';
      case 'textbox': return '텍스트 상자';
      case 'sheet': return '계층 시트 ' + (item.name || '');
      case 'label': return item.kind === 'global_label' ? '글로벌 라벨' : item.kind === 'hierarchical_label' ? '계층 라벨' : '라벨';
    }
    return item.k;
  }

  setReference(n, v) {
    const inst = child(n, 'instances');
    if (!inst) return;
    const paths = [];
    for (const proj of children(inst, 'project')) paths.push(...children(proj, 'path'));
    if (paths.length === 1) {
      const r = child(paths[0], 'reference');
      if (r) setStr(r, 1, v);
    }
  }

  props(item) {
    const n = item.n;
    const self = this;
    const at = child(n, 'at');
    const pos = at && !item.fixed ? [
      { label: '위치 X', type: 'number', value: num(at, 1), set(v) { self.moveBy(item, v - num(at, 1), 0); } },
      { label: '위치 Y', type: 'number', value: num(at, 2), set(v) { self.moveBy(item, 0, v - num(at, 2)); } },
    ] : [];
    if (item.k === 'symbol') {
      const f = [];
      for (const p of children(n, 'property')) {
        const key = str(p, 1) || '';
        if (key.startsWith('ki_')) continue;
        const main = key === 'Reference' || key === 'Value' || key === 'Footprint';
        if (!main && !str(p, 2)) continue;
        const label = key === 'Reference' ? '참조 (Reference)' : key === 'Value' ? '값 (Value)' : key === 'Footprint' ? '풋프린트' : key;
        f.push({ label, type: 'text', value: str(p, 2) || '', set(v) { setStr(p, 2, v); if (key === 'Reference') self.setReference(n, v); self.refresh(item); } });
      }
      f.push(...pos);
      const kind = partKind(item.ref, item.libId + ' ' + item.value);
      if (kind) f.splice(0, 0, { label: '부품 종류', type: 'info', value: kind });
      const libNode = this.libNodes.get(str(child(n, 'lib_name')) || '') || this.libNodes.get(item.libId);
      let descr = '';
      for (const src of [n, libNode]) {
        if (descr || !src) continue;
        for (const p of children(src, 'property')) if ((str(p, 1) === 'Description' || str(p, 1) === 'ki_description') && str(p, 2)) descr = str(p, 2);
      }
      if (descr) f.push({ label: '설명', type: 'info', value: descr });
      const pins = item.pins.filter((p) => p.number);
      if (pins.length) f.push({ label: '핀', type: 'table', head: ['핀', '이름', '종류'],
        rows: pins.map((p) => [p.number, p.name && p.name !== '~' ? p.name : '–', pinType(p.type)]).sort((a, b) => refCompare(a[0], b[0])) });
      f.push({ label: '각도 (°)', type: 'info', value: String(item.ang) + (item.mirror ? ' · 반전 ' + item.mirror : '') });
      f.push({ label: '심볼', type: 'info', value: item.libId + (item.unit > 1 ? ' (유닛 ' + item.unit + ')' : '') });
      return f;
    }
    if (item.k === 'label') {
      const f = [{ label: '이름', type: 'text', value: str(n, 1) || '', set(v) { if (v) { setStr(n, 1, v); self.refresh(item); } } }];
      const sh = child(n, 'shape');
      if (sh) f.push({ label: '모양', type: 'select', options: ['input', 'output', 'bidirectional', 'tri_state', 'passive'], value: str(sh),
        set(v) { setRaw(sh, 1, v); self.refresh(item); } });
      f.push(...pos);
      return f;
    }
    if (item.k === 'text' || item.k === 'textbox') {
      const size = child(child(child(n, 'effects'), 'font'), 'size');
      const f = [{ label: '내용', type: 'textarea', value: str(n, 1) || '', set(v) { setStr(n, 1, v); self.refresh(item); } }, ...pos];
      if (size) f.push({ label: '글자 크기 (mm)', type: 'number', value: num(size, 1), set(v) { if (v > 0) { setNum(size, 1, v, 4); setNum(size, 2, v, 4); self.refresh(item); } } });
      return f;
    }
    if (item.k === 'sheet') {
      const f = [];
      for (const p of children(n, 'property')) {
        const key = str(p, 1) || '';
        if (/name/i.test(key)) f.push({ label: '시트 이름', type: 'text', value: str(p, 2) || '', set(v) { setStr(p, 2, v); self.refresh(item); } });
        else if (/file/i.test(key)) f.push({ label: '시트 파일', type: 'info', value: str(p, 2) || '' });
      }
      return [...f, ...pos];
    }
    if (item.k === 'wire' || item.k === 'bus' || item.k === 'line') {
      const p = item.pts;
      let len = 0;
      for (let i = 0; i + 3 < p.length; i += 2) len += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
      return [{ label: '시작', type: 'info', value: p[0] + ', ' + p[1] }, { label: '끝', type: 'info', value: p[p.length - 2] + ', ' + p[p.length - 1] },
        { label: '길이 (mm)', type: 'info', value: len.toFixed(2) }];
    }
    if (item.k === 'libsym') return [{ label: '심볼', type: 'info', value: item.name }];
    return pos;
  }

  // ---------- new parts ----------

  nextRef(prefix) {
    let n = 1;
    for (const it of this.items) {
      if (it.k !== 'symbol' || !it.ref || !it.ref.startsWith(prefix)) continue;
      const tail = it.ref.slice(prefix.length);
      const v = parseInt(tail, 10);
      if (/^\d+$/.test(tail) && v >= n) n = v + 1;
    }
    return prefix === '#PWR' ? prefix + String(n).padStart(2, '0') : prefix + n;
  }

  // (path ...) under which this sheet's symbols are annotated, and the project name.
  instanceContext() {
    for (const it of this.items) {
      if (it.k !== 'symbol') continue;
      const inst = child(it.n, 'instances');
      const proj = inst && child(inst, 'project');
      const path = proj && child(proj, 'path');
      if (path) return { project: str(proj, 1) || '', path: str(path, 1) || '/' };
    }
    const u = child(this.root, 'uuid');
    return { project: this.projectName || '', path: '/' + (u ? str(u, 1) : '') };
  }

  // v6 files keep annotation in a root (symbol_instances ...) table instead.
  addLegacyInstance(symUuid, ref, value, footprint, likeUuid) {
    const table = child(this.root, 'symbol_instances');
    if (!table) return;
    let prefix = '/';
    if (likeUuid) for (const p of children(table, 'path')) { const s = str(p, 1) || ''; if (s.endsWith('/' + likeUuid)) prefix = s.slice(0, s.length - likeUuid.length); }
    insert(table, parse(`(path ${quote(prefix + symUuid)} (reference ${quote(ref)}) (unit 1) (value ${quote(value)}) (footprint ${quote(footprint)}))`));
  }

  setSymbolRef(node, ref) {
    for (const p of children(node, 'property')) if (str(p, 1) === 'Reference') setStr(p, 2, ref);
    const inst = child(node, 'instances');
    if (inst) for (const proj of children(inst, 'project')) for (const path of children(proj, 'path')) { const r = child(path, 'reference'); if (r) setStr(r, 1, ref); }
  }

  cloneSymbol(item, dx, dy) {
    const copy = clone(item.n);
    const oldId = str(child(item.n, 'uuid'));
    reId(copy);
    this.shift(copy, dx, dy);
    const power = (item.ref || '')[0] === '#';
    const prefix = power ? item.ref.replace(/\d+$/, '') : (item.ref || 'U').replace(/[\d?]+$/, '') || 'U';
    const ref = this.nextRef(prefix);
    this.setSymbolRef(copy, ref);
    const it = this.add(copy);
    this.addLegacyInstance(str(child(copy, 'uuid')), ref, item.value || '', '', oldId);
    return it;
  }

  // Symbols that can be placed straight from this schematic's own library section.
  ownSymbols() {
    const out = [];
    for (const [name, node] of this.libNodes) if (!child(node, 'extends')) out.push({ name, node });
    return out;
  }

  // Place a symbol; `node` is its library definition (from this file or a .kicad_sym), `full` its "Lib:Name" id.
  placeSymbol(node, full, x, y) {
    if (!this.libNodes.has(full)) {
      let libs = child(this.root, 'lib_symbols');
      if (!libs) libs = insert(this.root, parse('(lib_symbols)'), ['junction', 'no_connect', 'wire', 'bus', 'text', 'label', 'global_label', 'symbol', 'sheet', 'sheet_instances']);
      const copy = clone(node);
      setStr(copy, 1, full);
      insert(libs, copy);
      this.libNodes.set(full, copy);
      this.libs.delete(full);
    }
    const def = this.libNodes.get(full);
    const lib = this.lib(full);
    const power = !!child(def, 'power');
    const hide = this.hideYes === undefined ? (this.hideYes = /\(hide yes\)/.test(this.root.src)) : this.hideYes;
    const id = () => this.uid();
    const symId = uuid();
    let refPrefix = 'U', value = full.split(':').pop();
    const props = [];
    for (const p of children(def, 'property')) {
      const key = str(p, 1) || '';
      if (key.startsWith('ki_')) continue;
      let val = str(p, 2) || '';
      if (key === 'Reference') { refPrefix = val || 'U'; continue; }
      if (key === 'Value') value = val || value;
      props.push({ key, val, p });
    }
    const ref = this.nextRef(power ? '#PWR' : refPrefix.replace(/[\d?]+$/, '') || 'U');
    const refDef = children(def, 'property').find((p) => str(p, 1) === 'Reference');
    const propText = (key, val, p, forceHide) => {
      const at = p && child(p, 'at');
      const px = x + (at ? num(at, 1) : 0), py = y - (at ? num(at, 2) : 0);
      const size = p && child(child(child(p, 'effects'), 'font'), 'size');
      const sz = size ? `${this.f(num(size, 1, 1.27))} ${this.f(num(size, 2, 1.27))}` : '1.27 1.27';
      const hidden = forceHide || (p && isHidden(p));
      const fx = `(effects (font (size ${sz}))${hidden ? (hide ? ' (hide yes)' : ' hide') : ''})`;
      return `(property ${quote(key)} ${quote(val)} (at ${this.f(px)} ${this.f(py)} ${at ? this.f(num(at, 3)) : 0}) ${fx})`;
    };
    let text = `(symbol (lib_id ${quote(full)}) (at ${this.f(x)} ${this.f(y)} 0) (unit 1) (in_bom yes) (on_board yes)${this.version >= 20230121 ? ' (dnp no)' : ''} (uuid ${this.quoteUuid ? '"' + symId + '"' : symId})`;
    text += ' ' + propText('Reference', ref, refDef, power);
    for (const pr of props) text += ' ' + propText(pr.key, pr.val, pr.p, false);
    const seen = new Set();
    if (lib) for (const u of lib.units) {
      if (u.unit > 1) continue;
      for (const c of u.nodes) {
        if (c.h !== 'pin') continue;
        const numb = str(child(c, 'number')) || '';
        if (seen.has(numb)) continue;
        seen.add(numb);
        text += ` (pin ${quote(numb)} (uuid ${id()}))`;
      }
    }
    if (this.version >= 20230121) {
      const ctx = this.instanceContext();
      text += ` (instances (project ${quote(ctx.project)} (path ${quote(ctx.path)} (reference ${quote(ref)}) (unit 1))))`;
    }
    text += ')';
    const it = this.add(text);
    if (this.version < 20230121) this.addLegacyInstance(symId, ref, value, '', null);
    return it;
  }

  parts() {
    return this.items.filter((it) => it.k === 'symbol' && it.ref && it.ref[0] !== '#')
      .map((it) => ({ item: it, ref: it.ref + (it.unit > 1 ? ' (유닛 ' + it.unit + ')' : ''), value: it.value,
        footprint: (children(it.n, 'property').find((p) => str(p, 1) === 'Footprint') ? str(children(it.n, 'property').find((p) => str(p, 1) === 'Footprint'), 2) : '') || '',
        kind: partKind(it.ref, it.libId + ' ' + it.value) }))
      .sort((a, b) => refCompare(a.ref, b.ref));
  }

  summary() {
    if (this.isLibFile) return '심볼 ' + this.symbolNames.length + '개';
    const c = {};
    for (const it of this.items) c[it.k] = (c[it.k] || 0) + 1;
    const parts = [];
    if (c.symbol) parts.push('심볼 ' + c.symbol);
    if (c.wire) parts.push('배선 ' + c.wire);
    if (c.label) parts.push('라벨 ' + c.label);
    if (c.sheet) parts.push('시트 ' + c.sheet);
    return parts.join(' · ');
  }
}
