// viewer3d.js
// Three.js の 3D 描画。壁の立ち上げ・床・家具・カメラ。
// store の同じデータを読むだけ。内部単位 mm → Three.js は m（÷1000）で扱う。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as M from './model.js';
import { getRoomType } from './catalog.js';
import { getSunPosition, sunDirection, dateFromDayOfYear, DEFAULT_LAT, DEFAULT_LNG } from './sun.js';

const MM = 0.001; // mm → m
const Y_AXIS = new THREE.Vector3(0, 1, 0);
// 遮蔽判定専用の共有マテリアル（描画しないので軽量）
const OCCLUDER_MAT = new THREE.MeshBasicMaterial();

// 床板を描かない部屋種別（貫通表現）: 吹抜け・階段
const NO_FLOOR_TYPES = new Set(['fukinuke', 'stair']);

export class Viewer3D {
  constructor(container, store, ui) {
    this.container = container;
    this.store = store;
    this.ui = ui;
    this.active = false;
    this._inited = false;
    this._raf = null;
  }

  _init() {
    if (this._inited) return;
    this._inited = true;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xeef1f4);

    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;

    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 1000);
    this.camera.position.set(8, 9, 12);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(4, 0, 4);

    // 環境光（夜でも残す）
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(this.ambient);
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x33302c, 0.45);
    this.scene.add(this.hemi);

    // 太陽光（DirectionalLight + 影）
    this.sun = new THREE.DirectionalLight(0xfff4e0, 1.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.near = 0.5; sc.far = 120;
    sc.left = -25; sc.right = 25; sc.top = 25; sc.bottom = -25;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // グリッド & 影を受ける地面
    this.grid = new THREE.GridHelper(60, 60, 0xb7c0cc, 0xd5dbe3);
    this.scene.add(this.grid);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.ShadowMaterial({ opacity: 0.22 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // 3D 内容を入れるグループ（site.azimuth で回転）
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // 日射の現在状態
    this._center = new THREE.Vector3(0, 0, 0);

    this._materials = {
      floor: new Map(),
      wall: new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.9, metalness: 0.0 }),
    };

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  setActive(on) {
    this.active = on;
    if (on) {
      this._init();
      this.resize();
      this.rebuild();
      this._loop();
    } else if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  resize() {
    if (!this._inited) return;
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _loop() {
    if (!this.active) return;
    this._raf = requestAnimationFrame(() => this._loop());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  _clearRoot() {
    for (let i = this.root.children.length - 1; i >= 0; i--) {
      const obj = this.root.children[i];
      obj.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material._disposable) o.material.dispose();
      });
      this.root.remove(obj);
    }
  }

  _floorMaterial(hex) {
    if (!this._materials.floor.has(hex)) {
      const m = new THREE.MeshStandardMaterial({
        color: new THREE.Color(hex), roughness: 0.95, metalness: 0.0,
        side: THREE.DoubleSide,
      });
      this._materials.floor.set(hex, m);
    }
    return this._materials.floor.get(hex);
  }

  // 全フロアを level で積み上げて描画する
  rebuild() {
    if (!this._inited || !this.active) return;
    this._clearRoot();
    const plan = this.store.current();
    if (!plan) return;

    // site.azimuth（真北からの回転角）を建物全体に反映
    this.root.rotation.y = (plan.site?.azimuth || 0) * Math.PI / 180;

    for (const floor of plan.floors) {
      const hasContent = floor.rooms.length || floor.furniture.length || (floor.stairs || []).length;
      if (!hasContent) continue;
      const baseY = (floor.level || 0) * (floor.ceilingHeightMM || 2400) * MM;
      const g = new THREE.Group();
      g.position.y = baseY;

      // 床（部屋ポリゴン）
      for (const room of floor.rooms) {
        const mesh = this._buildFloor(room);
        if (mesh) g.add(mesh);
      }
      // 壁
      for (const wall of floor.walls) {
        const mesh = this._buildWall(wall);
        if (mesh) g.add(mesh);
      }
      // 階段
      for (const stair of (floor.stairs || [])) {
        const obj = this._buildStair(stair, floor.ceilingHeightMM || 2400);
        if (obj) g.add(obj);
      }
      // 家具
      for (const f of floor.furniture) {
        const mesh = this._buildFurniture(f);
        if (mesh) g.add(mesh);
      }
      this.root.add(g);
    }

    // 建物中心（太陽光ターゲット・影カメラ用）
    const box = new THREE.Box3().setFromObject(this.root);
    this._center = box.isEmpty() ? new THREE.Vector3(0, 1, 0) : box.getCenter(new THREE.Vector3());

    // 太陽光を現在のUI状態で更新
    if (this.ui?.sun) this.updateSun(this.ui.sun.doy, this.ui.sun.hour);

    // 初回フィット
    if (!this._fitted) {
      this._fitted = true;
      this._fitCamera();
    }
  }

  _buildFloor(room) {
    if (!room.polygon || room.polygon.length < 3) return null;
    if (NO_FLOOR_TYPES.has(room.type)) return null; // 床板なし（貫通）
    const shape = new THREE.Shape();
    room.polygon.forEach((p, i) => {
      const x = p.x * MM, z = p.z * MM;
      if (i === 0) shape.moveTo(x, z); else shape.lineTo(x, z);
    });
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    // Shape は XY 平面 → XZ へ寝かせる
    geo.rotateX(Math.PI / 2);
    const color = getRoomType(room.type).color;
    const mesh = new THREE.Mesh(geo, this._floorMaterial(color));
    mesh.position.y = 0.005;
    mesh.receiveShadow = true;
    return mesh;
  }

  _buildWall(wall) {
    const ax = wall.start.x, az = wall.start.z;
    const bx = wall.end.x, bz = wall.end.z;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1) return null;
    const t = (wall.thicknessMM || 120) * MM;
    const hgt = (wall.heightMM || 2400) * MM;
    const geo = new THREE.BoxGeometry(len * MM, hgt, t);
    const mat = this._materials.wall;
    const mesh = new THREE.Mesh(geo, mat);
    const cx = (ax + bx) / 2 * MM;
    const cz = (az + bz) / 2 * MM;
    mesh.position.set(cx, hgt / 2, cz);
    mesh.rotation.y = -Math.atan2(dz, dx);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  _buildFurniture(f) {
    const w = (f.wMM || 500) * MM;
    const d = (f.dMM || 500) * MM;
    const h = (f.hMM || 500) * MM;
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(f.color || '#888888'), roughness: 0.7, metalness: 0.05,
    });
    mat._disposable = true;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(f.x * MM, (f.y || 0) * MM + h / 2, f.z * MM);
    mesh.rotation.y = -((f.rotationDeg || 0) * Math.PI) / 180;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // 階段の3D表示（直進はステップ状、その他は単純ボックス）
  _buildStair(stair, ceilingHeightMM) {
    const w = stair.widthMM * MM;
    const d = stair.depthMM * MM;
    const h = ceilingHeightMM * MM;
    const rot = -(stair.rotationDeg || 0) * Math.PI / 180;

    const group = new THREE.Group();
    group.position.set(stair.x * MM, 0, stair.z * MM);
    group.rotation.y = rot;

    const nSteps = Math.max(4, Math.min(14, Math.round(stair.depthMM / 230)));
    const stepH = h / nSteps;
    const stepD = d / nSteps;

    const mat = new THREE.MeshStandardMaterial({
      color: 0xd4b896, roughness: 0.88, metalness: 0.0,
    });

    if (stair.type === 'straight') {
      // 踏み板を1段ずつ積み上げる
      for (let i = 0; i < nSteps; i++) {
        const geo = new THREE.BoxGeometry(w, stepH * (i + 1), stepD);
        const step = new THREE.Mesh(geo, mat);
        step.position.set(0, stepH * (i + 1) / 2, -d / 2 + stepD * (i + 0.5));
        step.castShadow = true; step.receiveShadow = true;
        group.add(step);
      }
    } else {
      // その他: 半分の高さのボックスで表現
      const geo = new THREE.BoxGeometry(w, h * 0.5, d);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, h * 0.25, 0);
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }

  // ---- 太陽光の更新（フェーズB） -------------------------------------------
  // @param doy 通日(1-365) @param hour 時刻(0-23)
  updateSun(doy, hour) {
    if (!this._inited) return;
    const plan = this.store.current();
    const lat = plan?.meta?.lat ?? DEFAULT_LAT;
    const lng = plan?.meta?.lng ?? DEFAULT_LNG;
    const date = dateFromDayOfYear(doy);
    const pos = getSunPosition(date, hour, lat, lng);

    if (pos.altitudeDeg <= 0) {
      // 夜間: 太陽光を消灯（環境光は残す）
      this.sun.visible = false;
      this.scene.background = new THREE.Color(0xcdd6e3);
      return;
    }
    this.sun.visible = true;
    this.scene.background = new THREE.Color(0xeef1f4);

    const dir = sunDirection(pos.azimuthDeg, pos.altitudeDeg); // 世界座標（X=東,Z=南）
    const dist = 45;
    const c = this._center || new THREE.Vector3();
    this.sun.target.position.copy(c);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(
      c.x + dir.x * dist,
      c.y + dir.y * dist,
      c.z + dir.z * dist,
    );
    // 高度が低いほど弱める
    const t = Math.min(1, pos.altitudeDeg / 40);
    this.sun.intensity = 0.4 + 0.9 * t;
  }

  // 遮蔽判定用のオクルーダー（壁・床・階段・家具）をローカル座標で構築。
  // 壁・床には userData.roomId を付け、自室の遮蔽は除外できるようにする。
  _buildOccluder() {
    const grp = new THREE.Group();
    const plan = this.store.current();
    if (!plan) return grp;
    const mat = OCCLUDER_MAT;

    for (const floor of plan.floors) {
      const baseY = (floor.level || 0) * (floor.ceilingHeightMM || 2400) * MM;
      const fg = new THREE.Group();
      fg.position.y = baseY;

      // 床
      for (const room of floor.rooms) {
        if (NO_FLOOR_TYPES.has(room.type)) continue;
        if (!room.polygon || room.polygon.length < 3) continue;
        const shape = new THREE.Shape();
        room.polygon.forEach((p, i) => {
          const x = p.x * MM, z = p.z * MM;
          if (i === 0) shape.moveTo(x, z); else shape.lineTo(x, z);
        });
        shape.closePath();
        const geo = new THREE.ShapeGeometry(shape);
        geo.rotateX(Math.PI / 2);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData = { roomId: room.id, kind: 'floor' };
        fg.add(mesh);
      }

      // 壁（部屋ごとに生成して roomId を付与）
      for (const room of floor.rooms) {
        const walls = M.wallsFromPolygon(room.polygon, {
          thicknessMM: 120, heightMM: floor.ceilingHeightMM || 2400,
        });
        for (const wall of walls) {
          const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
          const len = Math.hypot(dx, dz);
          if (len < 1) continue;
          const hgt = (wall.heightMM || 2400) * MM;
          const geo = new THREE.BoxGeometry(len * MM, hgt, (wall.thicknessMM || 120) * MM);
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set((wall.start.x + wall.end.x) / 2 * MM, hgt / 2, (wall.start.z + wall.end.z) / 2 * MM);
          mesh.rotation.y = -Math.atan2(dz, dx);
          mesh.userData = { roomId: room.id, kind: 'wall' };
          fg.add(mesh);
        }
      }

      // 階段
      for (const s of (floor.stairs || [])) {
        const geo = new THREE.BoxGeometry(s.widthMM * MM, (floor.ceilingHeightMM || 2400) * MM, s.depthMM * MM);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(s.x * MM, (floor.ceilingHeightMM || 2400) * MM / 2, s.z * MM);
        mesh.rotation.y = -((s.rotationDeg || 0) * Math.PI) / 180;
        mesh.userData = { roomId: null, kind: 'stair' };
        fg.add(mesh);
      }

      // 家具
      for (const f of floor.furniture) {
        const geo = new THREE.BoxGeometry((f.wMM || 500) * MM, (f.hMM || 500) * MM, (f.dMM || 500) * MM);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(f.x * MM, (f.y || 0) * MM + (f.hMM || 500) * MM / 2, f.z * MM);
        mesh.rotation.y = -((f.rotationDeg || 0) * Math.PI) / 180;
        mesh.userData = { roomId: null, kind: 'furniture' };
        fg.add(mesh);
      }

      grp.add(fg);
    }
    grp.updateMatrixWorld(true);
    return grp;
  }

  /**
   * 各部屋の本日（指定通日）の直射日照時間を集計する。
   * 部屋中心から太陽方向へレイを飛ばし、他要素に遮られなければ直射ありとする。
   * 自室の壁・床は遮蔽から除外（窓があるものとみなす簡易版）。
   * @returns {{ [roomId:string]: number }} 直射時間（時間/日）
   */
  computeDaylight(doy) {
    const plan = this.store.current();
    const result = {};
    if (!plan) return result;
    const lat = plan.meta?.lat ?? DEFAULT_LAT;
    const lng = plan.meta?.lng ?? DEFAULT_LNG;
    const azRad = (plan.site?.azimuth || 0) * Math.PI / 180;
    const date = dateFromDayOfYear(doy);

    // 1時間ごとの太陽方向（ローカル座標）を事前計算
    const dirs = [];
    for (let h = 0; h < 24; h++) {
      const pos = getSunPosition(date, h, lat, lng);
      if (pos.altitudeDeg <= 0) { dirs.push(null); continue; }
      const dw = sunDirection(pos.azimuthDeg, pos.altitudeDeg);
      const v = new THREE.Vector3(dw.x, dw.y, dw.z).applyAxisAngle(Y_AXIS, -azRad).normalize();
      dirs.push(v);
    }

    const occ = this._buildOccluder();
    const children = occ.children;
    const ray = new THREE.Raycaster();
    ray.far = 2000;
    const origin = new THREE.Vector3();

    for (const floor of plan.floors) {
      const baseY = (floor.level || 0) * (floor.ceilingHeightMM || 2400) * MM;
      for (const room of floor.rooms) {
        if (!room.polygon || room.polygon.length < 3) { result[room.id] = 0; continue; }
        const c = M.polygonCentroid(room.polygon);
        // 床から 1.2m の高さで計測
        origin.set(c.x * MM, baseY + 1.2, c.z * MM);
        let hours = 0;
        for (let h = 0; h < 24; h++) {
          const dir = dirs[h];
          if (!dir) continue;
          ray.set(origin, dir);
          const hits = ray.intersectObjects(children, true);
          // 自室の壁・床は無視。それ以外に当たれば遮蔽。
          const blocked = hits.some((hit) => hit.object.userData?.roomId !== room.id);
          if (!blocked) hours++;
        }
        result[room.id] = hours;
      }
    }

    // 後始末
    occ.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    return result;
  }

  _fitCamera() {
    const box = new THREE.Box3().setFromObject(this.root);
    if (box.isEmpty()) {
      this.controls.target.set(4, 0, 4);
      this.camera.position.set(10, 10, 14);
      return;
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z, 3);
    this.controls.target.copy(center);
    this.camera.position.set(center.x + radius * 1.1, radius * 1.0 + 4, center.z + radius * 1.3);
    this.controls.update();
  }

  // 外部から「全体表示」要求
  resetView() {
    this._fitCamera();
  }
}
