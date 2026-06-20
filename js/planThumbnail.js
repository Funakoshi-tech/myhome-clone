// planThumbnail.js — プラン一覧用の簡易サムネイル描画（Editor2D に依存しない）

import * as M from './model.js';
import { getRoomType } from './catalog.js';
import { drawStair2d } from './stairDraw2d.js';

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function expandBounds(bounds, pt) {
  if (!bounds) {
    return { minX: pt.x, maxX: pt.x, minZ: pt.z, maxZ: pt.z };
  }
  return {
    minX: Math.min(bounds.minX, pt.x),
    maxX: Math.max(bounds.maxX, pt.x),
    minZ: Math.min(bounds.minZ, pt.z),
    maxZ: Math.max(bounds.maxZ, pt.z),
  };
}

function appendStairBounds(bounds, floor) {
  let b = bounds;
  for (const s of floor.stairs || []) {
    for (const c of M.stairFootprintCorners(s)) b = expandBounds(b, c);
  }
  return b;
}

function planBounds(plan) {
  let b = null;
  for (const floor of plan.floors) {
    for (const room of floor.rooms) {
      for (const p of room.polygon) b = expandBounds(b, p);
    }
    b = appendStairBounds(b, floor);
  }
  return b;
}

function floorBounds(floor) {
  let b = null;
  for (const room of floor.rooms) {
    for (const p of room.polygon) b = expandBounds(b, p);
  }
  return appendStairBounds(b, floor);
}

function pickPreviewFloor(plan) {
  for (const id of ['1F', '2F', '3F']) {
    const f = M.getFloor(plan, id);
    if (f.rooms.length) return f;
  }
  return plan.floors[0] || M.getFloor(plan, '1F');
}

function drawFloorContent(ctx, floor, toScreen, scale, opts = {}) {
  const { showLabels = true, labelPrefix = '', plan = null } = opts;

  const lower = plan ? M.getLowerFloor(plan, floor.id) : null;
  if (lower) {
    for (const s of lower.stairs || []) {
      const sc = toScreen(s.x, s.z);
      drawStair2d(ctx, s, sc.x, sc.y, scale, { fromLowerFloor: lower.id, showLabel: false });
    }
  }

  for (const room of floor.rooms) {
    const color = getRoomType(room.type).color;
    ctx.beginPath();
    room.polygon.forEach((p, i) => {
      const s = toScreen(p.x, p.z);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.fillStyle = hexA(color, 0.45);
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = hexA(color, 0.85);
    ctx.stroke();
  }

  for (const wall of floor.walls) {
    const a = toScreen(wall.start.x, wall.start.z);
    const b = toScreen(wall.end.x, wall.end.z);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#5a6270';
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (const s of floor.stairs || []) {
    const sc = toScreen(s.x, s.z);
    drawStair2d(ctx, s, sc.x, sc.y, scale, { showLabel: false });
  }

  if (!showLabels) return;

  ctx.fillStyle = '#3d4654';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 10px system-ui, sans-serif';
  for (const room of floor.rooms) {
    if (room.labelVisible === false) continue;
    const c = M.polygonCentroid(room.polygon);
    const s = toScreen(c.x, c.z);
    const name = room.name || getRoomType(room.type).name;
    ctx.fillText(labelPrefix + name, s.x, s.y);
  }
}

/**
 * プランの簡易間取り図を canvas に描画する。
 * @param {object} plan
 * @param {HTMLCanvasElement} canvas
 * @param {{ floorId?: string, emptyLabel?: string }} [opts]
 */
export function renderPlanThumbnail(plan, canvas, opts = {}) {
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

  const floorId = opts.floorId;
  const floor = floorId ? M.getFloor(plan, floorId) : pickPreviewFloor(plan);
  const bounds = floorId ? floorBounds(floor) : planBounds(plan);

  const hasContent = floor.rooms.length || (floor.stairs || []).length;
  if (!bounds || !hasContent) {
    ctx.fillStyle = '#9aa3b0';
    ctx.font = '500 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.emptyLabel || '間取り未作成', cssW / 2, cssH / 2);
    return;
  }

  const pad = floorId ? 400 : 600;
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

  drawFloorContent(ctx, floor, toScreen, scale, { plan, showLabels: !floorId });
}

/** 1F / 2F / 3F の各 canvas に間取りを描画 */
export function renderPlanFloorThumbnails(plan, container) {
  for (const floorId of ['1F', '2F', '3F']) {
    const canvas = container.querySelector(`canvas[data-floor="${floorId}"]`);
    if (canvas) renderPlanThumbnail(plan, canvas, { floorId });
  }
}
