// editor2d.js
// 2D 作図エディタ（Canvas）。グリッド・スナップ・部屋/壁/家具の配置。
// store の同じデータを読み書きするだけ（描画専用ロジック）。

import * as M from './model.js';
import { getRoomType, getFurniture } from './catalog.js';

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

    // ドラッグ状態
    this.drag = null;

    // 頂点編集のホバー状態（選択中の部屋に対して）
    this.hoverVertex = null; // { id, index }
    this.hoverEdge = null;   // { id, index }（辺 i の中点）

    this._bind();
  }

  // ---- ライフサイクル -------------------------------------------------------
  setActive(on) {
    this.active = on;
    if (on) {
      this.resize();
      this.draw();
    }
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

    if (!b) {
      // 何もないとき: 原点付近に約 12m 四方を表示
      b = { minX: -1000, maxX: 11000, minZ: -1000, maxZ: 11000 };
    }
    const pad = 800;
    const w = (b.maxX - b.minX) + pad * 2;
    const h = (b.maxZ - b.minZ) + pad * 2;
    const sx = this.cssW / w;
    const sy = this.cssH / h;
    this.cam.scale = Math.max(0.005, Math.min(sx, sy));
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
    // カーソル位置を固定
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
    const space = this._space;

    // 画面移動（pan ツール・中ボタン・スペース）
    if (tool === 'pan' || middle || space) {
      this.drag = { kind: 'pan', sx, sy, panX: this.cam.panX, panY: this.cam.panY };
      return;
    }

    if (e.button !== 0) return;

    if (tool === 'room') {
      const sp = M.snapPoint(w, this._snapDiv());
      this.drag = { kind: 'room', start: sp, cur: sp };
      return;
    }

    if (tool === 'furniture') {
      this._placeFurniture(M.snapPoint(w, this._snapDiv()));
      return;
    }

    // select ツール
    // 部屋を選択中なら、頂点ハンドル → 辺の「＋」ハンドル の順で最優先判定
    if (this.ui.selection && this.ui.selection.kind === 'room') {
      const room = this._floor().rooms.find((r) => r.id === this.ui.selection.id);
      if (room) {
        const vi = this._vertexHandleAt(room, sx, sy);
        if (vi >= 0) {
          this.drag = { kind: 'vertex', roomId: room.id, index: vi };
          return;
        }
        const ei = this._edgeHandleAt(room, sx, sy);
        if (ei >= 0) {
          // 辺の中点に頂点を挿入し、その頂点のドラッグを即開始
          const a = room.polygon[ei];
          const b = room.polygon[(ei + 1) % room.polygon.length];
          const mid = M.snapPoint({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, this._snapDiv());
          room.polygon.splice(ei + 1, 0, mid);
          M.rebuildFloorWalls(this._floor());
          this.hoverEdge = null;
          this.hoverVertex = { id: room.id, index: ei + 1 };
          this.drag = { kind: 'vertex', roomId: room.id, index: ei + 1 };
          this.draw();
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
        const nx = M.snap(d.ox + (w.x - d.startW.x), this._snapDiv());
        const nz = M.snap(d.oz + (w.z - d.startW.z), this._snapDiv());
        f.x = nx; f.z = nz;
        this.draw();
      }
      return;
    }
    if (d.kind === 'move-room') {
      const floor = this._floor();
      const room = floor.rooms.find((x) => x.id === d.id);
      if (room) {
        const rawDx = w.x - d.startW.x;
        const rawDz = w.z - d.startW.z;
        const dx = M.snap(rawDx, this._snapDiv());
        const dz = M.snap(rawDz, this._snapDiv());
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
    if (d.kind === 'move-furniture' || d.kind === 'move-room' || d.kind === 'vertex') {
      // 永続化＋通知
      this.store.update(() => {});
      return;
    }
  }

  _onKey(e) {
    if (!this.active) return;
    // 入力欄での編集中はショートカットを無効化
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    if (e.code === 'Space') { this._space = true; }
    const sel = this.ui.selection;
    if (!sel) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this._deleteSelection();
      e.preventDefault();
    } else if ((e.key === 'r' || e.key === 'R') && sel.kind === 'furniture') {
      this.rotateSelectedFurniture(90);
    }
  }

  // keyup でスペース解除
  // （bind 内で個別 listener を増やさず、ここで補助）

  // ---- ヒットテスト ---------------------------------------------------------
  _hitTest(w) {
    const floor = this._floor();
    // 家具優先（上に乗っているため）
    for (let i = floor.furniture.length - 1; i >= 0; i--) {
      const f = floor.furniture[i];
      if (M.pointInOrientedRect(w, f.x, f.z, f.wMM, f.dMM, f.rotationDeg || 0)) {
        return { kind: 'furniture', id: f.id };
      }
    }
    for (let i = floor.rooms.length - 1; i >= 0; i--) {
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

  _edgeHandleAt(room, sx, sy) {
    const HIT = 10;
    const poly = room.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const s = this.worldToScreen((a.x + b.x) / 2, (a.z + b.z) / 2);
      if (Math.hypot(s.x - sx, s.y - sy) <= HIT) return i;
    }
    return -1;
  }

  // ドラッグしていないときのホバー状態更新（選択中の部屋に対して）
  _updateHover(sx, sy) {
    let hv = null, he = null;
    if (this.ui.tool === 'select' && this.ui.selection && this.ui.selection.kind === 'room') {
      const room = this._floor().rooms.find((r) => r.id === this.ui.selection.id);
      if (room) {
        const vi = this._vertexHandleAt(room, sx, sy);
        if (vi >= 0) hv = { id: room.id, index: vi };
        else {
          const ei = this._edgeHandleAt(room, sx, sy);
          if (ei >= 0) he = { id: room.id, index: ei };
        }
      }
    }
    const changed = JSON.stringify(hv) !== JSON.stringify(this.hoverVertex)
      || JSON.stringify(he) !== JSON.stringify(this.hoverEdge);
    this.hoverVertex = hv;
    this.hoverEdge = he;
    this.canvas.style.cursor = hv ? 'grab' : (he ? 'copy' : '');
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

  // main から呼ぶ汎用編集（プロパティ編集用）
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
      }
    });
    this.onUI();
  }

  deleteSelection() { this._deleteSelection(); }

  // ---- 描画 -----------------------------------------------------------------
  draw() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    // 背景
    ctx.fillStyle = '#eef1f4';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    if (this.ui.showGrid) this._drawGrid(ctx);
    this._drawAxes(ctx);

    const floor = this._floor();

    // 部屋
    for (const room of floor.rooms) this._drawRoom(ctx, room);
    // 壁
    for (const wall of floor.walls) this._drawWall(ctx, wall);
    // 家具
    for (const f of floor.furniture) this._drawFurniture(ctx, f);
    // 選択ハイライト
    this._drawSelection(ctx);
    // 頂点/辺ハンドル（部屋選択時）
    this._drawRoomHandles(ctx);
    // 部屋ドラッグのプレビュー
    if (this.drag && this.drag.kind === 'room') this._drawRoomPreview(ctx, this.drag);
  }

  _drawRoomHandles(ctx) {
    if (this.ui.tool !== 'select') return;
    const sel = this.ui.selection;
    if (!sel || sel.kind !== 'room') return;
    const room = this._floor().rooms.find((r) => r.id === sel.id);
    if (!room) return;
    const poly = room.polygon;

    // 頂点の○ハンドル
    for (let i = 0; i < poly.length; i++) {
      const s = this.worldToScreen(poly[i].x, poly[i].z);
      const hovered = this.hoverVertex
        && this.hoverVertex.id === room.id && this.hoverVertex.index === i;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = hovered ? '#f5a623' : '#2c7be5';
      ctx.stroke();
    }

    // 辺の中点「＋」ハンドル（ホバー時のみ）
    if (this.hoverEdge && this.hoverEdge.id === room.id) {
      const i = this.hoverEdge.index;
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const s = this.worldToScreen((a.x + b.x) / 2, (a.z + b.z) / 2);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#2c7be5';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(s.x - 4, s.y); ctx.lineTo(s.x + 4, s.y);
      ctx.moveTo(s.x, s.y - 4); ctx.lineTo(s.x, s.y + 4);
      ctx.stroke();
    }
  }

  _drawGrid(ctx) {
    const P = M.P_MM;
    const div = this._snapDiv();
    const sub = P / div;

    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.cssW, this.cssH);

    const startX = Math.floor(tl.x / sub) * sub;
    const endX = Math.ceil(br.x / sub) * sub;
    const startZ = Math.floor(tl.z / sub) * sub;
    const endZ = Math.ceil(br.z / sub) * sub;

    // サブグリッド（スナップ）
    if (this.cam.scale * sub > 6) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#e1e6ec';
      ctx.beginPath();
      for (let x = startX; x <= endX; x += sub) {
        const s = this.worldToScreen(x, 0).x;
        ctx.moveTo(s, 0); ctx.lineTo(s, this.cssH);
      }
      for (let z = startZ; z <= endZ; z += sub) {
        const s = this.worldToScreen(0, z).y;
        ctx.moveTo(0, s); ctx.lineTo(this.cssW, s);
      }
      ctx.stroke();
    }

    // メイングリッド（910mm = 1P）
    const startPX = Math.floor(tl.x / P) * P;
    const endPX = Math.ceil(br.x / P) * P;
    const startPZ = Math.floor(tl.z / P) * P;
    const endPZ = Math.ceil(br.z / P) * P;
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ccd4de';
    ctx.beginPath();
    for (let x = startPX; x <= endPX; x += P) {
      const s = this.worldToScreen(x, 0).x;
      ctx.moveTo(s, 0); ctx.lineTo(s, this.cssH);
    }
    for (let z = startPZ; z <= endPZ; z += P) {
      const s = this.worldToScreen(0, z).y;
      ctx.moveTo(0, s); ctx.lineTo(this.cssW, s);
    }
    ctx.stroke();
  }

  _drawAxes(ctx) {
    const o = this.worldToScreen(0, 0);
    ctx.lineWidth = 1.5;
    // X 軸（赤）
    ctx.strokeStyle = 'rgba(224,108,117,0.55)';
    ctx.beginPath(); ctx.moveTo(0, o.y); ctx.lineTo(this.cssW, o.y); ctx.stroke();
    // Z 軸（青）
    ctx.strokeStyle = 'rgba(97,175,239,0.55)';
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

    // 階段は段板を表す等間隔の線を描く（建築図面風）
    if (room.type === 'stair') this._drawStairTreads(ctx, room, color);

    if (room.labelVisible !== false) {
      const c = M.polygonCentroid(room.polygon);
      const s = this.worldToScreen(c.x, c.z);
      const areaM2 = M.polygonAreaM2(room.polygon);
      const tatami = this._plan().meta.tatamiM2 || 1.62;
      ctx.fillStyle = '#1f2733';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillText(room.name || getRoomType(room.type).name, s.x, s.y - 8);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#5b6470';
      ctx.fillText(M.formatAreaLabel(areaM2, tatami), s.x, s.y + 9);
    }
  }

  // 階段の段板（トレッド）を等間隔の線で描く。長手方向に上り矢印を添える。
  _drawStairTreads(ctx, room, color) {
    const b = M.polygonBounds(room.polygon);
    const w = b.maxX - b.minX, h = b.maxZ - b.minZ;
    if (w < 100 || h < 100) return;
    const treadMM = 250;

    ctx.save();
    this._polyPath(ctx, room.polygon);
    ctx.clip();

    ctx.lineWidth = 1;
    ctx.strokeStyle = this._hexA(color, 0.95);
    ctx.beginPath();
    if (w >= h) {
      const n = Math.max(2, Math.round(w / treadMM));
      for (let i = 1; i < n; i++) {
        const x = b.minX + (w * i) / n;
        const p1 = this.worldToScreen(x, b.minZ);
        const p2 = this.worldToScreen(x, b.maxZ);
        ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
      }
    } else {
      const n = Math.max(2, Math.round(h / treadMM));
      for (let i = 1; i < n; i++) {
        const z = b.minZ + (h * i) / n;
        const p1 = this.worldToScreen(b.minX, z);
        const p2 = this.worldToScreen(b.maxX, z);
        ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
      }
    }
    ctx.stroke();

    // 上り方向の矢印（中心線）
    const cz = (b.minZ + b.maxZ) / 2;
    const cx = (b.minX + b.maxX) / 2;
    let a, c2;
    if (w >= h) {
      a = this.worldToScreen(b.minX + w * 0.12, cz);
      c2 = this.worldToScreen(b.maxX - w * 0.12, cz);
    } else {
      a = this.worldToScreen(cx, b.minZ + h * 0.12);
      c2 = this.worldToScreen(cx, b.maxZ - h * 0.12);
    }
    ctx.strokeStyle = this._hexA('#1f2733', 0.55);
    ctx.fillStyle = this._hexA('#1f2733', 0.55);
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c2.x, c2.y); ctx.stroke();
    const ang = Math.atan2(c2.y - a.y, c2.x - a.x);
    const ah = 7;
    ctx.beginPath();
    ctx.moveTo(c2.x, c2.y);
    ctx.lineTo(c2.x - ah * Math.cos(ang - Math.PI / 6), c2.y - ah * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(c2.x - ah * Math.cos(ang + Math.PI / 6), c2.y - ah * Math.sin(ang + Math.PI / 6));
    ctx.closePath(); ctx.fill();

    ctx.restore();
  }

  _drawWall(ctx, wall) {
    const a = this.worldToScreen(wall.start.x, wall.start.z);
    const b = this.worldToScreen(wall.end.x, wall.end.z);
    const px = Math.max(2, wall.thicknessMM * this.cam.scale);
    ctx.lineCap = 'round';
    ctx.lineWidth = px;
    ctx.strokeStyle = '#4a5260';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  _furnitureCorners(f) {
    const rad = ((f.rotationDeg || 0) * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const hw = f.wMM / 2, hd = f.dMM / 2;
    const local = [
      { x: -hw, z: -hd }, { x: hw, z: -hd }, { x: hw, z: hd }, { x: -hw, z: hd },
    ];
    return local.map((p) => ({
      x: f.x + p.x * cos - p.z * sin,
      z: f.z + p.x * sin + p.z * cos,
    }));
  }

  _drawFurniture(ctx, f) {
    const corners = this._furnitureCorners(f);
    this._polyPath(ctx, corners);
    ctx.fillStyle = this._hexA(f.color || '#888', 0.85);
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#0c0e11';
    ctx.stroke();

    // 向きマーカー（前方 = -Z 側）
    const cat = getFurniture(f.catalogId);
    const c = this.worldToScreen(f.x, f.z);
    if (this.cam.scale * f.wMM > 28) {
      ctx.fillStyle = '#0c0e11';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cat.name, c.x, c.y);
    }
  }

  _drawSelection(ctx) {
    const sel = this.ui.selection;
    if (!sel) return;
    const floor = this._floor();
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#f5c542';
    if (sel.kind === 'room') {
      const r = floor.rooms.find((x) => x.id === sel.id);
      if (r) { this._polyPath(ctx, r.polygon); ctx.stroke(); }
    } else if (sel.kind === 'furniture') {
      const f = floor.furniture.find((x) => x.id === sel.id);
      if (f) { this._polyPath(ctx, this._furnitureCorners(f)); ctx.stroke(); }
    }
    ctx.restore();
  }

  _drawRoomPreview(ctx, d) {
    const poly = M.rectPolygon(d.start.x, d.start.z, d.cur.x, d.cur.z);
    const type = getRoomType(this.ui.roomType);
    this._polyPath(ctx, poly);
    ctx.fillStyle = this._hexA(type.color, 0.25);
    ctx.fill();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = this._hexA(type.color, 0.9);
    ctx.stroke();
    ctx.setLineDash([]);

    const areaM2 = M.polygonAreaM2(poly);
    const tatami = this._plan().meta.tatamiM2 || 1.62;
    const c = M.polygonCentroid(poly);
    const s = this.worldToScreen(c.x, c.z);
    ctx.fillStyle = '#1f2733';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(M.formatAreaLabel(areaM2, tatami), s.x, s.y);
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
