// KiCad S-expression parser / serializer.
//
// The tree keeps the source offsets of every node, so saving re-emits the
// original text byte-for-byte except for the atoms and lists that were
// actually edited. That keeps diffs against the KiCad-written file minimal.
//
// Node shapes:
//   list   {t:'l', h:'head', items:[...], p:parent, src, s, e, d:dirty}
//   opaque {t:'o', h:'head', p, src, s, e}      (huge lists we never edit)
//   atom   {t:'a', raw:'text', q:quoted, p, s, e}

const OPAQUE = new Set(['filled_polygon', 'data']);

export function parse(src) {
  const n = src.length;
  let i = 0;
  let cur = null;
  let root = null;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c <= 32) { i++; continue; }
    if (c === 40) { // (
      let j = i + 1;
      while (j < n && src.charCodeAt(j) <= 32) j++;
      let k = j;
      while (k < n) {
        const cc = src.charCodeAt(k);
        if (cc <= 32 || cc === 40 || cc === 41 || cc === 34) break;
        k++;
      }
      const h = src.slice(j, k);
      if (cur && OPAQUE.has(h)) {
        let depth = 1;
        let m = i + 1;
        while (m < n && depth > 0) {
          const cc = src.charCodeAt(m);
          if (cc === 40) depth++;
          else if (cc === 41) depth--;
          else if (cc === 34) {
            m++;
            while (m < n) {
              const q = src.charCodeAt(m);
              if (q === 92) m++;
              else if (q === 34) break;
              m++;
            }
          }
          m++;
        }
        cur.items.push({ t: 'o', h, p: cur, src, s: i, e: m });
        i = m;
        continue;
      }
      const node = { t: 'l', h, items: [], p: cur, src, s: i, e: -1, d: false };
      if (cur) cur.items.push(node);
      else if (!root) root = node;
      cur = node;
      i++;
      continue;
    }
    if (c === 41) { // )
      if (!cur) throw new Error('괄호가 맞지 않습니다 (위치 ' + i + ')');
      cur.e = i + 1;
      cur = cur.p;
      i++;
      if (!cur && root) break;
      continue;
    }
    if (!cur) throw new Error('KiCad S-expression 파일이 아닙니다');
    let j = i;
    let q = false;
    if (c === 34) {
      q = true;
      j = i + 1;
      while (j < n) {
        const cc = src.charCodeAt(j);
        if (cc === 92) { j += 2; continue; }
        if (cc === 34) break;
        j++;
      }
      j++;
    } else {
      while (j < n) {
        const cc = src.charCodeAt(j);
        if (cc <= 32 || cc === 40 || cc === 41) break;
        j++;
      }
    }
    cur.items.push({ t: 'a', raw: src.slice(i, j), q, p: cur, s: i, e: j });
    i = j;
  }
  if (!root || cur) throw new Error('파일이 중간에 끊겼거나 KiCad 파일이 아닙니다');
  return root;
}

function depthOf(n) {
  let d = 0;
  for (let p = n.p; p; p = p.p) d++;
  return d;
}

function ser(n, out) {
  if (n.t === 'a') { out.push(n.raw); return; }
  if (n.t === 'o' || !n.d) { out.push(n.src.slice(n.s, n.e)); return; }
  const orig = n.orig;
  let pos = n.s;
  let oi = 0;
  let indent = null;
  for (const c of n.items) {
    const original = c.s >= 0 && (c.t === 'a' ? !c.ins : c.src === n.src);
    if (original) {
      if (orig) {
        while (orig[oi] !== c) { pos = orig[oi].e; oi++; }
        oi++;
      }
      out.push(n.src.slice(pos, c.s));
      ser(c, out);
      pos = c.e;
    } else if (c.t === 'a') {
      out.push(' ');
      out.push(c.raw);
    } else {
      if (indent === null) indent = '\n' + '\t'.repeat(depthOf(n) + 1);
      out.push(indent);
      ser(c, out);
    }
  }
  if (orig) while (oi < orig.length) { pos = orig[oi].e; oi++; }
  out.push(n.src.slice(pos, n.e));
}

export function serialize(root) {
  const out = [];
  ser(root, out);
  let text = out.join('');
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

export function markDirty(n) {
  while (n && !n.d) { n.d = true; n = n.p; }
}

// ---------- reading helpers ----------

export function unquote(raw) {
  if (raw.charCodeAt(0) !== 34) return raw;
  const body = raw.slice(1, -1);
  if (body.indexOf('\\') < 0) return body;
  return body.replace(/\\(.)/g, (m, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '' : ch));
}

export function quote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"';
}

export function child(n, h) {
  if (!n || n.t !== 'l') return null;
  const it = n.items;
  for (let i = 1; i < it.length; i++) if (it[i].h === h) return it[i];
  return null;
}

export function children(n, h) {
  const r = [];
  if (!n || n.t !== 'l') return r;
  const it = n.items;
  for (let i = 1; i < it.length; i++) if (it[i].h === h) r.push(it[i]);
  return r;
}

export function str(n, i = 1) {
  const a = n && n.items && n.items[i];
  return a && a.t === 'a' ? unquote(a.raw) : undefined;
}

export function num(n, i = 1, def = 0) {
  const a = n && n.items && n.items[i];
  if (!a || a.t !== 'a') return def;
  const v = parseFloat(a.raw);
  return Number.isFinite(v) ? v : def;
}

export function hasAtom(n, word) {
  if (!n || n.t !== 'l') return false;
  const it = n.items;
  for (let i = 1; i < it.length; i++) if (it[i].t === 'a' && it[i].raw === word) return true;
  return false;
}

// (hide yes) | bare `hide` atom, on the node itself or inside its (effects ...)
export function isHidden(n) {
  if (!n) return false;
  if (hasAtom(n, 'hide')) return true;
  const h = child(n, 'hide');
  if (h && str(h) !== 'no') return true;
  const fx = child(n, 'effects');
  if (fx) {
    if (hasAtom(fx, 'hide')) return true;
    const h2 = child(fx, 'hide');
    if (h2 && str(h2) !== 'no') return true;
  }
  return false;
}

// Points of a (pts ...) list or of an opaque list containing one.
export function ptsOf(n) {
  if (!n) return [];
  const r = [];
  if (n.t === 'o') {
    const re = /\(xy\s+(\S+)\s+([^\s)]+)\)/g;
    const text = n.src.slice(n.s, n.e);
    let m;
    while ((m = re.exec(text))) r.push(parseFloat(m[1]), parseFloat(m[2]));
    return r;
  }
  const pts = n.h === 'pts' ? n : child(n, 'pts');
  if (!pts) return r;
  for (const c of pts.items) {
    if (c.h === 'xy') r.push(num(c, 1), num(c, 2));
    else if (c.h === 'arc') {
      for (const k of ['start', 'mid', 'end']) {
        const p = child(c, k);
        if (p) r.push(num(p, 1), num(p, 2));
      }
    }
  }
  return r;
}

// ---------- editing helpers ----------

export function fmt(v, digits = 6) {
  let s = Number(v).toFixed(digits);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

export function setRaw(n, i, raw) {
  const a = n.items[i];
  if (a && a.t === 'a') {
    if (a.raw === raw) return;
    a.raw = raw;
  } else {
    while (n.items.length < i) n.items.push({ t: 'a', raw: '0', q: false, p: n, s: -1, e: -1, ins: true });
    n.items.splice(i, 0, { t: 'a', raw, q: raw.charCodeAt(0) === 34, p: n, s: -1, e: -1, ins: true });
  }
  markDirty(n);
}

export function setNum(n, i, v, digits) { setRaw(n, i, fmt(v, digits)); }
export function setStr(n, i, s) { setRaw(n, i, quote(s)); }

export function remove(node) {
  const p = node.p;
  if (!p) return;
  const idx = p.items.indexOf(node);
  if (idx < 0) return;
  if (!p.orig) p.orig = p.items.slice();
  p.items.splice(idx, 1);
  markDirty(p);
}

// Insert `node` into `parent`, before the first child whose head is in
// `beforeHeads` (or at the end).
export function insert(parent, node, beforeHeads) {
  if (!parent.orig) parent.orig = parent.items.slice();
  let idx = parent.items.length;
  if (beforeHeads) {
    for (let i = 1; i < parent.items.length; i++) {
      if (beforeHeads.includes(parent.items[i].h)) { idx = i; break; }
    }
  }
  node.p = parent;
  parent.items.splice(idx, 0, node);
  markDirty(parent);
  return node;
}

export function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

// Give every (uuid ...) / (tstamp ...) inside `node` a fresh id (used when copying items).
export function reId(node) {
  if (!node || node.t !== 'l') return;
  if ((node.h === 'uuid' || node.h === 'tstamp') && node.items[1] && node.items[1].t === 'a') {
    const id = uuid();
    setRaw(node, 1, node.items[1].q ? '"' + id + '"' : id);
    return;
  }
  for (const c of node.items) reId(c);
}

export function clone(node) { return parse(serialize(node)); }
