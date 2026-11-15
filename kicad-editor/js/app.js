import { parse, serialize } from './sexpr.js';
import { PcbDoc } from './pcb.js';
import { SchDoc } from './sch.js';
import { snap } from './draw.js';
import { analyze, DEFAULT_RULES, RULE_LABELS } from './conn.js';
import { analyzeSch } from './erc.js';

const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');
const stage = $('stage');

// `state` always mirrors the active tab; the fields in TAB_KEYS are swapped on tab change.
const state = {
  doc: null,
  fileName: '',
  handle: null,       // File System Access handle (desktop Chromium only)
  sel: [],
  undo: [],
  redo: [],
  dirty: false,
  padInfo: null,
  check: null,        // last DRC / ERC result
  marker: null,       // violation being looked at
  tool: 'select',
  pending: null,      // part chosen in the picker, waiting to be placed
  preview: null,      // polyline being drawn
};
const TAB_KEYS = ['doc', 'fileName', 'handle', 'sel', 'undo', 'redo', 'dirty', 'padInfo', 'check', 'marker'];
const tabs = [];
let cur = -1;
const view = { k: 4, tx: 0, ty: 0, dpr: 1, w: 0, h: 0 };

let rules = { ...DEFAULT_RULES };
let project = null;   // values read from a .kicad_pro: { name, width, viaSize, viaDrill }
try { Object.assign(rules, JSON.parse(localStorage.getItem('kicad-pad-rules') || '{}')); } catch (e) { /* defaults */ }
try { project = JSON.parse(localStorage.getItem('kicad-pad-project') || 'null'); } catch (e) { /* none */ }
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };

const isBoard = (doc) => doc && doc.kind === 'pcb' && !doc.isFootprintFile;
const isFp = (doc) => doc && doc.kind === 'pcb' && doc.isFootprintFile;
const isSheet = (doc) => doc && doc.kind === 'sch' && !doc.isLibFile;

// ---------- documents and tabs ----------

export function makeDoc(text) {
  const root = parse(text);
  switch (root.h) {
    case 'kicad_pcb': case 'footprint': case 'module': return new PcbDoc(root);
    case 'kicad_sch': case 'kicad_symbol_lib': return new SchDoc(root);
  }
  throw new Error('지원하지 않는 파일입니다 (' + root.h + '). KiCad 6 이상의 .kicad_sch / .kicad_pcb / .kicad_mod / .kicad_sym 파일을 열어 주세요.');
}

function initDoc(doc) {
  if (doc.kind !== 'pcb') return;
  if (doc.isFootprintFile) doc.route = { layer: doc.layerNames.includes('F.SilkS') ? 'F.SilkS' : doc.layerNames[0] };
  else {
    const d = doc.defaults();
    doc.route = { layer: doc.copper[0] || 'F.Cu', width: d.width, viaSize: d.viaSize, viaDrill: d.viaDrill };
    const hasTracks = doc.items.some((it) => it.k === 'seg');
    if (project && !hasTracks) Object.assign(doc.route, { width: project.width || d.width, viaSize: project.viaSize || d.viaSize, viaDrill: project.viaDrill || d.viaDrill });
  }
}

function stash() {
  if (cur < 0 || !tabs[cur]) return;
  const t = tabs[cur];
  for (const k of TAB_KEYS) t[k] = state[k];
  t.view = { k: view.k, tx: view.tx, ty: view.ty };
}

function activate(i) {
  stash();
  close3D();
  cur = i;
  const t = tabs[i];
  for (const k of TAB_KEYS) state[k] = t[k];
  state.preview = null;
  const doc = state.doc;
  document.body.classList.add('has-doc');
  document.body.classList.toggle('is-sch', isSheet(doc));
  document.body.classList.toggle('is-pcb', isBoard(doc));
  document.body.classList.toggle('is-fp', isFp(doc));
  const gs = $('gridSel');
  gs.innerHTML = '';
  for (const g of doc.gridOptions) gs.add(new Option(g + ' mm', g, false, g === doc.grid));
  const ss = $('symSel');
  ss.hidden = !doc.isLibFile;
  if (doc.isLibFile) {
    ss.innerHTML = '';
    for (const s of doc.symbolNames) ss.add(new Option(s, s, false, s === doc.currentSymbol));
  }
  const ls = $('layerSel');
  ls.innerHTML = '';
  if (doc.kind === 'pcb') {
    for (const l of (doc.isFootprintFile ? doc.layerNames : doc.copper)) ls.add(new Option(l, l, false, l === doc.route.layer));
    if (!doc.isFootprintFile) $('widthInp').value = doc.route.width;
  }
  setTool('select');
  if (window.innerWidth > 760) $('panel').hidden = false;
  if (!isBoard(doc) && !isSheet(doc) && (!$('checkBody').hidden || !$('partsBody').hidden)) showPanel('props');
  if (isSheet(doc) && !$('layersBody').hidden) showPanel('props');
  resize();
  if (t.view) Object.assign(view, t.view); else fit();
  if (!state.check || state.check.rev !== (doc.rev || 0)) runCheck();
  refreshUi();
}

function loadText(text, name, handle) {
  let doc;
  try {
    PcbDoc.savedVisibility = null;
    doc = makeDoc(text);
  } catch (e) {
    toast(e.message || String(e), true);
    return false;
  }
  initDoc(doc);
  stash();
  tabs.push({ doc, fileName: name, handle: handle || null, sel: [], undo: [], redo: [], dirty: false, padInfo: null, check: null, marker: null, view: null });
  activate(tabs.length - 1);
  return true;
}

function closeTab(i) {
  stash();
  const t = tabs[i];
  if (t.dirty && !confirm(t.fileName + ' — 저장하지 않은 변경 사항이 있습니다. 닫을까요?')) return;
  tabs.splice(i, 1);
  if (!tabs.length) {
    cur = -1;
    close3D();
    Object.assign(state, { doc: null, fileName: '', handle: null, sel: [], undo: [], redo: [], dirty: false, padInfo: null, check: null, marker: null });
    document.body.classList.remove('has-doc', 'is-sch', 'is-pcb', 'is-fp');
    $('panel').hidden = true;
    document.title = 'KiCad Pad Editor';
    renderTabs();
    resize();
    return;
  }
  const next = i < cur ? cur - 1 : Math.min(cur === i ? i : cur, tabs.length - 1);
  cur = -1;
  activate(next);
}

async function openFile(file, handle) {
  const text = await file.text();
  if (/\.kicad_pro$/i.test(file.name) || text.trimStart()[0] === '{') { loadProject(text, file.name); return; }
  if (loadText(text, file.name, handle)) saveDraft();
}

// A KiCad project file carries the design rules; take the ones this app checks.
function loadProject(text, name) {
  let j;
  try { j = JSON.parse(text); } catch (e) { toast('프로젝트 파일(.kicad_pro)을 읽을 수 없습니다', true); return; }
  const r = (j.board && j.board.design_settings && j.board.design_settings.rules) || {};
  const classes = (j.net_settings && j.net_settings.classes) || [];
  const cls = classes.find((c) => c.name === 'Default') || classes[0] || {};
  const pos = (v) => (typeof v === 'number' && v > 0 ? v : null);
  const next = {
    clearance: Math.max(pos(r.min_clearance) || 0, pos(cls.clearance) || 0) || null,
    trackWidth: pos(r.min_track_width),
    viaSize: pos(r.min_via_diameter),
    viaDrill: pos(r.min_through_hole_diameter),
    annular: pos(r.min_via_annular_width),
    edge: typeof r.min_copper_edge_clearance === 'number' && r.min_copper_edge_clearance >= 0 ? r.min_copper_edge_clearance : null,
  };
  const got = Object.entries(next).filter(([, v]) => v !== null);
  if (!got.length && !pos(cls.track_width)) { toast('이 프로젝트 파일에는 읽을 수 있는 설계 규칙이 없습니다', true); return; }
  for (const [k, v] of got) rules[k] = v;
  project = { name, width: pos(cls.track_width), viaSize: pos(cls.via_diameter), viaDrill: pos(cls.via_drill), netClasses: classes.length };
  store('kicad-pad-rules', rules);
  store('kicad-pad-project', project);
  stash();
  for (const t of tabs) {
    if (!isBoard(t.doc)) continue;
    if (project.width) t.doc.route.width = project.width;
    if (project.viaSize) t.doc.route.viaSize = project.viaSize;
    if (project.viaDrill) t.doc.route.viaDrill = project.viaDrill;
    t.check = null;
  }
  if (state.doc) {
    state.check = null;
    if (isBoard(state.doc)) $('widthInp').value = state.doc.route.width;
    runCheck();
    if (isBoard(state.doc)) showPanel('check');
    refreshUi();
  }
  toast(`규칙을 불러왔습니다 (${name}): 간격 ${rules.clearance} · 배선 폭 ${rules.trackWidth} · 비아 ${rules.viaSize}/${rules.viaDrill} mm`);
}

function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast('내려받았습니다: ' + name);
}

const csv = (rows) => rows.map((r) => r.map((c) => { const v = String(c ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\r\n') + '\r\n';

function exportBom() {
  const groups = new Map();
  for (const p of state.doc.parts()) {
    const ref = p.ref.replace(/ \(유닛 \d+\)$/, '');
    const key = p.value + '\u0000' + p.footprint;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { refs: new Set(), value: p.value, footprint: p.footprint, kind: p.kind }));
    g.refs.add(ref);
  }
  const rows = [['Reference', 'Qty', 'Value', 'Footprint', 'Type']];
  for (const g of groups.values()) rows.push([[...g.refs].join(', '), g.refs.size, g.value, g.footprint, g.kind]);
  downloadText(state.fileName.replace(/\.[^.]+$/, '') + '-bom.csv', csv(rows));
}

function exportPositions() {
  const rows = [['Ref', 'Val', 'Package', 'PosX', 'PosY', 'Rot', 'Side']];
  for (const p of state.doc.parts()) rows.push([p.ref, p.value, p.footprint.split(':').pop(), p.x.toFixed(4), p.y.toFixed(4), p.ang.toFixed(1), p.side]);
  downloadText(state.fileName.replace(/\.[^.]+$/, '') + '-pos.csv', csv(rows));
}

async function openSample(name) {
  try {
    const res = await fetch('./samples/' + name);
    if (!res.ok) throw new Error('예제 파일을 불러오지 못했습니다');
    loadText(await res.text(), name);
  } catch (e) { toast(e.message, true); }
}

// ---------- saving ----------

function currentText() { return serialize(state.doc.root); }

async function save() {
  if (!state.doc) return;
  const text = currentText();
  try {
    if (state.handle && state.handle.createWritable) {
      const w = await state.handle.createWritable();
      await w.write(text);
      await w.close();
      markSaved('저장했습니다: ' + state.fileName);
      return;
    }
    if (window.showSaveFilePicker) {
      const h = await window.showSaveFilePicker({ suggestedName: state.fileName });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      state.handle = h;
      state.fileName = h.name;
      markSaved('저장했습니다: ' + h.name);
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = state.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  markSaved('내려받았습니다: ' + state.fileName + ' (파일 앱 › 다운로드)');
}

async function share() {
  if (!state.doc) return;
  try {
    await navigator.share({ files: [new File([currentText()], state.fileName, { type: 'text/plain' })], title: state.fileName });
    markSaved('공유했습니다');
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('공유할 수 없습니다. “저장”을 사용해 주세요.', true);
  }
}

function markSaved(msg) {
  state.dirty = false;
  refreshUi();
  toast(msg);
}

// Draft kept in IndexedDB so an accidental reload does not lose work.
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('kicad-pad', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv(mode, fn) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { return undefined; }
}
let draftTimer = 0;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!state.doc) return;
    kv('readwrite', (s) => s.put({ name: state.fileName, text: currentText(), dirty: state.dirty, at: Date.now() }, 'draft'));
  }, 600);
}

// ---------- undo ----------

function checkpoint() {
  state.undo.push(currentText());
  let total = 0;
  for (const s of state.undo) total += s.length;
  while (state.undo.length > 60 || (total > 80e6 && state.undo.length > 1)) total -= state.undo.shift().length;
  state.redo = [];
  state.dirty = true;
}

function restoreText(text) {
  const old = state.doc;
  if (old.kind === 'pcb') PcbDoc.savedVisibility = Object.fromEntries(old.layers.map((l) => [l.name, l.visible]));
  const doc = makeDoc(text);
  doc.grid = old.grid;
  if (old.kind === 'pcb') { doc.showZoneFill = old.showZoneFill; doc.showPadLabels = old.showPadLabels; doc.showValues = old.showValues; doc.hlNet = old.hlNet; doc.route = old.route; }
  if (old.isLibFile) doc.showLibSymbol(old.currentSymbol);
  state.doc = doc;
  state.sel = [];
  state.padInfo = null;
  state.check = null;
  state.marker = null;
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(currentText());
  restoreText(state.undo.pop());
  state.dirty = true;
  changed();
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(currentText());
  restoreText(state.redo.pop());
  state.dirty = true;
  changed();
}

function changed() {
  saveDraft();
  state.marker = null;
  scheduleCheck();
  refreshUi();
}

// ---------- connection / rule checks ----------

let checkTimer = 0;
function runCheck() {
  clearTimeout(checkTimer);
  const doc = state.doc;
  if (isBoard(doc)) state.check = analyze(doc, rules);
  else if (isSheet(doc)) state.check = analyzeSch(doc);
  else state.check = null;
  return state.check;
}
function scheduleCheck() {
  clearTimeout(checkTimer);
  const doc = state.doc;
  if (!isBoard(doc) && !isSheet(doc)) return;
  checkTimer = setTimeout(() => { if (state.doc === doc) { runCheck(); refreshUi(); } }, doc.items.length > 4000 ? 700 : 200);
}
const checkFresh = () => state.check && state.doc && state.check.rev === (state.doc.rev || 0);

function gotoViolation(v) {
  state.marker = v;
  state.sel = v.items.filter((it) => state.doc.items.includes(it)).slice(0, 1);
  const k = Math.max(view.k, state.doc.kind === 'pcb' ? 14 : 7);
  view.k = k;
  view.tx = view.w / 2 - v.x * k;
  view.ty = view.h / 2 - v.y * k;
  refreshUi();
}

// ---------- view ----------

function resize() {
  const r = stage.getBoundingClientRect();
  view.dpr = Math.min(window.devicePixelRatio || 1, 3);
  view.w = r.width;
  view.h = r.height;
  cv.width = Math.max(1, Math.round(r.width * view.dpr));
  cv.height = Math.max(1, Math.round(r.height * view.dpr));
  requestDraw();
}

function fit() {
  if (!state.doc) return;
  const b = state.doc.bounds();
  const bw = Math.max(b[2] - b[0], 1), bh = Math.max(b[3] - b[1], 1);
  const m = 28;
  view.k = Math.min((view.w - 2 * m) / bw, (view.h - 2 * m) / bh);
  if (!(view.k > 0)) view.k = 4;
  view.k = Math.min(view.k, 60);
  view.tx = view.w / 2 - ((b[0] + b[2]) / 2) * view.k;
  view.ty = view.h / 2 - ((b[1] + b[3]) / 2) * view.k;
  requestDraw();
}

function zoomAt(sx, sy, factor) {
  const k = Math.min(Math.max(view.k * factor, 0.2), 4000);
  const f = k / view.k;
  view.tx = sx - (sx - view.tx) * f;
  view.ty = sy - (sy - view.ty) * f;
  view.k = k;
  requestDraw();
}

const toWorld = (sx, sy) => [(sx - view.tx) / view.k, (sy - view.ty) / view.k];

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function draw() {
  const doc = state.doc;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = doc ? doc.background : '#10151d';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!doc) return;
  const d = view.dpr;
  ctx.setTransform(d * view.k, 0, 0, d * view.k, d * view.tx, d * view.ty);
  drawGrid(doc);
  doc.draw(ctx, view, state.sel);
  const px = 1 / view.k;

  if (checkFresh()) {
    const c = state.check;
    if (c.ratsnest.length) {
      ctx.beginPath();
      for (const r of c.ratsnest) { ctx.moveTo(r[0], r[1]); ctx.lineTo(r[2], r[3]); }
      ctx.lineWidth = 1.2 * px;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.lineWidth = 2 * px;
    let n = 0;
    for (const v of c.violations) {
      if (v.type === 'unconnected') continue;
      if (++n > 250) break;
      ctx.beginPath();
      ctx.arc(v.x, v.y, 7 * px, 0, Math.PI * 2);
      ctx.strokeStyle = v.sev === 'error' ? '#ff4d4f' : '#e0a100';
      ctx.stroke();
    }
  }
  if (state.marker) {
    const v = state.marker;
    ctx.beginPath();
    ctx.arc(v.x, v.y, 15 * px, 0, Math.PI * 2);
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = '#ffd24d';
    ctx.stroke();
  }

  const hs = state.sel.length === 1 ? doc.handles(state.sel[0]) : [];
  for (const [hx, hy] of hs) {
    ctx.beginPath();
    ctx.arc(hx, hy, 6 * px, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = '#e8590c';
    ctx.stroke();
  }
  if (state.preview) {
    const p = state.preview;
    ctx.beginPath();
    ctx.moveTo(p.pts[0], p.pts[1]);
    for (let i = 2; i < p.pts.length; i += 2) ctx.lineTo(p.pts[i], p.pts[i + 1]);
    ctx.lineWidth = Math.max(p.w || 0, 2 * px);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = p.color || '#e8590c';
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawGrid(doc) {
  if (doc.kind !== 'sch') return;
  let g = doc.grid;
  while (g * view.k < 9) g *= 2;
  const [x0, y0] = toWorld(0, 0);
  const [x1, y1] = toWorld(view.w, view.h);
  const s = 1.2 / view.k;
  ctx.fillStyle = 'rgba(60, 60, 80, 0.28)';
  for (let x = Math.ceil(x0 / g) * g; x < x1; x += g) {
    for (let y = Math.ceil(y0 / g) * g; y < y1; y += g) ctx.fillRect(x - s / 2, y - s / 2, s, s);
  }
}

// ---------- drawing tools (wire / track / footprint line) ----------

const DRAW_TOOLS = new Set(['wire', 'route', 'fpline']);

// KiCad-style posture: 45° first, then straight.
function bend45(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const d = Math.min(Math.abs(dx), Math.abs(dy));
  if (d < 1e-6 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6) return [x1, y1, x2, y2];
  return [x1, y1, x1 + Math.sign(dx) * d, y1 + Math.sign(dy) * d, x2, y2];
}

function drawStart(g, tol) {
  const doc = state.doc;
  if (state.tool === 'route') {
    g.a0 = doc.anchorAt(g.wx, g.wy, tol, doc.route.layer);
    if (g.a0 && g.a0.net) {   // light up everything on this net: these are the places it may go
      g.hl = { prev: doc.hlNet };
      doc.hlNet = g.a0.net;
      $('hint').textContent = `${g.a0.name || '시작점'} · 네트 ${g.a0.net} — 밝게 표시된 곳이 같은 네트입니다`;
    }
    g.p0 = g.a0 ? [g.a0.x, g.a0.y] : [snap(g.wx, doc.grid), snap(g.wy, doc.grid)];
  } else g.p0 = [snap(g.wx, doc.grid), snap(g.wy, doc.grid)];
}

function drawMove(g, wx, wy, tol) {
  const doc = state.doc;
  if (state.tool === 'route') {
    g.a1 = doc.anchorAt(wx, wy, tol, doc.route.layer);
    const p1 = g.a1 ? [g.a1.x, g.a1.y] : [snap(wx, doc.grid), snap(wy, doc.grid)];
    const layer = doc.layers.find((l) => l.name === doc.route.layer);
    state.preview = { pts: bend45(g.p0[0], g.p0[1], p1[0], p1[1]), w: doc.route.width, color: layer ? layer.color : '#e8590c' };
  } else if (state.tool === 'wire') {
    const x = snap(wx, doc.grid), y = snap(wy, doc.grid);
    state.preview = { pts: [g.p0[0], g.p0[1], x, g.p0[1], x, y] };
  } else {
    state.preview = { pts: [g.p0[0], g.p0[1], snap(wx, doc.grid), snap(wy, doc.grid)] };
  }
}

function routeDone(g) {
  if (!g || !g.hl) return;
  state.doc.hlNet = g.hl.prev;
  g.hl = null;
  $('hint').textContent = HINTS[state.tool] || '';
}

function drawEnd(g) {
  const doc = state.doc;
  routeDone(g);
  const p = state.preview;
  state.preview = null;
  if (!p) return;
  const pts = p.pts;
  if (Math.hypot(pts[pts.length - 2] - pts[0], pts[pts.length - 1] - pts[1]) < 1e-6) { requestDraw(); return; }
  checkpoint();
  const made = [];
  if (state.tool === 'route') {
    const n0 = g.a0 && g.a0.net, n1 = g.a1 && g.a1.net;
    const net = n0 || n1 || null;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const it = doc.addTrack(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], doc.route.width, doc.route.layer, net);
      if (it) made.push(it);
    }
    changed();
    const res = runCheck();
    const bad = res.violations.find((v) => v.type !== 'unconnected' && v.items.some((it) => made.includes(it)));
    if (bad) { state.marker = bad; toast('DRC: ' + bad.msg, true); }
    else if (n0 && n1 && n0 !== n1) toast(`서로 다른 네트를 이었습니다: ${n0} ↔ ${n1}`, true);
    else if (!net) toast('네트가 없는 배선입니다. 패드나 기존 배선에서 시작하면 네트가 지정됩니다.');
    else toast(`${net}: ${(g.a0 && g.a0.name) || '시작점'} → ${(g.a1 && g.a1.name) || '끝점'} · DRC 통과`);
    refreshUi();
    return;
  }
  for (let i = 0; i + 3 < pts.length; i += 2) {
    if (state.tool === 'wire') doc.addWire(pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
    else doc.addFpLine(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], doc.route.layer);
  }
  changed();
}

// ---------- pointer input ----------

const pointers = new Map();
let gesture = null;

function localPos(e) {
  const r = cv.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
const tolFor = (touch) => (touch ? 14 : 7) / view.k;

cv.addEventListener('pointerdown', (e) => {
  if (!state.doc) return;
  cv.setPointerCapture(e.pointerId);
  const [sx, sy] = localPos(e);
  pointers.set(e.pointerId, [sx, sy]);
  if (pointers.size === 2) {
    endGesture(true);
    const [a, b] = [...pointers.values()];
    gesture = { mode: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 };
    return;
  }
  if (pointers.size > 2) return;
  const [wx, wy] = toWorld(sx, sy);
  const doc = state.doc;
  const touch = e.pointerType === 'touch';
  const tol = tolFor(touch);
  let mode = 'pan';
  let handle = -1;
  if (e.button === 1 || e.button === 2) mode = 'pan';
  else if (DRAW_TOOLS.has(state.tool)) mode = 'draw';
  else if (state.tool !== 'select') mode = 'place';
  else if (state.sel.length === 1) {
    const it = state.sel[0];
    const hs = doc.handles(it);
    for (let i = 0; i < hs.length; i++) {
      if (Math.hypot(hs[i][0] - wx, hs[i][1] - wy) <= tol * 1.2) { handle = i; break; }
    }
    if (handle >= 0) mode = 'handle';
    else if (doc.canMove(it) && doc.hitAll(wx, wy, tol).includes(it)) mode = 'move';
  }
  gesture = { mode, handle, sx, sy, wx, wy, lastX: sx, lastY: sy, moved: false, applied: [0, 0], touch, started: false };
  if (mode === 'draw') drawStart(gesture, tol);
});

cv.addEventListener('pointermove', (e) => {
  if (!state.doc) return;
  const [sx, sy] = localPos(e);
  if (!pointers.has(e.pointerId)) { showCoords(sx, sy); return; }
  pointers.set(e.pointerId, [sx, sy]);
  if (!gesture) return;
  const doc = state.doc;
  if (gesture.mode === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
    view.tx += cx - gesture.cx;
    view.ty += cy - gesture.cy;
    if (gesture.d > 0) zoomAt(cx, cy, d / gesture.d);
    gesture.d = d; gesture.cx = cx; gesture.cy = cy;
    requestDraw();
    return;
  }
  const g = gesture;
  if (!g.moved) {
    if (Math.hypot(sx - g.sx, sy - g.sy) < (g.touch ? 8 : 4)) return;
    g.moved = true;
  }
  const [wx, wy] = toWorld(sx, sy);
  if (g.mode === 'pan') {
    view.tx += sx - g.lastX;
    view.ty += sy - g.lastY;
    g.lastX = sx; g.lastY = sy;
    requestDraw();
  } else if (g.mode === 'move') {
    const dx = snap(wx - g.wx, doc.grid), dy = snap(wy - g.wy, doc.grid);
    const ddx = dx - g.applied[0], ddy = dy - g.applied[1];
    if (ddx || ddy) {
      if (!g.started) { checkpoint(); g.started = true; }
      for (const it of state.sel) doc.moveBy(it, ddx, ddy);
      g.applied = [dx, dy];
      requestDraw();
    }
  } else if (g.mode === 'handle') {
    if (!g.started) { checkpoint(); g.started = true; }
    let x = snap(wx, doc.grid), y = snap(wy, doc.grid);
    const it = state.sel[0];
    if (it.k === 'seg') {   // track ends snap onto pads, vias and other track ends
      const a = doc.anchorAt(wx, wy, tolFor(g.touch), it.layer);
      const other = g.handle === 0 ? [it.x2, it.y2] : [it.x1, it.y1];
      if (a && Math.hypot(a.x - other[0], a.y - other[1]) > 1e-6) { x = a.x; y = a.y; }
    }
    doc.moveHandle(it, g.handle, x, y);
    requestDraw();
  } else if (g.mode === 'draw') {
    drawMove(g, wx, wy, tolFor(g.touch));
    requestDraw();
  }
  showCoords(sx, sy);
});

function endGesture(cancel) {
  const g = gesture;
  gesture = null;
  if (!g) return;
  if (g.mode === 'draw') {
    if (cancel) { routeDone(g); state.preview = null; requestDraw(); } else drawEnd(g);
  } else if ((g.mode === 'move' || g.mode === 'handle') && g.started) changed();
}

function pointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  const [sx, sy] = localPos(e);
  pointers.delete(e.pointerId);
  const g = gesture;
  if (!g) return;
  if (g.mode === 'pinch') { if (pointers.size < 2) gesture = null; return; }
  if (!g.moved && e.type === 'pointerup') { gesture = null; routeDone(g); state.preview = null; tap(sx, sy, g); return; }
  endGesture(e.type !== 'pointerup');
}
cv.addEventListener('pointerup', pointerUp);
cv.addEventListener('pointercancel', pointerUp);
cv.addEventListener('contextmenu', (e) => e.preventDefault());

cv.addEventListener('wheel', (e) => {
  if (!state.doc) return;
  e.preventDefault();
  const [sx, sy] = localPos(e);
  if (e.ctrlKey || Math.abs(e.deltaY) >= 40 || e.deltaMode) {
    zoomAt(sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016) * (e.deltaMode ? 30 : 1)));
  } else {
    view.tx -= e.deltaX;
    view.ty -= e.deltaY;
    requestDraw();
  }
}, { passive: false });

// Safari trackpad pinch
let gScale = 1;
cv.addEventListener('gesturestart', (e) => { e.preventDefault(); gScale = 1; });
cv.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (pointers.size) return;
  const [sx, sy] = localPos(e);
  zoomAt(sx, sy, e.scale / gScale);
  gScale = e.scale;
});

async function tap(sx, sy, g) {
  const doc = state.doc;
  const [wx, wy] = toWorld(sx, sy);
  const gx = snap(wx, doc.grid), gy = snap(wy, doc.grid);
  const tool = state.tool;
  if (tool === 'select') {
    const hits = doc.hitAll(wx, wy, tolFor(g.touch));
    let pick = hits[0] || null;
    if (state.sel.length === 1 && hits.length > 1) {
      const i = hits.indexOf(state.sel[0]);
      if (i >= 0) pick = hits[(i + 1) % hits.length];
    }
    state.sel = pick ? [pick] : [];
    state.marker = null;
    state.padInfo = pick && doc.kind === 'pcb' ? doc.padAt(pick, wx, wy) : null;
    if (pick && window.innerWidth > 760 && $('checkBody').hidden) showPanel('props');
    refreshUi();
    return;
  }
  if (tool === 'place-part') {
    const c = state.pending;
    if (!c) { setTool('select'); return; }
    checkpoint();
    let it = null;
    try { it = isSheet(doc) ? doc.placeSymbol(c.node, c.full, gx, gy) : doc.placeFootprint(c.node, c.nick, gx, gy); }
    catch (e) { toast('부품을 놓지 못했습니다: ' + (e.message || e), true); }
    state.sel = it ? [it] : [];
    setTool('select', true);
    changed();
    if (it) toast(`${it.ref} 추가` + (isBoard(doc) ? ' — 패드를 탭해 네트를 지정하세요' : ''));
    return;
  }
  if (tool === 'junction') { checkpoint(); doc.addJunction(gx, gy); changed(); return; }
  if (tool === 'nc') { checkpoint(); doc.addNoConnect(gx, gy); changed(); return; }
  if (tool === 'pad') { checkpoint(); const it = doc.addPad(gx, gy); state.sel = it ? [it] : []; setTool('select', true); changed(); return; }
  if (tool === 'via') {
    const r = doc.route;
    const a = doc.anchorAt(wx, wy, tolFor(g.touch), r.layer);
    const x = a ? a.x : gx, y = a ? a.y : gy;
    const net = (a && a.net) || doc.netAt(x, y, r.layer);
    checkpoint();
    const it = doc.addVia(x, y, r.viaSize, r.viaDrill, net);
    const first = doc.copper[0], last = doc.copper[doc.copper.length - 1];
    r.layer = r.layer === first ? last : first;
    $('layerSel').value = r.layer;
    changed();
    const res = runCheck();
    const bad = res.violations.find((v) => v.type !== 'unconnected' && v.items.includes(it));
    if (bad) { state.marker = bad; toast('DRC: ' + bad.msg, true); }
    else toast(`비아 추가${net ? ' (' + net + ')' : ''} · 이제 ${r.layer} 에 배선합니다`);
    refreshUi();
    return;
  }
  if (tool === 'label' || tool === 'text') {
    const isLabel = tool === 'label';
    const text = await ask(isLabel ? '라벨 (네트 이름)' : '텍스트 내용', '');
    if (!text) return;
    checkpoint();
    const it = isLabel ? doc.addLabel(gx, gy, text.trim()) : doc.addText(gx, gy, text);
    setTool('select');
    state.sel = it ? [it] : [];
    changed();
  }
}

function showCoords(sx, sy) {
  if (!state.doc) return;
  const [wx, wy] = toWorld(sx, sy);
  $('status').textContent = `X ${wx.toFixed(2)}  Y ${wy.toFixed(2)} mm`;
}

// ---------- actions ----------

const HINTS = {
  wire: '끌어서 배선을 긋습니다 (가로 → 세로로 꺾임)',
  label: '라벨을 놓을 곳을 탭하세요',
  junction: '접점을 놓을 곳을 탭하세요',
  nc: '미연결 표시를 놓을 핀 끝을 탭하세요',
  text: '텍스트를 놓을 곳을 탭하세요',
  route: '패드·비아·배선 끝에서 끌어서 연결합니다 (끝점은 자동으로 붙습니다)',
  via: '비아를 놓을 곳을 탭하세요 — 놓은 뒤 반대쪽 면으로 전환됩니다',
  pad: '패드를 놓을 곳을 탭하세요 (직전 패드의 모양을 이어받습니다)',
  fpline: '끌어서 선을 긋습니다 — 레이어는 위에서 고릅니다',
};

// ----- part picker -----

const BASIC_LIB = { GND: 'power', '+5V': 'power', '+3V3': 'power', VCC: 'power', Conn_01x02: 'Connector_Generic', Conn_01x03: 'Connector_Generic',
  Conn_01x04: 'Connector_Generic', SW_Push: 'Switch' };
let basicSyms = null, basicFp = null;
const stem = (name) => name.replace(/\.[^.]+$/, '');

async function partChoices() {
  const doc = state.doc;
  const out = [];
  if (isSheet(doc)) {
    if (!basicSyms) {
      try { basicSyms = [...new SchDoc(parse(await (await fetch('./samples/basic.kicad_sym')).text())).libNodes]; } catch (e) { basicSyms = []; }
    }
    for (const [name, node] of basicSyms) out.push({ group: '기본 부품', label: name, sub: (BASIC_LIB[name] || 'Device') + ':' + name, node, full: (BASIC_LIB[name] || 'Device') + ':' + name });
    for (const o of doc.ownSymbols()) out.push({ group: '이 회로도에 쓰인 부품', label: o.name.split(':').pop(), sub: o.name, node: o.node, full: o.name });
    tabs.forEach((t) => {
      if (!t.doc.isLibFile) return;
      for (const [name, node] of t.doc.libNodes) {
        if (t.doc.libNodes.get(name) && !/\(extends /.test(node.src.slice(node.s, node.s + 200))) out.push({ group: '라이브러리 ' + t.fileName, label: name, sub: stem(t.fileName) + ':' + name, node, full: stem(t.fileName) + ':' + name });
      }
    });
  } else if (isBoard(doc)) {
    if (!basicFp) {
      try { basicFp = parse(await (await fetch('./samples/R_0805_demo.kicad_mod')).text()); } catch (e) { basicFp = null; }
    }
    tabs.forEach((t) => { if (isFp(t.doc)) out.push({ group: '열려 있는 풋프린트 파일', label: t.doc.fpName, sub: t.fileName, node: t.doc.root, nick: null }); });
    if (basicFp) out.push({ group: '예제', label: 'R_0805_demo', sub: '0805 저항 풋프린트', node: basicFp, nick: null });
  }
  return out;
}

async function openPicker() {
  const choices = await partChoices();
  const dlg = $('picker');
  const list = $('pickList');
  const input = $('pickInput');
  const board = isBoard(state.doc);
  $('pickNote').textContent = board
    ? '풋프린트 파일(.kicad_mod)을 “열기”로 탭에 열어 두면 이 목록에 나옵니다. 보드에 있는 부품은 선택 후 “복제”로 늘릴 수 있습니다. 놓은 뒤 패드를 탭해 네트를 지정하세요.'
    : '심볼 라이브러리(.kicad_sym)를 “열기”로 탭에 열어 두면 이 목록에 나옵니다.';
  const render = () => {
    const q = input.value.trim().toLowerCase();
    list.textContent = '';
    let group = null, n = 0;
    for (const c of choices) {
      if (q && !(c.label + ' ' + c.sub).toLowerCase().includes(q)) continue;
      if (++n > 300) break;
      if (c.group !== group) { group = c.group; list.append(el('div', { class: 'pick-group' }, group)); }
      list.append(el('button', { type: 'button', class: 'part', onclick() {
        dlg.close();
        state.pending = c;
        setTool('place-part');
      } }, el('b', null, c.label), el('span', null, c.sub)));
    }
    if (!n) list.append(el('p', { class: 'empty' }, '맞는 부품이 없습니다.'));
  };
  input.value = '';
  input.oninput = render;
  render();
  dlg.showModal();
}

function setTool(t, keepSel) {
  state.tool = t;
  state.preview = null;
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t || (t === 'place-part' && b.dataset.tool === 'part'));
  const h = $('hint');
  if (t === 'place-part' && state.pending) HINTS['place-part'] = state.pending.label + ' — 놓을 곳을 탭하세요';
  h.hidden = !HINTS[t];
  h.textContent = HINTS[t] || '';
  cv.style.cursor = t === 'select' ? 'default' : 'crosshair';
  if (t !== 'select' && !keepSel) { state.sel = []; refreshUi(); }
}

function rotateSel() {
  const doc = state.doc;
  const items = state.sel.filter((it) => doc.canRotate(it));
  if (!items.length) return;
  checkpoint();
  for (const it of items) doc.rotate(it);
  changed();
}

function deleteSel() {
  const doc = state.doc;
  if (!state.sel.length || doc.isLibFile) return;
  checkpoint();
  for (const it of state.sel) doc.remove(it);
  state.sel = [];
  state.padInfo = null;
  changed();
}

function showPanel(tab) {
  const p = $('panel');
  p.hidden = false;
  if (tab) {
    for (const b of p.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
    $('propsBody').hidden = tab !== 'props';
    $('layersBody').hidden = tab !== 'layers';
    $('checkBody').hidden = tab !== 'check';
    $('partsBody').hidden = tab !== 'parts';
  }
  resize();
}

// 3D view (three.js is only loaded when first opened)
let v3 = null;
function close3D() {
  if (v3) { v3.dispose(); v3 = null; }
  $('view3d').hidden = true;
}
async function toggle3D() {
  if (v3) { close3D(); return; }
  if (!isBoard(state.doc)) return;
  const host = $('view3d');
  host.hidden = false;
  try {
    const mod = await import('./view3d.js');
    v3 = mod.open3D(state.doc, host);
    $('v3parts').classList.add('on');
  } catch (e) {
    host.hidden = true;
    toast('3D 보기를 열 수 없습니다: ' + (e.message || e), true);
  }
}

const actions = {
  open() {
    if (window.showOpenFilePicker) {
      window.showOpenFilePicker({ multiple: true }).then(async (hs) => { for (const h of hs) await openFile(await h.getFile(), h); }).catch(() => {});
    } else $('fileInput').click();
  },
  save, share, undo, redo, fit,
  rotate: rotateSel,
  delete: deleteSel,
  panel() { const p = $('panel'); p.hidden = !p.hidden; resize(); },
  check() { runCheck(); showPanel('check'); refreshUi(); },
  view3d: toggle3D,
  v3iso() { if (v3) v3.look('iso'); },
  v3top() { if (v3) v3.look('top'); },
  v3bottom() { if (v3) v3.look('bottom'); },
  v3parts() { if (v3) $('v3parts').classList.toggle('on', v3.toggleParts()); },
  async restore() {
    const d = await kv('readonly', (s) => s.get('draft'));
    if (d && loadText(d.text, d.name)) { state.dirty = !!d.dirty; refreshUi(); }
  },
};

function fire(t) {
  if (t.dataset.act) actions[t.dataset.act]();
  else if (t.dataset.tool === 'part') openPicker();
  else if (t.dataset.tool) setTool(t.dataset.tool);
  else if (t.dataset.tab) showPanel(t.dataset.tab);
  else if (t.dataset.sample) openSample(t.dataset.sample);
  else if (t.dataset.doc) activate(+t.dataset.doc);
  else if (t.dataset.close) closeTab(+t.dataset.close);
}
const CLICKABLE = '[data-act],[data-tool],[data-tab],[data-sample],[data-doc],[data-close]';

// Touch browsers can swallow the click of a tap that quickly follows another
// touch (e.g. undo right after a drag), so finger/pencil taps on buttons are
// handled on pointerup. File actions keep the native click they require.
const NEEDS_CLICK = new Set(['open', 'save', 'share', 'restore']);
let press = null;
let handled = null;
document.addEventListener('pointerdown', (e) => {
  const t = e.pointerType === 'mouse' ? null : e.target.closest(CLICKABLE);
  press = t && !t.disabled && !t.dataset.sample && !NEEDS_CLICK.has(t.dataset.act) ? { t, x: e.clientX, y: e.clientY, id: e.pointerId } : null;
});
document.addEventListener('pointerup', (e) => {
  const p = press;
  press = null;
  if (!p || p.id !== e.pointerId || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 12) return;
  if (e.target.closest(CLICKABLE) !== p.t || p.t.disabled) return;
  handled = { at: performance.now(), x: e.clientX, y: e.clientY };
  fire(p.t);
});
document.addEventListener('pointercancel', () => { press = null; });

document.addEventListener('click', (e) => {
  const t = e.target.closest(CLICKABLE);
  if (!t) return;
  // the click that follows a tap already handled on pointerup (the button under
  // the finger may have been re-rendered since, so compare position, not element)
  if (handled && performance.now() - handled.at < 800 && Math.hypot(e.clientX - handled.x, e.clientY - handled.y) < 24) { handled = null; return; }
  fire(t);
});

$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) await openFile(f);
});
$('gridSel').addEventListener('change', (e) => { if (state.doc) { state.doc.grid = parseFloat(e.target.value); requestDraw(); } });
$('symSel').addEventListener('change', (e) => { state.doc.showLibSymbol(e.target.value); state.sel = []; fit(); refreshUi(); });
$('layerSel').addEventListener('change', (e) => {
  const doc = state.doc;
  if (!doc || !doc.route) return;
  doc.route.layer = e.target.value;
  const l = doc.layers.find((x) => x.name === e.target.value);
  if (l && !l.visible) { l.visible = true; refreshUi(); }
});
$('widthInp').addEventListener('change', (e) => {
  const doc = state.doc;
  const v = parseFloat(e.target.value.replace(',', '.'));
  if (doc && doc.route && v > 0) doc.route.width = v;
  if (doc && doc.route) e.target.value = doc.route.width;
});

window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
window.addEventListener('dragleave', () => document.body.classList.remove('drop'));
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('drop');
  for (const f of [...e.dataTransfer.files]) await openFile(f);
});

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea,select,dialog')) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'o') { e.preventDefault(); actions.open(); return; }
  const doc = state.doc;
  if (!doc) return;
  if (mod && k === 's') { e.preventDefault(); save(); }
  else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (mod) return;
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); }
  else if (k === 'r') rotateSel();
  else if (k === 'f') fit();
  else if (k === 'escape') { if (v3) close3D(); setTool('select'); state.sel = []; refreshUi(); }
  else if (isSheet(doc)) {
    const map = { w: 'wire', l: 'label', j: 'junction', q: 'nc', t: 'text' };
    if (map[k]) setTool(map[k]);
  } else if (isBoard(doc)) {
    if (k === 'x') setTool('route'); else if (k === 'v') setTool('via');
  }
});

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', (e) => {
  stash();
  if (tabs.some((t) => t.dirty)) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- UI rendering ----------

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
}

function fieldEl(f) {
  const wrap = el('label', { class: 'field' }, el('span', null, f.label));
  if (f.type === 'info') { wrap.append(el('div', { class: 'info' }, f.value)); return wrap; }
  if (f.type === 'link') { wrap.append(el('a', { class: 'info', href: f.value, target: '_blank', rel: 'noopener' }, f.value)); return wrap; }
  if (f.type === 'table') {
    const box = el('div', { class: 'field' }, el('span', null, f.label));
    const table = el('table', { class: 'pins' }, el('tr', null, ...f.head.map((h) => el('th', null, h))));
    for (const r of f.rows) table.append(el('tr', null, ...r.map((c) => el('td', null, c))));
    box.append(table);
    return box;
  }
  let input;
  if (f.type === 'select') {
    input = el('select');
    for (const o of f.options) input.add(new Option(o, o, false, o === f.value));
  } else if (f.type === 'textarea') {
    input = el('textarea', { rows: 3, spellcheck: 'false' });
    input.value = f.value;
  } else {
    input = el('input', { type: 'text', inputmode: f.type === 'number' ? 'decimal' : null, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    input.value = f.type === 'number' ? String(+(+f.value).toFixed(6)) : f.value;
  }
  input.addEventListener('change', () => {
    let v = input.value;
    if (f.type === 'number') {
      v = parseFloat(v.replace(',', '.'));
      if (!Number.isFinite(v)) { refreshUi(); return; }
    }
    if (!f.plain) checkpoint();
    f.set(v);
    if (!f.plain) changed();
  });
  if (f.type !== 'textarea') input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  wrap.append(input);
  return wrap;
}

const KIND_LABEL = (doc) => (doc.kind === 'sch' ? (doc.isLibFile ? '심볼' : '회로도') : (doc.isFootprintFile ? '풋프린트' : 'PCB'));

function renderTabs() {
  const nav = $('doctabs');
  nav.textContent = '';
  tabs.forEach((t, i) => {
    const dirty = i === cur ? state.dirty : t.dirty;
    const name = i === cur ? state.fileName : t.fileName;
    nav.append(el('div', { class: 'doctab' + (i === cur ? ' on' : '') },
      el('span', { class: 'kind' }, KIND_LABEL(t.doc)),
      el('button', { class: 'name', 'data-doc': i, title: name }, name, dirty ? el('span', { class: 'dirty' }, ' ●') : null),
      el('button', { class: 'x', 'data-close': i, title: '닫기' }, '×')));
  });
}

// The same part in another open file (schematic symbol <-> PCB footprint).
function crossProbe(it) {
  const want = it.k === 'symbol' ? 'fp' : it.k === 'fp' ? 'symbol' : null;
  if (!want || !it.ref || it.ref[0] === '#') return null;
  for (let i = 0; i < tabs.length; i++) {
    if (i === cur) continue;
    const other = tabs[i].doc.items.find((o) => o.k === want && o.ref === it.ref);
    if (other) return { i, other, label: want === 'fp' ? 'PCB에서 보기' : '회로도에서 보기' };
  }
  return null;
}

function renderProps() {
  const body = $('propsBody');
  const doc = state.doc;
  body.textContent = '';
  if (!doc) return;
  if (!state.sel.length) {
    body.append(el('h2', null, state.fileName));
    body.append(el('p', { class: 'empty' }, doc.summary() || ''));
    body.append(el('p', { class: 'empty' }, '항목을 탭하면 선택됩니다. 선택한 항목을 끌어서 옮기고, 여기에서 값을 고칠 수 있습니다. 같은 자리를 다시 탭하면 겹친 다른 항목으로 넘어갑니다.'));
    if (isBoard(doc)) {
      const r = doc.route;
      body.append(el('div', { class: 'row2' },
        fieldEl({ label: '새 비아 지름', type: 'number', value: r.viaSize, plain: true, set(v) { if (v > 0) r.viaSize = v; } }),
        fieldEl({ label: '새 비아 드릴', type: 'number', value: r.viaDrill, plain: true, set(v) { if (v > 0) r.viaDrill = v; } })));
      if (doc.hlNet) body.append(el('button', { class: 'panel-btn on', onclick() { doc.hlNet = null; refreshUi(); } }, '네트 강조 끄기: ' + doc.hlNet));
    }
    return;
  }
  const it = state.sel[0];
  body.append(el('h2', null, doc.title(it)));
  const fields = doc.props(it);
  for (let i = 0; i < fields.length; i++) {
    const a = fields[i], b = fields[i + 1];
    if (a.type === 'number' && b && b.type === 'number' && / X$/.test(a.label) && / Y$/.test(b.label)) {
      body.append(el('div', { class: 'row2' }, fieldEl(a), fieldEl(b)));
      i++;
    } else body.append(fieldEl(a));
  }
  if ((it.k === 'symbol' && isSheet(doc)) || (it.k === 'fp' && isBoard(doc))) {
    body.append(el('button', { class: 'panel-btn', onclick() {
      checkpoint();
      let copy;
      if (it.k === 'symbol') copy = doc.cloneSymbol(it, 0, snap(it.bb[3] - it.bb[1] + 5.08, 2.54));
      else copy = doc.cloneFootprint(it, snap(it.bb[2] - it.bb[0] + 1, doc.grid), 0);
      state.sel = copy ? [copy] : [];
      state.padInfo = null;
      changed();
      if (copy) toast(`${copy.ref} 로 복제했습니다` + (it.k === 'fp' ? ' — 패드 네트는 비어 있습니다' : ''));
    } }, '이 부품 복제'));
  }
  const probe = crossProbe(it);
  if (probe) {
    body.append(el('button', { class: 'panel-btn', onclick() {
      activate(probe.i);
      state.sel = [probe.other];
      const b = probe.other.bb;
      if (b) { view.tx = view.w / 2 - ((b[0] + b[2]) / 2) * view.k; view.ty = view.h / 2 - ((b[1] + b[3]) / 2) * view.k; }
      refreshUi();
    } }, probe.label + ': ' + it.ref));
  }
  if (doc.kind === 'pcb') {
    const pad = state.padInfo;
    if (pad) body.append(fieldEl({ label: '탭한 패드', type: 'info', value: pad.pad + (pad.net ? '  ·  네트 ' + pad.net : '  ·  연결 없음') }));
    if (pad && it.k === 'fp' && isBoard(doc)) {
      const NONE = '(연결 없음)', NEW = '+ 새 네트 만들기…';
      body.append(fieldEl({ label: `패드 ${pad.pad} 의 네트 지정`, type: 'select', options: [NONE, ...doc.netList(), NEW], value: pad.net || NONE, plain: true,
        async set(v) {
          let net = v === NONE ? null : v;
          if (v === NEW) { net = (await ask('새 네트 이름', '') || '').trim(); if (!net) { refreshUi(); return; } }
          checkpoint();
          doc.setPadNet(it, pad.pad, net);
          state.padInfo = { pad: pad.pad, net };
          changed();
        } }));
    }
    const net = (pad && pad.net) || it.net;
    if (net) {
      const on = doc.hlNet === net;
      body.append(el('button', { class: 'panel-btn' + (on ? ' on' : ''), onclick() { doc.hlNet = on ? null : net; refreshUi(); } },
        on ? '네트 강조 끄기' : '이 네트 강조: ' + net));
    }
  }
  // rule status of this one connection / part
  if (checkFresh() && (it.cu || it.k === 'symbol' || it.k === 'wire' || it.k === 'label')) {
    const vs = state.check.violations.filter((v) => v.items.includes(it));
    if (vs.length) {
      const box = el('div', { class: 'drc-bad' }, el('b', null, (state.check.kind === 'drc' ? 'DRC' : 'ERC') + ' 문제 ' + vs.length + '건'));
      for (const v of vs.slice(0, 6)) box.append(el('button', { class: 'viol' + (v.sev === 'warn' ? ' warn' : ''), onclick() { gotoViolation(v); } }, el('i'), v.msg));
      body.append(box);
    } else if (state.check.kind === 'drc') {
      const g = state.check.gap.get(it);
      const R = state.check.rules;
      body.append(el('div', { class: 'drc-ok' }, 'DRC 통과 · ' + (g !== undefined && g < Infinity
        ? `다른 네트와 가장 가까운 간격 ${g.toFixed(3)} mm (기준 ${R.clearance} mm)`
        : `주변 ${R.clearance} mm 안에 다른 네트 없음`)));
    } else body.append(el('div', { class: 'drc-ok' }, '연결 검사 통과'));
  }
  if (isBoard(doc) && (it.k === 'fp' || it.k === 'seg' || it.k === 'via')) {
    body.append(el('p', { class: 'note' }, '부품을 옮기거나 돌리면 패드에 붙은 배선 끝이 따라옵니다(배선이 비스듬해질 수 있으니 DRC를 확인하세요). 영역(zone) 채움은 다시 계산되지 않습니다.'));
  } else if (it.k === 'symbol') {
    body.append(el('p', { class: 'note' }, '심볼을 옮기거나 돌리면 핀에 붙은 배선 끝이 따라옵니다. 배선이 비스듬해지면 끝점을 끌어 정리하세요.'));
  }
}

function renderLayers() {
  const body = $('layersBody');
  const doc = state.doc;
  body.textContent = '';
  if (!doc || doc.kind !== 'pcb') return;
  const setAll = (fn) => { for (const l of doc.layers) l.visible = fn(l); refreshUi(); };
  body.append(el('div', { class: 'layer-tools' },
    el('button', { class: 'panel-btn', onclick: () => setAll(() => true) }, '모두'),
    el('button', { class: 'panel-btn', onclick: () => setAll((l) => /^F\.|Edge/.test(l.name)) }, '앞면'),
    el('button', { class: 'panel-btn', onclick: () => setAll((l) => /^B\.|Edge/.test(l.name)) }, '뒷면')));
  for (const l of doc.layers) {
    body.append(el('button', { class: 'layer' + (l.visible ? '' : ' off'), onclick() { l.visible = !l.visible; refreshUi(); } },
      el('i', { style: 'background:' + l.color }), l.name));
  }
  body.append(el('button', { class: 'panel-btn' + (doc.showPadLabels ? ' on' : ''), style: 'margin-top:10px', onclick() { doc.showPadLabels = !doc.showPadLabels; refreshUi(); } },
    doc.showPadLabels ? '패드 번호·네트 이름 표시 중' : '패드 번호·네트 이름 숨김'));
  if (!doc.isFootprintFile) {
    body.append(el('button', { class: 'panel-btn' + (doc.showValues ? ' on' : ''), onclick() { doc.showValues = !doc.showValues; refreshUi(); } },
      doc.showValues ? '부품 값 표시 중' : '부품 값 숨김'));
    body.append(el('button', { class: 'panel-btn' + (doc.showZoneFill ? ' on' : ''), style: 'margin-top:10px', onclick() { doc.showZoneFill = !doc.showZoneFill; refreshUi(); } },
      doc.showZoneFill ? '영역 채움 표시 중' : '영역 채움 숨김'));
  }
}

function selectAndShow(it) {
  state.sel = [it];
  state.marker = null;
  state.padInfo = null;
  const b = it.bb;
  if (b) {
    const k = Math.max(view.k, Math.min(40, 0.35 * Math.min(view.w, view.h) / Math.max(b[2] - b[0], b[3] - b[1], 1)));
    view.k = k;
    view.tx = view.w / 2 - ((b[0] + b[2]) / 2) * k;
    view.ty = view.h / 2 - ((b[1] + b[3]) / 2) * k;
  }
  refreshUi();
}

function renderParts() {
  const body = $('partsBody');
  const doc = state.doc;
  body.textContent = '';
  if (!doc || !doc.parts || (!isBoard(doc) && !isSheet(doc))) return;
  const parts = doc.parts();
  body.append(el('h2', null, '부품 목록 (' + parts.length + ')'));
  const tools = el('div', { class: 'layer-tools', style: 'grid-template-columns:1fr 1fr' }, el('button', { class: 'panel-btn', onclick: exportBom }, 'BOM 내보내기 (CSV)'));
  if (isBoard(doc)) tools.append(el('button', { class: 'panel-btn', onclick: exportPositions }, '부품 위치 (CSV)'));
  body.append(tools);
  body.append(el('p', { class: 'empty' }, '탭하면 그 부품으로 이동합니다. 종류는 참조 번호(R, C, U…)로 추정한 것입니다.'));
  for (const p of parts) {
    body.append(el('button', { class: 'part' + (state.sel[0] === p.item ? ' on' : ''), onclick() { selectAndShow(p.item); } },
      el('b', null, p.ref), el('span', null, p.value || '–'), el('em', null, p.kind)));
  }
}

function renderCheck() {
  const body = $('checkBody');
  const doc = state.doc;
  body.textContent = '';
  if (!doc || (!isBoard(doc) && !isSheet(doc))) return;
  const board = isBoard(doc);
  body.append(el('h2', null, board ? '설계 규칙 검사 (DRC)' : '연결 검사 (ERC)'));
  if (board) {
    const grid = el('div', { class: 'rules' });
    for (const key of Object.keys(DEFAULT_RULES)) {
      grid.append(fieldEl({ label: RULE_LABELS[key] + ' (mm)', type: 'number', value: rules[key], plain: true,
        set(v) {
          if (!(v >= 0)) return;
          rules[key] = v;
          store('kicad-pad-rules', rules);
          runCheck();
          refreshUi();
        } }));
    }
    body.append(grid);
  }
  if (board) body.append(el('p', { class: 'empty' }, project
    ? `규칙 출처: ${project.name}` + (project.netClasses > 1 ? ' (Default 넷클래스 기준 — 넷클래스별 규칙은 적용하지 않습니다)' : '')
    : '프로젝트 파일(.kicad_pro)을 “열기”로 열면 그 프로젝트의 규칙을 불러옵니다.'));
  const c = state.check;
  if (!c || !checkFresh()) { body.append(el('p', { class: 'empty' }, '검사 중…')); return; }
  const warns = c.violations.length - c.errors;
  let cls = 'check-sum', text;
  if (!c.violations.length) text = board ? '문제 없음 — 모든 연결이 이어져 있고 규칙을 지킵니다.' : '문제 없음 — 모든 핀과 배선이 연결되어 있습니다.';
  else {
    cls += c.errors ? ' bad' : ' warn';
    text = `오류 ${c.errors}건 · 경고 ${warns}건` + (board ? ` · 미연결 ${c.unconnected}곳` : '') + (c.truncated ? ' (앞의 일부만 표시)' : '');
  }
  body.append(el('div', { class: cls }, text));
  if (board && c.unfilledZones) {
    body.append(el('p', { class: 'note' }, `채워지지 않은 영역(zone) ${c.unfilledZones}개는 연결로 계산하지 않았습니다. KiCad에서 B 키로 채운 뒤 저장하면 반영됩니다.`));
  }
  for (const v of c.violations) {
    body.append(el('button', { class: 'viol' + (v.sev === 'warn' ? ' warn' : '') + (state.marker === v ? ' on' : ''), onclick() { gotoViolation(v); } }, el('i'), v.msg));
  }
  if (board) body.append(el('p', { class: 'empty', style: 'margin-top:12px' }, '구리 간격·단락·배선 폭·비아·외곽 간격·미연결을 확인하며, 영역 채움과 코트야드는 검사하지 않습니다.'));
}

function refreshUi() {
  const doc = state.doc;
  renderTabs();
  if (doc) {
    const it = state.sel[0];
    $('undoBtn').disabled = !state.undo.length;
    $('redoBtn').disabled = !state.redo.length;
    $('rotateBtn').disabled = !(it && doc.canRotate(it));
    $('deleteBtn').disabled = !it || !!doc.isLibFile;
    const info = $('fileInfo');
    info.textContent = '';
    let badge = null;
    if (checkFresh() && state.check.violations.length) badge = ' · 검사 ' + state.check.violations.length + '건';
    info.append(el('b', null, state.fileName, state.dirty ? el('span', { class: 'dirty' }, ' ●') : null), doc.summary() + (badge || ''));
    document.title = (state.dirty ? '● ' : '') + state.fileName + ' – KiCad Pad Editor';
  }
  renderProps();
  renderLayers();
  renderCheck();
  renderParts();
  requestDraw();
}

let toastTimer = 0;
function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.toggle('error', !!isError);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2600);
}

function ask(label, value) {
  const dlg = $('ask');
  $('askLabel').textContent = label;
  const input = $('askInput');
  input.value = value || '';
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value : null), { once: true });
    dlg.showModal();
    input.focus();
  });
}

// ---------- startup ----------

(async function init() {
  resize();
  new ResizeObserver(resize).observe(stage);
  try {
    if (navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.kicad_pcb', { type: 'text/plain' })] })) $('shareBtn').hidden = false;
  } catch (e) { /* share unsupported */ }
  const d = await kv('readonly', (s) => s.get('draft'));
  if (d && d.text) {
    $('restore').hidden = false;
    $('restoreBtn').textContent = '이어서 편집: ' + d.name + (d.dirty ? ' (저장 안 된 변경 있음)' : '');
  }
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (p) => { for (const h of p.files || []) await openFile(await h.getFile(), h); });
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  // test hook
  window.__kicadPad = { state, view, tabs, loadText, currentText, toWorld, runCheck, get v3() { return v3; } };
})();
