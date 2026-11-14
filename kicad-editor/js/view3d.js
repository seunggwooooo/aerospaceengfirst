// 3D board preview: outline extruded to board thickness, copper / silkscreen as
// textures, and simple placeholder bodies for the parts (no STEP/WRL models).
import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { drawPrims, emptyBounds, primBounds, DEG, pointInPoly } from './draw.js';
import { edgeShapes } from './conn.js';

const MASK = '#0d5b33', CU_MASKED = '#2c8a52', PAD = '#d9b648', SILK = '#f2f2ee', HOLE = '#0b0d10';

// Join Edge.Cuts pieces into closed loops.
function outlineLoops(doc) {
  const segs = edgeShapes(doc, true).map((s) => s.pts);
  const key = (x, y) => Math.round(x * 100) + ',' + Math.round(y * 100);
  const at = new Map();
  segs.forEach((s, i) => {
    for (const k of [key(s[0], s[1]), key(s[2], s[3])]) { let a = at.get(k); if (!a) at.set(k, (a = [])); a.push(i); }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts = [segs[i][0], segs[i][1], segs[i][2], segs[i][3]];
    const start = key(segs[i][0], segs[i][1]);
    let closed = false;
    for (let guard = 0; guard < segs.length + 2; guard++) {
      const k = key(pts[pts.length - 2], pts[pts.length - 1]);
      if (k === start) { closed = true; break; }
      const next = (at.get(k) || []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      const s = segs[next];
      if (key(s[0], s[1]) === k) pts.push(s[2], s[3]); else pts.push(s[0], s[1]);
    }
    if (closed && pts.length >= 8) { pts.length -= 2; loops.push(pts); }
  }
  const area = (p) => { let a = 0; for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1]; return a / 2; };
  loops.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
  return loops;
}

function partStyle(fp, w, d, tht) {
  const name = fp.name.toLowerCase();
  const ref = (fp.ref || '').toUpperCase();
  const small = Math.min(w, d);
  if (/mountinghole|fiducial|logo|testpoint|test_point|nettie|net-tie|solderjumper|jumper_/.test(name) || /^(H|FID|TP|NT|LOGO|REF\*\*|G)\d*$/.test(ref)) return null;
  if (/pinheader|pinsocket/.test(name)) return { h: 8.5, color: 0x16181c };
  if (/usb/.test(name)) return { h: 3.2, color: 0xb9bcc2, metal: true };
  if (/dsub|barrel|terminal|rj45|jack|conn/.test(name) || /^(J|P|CN|X|K)\d/.test(ref)) return { h: Math.min(Math.max(small * 0.35, 2.5), 6), color: 0x1b1d22 };
  if (/^LED|^D\d/.test(ref) && /led/.test(name)) return { h: tht ? 6 : 0.8, color: 0xe9f5c9, glow: true, round: tht };
  if (/^C/.test(ref)) {
    if (/cp_|elec|radial/.test(name)) return { h: Math.min(Math.max(small * 1.2, 5), 13), color: 0x23305a, round: true, metal: true };
    return { h: tht ? 3.5 : Math.min(Math.max(small * 0.6, 0.35), 1.7), color: 0xb5946a };
  }
  if (/^R/.test(ref)) return { h: tht ? 2.4 : 0.45, color: tht ? 0xc9a66b : 0x1c1f26 };
  if (/^(L|FB)/.test(ref)) return { h: Math.min(Math.max(small * 0.6, 0.6), 6), color: 0x4a4d55 };
  if (/^(Y|XTAL)/.test(ref) || /crystal|oscillator/.test(name)) return { h: tht ? 3.5 : 1.0, color: 0xc0c3c8, metal: true };
  if (/^SW|^BT/.test(ref)) return { h: 3.5, color: 0x2a2d33 };
  if (/^Q/.test(ref)) return { h: tht ? 4.5 : 1.1, color: 0x17181b };
  if (/^D/.test(ref)) return { h: tht ? 2.4 : 1.0, color: 0x1a1b1f };
  if (/^(U|IC)/.test(ref)) {
    if (/dip-|dip_/.test(name)) return { h: 3.6, color: 0x17181b };
    return { h: /bga|qfn|dfn|lga/.test(name) ? 0.85 : /soic|sop|so-/.test(name) ? 1.6 : 1.2, color: 0x17181b };
  }
  return { h: tht ? 3 : 1.2, color: 0x24262b };
}

export function open3D(doc, host, onClose) {
  const b = doc.bounds();
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const bw = Math.max(b[2] - b[0], 1), bh = Math.max(b[3] - b[1], 1);
  const t = doc.thickness || 1.6;
  const size = Math.max(bw, bh);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x1a2130);
  const canvas = renderer.domElement;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;display:block';
  host.prepend(canvas);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x54606e, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(-size, size * 1.6, size * 0.9);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(size, -size, -size * 0.6);
  scene.add(fill);

  // ----- board body -----
  const loops = outlineLoops(doc);
  const shape = new THREE.Shape();
  const outer = loops[0] || [b[0], b[1], b[2], b[1], b[2], b[3], b[0], b[3]];
  outer.forEach((v, i) => { if (i % 2) return; const x = v - cx, y = -(outer[i + 1] - cy); if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y); });
  shape.closePath();
  for (const l of loops.slice(1)) {
    if (!pointInPoly(l[0], l[1], outer)) continue;
    const p = new THREE.Path();
    l.forEach((v, i) => { if (i % 2) return; const x = v - cx, y = -(l[i + 1] - cy); if (i === 0) p.moveTo(x, y); else p.lineTo(x, y); });
    p.closePath();
    shape.holes.push(p);
  }
  const holes = [];
  for (const it of doc.items) if (it.k === 'fp' && it.holes) for (const h of it.holes) if (h.d >= 0.5 && pointInPoly(h.x, h.y, outer)) holes.push(h);
  const withDrills = shape.clone();
  if (holes.length <= 1500) for (const h of holes) { const p = new THREE.Path(); p.absarc(h.x - cx, -(h.y - cy), h.d / 2, 0, Math.PI * 2, true); withDrills.holes.push(p); }
  let geo;
  try { geo = new THREE.ExtrudeGeometry(withDrills, { depth: t, bevelEnabled: false, curveSegments: 10 }); }
  catch (e) { geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false }); }
  const board = new THREE.Mesh(geo, [
    new THREE.MeshStandardMaterial({ color: MASK, roughness: 0.55, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({ color: 0x8c7b3f, roughness: 0.9 }),
  ]);
  board.rotation.x = -Math.PI / 2;
  scene.add(board);

  // ----- copper / silkscreen textures -----
  const maxTex = Math.min(renderer.capabilities.maxTextureSize, 4096);
  const s = Math.min(maxTex / bw, maxTex / bh, 48);
  const buckets = doc.buckets();
  const paint = (side) => {
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(bw * s));
    c.height = Math.max(2, Math.round(bh * s));
    const g = c.getContext('2d');
    const view = { k: s, tx: -b[0] * s, ty: -b[1] * s, dpr: 1 };
    g.setTransform(s, 0, 0, s, view.tx, view.ty);
    const layer = (name, color, filter) => { const p = buckets.get(name); if (p) drawPrims(g, view, p, color, { force: true, filter }); };
    layer(side + '.Cu', CU_MASKED, (p) => p.pad === undefined);
    layer('@Via', CU_MASKED);
    layer(side + '.Cu', PAD, (p) => p.pad !== undefined);
    layer('@TH', PAD);
    layer(side + '.SilkS', SILK);
    layer('@Holes', HOLE);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  };
  const quad = (y, tex) => {
    const x0 = b[0] - cx, x1 = b[2] - cx, z0 = b[1] - cy, z1 = b[3] - cy;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.04, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.15 }));
    scene.add(m);
    return m;
  };
  quad(t + 0.012, paint('F'));
  const under = quad(-0.012, paint('B'));
  under.geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0], 3));

  // ----- placeholder part bodies -----
  const parts = new THREE.Group();
  scene.add(parts);
  for (const fp of doc.items) {
    if (fp.k !== 'fp') continue;
    const back = fp.layer === 'B.Cu';
    const side = back ? 'B' : 'F';
    const a = fp.ang * DEG, cs = Math.cos(a), sn = Math.sin(a);
    const pick = (test) => {
      const bb = emptyBounds();
      const add = (X, Y) => { const dx = X - fp.x, dy = Y - fp.y; const lx = dx * cs - dy * sn, ly = dx * sn + dy * cs; if (lx < bb[0]) bb[0] = lx; if (lx > bb[2]) bb[2] = lx; if (ly < bb[1]) bb[1] = ly; if (ly > bb[3]) bb[3] = ly; };
      for (const p of fp.prims) {
        if (p.t === 'T' || !test(p)) continue;
        if (p.t === 'L') { add(p.x1, p.y1); add(p.x2, p.y2); }
        else if (p.t === 'P') for (let i = 0; i < p.pts.length; i += 2) add(p.pts[i], p.pts[i + 1]);
        else if (p.t === 'C' || p.t === 'A') { add(p.cx - p.r, p.cy - p.r); add(p.cx + p.r, p.cy + p.r); add(p.cx - p.r, p.cy + p.r); add(p.cx + p.r, p.cy - p.r); }
        else if (p.t === 'R') { const r = Math.min(p.w, p.h) / 2; add(p.x - r, p.y - r); add(p.x + r, p.y + r); }
      }
      return bb[0] === Infinity ? null : bb;
    };
    const bb = pick((p) => p.layer === side + '.Fab') || pick((p) => p.layer === side + '.CrtYd') || pick((p) => p.pad !== undefined && !p.hole);
    if (!bb) continue;
    const w = bb[2] - bb[0], d = bb[3] - bb[1];
    if (w < 0.2 || d < 0.2) continue;
    const tht = fp.prims.some((p) => p.layer === '@TH');
    const st = partStyle(fp, w, d, tht);
    if (!st) continue;
    const lift = tht && !/pinheader|pinsocket|dip|conn|dsub|usb/i.test(fp.name) && /^(R|D)/i.test(fp.ref) ? 0.6 : 0;
    const g = st.round ? new THREE.CylinderGeometry(Math.min(w, d) / 2, Math.min(w, d) / 2, st.h, 28) : new THREE.BoxGeometry(w, st.h, d);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: st.color, roughness: st.metal ? 0.35 : 0.7, metalness: st.metal ? 0.6 : 0.05,
      transparent: !!st.glow, opacity: st.glow ? 0.82 : 1 }));
    const lx = (bb[0] + bb[2]) / 2, ly = (bb[1] + bb[3]) / 2;
    const X = fp.x + lx * cs + ly * sn, Y = fp.y - lx * sn + ly * cs;
    m.position.set(X - cx, back ? -(st.h / 2 + lift) : t + st.h / 2 + lift, Y - cy);
    m.rotation.y = a;
    parts.add(m);
  }

  // ----- camera -----
  const camera = new THREE.PerspectiveCamera(35, 1, size / 200, size * 40);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, t / 2, 0);
  controls.minDistance = size * 0.05;
  controls.maxDistance = size * 12;
  const look = (dir) => {
    const dist = size * 1.9;
    if (dir === 'top') camera.position.set(0, dist, 0.001);
    else if (dir === 'bottom') camera.position.set(0, -dist, 0.001);
    else camera.position.set(-size * 0.55, size * 1.05, size * 1.25);
    controls.update();
    render();
  };
  let queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; renderer.render(scene, camera); });
  }
  const resize = () => {
    const r = host.getBoundingClientRect();
    renderer.setSize(Math.max(r.width, 2), Math.max(r.height, 2), false);
    camera.aspect = Math.max(r.width, 2) / Math.max(r.height, 2);
    camera.updateProjectionMatrix();
    render();
  };
  controls.addEventListener('change', render);
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  look('iso');

  return {
    look,
    toggleParts() { parts.visible = !parts.visible; render(); return parts.visible; },
    partCount: parts.children.length,
    dispose() {
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of ms) { if (m.map) m.map.dispose(); m.dispose(); }
      });
      renderer.dispose();
      canvas.remove();
      if (onClose) onClose();
    },
  };
}
