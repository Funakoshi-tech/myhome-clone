// floorTexture.js — 床テクスチャの生成・読込・UV・マテリアル

import * as THREE from 'three';
import { FLOORING_TYPES } from './catalog.js';

const MM = 0.001;

const _texCache = new Map();
const _matCache = new Map();

/** 板目パレット（ホワイトオーク系） */
const PROCEDURAL_PALETTES = {
  whitewash_oak: {
    base: [228, 226, 222],
    light: [238, 236, 232],
    dark: [205, 202, 198],
    gap: [168, 166, 162],
    grain: [195, 192, 188],
  },
  natural_oak: {
    base: [215, 190, 155],
    light: [228, 205, 170],
    dark: [185, 155, 120],
    gap: [140, 115, 85],
    grain: [175, 145, 110],
  },
  walnut: {
    base: [120, 92, 68],
    light: [138, 108, 82],
    dark: [88, 66, 48],
    gap: [58, 44, 32],
    grain: [75, 56, 40],
  },
  tile_gray: {
    base: [178, 181, 184],
    light: [198, 201, 204],
    dark: [148, 152, 156],
    grout: [138, 142, 146],
    vein: [125, 130, 136],
  },
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** シームレスな直線板目テクスチャ（板の長辺 = 画像の V = ワールド Z） */
function createProceduralPlankTexture(styleId) {
  const palette = PROCEDURAL_PALETTES[styleId] || PROCEDURAL_PALETTES.whitewash_oak;
  const plankW = 64;
  const plankL = 256;
  const cols = 8;
  const W = cols * plankW;
  const H = plankL;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = rgb(palette.gap);
  ctx.fillRect(0, 0, W, H);

  for (let col = 0; col < cols; col++) {
    const seed = col + 1;
    const r = mulberry32(seed);
    const px = col * plankW + 1;
    const py = 1;
    const pw = plankW - 2;
    const ph = plankL - 2;

    const tone = r();
    const c = tone < 0.35 ? palette.light : tone > 0.7 ? palette.dark : palette.base;
    ctx.fillStyle = rgb(c);
    ctx.fillRect(px, py, pw, ph);

    ctx.lineWidth = 1;
    const grainN = 12 + Math.floor(r() * 5);
    for (let g = 0; g < grainN; g++) {
      const gx = px + 2 + r() * (pw - 4);
      const gy0 = py + 2 + (ph - 4) * (g / grainN);
      const gy1 = py + 2 + (ph - 4) * ((g + 0.55 + r() * 0.35) / grainN);
      ctx.strokeStyle = `rgba(${palette.grain[0]},${palette.grain[1]},${palette.grain[2]},${0.14 + r() * 0.16})`;
      ctx.beginPath();
      ctx.moveTo(gx, gy0);
      ctx.lineTo(gx + (r() - 0.5) * 4, gy1);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** シームレスなグレー石調タイル（格子目地・壁に平行） */
function createProceduralTileTexture(styleId) {
  const palette = PROCEDURAL_PALETTES[styleId] || PROCEDURAL_PALETTES.tile_gray;
  const tilePx = 128;
  const cols = 4;
  const W = cols * tilePx;
  const H = W;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = rgb(palette.grout);
  ctx.fillRect(0, 0, W, H);

  for (let row = 0; row < cols; row++) {
    for (let col = 0; col < cols; col++) {
      const seed = row * cols + col + 1;
      const r = mulberry32(seed);
      const px = col * tilePx + 2;
      const py = row * tilePx + 2;
      const pw = tilePx - 4;
      const ph = tilePx - 4;

      const tone = r();
      const c = tone < 0.3 ? palette.light : tone > 0.72 ? palette.dark : palette.base;
      ctx.fillStyle = rgb(c);
      ctx.fillRect(px, py, pw, ph);

      // 大理石風の筋
      ctx.lineWidth = 1.2;
      const veins = 4 + Math.floor(r() * 4);
      for (let v = 0; v < veins; v++) {
        const vx0 = px + r() * pw;
        const vy0 = py + r() * ph;
        const vx1 = px + r() * pw;
        const vy1 = py + r() * ph;
        ctx.strokeStyle = `rgba(${palette.vein[0]},${palette.vein[1]},${palette.vein[2]},${0.18 + r() * 0.22})`;
        ctx.beginPath();
        ctx.moveTo(vx0, vy0);
        ctx.bezierCurveTo(
          px + r() * pw, py + r() * ph,
          px + r() * pw, py + r() * ph,
          vx1, vy1,
        );
        ctx.stroke();
      }

      // 微細なムラ
      ctx.fillStyle = `rgba(255,255,255,${0.02 + r() * 0.05})`;
      ctx.fillRect(px + r() * pw * 0.5, py + r() * ph * 0.5, pw * 0.35, ph * 0.25);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** 畳テクスチャ（淡い緑・横畳目の織り目） */
function createProceduralTatamiTexture() {
  const palette = {
    base: [194, 204, 172],
    light: [210, 220, 188],
    dark: [176, 186, 158],
    gap: [102, 112, 88],
    weave: [148, 162, 132],
  };
  const matW = 64;
  const matL = 128;
  const cols = 8;
  const W = cols * matW;
  const H = matL;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = rgb(palette.gap);
  ctx.fillRect(0, 0, W, H);

  for (let col = 0; col < cols; col++) {
    const seed = col + 1;
    const r = mulberry32(seed);
    const px = col * matW + 2;
    const py = 2;
    const pw = matW - 4;
    const ph = matL - 4;

    const tone = r();
    const c = tone < 0.32 ? palette.light : tone > 0.68 ? palette.dark : palette.base;
    ctx.fillStyle = rgb(c);
    ctx.fillRect(px, py, pw, ph);

    // 畳目（横方向の細い織り筋）
    const weaveGap = 2 + Math.floor(r() * 2);
    for (let y = py + 3; y < py + ph - 2; y += weaveGap) {
      const wobble = (r() - 0.5) * 0.6;
      ctx.strokeStyle = `rgba(${palette.weave[0]},${palette.weave[1]},${palette.weave[2]},${0.22 + r() * 0.18})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(px + 2, y + wobble);
      ctx.lineTo(px + pw - 2, y + wobble);
      ctx.stroke();
    }

    // わずかなムラ
    if (r() > 0.45) {
      ctx.fillStyle = `rgba(255,255,255,${0.02 + r() * 0.04})`;
      ctx.fillRect(px + 4, py + 4 + r() * (ph - 12), pw - 8, 6);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function rgb(c) {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * ワールド座標に合わせて床 UV を設定。
 * タイル: 格子状（X/Z に平行）。板目: 長辺はワールド Z。
 */
export function applyFloorUvs(geometry, flooring) {
  const pos = geometry.attributes.position;
  const uvs = new Float32Array(pos.count * 2);

  if (flooring?.tileSizeMM) {
    const tileM = Math.max(flooring.tileSizeMM, 100) * MM;
    for (let i = 0; i < pos.count; i++) {
      uvs[i * 2] = pos.getX(i) / tileM;
      uvs[i * 2 + 1] = -pos.getZ(i) / tileM;
    }
  } else {
    const plankW = Math.max(flooring?.plankWidthMM || 180, 50) * MM;
    const plankL = Math.max(flooring?.plankLengthMM || 1200, 200) * MM;
    for (let i = 0; i < pos.count; i++) {
      uvs[i * 2] = pos.getX(i) / plankW;
      uvs[i * 2 + 1] = -pos.getZ(i) / plankL;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

function resolveTexture(flooring, loader) {
  if (flooring.procedural) {
    const key = `proc:${flooring.procedural}`;
    if (!_texCache.has(key)) {
      let tex;
      if (flooring.procedural === 'tatami') {
        tex = createProceduralTatamiTexture();
      } else if (flooring.tileSizeMM) {
        tex = createProceduralTileTexture(flooring.procedural);
      } else {
        tex = createProceduralPlankTexture(flooring.procedural);
      }
      _texCache.set(key, tex);
    }
    return _texCache.get(key);
  }
  if (flooring.texture) return loadTexture(flooring.texture, loader);
  return null;
}

async function loadTexture(path, loader) {
  if (_texCache.has(path)) return _texCache.get(path);
  const task = loader.loadAsync(encodeURI(path)).then((tex) => {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  });
  _texCache.set(path, task);
  return task;
}

function solidMaterial(flooring) {
  const key = `solid:${flooring.id}`;
  if (_matCache.has(key)) return _matCache.get(key);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(flooring.color || '#c9ad88'),
    roughness: flooring.roughness ?? 0.9,
    metalness: flooring.metalness ?? 0,
    side: THREE.DoubleSide,
  });
  _matCache.set(key, mat);
  return mat;
}

async function texturedMaterial(flooring, loader) {
  const key = `tex:${flooring.id}`;
  if (_matCache.has(key)) return _matCache.get(key);
  const tex = await resolveTexture(flooring, loader);
  if (!tex) return solidMaterial(flooring);
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    color: new THREE.Color(flooring.tint || '#ffffff'),
    roughness: flooring.roughness ?? 0.72,
    metalness: flooring.metalness ?? 0,
    side: THREE.DoubleSide,
  });
  _matCache.set(key, mat);
  return mat;
}

/** 床材定義からマテリアルを取得（キャッシュあり） */
export async function materialForFlooring(flooring, loader) {
  if (!flooring?.procedural && !flooring?.texture) return solidMaterial(flooring);
  return texturedMaterial(flooring, loader);
}

/** 全床材テクスチャを先読み */
export async function preloadFlooringMaterials(loader) {
  await Promise.all(FLOORING_TYPES.map((f) => materialForFlooring(f, loader)));
}

export function getCachedFlooringMaterial(flooring) {
  if (!flooring) return null;
  if (flooring.procedural || flooring.texture) {
    return _matCache.get(`tex:${flooring.id}`) || null;
  }
  return _matCache.get(`solid:${flooring.id}`) || solidMaterial(flooring);
}
