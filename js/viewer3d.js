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
const CEILING_SLAB_M = 0.05; // 天井板厚（レイキャスト安定用）
const OCCLUDER_MAT = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

// 床板なし（上下貫通）: 吹抜け
const NO_FLOOR_TYPES = new Set(['fukinuke']);
// 天井なし: バルコニー・吹抜け・階段部屋
const NO_CEILING_TYPES = new Set(['balcony', 'fukinuke', 'stair']);

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
    this.controls.enableZoom = false; // トラックパッドの wheel は自前処理
    this.controls.target.set(4, 0, 4);

    this._onWheel = (e) => this._handleWheel(e);
    this.renderer.domElement.addEventListener('wheel', this._onWheel, { passive: false, capture: true });

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
    this._lastDisplayKey = null;

    this._materials = {
      floor: new Map(),
      wall: new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.9, metalness: 0.0 }),
      ceiling: new THREE.MeshStandardMaterial({
        color: 0xd8e4ef,
        transparent: true,
        opacity: 0.14,
        roughness: 0.92,
        metalness: 0.0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
      // 3D 表示専用：影のみ落とす不可視天井（日射計算 occluder とは別）
      ceilingShadow: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        roughness: 0.92,
        side: THREE.DoubleSide,
        depthWrite: true,
        colorWrite: false,
      }),
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

  /** Mac トラックパッド: ctrlKey=ピンチズーム、それ以外=二本指パン */
  _handleWheel(e) {
    if (!this.active) return;
    e.preventDefault();
    e.stopPropagation();

    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      dx *= this.container.clientWidth || 800;
      dy *= this.container.clientHeight || 600;
    }

    if (e.ctrlKey) {
      const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      const factor = Math.exp(-dy * 0.01);
      offset.multiplyScalar(factor);
      const dist = offset.length();
      if (dist < 1.5) offset.setLength(1.5);
      else if (dist > 400) offset.setLength(400);
      this.camera.position.copy(this.controls.target).add(offset);
    } else {
      const dist = this.camera.position.distanceTo(this.controls.target);
      const scale = dist * 0.001;
      const right = new THREE.Vector3();
      right.setFromMatrixColumn(this.camera.matrix, 0);
      const up = new THREE.Vector3();
      up.setFromMatrixColumn(this.camera.matrix, 1);
      right.multiplyScalar(-dx * scale);
      up.multiplyScalar(dy * scale);
      this.camera.position.add(right).add(up);
      this.controls.target.add(right).add(up);
    }
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

  // 3D 表示。view3dAllFloors=false なら ui.floorId のみ（y=0 に配置）。
  // view3dAllFloors=true なら全フロアを level で積み上げ表示。
  rebuild(opts = {}) {
    if (!this._inited || !this.active) return;
    this._clearRoot();
    const plan = this.store.current();
    if (!plan) return;

    const showAll = !!this.ui?.view3dAllFloors;
    const selectedId = this.ui?.floorId || '1F';
    const displayKey = showAll ? '__all__' : selectedId;
    const fitCamera = opts.fitCamera || displayKey !== this._lastDisplayKey;

    // site.azimuth（真北からの回転角）を建物全体に反映
    this.root.rotation.y = (plan.site?.azimuth || 0) * Math.PI / 180;

    for (const floor of plan.floors) {
      if (!showAll && floor.id !== selectedId) continue;
      const hasContent = floor.rooms.length || floor.furniture.length || (floor.stairs || []).length;
      const lower = M.getLowerFloor(plan, floor.id);
      const hasLowerStairs = !showAll && floor.id === selectedId && (lower?.stairs?.length || 0) > 0;
      if (!hasContent && !hasLowerStairs) continue;
      const baseY = showAll
        ? (floor.level || 0) * (floor.ceilingHeightMM || 2400) * MM
        : 0;
      const g = new THREE.Group();
      g.position.y = baseY;
      g.userData = { floorId: floor.id };
      this._populateFloorGeometry(g, floor, 'visual', plan);

      // 単階表示: 下階の階段を上階まで突き抜けて表示
      if (!showAll && lower?.stairs?.length) {
        const riseMM = lower.ceilingHeightMM || 2400;
        const upper = M.getUpperFloor(plan, floor.id);
        for (const s of lower.stairs) {
          const obj = this._buildStair(s, riseMM, lower, upper);
          if (obj) {
            obj.position.y = -riseMM * MM;
            g.add(obj);
          }
        }
      }

      this.root.add(g);
    }

    this._lastDisplayKey = displayKey;

    // 建物中心（太陽光ターゲット・影カメラ用）
    const box = new THREE.Box3().setFromObject(this.root);
    this._center = box.isEmpty() ? new THREE.Vector3(0, 1, 0) : box.getCenter(new THREE.Vector3());

    // 太陽光を現在のUI状態で更新
    if (this.ui?.sun) this.updateSun(this.ui.sun.doy, this.ui.sun.hour);

    if (fitCamera || !this._fitted) {
      this._fitted = true;
      this._fitCamera();
    }
  }

  _roomHasFloor(room) {
    return !NO_FLOOR_TYPES.has(room.type);
  }

  _roomHasCeiling(room) {
    return !NO_CEILING_TYPES.has(room.type);
  }

  // 部屋の底面（床）。下階階段の位置には穴を開ける。
  _buildRoomFloor(room, yM, mat, floor, plan, opts = {}) {
    if (!this._roomHasFloor(room)) return null;
    const shape = (floor && plan)
      ? this._roomFloorShape(room, floor, plan)
      : this._roomShape(room);
    if (!shape) return null;
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    const useMat = mat || this._floorMaterial(opts.color || '#888');
    const mesh = new THREE.Mesh(geo, useMat);
    mesh.position.y = yM;
    if (opts.receiveShadow) mesh.receiveShadow = true;
    return mesh;
  }

  // 部屋の天井面（箱の上面。日射・3D 共用ジオメトリ）
  _buildRoomCeiling(room, ceilingYM, mat, floor = null) {
    if (!this._roomHasCeiling(room)) return null;
    const shape = floor ? this._roomCeilingShape(room, floor) : this._roomShape(room);
    if (!shape) return null;
    const geo = new THREE.ExtrudeGeometry(shape, { depth: CEILING_SLAB_M, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = ceilingYM - CEILING_SLAB_M;
    return mesh;
  }

  /**
   * 1フロア分の物理構造（床・壁・天井・階段・家具）をグループへ追加。
   * @param {'visual'|'occluder'} mode
   */
  _populateFloorGeometry(fg, floor, mode, plan = null) {
    const planData = plan || this.store.current();
    const ceilingY = (floor.ceilingHeightMM || 2400) * MM;
    const isOcc = mode === 'occluder';
    const upper = planData ? M.getUpperFloor(planData, floor.id) : null;

    for (const room of floor.rooms) {
      const floorMesh = this._buildRoomFloor(
        room,
        isOcc ? 0 : 0.005,
        isOcc ? OCCLUDER_MAT : null,
        floor,
        planData,
        isOcc ? {} : { color: getRoomType(room.type).color, receiveShadow: true },
      );
      if (floorMesh) {
        floorMesh.userData = { roomId: room.id, kind: 'floor' };
        fg.add(floorMesh);
      }

      const ceilMesh = this._buildRoomCeiling(room, ceilingY, isOcc ? OCCLUDER_MAT : this._materials.ceiling, floor);
      if (ceilMesh) {
        ceilMesh.userData = { roomId: room.id, kind: 'ceiling' };
        if (!isOcc) {
          // 表示用：半透明で室内が見える
          ceilMesh.castShadow = false;
          ceilMesh.receiveShadow = false;
          ceilMesh.renderOrder = 2;
          fg.add(ceilMesh);
          // 影用：不可視だが castShadow で上からの直射を床に遮る
          const shadowCeil = this._buildRoomCeiling(room, ceilingY, this._materials.ceilingShadow, floor);
          if (shadowCeil) {
            shadowCeil.userData = { roomId: room.id, kind: 'ceiling-shadow' };
            shadowCeil.castShadow = true;
            shadowCeil.receiveShadow = false;
            shadowCeil.renderOrder = 0;
            fg.add(shadowCeil);
          }
        } else {
          fg.add(ceilMesh);
        }
      }
    }

    for (const wall of floor.walls) {
      const ops = (floor.openings || []).filter((o) => o.wallId === wall.id);
      const wallGroup = this._buildWallWithOpenings(wall, ops, isOcc ? OCCLUDER_MAT : null, { occluder: isOcc });
      if (!wallGroup) continue;
      const rid = wall.roomId || null;
      wallGroup.traverse((o) => {
        if (o.isMesh) o.userData = { roomId: rid, kind: 'wall' };
      });
      fg.add(wallGroup);
    }

    for (const s of (floor.stairs || [])) {
      const riseMM = M.stairRiseHeightMM(floor, upper);
      if (isOcc) {
        const geo = new THREE.BoxGeometry(s.widthMM * MM, riseMM * MM, s.depthMM * MM);
        const mesh = new THREE.Mesh(geo, OCCLUDER_MAT);
        mesh.position.set(s.x * MM, (riseMM * MM) / 2, s.z * MM);
        mesh.rotation.y = -((s.rotationDeg || 0) * Math.PI) / 180;
        mesh.userData = { roomId: null, kind: 'stair' };
        fg.add(mesh);
      } else {
        const obj = this._buildStair(s, riseMM, floor, upper);
        if (obj) fg.add(obj);
      }
    }

    if (isOcc) {
      for (const f of floor.furniture) {
        const geo = new THREE.BoxGeometry((f.wMM || 500) * MM, (f.hMM || 500) * MM, (f.dMM || 500) * MM);
        const mesh = new THREE.Mesh(geo, OCCLUDER_MAT);
        mesh.position.set(f.x * MM, (f.y || 0) * MM + (f.hMM || 500) * MM / 2, f.z * MM);
        mesh.rotation.y = -((f.rotationDeg || 0) * Math.PI) / 180;
        mesh.userData = { roomId: null, kind: 'furniture' };
        fg.add(mesh);
      }
    } else {
      for (const f of floor.furniture) {
        const mesh = this._buildFurniture(f);
        if (mesh) fg.add(mesh);
      }
    }
  }

  // 部屋ポリゴンの水平面（床・天井オクルーダー共用）
  _buildRoomPolygonMesh(room, yM, mat, opts = {}) {
    if (!room.polygon || room.polygon.length < 3) return null;
    const shape = this._roomShape(room);
    if (!shape) return null;
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    const useMat = mat || this._floorMaterial(opts.color || '#888');
    const mesh = new THREE.Mesh(geo, useMat);
    mesh.position.y = yM;
    if (opts.receiveShadow) mesh.receiveShadow = true;
    return mesh;
  }

  _roomShape(room) {
    if (!room.polygon || room.polygon.length < 3) return null;
    const shape = new THREE.Shape();
    room.polygon.forEach((p, i) => {
      const x = p.x * MM, z = p.z * MM;
      if (i === 0) shape.moveTo(x, z); else shape.lineTo(x, z);
    });
    shape.closePath();
    return shape;
  }

  _appendStairHoles(shape, stairs, room) {
    if (!shape || !stairs?.length || !room?.polygon) return;
    for (const stair of stairs) {
      if (!M.pointInPolygon({ x: stair.x, z: stair.z }, room.polygon)) continue;
      const corners = M.stairFootprintCorners(stair);
      const hole = new THREE.Path();
      corners.forEach((p, i) => {
        const x = p.x * MM;
        const z = p.z * MM;
        if (i === 0) hole.moveTo(x, z);
        else hole.lineTo(x, z);
      });
      hole.closePath();
      shape.holes.push(hole);
    }
  }

  // 下階階段の位置に穴を開けた床用シェイプ
  _roomFloorShape(room, floor, plan) {
    const shape = this._roomShape(room);
    if (!shape) return null;
    const lower = M.getLowerFloor(plan, floor.id);
    if (lower) this._appendStairHoles(shape, lower.stairs, room);
    return shape;
  }

  // 階段配置箇所に穴を開けた天井用シェイプ
  _roomCeilingShape(room, floor) {
    const shape = this._roomShape(room);
    if (!shape) return null;
    this._appendStairHoles(shape, floor.stairs, room);
    return shape;
  }

  // 日射遮蔽用シーン（3D表示と同じ物理構造・不透明材質）
  _buildOccluder() {
    const grp = new THREE.Group();
    const plan = this.store.current();
    if (!plan) return grp;

    for (const floor of plan.floors) {
      const baseY = (floor.level || 0) * (floor.ceilingHeightMM || 2400) * MM;
      const fg = new THREE.Group();
      fg.position.y = baseY;
      this._populateFloorGeometry(fg, floor, 'occluder');
      grp.add(fg);
    }
    grp.updateMatrixWorld(true);
    return grp;
  }

  /** レイが遮蔽されるか（自室の床のみ除外）— 開口部なし屋外系部屋用 */
  _rayBlockedExceptOwnFloor(room, hits) {
    return hits.some((hit) => {
      const ud = hit.object.userData;
      return !(ud?.kind === 'floor' && ud?.roomId === room.id);
    });
  }

  _openingWorldPoints(wall, opening) {
    const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
    const lenMM = Math.hypot(dx, dz);
    if (lenMM < 1) return null;
    const ux = dx / lenMM, uz = dz / lenMM;
    const oStart = opening.offsetMM - opening.widthMM / 2;
    const oEnd = opening.offsetMM + opening.widthMM / 2;
    return {
      start: { x: wall.start.x + ux * oStart, z: wall.start.z + uz * oStart },
      end: { x: wall.start.x + ux * oEnd, z: wall.start.z + uz * oEnd },
    };
  }

  // 部屋の外側を向く壁法線（XZ）
  _wallExteriorNormal(wall, room) {
    const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
    const len = Math.hypot(dx, dz);
    if (len < 1) return null;
    const ux = dx / len, uz = dz / len;
    let nx = -uz, nz = ux;
    const mid = { x: (wall.start.x + wall.end.x) / 2, z: (wall.start.z + wall.end.z) / 2 };
    const c = M.polygonCentroid(room.polygon);
    if (nx * (mid.x - c.x) + nz * (mid.z - c.z) < 0) { nx = -nx; nz = -nz; }
    return { nx, nz, ux, uz };
  }

  _roomOpeningPairs(floor, room) {
    const pairs = [];
    for (const op of (floor.openings || [])) {
      const wall = floor.walls.find((w) => w.id === op.wallId);
      if (!wall) continue;
      const wallRoomId = M.inferWallRoomId(wall);
      if (wallRoomId !== room.id) continue;
      pairs.push({ op, wall });
    }
    return pairs;
  }

  // 自室の箱（床壁天井）以外の遮蔽ヒットか
  _isExternalOcclusionHit(hit, room) {
    const ud = hit.object.userData;
    if (!ud) return true;
    if (ud.roomId === room.id) return false;
    return true;
  }

  // サンプル点 sy が開口の鉛直範囲内か（高高度の太陽も窓から入るため仰角比較は使わない）
  _sunWithinOpeningVertical(opening, sampleY, dir, baseYM) {
    const sill = (opening.sillMM || 0) * MM;
    const h = (opening.heightMM || 1100) * MM;
    const y0 = baseYM + sill;
    const y1 = baseYM + sill + h;
    if (sampleY < y0 - 0.02 || sampleY > y1 + 0.02) return false;
    // 太陽が地平線より十分上（開口から見える前提）
    const horiz = Math.hypot(dir.x, dir.z);
    return dir.y > -0.05 && Math.atan2(dir.y, Math.max(horiz, 1e-4)) > -0.05;
  }

  // 1つの開口から太陽が見えるか
  _openingAdmitsSun(opening, wall, room, baseYM, dir, ray, occ) {
    const wn = this._wallExteriorNormal(wall, room);
    if (!wn) return false;
    const n3 = new THREE.Vector3(wn.nx, 0, wn.nz);
    if (dir.dot(n3) < 0.05) return false;

    const pts = this._openingWorldPoints(wall, opening);
    if (!pts) return false;
    const sill = (opening.sillMM || 0) * MM;
    const h = (opening.heightMM || 1100) * MM;
    const outDist = (wall.thicknessMM || 120) * MM * 2.5 + 0.15;
    const widthFracs = [0.25, 0.5, 0.75];
    const heightFracs = [0.35, 0.55, 0.75];

    for (const wf of widthFracs) {
      const cx = (pts.start.x + (pts.end.x - pts.start.x) * wf) * MM;
      const cz = (pts.start.z + (pts.end.z - pts.start.z) * wf) * MM;
      for (const hf of heightFracs) {
        const sy = baseYM + sill + h * hf;
        if (!this._sunWithinOpeningVertical(opening, sy, dir, baseYM)) continue;

        const exterior = new THREE.Vector3(
          cx + wn.nx * outDist,
          sy,
          cz + wn.nz * outDist,
        );
        ray.set(exterior, dir);
        const hits = ray.intersectObjects(occ.children, true);
        if (!hits.some((hit) => this._isExternalOcclusionHit(hit, room))) return true;
      }
    }
    return false;
  }

  // 天井なし部屋：開口経由のみ（上空直晒しはバルコニー等の室外用途に限定）
  _openTopRoomAdmitsSun(room, floor, baseYM, dir, ray, occ) {
    const pairs = this._roomOpeningPairs(floor, room);
    if (pairs.some(({ op, wall }) => this._openingAdmitsSun(op, wall, room, baseYM, dir, ray, occ))) {
      return true;
    }
    // バルコニーのみ：壁に囲まれず上方からの直射も許可（閾値を上げて過大計測を抑制）
    if (room.type !== 'balcony') return false;
    if (dir.y < 0.15) return false;
    const c = M.polygonCentroid(room.polygon);
    const origin = new THREE.Vector3(c.x * MM, baseYM + 1.2, c.z * MM);
    ray.set(origin, dir);
    const hits = ray.intersectObjects(occ.children, true);
    return !this._rayBlockedExceptOwnFloor(room, hits);
  }

  // 囲まれた部屋：窓・開口から入る光のみ（デフォルト遮蔽）
  _enclosedRoomAdmitsSun(room, floor, baseYM, dir, ray, occ) {
    const pairs = this._roomOpeningPairs(floor, room);
    if (!pairs.length) return false;
    return pairs.some(({ op, wall }) => this._openingAdmitsSun(op, wall, room, baseYM, dir, ray, occ));
  }

  _roomAdmitsSunHour(room, floor, baseYM, dir, ray, occ) {
    if (this._roomHasCeiling(room)) {
      return this._enclosedRoomAdmitsSun(room, floor, baseYM, dir, ray, occ);
    }
    return this._openTopRoomAdmitsSun(room, floor, baseYM, dir, ray, occ);
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

  // 建具開口を考慮して壁を分割描画する。
  // openings: この壁に属する建具の配列（offsetMM でソート済みでなくてよい）
  _buildWallWithOpenings(wall, openings = [], mat = null, options = {}) {
    const forOccluder = !!options.occluder;
    const ax = wall.start.x, az = wall.start.z;
    const bx = wall.end.x, bz = wall.end.z;
    const dx = bx - ax, dz = bz - az;
    const lenMM = Math.hypot(dx, dz);
    if (lenMM < 1) return null;

    const L = lenMM * MM;
    const T = (wall.thicknessMM || 120) * MM;
    const H = (wall.heightMM || 2400) * MM;
    const ang = -Math.atan2(dz, dx);
    const useMat = mat || this._materials.wall;

    const group = new THREE.Group();
    group.position.set((ax + bx) / 2 * MM, 0, (az + bz) / 2 * MM);
    group.rotation.y = ang;

    // ローカル X の中心からの距離に変換（壁は -L/2 〜 +L/2）
    const toLocalX = (offMM) => offMM * MM - L / 2;

    const addSeg = (segW, segH, segT, m, cx, cy, cz = 0) => {
      if (segW < 0.0005 || segH < 0.0005) return;
      const geo = new THREE.BoxGeometry(segW, segH, segT);
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(cx, cy, cz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    };

    const ops = (openings || [])
      .slice()
      .sort((a, b) => a.offsetMM - b.offsetMM)
      .filter((o) => o.offsetMM - o.widthMM / 2 < lenMM && o.offsetMM + o.widthMM / 2 > 0);

    if (ops.length === 0) {
      addSeg(L, H, T, useMat, 0, H / 2);
      return group;
    }

    let curMM = 0;
    for (const op of ops) {
      const oStartMM = Math.max(0, op.offsetMM - op.widthMM / 2);
      const oEndMM   = Math.min(lenMM, op.offsetMM + op.widthMM / 2);
      const oSillMM  = op.sillMM || 0;
      const oHgtMM   = op.heightMM || 1100;
      const oTopMM   = oSillMM + oHgtMM;
      const oW       = (oEndMM - oStartMM) * MM;
      const cx       = toLocalX((oStartMM + oEndMM) / 2);

      // 開口前の柱部分
      if (oStartMM > curMM) {
        const w = (oStartMM - curMM) * MM;
        addSeg(w, H, T, useMat, toLocalX((curMM + oStartMM) / 2), H / 2);
      }

      // 開口内: 腰壁（sill > 0 の場合）
      if (oSillMM > 0) {
        addSeg(oW, oSillMM * MM, T, useMat, cx, oSillMM * MM / 2);
      }
      // 開口内: まぐさ（上部）
      const lintelMM = Math.max(0, (wall.heightMM || 2400) - oTopMM);
      if (lintelMM > 0) {
        addSeg(oW, lintelMM * MM, T, useMat, cx, oTopMM * MM + lintelMM * MM / 2);
      }

      // 窓枠（日射オクルーダーでは開口を塞がないよう省略）
      if (!forOccluder) {
        const frameMat = this._getFrameMat();
        const FT = T * 1.05;
        const FW = 0.030;
        addSeg(oW + FW * 2, FW, FT, frameMat, cx, oTopMM * MM + FW / 2);
        addSeg(oW + FW * 2, FW, FT, frameMat, cx, oSillMM * MM - FW / 2);
        addSeg(FW, oHgtMM * MM, FT, frameMat, cx - oW / 2 - FW / 2, (oSillMM + oTopMM) / 2 * MM);
        addSeg(FW, oHgtMM * MM, FT, frameMat, cx + oW / 2 + FW / 2, (oSillMM + oTopMM) / 2 * MM);
      }

      curMM = oEndMM;
    }

    // 最終セグメント
    if (curMM < lenMM) {
      const w = (lenMM - curMM) * MM;
      addSeg(w, H, T, useMat, toLocalX((curMM + lenMM) / 2), H / 2);
    }

    return group;
  }

  _getFrameMat() {
    if (!this._materials.frame) {
      this._materials.frame = new THREE.MeshStandardMaterial({
        color: 0xd8e4ec, roughness: 0.7, metalness: 0.05,
      });
    }
    return this._materials.frame;
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

  // 階段の3D表示（1階分の高さまで上階へ突き抜け）
  _buildStair(stair, riseMM, sourceFloor, upperFloor) {
    const w = stair.widthMM * MM;
    const d = stair.depthMM * MM;
    const h = riseMM * MM;
    const rot = -(stair.rotationDeg || 0) * Math.PI / 180;

    const group = new THREE.Group();
    group.position.set(stair.x * MM, 0, stair.z * MM);
    group.rotation.y = rot;
    group.userData = { kind: 'stair', floorId: sourceFloor?.id || null };

    const nSteps = Math.max(4, Math.min(14, Math.round(stair.depthMM / 230)));
    const stepH = h / nSteps;
    const stepD = d / nSteps;

    const mat = new THREE.MeshStandardMaterial({
      color: 0xd4b896, roughness: 0.88, metalness: 0.0,
    });

    if (stair.type === 'straight') {
      for (let i = 0; i < nSteps; i++) {
        const geo = new THREE.BoxGeometry(w, stepH * (i + 1), stepD);
        const step = new THREE.Mesh(geo, mat);
        step.position.set(0, stepH * (i + 1) / 2, -d / 2 + stepD * (i + 0.5));
        step.castShadow = true;
        step.receiveShadow = true;
        group.add(step);
      }
    } else {
      const geo = new THREE.BoxGeometry(w, h * 0.85, d);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, h * 0.425, 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    // 上階がある場合、踊り場側の縦板で上階床までつなぐ
    if (upperFloor) {
      const railMat = new THREE.MeshStandardMaterial({
        color: 0xc4a880, roughness: 0.9, metalness: 0.0,
      });
      const sideT = Math.min(0.04, w * 0.08);
      for (const sx of [-1, 1]) {
        const geo = new THREE.BoxGeometry(sideT, h, sideT);
        const rail = new THREE.Mesh(geo, railMat);
        rail.position.set(sx * (w / 2 - sideT / 2), h / 2, d / 2 - sideT / 2);
        rail.castShadow = true;
        group.add(rail);
      }
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

  /**
   * 各部屋の本日（指定通日）の直射日照時間を集計する。
   *
   * デフォルト遮蔽型：室内は原則ふさがれ、窓・開口から見える太陽のみカウント。
   * 天井なし部屋（バルコニー・吹抜け等）は開口または上空への直射も許可。
   *
   * @returns {{ [roomId:string]: number }} 直射時間（時間/日）
   */
  computeDaylight(doy) {
    const plan = this.store.current();
    const result = {};
    if (!plan) return result;
    M.ensureWallRoomIds(plan);
    const lat = plan.meta?.lat ?? DEFAULT_LAT;
    const lng = plan.meta?.lng ?? DEFAULT_LNG;
    const azRad = (plan.site?.azimuth || 0) * Math.PI / 180;
    const date = dateFromDayOfYear(doy);

    const dirs = [];
    for (let h = 0; h < 24; h++) {
      const pos = getSunPosition(date, h, lat, lng);
      if (pos.altitudeDeg <= 0) { dirs.push(null); continue; }
      const dw = sunDirection(pos.azimuthDeg, pos.altitudeDeg);
      dirs.push(new THREE.Vector3(dw.x, dw.y, dw.z).applyAxisAngle(Y_AXIS, -azRad).normalize());
    }

    const occ = this._buildOccluder();
    const ray = new THREE.Raycaster();
    ray.far = 500;
    const origin = new THREE.Vector3();

    for (const floor of plan.floors) {
      const baseY = (floor.level || 0) * (floor.ceilingHeightMM || 2400) * MM;
      for (const room of floor.rooms) {
        if (!room.polygon || room.polygon.length < 3) { result[room.id] = 0; continue; }
        const c = M.polygonCentroid(room.polygon);
        origin.set(c.x * MM, baseY + 1.2, c.z * MM);
        let hours = 0;
        for (let h = 0; h < 24; h++) {
          const dir = dirs[h];
          if (!dir) continue;
          if (this._roomAdmitsSunHour(room, floor, baseY, dir, ray, occ)) hours++;
        }
        result[room.id] = hours;
      }
    }

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
