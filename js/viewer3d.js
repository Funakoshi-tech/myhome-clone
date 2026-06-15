// viewer3d.js
// Three.js の 3D 描画。壁の立ち上げ・床・家具・カメラ。
// store の同じデータを読むだけ。内部単位 mm → Three.js は m（÷1000）で扱う。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as M from './model.js';
import { getRoomType } from './catalog.js';

const MM = 0.001; // mm → m

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
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(4, 0, 4);

    // ライト（フェーズ A は影なし。日射はフェーズ B）
    const amb = new THREE.AmbientLight(0xffffff, 0.65);
    this.scene.add(amb);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(6, 12, 4);
    this.scene.add(dir);
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x33302c, 0.5);
    this.scene.add(hemi);

    // グリッド & 地面
    this.grid = new THREE.GridHelper(60, 60, 0xb7c0cc, 0xd5dbe3);
    this.scene.add(this.grid);

    // 3D 内容を入れるグループ
    this.root = new THREE.Group();
    this.scene.add(this.root);

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
        group.add(step);
      }
    } else {
      // その他: 半分の高さのボックスで表現
      const geo = new THREE.BoxGeometry(w, h * 0.5, d);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, h * 0.25, 0);
      mesh.material = mat;
      group.add(mesh);
    }
    return group;
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
