// furnitureIcon2d.js — GLB/OBJ 家具モデルの真上ビューアイコン生成（2D 平面図用）

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

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

/** カタログ既定寸法相当（1m 立方）に正規化して床面に配置 */
function fitModelForTopView(template) {
  const model = template.clone(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  model.scale.set(
    size.x > 1e-6 ? 1 / size.x : 1,
    size.y > 1e-6 ? 1 / size.y : 1,
    size.z > 1e-6 ? 1 / size.z : 1,
  );
  model.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(model);
  model.position.x -= (fitted.min.x + fitted.max.x) / 2;
  model.position.y -= fitted.min.y;
  model.position.z -= (fitted.min.z + fitted.max.z) / 2;
  return model;
}

function renderTopDownIcon(template) {
  const model = fitModelForTopView(template);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const pad = 1.1;
  const halfW = Math.max(size.x * pad * 0.5, 0.05);
  const halfD = Math.max(size.z * pad * 0.5, 0.05);

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
  cam.position.set(center.x, box.max.y + Math.max(size.y, 0.5) + 2, center.z);
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

async function buildIcon(path) {
  const template = await loadModelTemplate(path);
  return renderTopDownIcon(template);
}

function notifyListeners(path, canvas) {
  const set = _pendingListeners.get(path);
  if (!set) return;
  for (const cb of set) cb(canvas);
  _pendingListeners.delete(path);
}

/** キャッシュ済みアイコン canvas（未生成なら null） */
export function getFurnitureIcon(modelPath) {
  const entry = _iconCache.get(modelPath);
  if (entry instanceof HTMLCanvasElement) return entry;
  if (entry === null) return null;
  return undefined;
}

/** アイコン生成を開始。完了時に onReady(canvas|null) を呼ぶ */
export function requestFurnitureIcon(modelPath, onReady) {
  if (!modelPath) {
    onReady(null);
    return;
  }

  const cached = _iconCache.get(modelPath);
  if (cached instanceof HTMLCanvasElement) {
    onReady(cached);
    return;
  }
  if (cached === null) {
    onReady(null);
    return;
  }

  if (!_pendingListeners.has(modelPath)) _pendingListeners.set(modelPath, new Set());
  _pendingListeners.get(modelPath).add(onReady);

  if (cached instanceof Promise) return;

  const task = buildIcon(modelPath)
    .then((canvas) => {
      _iconCache.set(modelPath, canvas);
      notifyListeners(modelPath, canvas);
      return canvas;
    })
    .catch((err) => {
      console.warn('[furnitureIcon2d] icon render failed:', modelPath, err);
      _iconCache.set(modelPath, null);
      notifyListeners(modelPath, null);
      return null;
    });
  _iconCache.set(modelPath, task);
}
