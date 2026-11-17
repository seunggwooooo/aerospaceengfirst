// Schematic electrical checks: do the drawn connections actually connect?
import { distToSeg } from './draw.js';

const key = (x, y) => Math.round(x * 100) + ',' + Math.round(y * 100);

export function analyzeSch(doc) {
  const t0 = Date.now();
  const wires = [];        // [x1,y1,x2,y2,item]
  const ends = new Map();  // point -> number of wire ends there
  const pins = new Map();  // point -> [{sym, pin}]
  const marks = new Map(); // point -> Set('label'|'nc'|'junction'|'sheetpin')
  const addMark = (x, y, m) => { const k = key(x, y); let s = marks.get(k); if (!s) marks.set(k, (s = new Set())); s.add(m); };
  const addEnd = (x, y) => { const k = key(x, y); ends.set(k, (ends.get(k) || 0) + 1); };
  const labels = [];
  const refs = new Map();
  const violations = [];

  for (const it of doc.items) {
    if (it.k === 'wire' || it.k === 'bus') {
      for (let i = 0; i + 3 < it.pts.length; i += 2) {
        wires.push([it.pts[i], it.pts[i + 1], it.pts[i + 2], it.pts[i + 3], it]);
        addEnd(it.pts[i], it.pts[i + 1]);
        addEnd(it.pts[i + 2], it.pts[i + 3]);
      }
    } else if (it.k === 'entry') {
      const p = it.prims[0];
      addMark(p.x1, p.y1, 'entry'); addMark(p.x2, p.y2, 'entry');
    } else if (it.k === 'junction') addMark(it.x, it.y, 'junction');
    else if (it.k === 'nc') addMark(it.x, it.y, 'nc');
    else if (it.k === 'label') { addMark(it.x, it.y, 'label'); labels.push(it); }
    else if (it.k === 'sheet') for (const p of it.pinPts || []) addMark(p[0], p[1], 'sheetpin');
    else if (it.k === 'symbol') {
      for (const p of it.pins) {
        const k = key(p.x, p.y);
        let arr = pins.get(k);
        if (!arr) pins.set(k, (arr = []));
        arr.push({ sym: it, pin: p });
      }
      if (it.ref && it.ref[0] !== '#') {
        if (/\?$/.test(it.ref)) violations.push({ type: 'annotation', sev: 'warn', x: it.x, y: it.y, items: [it], msg: `참조 번호가 지정되지 않음: ${it.ref}` });
        const id = it.ref + '/' + it.unit;
        if (refs.has(id)) violations.push({ type: 'duplicate', sev: 'error', x: it.x, y: it.y, items: [it, refs.get(id)], msg: `참조 번호 중복: ${it.ref}` });
        else refs.set(id, it);
      }
    }
  }

  const onWire = (x, y, skip) => {
    for (const w of wires) {
      if (w[4] === skip && ((w[0] === x && w[1] === y) || (w[2] === x && w[3] === y))) continue;
      if (distToSeg(x, y, w[0], w[1], w[2], w[3]) < 0.005) return true;
    }
    return false;
  };

  for (const [k, arr] of pins) {
    const m = marks.get(k);
    const { sym, pin } = arr[0];
    const connected = arr.length > 1 || ends.has(k) || (m && (m.has('label') || m.has('sheetpin') || m.has('entry'))) || onWire(pin.x, pin.y, null);
    const nc = m && m.has('nc');
    for (const { sym: s2, pin: p2 } of arr) {
      if (p2.type === 'no_connect' || p2.hidden) continue;
      const name = `${s2.ref || '?'} 핀 ${p2.number}${p2.name && p2.name !== '~' ? ' (' + p2.name + ')' : ''}`;
      if (!connected && !nc) violations.push({ type: 'pin', sev: 'error', x: p2.x, y: p2.y, items: [s2], msg: `핀이 연결되지 않음: ${name}` });
      else if (connected && nc) violations.push({ type: 'nc', sev: 'warn', x: p2.x, y: p2.y, items: [s2], msg: `미연결 표시가 있는데 연결됨: ${name}` });
    }
    void sym;
  }

  const seen = new Set();
  for (const w of wires) {
    if (w[4].k !== 'wire') continue;
    for (const [x, y] of [[w[0], w[1]], [w[2], w[3]]]) {
      const k = key(x, y);
      if (seen.has(k)) continue;
      seen.add(k);
      const m = marks.get(k);
      if (ends.get(k) > 1 || pins.has(k) || (m && m.size) || onWire(x, y, w[4])) continue;
      // a labelled stub is a named connection, not a loose end
      if (labels.some((l) => distToSeg(l.x, l.y, w[0], w[1], w[2], w[3]) < 0.005)) continue;
      violations.push({ type: 'dangling', sev: 'warn', x, y, items: [w[4]], msg: `배선 끝이 어디에도 연결되지 않음 (${x}, ${y})` });
    }
  }

  for (const it of labels) {
    const k = key(it.x, it.y);
    if (ends.has(k) || pins.has(k) || onWire(it.x, it.y, null)) continue;
    violations.push({ type: 'label', sev: 'warn', x: it.x, y: it.y, items: [it], msg: `라벨이 배선이나 핀에 붙어 있지 않음: ${it.prims[it.prims.length - 1].text}` });
  }

  // ---- nets: wires that touch form one net; two different names on it is a conflict ----
  if (wires.length <= 4000) {
    const par = wires.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const on = (x, y, w) => distToSeg(x, y, w[0], w[1], w[2], w[3]) < 0.005;
    for (let i = 0; i < wires.length; i++) {
      const a = wires[i];
      for (let j = i + 1; j < wires.length; j++) {
        const b = wires[j];
        if ((a[4].k === 'bus') !== (b[4].k === 'bus')) continue;
        if (on(a[0], a[1], b) || on(a[2], a[3], b) || on(b[0], b[1], a) || on(b[2], b[3], a)) par[find(i)] = find(j);
      }
    }
    for (const [k, m] of marks) {
      if (!m.has('junction')) continue;
      const [jx, jy] = k.split(',').map((v) => v / 100);
      let first = -1;
      wires.forEach((w, i) => { if (w[4].k === 'wire' && on(jx, jy, w)) { if (first < 0) first = i; else par[find(i)] = find(first); } });
    }
    const names = new Map();
    const name = (x, y, text, power, item) => {
      const i = wires.findIndex((w) => w[4].k === 'wire' && on(x, y, w));
      if (i < 0 || !text) return;
      const r = find(i);
      let m = names.get(r);
      if (!m) names.set(r, (m = new Map()));
      if (!m.has(text)) m.set(text, { x, y, power, item });
    };
    for (const it of labels) if (it.kind === 'label' || it.kind === 'global_label') name(it.x, it.y, it.prims[it.prims.length - 1].text, false, it);
    for (const it of doc.items) if (it.k === 'symbol' && it.ref && it.ref[0] === '#' && it.value && !/PWR_FLAG/i.test(it.value + it.libId)) for (const p of it.pins) name(p.x, p.y, it.value, true, it);
    for (const m of names.values()) {
      if (m.size < 2) continue;
      const list = [...m.entries()];
      const powers = list.filter(([, v]) => v.power).length;
      const at = list[1][1];
      violations.push({ type: 'netname', sev: powers >= 2 ? 'error' : 'warn', x: at.x, y: at.y, items: list.map(([, v]) => v.item),
        msg: (powers >= 2 ? '서로 다른 전원이 한 배선으로 이어짐: ' : '한 배선에 이름이 여러 개: ') + list.map(([n]) => n).join(', ') });
    }
    // a wire running across a pin connects to it even though it does not end there
    for (const [k, arr] of pins) {
      if (ends.has(k)) continue;
      for (const { sym, pin } of arr) {
        if (pin.hidden || (sym.ref || '')[0] === '#') continue;
        const w = wires.find((q) => q[4].k === 'wire' && on(pin.x, pin.y, q));
        if (w) violations.push({ type: 'through', sev: 'warn', x: pin.x, y: pin.y, items: [sym, w[4]], msg: `배선이 핀 위를 지나가며 연결됨: ${sym.ref || '?'} 핀 ${pin.number} — 의도한 연결인지 확인하세요` });
      }
    }
  }

  const order = { duplicate: 0, netname: 1, pin: 2, through: 3, dangling: 4, label: 5, nc: 6, annotation: 7 };
  violations.sort((a, b) => order[a.type] - order[b.type]);
  return { kind: 'erc', violations, ratsnest: [], errors: violations.filter((v) => v.sev === 'error').length, ms: Date.now() - t0, rev: doc.rev || 0 };
}
