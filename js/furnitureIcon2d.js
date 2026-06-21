// furnitureIcon2d.js — GLB/OBJ 家具モデルの真上ビューアイコン生成（2D 平面図用）

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

const MM = 0.001;
const ICON_PX = 256;

const _modelCache = new Map();
const _iconCache = new Map();
const _pendingListeners = new Map();

let _renderer = null;
let _gltfLoader = null;
let _objLoader = null;
let _mtlLoader = null;

function modelUrl(path) {
  return encodeURI(path);
}

function iconCacheKey(modelPath, dims = {}) {
  const w = Math.round(dims.wMM ?? 500);
  const d = Math.round(dims.dMM ?? 500);
  const h = Math.round(dims.hMM ?? 500);
  return `${modelPath}|${w}|${d}|${h}`;
}

function getRenderer() {
  if (!_renderer) {
    _renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    _renderer.setClearColor(0x000000, 0);
  }
  return _renderer;
}

function getLoaders() {
  if (!_gltfLoader) _gltfLoader = new GLTFLoader();
  if (!_objLoader) _objLoader = new OBJLoader();
  if (!_mtlLoader) _mtlLoader = new MTLLoader();
  return { gltf: _gltfLoader, obj: _objLoader, mtl: _mtlLoader };
}

function prepareModel(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (Array.isArray(o.material)) {
      o.material.forEach((m) => { m.side = THREE.DoubleSide; });
    } else if (o.material) {
      o.material.side = THREE.DoubleSide;
    }
  });
  return root;
}

async function loadModelTemplate(path) {
  if (_modelCache.has(path)) return _modelCache.get(path);
  const task = (async () => {
    const url = modelUrl(path);
    const lower = path.toLowerCase();
    const { gltf, obj, mtl } = getLoaders();
    if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
      const data = await gltf.loadAsync(url);
      return prepareModel(data.scene);
    }
    if (lower.endsWith('.obj')) {
      const mtlPath = path.replace(/\.obj$/i, '.mtl');
      try {
        const materials = await mtl.loadAsync(modelUrl(mtlPath));
        materials.preload();
        return prepareModel(await obj.setMaterials(materials).loadAsync(url));
      } catch {
        return prepareModel(await obj.loadAsync(url));
      }
    }
    throw new Error(`Unsupported model format: ${path}`);
  })();
  _modelCache.set(path, task);
  return task;
}

/** 3D 表示と同じ w/d/h フットプリント（mm）に非等倍フィットして床面に配置 */
function fitModelToFootprint(template, dims) {
  const model = template.clone(true);
  const targetW = (dims.wMM || 500) * MM;
  const targetH = (dims.hMM || 500) * MM;
  const targetD = (dims.dMM || 500) * MM;

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  model.scale.set(
    size.x > 1e-6 ? targetW / size.x : 1,
    size.y > 1e-6 ? targetH / size.y : 1,
    size.z > 1e-6 ? targetD / size.z : 1,
  );
  model.updateMatrixWorld(true);

  const fitted = new THREE.Box3().setFromObject(model);
  model.position.x -= (fitted.min.x + fitted.max.x) / 2;
  model.position.y -= fitted.min.y;
  model.position.z -= (fitted.min.z + fitted.max.z) / 2;
  return model;
}

function renderTopDownIcon(template, dims) {
  const model = fitModelToFootprint(template, dims);
  const targetW = (dims.wMM || 500) * MM;
  const targetD = (dims.dMM || 500) * MM;
  const halfW = targetW / 2;
  const halfD = targetD / 2;
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());

  const aspect = halfW / halfD;
  let pxW = ICON_PX;
  let pxH = ICON_PX;
  if (aspect >= 1) pxH = Math.max(64, Math.round(ICON_PX / aspect));
  else pxW = Math.max(64, Math.round(ICON_PX * aspect));

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.15));
  const dir = new THREE.DirectionalLight(0xffffff, 0.65);
  dir.position.set(0.4, 1, 0.6);
  scene.add(dir);
  scene.add(model);

  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfD, -halfD, 0.01, 100);
  cam.position.set(center.x, box.max.y + 2, center.z);
  cam.up.set(0, 0, -1);
  cam.lookAt(center.x, center.y, center.z);

  const renderer = getRenderer();
  renderer.setSize(pxW, pxH, false);
  renderer.render(scene, cam);

  const out = document.createElement('canvas');
  out.width = pxW;
  out.height = pxH;
  out.getContext('2d').drawImage(renderer.domElement, 0, 0);
  return out;
}

async function buildIcon(modelPath, dims) {
  const template = await loadModelTemplate(modelPath);
  return renderTopDownIcon(template, dims);
}

function notifyListeners(cacheKey, canvas) {
  const set = _pendingListeners.get(cacheKey);
  if (!set) return;
  for (const cb of set) cb(canvas);
  _pendingListeners.delete(cacheKey);
}

/** キャッシュ済みアイコン canvas（未生成なら undefined、失敗 null） */
export function getFurnitureIcon(modelPath, dims = {}) {
  const key = iconCacheKey(modelPath, dims);
  const entry = _iconCache.get(key);
  if (entry instanceof HTMLCanvasElement) return entry;
  if (entry === null) return null;
  return undefined;
}

/** アイコン生成を開始。完了時に onReady(canvas|null) を呼ぶ */
export function requestFurnitureIcon(modelPath, dims, onReady) {
  if (typeof dims === 'function') {
    onReady = dims;
    dims = {};
  }
  if (!modelPath) {
    onReady(null);
    return;
  }

  const key = iconCacheKey(modelPath, dims);
  const cached = _iconCache.get(key);
  if (cached instanceof HTMLCanvasElement) {
    onReady(cached);
    return;
  }
  if (cached === null) {
    onReady(null);
    return;
  }

  if (!_pendingListeners.has(key)) _pendingListeners.set(key, new Set());
  _pendingListeners.get(key).add(onReady);

  if (cached instanceof Promise) return;

  const task = buildIcon(modelPath, dims)
    .then((canvas) => {
      _iconCache.set(key, canvas);
      notifyListeners(key, canvas);
      return canvas;
    })
    .catch((err) => {
      console.warn('[furnitureIcon2d] icon render failed:', modelPath, err);
      _iconCache.set(key, null);
      notifyListeners(key, null);
      return null;
    });
  _iconCache.set(key, task);
}
