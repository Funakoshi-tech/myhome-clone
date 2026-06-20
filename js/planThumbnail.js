// planThumbnail.js — プラン一覧用の簡易サムネイル描画（Editor2D に依存しない）

import * as M from './model.js';
import { getRoomType } from './catalog.js';

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function planBounds(plan) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const expand = (pt) => {
    minX = Math.min(minX, pt.x);
    maxX = Math.max(maxX, pt.x);
    minZ = Math.min(minZ, pt.z);
    maxZ = Math.max(maxZ, pt.z);
  };
  for (const floor of plan.floors) {
    for (const room of floor.rooms) {
      for (const p of room.polygon) expand(p);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, maxX, minZ, maxZ };
}

function pickPreviewFloor(plan) {
  for (const id of ['1F', '2F', '3F']) {
    const f = M.getFloor(plan, id);
    if (f.rooms.length) return f;
  }
  return plan.floors[0] || M.getFloor(plan, '1F');
}

/**
 * プランの簡易間取り図を canvas に描画する。
 * @param {object} plan
 * @param {HTMLCanvasElement} canvas
 */
export function renderPlanThumbnail(plan, canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cssW = canvas.clientWidth || 280;
  const cssH = canvas.clientHeight || 200;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#f3ebe0';
  ctx.fillRect(0, 0, cssW, cssH);

  const bounds = planBounds(plan);
  const floor = pickPreviewFloor(plan);
  if (!bounds || !floor.rooms.length) {
    ctx.fillStyle = '#9aa3b0';
    ctx.font = '500 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('間取り未作成', cssW / 2, cssH / 2);
    return;
  }

  const pad = 600;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const h = bounds.maxZ - bounds.minZ + pad * 2;
  const scale = Math.max(0.005, Math.min(cssW / w, cssH / h));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const panX = cssW / 2 - cx * scale;
  const panY = cssH / 2 - cz * scale;

  const toScreen = (x, z) => ({
    x: x * scale + panX,
    y: z * scale + panY,
  });

  const drawPoly = (polygon, fill, stroke, lw = 1) => {
    ctx.beginPath();
    polygon.forEach((p, i) => {
      const s = toScreen(p.x, p.z);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  };

  for (const room of floor.rooms) {
    const color = getRoomType(room.type).color;
    drawPoly(room.polygon, hexA(color, 0.45), hexA(color, 0.85), 1.2);
  }

  for (const wall of floor.walls) {
    const a = toScreen(wall.start.x, wall.start.z);
    const b = toScreen(wall.end.x, wall.end.z);
    ctx.lineWidth = Math.max(1.5, (wall.thicknessMM || 120) * scale * 0.5);
    ctx.strokeStyle = '#5a6270';
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.fillStyle = '#3d4654';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 10px system-ui, sans-serif';
  for (const room of floor.rooms) {
    if (room.labelVisible === false) continue;
    const c = M.polygonCentroid(room.polygon);
    const s = toScreen(c.x, c.z);
    const name = room.name || getRoomType(room.type).name;
    ctx.fillText(name, s.x, s.y);
  }
}
