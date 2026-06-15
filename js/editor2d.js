// editor2d.js
// 2D 作図エディタ（Canvas）。グリッド・スナップ・部屋/壁/家具/階段の配置。
// store の同じデータを読み書きするだけ（描画専用ロジック）。

import * as M from './model.js';
import { getRoomType, getFurniture, getStairType } from './catalog.js';

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
    this._bind();
  }

  // ---- ライフサイクル -------------------------------------------------------
  setActive(on) {
    this.active = on;
    if (on) { this.resize(); this.draw(); }
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
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
    const plan = this._plan();
    const cur = plan.floors.find((f) => f.id === this.ui.floorId);
    if (!cur) return null;
    return plan.floors.find((f) => f.level === cur.level - 1) || null;
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
    const { sx, sy } = this._mouse(e);
    const before = this.screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.cam.scale = Math.max(0.004, Math.min(0.4, this.cam.scale * factor));
    this.cam.panX = sx - before.x * this.cam.scale;
    this.cam.panY = sy - before.z * this.cam.scale;
    this.draw();
  }

  _onDown(e) {
    if (!this.active) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    const { sx, sy } = this._mouse(e);
    const w = this.screenToWorld(sx, sy);
    const tool = this.ui.tool;
    const middle = e.button === 1;

    // 画面移動（pan ツール・中ボタン・スペース）
    if (tool === 'pan' || middle || this._space) {
      this.drag = { kind: 'pan', sx, sy, panX: this.cam.panX, panY: this.cam.panY };
      return;
    }

    // ---- 右クリック: 選択中の部屋の辺に頂点を挿入 ----
    if (e.button === 2) {
      if (tool === 'select' && this.ui.selection?.kind === 'room') {
        const room = this._floor().rooms.find((r) => r.id === this.ui.selection.id);
        if (room) {
          const ei = this._edgeAt(room, w);
          if (ei >= 0) {
            const snapped = M.snapPoint(w, this._snapDiv());
            room.polygon.splice(ei + 1, 0, snapped);
            M.rebuildFloorWalls(this._floor());
            this.store.update(() => {});
            this.draw();
          }
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

    // ---- select ツール ----
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
        this.drag = { kind: 'move-furniture', id: hit.id, startW: w, ox: f.x, oz: f.z };
      } else if (hit.kind === 'stair') {
        const s = (this._floor().stairs || []).find((x) => x.id === hit.id);
        if (s) this.drag = { kind: 'move-stair', id: hit.id, startW: w, ox: s.x, oz: s.z };
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
        room.polygon[d.index] = M.snapPoint(w, this._snapDiv());
        M.rebuildFloorWalls(floor);
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
        room.polygon[d.idxA] = { x: d.origA.x + dx, z: d.origA.z + dz };
        room.polygon[d.idxB] = { x: d.origB.x + dx, z: d.origB.z + dz };
        M.rebuildFloorWalls(floor);
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
        f.x = M.snap(d.ox + (w.x - d.startW.x), this._snapDiv());
        f.z = M.snap(d.oz + (w.z - d.startW.z), this._snapDiv());
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
    if (d.kind === 'move-room') {
      const floor = this._floor();
      const room = floor.rooms.find((x) => x.id === d.id);
      if (room) {
        const dx = M.snap(w.x - d.startW.x, this._snapDiv());
        const dz = M.snap(w.z - d.startW.z, this._snapDiv());
        if (dx !== (d.lastDx || 0) || dz !== (d.lastDz || 0)) {
          room.polygon = M.translatePolygon(room.polygon, dx - (d.lastDx || 0), dz - (d.lastDz || 0));
          d.lastDx = dx; d.lastDz = dz;
          M.rebuildFloorWalls(floor);
          this.draw();
        }
      }
      return;
    }
  }

  _onUp(e) {
    if (!this.drag) return;
    const d = this.drag;
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
    const persistKinds = ['move-furniture', 'move-stair', 'move-room', 'vertex', 'move-edge'];
    if (persistKinds.includes(d.kind)) {
      this.store.update(() => {});
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
    // 部屋
    for (let i = (floor.rooms || []).length - 1; i >= 0; i--) {
      const room = floor.rooms[i];
      if (M.pointInPolygon(w, room.polygon)) {
        return { kind: 'room', id: room.id };
      }
    }
    return null;
  }

  // ---- 頂点/辺ハンドル -----------------------------------------------------
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
      M.rebuildFloorWalls(floor);
      this.ui.selection = { kind: 'room', id: room.id };
    });
    this.onUI();
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
    this.onUI();
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
    this.onUI();
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
        M.rebuildFloorWalls(floor);
      } else if (sel.kind === 'stair') {
        floor.stairs = (floor.stairs || []).filter((s) => s.id !== sel.id);
      }
    });
    this.ui.selection = null;
    this.onUI();
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
        if (r) { mutator(r); M.rebuildFloorWalls(floor); }
      } else if (sel.kind === 'furniture') {
        const f = floor.furniture.find((x) => x.id === sel.id);
        if (f) mutator(f);
      } else if (sel.kind === 'stair') {
        const s = (floor.stairs || []).find((x) => x.id === sel.id);
        if (s) mutator(s);
      }
    });
    this.onUI();
  }

  deleteSelection() { this._deleteSelection(); }

  // ---- 描画 -----------------------------------------------------------------
  draw() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    ctx.fillStyle = '#eef1f4';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    if (this.ui.showGrid) this._drawGrid(ctx);
    this._drawAxes(ctx);

    const floor = this._floor();

    // 下階の階段を薄いグレーで参照表示（上下階の位置関係把握用）
    const lower = this._lowerFloor();
    if (lower) {
      for (const s of (lower.stairs || [])) this._drawStair(ctx, s, true);
    }

    for (const room of floor.rooms) this._drawRoom(ctx, room);
    for (const wall of floor.walls) this._drawWall(ctx, wall);
    for (const s of (floor.stairs || [])) this._drawStair(ctx, s, false);
    for (const f of floor.furniture) this._drawFurniture(ctx, f);
    this._drawSelection(ctx);
    this._drawRoomHandles(ctx);
    if (this.drag?.kind === 'room') this._drawRoomPreview(ctx, this.drag);
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

  _polyPath(ctx, polygon) {
    ctx.beginPath();
    polygon.forEach((p, i) => {
      const s = this.worldToScreen(p.x, p.z);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
  }

  _drawRoom(ctx, room) {
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
      ctx.fillText(room.name || getRoomType(room.type).name, s.x, s.y - 8);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#5b6470';
      ctx.fillText(M.formatAreaLabel(areaM2, tatami), s.x, s.y + 9);

      // 日照時間（フェーズB: 現在選択中の日付での直射時間）
      const daylight = this.ui.daylight;
      if (daylight && Object.prototype.hasOwnProperty.call(daylight, room.id)) {
        const hrs = daylight[room.id];
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillStyle = hrs > 0 ? '#c8860a' : '#8a93a0';
        ctx.fillText(`☀ ${hrs.toFixed(1)}h`, s.x, s.y + 24);
      }
    }
  }

  _drawWall(ctx, wall) {
    const a = this.worldToScreen(wall.start.x, wall.start.z);
    const b = this.worldToScreen(wall.end.x, wall.end.z);
    const px = Math.max(2, wall.thicknessMM * this.cam.scale);
    ctx.lineCap = 'round';
    ctx.lineWidth = px;
    ctx.strokeStyle = '#4a5260';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.lineCap = 'butt';
  }

  _furnitureCorners(f) {
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

  _drawFurniture(ctx, f) {
    const corners = this._furnitureCorners(f);
    this._polyPath(ctx, corners);
    ctx.fillStyle = this._hexA(f.color || '#888', 0.85);
    ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#2c3444'; ctx.stroke();
    const cat = getFurniture(f.catalogId);
    if (this.cam.scale * f.wMM > 28) {
      const c = this.worldToScreen(f.x, f.z);
      ctx.fillStyle = '#1f2733';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(cat.name, c.x, c.y);
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
    }
    ctx.restore();
  }

  _stairCorners(stair) {
    return this._furnitureCorners({
      x: stair.x, z: stair.z,
      wMM: stair.widthMM, dMM: stair.depthMM,
      rotationDeg: stair.rotationDeg || 0,
    });
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

    // 頂点の○ハンドル（辺のドラッグ・右クリック挿入のガイドも兼ねる）
    for (let i = 0; i < poly.length; i++) {
      const s = this.worldToScreen(poly[i].x, poly[i].z);
      const hovered = this.hoverVertex?.id === room.id && this.hoverVertex?.index === i;
      ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = hovered ? '#f5a623' : '#2c7be5';
      ctx.stroke();
    }
    // 辺の＋ハンドル表示は廃止。右クリックで頂点挿入。
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
    ctx.fillStyle = '#1f2733';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(M.formatAreaLabel(areaM2, tatami), s.x, s.y);
  }

  // ---- 階段の描画 -----------------------------------------------------------
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} stair
   * @param {boolean} isRef  true = 下階参照の薄いゴースト表示
   */
  _drawStair(ctx, stair, isRef = false) {
    const scl = this.cam.scale;
    const sc = this.worldToScreen(stair.x, stair.z);
    const hw = stair.widthMM * scl / 2;
    const hd = stair.depthMM * scl / 2;
    const n = Math.max(3, Math.min(15, Math.round(stair.depthMM / 250)));

    ctx.save();
    ctx.translate(sc.x, sc.y);
    ctx.rotate((stair.rotationDeg || 0) * Math.PI / 180);

    // アウトライン
    ctx.beginPath(); ctx.rect(-hw, -hd, hw * 2, hd * 2);
    ctx.fillStyle = isRef ? 'rgba(170,160,140,0.12)' : 'rgba(218,195,148,0.40)';
    ctx.fill();
    ctx.lineWidth = isRef ? 1 : 1.5;
    ctx.strokeStyle = isRef ? 'rgba(130,120,100,0.35)' : 'rgba(100,80,45,0.9)';
    ctx.stroke();

    if (!isRef) {
      switch (stair.type) {
        case 'straight': this._stairStraight(ctx, hw, hd, n); break;
        case 'l_shape':  this._stairLShape(ctx, hw, hd, n);   break;
        case 'u_shape':  this._stairUShape(ctx, hw, hd, n);   break;
        case 'winding':  this._stairWinding(ctx, hw, hd);     break;
        case 'spiral':   this._stairSpiral(ctx, hw, hd);      break;
      }
      // 名前ラベル
      if (scl * stair.widthMM > 50) {
        const def = getStairType(stair.type);
        ctx.fillStyle = 'rgba(70,50,25,0.85)';
        ctx.font = `${Math.max(8, Math.min(11, hw * 0.32))}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(def.name, 0, hd - 2);
      }
    }

    ctx.restore();
  }

  // 直進階段
  _stairStraight(ctx, hw, hd, n) {
    const col = 'rgba(100,80,45,0.72)';
    ctx.lineWidth = 1;
    ctx.strokeStyle = col;
    // 段板ライン
    for (let i = 0; i <= n; i++) {
      const y = -hd + (hd * 2 * i) / n;
      ctx.beginPath(); ctx.moveTo(-hw, y); ctx.lineTo(hw, y); ctx.stroke();
    }
    // 切断斜線（約40%の高さ）
    const cutY = -hd + hd * 2 * 0.4;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(100,80,45,0.95)';
    ctx.beginPath(); ctx.moveTo(-hw, cutY - hw * 0.35); ctx.lineTo(hw, cutY + hw * 0.35); ctx.stroke();
    // UP矢印
    ctx.lineWidth = 1.5;
    this._arrowPx(ctx, 0, hd * 0.65, 0, -hd * 0.65);
  }

  // L字階段
  _stairLShape(ctx, hw, hd, n) {
    const col = 'rgba(100,80,45,0.72)';
    // L字仕切り: 縦中央(x=0, y: hd→0) → 横(y=0, x: 0→-hw)
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(100,80,45,0.90)';
    ctx.beginPath(); ctx.moveTo(0, hd); ctx.lineTo(0, 0); ctx.lineTo(-hw, 0); ctx.stroke();
    // 左縦走路（x:-hw→0, y:-hd→0）の段板
    const nV = Math.max(2, Math.round(n * 0.6));
    ctx.lineWidth = 1; ctx.strokeStyle = col;
    for (let i = 1; i < nV; i++) {
      const y = -hd + (hd * i) / nV;
      ctx.beginPath(); ctx.moveTo(-hw, y); ctx.lineTo(0, y); ctx.stroke();
    }
    // 上横走路（x:0→hw, y:-hd→0）の段板
    const nH = Math.max(2, Math.round(n * 0.4));
    for (let i = 1; i < nH; i++) {
      const x = (hw * i) / nH;
      ctx.beginPath(); ctx.moveTo(x, -hd); ctx.lineTo(x, 0); ctx.stroke();
    }
    ctx.lineWidth = 1.5;
    this._arrowPx(ctx, -hw * 0.5, hd * 0.65, -hw * 0.5, -hd * 0.5);
  }

  // U字折返し階段
  _stairUShape(ctx, hw, hd, n) {
    const col = 'rgba(100,80,45,0.72)';
    // 中央仕切り線
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(100,80,45,0.90)';
    ctx.beginPath(); ctx.moveTo(0, hd); ctx.lineTo(0, -hd * 0.65); ctx.stroke();
    // 踊り場ライン（上部）
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(-hw, -hd * 0.65); ctx.lineTo(hw, -hd * 0.65); ctx.stroke();
    ctx.setLineDash([]);
    // 左走路段板（下から上へ）
    const nh = Math.max(2, Math.round(n * 0.5));
    ctx.lineWidth = 1; ctx.strokeStyle = col;
    for (let i = 1; i < nh; i++) {
      const y = hd - (hd * 1.65 * i) / nh;
      ctx.beginPath(); ctx.moveTo(-hw, y); ctx.lineTo(-0.5, y); ctx.stroke();
    }
    // 右走路段板（上から下へ、折返し）
    for (let i = 1; i < nh; i++) {
      const y = -hd * 0.65 + (hd * 1.65 * i) / nh;
      ctx.beginPath(); ctx.moveTo(0.5, y); ctx.lineTo(hw, y); ctx.stroke();
    }
    ctx.lineWidth = 1.5;
    this._arrowPx(ctx, -hw * 0.5, hd * 0.65, -hw * 0.5, -hd * 0.35);
  }

  // 廻り階段（4分の1廻り）
  _stairWinding(ctx, hw, hd) {
    const col = 'rgba(100,80,45,0.72)';
    const fanX = -hw, fanY = hd; // 廻りコーナー = 左下
    const fanR = Math.min(hw * 1.5, hd * 1.1);
    const nFan = 6;
    ctx.lineWidth = 1; ctx.strokeStyle = col;
    // 扇形の放射ライン
    for (let i = 0; i <= nFan; i++) {
      const ang = (Math.PI * 0.07) + (Math.PI * 0.43 * i) / nFan;
      ctx.beginPath();
      ctx.moveTo(fanX, fanY);
      ctx.lineTo(fanX + fanR * Math.cos(ang), fanY - fanR * Math.sin(ang));
      ctx.stroke();
    }
    // 弧（2本）
    for (const r of [fanR * 0.55, fanR * 0.88]) {
      ctx.beginPath();
      ctx.arc(fanX, fanY, r, -Math.PI * 0.5, -Math.PI * 0.07);
      ctx.stroke();
    }
    // 直線部分の段板（右上）
    const nSt = 4;
    for (let i = 1; i <= nSt; i++) {
      const y = -hd + (hd * 1.0 * i) / nSt;
      if (y + hd < fanR * 0.9) {
        ctx.beginPath(); ctx.moveTo(-hw * 0.3, y); ctx.lineTo(hw, y); ctx.stroke();
      }
    }
    ctx.lineWidth = 1.5;
    this._arrowPx(ctx, hw * 0.3, hd * 0.6, hw * 0.3, -hd * 0.6);
  }

  // 螺旋階段
  _stairSpiral(ctx, hw, hd) {
    const col = 'rgba(100,80,45,0.72)';
    const r = Math.min(hw, hd) * 0.9;
    const rc = r * 0.22;
    // 外周円
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(100,80,45,0.90)';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    // 中心ポスト
    ctx.fillStyle = 'rgba(190,165,120,0.5)';
    ctx.beginPath(); ctx.arc(0, 0, rc, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(100,80,45,0.90)';
    ctx.beginPath(); ctx.arc(0, 0, rc, 0, Math.PI * 2); ctx.stroke();
    // 放射状の段板
    const nRad = 8;
    ctx.lineWidth = 1; ctx.strokeStyle = col;
    for (let i = 0; i < nRad; i++) {
      const ang = (Math.PI * 2 * i) / nRad;
      ctx.beginPath();
      ctx.moveTo(rc * Math.cos(ang), rc * Math.sin(ang));
      ctx.lineTo(r * Math.cos(ang), r * Math.sin(ang));
      ctx.stroke();
    }
    ctx.lineWidth = 1.5;
    this._arrowPx(ctx, 0, r * 0.7, 0, -r * 0.7);
  }

  // UP矢印（ピクセル座標で描画）
  _arrowPx(ctx, x1, y1, x2, y2) {
    ctx.strokeStyle = 'rgba(60,40,20,0.85)';
    ctx.fillStyle = 'rgba(60,40,20,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const ah = 7;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - ah * Math.cos(ang - Math.PI / 6), y2 - ah * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(x2 - ah * Math.cos(ang + Math.PI / 6), y2 - ah * Math.sin(ang + Math.PI / 6));
    ctx.closePath(); ctx.fill();
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
