// bicycleModel3d.js — 自転車の 3D モデル（素材が無いので円柱・トーラスで組み立てる）
//
// 単位は m。家具のローカル座標（X = 幅、Y = 上、Z = 全長、前輪は -Z）で、床面 y=0 に置く。
// 基準寸法（全長 1900・幅 600・高さ 1100mm のシティサイクル）で組み、家具の w/d/h に合わせて伸縮する。

import * as THREE from 'three';

const BASE = { w: 0.6, d: 1.9, h: 1.1 };
const WHEEL_R = 0.33;
const WHEEL_Z = 0.62;

function mat(color, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.55, metalness: 0.15, ...opts });
  m._disposable = true;
  return m;
}

function addMesh(group, geo, material) {
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

/** 2 点を結ぶ円柱 */
function tube(group, a, b, r, material) {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  if (len < 1e-6) return;
  const mesh = addMesh(group, new THREE.CylinderGeometry(r, r, len, 10), material);
  mesh.position.copy(va).add(vb).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
}

function wheel(group, z, tireMat, metalMat) {
  const tire = addMesh(group, new THREE.TorusGeometry(WHEEL_R - 0.02, 0.022, 10, 36), tireMat);
  tire.rotation.y = Math.PI / 2;
  tire.position.set(0, WHEEL_R, z);
  const rim = addMesh(group, new THREE.TorusGeometry(WHEEL_R - 0.05, 0.008, 6, 36), metalMat);
  rim.rotation.y = Math.PI / 2;
  rim.position.set(0, WHEEL_R, z);
  const n = 12;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = WHEEL_R - 0.05;
    tube(group, [0, WHEEL_R, z], [0, WHEEL_R + Math.sin(t) * r, z + Math.cos(t) * r], 0.0025, metalMat);
  }
  const hub = addMesh(group, new THREE.CylinderGeometry(0.025, 0.025, 0.1, 10), metalMat);
  hub.rotation.z = Math.PI / 2;
  hub.position.set(0, WHEEL_R, z);
}

/**
 * @param {{wMM?:number,dMM?:number,hMM?:number,color?:string}} f
 * @returns {THREE.Group}
 */
export function buildBicycle3d(f) {
  const inner = new THREE.Group();
  const frameMat = mat(f.color || '#2e86c1', { metalness: 0.3, roughness: 0.4 });
  const tireMat = mat('#222222', { metalness: 0, roughness: 0.9 });
  const metalMat = mat('#b8bec6', { metalness: 0.8, roughness: 0.3 });
  const darkMat = mat('#333333', { metalness: 0.1, roughness: 0.7 });

  wheel(inner, -WHEEL_Z, tireMat, metalMat);
  wheel(inner, WHEEL_Z, tireMat, metalMat);

  const R = [0, WHEEL_R, WHEEL_Z];       // 後輪の軸
  const F = [0, WHEEL_R, -WHEEL_Z];      // 前輪の軸
  const B = [0, 0.29, 0.13];             // ペダルの軸（ハンガー）
  const S = [0, 0.82, 0.33];             // シートチューブの上
  const Hb = [0, 0.6, -0.5];             // ヘッドの下
  const Ht = [0, 0.86, -0.45];           // ヘッドの上
  const r = 0.018;

  // シティサイクルのまたぎやすい低いフレーム
  tube(inner, S, B, r, frameMat);
  tube(inner, B, Hb, r * 1.3, frameMat);
  tube(inner, R, B, r * 0.8, frameMat);
  tube(inner, R, [0, 0.76, 0.36], r * 0.7, frameMat);
  tube(inner, Hb, Ht, r * 1.2, frameMat);
  tube(inner, Hb, F, r * 0.9, frameMat); // フォーク

  // サドル
  tube(inner, S, [0, 0.9, 0.36], 0.012, metalMat);
  const saddle = addMesh(inner, new THREE.BoxGeometry(0.16, 0.06, 0.26), darkMat);
  saddle.position.set(0, 0.93, 0.37);

  // ハンドル
  tube(inner, Ht, [0, 1.0, -0.42], 0.012, metalMat);
  tube(inner, [-0.28, 1.0, -0.36], [0.28, 1.0, -0.36], 0.011, metalMat);
  tube(inner, [-0.3, 1.0, -0.36], [-0.2, 1.0, -0.36], 0.017, darkMat);
  tube(inner, [0.2, 1.0, -0.36], [0.3, 1.0, -0.36], 0.017, darkMat);

  // 前かご・荷台
  const basket = addMesh(inner, new THREE.BoxGeometry(0.34, 0.24, 0.3), mat('#8c959e', { transparent: true, opacity: 0.55, metalness: 0.6 }));
  basket.position.set(0, 0.86, -0.77);
  tube(inner, Ht, [0, 0.75, -0.66], 0.008, metalMat);
  const rack = addMesh(inner, new THREE.BoxGeometry(0.17, 0.02, 0.42), metalMat);
  rack.position.set(0, 0.78, 0.59);

  // ペダル
  tube(inner, [-0.1, B[1], B[2]], [0.1, B[1], B[2]], 0.01, darkMat);
  const outer = new THREE.Group();
  outer.add(inner);
  outer.scale.set(
    (f.wMM || 600) / 1000 / BASE.w,
    (f.hMM || 1100) / 1000 / BASE.h,
    (f.dMM || 1900) / 1000 / BASE.d,
  );
  return outer;
}
