// interiorMinimap.js — 内観モード右上の間取りミニマップ

import * as M from './model.js';
import { getRoomType } from './catalog.js';
import { floorBounds } from './interiorNav.js';

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export class InteriorMinimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._bounds = null;
    this._floorId = null;
  }

  _makeMapper(floor, w, h) {
    const bounds = floorBounds(floor);
    this._bounds = bounds;
    const pad = 14;
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxZ - bounds.minZ;
    const scale = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
    const ox = pad + (w - pad * 2 - bw * scale) / 2;
    const oy = pad + (h - pad * 2 - bh * scale) / 2;
    const toScreen = (x, z) => ({
      x: ox + (x - bounds.minX) * scale,
      y: oy + (z - bounds.minZ) * scale,
    });
    const toWorld = (sx, sy) => ({
      x: bounds.minX + (sx - ox) / scale,
      z: bounds.minZ + (sy - oy) / scale,
    });
    return { toScreen, toWorld, scale };
  }

  draw(floor, player, yawRad) {
    if (!floor || !this.ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;
    this._floorId = floor.id;
    const { toScreen } = this._makeMapper(floor, w, h);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    for (const room of floor.rooms || []) {
      const color = getRoomType(room.type).color;
      ctx.beginPath();
      room.polygon.forEach((p, i) => {
        const s = toScreen(p.x, p.z);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = hexA(color, 0.42);
      ctx.fill();
      ctx.strokeStyle = hexA(color, 0.85);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    for (const wall of floor.walls || []) {
      if (M.isWallEdgeRemoved(floor, wall)) continue;
      const a = toScreen(wall.start.x, wall.start.z);
      const b = toScreen(wall.end.x, wall.end.z);
      ctx.strokeStyle = '#4a5260';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (const p of floor.partitions || []) {
      const { start, end } = M.partitionEndpoints(p);
      const a = toScreen(start.x, start.z);
      const b = toScreen(end.x, end.z);
      ctx.strokeStyle = '#6a6a72';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    const ps = toScreen(player.x, player.z);
    const arrowLen = 18;
    // 移動・視点と一致: yaw=0 で -Z（画面上方向）を向く
    const fx = -Math.sin(yawRad);
    const fz = -Math.cos(yawRad);
    const ax = ps.x + fx * arrowLen;
    const ay = ps.y + fz * arrowLen;

    ctx.strokeStyle = '#2c7be5';
    ctx.fillStyle = '#2c7be5';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(ps.x, ps.y);
    ctx.lineTo(ax, ay);
    ctx.stroke();

    // 視界方向の矢印先端
    const headLen = 7;
    const headAng = Math.atan2(fz, fx);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(
      ax - headLen * Math.cos(headAng - 0.45),
      ay - headLen * Math.sin(headAng - 0.45),
    );
    ctx.lineTo(
      ax - headLen * Math.cos(headAng + 0.45),
      ay - headLen * Math.sin(headAng + 0.45),
    );
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.arc(ps.x, ps.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#333';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(floor.id, 8, 16);
  }

  /** クリック位置 → ワールド mm（同フロア） */
  clickToWorld(floor, clientX, clientY) {
    if (!floor || this._floorId !== floor.id || !this._bounds) return null;
    const rect = this.canvas.getBoundingClientRect();
    const sx = ((clientX - rect.left) / rect.width) * this.canvas.width;
    const sy = ((clientY - rect.top) / rect.height) * this.canvas.height;
    const { toWorld } = this._makeMapper(floor, this.canvas.width, this.canvas.height);
    return toWorld(sx, sy);
  }
}
