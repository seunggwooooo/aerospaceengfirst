import { parse, serialize } from './sexpr.js';
import { PcbDoc } from './pcb.js';
import { SchDoc } from './sch.js';
import { snap } from './draw.js';

const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');
const stage = $('stage');

const state = {
  doc: null,
  fileName: '',
  handle: null,       // File System Access handle (desktop Chromium only)
  sel: [],
  tool: 'select',
  undo: [],
  redo: [],
  dirty: false,
  padInfo: null,
  preview: null,      // wire being drawn
};
const view = { k: 4, tx: 0, ty: 0, dpr: 1, w: 0, h: 0 };

// ---------- loading ----------

export function makeDoc(text) {
  const root = parse(text);
  switch (root.h) {
    case 'kicad_pcb': case 'footprint': case 'module': return new PcbDoc(root);
    case 'kicad_sch': case 'kicad_symbol_lib': return new SchDoc(root);
  }
  throw new Error('지원하지 않는 파일입니다 (' + root.h + '). KiCad 6 이상의 .kicad_sch / .kicad_pcb / .kicad_mod / .kicad_sym 파일을 열어 주세요.');
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
  state.doc = doc;
  state.fileName = name;
  state.handle = handle || null;
  state.sel = [];
  state.undo = [];
  state.redo = [];
  state.dirty = false;
  state.padInfo = null;
  setTool('select');
  document.body.classList.add('has-doc');
  document.body.classList.toggle('is-sch', doc.kind === 'sch' && !doc.isLibFile);
  document.body.classList.toggle('is-pcb', doc.kind === 'pcb');
  const gs = $('gridSel');
  gs.innerHTML = '';
  for (const g of doc.gridOptions) gs.add(new Option(g + ' mm', g, false, g === doc.grid));
  const ss = $('symSel');
  ss.hidden = !doc.isLibFile;
  if (doc.isLibFile) {
    ss.innerHTML = '';
    for (const s of doc.symbolNames) ss.add(new Option(s, s));
  }
  if (window.innerWidth > 760) $('panel').hidden = false;
  resize();
  fit();
  refreshUi();
  return true;
}

async function openFile(file, handle) {
  if (state.dirty && !confirm('저장하지 않은 변경 사항이 있습니다. 다른 파일을 열까요?')) return;
  const text = await file.text();
  if (loadText(text, file.name, handle)) saveDraft();
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

function shareFile() {
  return new File([currentText()], state.fileName, { type: 'text/plain' });
}

async function share() {
  if (!state.doc) return;
  try {
    await navigator.share({ files: [shareFile()], title: state.fileName });
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
  if (old.kind === 'pcb') {
    PcbDoc.savedVisibility = Object.fromEntries(old.layers.map((l) => [l.name, l.visible]));
  }
  const doc = makeDoc(text);
  doc.grid = old.grid;
  if (old.kind === 'pcb') { doc.showZoneFill = old.showZoneFill; doc.hlNet = old.hlNet; }
  if (old.isLibFile) doc.showLibSymbol(old.currentSymbol);
  state.doc = doc;
  state.sel = [];
  state.padInfo = null;
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(currentText());
  restoreText(state.undo.pop());
  state.dirty = true;
  changed(false);
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(currentText());
  restoreText(state.redo.pop());
  state.dirty = true;
  changed(false);
}

function changed() {
  saveDraft();
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

  // handles of the selected item
  const hs = state.sel.length === 1 ? doc.handles(state.sel[0]) : [];
  for (const [hx, hy] of hs) {
    ctx.beginPath();
    ctx.arc(hx, hy, 6 / view.k, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2 / view.k;
    ctx.strokeStyle = '#e8590c';
    ctx.stroke();
  }
  if (state.preview) {
    const p = state.preview;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[2], p[1]);
    ctx.lineTo(p[2], p[3]);
    ctx.lineWidth = 2 / view.k;
    ctx.strokeStyle = '#e8590c';
    ctx.stroke();
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

// ---------- pointer input ----------

const pointers = new Map();
let gesture = null;   // {mode, ...}

function localPos(e) {
  const r = cv.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

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
  const tol = (e.pointerType === 'touch' ? 14 : 7) / view.k;
  let mode = 'pan';
  let handle = -1;
  if (state.tool === 'wire') mode = 'wire';
  else if (state.tool !== 'select') mode = 'place';
  else if (e.button === 1 || e.button === 2) mode = 'pan';
  else if (state.sel.length === 1) {
    const it = state.sel[0];
    const hs = doc.handles(it);
    for (let i = 0; i < hs.length; i++) {
      if (Math.hypot(hs[i][0] - wx, hs[i][1] - wy) <= tol * 1.2) { handle = i; break; }
    }
    if (handle >= 0) mode = 'handle';
    else if (doc.canMove(it) && doc.hitAll(wx, wy, tol).includes(it)) mode = 'move';
  }
  gesture = { mode, handle, sx, sy, wx, wy, lastX: sx, lastY: sy, moved: false, applied: [0, 0], touch: e.pointerType === 'touch', started: false };
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
    doc.moveHandle(state.sel[0], g.handle, snap(wx, doc.grid), snap(wy, doc.grid));
    requestDraw();
  } else if (g.mode === 'wire') {
    state.preview = [snap(g.wx, doc.grid), snap(g.wy, doc.grid), snap(wx, doc.grid), snap(wy, doc.grid)];
    requestDraw();
  }
  showCoords(sx, sy);
});

function endGesture(cancel) {
  const g = gesture;
  gesture = null;
  if (!g) return;
  if (g.mode === 'wire') {
    const p = state.preview;
    state.preview = null;
    if (p && !cancel) {
      const doc = state.doc;
      if (p[0] !== p[2] || p[1] !== p[3]) {
        checkpoint();
        doc.addWire(p[0], p[1], p[2], p[1]);
        doc.addWire(p[2], p[1], p[2], p[3]);
        changed();
      }
    }
    requestDraw();
  } else if ((g.mode === 'move' || g.mode === 'handle') && g.started) {
    changed();
  }
}

function pointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  const [sx, sy] = localPos(e);
  pointers.delete(e.pointerId);
  const g = gesture;
  if (!g) return;
  if (g.mode === 'pinch') { if (pointers.size < 2) gesture = null; return; }
  if (!g.moved && e.type === 'pointerup') { gesture = null; tap(sx, sy, g); return; }
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
  if (state.tool === 'select') {
    const tol = (g.touch ? 14 : 7) / view.k;
    const hits = doc.hitAll(wx, wy, tol);
    let pick = hits[0] || null;
    if (state.sel.length === 1 && hits.length > 1) {
      const i = hits.indexOf(state.sel[0]);
      if (i >= 0) pick = hits[(i + 1) % hits.length];
    }
    state.sel = pick ? [pick] : [];
    state.padInfo = pick && doc.kind === 'pcb' ? doc.padAt(pick, wx, wy) : null;
    if (pick && window.innerWidth > 760) showPanel('props');
    refreshUi();
    return;
  }
  if (state.tool === 'junction') { checkpoint(); doc.addJunction(gx, gy); changed(); return; }
  if (state.tool === 'nc') { checkpoint(); doc.addNoConnect(gx, gy); changed(); return; }
  if (state.tool === 'label' || state.tool === 'text') {
    const isLabel = state.tool === 'label';
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
};

function setTool(t) {
  state.tool = t;
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  const h = $('hint');
  h.hidden = !HINTS[t];
  h.textContent = HINTS[t] || '';
  cv.style.cursor = t === 'select' ? 'default' : 'crosshair';
  if (t !== 'select') { state.sel = []; refreshUi(); }
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
  const items = state.sel.filter((it) => !it.fixed);
  if (!items.length) return;
  checkpoint();
  for (const it of items) doc.remove(it);
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
  }
  resize();
}

const actions = {
  open() {
    if (window.showOpenFilePicker) {
      window.showOpenFilePicker().then(async ([h]) => openFile(await h.getFile(), h)).catch(() => {});
    } else $('fileInput').click();
  },
  save, share, undo, redo, fit,
  rotate: rotateSel,
  delete: deleteSel,
  panel() { const p = $('panel'); p.hidden = !p.hidden; resize(); },
  async restore() {
    const d = await kv('readonly', (s) => s.get('draft'));
    if (d && loadText(d.text, d.name)) { state.dirty = !!d.dirty; refreshUi(); }
  },
};

function activate(t) {
  if (t.dataset.act) actions[t.dataset.act]();
  else if (t.dataset.tool) setTool(t.dataset.tool);
  else if (t.dataset.tab) showPanel(t.dataset.tab);
  else if (t.dataset.sample) openSample(t.dataset.sample);
}

// Touch browsers can swallow the click of a tap that quickly follows another
// touch (e.g. undo right after a drag), so finger/pencil taps on buttons are
// handled on pointerup. File actions keep the native click they require.
const NEEDS_CLICK = new Set(['open', 'save', 'share', 'restore']);
let press = null;
let handled = null;
document.addEventListener('pointerdown', (e) => {
  const t = e.pointerType === 'mouse' ? null : e.target.closest('[data-act],[data-tool],[data-tab]');
  press = t && !t.disabled && !NEEDS_CLICK.has(t.dataset.act) ? { t, x: e.clientX, y: e.clientY, id: e.pointerId } : null;
});
document.addEventListener('pointerup', (e) => {
  const p = press;
  press = null;
  if (!p || p.id !== e.pointerId || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 12) return;
  if (e.target.closest('[data-act],[data-tool],[data-tab]') !== p.t || p.t.disabled) return;
  handled = { t: p.t, at: performance.now() };
  activate(p.t);
});
document.addEventListener('pointercancel', () => { press = null; });

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act],[data-tool],[data-tab],[data-sample]');
  if (!t) return;
  if (handled && handled.t === t && performance.now() - handled.at < 800) { handled = null; return; }
  activate(t);
});

$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openFile(f);
});
$('gridSel').addEventListener('change', (e) => { if (state.doc) { state.doc.grid = parseFloat(e.target.value); requestDraw(); } });
$('symSel').addEventListener('change', (e) => { state.doc.showLibSymbol(e.target.value); state.sel = []; fit(); refreshUi(); });

window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
window.addEventListener('dragleave', () => document.body.classList.remove('drop'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drop');
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea,select,dialog')) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'o') { e.preventDefault(); actions.open(); return; }
  if (!state.doc) return;
  if (mod && k === 's') { e.preventDefault(); save(); }
  else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (mod) return;
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); }
  else if (k === 'r') rotateSel();
  else if (k === 'f') fit();
  else if (k === 'escape') { setTool('select'); state.sel = []; refreshUi(); }
  else if (state.doc.kind === 'sch' && !state.doc.isLibFile) {
    const map = { w: 'wire', l: 'label', j: 'junction', q: 'nc', t: 'text' };
    if (map[k]) setTool(map[k]);
  }
});

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

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
    checkpoint();
    f.set(v);
    changed();
  });
  if (f.type !== 'textarea') input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  wrap.append(input);
  return wrap;
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
    if (doc.kind === 'pcb' && doc.hlNet) {
      body.append(el('button', { class: 'panel-btn on', onclick() { doc.hlNet = null; refreshUi(); } }, '네트 강조 끄기: ' + doc.hlNet));
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
  if (doc.kind === 'pcb') {
    const pad = state.padInfo;
    if (pad) body.append(fieldEl({ label: '탭한 패드', type: 'info', value: pad.pad + (pad.net ? '  ·  네트 ' + pad.net : '  ·  연결 없음') }));
    const net = (pad && pad.net) || it.net;
    if (net) {
      const on = doc.hlNet === net;
      body.append(el('button', { class: 'panel-btn' + (on ? ' on' : ''), onclick() { doc.hlNet = on ? null : net; refreshUi(); } },
        on ? '네트 강조 끄기' : '이 네트 강조: ' + net));
    }
    if (it.k === 'fp' || it.k === 'seg' || it.k === 'via') {
      body.append(el('p', { class: 'note' }, '부품을 옮겨도 연결된 배선은 따라오지 않고, 영역(zone) 채움도 다시 계산되지 않습니다. KiCad에서 열어 B 키로 영역을 다시 채우고 DRC를 확인하세요.'));
    }
  } else if (it.k === 'symbol') {
    body.append(el('p', { class: 'note' }, '심볼을 옮겨도 배선은 따라오지 않습니다. 배선 끝점을 끌어 다시 맞춰 주세요.'));
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
  body.append(el('button', { class: 'panel-btn' + (doc.showZoneFill ? ' on' : ''), style: 'margin-top:10px', onclick() { doc.showZoneFill = !doc.showZoneFill; refreshUi(); } },
    doc.showZoneFill ? '영역 채움 표시 중' : '영역 채움 숨김'));
}

function refreshUi() {
  const doc = state.doc;
  if (doc) {
    const it = state.sel[0];
    $('undoBtn').disabled = !state.undo.length;
    $('redoBtn').disabled = !state.redo.length;
    $('rotateBtn').disabled = !(it && doc.canRotate(it));
    $('deleteBtn').disabled = !(it && !it.fixed);
    const info = $('fileInfo');
    info.textContent = '';
    info.append(el('b', null, state.fileName, state.dirty ? el('span', { class: 'dirty' }, ' ●') : null), doc.summary());
    document.title = (state.dirty ? '● ' : '') + state.fileName + ' – KiCad Pad Editor';
  }
  renderProps();
  renderLayers();
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
    window.launchQueue.setConsumer(async (p) => { if (p.files && p.files[0]) openFile(await p.files[0].getFile(), p.files[0]); });
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  // test hook
  window.__kicadPad = { state, view, loadText, currentText, toWorld };
})();
