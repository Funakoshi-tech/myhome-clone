// parkingSimMode.js — 駐車シミュレーターの UI（左パネル・操作パネル・2D 図面への重ね描き・入力）
//
// 計算は parkingSim.js（純関数）。この画面は手で車を動かして確かめるためのもので、自動操作・自動判定はしない。
// 道路・ガードレール・選んだ車は plan.site.road に保存する。車の位置や軌跡は保存しない（画面を閉じれば消える）。

import * as M from './model.js';
import * as SITE from './sitePolygon.js';
import * as PS from './parkingSim.js';
import { getFurniture } from './catalog.js';

const $ = (sel) => document.querySelector(sel);

const SPEED_MM_S = 800;          // 押しっぱなしの速さ（約 3km/h）
const STEER_RATE_PER_S = 1.2;    // ←→ キーでハンドルを切る速さ（いっぱいまで約 0.8 秒）
const HANDLE_HIT_PX = 10;
const ROTATE_HANDLE_PX = 26;     // 車の前端から回転ハンドルまで（画面 px）
const TRAIL_COLORS = ['#8e44ad', '#16a085', '#c0392b', '#7f8c8d'];

const fmtM = (mm) => `${(mm / 1000).toFixed(2)}m`;
const fmtCm = (mm) => `${Math.round(mm / 10)}cm`;

export class ParkingSimController {
  /**
   * @param {object} deps
   * @param {import('./editor2d.js').Editor2D} deps.editor
   * @param {import('./store.js').Store} deps.store
   * @param {object} deps.ui
   * @param {(tool: string) => void} deps.setTool
   * @param {() => void} deps.updateHint
   */
  constructor({ editor, store, ui, setTool, updateHint }) {
    this.editor = editor;
    this.store = store;
    this.ui = ui;
    this.setTool = setTool;
    this.updateHint = updateHint;

    this.mode = null;        // null | 'pickRoad' | 'drawGuard' | 'drive'
    this.guardDraft = null;  // { p1, cur }
    this.hoverEdge = -1;
    this.drag = null;        // { kind: 'guardEnd'|'car'|'carRotate', ... }

    this.planId = null;
    this.hist = [];          // [{ pose, dir, k, clear }]
    this.cursor = -1;
    this.steer = 0;          // -1（左いっぱい）〜 1（右いっぱい）
    this.trails = [];        // 残した軌跡 [{ poses, vehicleId, color, label }]
    this.lastHit = null;

    this.keys = new Set();
    this.held = 0;           // ボタン押しっぱなし: +1 前進 / -1 後退 / 0
    this.raf = 0;
    this.lastFrame = 0;
    this.speedMul = 1;

    this._wirePanel();
    this._wireHud();
    this._wireKeys();
  }

  // ---- データ ---------------------------------------------------------------

  _plan() { return this.store.current(); }
  _boundary() { return this._plan()?.site?.boundary || []; }
  road() { return PS.normalizeRoad(this._plan()?.site?.road, this._boundary()); }
  vehicle() { return PS.getVehiclePreset(this.road()?.vehicleId); }

  geo() {
    const r = this.road();
    if (!r) return null;
    return PS.roadGeometry(this._boundary(), r.edgeIndex, r.widthMM);
  }

  /** plan.site.road を書き換える（取り消し履歴に積む） */
  _updateRoad(mutator, opts) {
    this.store.update((plan) => {
      const cur = PS.normalizeRoad(plan.site.road, plan.site.boundary || []);
      if (!cur) return;
      mutator(cur);
      plan.site.road = cur;
    }, opts);
  }

  _buildingSegs(plan) {
    const floor = (plan.floors || []).find((f) => f.id === '1F');
    if (!floor) return [];
    const ext = M.classifyExteriorWalls(floor, plan);
    const segs = [];
    for (const w of floor.walls || []) {
      if (!ext.get(w.id)) continue;
      // 2D で削除した壁（ガレージの前面など）は通り抜けられる
      if (M.isWallEdgeRemoved(floor, w)) continue;
      const room = floor.rooms?.find((r) => r.id === M.inferWallRoomId(w));
      if (room && (M.isOutdoorRoom(room) || M.isFloorOnlyRoom(room))) continue;
      segs.push({ a: w.start, b: w.end });
    }
    return segs;
  }

  _vehicleRects(plan) {
    const floor = (plan.floors || []).find((f) => f.id === '1F');
    const rects = [];
    for (const f of floor?.furniture || []) {
      if (getFurniture(f.catalogId)?.kind !== 'vehicle') continue;
      const rad = ((f.rotationDeg || 0) * Math.PI) / 180;
      const c = Math.cos(rad), s = Math.sin(rad), hw = f.wMM / 2, hd = f.dMM / 2;
      rects.push([[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, z]) => ({ x: f.x + x * c - z * s, z: f.z + x * s + z * c })));
    }
    return rects;
  }

  obstacles() {
    const plan = this._plan();
    const r = this.road();
    const geo = this.geo();
    if (!plan || !r || !geo) return [];
    return PS.buildObstacles({
      boundary: this._boundary(),
      geo,
      roadEdgeIndex: r.edgeIndex,
      guardrails: r.guardrails.filter((g) => g.enabled),
      buildingSegs: r.usePlanObstacles ? this._buildingSegs(plan) : [],
      vehicleRects: r.usePlanObstacles ? this._vehicleRects(plan) : [],
      neighborFrontWalls: r.neighborFrontWalls,
    });
  }

  pose() { return this.hist[this.cursor]?.pose || null; }

  // ---- モード ---------------------------------------------------------------

  isActive() { return this.ui.tool === 'parking'; }

  hintText() {
    if (this.mode === 'pickRoad') return '前面道路：道路に面している敷地の辺をクリック。Esc で中止';
    if (this.mode === 'drawGuard') return this.guardDraft ? 'ガードレール：終わりの点をクリック。Esc で中止' : 'ガードレール：始めの点をクリック（道路の上）。Esc で中止';
    if (this.mode === 'drive') return '駐車シミュレーター：↑↓ で前進・後退（押しっぱなし）、←→ でハンドル、C で中央。Shift で速く・Alt で遅く。車はドラッグで移動、前の丸で向きを変更。ガードレールの端の丸はドラッグで調整';
    return '';
  }

  _enter(mode) {
    this.mode = mode;
    this.guardDraft = null;
    if (this.ui.tool !== 'parking') this.setTool('parking');
    this._sync();
    this.updateHint();
    this.editor.draw();
  }

  /** モードを抜ける。運転中だったなら運転に戻る */
  _leaveSubMode() {
    const back = this.hist.length ? 'drive' : null;
    this.mode = back;
    this.guardDraft = null;
    if (!back && this.ui.tool === 'parking') this.setTool('select');
    this._sync();
    this.updateHint();
    this.editor.draw();
  }

  /** main.js の setTool から呼ばれる */
  onToolChange(tool) {
    if (tool !== 'parking') {
      this.mode = null;
      this.guardDraft = null;
      this.drag = null;
      this._stopLoop();
      this._sync();
    }
  }

  onViewChange(view) {
    if (view !== '2d' && this.isActive()) this.setTool('select');
    this._sync();
  }

  startDriving() {
    const geo = this.geo();
    if (!geo) return;
    this._checkPlan();
    if (!this.hist.length) this._placeAtStart(true);
    this._enter('drive');
    this._fitView();
  }

  /** 敷地の間口まわりと道路の両側（車が通るあたり）が入るように画面を合わせる */
  _fitView() {
    const geo = this.geo();
    const ed = this.editor;
    if (!geo || !ed.cssW) return;
    const L = this.vehicle().lengthMM + 3000;
    const pts = [
      geo.fromLocal(-L, 0), geo.fromLocal(geo.len + L, 0),
      geo.fromLocal(-L, geo.widthMM + 800), geo.fromLocal(geo.len + L, geo.widthMM + 800),
      geo.fromLocal(-L, -8000), geo.fromLocal(geo.len + L, -8000),
    ];
    const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    // 左上の操作パネルの分だけ左を空ける
    const padL = 330, pad = 30;
    const w = ed.cssW - padL - pad, h = ed.cssH - pad * 2;
    ed.cam.scale = Math.max(0.005, Math.min(w / (maxX - minX), h / (maxZ - minZ)));
    ed.cam.panX = padL + w / 2 - ((minX + maxX) / 2) * ed.cam.scale;
    ed.cam.panY = pad + h / 2 - ((minZ + maxZ) / 2) * ed.cam.scale;
    ed.draw();
  }

  stopDriving() {
    this._stopLoop();
    this.mode = null;
    if (this.ui.tool === 'parking') this.setTool('select');
    this._sync();
    this.updateHint();
    this.editor.draw();
  }

  /** プランを切り替えたら車と軌跡を捨てる */
  _checkPlan() {
    const id = this.store.currentId;
    if (id !== this.planId) {
      this.planId = id;
      this.hist = []; this.cursor = -1; this.trails = []; this.steer = 0; this.lastHit = null;
    }
  }

  _setStart(pose) {
    const cl = PS.carClearance(PS.carCorners(pose, this.vehicle()), this.obstacles());
    this.hist = [{ pose, dir: 0, k: 0, clear: cl }];
    this.cursor = 0;
    this.lastHit = null;
  }

  _placeAtStart(fromStart) {
    const geo = this.geo();
    if (!geo) return;
    this._setStart(PS.initialPose(geo, this.vehicle(), fromStart));
  }

  /** 道路の向きを画面の言葉で（左から／右から など） */
  _sideLabels() {
    const geo = this.geo();
    if (!geo) return ['始点側から', '終点側から'];
    const { x, z } = geo.dir;
    if (Math.abs(x) >= Math.abs(z)) return x > 0 ? ['左から', '右から'] : ['右から', '左から'];
    return z > 0 ? ['上から', '下から'] : ['下から', '上から'];
  }

  // ---- 運転 -----------------------------------------------------------------

  _wireKeys() {
    const isTyping = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '') || e.target?.isContentEditable;
    window.addEventListener('keydown', (e) => {
      if (!this.isActive() || !this.editor.active || isTyping(e) || e.metaKey || e.ctrlKey) return;
      if (e.key === 'Escape') {
        if (this.mode === 'pickRoad' || this.mode === 'drawGuard') this._leaveSubMode();
        else this.stopDriving();
        e.preventDefault();
        return;
      }
      if (this.mode !== 'drive') return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        this.keys.add(e.key);
        e.preventDefault();
        this._startLoop();
      } else if (e.key === 'c' || e.key === 'C') {
        this._setSteer(0);
      }
      this._modifiers(e);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key);
      this._modifiers(e);
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.held = 0; });
  }

  _modifiers(e) {
    this.speedMul = e.shiftKey ? 3 : (e.altKey ? 0.3 : 1);
  }

  _driveDir() {
    if (this.held) return this.held;
    const up = this.keys.has('ArrowUp'), down = this.keys.has('ArrowDown');
    return up && !down ? 1 : (down && !up ? -1 : 0);
  }

  _startLoop() {
    if (this.raf) return;
    this.lastFrame = performance.now();
    const tick = (now) => {
      // rAF の時刻は直前の performance.now() より前になることがある（負の dt で後退扱いにしない）
      const dt = Math.max(0, Math.min(0.05, (now - this.lastFrame) / 1000));
      this.lastFrame = now;
      const steerIn = (this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('ArrowLeft') ? 1 : 0);
      if (steerIn) this._setSteer(this.steer + steerIn * STEER_RATE_PER_S * dt, false);
      const dir = this._driveDir();
      if (dir && dt > 0) this._drive(dir * SPEED_MM_S * this.speedMul * dt);
      if (!dir && !steerIn) { this.raf = 0; this._syncHud(); return; }
      this._syncHud();
      this.editor.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  _stopLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.keys.clear();
    this.held = 0;
  }

  _setSteer(v, redraw = true) {
    this.steer = Math.max(-1, Math.min(1, v));
    if (redraw) { this._syncHud(); this.editor.draw(); }
  }

  _drive(dist) {
    const start = this.pose();
    if (!start) return;
    const v = this.vehicle();
    const k = this.steer * PS.maxCurvature(v);
    const obs = this.obstacles();
    const r = PS.driveWithCollision(start, v, k, dist, obs, true);
    if (r.poses.length) {
      // 巻き戻した位置から動かしたら、その先の記録は捨てる
      this.hist.length = this.cursor + 1;
      const dir = Math.sign(dist);
      for (const p of r.poses) {
        this.hist.push({ pose: p, dir, k, clear: PS.carClearance(PS.carCorners(p, v), obs) });
      }
      this.cursor = this.hist.length - 1;
    }
    this.lastHit = r.hit ? { ...r.hit, label: obs[r.hit.index]?.label || '' } : null;
  }

  stats() {
    const upto = this.hist.slice(0, this.cursor + 1);
    const obs = this.obstacles();
    let min = null;
    for (const h of upto) {
      if (h.clear && (!min || h.clear.d < min.d)) min = h.clear;
    }
    const cur = this.hist[this.cursor]?.clear || null;
    const { changes, kirikaeshi } = PS.countDirectionChanges(upto.map((h) => h.dir));
    const label = (c) => (c ? obs[c.index]?.label || '' : '');
    return { cur, curLabel: label(cur), min, minLabel: label(min), changes, kirikaeshi };
  }

  keepTrail() {
    if (this.cursor < 1) return;
    const n = this.trails.length;
    const st = this.stats();
    this.trails.push({
      poses: this.hist.slice(0, this.cursor + 1).map((h) => h.pose),
      vehicleId: this.vehicle().id,
      color: TRAIL_COLORS[n % TRAIL_COLORS.length],
      label: `軌跡${n + 1}（最小 ${st.min ? fmtCm(st.min.d) : '—'}・切り返し${st.kirikaeshi}回）`,
    });
    this._syncHud();
    this.editor.draw();
  }

  // ---- 入力（editor2d から呼ばれる） ------------------------------------------

  _screen(p) { return this.editor.worldToScreen(p.x, p.z); }

  _guardEndAt(sx, sy) {
    const r = this.road();
    if (!r) return null;
    for (const g of r.guardrails) {
      for (const end of ['a', 'b']) {
        const s = this._screen(g[end]);
        if (Math.hypot(s.x - sx, s.y - sy) <= HANDLE_HIT_PX) return { id: g.id, end };
      }
    }
    return null;
  }

  _rotateHandle(pose, v) {
    const c = Math.cos(pose.th), s = Math.sin(pose.th);
    const f = v.wheelbaseMM + v.frontOverhangMM;
    const front = { x: pose.x + f * c, z: pose.z + f * s };
    const sf = this._screen(front);
    return { x: sf.x + c * ROTATE_HANDLE_PX, y: sf.y + s * ROTATE_HANDLE_PX };
  }

  onPointerDown(e, sx, sy, w) {
    if (e.button === 2) {
      if (this.mode === 'drawGuard' || this.mode === 'pickRoad') this._leaveSubMode();
      return;
    }
    if (e.button !== 0) return;

    if (this.mode === 'pickRoad') {
      const i = this.editor._siteEdgeAt(w);
      if (i < 0) return;
      this.store.update((plan) => {
        const prev = PS.normalizeRoad(plan.site.road, plan.site.boundary || []);
        plan.site.road = { ...(prev || {}), edgeIndex: i, widthMM: prev?.widthMM || PS.DEFAULT_ROAD_WIDTH_MM, guardrails: prev?.edgeIndex === i ? prev.guardrails : [] };
      });
      this.hist = []; this.cursor = -1; this.trails = [];
      this._leaveSubMode();
      return;
    }

    if (this.mode === 'drawGuard') {
      if (!this.guardDraft) { this.guardDraft = { p1: w, cur: w }; this.updateHint(); this.editor.draw(); return; }
      const p1 = this.guardDraft.p1;
      if (e.shiftKey) w = this.guardDraft.cur; // Shift で道路と平行に吸着した位置
      if (Math.hypot(w.x - p1.x, w.z - p1.z) < 100) return;
      const id = `gr_${Date.now().toString(36)}`;
      this._updateRoad((r) => { r.guardrails.push({ id, a: { x: Math.round(p1.x), z: Math.round(p1.z) }, b: { x: Math.round(w.x), z: Math.round(w.z) }, enabled: true }); });
      this._leaveSubMode();
      this._refreshClearance();
      return;
    }

    const gEnd = this._guardEndAt(sx, sy);
    if (gEnd) {
      this.store.update(() => {}); // ドラッグ前の状態を取り消し履歴に積む
      this.drag = { kind: 'guardEnd', ...gEnd };
      return;
    }

    if (this.mode === 'drive') {
      const pose = this.pose();
      const v = this.vehicle();
      if (!pose) return;
      const h = this._rotateHandle(pose, v);
      if (Math.hypot(h.x - sx, h.y - sy) <= HANDLE_HIT_PX + 2) {
        this.drag = { kind: 'carRotate', pose };
        return;
      }
      const corners = PS.carCorners(pose, v);
      if (M.pointInPolygon(w, corners)) {
        this.drag = { kind: 'car', pose, start: w };
      }
    }
  }

  onPointerMove(e, sx, sy, w) {
    const cv = this.editor.canvas;
    const d = this.drag;
    if (d?.kind === 'guardEnd') {
      const g = this.store.current()?.site?.road?.guardrails?.find((x) => x.id === d.id);
      if (g) {
        let p = { x: Math.round(w.x), z: Math.round(w.z) };
        // Shift で道路に平行（ガードレールのもう一方の端からの向きを道路に揃える）
        const geo = this.geo();
        if (e.shiftKey && geo) {
          const other = g[d.end === 'a' ? 'b' : 'a'];
          const t = (p.x - other.x) * geo.dir.x + (p.z - other.z) * geo.dir.z;
          p = { x: Math.round(other.x + geo.dir.x * t), z: Math.round(other.z + geo.dir.z * t) };
        }
        g[d.end] = p;
        this._syncPanel();
        this.editor.draw();
      }
      return;
    }
    if (d?.kind === 'car') {
      const pose = { x: d.pose.x + (w.x - d.start.x), z: d.pose.z + (w.z - d.start.z), th: d.pose.th };
      this._setStart(pose);
      this._syncHud();
      this.editor.draw();
      return;
    }
    if (d?.kind === 'carRotate') {
      const v = this.vehicle();
      const c = Math.cos(d.pose.th), s = Math.sin(d.pose.th);
      const mid = (v.wheelbaseMM + v.frontOverhangMM - v.rearOverhangMM) / 2;
      const center = { x: d.pose.x + mid * c, z: d.pose.z + mid * s };
      let th = Math.atan2(w.z - center.z, w.x - center.x);
      // 道路の向き（とその逆・直角）の近くに吸着
      const geo = this.geo();
      if (geo && !e.altKey) {
        const base = Math.atan2(geo.dir.z, geo.dir.x);
        for (let q = 0; q < 4; q++) {
          const cand = base + (q * Math.PI) / 2;
          const diff = Math.atan2(Math.sin(th - cand), Math.cos(th - cand));
          if (Math.abs(diff) < (3 * Math.PI) / 180) th = cand;
        }
      }
      const pose = { x: center.x - mid * Math.cos(th), z: center.z - mid * Math.sin(th), th };
      this._setStart(pose);
      this._syncHud();
      this.editor.draw();
      return;
    }

    if (this.mode === 'pickRoad') {
      const i = this.editor._siteEdgeAt(w);
      if (i !== this.hoverEdge) { this.hoverEdge = i; this.editor.draw(); }
      cv.style.cursor = i >= 0 ? 'pointer' : 'default';
      return;
    }
    if (this.mode === 'drawGuard') {
      cv.style.cursor = 'crosshair';
      if (this.guardDraft) {
        let cur = w;
        const geo = this.geo();
        if (e.shiftKey && geo) {
          const p1 = this.guardDraft.p1;
          const t = (w.x - p1.x) * geo.dir.x + (w.z - p1.z) * geo.dir.z;
          cur = { x: p1.x + geo.dir.x * t, z: p1.z + geo.dir.z * t };
        }
        this.guardDraft.cur = cur;
        this.editor.draw();
      }
      return;
    }
    // ホバーでカーソルを変える
    if (this._guardEndAt(sx, sy)) { cv.style.cursor = 'grab'; return; }
    const pose = this.pose();
    if (this.mode === 'drive' && pose) {
      const v = this.vehicle();
      const h = this._rotateHandle(pose, v);
      if (Math.hypot(h.x - sx, h.y - sy) <= HANDLE_HIT_PX + 2) { cv.style.cursor = 'crosshair'; return; }
      if (M.pointInPolygon(w, PS.carCorners(pose, v))) { cv.style.cursor = 'move'; return; }
    }
    cv.style.cursor = 'default';
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    if (d?.kind === 'guardEnd') {
      this.store.update(() => {}, { skipHistory: true }); // 保存＋各パネル更新
      this._refreshClearance();
      this._sync();
    }
  }

  // ---- 描画（editor2d.draw から呼ばれる） ---------------------------------------

  /** 道路とガードレール（敷地の下に描く） */
  drawUnder(ctx) {
    const r = this.road();
    const geo = this.geo();
    if (!r || !geo) return;
    const S = (p) => this._screen(p);
    const poly = [geo.nearStart, geo.nearEnd, geo.farEnd, geo.farStart].map(S);
    ctx.save();
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,128,140,0.18)';
    ctx.fill();
    // 向かい側の端・こちら側の境界の延長
    ctx.strokeStyle = 'rgba(70,78,90,0.75)';
    ctx.lineWidth = 2;
    const line = (a, b) => { const sa = S(a), sb = S(b); ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke(); };
    line(geo.farStart, geo.farEnd);
    ctx.setLineDash(r.neighborFrontWalls ? [] : [6, 6]);
    line(geo.nearStart, geo.a);
    line(geo.b, geo.nearEnd);
    ctx.setLineDash([]);
    // 幅員ラベル
    const mid = geo.fromLocal(geo.len / 2, r.widthMM / 2);
    const sm = S(mid);
    this.editor._drawSiteText(ctx, `前面道路 幅員 ${(r.widthMM / 1000).toFixed(2)}m`, sm.x, sm.y, { color: '#4a5260', font: '600 12px system-ui, sans-serif' });

    // ガードレール
    const showHandles = this.isActive();
    for (const g of r.guardrails) {
      const a = S(g.a), b = S(g.b);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineWidth = g.enabled ? 4 : 2;
      ctx.strokeStyle = g.enabled ? '#d35400' : 'rgba(160,160,160,0.9)';
      ctx.setLineDash(g.enabled ? [] : [6, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (showHandles) {
        for (const p of [a, b]) {
          ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = '#fff'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = '#d35400'; ctx.stroke();
        }
        const rel = PS.guardrailRelation(g, geo);
        const near = g[this._nearEndKey(g, geo)];
        const sn = S(near);
        const txt = rel.gapMM >= 0 ? `角から ${fmtM(rel.gapMM)}` : `敷地の前に ${fmtM(-rel.gapMM)}`;
        this.editor._drawSiteText(ctx, `${txt}／境界から ${fmtM(rel.offsetMM)}`, sn.x, sn.y - 14, { color: '#a04000' });
      }
    }
    ctx.restore();
  }

  /** ガードレールの、間口に近いほうの端（'a' | 'b'） */
  _nearEndKey(g, geo) {
    const la = geo.toLocal(g.a).s, lb = geo.toLocal(g.b).s;
    const dist = (s) => (s < 0 ? -s : (s > geo.len ? s - geo.len : 0));
    return dist(la) <= dist(lb) ? 'a' : 'b';
  }

  /** 車・軌跡・作図中の線など（いちばん上に描く） */
  drawOver(ctx) {
    const S = (p) => this._screen(p);
    ctx.save();
    if (this.mode === 'pickRoad' && this.hoverEdge >= 0) {
      const b = this._boundary();
      const a = S(b[this.hoverEdge]), c = S(b[(this.hoverEdge + 1) % b.length]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y);
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(44,123,229,0.6)'; ctx.stroke();
    }
    if (this.mode === 'drawGuard' && this.guardDraft) {
      const a = S(this.guardDraft.p1), c = S(this.guardDraft.cur);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y);
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(211,84,0,0.7)'; ctx.stroke();
      const len = Math.hypot(this.guardDraft.cur.x - this.guardDraft.p1.x, this.guardDraft.cur.z - this.guardDraft.p1.z);
      this.editor._drawSiteText(ctx, fmtM(len), (a.x + c.x) / 2, (a.y + c.y) / 2 - 12, { color: '#a04000' });
    }

    if (this.mode === 'drive' || (this.isActive() && this.hist.length)) {
      for (const t of this.trails) this._drawTrail(ctx, t.poses, PS.getVehiclePreset(t.vehicleId), t.color, 0.55);
      const upto = this.hist.slice(0, this.cursor + 1).map((h) => h.pose);
      const v = this.vehicle();
      if (upto.length > 1) this._drawTrail(ctx, upto, v, '#2c7be5', 0.9);
      const pose = this.pose();
      if (pose) {
        this._drawCar(ctx, pose, v);
        const cl = this.hist[this.cursor]?.clear;
        if (cl) {
          const p = S(cl.p), q = S(cl.q);
          const hit = cl.d <= 0;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
          ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
          ctx.strokeStyle = hit ? '#c0392b' : '#16a085'; ctx.stroke(); ctx.setLineDash([]);
          for (const pt of [p, q]) { ctx.beginPath(); ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2); ctx.fillStyle = hit ? '#c0392b' : '#16a085'; ctx.fill(); }
          this.editor._drawSiteText(ctx, hit ? '接触' : fmtCm(cl.d), (p.x + q.x) / 2, (p.y + q.y) / 2 - 10, { color: hit ? '#c0392b' : '#0e7a63', font: '700 12px system-ui, sans-serif' });
        }
      }
    }
    ctx.restore();
  }

  _drawTrail(ctx, poses, v, color, alpha) {
    const S = (p) => this._screen(p);
    const step = Math.max(1, Math.floor(poses.length / 400));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    const cs = [];
    for (let i = 0; i < poses.length; i += step) cs.push(PS.carCorners(poses[i], v));
    cs.push(PS.carCorners(poses[poses.length - 1], v));
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      cs.forEach((c, i) => { const p = S(c[k]); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.stroke();
    }
    // 一定距離ごとの車体の輪郭（薄く）
    ctx.globalAlpha = alpha * 0.35;
    let acc = 0;
    for (let i = 1; i < poses.length; i++) {
      acc += Math.hypot(poses[i].x - poses[i - 1].x, poses[i].z - poses[i - 1].z);
      if (acc < 600) continue;
      acc = 0;
      const c = PS.carCorners(poses[i], v).map(S);
      ctx.beginPath(); c.forEach((p, j) => (j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
    }
    ctx.restore();
  }

  _drawCar(ctx, pose, v) {
    const S = (p) => this._screen(p);
    const hit = this.hist[this.cursor]?.clear?.d <= 0;
    const c = PS.carCorners(pose, v).map(S);
    ctx.save();
    ctx.beginPath(); c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
    ctx.fillStyle = hit ? 'rgba(192,57,43,0.45)' : this._hexA(v.color, 0.45);
    ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = hit ? '#c0392b' : v.color; ctx.stroke();
    // 前側（フロントガラスの位置の目印）
    const cs = Math.cos(pose.th), sn = Math.sin(pose.th);
    const fx = v.wheelbaseMM + v.frontOverhangMM * 0.2;
    const h = v.widthMM / 2 * 0.85;
    const p1 = S({ x: pose.x + fx * cs + h * sn, z: pose.z + fx * sn - h * cs });
    const p2 = S({ x: pose.x + fx * cs - h * sn, z: pose.z + fx * sn + h * cs });
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineWidth = 2.5; ctx.stroke();
    // タイヤ
    const k = this.steer * PS.maxCurvature(v);
    for (const w of PS.wheelPoses(pose, v, k)) {
      const wl = 330, ww = 110;
      const wc = Math.cos(w.th), ws = Math.sin(w.th);
      const pts = [[wl, ww], [wl, -ww], [-wl, -ww], [-wl, ww]].map(([lx, ly]) => S({ x: w.x + lx * wc - ly * ws, z: w.z + lx * ws + ly * wc }));
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
      ctx.fillStyle = '#222'; ctx.fill();
    }
    // 回転ハンドル
    if (this.mode === 'drive') {
      const hd = this._rotateHandle(pose, v);
      const fr = S({ x: pose.x + (v.wheelbaseMM + v.frontOverhangMM) * cs, z: pose.z + (v.wheelbaseMM + v.frontOverhangMM) * sn });
      ctx.beginPath(); ctx.moveTo(fr.x, fr.y); ctx.lineTo(hd.x, hd.y); ctx.lineWidth = 1.5; ctx.strokeStyle = '#2e9e5b'; ctx.stroke();
      ctx.beginPath(); ctx.arc(hd.x, hd.y, 6, 0, Math.PI * 2); ctx.fillStyle = '#2e9e5b'; ctx.fill();
    }
    ctx.restore();
  }

  _hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ---- 左パネル ---------------------------------------------------------------

  _wirePanel() {
    const sel = $('#parking-vehicle');
    sel.innerHTML = PS.VEHICLE_PRESETS.map((v) => `<option value="${v.id}">${v.name}</option>`).join('');
    sel.addEventListener('change', () => {
      this._updateRoad((r) => { r.vehicleId = sel.value; });
      // 車を替えたら同じ位置で計算し直す（軌跡は前の車のものなので捨てる）
      const pose = this.pose();
      if (pose) this._setStart(pose);
      this._sync();
      this.editor.draw();
    });
    $('#parking-road-pick').addEventListener('click', () => this._enter('pickRoad'));
    $('#parking-road-clear').addEventListener('click', () => {
      this.store.update((plan) => { plan.site.road = null; });
      this.stopDriving();
      this.hist = []; this.cursor = -1; this.trails = [];
      this._sync();
    });
    $('#parking-road-width').addEventListener('change', (e) => {
      const v = Number(e.target.value);
      if (!(v >= 1000 && v <= 50000)) { this._sync(); return; }
      this._updateRoad((r) => { r.widthMM = Math.round(v); });
      this._refreshClearance();
    });
    $('#parking-neighbor-walls').addEventListener('change', (e) => {
      this._updateRoad((r) => { r.neighborFrontWalls = e.target.checked; });
      this._refreshClearance();
    });
    $('#parking-plan-obstacles').addEventListener('change', (e) => {
      this._updateRoad((r) => { r.usePlanObstacles = e.target.checked; });
      this._refreshClearance();
    });
    $('#parking-guard-add').addEventListener('click', () => this._enter('drawGuard'));
    $('#parking-start').addEventListener('click', () => {
      if (this.mode === 'drive') this.stopDriving();
      else this.startDriving();
    });
  }

  /** 障害物が変わったら、記録済みの各位置のすき間を計算し直す */
  _refreshClearance() {
    const v = this.vehicle();
    const obs = this.obstacles();
    for (const h of this.hist) h.clear = PS.carClearance(PS.carCorners(h.pose, v), obs);
    this._sync();
    this.editor.draw();
  }

  _syncPanel() {
    const hasSite = SITE.isValidSite(this._boundary());
    const r = this.road();
    const geo = this.geo();
    $('#parking-road-status').textContent = !hasSite
      ? '先に敷地を描いてください'
      : (r ? `前面道路：敷地の辺 ${fmtM(geo?.len || 0)} に接する道路` : '前面道路が未設定です。道路に面した敷地の辺を選んでください');
    $('#parking-road-pick').disabled = !hasSite;
    $('#parking-road-pick').textContent = r ? '道路の辺を選び直す' : '前面道路の辺を選ぶ';
    $('#parking-road-pick').classList.toggle('active', this.mode === 'pickRoad');
    $('#parking-road-clear').hidden = !r;
    $('#parking-road-detail').hidden = !r;
    if (!r) return;
    const wIn = $('#parking-road-width');
    if (document.activeElement !== wIn) wIn.value = r.widthMM;
    $('#parking-neighbor-walls').checked = r.neighborFrontWalls;
    $('#parking-plan-obstacles').checked = r.usePlanObstacles;
    $('#parking-guard-add').classList.toggle('active', this.mode === 'drawGuard');
    $('#parking-vehicle').value = r.vehicleId;
    const v = this.vehicle();
    $('#parking-vehicle-spec').textContent = `全長 ${v.lengthMM}／全幅 ${v.widthMM}／ホイールベース ${v.wheelbaseMM}mm・最小回転半径 ${(v.minTurnRadiusMM / 1000).toFixed(1)}m`;
    $('#parking-start').textContent = this.mode === 'drive' ? 'シミュレーションを終える' : 'シミュレーション開始';
    $('#parking-start').classList.toggle('active', this.mode === 'drive');

    const list = $('#parking-guard-list');
    list.innerHTML = '';
    r.guardrails.forEach((g, i) => {
      const rel = geo ? PS.guardrailRelation(g, geo) : null;
      const row = document.createElement('div');
      row.className = 'parking-guard-row';
      const len = Math.hypot(g.b.x - g.a.x, g.b.z - g.a.z);
      const pos = rel ? (rel.gapMM >= 0 ? `角から${fmtM(rel.gapMM)}` : `敷地の前に${fmtM(-rel.gapMM)}`) : '';
      row.innerHTML = `<label class="check"><input type="checkbox" ${g.enabled ? 'checked' : ''}/> <span>${i + 1}. 長さ ${fmtM(len)}・${pos}</span></label>`;
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'btn btn-compact danger'; del.textContent = '削除';
      row.appendChild(del);
      row.querySelector('input').addEventListener('change', (e) => {
        this._updateRoad((rr) => { const x = rr.guardrails.find((y) => y.id === g.id); if (x) x.enabled = e.target.checked; });
        this._refreshClearance();
      });
      del.addEventListener('click', () => {
        this._updateRoad((rr) => { rr.guardrails = rr.guardrails.filter((y) => y.id !== g.id); });
        this._refreshClearance();
      });
      list.appendChild(row);
    });
  }

  // ---- 操作パネル（図面の上に浮かぶ） --------------------------------------------

  _wireHud() {
    const holdBtn = (el, dir) => {
      const stop = () => { if (this.held === dir) this.held = 0; };
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); this._modifiers(e); this.held = dir; this._startLoop(); });
      el.addEventListener('pointerup', stop);
      el.addEventListener('pointerleave', stop);
      el.addEventListener('pointercancel', stop);
    };
    holdBtn($('#parking-fwd'), 1);
    holdBtn($('#parking-back'), -1);
    $('#parking-steer').addEventListener('input', (e) => this._setSteer(Number(e.target.value) / 100));
    $('#parking-steer-left').addEventListener('click', () => this._setSteer(-1));
    $('#parking-steer-right').addEventListener('click', () => this._setSteer(1));
    $('#parking-steer-center').addEventListener('click', () => this._setSteer(0));
    $('#parking-timeline').addEventListener('input', (e) => {
      this.cursor = Math.max(0, Math.min(this.hist.length - 1, Number(e.target.value)));
      this.lastHit = null;
      this._syncHud();
      this.editor.draw();
    });
    $('#parking-from-start').addEventListener('click', () => { this._placeAtStart(true); this._syncHud(); this.editor.draw(); });
    $('#parking-from-end').addEventListener('click', () => { this._placeAtStart(false); this._syncHud(); this.editor.draw(); });
    $('#parking-restart').addEventListener('click', () => {
      if (!this.hist.length) return;
      this._setStart(this.hist[0].pose);
      this._syncHud(); this.editor.draw();
    });
    $('#parking-keep').addEventListener('click', () => this.keepTrail());
    $('#parking-clear-trails').addEventListener('click', () => { this.trails = []; this._syncHud(); this.editor.draw(); });
    $('#parking-exit').addEventListener('click', () => this.stopDriving());
  }

  _syncHud() {
    const hud = $('#parking-hud');
    const show = this.mode === 'drive' && this.ui.view === '2d';
    hud.hidden = !show;
    if (!show) return;
    const v = this.vehicle();
    $('#parking-hud-vehicle').textContent = v.name;
    const sl = $('#parking-steer');
    if (document.activeElement !== sl) sl.value = Math.round(this.steer * 100);
    const deg = (PS.steerAngleForCurvature(v, Math.abs(this.steer) * PS.maxCurvature(v)) * 180) / Math.PI;
    const side = this.steer > 0.005 ? '右' : (this.steer < -0.005 ? '左' : '');
    $('#parking-steer-label').textContent = side
      ? `ハンドル ${side} ${Math.round(Math.abs(this.steer) * 100)}%（タイヤの向き 約${deg.toFixed(0)}°）`
      : 'ハンドル まっすぐ';
    const [l1, l2] = this._sideLabels();
    $('#parking-from-start').textContent = l1;
    $('#parking-from-end').textContent = l2;

    const st = this.stats();
    const rows = [];
    rows.push(`<div><span>今のすき間</span><b class="${st.cur && st.cur.d <= 0 ? 'bad' : ''}">${st.cur ? (st.cur.d <= 0 ? '接触' : fmtCm(st.cur.d)) : '—'}</b><small>${st.curLabel}</small></div>`);
    rows.push(`<div><span>ここまでで一番近づいた</span><b class="${st.min && st.min.d <= 0 ? 'bad' : ''}">${st.min ? (st.min.d <= 0 ? '接触' : fmtCm(st.min.d)) : '—'}</b><small>${st.minLabel}</small></div>`);
    rows.push(`<div><span>切り返し</span><b>${st.kirikaeshi}回</b><small>前進⇄後退の切り替え ${st.changes}回</small></div>`);
    if (this.lastHit) rows.push(`<div class="bad-row">${this.lastHit.label || '障害物'}に当たるので、これ以上進めません</div>`);
    $('#parking-stats').innerHTML = rows.join('');
    const tl = $('#parking-timeline');
    tl.max = Math.max(0, this.hist.length - 1);
    tl.value = this.cursor;
    tl.disabled = this.hist.length < 2;
    const tr = $('#parking-trails');
    tr.innerHTML = this.trails.map((t) => `<div><span class="swatch" style="background:${t.color}"></span>${t.label}</div>`).join('');
    $('#parking-clear-trails').hidden = !this.trails.length;
  }

  _sync() {
    this._syncPanel();
    this._syncHud();
  }

  /** main.js の refreshPanels から呼ばれる */
  syncPanel() {
    this._checkPlan();
    if (this.mode && !this.road() && this.mode !== 'pickRoad') { this.mode = null; if (this.isActive()) this.setTool('select'); }
    this._sync();
  }
}
