// plantModel3d.js — 植栽の 3D モデル（素材が無いので低ポリの球・円錐で組み立てる）
//
// 単位は m。家具のローカル座標（X = 幅、Y = 上、Z = 奥行）で床面 y=0 に置き、
// 幅・奥行・高さ（f.wMM/dMM/hMM）の箱にちょうど収まる大きさで作る。

import * as THREE from 'three';
import { seeded } from './plantDraw2d.js';

function mat(color, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.85, metalness: 0, flatShading: true, ...opts });
  m._disposable = true;
  return m;
}

function addMesh(group, geo, material, { cast = true } = {}) {
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

/**
 * 単位立方体（x,z: -0.5〜0.5、y: 0〜1）の中に、もこもこした葉の塊を作る。
 * 外側の group を伸縮して実寸に合わせる。
 */
function foliageCluster(rnd, leafMat, darkMat, count = 9) {
  const g = new THREE.Group();
  addMesh(g, new THREE.IcosahedronGeometry(0.36, 1), leafMat).position.set(0, 0.5, 0);
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = 0.12 + rnd() * 0.16;
    const r = 0.16 + rnd() * 0.1;
    const y = 0.3 + rnd() * 0.42;
    const m = addMesh(g, new THREE.IcosahedronGeometry(r, 1), i % 3 === 0 ? darkMat : leafMat);
    m.position.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
  }
  return g;
}

/** 葉の塊を幅 W・奥行 D・高さ H の箱に収め、下端を y0 に置く */
function fitCluster(cluster, W, H, D, y0) {
  cluster.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(cluster);
  const size = box.getSize(new THREE.Vector3());
  const outer = new THREE.Group();
  cluster.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  outer.add(cluster);
  outer.scale.set(W / Math.max(size.x, 1e-6), H / Math.max(size.y, 1e-6), D / Math.max(size.z, 1e-6));
  outer.position.y = y0;
  return outer;
}

function trunk(group, H, W, D, ratio) {
  const r = Math.max(0.03, Math.min(0.15, Math.min(W, D) * 0.045));
  const h = H * ratio;
  const m = addMesh(group, new THREE.CylinderGeometry(r * 0.8, r, h, 8), mat('#6e4b2a'));
  m.position.y = h / 2;
}

/**
 * @param {string} kind 'tree' | 'conifer' | 'shrub' | 'hedge' | 'lawn' | 'flowerbed'
 * @param {{id?:string,wMM?:number,dMM?:number,hMM?:number,color?:string}} f
 * @returns {THREE.Group}
 */
export function buildPlant3d(kind, f) {
  const W = (f.wMM || 1000) / 1000;
  const D = (f.dMM || 1000) / 1000;
  const H = Math.max(0.005, (f.hMM || 1000) / 1000);
  const leafColor = new THREE.Color(f.color || '#5a8f3c');
  const leafMat = mat(leafColor);
  const darkMat = mat(leafColor.clone().multiplyScalar(0.75));
  const rnd = seeded(f.id || kind);
  const group = new THREE.Group();

  if (kind === 'tree') {
    trunk(group, H, W, D, 0.5);
    group.add(fitCluster(foliageCluster(rnd, leafMat, darkMat, 11), W, H * 0.68, D, H * 0.32));
  } else if (kind === 'conifer') {
    trunk(group, H, W, D, 0.15);
    const tiers = 3;
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      const h = H * 0.5;
      const cone = addMesh(group, new THREE.ConeGeometry(0.5 * (1 - t * 0.28), 1, 9), i % 2 ? darkMat : leafMat);
      cone.scale.set(W, h, D);
      cone.position.y = H * 0.1 + H * 0.3 * i * 0.95 + h / 2 - (i ? H * 0.02 : 0);
    }
    // 収まりきらない分を高さ H に合わせて縮める
    group.updateMatrixWorld(true);
    const top = new THREE.Box3().setFromObject(group).max.y;
    if (top > H) group.scale.y = H / top;
  } else if (kind === 'shrub') {
    group.add(fitCluster(foliageCluster(rnd, leafMat, darkMat, 8), W, H, D, 0));
  } else if (kind === 'hedge') {
    // 長いほうの辺に沿って葉の塊を並べ、四角く刈り込んだ形にする
    const along = W >= D;
    const len = along ? W : D;
    const thick = along ? D : W;
    const n = Math.max(1, Math.round(len / Math.max(thick, 0.3)));
    const inner = new THREE.Group();
    const core = addMesh(inner, new THREE.BoxGeometry(1, 0.86, 1), leafMat);
    core.position.y = 0.43;
    for (let i = 0; i < n; i++) {
      const u = -0.5 + (i + 0.5) / n;
      const b = addMesh(inner, new THREE.IcosahedronGeometry(0.5, 1), rnd() < 0.4 ? darkMat : leafMat);
      b.scale.set(along ? 1.15 / n : 1.04, 0.3, along ? 1.04 : 1.15 / n);
      b.position.set(along ? u : 0, 0.85, along ? 0 : u);
    }
    group.add(fitCluster(inner, W, H, D, 0));
  } else if (kind === 'lawn') {
    const m = addMesh(group, new THREE.BoxGeometry(W, H, D), mat(leafColor, { flatShading: false, roughness: 1 }), { cast: false });
    m.position.y = H / 2;
  } else if (kind === 'flowerbed') {
    const rim = Math.min(0.08, Math.min(W, D) * 0.1);
    const brick = mat('#8b6b4a');
    const bed = new THREE.Group();
    const edges = [
      [W, rim, 0, (D - rim) / 2], [W, rim, 0, -(D - rim) / 2],
      [rim, D - rim * 2, (W - rim) / 2, 0], [rim, D - rim * 2, -(W - rim) / 2, 0],
    ];
    for (const [w, d, x, z] of edges) {
      const e = addMesh(bed, new THREE.BoxGeometry(w, H, d), brick);
      e.position.set(x, H / 2, z);
    }
    const soil = addMesh(bed, new THREE.BoxGeometry(W - rim * 2, H * 0.8, D - rim * 2), mat('#5b4430'), { cast: false });
    soil.position.y = H * 0.4;
    const colors = ['#e74c3c', '#f1c40f', '#ffffff', '#e67e22', '#c0392b', '#f5b7d1'].map((c) => mat(c));
    const iw = W - rim * 2, id = D - rim * 2;
    const n = Math.max(6, Math.min(80, Math.round((iw * id) / 0.02)));
    const r = Math.min(0.06, Math.min(iw, id) * 0.12);
    for (let i = 0; i < n; i++) {
      const x = (rnd() - 0.5) * (iw - r * 2);
      const z = (rnd() - 0.5) * (id - r * 2);
      const stem = addMesh(bed, new THREE.IcosahedronGeometry(r * 1.2, 0), leafMat, { cast: false });
      stem.position.set(x, H * 0.8 + r, z);
      const fl = addMesh(bed, new THREE.IcosahedronGeometry(r, 0), colors[i % colors.length], { cast: false });
      fl.position.set(x, H * 0.8 + r * 2.4, z);
    }
    group.add(bed);
  }
  return group;
}
