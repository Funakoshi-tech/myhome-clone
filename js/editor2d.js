// editor2d.js
// 2D 作図エディタ（Canvas）。グリッド・スナップ・部屋/壁/家具/階段の配置。
// store の同じデータを読み書きするだけ（描画専用ロジック）。

import * as M from './model.js';
import { getRoomType, getFurniture, getStairType, getOpeningType } from './catalog.js';
import { drawStair2d } from './stairDraw2d.js';
import { getFurnitureIcon, requestFurnitureIcon } from './furnitureIcon2d.js';

// ---- モジュールレベルのヘルパー（純粋関数） --------------------------------

// 点 p から線分 a-b への最短距離（mm）
function _ptSegDist(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-6) return Math.hypot(p.x - a.x, p.z - a.z);
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
}

function _edgeKey(a, b) {
  const r = (v) => Math.round(v);
  const p1 = `${r(a.x)},${r(a.z)}`;
  const p2 = `${r(b.x)},${r(b.z)}`;
  return p1 < p2 ? `${p1}|${p2}` : `${p2}|${p1}`;
}

function _wallExteriorNormal(wall, room) {
  const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
  const len = Math.hypot(dx, dz);
  if (len < 1) return null;
  const ux = dx / len, uz = dz / len;
  let nx = -uz, nz = ux;
  const mid = { x: (wall.start.x + wall.end.x) / 2, z: (wall.start.z + wall.end.z) / 2 };
  const c = M.polygonCentroid(room.polygon);
  // 法線が部屋重心から離れる方向（外側）を向くよう補正
  if (nx * (mid.x - c.x) + nz * (mid.z - c.z) < 0) { nx = -nx; nz = -nz; }
  return { nx, nz, ux, uz, len };
}

/** 全居室ポリゴンの外側を向く法線に確定（内側向きなら反転） */
function _resolveOutwardNormal(wall, room, floor) {
  const wn = _wallExteriorNormal(wall, room);
  if (!wn) return null;
  let { nx, nz } = wn;
  const mid = { x: (wall.start.x + wall.end.x) / 2, z: (wall.start.z + wall.end.z) / 2 };
  const probe = { x: mid.x + nx * 120, z: mid.z + nz * 120 };
  const insideAny = floor.rooms.some((r) => r.polygon && M.pointInPolygon(probe, r.polygon));
  if (insideAny) { nx = -nx; nz = -nz; }
  return { ...wn, nx, nz };
}

function _ptNear(a, b, eps = 2) {
  return Math.hypot(a.x - b.x, a.z - b.z) <= eps;
}

function _formatDimMm(mm) {
  return `${Math.round(mm).toLocaleString('ja-JP')}mm`;
}

const FURNITURE_MAGNET_MM = 60;
const FURNITURE_DIST_SHOW_MAX_MM = 4500;
const FURNITURE_EDGE_PARALLEL = 0.992;
const FURNITURE_EDGE_FACE = 0.88;
const FURNITURE_EDGE_OVERLAP_MIN_MM = 80;

function _furnitureCornersFrom(f) {
  const rad = ((f.rotationDeg || 0) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const hw = f.wMM / 2, hd = f.dMM / 2;
  return [
    { x: -hw, z: -hd }, { x: hw, z: -hd }, { x: hw, z: hd }, { x: -hw, z: hd },
  ].map((p) => ({
    x: f.x + p.x * cos - p.z * sin,
    z: f.z + p.x * sin + p.z * cos,
  }));
}

function _furnitureEdgesFrom(f) {
  const corners = _furnitureCornersFrom(f);
  const edges = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const tx = b.x - a.x, tz = b.z - a.z;
    const len = Math.hypot(tx, tz);
    if (len < 1e-6) continue;
    const ux = tx / len, uz = tz / len;
    let nx = -uz, nz = ux;
    const vx = mx - f.x, vz = mz - f.z;
    if (nx * vx + nz * vz < 0) { nx = -nx; nz = -nz; }
    edges.push({
      a, b,
      mid: { x: mx, z: mz },
      nx, nz, ux, uz,
      halfLen: len / 2,
    });
  }
  return edges;
}

function _axisOverlap1D(mid, halfLen, ptA, ptB, ux, uz) {
  const t = (p) => p.x * ux + p.z * uz;
  const lo1 = t(mid) - halfLen, hi1 = t(mid) + halfLen;
  const lo2 = Math.min(t(ptA), t(ptB)), hi2 = Math.max(t(ptA), t(ptB));
  return Math.max(0, Math.min(hi1, hi2) - Math.max(lo1, lo2));
}

function _collectWallInnerFaces(floor, furniturePos = null) {
  const faces = [];
  for (const wall of floor.walls) {
    const room = floor.rooms.find((r) => r.id === (wall.roomId || M.inferWallRoomId(wall)));
    if (!room?.polygon) continue;
    const wn = _wallExteriorNormal(wall, room);
    if (!wn) continue;
    const { nx, nz, ux, uz } = wn;
    const halfT = (wall.thicknessMM || 120) / 2;
    const mid = { x: (wall.start.x + wall.end.x) / 2, z: (wall.start.z + wall.end.z) / 2 };

    // 家具がある場合：この壁の部屋内側に家具がある面のみ（壁芯ではなく内側面）
    if (furniturePos) {
      const side = nx * (furniturePos.x - mid.x) + nz * (furniturePos.z - mid.z);
      if (side > 0) continue;
    }

    const a = { x: wall.start.x - nx * halfT, z: wall.start.z - nz * halfT };
    const b = { x: wall.end.x - nx * halfT, z: wall.end.z - nz * halfT };
    faces.push({
      a, b, outNx: nx, outNz: nz, ux, uz, roomId: room.id,
    });
  }
  return faces;
}

/** 家具辺と壁内面（平行・向き合い）の隙間 mm。吸着・距離表示共通 */
function _edgeToWallInnerGap(edge, face) {
  const parallel = Math.abs(edge.ux * face.ux + edge.uz * face.uz);
  if (parallel < FURNITURE_EDGE_PARALLEL) return null;
  const facing = edge.nx * face.outNx + edge.nz * face.outNz;
  if (facing < FURNITURE_EDGE_FACE) return null;
  const overlap = _axisOverlap1D(edge.mid, edge.halfLen, face.a, face.b, face.ux, face.uz);
  if (overlap < FURNITURE_EDGE_OVERLAP_MIN_MM) return null;
  const gap = edge.nx * (face.a.x - edge.mid.x) + edge.nz * (face.a.z - edge.mid.z);
  if (gap < 0) return null;
  const target = { x: edge.mid.x + edge.nx * gap, z: edge.mid.z + edge.nz * gap };
  return { gap, target, kind: 'wall' };
}

function _edgeToFurnitureGap(edge, otherEdge) {
  const parallel = Math.abs(edge.ux * otherEdge.ux + edge.uz * otherEdge.uz);
  if (parallel < FURNITURE_EDGE_PARALLEL) return null;
  const facing = edge.nx * otherEdge.nx + edge.nz * otherEdge.nz;
  if (facing > -FURNITURE_EDGE_FACE) return null;
  const overlap = _axisOverlap1D(edge.mid, edge.halfLen, otherEdge.a, otherEdge.b, edge.ux, edge.uz);
  if (overlap < FURNITURE_EDGE_OVERLAP_MIN_MM) return null;
  const gap = edge.nx * (otherEdge.mid.x - edge.mid.x) + edge.nz * (otherEdge.mid.z - edge.mid.z);
  if (gap < 0) return null;
  const target = { x: edge.mid.x + edge.nx * gap, z: edge.mid.z + edge.nz * gap };
  return { gap, target, kind: 'furniture' };
}

/** 壁内面への平行移動スナップ（回転補正なし・辺が壁と平行な場合のみ） */
function _snapFurnitureToWalls(x, z, f, floor) {
  const tmp = { ...f, x, z };
  let dx = 0, dz = 0;
  const faces = _collectWallInnerFaces(floor, { x, z });
  for (const edge of _furnitureEdgesFrom(tmp)) {
    let best = null;
    for (const face of faces) {
      const hit = _edgeToWallInnerGap(edge, face);
      if (!hit || hit.gap > FURNITURE_MAGNET_MM) continue;
      if (!best || hit.gap < best.gap) best = hit;
    }
    if (best) {
      dx -= best.gap * edge.nx;
      dz -= best.gap * edge.nz;
    }
  }
  return { x: x + dx, z: z + dz };
}

// ============================================================================
export class Editor2D {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./store.js').Store} store
   * @param {object} ui  共有UI状態（main.js が保持）
   * @param {() => void} onUI  選択変更などで panel 再描画を促すコールバック
   */
  constructor(canvas, store, ui, onUI) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;
    this.ui = ui;
    this.onUI = onUI || (() => {});
    this.active = false;

    // カメラ（CSS px 基準）: screen = world * scale + pan
    this.cam = { scale: 0.05, panX: 0, panY: 0 };
    this.dpr = window.devicePixelRatio || 1;

    this.drag = null;

    // ホバー状態（選択中の部屋の頂点/辺）
    this.hoverVertex = null; // { id, index }
    this.hoverEdge = null;   // { id, index } — カーソル変更用（+ ハンドルは廃止）

    this._space = false;
    this._bgImgCache = null;
    this._bgImgUrl = null;
    this._bgCalib = null; // { step: 1|2, p1?: {px,py}, p2?: {px,py} }
    this._clipboard = null;
    this._bind();
    this._initContextMenu();
  }

  _initContextMenu() {
    this.ctxMenu = document.createElement('div');
    this.ctxMenu.id = 'ctx-menu';
    this.ctxMenu.hidden = true;
    document.body.appendChild(this.ctxMenu);
    this._ctxMenuHide = (e) => {
      if (e.button !== 0) return;
      if (!this.ctxMenu.hidden && !this.ctxMenu.contains(e.target)) this._hideContextMenu();
    };
    window.addEventListener('pointerdown', this._ctxMenuHide);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._hideContextMenu(); });
  }

  _getContextMenuItems() {
    const sel = this.ui.selection;
    if (!sel) return [];
    const items = [];
    if (sel.kind === 'opening') {
      const op = (this._floor().openings || []).find((o) => o.id === sel.id);
      if (op?.type === 'door') {
        items.push({ label: '左右反転', action: () => this._toggleDoorFlip('flipLR') });
        items.push({ label: '上下反転', action: () => this._toggleDoorFlip('flipUD') });
      }
    }
    items.push({ label: '削除', action: () => this._deleteSelection(), danger: true });
    return items;
  }

  _doorFlipState(opening) {
    // flipLR = 内開き(false) / 外開き(true)
    // flipUD = 左開き(false) / 右開き(true)
    if (opening.doorFlipV2) {
      return { swingOut: !!opening.flipLR, hingeRight: !!opening.flipUD };
    }
    return {
      swingOut: !!(opening.flipUD ?? opening.flipIO),
      hingeRight: !!opening.flipLR,
    };
  }

  _normAng(a) {
    let x = a % (2 * Math.PI);
    if (x > Math.PI) x -= 2 * Math.PI;
    if (x < -Math.PI) x += 2 * Math.PI;
    return x;
  }

  // 中心からマウス方向を 90° 刻みにスナップ（階段・ドア共通）
  _snapRadialRad(centerW, w) {
    const raw = Math.atan2(w.z - centerW.z, w.x - centerW.x);
    return Math.round(raw / (Math.PI / 2)) * (Math.PI / 2);
  }

  // ドアの開き側に対応するハンドル方向（ラジアン）
  _doorNaturalHandleRad(g) {
    const openSide = Math.sign(Math.sin(this._normAng(g.openAng - g.closedAng))) || 1;
    return Math.atan2(g.nz * openSide, g.nx * openSide);
  }

  _doorHandleRadForConfig(wall, opening, hingeRight, swingOut) {
    const probe = { ...opening, flipUD: hingeRight, flipLR: swingOut, doorFlipV2: true };
    delete probe.doorSwingRad;
    delete probe.flipIO;
    const g = this._doorLayout(wall, probe);
    if (!g) return 0;
    const natural = this._doorNaturalHandleRad(g);
    return Math.round(natural / (Math.PI / 2)) * (Math.PI / 2);
  }

  // 中心基準・90°スナップでドアの開き方向（4パターン）を決定
  _applyDoorRotationSnap(opening, wall, centerW, w) {
    const snappedRad = this._snapRadialRad(centerW, w);
    const candidates = [
      { hingeRight: false, swingOut: false },
      { hingeRight: false, swingOut: true },
      { hingeRight: true, swingOut: false },
      { hingeRight: true, swingOut: true },
    ];
    let best = candidates[0], bestDiff = Infinity;
    for (const c of candidates) {
      const handleRad = this._doorHandleRadForConfig(wall, opening, c.hingeRight, c.swingOut);
      const diff = Math.abs(this._normAng(handleRad - snappedRad));
      if (diff < bestDiff) { bestDiff = diff; best = c; }
    }
    opening.flipUD = best.hingeRight;
    opening.flipLR = best.swingOut;
    opening.doorFlipV2 = true;
    delete opening.flipIO;
    this._syncDoorSwingFromFlips(opening, wall);
  }

  // ドアの幾何（丁番・開き方向・回転ハンドル位置）
  _doorLayout(wall, opening, handleOverrideW = null) {
    const ax = wall.start.x, az = wall.start.z;
    const bx = wall.end.x, bz = wall.end.z;
    const dx = bx - ax, dz = bz - az;
    const lenMM = Math.hypot(dx, dz);
    if (lenMM < 1) return null;
    const ux = dx / lenMM, uz = dz / lenMM;
    const nx = -uz, nz = ux;
    const halfT = (wall.thicknessMM || 120) / 2;
    const oStart = opening.offsetMM - opening.widthMM / 2;
    const oEnd = opening.offsetMM + opening.widthMM / 2;
    const width = opening.widthMM;

    const { swingOut, hingeRight } = this._doorFlipState(opening);
    const hingeMM = hingeRight ? oEnd : oStart;
    const otherMM = hingeRight ? oStart : oEnd;
    const hingeW = { x: ax + ux * hingeMM, z: az + uz * hingeMM };
    const otherW = { x: ax + ux * otherMM, z: az + uz * otherMM };
    const centerW = { x: ax + ux * opening.offsetMM, z: az + uz * opening.offsetMM };
    const closedAng = Math.atan2(otherW.z - hingeW.z, otherW.x - hingeW.x);

    let openAng;
    if (typeof opening.doorSwingRad === 'number') {
      openAng = opening.doorSwingRad;
    } else {
      openAng = closedAng + (swingOut ? -1 : 1) * Math.PI / 2;
    }

    const leafEndW = {
      x: hingeW.x + Math.cos(openAng) * width,
      z: hingeW.z + Math.sin(openAng) * width,
    };

    let handleW;
    const stemLenMM = Math.max(opening.widthMM, (wall.thicknessMM || 120)) * 0.55 + 280;
    let handleRad;
    if (handleOverrideW) {
      handleRad = Math.atan2(handleOverrideW.z - centerW.z, handleOverrideW.x - centerW.x);
      handleRad = Math.round(handleRad / (Math.PI / 2)) * (Math.PI / 2);
    } else {
      const openSide = Math.sign(Math.sin(this._normAng(openAng - closedAng))) || 1;
      const natural = Math.atan2(nz * openSide, nx * openSide);
      handleRad = Math.round(natural / (Math.PI / 2)) * (Math.PI / 2);
    }
    handleW = {
      x: centerW.x + Math.cos(handleRad) * stemLenMM,
      z: centerW.z + Math.sin(handleRad) * stemLenMM,
    };

    return {
      ux, uz, nx, nz, halfT, oStart, oEnd, width, lenMM,
      hingeW, otherW, centerW, leafEndW, handleW, closedAng, openAng,
    };
  }

  _syncDoorSwingFromFlips(o, wall) {
    const { swingOut, hingeRight } = this._doorFlipState(o);
    const ax = wall.start.x, az = wall.start.z;
    const dx = wall.end.x - ax, dz = wall.end.z - az;
    const lenMM = Math.hypot(dx, dz);
    if (lenMM < 1) return;
    const ux = dx / lenMM, uz = dz / lenMM;
    const oStart = o.offsetMM - o.widthMM / 2;
    const oEnd = o.offsetMM + o.widthMM / 2;
    const hingeMM = hingeRight ? oEnd : oStart;
    const otherMM = hingeRight ? oStart : oEnd;
    const hingeW = { x: ax + ux * hingeMM, z: az + uz * hingeMM };
    const otherW = { x: ax + ux * otherMM, z: az + uz * otherMM };
    const closedAng = Math.atan2(otherW.z - hingeW.z, otherW.x - hingeW.x);
    o.doorSwingRad = closedAng + (swingOut ? -1 : 1) * Math.PI / 2;
  }

  _doorRotateHandleHit(op, wall, sx, sy) {
    const override = this.drag?.kind === 'rotate-door' && this.drag.id === op.id
      ? this.drag.tempHandleW : null;
    const g = this._doorLayout(wall, op, override);
    if (!g) return false;
    const hs = this.worldToScreen(g.handleW.x, g.handleW.z);
    return Math.hypot(sx - hs.x, sy - hs.y) <= 10;
  }

  _toggleDoorFlip(field) {
    const sel = this.ui.selection;
    if (!sel || sel.kind !== 'opening') return;
    this.store.update((plan) => {
      const floor = M.getFloor(plan, this.ui.floorId);
      const o = (floor.openings || []).find((x) => x.id === sel.id);
      const wall = floor.walls.find((w) => w.id === o?.wallId);
      if (o && o.type === 'door' && wall) {
        o[field] = !o[field];
        o.doorFlipV2 = true;
        delete o.flipIO;
        this._syncDoorSwingFromFlips(o, wall);
      }
    });
    this.onUI();
  }

  _showContextMenu(clientX, clientY) {
    const items = this._getContextMenuItems();
    if (!items.length) return;
    this.ctxMenu.innerHTML = '';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = item.label;
      if (item.danger) btn.dataset.danger = '1';
      btn.addEventListener('click', () => {
        this._hideContextMenu();
        item.action();
      });
      this.ctxMenu.appendChild(btn);
    }
    this.ctxMenu.hidden = false;
    this.ctxMenu.style.left = `${clientX}px`;
    this.ctxMenu.style.top = `${clientY}px`;
  }

  _hideContextMenu() {
    if (this.ctxMenu) this.ctxMenu.hidden = true;
  }

  _clickMenuMeta(e, sx, sy) {
    return { clickSx: sx, clickSy: sy, clientX: e.clientX, clientY: e.clientY };
  }

  _revertDrag(d) {
    const floor = this._floor();
    if (d.kind === 'move-opening') {
      const op = (floor.openings || []).find((o) => o.id === d.id);
      if (op) op.offsetMM = d.origOffset;
    } else if (d.kind === 'move-furniture') {
      const f = floor.furniture.find((x) => x.id === d.id);
      if (f) { f.x = d.ox; f.z = d.oz; }
    } else if (d.kind === 'move-stair') {
      const s = (floor.stairs || []).find((x) => x.id === d.id);
      if (s) { s.x = d.ox; s.z = d.oz; }
    } else if (d.kind === 'rotate-stair') {
      const s = (floor.stairs || []).find((x) => x.id === d.id);
      if (s) s.rotationDeg = d.origRotationDeg;
    } else if (d.kind === 'rotate-furniture') {
      const f = floor.furniture.find((x) => x.id === d.id);
      if (f) f.rotationDeg = d.origRotationDeg;
    } else if (d.kind === 'rotate-opening') {
      const op = (floor.openings || []).find((o) => o.id === d.id);
      if (op) op.wallFaceSign = d.origWallFaceSign;
    } else if (d.kind === 'rotate-door') {
      const op = (floor.openings || []).find((o) => o.id === d.id);
      if (op) {
        op.flipLR = d.origFlipLR;
        op.flipUD = d.origFlipUD;
        if (typeof d.origSwingRad === 'number') op.doorSwingRad = d.origSwingRad;
        else delete op.doorSwingRad;
      }
    }
  }

  // ---- ライフサイクル -------------------------------------------------------
  setActive(on) {
    this.active = on;
    if (on) { this.resize(); this.draw(); }
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.cssW = r.width;
    this.cssH = r.height;
    if (this.active) this.draw();
  }

  // ---- 座標変換 -------------------------------------------------------------
  worldToScreen(x, z) {
    return { x: x * this.cam.scale + this.cam.panX, y: z * this.cam.scale + this.cam.panY };
  }
  screenToWorld(sx, sy) {
    return { x: (sx - this.cam.panX) / this.cam.scale, z: (sy - this.cam.panY) / this.cam.scale };
  }
  _mouse(e) {
    const r = this.canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  // ---- 全体表示 -------------------------------------------------------------
  zoomFit() {
    const floor = this._floor();
    let b = null;
    const expand = (pt) => {
      if (!b) b = { minX: pt.x, maxX: pt.x, minZ: pt.z, maxZ: pt.z };
      else {
        b.minX = Math.min(b.minX, pt.x); b.maxX = Math.max(b.maxX, pt.x);
        b.minZ = Math.min(b.minZ, pt.z); b.maxZ = Math.max(b.maxZ, pt.z);
      }
    };
    for (const room of floor.rooms) for (const p of room.polygon) expand(p);
    for (const f of floor.furniture) expand({ x: f.x, z: f.z });
    for (const s of (floor.stairs || [])) expand({ x: s.x, z: s.z });
    const bgBounds = this._bgWorldBounds(this._plan().site?.backgroundImage);
    if (bgBounds) {
      expand({ x: bgBounds.minX, z: bgBounds.minZ });
      expand({ x: bgBounds.maxX, z: bgBounds.maxZ });
    }

    if (!b) b = { minX: -1000, maxX: 11000, minZ: -1000, maxZ: 11000 };
    const pad = 800;
    const w = (b.maxX - b.minX) + pad * 2;
    const h = (b.maxZ - b.minZ) + pad * 2;
    this.cam.scale = Math.max(0.005, Math.min(this.cssW / w, this.cssH / h));
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    this.cam.panX = this.cssW / 2 - cx * this.cam.scale;
    this.cam.panY = this.cssH / 2 - cz * this.cam.scale;
    this.draw();
  }

  // ---- データ取得 -----------------------------------------------------------
  _plan() { return this.store.current(); }
  _floor() { return M.getFloor(this._plan(), this.ui.floorId); }
  _snapDiv() { return this._plan().meta.snapDivisions || 4; }

  // 1つ下の階のフロアを返す（フロア間連動用）
  _lowerFloor() {
    return M.getLowerFloor(this._plan(), this.ui.floorId);
  }

  // ---- 入力 -----------------------------------------------------------------
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onDown(e));
    window.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerup', (e) => this._onUp(e));
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this._onKey(e));
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this._space = false; });
  }

  _onWheel(e) {
    if (!this.active) return;
    e.preventDefault();

    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      dx *= this.cssW;
      dy *= this.cssH;
    }

    if (e.ctrlKey) {
      // Mac トラックパッドのピンチ（ctrlKey + wheel）
      const { sx, sy } = this._mouse(e);
      const before = this.screenToWorld(sx, sy);
      const factor = Math.exp(-dy * 0.01);
      this.cam.scale = Math.max(0.004, Math.min(0.4, this.cam.scale * factor));
      this.cam.panX = sx - before.x * this.cam.scale;
      this.cam.panY = sy - before.z * this.cam.scale;
    } else {
      // 二本指スクロール → パン
      this.cam.panX -= dx;
      this.cam.panY -= dy;
    }
    this.draw();
  }

  _onDown(e) {
    if (!this.active) return;
    if (e.button === 0) this._hideContextMenu();
    this.canvas.setPointerCapture?.(e.pointerId);
    const { sx, sy } = this._mouse(e);

    // 敷地写真：基準線モード
    if (this.ui.bgCalib && e.button === 0 && this._onBgCalibClick(sx, sy)) return;

    const w = this.screenToWorld(sx, sy);
    const tool = this.ui.tool;
    const middle = e.button === 1;

    // 画面移動（pan ツール・中ボタン・スペース）
    if (tool === 'pan' || middle || this._space) {
      this.drag = { kind: 'pan', sx, sy, panX: this.cam.panX, panY: this.cam.panY };
      return;
    }

    // ---- 右クリック ----
    if (e.button === 2) {
      this._hideContextMenu();
      if (tool === 'select' && this.ui.selection) {
        const sel = this.ui.selection;
        // 部屋：追加頂点上なら削除 → 辺上なら頂点挿入（メニューより優先）
        if (sel.kind === 'room') {
          const room = this._floor().rooms.find((r) => r.id === sel.id);
          if (room) {
            const vi = this._vertexHandleAt(room, sx, sy);
            if (vi >= 0 && this._canDeleteVertex(room, vi)) {
              this._deleteRoomVertex(room, vi);
              return;
            }
            const ei = this._edgeAt(room, w);
            if (ei >= 0) {
              const snapped = M.snapPoint(w, this._snapDiv());
              room.polygon.splice(ei + 1, 0, { ...snapped, userAdded: true });
              M.rebuildFloorWalls(this._floor(), this._plan());
              this.store.update(() => {});
              this.draw();
              return;
            }
          }
        }
        // 選択済みパーツ上 → コンテキストメニュー
        if (this._isOnSelection(w, sx, sy)) {
          this._showContextMenu(e.clientX, e.clientY);
          return;
        }
      }
      return;
    }

    if (e.button !== 0) return;

    // ---- 各ツールのアクション ----
    if (tool === 'room') {
      const sp = M.snapPoint(w, this._snapDiv());
      this.drag = { kind: 'room', start: sp, cur: sp };
      return;
    }
    if (tool === 'furniture') {
      this._placeFurniture(M.snapPoint(w, this._snapDiv()));
      return;
    }
    if (tool === 'stair') {
      this._placeStair(M.snapPoint(w, this._snapDiv()));
      return;
    }
    if (tool === 'opening') {
      this._placeOpening(w);
      return;
    }

    // ---- select ツール ----
    // Opening 選択中 → 端点ドラッグ（幅調整）→ 移動ドラッグ
    if (this.ui.selection?.kind === 'opening') {
      const flr = this._floor();
      const op = (flr.openings || []).find((o) => o.id === this.ui.selection.id);
      if (op) {
        const wall = flr.walls.find((wl) => wl.id === op.wallId);
        if (wall && op.type === 'door') {
          if (this._doorRotateHandleHit(op, wall, sx, sy)) {
            const g = this._doorLayout(wall, op);
            this.drag = {
              kind: 'rotate-door', id: op.id, wallId: wall.id,
              centerW: { ...g.centerW },
              origFlipLR: op.flipLR,
              origFlipUD: op.flipUD,
              origSwingRad: op.doorSwingRad,
            };
            return;
          }
        }
        if (wall && op.type !== 'door') {
          if (this._openingRotateHandleHit(op, wall, sx, sy)) {
            const g = this._openingRotateLayout(wall, op);
            this.drag = {
              kind: 'rotate-opening',
              id: op.id,
              wallId: wall.id,
              centerW: g ? { ...g.centerW } : null,
              origWallFaceSign: op.wallFaceSign ?? 1,
            };
            return;
          }
          const handle = this._openingHandleAt(op, wall, sx, sy);
          if (handle) {
            const lenMM = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z);
            const oStart = op.offsetMM - op.widthMM / 2;
            const oEnd = op.offsetMM + op.widthMM / 2;
            this.drag = {
              kind: 'resize-opening',
              id: op.id,
              wallId: wall.id,
              end: handle,
              fixedStartMM: oStart,
              fixedEndMM: oEnd,
              wallLenMM: lenMM,
            };
            return;
          }
        }
        if (wall) {
          const pts = this._openingWorldPoints(wall, op);
          if (pts && _ptSegDist(w, pts.start, pts.end) <= 15 / this.cam.scale) {
            this.drag = {
              kind: 'move-opening', id: op.id, wallId: wall.id,
              startW: w, origOffset: op.offsetMM,
              ...this._clickMenuMeta(e, sx, sy),
            };
            return;
          }
        }
      }
    }

    // 家具選択中 → 回転ハンドル → 移動ドラッグ
    if (this.ui.selection?.kind === 'furniture') {
      const f = (this._floor().furniture || []).find((x) => x.id === this.ui.selection.id);
      if (f) {
        if (this._furnitureRotateHandleHit(f, sx, sy)) {
          this.drag = {
            kind: 'rotate-furniture',
            id: f.id,
            centerW: { x: f.x, z: f.z },
            origRotationDeg: f.rotationDeg || 0,
          };
          return;
        }
        if (M.pointInOrientedRect(w, f.x, f.z, f.wMM, f.dMM, f.rotationDeg || 0)) {
          this.drag = {
            kind: 'move-furniture', id: f.id, startW: w, ox: f.x, oz: f.z,
            ...this._clickMenuMeta(e, sx, sy),
          };
          return;
        }
      }
    }

    // 階段選択中 → 回転ハンドル → 辺平行移動 → 移動ドラッグ
    if (this.ui.selection?.kind === 'stair') {
      const s = (this._floor().stairs || []).find((x) => x.id === this.ui.selection.id);
      if (s) {
        if (this._stairRotateHandleHit(s, sx, sy)) {
          this.drag = {
            kind: 'rotate-stair',
            id: s.id,
            centerW: { x: s.x, z: s.z },
            origRotationDeg: s.rotationDeg || 0,
          };
          return;
        }
        const ei = this._stairEdgeAt(s, w);
        if (ei >= 0) {
          this.drag = {
            kind: 'move-stair-edge',
            id: s.id,
            edgeIndex: ei,
            startW: w,
            orig: {
              x: s.x, z: s.z,
              widthMM: s.widthMM, depthMM: s.depthMM,
              rotationDeg: s.rotationDeg || 0,
            },
          };
          return;
        }
        if (M.pointInOrientedRect(w, s.x, s.z, s.widthMM, s.depthMM, s.rotationDeg || 0)) {
          this.drag = {
            kind: 'move-stair', id: s.id, startW: w, ox: s.x, oz: s.z,
            ...this._clickMenuMeta(e, sx, sy),
          };
          return;
        }
      }
    }

    // 部屋選択中 → 頂点ハンドル優先 → 辺平行移動 → 通常ヒットテスト
    if (this.ui.selection?.kind === 'room') {
      const room = this._floor().rooms.find((r) => r.id === this.ui.selection.id);
      if (room) {
        const vi = this._vertexHandleAt(room, sx, sy);
        if (vi >= 0) {
          this.drag = { kind: 'vertex', roomId: room.id, index: vi };
          return;
        }
        const ei = this._edgeAt(room, w);
        if (ei >= 0) {
          const poly = room.polygon;
          this.drag = {
            kind: 'move-edge',
            roomId: room.id,
            idxA: ei,
            idxB: (ei + 1) % poly.length,
            startW: w,
            origA: { ...poly[ei] },
            origB: { ...poly[(ei + 1) % poly.length] },
          };
          return;
        }
      }
    }

    const hit = this._hitTest(w);
    this.ui.selection = hit;
    this.hoverVertex = null;
    this.hoverEdge = null;
    this.onUI();
    if (hit) {
      if (hit.kind === 'furniture') {
        const f = this._floor().furniture.find((x) => x.id === hit.id);
        this.drag = {
          kind: 'move-furniture', id: hit.id, startW: w, ox: f.x, oz: f.z,
          ...this._clickMenuMeta(e, sx, sy),
        };
      } else if (hit.kind === 'stair') {
        const s = (this._floor().stairs || []).find((x) => x.id === hit.id);
        if (s) {
          this.drag = {
            kind: 'move-stair', id: hit.id, startW: w, ox: s.x, oz: s.z,
            ...this._clickMenuMeta(e, sx, sy),
          };
        }
      } else if (hit.kind === 'opening') {
        const op = (this._floor().openings || []).find((x) => x.id === hit.id);
        const wall = op ? this._floor().walls.find((wl) => wl.id === op.wallId) : null;
        if (op && wall) {
          this.drag = {
            kind: 'move-opening', id: hit.id, wallId: wall.id,
            startW: w, origOffset: op.offsetMM,
            ...this._clickMenuMeta(e, sx, sy),
          };
        }
      } else if (hit.kind === 'room') {
        this.drag = { kind: 'move-room', id: hit.id, startW: w };
      }
    }
    this.draw();
  }

  _onMove(e) {
    if (!this.active) return;
    const { sx, sy } = this._mouse(e);
    const w = this.screenToWorld(sx, sy);
    const d = this.drag;

    if (!d) { this._updateHover(sx, sy); return; }

    if (d.kind === 'vertex') {
      const floor = this._floor();
      const room = floor.rooms.find((x) => x.id === d.roomId);
      if (room && room.polygon[d.index]) {
        const pt = room.polygon[d.index];
        room.polygon[d.index] = { ...M.snapPoint(w, this._snapDiv()), userAdded: pt.userAdded };
        M.rebuildFloorWalls(floor, this._plan());
        this.draw();
      }
      return;
    }

    if (d.kind === 'move-edge') {
      const floor = this._floor();
      const room = floor.rooms.find((x) => x.id === d.roomId);
      if (room) {
        const dx = M.snap(w.x - d.startW.x, this._snapDiv());
        const dz = M.snap(w.z - d.startW.z, this._snapDiv());
        room.polygon[d.idxA] = { x: d.origA.x + dx, z: d.origA.z + dz, userAdded: d.origA.userAdded };
        room.polygon[d.idxB] = { x: d.origB.x + dx, z: d.origB.z + dz, userAdded: d.origB.userAdded };
        M.rebuildFloorWalls(floor, this._plan());
        this.draw();
      }
      return;
    }

    if (d.kind === 'pan') {
      this.cam.panX = d.panX + (sx - d.sx);
      this.cam.panY = d.panY + (sy - d.sy);
      this.draw();
      return;
    }
    if (d.kind === 'room') {
      d.cur = M.snapPoint(w, this._snapDiv());
      this.draw();
      return;
    }
    if (d.kind === 'move-furniture') {
      const f = this._floor().furniture.find((x) => x.id === d.id);
      if (f) {
        let nx = d.ox + (w.x - d.startW.x);
        let nz = d.oz + (w.z - d.startW.z);
        if (this.ui.furnitureWallMagnet !== false) {
          ({ x: nx, z: nz } = _snapFurnitureToWalls(nx, nz, f, this._floor()));
        }
        f.x = nx;
        f.z = nz;
        this.draw();
      }
      return;
    }
    if (d.kind === 'move-stair-edge') {
      const s = (this._floor().stairs || []).find((x) => x.id === d.id);
      if (s) this._applyStairEdgeDrag(s, d.edgeIndex, d.startW, w, d.orig);
      this.draw();
      return;
    }
    if (d.kind === 'rotate-furniture') {
      const f = this._floor().furniture.find((x) => x.id === d.id);
      if (f) {
        f.rotationDeg = this._snapOrientedRotationDeg(d.centerW, w);
        const g = this._furnitureRotateLayout(f);
        d.tempHandleW = g ? { ...g.handleW } : null;
        this.draw();
      }
      return;
    }
    if (d.kind === 'rotate-opening') {
      const floor = this._floor();
      const op = (floor.openings || []).find((x) => x.id === d.id);
      const wall = floor.walls.find((wl) => wl.id === d.wallId);
      if (op && wall) {
        this._applyOpeningWallFaceSnap(op, wall, d.centerW, w);
        const g = this._openingRotateLayout(wall, op);
        d.tempHandleW = g ? { ...g.handleW } : null;
        this.draw();
      }
      return;
    }
    if (d.kind === 'rotate-stair') {
      const s = (this._floor().stairs || []).find((x) => x.id === d.id);
      if (s) {
        s.rotationDeg = this._snapStairRotationDeg(d.centerW, w);
        const g = this._stairRotateLayout(s);
        d.tempHandleW = g ? { ...g.handleW } : null;
        this.draw();
      }
      return;
    }
    if (d.kind === 'move-stair') {
      const s = (this._floor().stairs || []).find((x) => x.id === d.id);
      if (s) {
        s.x = M.snap(d.ox + (w.x - d.startW.x), this._snapDiv());
        s.z = M.snap(d.oz + (w.z - d.startW.z), this._snapDiv());
        this.draw();
      }
      return;
    }
    if (d.kind === 'move-opening') {
      const floor = this._floor();
      const op = (floor.openings || []).find((o) => o.id === d.id);
      const wall = floor.walls.find((wl) => wl.id === d.wallId);
      if (op && wall) {
        const wdx = wall.end.x - wall.start.x, wdz = wall.end.z - wall.start.z;
        const wlen = Math.hypot(wdx, wdz);
        const ux = wdx / wlen, uz = wdz / wlen;
        const delta = (w.x - d.startW.x) * ux + (w.z - d.startW.z) * uz;
        const newOffset = M.snap(d.origOffset + delta, this._snapDiv());
        const halfW = op.widthMM / 2;
        op.offsetMM = Math.max(halfW, Math.min(wlen - halfW, newOffset));
        this.draw();
      }
      return;
    }
    if (d.kind === 'rotate-door') {
      const floor = this._floor();
      const op = (floor.openings || []).find((o) => o.id === d.id);
      const wall = floor.walls.find((wl) => wl.id === d.wallId);
      if (op && wall) {
        this._applyDoorRotationSnap(op, wall, d.centerW, w);
        const g = this._doorLayout(wall, op);
        if (g) d.tempHandleW = { ...g.handleW };
        this.draw();
      }
      return;
    }
    if (d.kind === 'resize-opening') {
      const floor = this._floor();
      const op = (floor.openings || []).find((o) => o.id === d.id);
      const wall = floor.walls.find((wl) => wl.id === d.wallId);
      if (op && wall) {
        const wdx = wall.end.x - wall.start.x, wdz = wall.end.z - wall.start.z;
        const wlen = d.wallLenMM || Math.hypot(wdx, wdz);
        const ux = wdx / wlen, uz = wdz / wlen;
        const distMM = (w.x - wall.start.x) * ux + (w.z - wall.start.z) * uz;
        const snapped = M.snap(distMM, this._snapDiv());
        const MIN_W = 100;
        if (d.end === 'start') {
          const newStart = Math.max(0, Math.min(d.fixedEndMM - MIN_W, snapped));
          op.widthMM = d.fixedEndMM - newStart;
          op.offsetMM = (newStart + d.fixedEndMM) / 2;
        } else {
          const newEnd = Math.min(wlen, Math.max(d.fixedStartMM + MIN_W, snapped));
          op.widthMM = newEnd - d.fixedStartMM;
          op.offsetMM = (d.fixedStartMM + newEnd) / 2;
        }
        this.draw();
      }
      return;
    }
    if (d.kind === 'move-room') {
      const floor = this._floor();
      const room = floor.rooms.find((x) => x.id === d.id);
      if (room) {
        const dx = M.snap(w.x - d.startW.x, this._snapDiv());
        const dz = M.snap(w.z - d.startW.z, this._snapDiv());
        if (dx !== (d.lastDx || 0) || dz !== (d.lastDz || 0)) {
          room.polygon = M.translatePolygon(room.polygon, dx - (d.lastDx || 0), dz - (d.lastDz || 0));
          d.lastDx = dx; d.lastDz = dz;
          M.rebuildFloorWalls(floor, this._plan());
          this.draw();
        }
      }
      return;
    }
  }

  _onUp(e) {
    if (!this.drag) return;
    const d = this.drag;
    const { sx, sy } = this._mouse(e);

    // 左クリック短押し（ほぼ移動なし）→ コンテキストメニュー
    if (d.clickSx != null && Math.hypot(sx - d.clickSx, sy - d.clickSy) < 6) {
      this._revertDrag(d);
      this.drag = null;
      this._showContextMenu(d.clientX, d.clientY);
      this.draw();
      return;
    }

    this.drag = null;

    if (d.kind === 'room') {
      const a = d.start, b = d.cur;
      if (Math.abs(a.x - b.x) >= 100 && Math.abs(a.z - b.z) >= 100) {
        this._createRoom(a, b);
      } else {
        this.draw();
      }
      return;
    }
    const persistKinds = ['move-furniture', 'move-stair', 'move-stair-edge', 'rotate-furniture', 'rotate-stair', 'rotate-opening', 'move-room', 'vertex', 'move-edge', 'move-opening', 'resize-opening', 'rotate-door'];
    if (persistKinds.includes(d.kind)) {
      this.store.update((plan) => {
        if (d.kind === 'rotate-door') {
          const floor = M.getFloor(plan, this.ui.floorId);
          const o = (floor.openings || []).find((x) => x.id === d.id);
          const wall = floor.walls.find((w) => w.id === d.wallId);
          if (o && wall) this._syncDoorSwingFromFlips(o, wall);
        }
      });
      return;
    }
  }

  _onKey(e) {
    if (!this.active) return;
    const tag = (e.target?.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) || e.target?.isContentEditable) return;
    if (e.code === 'Space') { this._space = true; }
    const sel = this.ui.selection;
    if (!sel) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this._deleteSelection();
      e.preventDefault();
    } else if (e.key === 'r' || e.key === 'R') {
      if (sel.kind === 'furniture') this.rotateSelectedFurniture(90);
      else if (sel.kind === 'stair') this.rotateSelectedStair(90);
    }
  }

  // ---- ヒットテスト ---------------------------------------------------------
  _hitTest(w) {
    const floor = this._floor();
    // 家具優先
    for (let i = (floor.furniture || []).length - 1; i >= 0; i--) {
      const f = floor.furniture[i];
      if (M.pointInOrientedRect(w, f.x, f.z, f.wMM, f.dMM, f.rotationDeg || 0)) {
        return { kind: 'furniture', id: f.id };
      }
    }
    // 階段
    for (let i = (floor.stairs || []).length - 1; i >= 0; i--) {
      const s = floor.stairs[i];
      if (M.pointInOrientedRect(w, s.x, s.z, s.widthMM, s.depthMM, s.rotationDeg || 0)) {
        return { kind: 'stair', id: s.id };
      }
    }
    // 建具（壁上のセグメントに近い）
    const opHit = 12 / this.cam.scale;
    for (const op of (floor.openings || [])) {
      const wl = floor.walls.find((x) => x.id === op.wallId);
      if (!wl) continue;
      const pts = this._openingWorldPoints(wl, op);
      if (pts && _ptSegDist(w, pts.start, pts.end) <= opHit) {
        return { kind: 'opening', id: op.id };
      }
    }
    // 部屋
    for (let i = (floor.rooms || []).length - 1; i >= 0; i--) {
      const room = floor.rooms[i];
      if (M.pointInPolygon(w, room.polygon)) {
        return { kind: 'room', id: room.id };
      }
    }
    return null;
  }

  // 建具の世界座標端点（start/end を返す、nullなら壁なし）
  _openingWorldPoints(wall, opening) {
    const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
    const lenMM = Math.hypot(dx, dz);
    if (lenMM < 1) return null;
    const ux = dx / lenMM, uz = dz / lenMM;
    const oStart = opening.offsetMM - opening.widthMM / 2;
    const oEnd   = opening.offsetMM + opening.widthMM / 2;
    return {
      start: { x: wall.start.x + ux * oStart, z: wall.start.z + uz * oStart },
      end:   { x: wall.start.x + ux * oEnd,   z: wall.start.z + uz * oEnd   },
    };
  }

  // 最寄り壁を返す（ヒット閾値: 12 px換算）
  _wallAt(w) {
    const floor = this._floor();
    const HIT = 12 / this.cam.scale;
    for (const wall of floor.walls) {
      if (_ptSegDist(w, wall.start, wall.end) <= HIT) return wall;
    }
    return null;
  }

  // 選択中パーツ上にポインタがあるか（右クリックメニュー用）
  _isOnSelection(w, sx, sy) {
    const sel = this.ui.selection;
    if (!sel) return false;
    const floor = this._floor();
    if (sel.kind === 'room') {
      const room = floor.rooms.find((r) => r.id === sel.id);
      return room ? M.pointInPolygon(w, room.polygon) : false;
    }
    if (sel.kind === 'furniture') {
      const f = floor.furniture.find((x) => x.id === sel.id);
      return f ? M.pointInOrientedRect(w, f.x, f.z, f.wMM, f.dMM, f.rotationDeg || 0) : false;
    }
    if (sel.kind === 'stair') {
      const s = (floor.stairs || []).find((x) => x.id === sel.id);
      return s ? M.pointInOrientedRect(w, s.x, s.z, s.widthMM, s.depthMM, s.rotationDeg || 0) : false;
    }
    if (sel.kind === 'opening') {
      const op = (floor.openings || []).find((x) => x.id === sel.id);
      if (!op) return false;
      const wall = floor.walls.find((wl) => wl.id === op.wallId);
      if (!wall) return false;
      const pts = this._openingWorldPoints(wall, op);
      return pts ? _ptSegDist(w, pts.start, pts.end) <= 15 / this.cam.scale : false;
    }
    return false;
  }

  // 建具端点ハンドル（'start' | 'end' | null）
  _openingHandleAt(op, wall, sx, sy) {
    const pts = this._openingWorldPoints(wall, op);
    if (!pts) return null;
    const HIT = 10;
    const ss = this.worldToScreen(pts.start.x, pts.start.z);
    const se = this.worldToScreen(pts.end.x, pts.end.z);
    if (Math.hypot(sx - ss.x, sy - ss.y) <= HIT) return 'start';
    if (Math.hypot(sx - se.x, sy - se.y) <= HIT) return 'end';
    return null;
  }

  // ---- 頂点/辺ハンドル -----------------------------------------------------
  _canDeleteVertex(room, index) {
    const p = room.polygon[index];
    return !!p?.userAdded && room.polygon.length > 3;
  }

  _deleteRoomVertex(room, index) {
    if (!this._canDeleteVertex(room, index)) return;
    room.polygon.splice(index, 1);
    M.rebuildFloorWalls(this._floor(), this._plan());
    this.store.update(() => {});
    this.hoverVertex = null;
    this.draw();
  }

  _vertexHandleAt(room, sx, sy) {
    const HIT = 10;
    for (let i = 0; i < room.polygon.length; i++) {
      const s = this.worldToScreen(room.polygon[i].x, room.polygon[i].z);
      if (Math.hypot(s.x - sx, s.y - sy) <= HIT) return i;
    }
    return -1;
  }

  // 世界座標の点 w から各辺への距離でヒット判定（辺全体）
  _edgeAt(room, w) {
    const HIT = 8 / this.cam.scale; // 8pxをmm換算
    const poly = room.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (_ptSegDist(w, a, b) <= HIT) return i;
    }
    return -1;
  }

  // ドラッグなし時のホバー更新（カーソル変化・辺ハイライト）
  _updateHover(sx, sy) {
    let hv = null, he = null;
    if (this.ui.tool === 'select' && this.ui.selection?.kind === 'room') {
      const room = this._floor().rooms.find((r) => r.id === this.ui.selection.id);
      if (room) {
        const vi = this._vertexHandleAt(room, sx, sy);
        if (vi >= 0) {
          hv = { id: room.id, index: vi };
          this.canvas.style.cursor = 'grab';
        } else {
          const w = this.screenToWorld(sx, sy);
          const ei = this._edgeAt(room, w);
          if (ei >= 0) {
            he = { id: room.id, index: ei };
            this.canvas.style.cursor = 'col-resize';
          } else {
            this.canvas.style.cursor = '';
          }
        }
      } else {
        this.canvas.style.cursor = '';
      }
    } else if (this.ui.tool === 'select' && this.ui.selection?.kind === 'furniture') {
      const f = (this._floor().furniture || []).find((x) => x.id === this.ui.selection.id);
      if (f) {
        if (this._furnitureRotateHandleHit(f, sx, sy)) {
          this.canvas.style.cursor = 'grab';
        } else {
          this.canvas.style.cursor = '';
        }
      } else {
        this.canvas.style.cursor = '';
      }
    } else if (this.ui.tool === 'select' && this.ui.selection?.kind === 'stair') {
      const s = (this._floor().stairs || []).find((x) => x.id === this.ui.selection.id);
      if (s) {
        if (this._stairRotateHandleHit(s, sx, sy)) {
          this.canvas.style.cursor = 'grab';
        } else {
          const w = this.screenToWorld(sx, sy);
          const ei = this._stairEdgeAt(s, w);
          if (ei >= 0) {
            he = { id: s.id, index: ei };
            this.canvas.style.cursor = 'col-resize';
          } else {
            this.canvas.style.cursor = '';
          }
        }
      } else {
        this.canvas.style.cursor = '';
      }
    } else if (this.ui.tool === 'select' && this.ui.selection?.kind === 'opening') {
      const op = (this._floor().openings || []).find((o) => o.id === this.ui.selection.id);
      const wall = op ? this._floor().walls.find((w) => w.id === op.wallId) : null;
      if (op?.type === 'door' && wall && this._doorRotateHandleHit(op, wall, sx, sy)) {
        this.canvas.style.cursor = 'grab';
      } else if (op && op.type !== 'door' && wall && this._openingRotateHandleHit(op, wall, sx, sy)) {
        this.canvas.style.cursor = 'grab';
      } else {
        this.canvas.style.cursor = '';
      }
    } else {
      this.canvas.style.cursor = '';
    }
    const changed = JSON.stringify(hv) !== JSON.stringify(this.hoverVertex)
      || JSON.stringify(he) !== JSON.stringify(this.hoverEdge);
    this.hoverVertex = hv;
    this.hoverEdge = he;
    if (changed) this.draw();
  }

  // ---- 生成・編集 -----------------------------------------------------------
  // パーツ配置後の共通処理：UI更新 → 選択/移動モードへ自動切替
  _afterPlace() {
    this.onUI();
    if (this.ui.setTool) this.ui.setTool('select');
  }

  _createRoom(a, b) {
    const type = getRoomType(this.ui.roomType);
    const poly = M.rectPolygon(a.x, a.z, b.x, b.z);
    this.store.update((plan) => {
      const floor = M.getFloor(plan, this.ui.floorId);
      const room = {
        id: M.uid('r'),
        type: type.id,
        name: type.name,
        polygon: poly,
        labelVisible: true,
      };
      floor.rooms.push(room);
      M.rebuildFloorWalls(floor, plan);
      this.ui.selection = { kind: 'room', id: room.id };
    });
    this._afterPlace();
  }

  _placeFurniture(p) {
    const cat = getFurniture(this.ui.furnitureId);
    this.store.update((plan) => {
      const floor = M.getFloor(plan, this.ui.floorId);
      const f = {
        id: M.uid('f'),
        catalogId: cat.id,
        x: p.x, y: 0, z: p.z,
        rotationDeg: 0,
        wMM: cat.wMM, dMM: cat.dMM, hMM: cat.hMM,
        color: cat.color,
      };
      floor.furniture.push(f);
      this.ui.selection = { kind: 'furniture', id: f.id };
    });
    this._afterPlace();
  }

  _placeStair(p) {
    const def = getStairType(this.ui.stairType || 'straight');
    this.store.update((plan) => {
      const floor = M.getFloor(plan, this.ui.floorId);
      if (!floor.stairs) floor.stairs = [];
      const s = {
        id: M.uid('st'),
        type: def.id,
        x: p.x, z: p.z,
        widthMM: def.defaultW,
        depthMM: def.defaultD,
        rotationDeg: 0,
      };
      floor.stairs.push(s);
      this.ui.selection = { kind: 'stair', id: s.id };
    });
    this._afterPlace();
  }

  _placeOpening(w) {
    const wall = this._wallAt(w);
    if (!wall) return;
    const def = getOpeningType(this.ui.openingId || 'window');
    const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
    const lenMM = Math.hypot(dx, dz);
    if (lenMM < 1) return;
    // クリック位置を壁方向に射影してオフセット算出
    const t = ((w.x - wall.start.x) * dx + (w.z - wall.start.z) * dz) / (lenMM * lenMM);
    let offsetMM = M.snap(t * lenMM, this._snapDiv());
    const halfW = def.widthMM / 2;
    offsetMM = Math.max(halfW, Math.min(lenMM - halfW, offsetMM));
    this.store.update((plan) => {
      const fl = M.getFloor(plan, this.ui.floorId);
      const op = {
        id: M.uid('op'),
        wallId: wall.id,
        type: def.id,
        offsetMM,
        widthMM: def.widthMM,
        sillMM: def.sillMM,
        heightMM: def.heightMM,
      };
      if (def.id !== 'door') {
        const ux = dx / lenMM, uz = dz / lenMM;
        const nx = -uz, nz = ux;
        const onWall = { x: wall.start.x + ux * offsetMM, z: wall.start.z + uz * offsetMM };
        const side = nx * (w.x - onWall.x) + nz * (w.z - onWall.z);
        op.wallFaceSign = side > 0 ? 1 : -1;
      }
      if (def.id === 'door') {
        op.doorFlipV2 = true;
        op.flipLR = false;
        op.flipUD = false;
        const ux = dx / lenMM, uz = dz / lenMM;
        const oStart = offsetMM - def.widthMM / 2;
        const oEnd = offsetMM + def.widthMM / 2;
        const hingeW = { x: wall.start.x + ux * oStart, z: wall.start.z + uz * oStart };
        const otherW = { x: wall.start.x + ux * oEnd, z: wall.start.z + uz * oEnd };
        const wallAng = Math.atan2(dz, dx);
        op.doorSwingRad = wallAng + Math.PI / 2;
      }
      if (!fl.openings) fl.openings = [];
      fl.openings.push(op);
      this.ui.selection = { kind: 'opening', id: op.id };
    });
    this._afterPlace();
  }

  _deleteSelection() {
    const sel = this.ui.selection;
    if (!sel) return;
    this.store.update((plan) => {
      const floor = M.getFloor(plan, this.ui.floorId);
      if (sel.kind === 'furniture') {
        floor.furniture = floor.furniture.filter((f) => f.id !== sel.id);
      } else if (sel.kind === 'room') {
        floor.rooms = floor.rooms.filter((r) => r.id !== sel.id);
        M.rebuildFloorWalls(floor, this._plan());
      } else if (sel.kind === 'stair') {
        floor.stairs = (floor.stairs || []).filter((s) => s.id !== sel.id);
      } else if (sel.kind === 'opening') {
        floor.openings = (floor.openings || []).filter((o) => o.id !== sel.id);
      }
    });
    this.ui.selection = null;
    this.onUI();
  }

  /** Cmd+C: 選択中の部屋・家具・階段・建具をクリップボードへ */
  copySelection() {
    const sel = this.ui.selection;
    if (!sel) return false;
    const floor = this._floor();
    if (sel.kind === 'room') {
      const r = floor.rooms.find((x) => x.id === sel.id);
      if (!r) return false;
      this._clipboard = { kind: 'room', data: JSON.parse(JSON.stringify(r)) };
    } else if (sel.kind === 'furniture') {
      const f = floor.furniture.find((x) => x.id === sel.id);
      if (!f) return false;
      this._clipboard = { kind: 'furniture', data: JSON.parse(JSON.stringify(f)) };
    } else if (sel.kind === 'stair') {
      const s = (floor.stairs || []).find((x) => x.id === sel.id);
      if (!s) return false;
      this._clipboard = { kind: 'stair', data: JSON.parse(JSON.stringify(s)) };
    } else if (sel.kind === 'opening') {
      const op = (floor.openings || []).find((x) => x.id === sel.id);
      const wall = floor.walls.find((w) => w.id === op?.wallId);
      if (!op || !wall) return false;
      const data = JSON.parse(JSON.stringify(op));
      data._wallStart = { x: wall.start.x, z: wall.start.z };
      data._wallEnd = { x: wall.end.x, z: wall.end.z };
      this._clipboard = { kind: 'opening', data };
    } else {
      return false;
    }
    return true;
  }

  _findWallForOpeningPaste(floor, opData, dx, dz) {
    const ws = { x: opData._wallStart.x + dx, z: opData._wallStart.z + dz };
    const we = { x: opData._wallEnd.x + dx, z: opData._wallEnd.z + dz };
    const targetKey = _edgeKey(ws, we);
    for (const w of floor.walls) {
      if (_edgeKey(w.start, w.end) === targetKey) return w;
    }
    const len = Math.hypot(we.x - ws.x, we.z - ws.z);
    const mid = { x: (ws.x + we.x) / 2, z: (ws.z + we.z) / 2 };
    let best = null;
    let bestScore = Infinity;
    for (const w of floor.walls) {
      const wlen = Math.hypot(w.end.x - w.start.x, w.end.z - w.start.z);
      if (Math.abs(wlen - len) > 30) continue;
      const wmid = { x: (w.start.x + w.end.x) / 2, z: (w.start.z + w.end.z) / 2 };
      const d = Math.hypot(wmid.x - mid.x, wmid.z - mid.z);
      if (d < bestScore) { bestScore = d; best = w; }
    }
    return bestScore < 100 ? best : null;
  }

  /** Cmd+V: クリップボードの内容をオフセットして貼り付け */
  pasteSelection() {
    if (!this._clipboard) return false;
    const { kind } = this._clipboard;
    const data = JSON.parse(JSON.stringify(this._clipboard.data));
    const snap = this._snapDiv();
    const dx = M.P_MM;
    const dz = 0;

    if (kind === 'opening') {
      const floor = this._floor();
      if (!this._findWallForOpeningPaste(floor, data, dx, dz)) return false;
    }

    let pasted = false;
    this.store.update((plan) => {
      const floor = M.getFloor(plan, this.ui.floorId);
      if (kind === 'room') {
        data.id = M.uid('room');
        data.polygon = M.translatePolygon(data.polygon, dx, dz);
        floor.rooms.push(data);
        M.rebuildFloorWalls(floor, this._plan());
        this.ui.selection = { kind: 'room', id: data.id };
        pasted = true;
      } else if (kind === 'furniture') {
        data.id = M.uid('f');
        data.x = M.snap((data.x ?? 0) + dx, snap);
        data.z = M.snap((data.z ?? 0) + dz, snap);
        floor.furniture.push(data);
        this.ui.selection = { kind: 'furniture', id: data.id };
        pasted = true;
      } else if (kind === 'stair') {
        data.id = M.uid('st');
        data.x = M.snap((data.x ?? 0) + dx, snap);
        data.z = M.snap((data.z ?? 0) + dz, snap);
        if (!floor.stairs) floor.stairs = [];
        floor.stairs.push(data);
        this.ui.selection = { kind: 'stair', id: data.id };
        pasted = true;
      } else if (kind === 'opening') {
        const wall = this._findWallForOpeningPaste(floor, data, dx, dz);
        if (!wall) return;
        data.id = M.uid('op');
        data.wallId = wall.id;
        delete data._wallStart;
        delete data._wallEnd;
        if (!floor.openings) floor.openings = [];
        floor.openings.push(data);
        this.ui.selection = { kind: 'opening', id: data.id };
        pasted = true;
      }
    });

    if (pasted) {
      this.onUI();
      this.draw();
    }
    return pasted;
  }

  rotateSelectedFurniture(deg) {
    const sel = this.ui.selection;
    if (!sel || sel.kind !== 'furniture') return;
    this.store.update((plan) => {
      const floor = M.getFloor(plan, this.ui.floorId);
      const f = floor.furniture.find((x) => x.id === sel.id);
      if (f) f.rotationDeg = ((f.rotationDeg || 0) + deg) % 360;
    });
    this.onUI();
  }

  rotateSelectedStair(deg) {
    const sel = this.ui.selection;
    if (!sel || sel.kind !== 'stair') return;
    this.store.update((plan) => {
      const floor = M.getFloor(plan, this.ui.floorId);
      const s = (floor.stairs || []).find((x) => x.id === sel.id);
      if (s) s.rotationDeg = ((s.rotationDeg || 0) + deg) % 360;
    });
    this.onUI();
  }

  applyToSelection(mutator) {
    const sel = this.ui.selection;
    if (!sel) return;
    this.store.update((plan) => {
      const floor = M.getFloor(plan, this.ui.floorId);
      if (sel.kind === 'room') {
        const r = floor.rooms.find((x) => x.id === sel.id);
        if (r) { mutator(r); M.rebuildFloorWalls(floor, plan); }
      } else if (sel.kind === 'furniture') {
        const f = floor.furniture.find((x) => x.id === sel.id);
        if (f) mutator(f);
      } else if (sel.kind === 'stair') {
        const s = (floor.stairs || []).find((x) => x.id === sel.id);
        if (s) mutator(s);
      } else if (sel.kind === 'opening') {
        const o = (floor.openings || []).find((x) => x.id === sel.id);
        if (o) mutator(o);
      }
    });
    this.onUI();
  }

  deleteSelection() { this._deleteSelection(); }

  // ---- 敷地写真（下絵） -----------------------------------------------------
  invalidateBgImage() {
    this._bgImgCache = null;
    this._bgImgUrl = null;
  }

  startBgCalibration() {
    this._bgCalib = { step: 1 };
    this.ui.bgCalib = true;
    this.draw();
    if (this.onUI) this.onUI();
  }

  cancelBgCalibration() {
    this._bgCalib = null;
    this.ui.bgCalib = false;
    this.draw();
    if (this.onUI) this.onUI();
  }

  getBgCalibPxDistance() {
    if (!this._bgCalib?.p1 || !this._bgCalib?.p2) return 0;
    const { p1, p2 } = this._bgCalib;
    return Math.hypot(p2.px - p1.px, p2.py - p1.py);
  }

  clearBgCalibPoints() {
    if (this._bgCalib) this._bgCalib = { step: 1 };
    this.draw();
  }

  _ensureBgImage(bg) {
    if (!bg?.dataUrl) return Promise.resolve(null);
    if (this._bgImgCache && this._bgImgUrl === bg.dataUrl) return Promise.resolve(this._bgImgCache);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this._bgImgCache = img;
        this._bgImgUrl = bg.dataUrl;
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = bg.dataUrl;
    });
  }

  /** 未スケール時はプレビュー用の一時 transform を返す */
  _bgTransform(bg) {
    if (M.isBackgroundImageScaled(bg)) {
      return {
        scaleMMperPx: bg.scaleMMperPx,
        offsetX: bg.offsetX ?? 0,
        offsetZ: bg.offsetZ ?? 0,
        preview: false,
      };
    }
    const wPx = bg.naturalWidthPx || 1;
    const hPx = bg.naturalHeightPx || 1;
    const fitW = (this.cssW * 0.85) / this.cam.scale;
    const fitH = (this.cssH * 0.85) / this.cam.scale;
    const scale = Math.min(fitW / wPx, fitH / hPx);
    const wMM = wPx * scale;
    const hMM = hPx * scale;
    return {
      scaleMMperPx: scale,
      offsetX: -wMM / 2,
      offsetZ: -hMM / 2,
      preview: true,
    };
  }

  _bgWorldBounds(bg) {
    if (!bg?.dataUrl || !bg.visible) return null;
    if (!M.isBackgroundImageScaled(bg) && !this._bgCalib) return null;
    const t = this._bgTransform(bg);
    const wMM = bg.naturalWidthPx * t.scaleMMperPx;
    const hMM = bg.naturalHeightPx * t.scaleMMperPx;
    const cx = t.offsetX + wMM / 2;
    const cz = t.offsetZ + hMM / 2;
    const rot = (bg.rotationDeg || 0) * Math.PI / 180;
    const hw = wMM / 2;
    const hh = hMM / 2;
    const corners = [
      { x: -hw, z: -hh }, { x: hw, z: -hh }, { x: hw, z: hh }, { x: -hw, z: hh },
    ];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    for (const c of corners) {
      const wx = cx + c.x * cos - c.z * sin;
      const wz = cz + c.x * sin + c.z * cos;
      minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
      minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
    }
    return { minX, maxX, minZ, maxZ };
  }

  _screenToBgPixel(sx, sy, bg) {
    const t = this._bgTransform(bg);
    const wMM = bg.naturalWidthPx * t.scaleMMperPx;
    const hMM = bg.naturalHeightPx * t.scaleMMperPx;
    const cx = t.offsetX + wMM / 2;
    const cz = t.offsetZ + hMM / 2;
    const w = this.screenToWorld(sx, sy);
    const rot = -(bg.rotationDeg || 0) * Math.PI / 180;
    const dx = w.x - cx;
    const dz = w.z - cz;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    const localX = lx + wMM / 2;
    const localZ = lz + hMM / 2;
    if (localX < 0 || localZ < 0 || localX > wMM || localZ > hMM) return null;
    return {
      px: localX / t.scaleMMperPx,
      py: localZ / t.scaleMMperPx,
    };
  }

  _onBgCalibClick(sx, sy) {
    const bg = this._plan().site?.backgroundImage;
    if (!bg?.dataUrl || !this._bgCalib) return false;
    const pt = this._screenToBgPixel(sx, sy, bg);
    if (!pt) return true;
    if (this._bgCalib.step === 1) {
      this._bgCalib = { step: 2, p1: pt };
    } else {
      this._bgCalib = { ...this._bgCalib, p2: pt, step: 3 };
      this.ui.bgCalib = false;
      if (this.ui.onBgCalibDone) this.ui.onBgCalibDone(this.getBgCalibPxDistance());
    }
    this.draw();
    if (this.onUI) this.onUI();
    return true;
  }

  _drawBackground(ctx) {
    const bg = this._plan().site?.backgroundImage;
    if (!bg?.dataUrl || bg.visible === false) return;
    const img = this._bgImgCache;
    if (!img?.complete) {
      this._ensureBgImage(bg).then(() => { if (this.active) this.draw(); });
      return;
    }
    const t = this._bgTransform(bg);
    const wMM = bg.naturalWidthPx * t.scaleMMperPx;
    const hMM = bg.naturalHeightPx * t.scaleMMperPx;
    const cx = t.offsetX + wMM / 2;
    const cz = t.offsetZ + hMM / 2;
    const sc = this.worldToScreen(cx, cz);
    const sw = wMM * this.cam.scale;
    const sh = hMM * this.cam.scale;
    const rot = (bg.rotationDeg || 0) * Math.PI / 180;

    ctx.save();
    ctx.globalAlpha = typeof bg.opacity === 'number' ? bg.opacity : 0.5;
    ctx.translate(sc.x, sc.y);
    ctx.rotate(rot);
    ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();
  }

  _drawBgCalibOverlay(ctx) {
    if (!this.ui.bgCalib || !this._bgCalib) return;
    const bg = this._plan().site?.backgroundImage;
    if (!bg?.dataUrl) return;

    ctx.save();
    ctx.fillStyle = 'rgba(44, 123, 229, 0.92)';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const msg = this._bgCalib.step === 1
      ? '寸法のわかる2点をクリックしてください（1点目）'
      : '2点目をクリックしてください';
    ctx.fillText(msg, 12, 24);

    const drawPt = (pt, label) => {
      const t = this._bgTransform(bg);
      const wMM = bg.naturalWidthPx * t.scaleMMperPx;
      const hMM = bg.naturalHeightPx * t.scaleMMperPx;
      const cx = t.offsetX + wMM / 2;
      const cz = t.offsetZ + hMM / 2;
      const rot = (bg.rotationDeg || 0) * Math.PI / 180;
      const lx = pt.px * t.scaleMMperPx - wMM / 2;
      const lz = pt.py * t.scaleMMperPx - hMM / 2;
      const wx = cx + lx * Math.cos(rot) - lz * Math.sin(rot);
      const wz = cz + lx * Math.sin(rot) + lz * Math.cos(rot);
      const s = this.worldToScreen(wx, wz);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#f5a623';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#1f2733';
      ctx.fillText(label, s.x + 10, s.y - 8);
    };

    if (this._bgCalib.p1) drawPt(this._bgCalib.p1, '1');
    if (this._bgCalib.p1 && this._bgCalib.p2) {
      drawPt(this._bgCalib.p2, '2');
      const t = this._bgTransform(bg);
      const wMM = bg.naturalWidthPx * t.scaleMMperPx;
      const hMM = bg.naturalHeightPx * t.scaleMMperPx;
      const cx = t.offsetX + wMM / 2;
      const cz = t.offsetZ + hMM / 2;
      const rot = (bg.rotationDeg || 0) * Math.PI / 180;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const toWorld = (pt) => {
        const lx = pt.px * t.scaleMMperPx - wMM / 2;
        const lz = pt.py * t.scaleMMperPx - hMM / 2;
        return {
          x: cx + lx * cos - lz * sin,
          z: cz + lx * sin + lz * cos,
        };
      };
      const a = toWorld(this._bgCalib.p1);
      const b = toWorld(this._bgCalib.p2);
      const sa = this.worldToScreen(a.x, a.z);
      const sb = this.worldToScreen(b.x, b.z);
      ctx.strokeStyle = '#f5a623';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // ---- 描画 -----------------------------------------------------------------
  draw() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    ctx.fillStyle = '#eef1f4';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    this._drawBackground(ctx);

    if (this.ui.showGrid) this._drawGrid(ctx);
    this._drawAxes(ctx);

    const floor = this._floor();

    // 下階の間取りを薄く参照表示
    if (this.ui.showLowerFloorRef) {
      const lower = this._lowerFloor();
      if (lower) this._drawLowerFloorReference(ctx, lower);
    }

    // 下階の階段を上階でも同位置に表示（設置階→上階連動）
    const lowerForStairs = this._lowerFloor();
    if (lowerForStairs) {
      for (const s of (lowerForStairs.stairs || [])) {
        this._drawStair(ctx, s, false, { fromLowerFloor: lowerForStairs.id });
      }
    }

    for (const room of floor.rooms) this._drawRoom(ctx, room);
    for (const wall of floor.walls) this._drawWall(ctx, wall);
    for (const op of (floor.openings || [])) this._drawOpeningSymbol(ctx, op);
    for (const s of (floor.stairs || [])) this._drawStair(ctx, s, false);
    for (const f of floor.furniture) this._drawFurniture(ctx, f);
    this._drawSelection(ctx);
    const guideF = this._activeFurnitureForGuides();
    if (guideF) this._drawFurnitureDistanceGuides(ctx, guideF, floor);
    this._drawRoomHandles(ctx);
    this._drawFurnitureHandles(ctx);
    this._drawStairHandles(ctx);
    if (this.drag?.kind === 'room') this._drawRoomPreview(ctx, this.drag);
    if (this.ui.showDimensions) this._drawWallDimensions(ctx, floor);
    this._drawBgCalibOverlay(ctx);
  }

  // ---- 部屋/壁/家具の描画（既存） -------------------------------------------
  _drawGrid(ctx) {
    const P = M.P_MM;
    const div = this._snapDiv();
    const sub = P / div;
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.cssW, this.cssH);

    if (this.cam.scale * sub > 6) {
      const sX = Math.floor(tl.x / sub) * sub, eX = Math.ceil(br.x / sub) * sub;
      const sZ = Math.floor(tl.z / sub) * sub, eZ = Math.ceil(br.z / sub) * sub;
      ctx.lineWidth = 1; ctx.strokeStyle = '#e1e6ec'; ctx.beginPath();
      for (let x = sX; x <= eX; x += sub) { const s = this.worldToScreen(x, 0).x; ctx.moveTo(s, 0); ctx.lineTo(s, this.cssH); }
      for (let z = sZ; z <= eZ; z += sub) { const s = this.worldToScreen(0, z).y; ctx.moveTo(0, s); ctx.lineTo(this.cssW, s); }
      ctx.stroke();
    }

    const sPX = Math.floor(tl.x / P) * P, ePX = Math.ceil(br.x / P) * P;
    const sPZ = Math.floor(tl.z / P) * P, ePZ = Math.ceil(br.z / P) * P;
    ctx.lineWidth = 1; ctx.strokeStyle = '#ccd4de'; ctx.beginPath();
    for (let x = sPX; x <= ePX; x += P) { const s = this.worldToScreen(x, 0).x; ctx.moveTo(s, 0); ctx.lineTo(s, this.cssH); }
    for (let z = sPZ; z <= ePZ; z += P) { const s = this.worldToScreen(0, z).y; ctx.moveTo(0, s); ctx.lineTo(this.cssW, s); }
    ctx.stroke();
  }

  _drawAxes(ctx) {
    const o = this.worldToScreen(0, 0);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(224,108,117,0.5)';
    ctx.beginPath(); ctx.moveTo(0, o.y); ctx.lineTo(this.cssW, o.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(97,175,239,0.5)';
    ctx.beginPath(); ctx.moveTo(o.x, 0); ctx.lineTo(o.x, this.cssH); ctx.stroke();
  }

  /** 建物外周の壁に沿った寸法線（内側=各辺、外側=連続合計） */
  _collectExteriorWallSegments(floor) {
    const edgeMap = new Map();
    for (const wall of floor.walls) {
      const key = _edgeKey(wall.start, wall.end);
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push(wall);
    }

    const segments = [];
    for (const walls of edgeMap.values()) {
      if (walls.length !== 1) continue;
      const wall = walls[0];
      const room = floor.rooms.find((r) => r.id === (wall.roomId || M.inferWallRoomId(wall)));
      if (!room?.polygon) continue;
      const wn = _resolveOutwardNormal(wall, room, floor);
      if (!wn || wn.len < 1) continue;
      segments.push({
        ax: wall.start.x, az: wall.start.z,
        bx: wall.end.x, bz: wall.end.z,
        len: wn.len,
        nx: wn.nx, nz: wn.nz,
        ux: wn.ux, uz: wn.uz,
        midX: (wall.start.x + wall.end.x) / 2,
        midZ: (wall.start.z + wall.end.z) / 2,
      });
    }
    return segments;
  }

  _mergeExteriorChains(segments) {
    const used = new Set();
    const chains = [];

    const sameAxis = (a, b) => Math.abs(a.ux * b.ux + a.uz * b.uz) > 0.99
      && Math.abs(a.nx - b.nx) < 0.05 && Math.abs(a.nz - b.nz) < 0.05;

    for (let i = 0; i < segments.length; i++) {
      if (used.has(i)) continue;
      let chain = [{ ...segments[i] }];
      used.add(i);
      let changed = true;
      while (changed) {
        changed = false;
        for (let j = 0; j < segments.length; j++) {
          if (used.has(j)) continue;
          const s = segments[j];
          const first = chain[0];
          const last = chain[chain.length - 1];
          const a0 = { x: first.ax, z: first.az };
          const a1 = { x: last.bx, z: last.bz };

          if (sameAxis(last, s) && _ptNear(a1, { x: s.ax, z: s.az })) {
            chain.push({ ...s });
            used.add(j);
            changed = true;
          } else if (sameAxis(last, s) && _ptNear(a1, { x: s.bx, z: s.bz })) {
            chain.push({
              ax: s.bx, az: s.bz, bx: s.ax, bz: s.az,
              len: s.len, nx: s.nx, nz: s.nz, ux: -s.ux, uz: -s.uz,
            });
            used.add(j);
            changed = true;
          } else if (sameAxis(first, s) && _ptNear(a0, { x: s.bx, z: s.bz })) {
            chain.unshift({ ...s });
            used.add(j);
            changed = true;
          } else if (sameAxis(first, s) && _ptNear(a0, { x: s.ax, z: s.az })) {
            chain.unshift({
              ax: s.bx, az: s.bz, bx: s.ax, bz: s.az,
              len: s.len, nx: s.nx, nz: s.nz, ux: -s.ux, uz: -s.uz,
            });
            used.add(j);
            changed = true;
          }
        }
      }
      chains.push(chain);
    }
    return chains;
  }

  /** 寸法線がすべての居室ポリゴンの外に出るオフセット距離（mm） */
  _dimensionClearance(floor, x, z, nx, nz, minOff = 280) {
    for (let off = minOff; off <= 12000; off += 40) {
      const pt = { x: x + nx * off, z: z + nz * off };
      const inside = floor.rooms.some((r) => r.polygon && M.pointInPolygon(pt, r.polygon));
      if (!inside) return off;
    }
    return minOff;
  }

  _drawDimensionSegment(ctx, ax, az, bx, bz, lenMM, nx, nz, offsetMM, opts = {}) {
    const thick = opts.thick || false;
    const off = offsetMM;
    // 引出線は壁面上（頂点）から寸法線まで
    const da = { x: ax + nx * off, z: az + nz * off };
    const db = { x: bx + nx * off, z: bz + nz * off };
    const sa = this.worldToScreen(ax, az);
    const sb = this.worldToScreen(bx, bz);
    const sda = this.worldToScreen(da.x, da.z);
    const sdb = this.worldToScreen(db.x, db.z);

    const segPx = Math.hypot(sb.x - sa.x, sb.y - sa.y);
    if (segPx < 24) return;

    ctx.save();
    ctx.strokeStyle = thick ? '#2a3140' : '#4a5260';
    ctx.fillStyle = thick ? '#1f2733' : '#3d4654';
    ctx.lineWidth = thick ? 1.2 : 1;

    // 引出線（壁角 → 寸法線）
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sda.x, sda.y);
    ctx.moveTo(sb.x, sb.y);
    ctx.lineTo(sdb.x, sdb.y);
    ctx.stroke();

    // 寸法線
    ctx.beginPath();
    ctx.moveTo(sda.x, sda.y);
    ctx.lineTo(sdb.x, sdb.y);
    ctx.stroke();

    // 端点ティック（45°）
    const tick = 4;
    const dx = sdb.x - sda.x, dy = sdb.y - sda.y;
    const dlen = Math.hypot(dx, dy) || 1;
    const tx = (-dy / dlen) * tick, ty = (dx / dlen) * tick;
    for (const p of [sda, sdb]) {
      ctx.beginPath();
      ctx.moveTo(p.x - tx - dx / dlen * tick, p.y - ty - dy / dlen * tick);
      ctx.lineTo(p.x + tx + dx / dlen * tick, p.y + ty + dy / dlen * tick);
      ctx.stroke();
    }

    // ラベル（寸法線の外側）
    const mx = (sda.x + sdb.x) / 2;
    const my = (sda.y + sdb.y) / 2;
    const label = _formatDimMm(lenMM);
    const nRef = this.worldToScreen(
      (da.x + db.x) / 2 + nx * 200,
      (da.z + db.z) / 2 + nz * 200,
    );
    let lnx = nRef.x - mx, lny = nRef.y - my;
    const lnlen = Math.hypot(lnx, lny) || 1;
    lnx /= lnlen; lny /= lnlen;
    ctx.font = `${thick ? 600 : 500} ${thick ? 12 : 11}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, mx + lnx * 12, my + lny * 12);
    ctx.restore();
  }

  _drawWallDimensions(ctx, floor) {
    const segments = this._collectExteriorWallSegments(floor);
    if (!segments.length) return;

    const innerOffsets = segments.map((seg) =>
      this._dimensionClearance(floor, seg.midX, seg.midZ, seg.nx, seg.nz, 280),
    );
    const baseInner = Math.max(...innerOffsets, 280);
    const outerOff = baseInner + 520;

    for (const seg of segments) {
      this._drawDimensionSegment(
        ctx, seg.ax, seg.az, seg.bx, seg.bz, seg.len,
        seg.nx, seg.nz, baseInner,
      );
    }

    const chains = this._mergeExteriorChains(segments);
    for (const chain of chains) {
      if (chain.length < 2) continue;
      const first = chain[0];
      const last = chain[chain.length - 1];
      const total = chain.reduce((s, c) => s + c.len, 0);
      this._drawDimensionSegment(
        ctx, first.ax, first.az, last.bx, last.bz, total,
        first.nx, first.nz, outerOff, { thick: true },
      );
    }
  }

  _polyPath(ctx, polygon) {
    ctx.beginPath();
    polygon.forEach((p, i) => {
      const s = this.worldToScreen(p.x, p.z);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
  }

  _drawLowerFloorReference(ctx, floor) {
    for (const room of floor.rooms) this._drawRoom(ctx, room, true);
    for (const wall of floor.walls) this._drawWall(ctx, wall, { floor, isRef: true });
    for (const op of (floor.openings || [])) this._drawOpeningSymbol(ctx, op, { floor, isRef: true });
    for (const f of floor.furniture) this._drawFurniture(ctx, f, true);
  }

  _drawRoom(ctx, room, isRef = false) {
    if (isRef) {
      const color = getRoomType(room.type).color;
      this._polyPath(ctx, room.polygon);
      ctx.fillStyle = this._hexA(color, 0.10);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(120,125,135,0.42)';
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (room.labelVisible !== false) {
        const c = M.polygonCentroid(room.polygon);
        const s = this.worldToScreen(c.x, c.z);
        const lower = this._lowerFloor();
        const prefix = lower ? `${lower.id} ` : '';
        ctx.fillStyle = 'rgba(90,98,110,0.72)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '500 11px system-ui, sans-serif';
        ctx.fillText(prefix + (room.name || getRoomType(room.type).name), s.x, s.y);
      }
      return;
    }
    const color = getRoomType(room.type).color;
    this._polyPath(ctx, room.polygon);
    ctx.fillStyle = this._hexA(color, 0.35);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = this._hexA(color, 0.9);
    ctx.stroke();

    if (room.labelVisible !== false) {
      const c = M.polygonCentroid(room.polygon);
      const s = this.worldToScreen(c.x, c.z);
      const areaM2 = M.polygonAreaM2(room.polygon);
      const tatami = this._plan().meta.tatamiM2 || 1.62;
      ctx.fillStyle = '#1f2733';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillText(room.name || getRoomType(room.type).name, s.x, s.y - 10);
      ctx.font = '700 15px system-ui, sans-serif';
      ctx.fillStyle = '#3d4654';
      ctx.fillText(M.formatAreaLabel(areaM2, tatami), s.x, s.y + 10);

      // 日照時間（フェーズB: 現在選択中の日付での直射時間）
      const daylight = this.ui.daylight;
      if (daylight && Object.prototype.hasOwnProperty.call(daylight, room.id)) {
        const hrs = daylight[room.id];
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillStyle = hrs > 0 ? '#c8860a' : '#8a93a0';
        ctx.fillText(`☀ ${hrs.toFixed(1)}h`, s.x, s.y + 28);
      }
    }
  }

  _drawWall(ctx, wall, opts = {}) {
    const floor = opts.floor || this._floor();
    const isRef = !!opts.isRef;
    const ops = (floor.openings || [])
      .filter((o) => o.wallId === wall.id)
      .sort((a, b) => a.offsetMM - b.offsetMM);

    const ax = wall.start.x, az = wall.start.z;
    const bx = wall.end.x, bz = wall.end.z;
    const dx = bx - ax, dz = bz - az;
    const lenMM = Math.hypot(dx, dz);
    if (lenMM < 1) return;
    const ux = dx / lenMM, uz = dz / lenMM;

    const px = Math.max(isRef ? 1 : 2, wall.thicknessMM * this.cam.scale);
    ctx.lineCap = 'square';
    ctx.lineWidth = px;
    ctx.strokeStyle = isRef ? 'rgba(130,130,135,0.38)' : '#4a5260';

    const seg = (fromMM, toMM) => {
      if (toMM - fromMM < 1) return;
      const sa = this.worldToScreen(ax + ux * fromMM, az + uz * fromMM);
      const sb = this.worldToScreen(ax + ux * toMM,   az + uz * toMM);
      ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
    };

    let cur = 0;
    for (const op of ops) {
      const oS = Math.max(0, op.offsetMM - op.widthMM / 2);
      const oE = Math.min(lenMM, op.offsetMM + op.widthMM / 2);
      seg(cur, oS);
      cur = oE;
    }
    seg(cur, lenMM);
    ctx.lineCap = 'butt';
  }

  // MyHomeCloud 仕様のドア記号（黒線の弧＋扉、選択時は青枠＋緑回転ハンドル）
  _drawDoorSymbol(ctx, wall, opening) {
    const isSelected = this.ui.selection?.kind === 'opening'
      && this.ui.selection.id === opening.id
      && this.ui.tool === 'select';
    const handleOverride = (this.drag?.kind === 'rotate-door' && this.drag.id === opening.id)
      ? this.drag.tempHandleW : null;
    const g = this._doorLayout(wall, opening, handleOverride);
    if (!g) return;

    const ax = wall.start.x, az = wall.start.z;
    const { halfT, oStart, oEnd, ux, uz, nx, nz } = g;

    // 框（建具枠）：開口両端を壁厚方向にキャップ
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#333';
    for (const offMM of [oStart, oEnd]) {
      const pA = this.worldToScreen(ax + ux * offMM + nx * halfT, az + uz * offMM + nz * halfT);
      const pB = this.worldToScreen(ax + ux * offMM - nx * halfT, az + uz * offMM - nz * halfT);
      ctx.beginPath(); ctx.moveTo(pA.x, pA.y); ctx.lineTo(pB.x, pB.y); ctx.stroke();
    }

    const hingeS = this.worldToScreen(g.hingeW.x, g.hingeW.z);
    const otherS = this.worldToScreen(g.otherW.x, g.otherW.z);
    const leafS = this.worldToScreen(g.leafEndW.x, g.leafEndW.z);
    const r = Math.hypot(otherS.x - hingeS.x, otherS.y - hingeS.y);
    const closedAng = Math.atan2(otherS.y - hingeS.y, otherS.x - hingeS.x);
    const openAng = Math.atan2(leafS.y - hingeS.y, leafS.x - hingeS.x);
    const ccw = this._normAng(openAng - closedAng) > 0;

    // 開き弧＋扉（黒線）
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(hingeS.x, hingeS.y, r, closedAng, openAng, !ccw);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(hingeS.x, hingeS.y);
    ctx.lineTo(leafS.x, leafS.y);
    ctx.stroke();

    if (isSelected) {
      // 選択枠（壁厚内の青矩形）
      const corners = [
        [oStart, halfT], [oEnd, halfT], [oEnd, -halfT], [oStart, -halfT],
      ].map(([off, nt]) => this.worldToScreen(ax + ux * off + nx * nt, az + uz * off + nz * nt));
      ctx.strokeStyle = '#2c7be5';
      ctx.lineWidth = 2;
      ctx.beginPath();
      corners.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.closePath();
      ctx.stroke();

      // 回転ハンドル（開口中心から垂直な青線＋緑丸）
      this._drawGreenRotateHandle(ctx, g.centerW, g.handleW);
    }
  }

  // 建具記号（壁の隙間に上書き）
  _drawOpeningSymbol(ctx, opening, opts = {}) {
    const floor = opts.floor || this._floor();
    const isRef = !!opts.isRef;
    const wall = floor.walls.find((w) => w.id === opening.wallId);
    if (!wall) return;
    const pts = this._openingWorldPoints(wall, opening);
    if (!pts) return;

    const ax = wall.start.x, az = wall.start.z;
    const dx = wall.end.x - ax, dz = wall.end.z - az;
    const lenMM = Math.hypot(dx, dz);
    if (lenMM < 1) return;
    const ux = dx / lenMM, uz = dz / lenMM;
    const nx = -uz, nz = ux;
    const halfT = (wall.thicknessMM || 120) / 2;
    const oStart = opening.offsetMM - opening.widthMM / 2;
    const oEnd   = opening.offsetMM + opening.widthMM / 2;

    if (isRef) {
      ctx.strokeStyle = 'rgba(130,135,145,0.35)';
      ctx.lineWidth = 1;
      const p1 = this.worldToScreen(ax + ux * oStart + nx * halfT * 0.5, az + uz * oStart + nz * halfT * 0.5);
      const p2 = this.worldToScreen(ax + ux * oEnd + nx * halfT * 0.5, az + uz * oEnd + nz * halfT * 0.5);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      return;
    }

    if (opening.type === 'door') {
      this._drawDoorSymbol(ctx, wall, opening);
      return;
    }

    // 窓 / 掃き出し窓：ガラス二重線
    const color = opening.type === 'sliding' ? '#1a8ab0' : '#2c8fc0';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    const faceSign = opening.wallFaceSign ?? 1;
    const isSelected = this.ui.selection?.kind === 'opening'
      && this.ui.selection.id === opening.id
      && this.ui.tool === 'select';

    // 壁厚の片側に平行線2本
    for (const offset of [0.45, 0.58]) {
      const p1 = this.worldToScreen(
        ax + ux * oStart + nx * halfT * offset * faceSign,
        az + uz * oStart + nz * halfT * offset * faceSign,
      );
      const p2 = this.worldToScreen(
        ax + ux * oEnd + nx * halfT * offset * faceSign,
        az + uz * oEnd + nz * halfT * offset * faceSign,
      );
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
    // 両端のキャップ線
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#4a5260';
    for (const offMM of [oStart, oEnd]) {
      const pA = this.worldToScreen(ax + ux * offMM + nx * halfT, az + uz * offMM + nz * halfT);
      const pB = this.worldToScreen(ax + ux * offMM - nx * halfT, az + uz * offMM - nz * halfT);
      ctx.beginPath(); ctx.moveTo(pA.x, pA.y); ctx.lineTo(pB.x, pB.y); ctx.stroke();
    }

    if (isSelected) {
      const handleOverride = (this.drag?.kind === 'rotate-opening' && this.drag.id === opening.id)
        ? this.drag.tempHandleW : null;
      const g = this._openingRotateLayout(wall, opening, handleOverride);
      if (g) this._drawGreenRotateHandle(ctx, g.centerW, g.handleW);
    }
  }

  _furnitureCorners(f) {
    return _furnitureCornersFrom(f);
  }

  _activeFurnitureForGuides() {
    const floor = this._floor();
    if (this.drag?.kind === 'move-furniture') {
      return floor.furniture.find((x) => x.id === this.drag.id) || null;
    }
    const sel = this.ui.selection;
    if (sel?.kind === 'furniture') {
      return floor.furniture.find((x) => x.id === sel.id) || null;
    }
    return null;
  }

  _drawFurnitureDistanceGuides(ctx, f, floor) {
    const edges = _furnitureEdgesFrom(f);
    const wallFaces = _collectWallInnerFaces(floor, { x: f.x, z: f.z });
    const others = floor.furniture.filter((x) => x.id !== f.id);

    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const edge of edges) {
      let wallHit = null;
      for (const face of wallFaces) {
        const hit = _edgeToWallInnerGap(edge, face);
        if (!hit || hit.gap > FURNITURE_DIST_SHOW_MAX_MM) continue;
        if (!wallHit || hit.gap < wallHit.gap) wallHit = hit;
      }
      if (wallHit) this._drawFurnitureDistGuide(ctx, edge.mid, wallHit.target, wallHit.gap, '#2c5080');

      let furnHit = null;
      for (const other of others) {
        for (const oe of _furnitureEdgesFrom(other)) {
          const hit = _edgeToFurnitureGap(edge, oe);
          if (!hit || hit.gap > FURNITURE_DIST_SHOW_MAX_MM) continue;
          if (!furnHit || hit.gap < furnHit.gap) furnHit = hit;
        }
      }
      if (furnHit) this._drawFurnitureDistGuide(ctx, edge.mid, furnHit.target, furnHit.gap, '#9a6530');
    }
    ctx.restore();
  }

  _drawFurnitureDistGuide(ctx, fromW, toW, distMM, color) {
    const sa = this.worldToScreen(fromW.x, fromW.z);
    const sb = this.worldToScreen(toW.x, toW.z);
    if (Math.hypot(sb.x - sa.x, sb.y - sa.y) < 6) return;

    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();

    const label = `${Math.round(distMM)}mm`;
    const mx = (sa.x + sb.x) / 2;
    const my = (sa.y + sb.y) / 2;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeText(label, mx, my);
    ctx.lineWidth = 1;
    ctx.fillStyle = color;
    ctx.fillText(label, mx, my);
  }

  _drawFurnitureFallbackRect(ctx, f, sc, hw, hd) {
    ctx.save();
    ctx.translate(sc.x, sc.y);
    ctx.rotate((f.rotationDeg || 0) * Math.PI / 180);
    ctx.beginPath();
    ctx.rect(-hw, -hd, hw * 2, hd * 2);
    ctx.fillStyle = this._hexA(f.color || '#888', 0.85);
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#2c3444';
    ctx.stroke();
    ctx.restore();
  }

  _drawFurniture(ctx, f, isRef = false) {
    const sc = this.worldToScreen(f.x, f.z);
    const hw = f.wMM * this.cam.scale / 2;
    const hd = f.dMM * this.cam.scale / 2;

    if (isRef) {
      const corners = this._furnitureCorners(f);
      this._polyPath(ctx, corners);
      ctx.fillStyle = 'rgba(150,150,155,0.14)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(130,130,135,0.32)';
      ctx.stroke();
      return;
    }

    const cat = getFurniture(f.catalogId);
    const modelPath = cat?.model3d;

    if (modelPath) {
      const dims = { wMM: f.wMM, dMM: f.dMM, hMM: f.hMM };
      const icon = getFurnitureIcon(modelPath, dims);
      if (icon) {
        ctx.save();
        ctx.translate(sc.x, sc.y);
        ctx.rotate((f.rotationDeg || 0) * Math.PI / 180);
        ctx.drawImage(icon, -hw, -hd, hw * 2, hd * 2);
        ctx.restore();
      } else if (icon === undefined) {
        requestFurnitureIcon(modelPath, dims, () => this.draw());
        this._drawFurnitureFallbackRect(ctx, f, sc, hw, hd);
      } else {
        this._drawFurnitureFallbackRect(ctx, f, sc, hw, hd);
      }
    } else {
      this._drawFurnitureFallbackRect(ctx, f, sc, hw, hd);
    }

    if (this.cam.scale * f.wMM > 28) {
      const name = cat.name;
      ctx.save();
      ctx.translate(sc.x, sc.y);
      ctx.rotate((f.rotationDeg || 0) * Math.PI / 180);
      ctx.fillStyle = '#1f2733';
      ctx.font = `${Math.max(8, Math.min(11, hw * 0.32))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(name, 0, hd + 2);
      ctx.restore();
    }
  }

  _drawSelection(ctx) {
    const sel = this.ui.selection;
    if (!sel) return;
    const floor = this._floor();
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#f5a623';
    if (sel.kind === 'room') {
      const r = floor.rooms.find((x) => x.id === sel.id);
      if (r) { this._polyPath(ctx, r.polygon); ctx.stroke(); }
    } else if (sel.kind === 'furniture') {
      const f = floor.furniture.find((x) => x.id === sel.id);
      if (f) { this._polyPath(ctx, this._furnitureCorners(f)); ctx.stroke(); }
    } else if (sel.kind === 'stair') {
      const s = (floor.stairs || []).find((x) => x.id === sel.id);
      if (s) { this._polyPath(ctx, this._stairCorners(s)); ctx.stroke(); }
    } else if (sel.kind === 'opening') {
      const op = (floor.openings || []).find((x) => x.id === sel.id);
      if (op?.type === 'door') {
        // ドアの選択 UI は _drawDoorSymbol 内で描画
      } else if (op) {
        const wl = floor.walls.find((x) => x.id === op.wallId);
        if (wl) {
          const pts = this._openingWorldPoints(wl, op);
          if (pts) {
            const sa = this.worldToScreen(pts.start.x, pts.start.z);
            const sb = this.worldToScreen(pts.end.x, pts.end.z);
            ctx.lineWidth = 4;
            ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
            ctx.restore();
            ctx.save();
            ctx.setLineDash([]);
            // 窓・掃き出し窓：端点ハンドル（幅調整）
            if (op.type !== 'door') {
              ctx.fillStyle = '#ffffff';
              ctx.strokeStyle = '#2c7be5';
              ctx.lineWidth = 2;
              for (const pt of [sa, sb]) {
                ctx.beginPath(); ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
              }
            }
          }
        }
      }
    }
    ctx.restore();
  }

  toggleDoorFlip(field) { this._toggleDoorFlip(field); }

  _stairCorners(stair) {
    return this._furnitureCorners({
      x: stair.x, z: stair.z,
      wMM: stair.widthMM, dMM: stair.depthMM,
      rotationDeg: stair.rotationDeg || 0,
    });
  }

  _drawGreenRotateHandle(ctx, centerW, handleW) {
    const centerS = this.worldToScreen(centerW.x, centerW.z);
    const handleS = this.worldToScreen(handleW.x, handleW.z);
    ctx.strokeStyle = '#2c7be5';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerS.x, centerS.y);
    ctx.lineTo(handleS.x, handleS.y);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#27ae60';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(handleS.x, handleS.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#27ae60';
    ctx.beginPath();
    ctx.arc(handleS.x, handleS.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // 回転矩形（家具・階段）の回転ハンドル位置
  _orientedRotateLayout(x, z, widthMM, depthMM, rotationDeg, handleOverrideW = null) {
    const centerW = { x, z };
    const rad = (rotationDeg || 0) * Math.PI / 180;
    const stemLenMM = Math.max(widthMM, depthMM) * 0.55 + 280;
    let handleW;
    if (handleOverrideW) {
      handleW = { x: handleOverrideW.x, z: handleOverrideW.z };
    } else {
      handleW = {
        x: centerW.x + Math.sin(rad) * stemLenMM,
        z: centerW.z - Math.cos(rad) * stemLenMM,
      };
    }
    return { centerW, handleW };
  }

  _snapOrientedRotationDeg(centerW, w) {
    const snappedRad = this._snapRadialRad(centerW, w);
    const snappedDeg = snappedRad * 180 / Math.PI;
    return ((snappedDeg + 90) % 360 + 360) % 360;
  }

  _orientedRotateHandleHit(centerW, widthMM, depthMM, rotationDeg, dragKind, dragId, itemId, sx, sy) {
    const override = this.drag?.kind === dragKind && this.drag.id === itemId
      ? this.drag.tempHandleW : null;
    const g = this._orientedRotateLayout(
      centerW.x, centerW.z, widthMM, depthMM, rotationDeg, override,
    );
    if (!g) return false;
    const hs = this.worldToScreen(g.handleW.x, g.handleW.z);
    return Math.hypot(sx - hs.x, sy - hs.y) <= 10;
  }

  _furnitureRotateLayout(f, handleOverrideW = null) {
    return this._orientedRotateLayout(
      f.x, f.z, f.wMM, f.dMM, f.rotationDeg || 0, handleOverrideW,
    );
  }

  _furnitureRotateHandleHit(f, sx, sy) {
    return this._orientedRotateHandleHit(
      { x: f.x, z: f.z }, f.wMM, f.dMM, f.rotationDeg || 0,
      'rotate-furniture', f.id, f.id, sx, sy,
    );
  }

  _openingInwardNormal(wall) {
    const room = this._floor().rooms.find((r) => r.id === (wall.roomId || M.inferWallRoomId(wall)));
    if (!room?.polygon) return null;
    const wn = _wallExteriorNormal(wall, room);
    if (!wn) return null;
    return { nx: -wn.nx, nz: -wn.nz };
  }

  _openingRotateLayout(wall, opening, handleOverrideW = null) {
    const ax = wall.start.x, az = wall.start.z;
    const dx = wall.end.x - ax, dz = wall.end.z - az;
    const lenMM = Math.hypot(dx, dz);
    if (lenMM < 1) return null;
    const ux = dx / lenMM, uz = dz / lenMM;
    const inward = this._openingInwardNormal(wall);
    const nx = inward?.nx ?? -uz;
    const nz = inward?.nz ?? ux;
    const centerW = { x: ax + ux * opening.offsetMM, z: az + uz * opening.offsetMM };
    const sign = opening.wallFaceSign ?? 1;
    const stemLenMM = Math.max(opening.widthMM, (wall.thicknessMM || 120)) * 0.55 + 280;
    let handleW;
    if (handleOverrideW) {
      handleW = { x: handleOverrideW.x, z: handleOverrideW.z };
    } else {
      handleW = {
        x: centerW.x + nx * sign * stemLenMM,
        z: centerW.z + nz * sign * stemLenMM,
      };
    }
    return { centerW, handleW, inwardNx: nx, inwardNz: nz };
  }

  _openingRotateHandleHit(opening, wall, sx, sy) {
    const override = this.drag?.kind === 'rotate-opening' && this.drag.id === opening.id
      ? this.drag.tempHandleW : null;
    const g = this._openingRotateLayout(wall, opening, override);
    if (!g) return false;
    const hs = this.worldToScreen(g.handleW.x, g.handleW.z);
    return Math.hypot(sx - hs.x, sy - hs.y) <= 10;
  }

  _applyOpeningWallFaceSnap(opening, wall, centerW, w) {
    const layout = this._openingRotateLayout(wall, opening);
    if (!layout) return;
    const snappedRad = this._snapRadialRad(centerW, w);
    const hx = Math.cos(snappedRad);
    const hz = Math.sin(snappedRad);
    const dot = hx * layout.inwardNx + hz * layout.inwardNz;
    opening.wallFaceSign = dot >= 0 ? 1 : -1;
  }

  _drawFurnitureHandles(ctx) {
    if (this.ui.tool !== 'select') return;
    const sel = this.ui.selection;
    if (!sel || sel.kind !== 'furniture') return;
    const f = (this._floor().furniture || []).find((x) => x.id === sel.id);
    if (!f) return;

    const handleOverride = (this.drag?.kind === 'rotate-furniture' && this.drag.id === f.id)
      ? this.drag.tempHandleW : null;
    const g = this._furnitureRotateLayout(f, handleOverride);
    this._drawGreenRotateHandle(ctx, g.centerW, g.handleW);
  }

  // 階段の回転ハンドル位置（中心から上り方向へ青線＋緑丸）
  _stairRotateLayout(stair, handleOverrideW = null) {
    return this._orientedRotateLayout(
      stair.x, stair.z, stair.widthMM, stair.depthMM, stair.rotationDeg || 0, handleOverrideW,
    );
  }

  _snapStairRotationDeg(centerW, w) {
    return this._snapOrientedRotationDeg(centerW, w);
  }

  _stairRotateHandleHit(stair, sx, sy) {
    const override = this.drag?.kind === 'rotate-stair' && this.drag.id === stair.id
      ? this.drag.tempHandleW : null;
    const g = this._stairRotateLayout(stair, override);
    if (!g) return false;
    const hs = this.worldToScreen(g.handleW.x, g.handleW.z);
    return Math.hypot(sx - hs.x, sy - hs.y) <= 10;
  }

  // 階段矩形の辺ヒット（0〜3）
  _stairEdgeAt(stair, w) {
    const HIT = 8 / this.cam.scale;
    const corners = this._stairCorners(stair);
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      if (_ptSegDist(w, a, b) <= HIT) return i;
    }
    return -1;
  }

  // 辺の平行移動で widthMM / depthMM を更新（部屋の辺移動と同様）
  _applyStairEdgeDrag(stair, edgeIndex, startW, curW, orig) {
    const rad = (orig.rotationDeg || 0) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const wdx = curW.x - startW.x, wdz = curW.z - startW.z;
    const ldx = wdx * cos + wdz * sin;
    const ldz = -wdx * sin + wdz * cos;

    // ローカル辺法線: 0=−Z, 1=+X, 2=+Z, 3=−X
    const edges = [
      { lx: 0, lz: -1, dim: 'depth', cSign: -0.5 },
      { lx: 1, lz: 0, dim: 'width', cSign: 0.5 },
      { lx: 0, lz: 1, dim: 'depth', cSign: 0.5 },
      { lx: -1, lz: 0, dim: 'width', cSign: -0.5 },
    ];
    const e = edges[edgeIndex];
    const deltaN = M.snap(ldx * e.lx + ldz * e.lz, this._snapDiv());
    const MIN = M.P_MM;

    if (e.dim === 'depth') {
      const newDepth = Math.max(MIN, orig.depthMM + deltaN);
      const applied = newDepth - orig.depthMM;
      stair.depthMM = newDepth;
      const clx = 0, clz = e.cSign * applied;
      stair.x = orig.x + clx * cos - clz * sin;
      stair.z = orig.z + clx * sin + clz * cos;
    } else {
      const newWidth = Math.max(MIN, orig.widthMM + deltaN);
      const applied = newWidth - orig.widthMM;
      stair.widthMM = newWidth;
      const clx = e.cSign * applied, clz = 0;
      stair.x = orig.x + clx * cos - clz * sin;
      stair.z = orig.z + clx * sin + clz * cos;
    }
  }

  _drawStairHandles(ctx) {
    if (this.ui.tool !== 'select') return;
    const sel = this.ui.selection;
    if (!sel || sel.kind !== 'stair') return;
    const stair = (this._floor().stairs || []).find((s) => s.id === sel.id);
    if (!stair) return;
    const corners = this._stairCorners(stair);

    if (this.hoverEdge?.id === stair.id) {
      const i = this.hoverEdge.index;
      const a = corners[i], b = corners[(i + 1) % 4];
      const sa = this.worldToScreen(a.x, a.z);
      const sb = this.worldToScreen(b.x, b.z);
      ctx.strokeStyle = 'rgba(44,123,229,0.45)';
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
    }

    // 回転ハンドル（中心から上り方向の青線＋緑丸）
    const handleOverride = (this.drag?.kind === 'rotate-stair' && this.drag.id === stair.id)
      ? this.drag.tempHandleW : null;
    const g = this._stairRotateLayout(stair, handleOverride);
    this._drawGreenRotateHandle(ctx, g.centerW, g.handleW);
  }

  _drawRoomHandles(ctx) {
    if (this.ui.tool !== 'select') return;
    const sel = this.ui.selection;
    if (!sel || sel.kind !== 'room') return;
    const room = this._floor().rooms.find((r) => r.id === sel.id);
    if (!room) return;
    const poly = room.polygon;

    // ホバー中の辺をハイライト（ドラッグ可能であることを示す）
    if (this.hoverEdge?.id === room.id) {
      const i = this.hoverEdge.index;
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const sa = this.worldToScreen(a.x, a.z);
      const sb = this.worldToScreen(b.x, b.z);
      ctx.strokeStyle = 'rgba(44,123,229,0.45)';
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
    }

    // 頂点の○ハンドル（追加頂点は橙、右クリックで削除）
    for (let i = 0; i < poly.length; i++) {
      const s = this.worldToScreen(poly[i].x, poly[i].z);
      const hovered = this.hoverVertex?.id === room.id && this.hoverVertex?.index === i;
      const added = !!poly[i].userAdded;
      ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = hovered ? '#f5a623' : (added ? '#e67e22' : '#2c7be5');
      ctx.stroke();
    }
    // 辺の右クリックで頂点挿入、追加頂点の右クリックで削除。
  }

  _drawRoomPreview(ctx, d) {
    const poly = M.rectPolygon(d.start.x, d.start.z, d.cur.x, d.cur.z);
    const type = getRoomType(this.ui.roomType);
    this._polyPath(ctx, poly);
    ctx.fillStyle = this._hexA(type.color, 0.25); ctx.fill();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = this._hexA(type.color, 0.9); ctx.stroke();
    ctx.setLineDash([]);
    const areaM2 = M.polygonAreaM2(poly);
    const tatami = this._plan().meta.tatamiM2 || 1.62;
    const c = M.polygonCentroid(poly);
    const s = this.worldToScreen(c.x, c.z);
    ctx.fillStyle = '#3d4654';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.fillText(M.formatAreaLabel(areaM2, tatami), s.x, s.y);
  }

  // ---- 階段の描画 -----------------------------------------------------------
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} stair
   * @param {boolean} isRef  true = 薄いゴースト表示
   * @param {{ fromLowerFloor?: string }} [opts]
   */
  _drawStair(ctx, stair, isRef = false, opts = {}) {
    const sc = this.worldToScreen(stair.x, stair.z);
    drawStair2d(ctx, stair, sc.x, sc.y, this.cam.scale, { isRef, ...opts });
  }

  // #rrggbb → rgba
  _hexA(hex, a) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
}
