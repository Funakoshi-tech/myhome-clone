// interiorMode.js — 内観（一人称）モードの入力・移動・UI連携

import * as THREE from 'three';
import * as NAV from './interiorNav.js';
import { InteriorMinimap } from './interiorMinimap.js';
import * as M from './model.js';

const MM = 0.001;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

export class InteriorMode {
  constructor(viewer) {
    this.viewer = viewer;
    this.active = false;
    this.pos = { x: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this._keys = new Set();
    this._segments = [];
    this._obstacles = [];
    this._lastT = 0;
    this._lookDragging = false;
    this._lastLookX = 0;
    this._lastLookY = 0;

    this._overlay = document.getElementById('interior-overlay');
    this._minimapCanvas = document.getElementById('interior-minimap');
    this._floorBar = document.getElementById('interior-floor-bar');
    this._minimap = this._minimapCanvas ? new InteriorMinimap(this._minimapCanvas) : null;

    this._onKeyDown = (e) => this._handleKey(e, true);
    this._onKeyUp = (e) => this._handleKey(e, false);
    this._onCanvasMouseDown = (e) => this._onCanvasMouseDownHandler(e);
    this._onCanvasMouseMove = (e) => this._onCanvasMouseMoveHandler(e);
    this._onCanvasMouseUp = (e) => this._onCanvasMouseUpHandler(e);
    this._onCanvasContextMenu = (e) => {
      if (this.active) e.preventDefault();
    };
    this._onMinimapClick = (e) => this._handleMinimapClick(e);
    this._onWindowBlur = () => {
      this._keys.clear();
      this._lookDragging = false;
    };
  }

  _plan() { return this.viewer.store.current(); }

  _floor() {
    const plan = this._plan();
    return plan ? M.getFloor(plan, this.viewer.ui.floorId) : null;
  }

  _refreshCollision() {
    const floor = this._floor();
    if (!floor) return;
    this._segments = NAV.buildCollisionSegments(floor);
    this._obstacles = NAV.buildFurnitureObstacles(floor);
  }

  enter(opts = {}) {
    const viewer = this.viewer;
    if (viewer.ui.view3dAllFloors) {
      viewer.ui.view3dAllFloors = false;
      viewer.rebuild({ fitCamera: false });
    }
    this.active = true;
    viewer.controls.enabled = false;
    this._refreshCollision();

    const floor = this._floor();
    if (opts.warp && opts.x != null && opts.z != null) {
      this._setPosition(opts.x, opts.z, true);
    } else if (!opts.keepPosition) {
      const spawn = NAV.findInteriorSpawn(floor, this._plan());
      this.pos.x = spawn.x;
      this.pos.z = spawn.z;
      this.yaw = spawn.yaw;
      this.pitch = 0;
      this._ensureFreePosition();
      const genkan = (floor.rooms || []).find((r) => r.type === 'genkan' && r.polygon?.length >= 3);
      if (genkan) {
        const c = M.polygonCentroid(genkan.polygon);
        this.yaw = Math.atan2(c.x - this.pos.x, -(c.z - this.pos.z));
      }
    }

    if (opts.yaw != null) this.yaw = opts.yaw;
    if (opts.pitch != null) this.pitch = opts.pitch;

    window.addEventListener('keydown', this._onKeyDown, true);
    window.addEventListener('keyup', this._onKeyUp, true);
    window.addEventListener('blur', this._onWindowBlur);
    const el = viewer.renderer.domElement;
    el.setAttribute('tabindex', '-1');
    el.addEventListener('mousedown', this._onCanvasMouseDown);
    el.addEventListener('mousemove', this._onCanvasMouseMove);
    el.addEventListener('mouseup', this._onCanvasMouseUp);
    el.addEventListener('mouseleave', this._onCanvasMouseUp);
    el.addEventListener('contextmenu', this._onCanvasContextMenu);
    window.addEventListener('mousemove', this._onCanvasMouseMove);
    this._minimapCanvas?.addEventListener('click', this._onMinimapClick);

    this._blurPageFocus();
    this._focusView(true);

    this._overlay?.removeAttribute('hidden');
    this._buildFloorBar();
    this._lastT = performance.now();
    this._updateCamera();
    this._drawMinimap();
  }

  exit() {
    this.active = false;
    this.viewer.controls.enabled = true;
    window.removeEventListener('keydown', this._onKeyDown, true);
    window.removeEventListener('keyup', this._onKeyUp, true);
    window.removeEventListener('blur', this._onWindowBlur);
    const el = this.viewer.renderer?.domElement;
    if (el) {
      el.removeEventListener('mousedown', this._onCanvasMouseDown);
      el.removeEventListener('mousemove', this._onCanvasMouseMove);
      el.removeEventListener('mouseup', this._onCanvasMouseUp);
      el.removeEventListener('mouseleave', this._onCanvasMouseUp);
      el.removeEventListener('contextmenu', this._onCanvasContextMenu);
    }
    window.removeEventListener('mousemove', this._onCanvasMouseMove);
    this._minimapCanvas?.removeEventListener('click', this._onMinimapClick);
    this._keys.clear();
    this._lookDragging = false;
    this._overlay?.setAttribute('hidden', '');
  }

  onRebuild() {
    if (!this.active) return;
    this._refreshCollision();
    this._setPosition(this.pos.x, this.pos.z, true);
    this._buildFloorBar();
    this._drawMinimap();
  }

  _setPosition(x, z, snap) {
    const floor = this._floor();
    if (!floor) return;
    let p = { x, z };
    if (snap) {
      const snapped = NAV.snapWarpPosition(x, z, floor, this._segments, this._obstacles);
      if (snapped) p = snapped;
    }
    this.pos.x = p.x;
    this.pos.z = p.z;
    this._ensureFreePosition();
    this._updateCamera();
  }

  _ensureFreePosition() {
    const floor = this._floor();
    if (!floor) return;
    if (!NAV.collidesAt(this.pos, floor, this._segments, this._obstacles)) return;
    const snapped = NAV.snapWarpPosition(
      this.pos.x, this.pos.z, floor, this._segments, this._obstacles,
    );
    if (snapped) {
      this.pos.x = snapped.x;
      this.pos.z = snapped.z;
    }
  }

  warpTo(x, z) {
    this._setPosition(x, z, true);
    this._drawMinimap();
  }

  warpToFloor(floorId) {
    const plan = this._plan();
    if (!plan || !M.getFloor(plan, floorId)) return;
    const keepX = this.pos.x;
    const keepZ = this.pos.z;
    this.viewer.ui.floorId = floorId;
    this.viewer.rebuild({ fitCamera: false });
    this._refreshCollision();
    this._setPosition(keepX, keepZ, true);
    this._buildFloorBar();
    this._drawMinimap();
  }

  _buildFloorBar() {
    const bar = this._floorBar;
    if (!bar) return;
    const plan = this._plan();
    if (!plan) { bar.innerHTML = ''; return; }
    bar.innerHTML = '';
    for (const floor of NAV.floorsWithContent(plan)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'interior-floor-btn';
      btn.textContent = floor.id;
      btn.classList.toggle('active', floor.id === this.viewer.ui.floorId);
      btn.addEventListener('click', () => this.warpToFloor(floor.id));
      bar.appendChild(btn);
    }
  }

  _handleMinimapClick(e) {
    e.stopPropagation();
    const floor = this._floor();
    if (!floor || !this._minimap) return;
    const w = this._minimap.clickToWorld(floor, e.clientX, e.clientY);
    if (w) this.warpTo(w.x, w.z);
  }

  _moveKeyFromEvent(e) {
    const byCode = {
      KeyW: 'KeyW', KeyA: 'KeyA', KeyS: 'KeyS', KeyD: 'KeyD',
      ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    };
    if (byCode[e.code]) return byCode[e.code];
    const byKey = {
      w: 'KeyW', W: 'KeyW', a: 'KeyA', A: 'KeyA', s: 'KeyS', S: 'KeyS', d: 'KeyD', D: 'KeyD',
      ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    };
    return byKey[e.key] || null;
  }

  _focusView(force = false) {
    const canvas = this.viewer.renderer?.domElement;
    const host = this.viewer.container;
    const el = canvas || host;
    if (!el) return;
    el.setAttribute('tabindex', '-1');
    if (host) host.setAttribute('tabindex', '-1');
    const apply = () => {
      if (!this.active) return;
      const active = document.activeElement;
      if (!force
        && active
        && active !== document.body
        && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return;
      if (active && active !== el && active !== document.body && active.blur) {
        active.blur();
      }
      el.focus({ preventScroll: true });
    };
    requestAnimationFrame(() => requestAnimationFrame(apply));
  }

  focusView() {
    this._focusView(true);
  }

  _blurPageFocus() {
    const active = document.activeElement;
    if (active && active !== document.body && active.blur) active.blur();
  }

  _handleKey(e, down) {
    if (!this.active) return;
    const target = e.target;
    const tag = target?.tagName || '';
    const k = this._moveKeyFromEvent(e);
    if (!k) return;

    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(tag) || target?.isContentEditable;
    if (inField && down) {
      if (target.blur) target.blur();
      this._focusView(true);
    } else if (inField && !down) {
      // keyup は入力欄に届くことがあるが、歩行状態は解除する
      this._keys.delete(k);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (down) {
      this._keys.add(k);
      this._focusView(true);
    } else {
      this._keys.delete(k);
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /** 左ボタン押下中のドラッグ、または左+右同時押しで視点移動 */
  _isLookDrag(e) {
    if (this._lookDragging) return true;
    const b = e.buttons;
    return (b & 1) && (b & 2);
  }

  _onCanvasMouseDownHandler(e) {
    if (!this.active) return;
    this._blurPageFocus();
    this._focusView(true);
    const b = e.buttons;
    if (e.button === 0) {
      this._lookDragging = true;
      this._lastLookX = e.clientX;
      this._lastLookY = e.clientY;
      e.preventDefault();
    } else if (e.button === 2 && (b & 1)) {
      this._lookDragging = true;
      this._lastLookX = e.clientX;
      this._lastLookY = e.clientY;
      e.preventDefault();
    }
    if (e.button === 2) e.preventDefault();
  }

  _onCanvasMouseUpHandler(e) {
    if (!this.active) return;
    if (e.button === 0) this._lookDragging = false;
    this._lastLookX = e.clientX;
    this._lastLookY = e.clientY;
  }

  _onCanvasMouseMoveHandler(e) {
    if (!this.active || !this._isLookDrag(e)) return;
    const dx = e.clientX - this._lastLookX;
    const dy = e.clientY - this._lastLookY;
    this._lastLookX = e.clientX;
    this._lastLookY = e.clientY;
    if (dx === 0 && dy === 0) return;
    const sens = 0.004;
    this.yaw += dx * sens;
    this.pitch += dy * sens;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    this._updateCamera();
    this._drawMinimap();
    e.preventDefault();
  }

  update() {
    if (!this.active) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this._lastT) / 1000);
    this._lastT = now;

    let fx = 0, fz = 0;
    if (this._keys.has('KeyW') || this._keys.has('ArrowUp')) fz -= 1;
    if (this._keys.has('KeyS') || this._keys.has('ArrowDown')) fz += 1;
    if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) fx -= 1;
    if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) fx += 1;

    if (fx !== 0 || fz !== 0) {
      const len = Math.hypot(fx, fz) || 1;
      fx /= len; fz /= len;
      const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
      const dx = (fx * cos + fz * sin) * NAV.WALK_SPEED_MM_S * dt;
      const dz = (-fx * sin + fz * cos) * NAV.WALK_SPEED_MM_S * dt;
      const floor = this._floor();
      if (floor) {
        const next = NAV.tryMove(
          this.pos,
          { x: this.pos.x + dx, z: this.pos.z + dz },
          floor,
          this._segments,
          this._obstacles,
        );
        this.pos.x = next.x;
        this.pos.z = next.z;
        this._updateCamera();
        this._drawMinimap();
      }
    }
  }

  _updateCamera() {
    const viewer = this.viewer;
    const lx = this.pos.x * MM;
    const ly = NAV.EYE_HEIGHT_MM * MM;
    const lz = this.pos.z * MM;
    const world = new THREE.Vector3(lx, ly, lz);
    viewer.root.localToWorld(world);
    viewer.camera.position.copy(world);
    viewer.camera.rotation.order = 'YXZ';
    viewer.camera.rotation.y = this.yaw + viewer.root.rotation.y;
    viewer.camera.rotation.x = this.pitch;
    viewer.camera.rotation.z = 0;
  }

  _drawMinimap() {
    const floor = this._floor();
    if (floor && this._minimap) {
      this._minimap.draw(floor, this.pos, this.yaw);
    }
  }
}
