// vehicleTint.js — Kenney Car Kit の body メッシュを単色塗装に差し替え

import * as THREE from 'three';

/** 車体メッシュか（タイヤ以外を塗装対象とする） */
function isVehicleBodyMesh(mesh) {
  const n = (mesh.name || '').toLowerCase();
  return !n.includes('wheel');
}

/** 車体のテクスチャを除去し、指定色で塗装する */
export function tintVehicleBody(root, hex) {
  if (!hex) return;
  const color = new THREE.Color(hex);
  root.traverse((o) => {
    if (!o.isMesh || !isVehicleBodyMesh(o)) return;
    o.material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.12,
      metalness: 0.02,
      roughness: 0.62,
      side: THREE.DoubleSide,
    });
  });
}

/** 車の3D塗装色（カタログ既定。保存済み f.color より優先） */
export function vehicleBodyColor(cat, f = null) {
  return cat?.modelBodyColor ?? cat?.color ?? f?.color;
}
