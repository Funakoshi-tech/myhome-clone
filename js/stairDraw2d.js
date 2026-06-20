// stairDraw2d.js — 2D 階段シンボル描画（エディタ・サムネイル共通）

import { getStairType } from './catalog.js';

function arrowPx(ctx, x1, y1, x2, y2) {
  ctx.strokeStyle = 'rgba(60,40,20,0.85)';
  ctx.fillStyle = 'rgba(60,40,20,0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const ah = 7;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - ah * Math.cos(ang - Math.PI / 6), y2 - ah * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(x2 - ah * Math.cos(ang + Math.PI / 6), y2 - ah * Math.sin(ang + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function stairStraight(ctx, hw, hd, n) {
  const col = 'rgba(100,80,45,0.72)';
  ctx.lineWidth = 1;
  ctx.strokeStyle = col;
  for (let i = 0; i <= n; i++) {
    const y = -hd + (hd * 2 * i) / n;
    ctx.beginPath();
    ctx.moveTo(-hw, y);
    ctx.lineTo(hw, y);
    ctx.stroke();
  }
  const cutY = -hd + hd * 2 * 0.4;
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(100,80,45,0.95)';
  ctx.beginPath();
  ctx.moveTo(-hw, cutY - hw * 0.35);
  ctx.lineTo(hw, cutY + hw * 0.35);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  arrowPx(ctx, 0, hd * 0.65, 0, -hd * 0.65);
}

function stairLShape(ctx, hw, hd, n) {
  const col = 'rgba(100,80,45,0.72)';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(100,80,45,0.90)';
  ctx.beginPath();
  ctx.moveTo(0, hd);
  ctx.lineTo(0, 0);
  ctx.lineTo(-hw, 0);
  ctx.stroke();
  const nV = Math.max(2, Math.round(n * 0.6));
  ctx.lineWidth = 1;
  ctx.strokeStyle = col;
  for (let i = 1; i < nV; i++) {
    const y = -hd + (hd * i) / nV;
    ctx.beginPath();
    ctx.moveTo(-hw, y);
    ctx.lineTo(0, y);
    ctx.stroke();
  }
  const nH = Math.max(2, Math.round(n * 0.4));
  for (let i = 1; i < nH; i++) {
    const x = (hw * i) / nH;
    ctx.beginPath();
    ctx.moveTo(x, -hd);
    ctx.lineTo(x, 0);
    ctx.stroke();
  }
  ctx.lineWidth = 1.5;
  arrowPx(ctx, -hw * 0.5, hd * 0.65, -hw * 0.5, -hd * 0.5);
}

function stairUShape(ctx, hw, hd, n) {
  const col = 'rgba(100,80,45,0.72)';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(100,80,45,0.90)';
  ctx.beginPath();
  ctx.moveTo(0, hd);
  ctx.lineTo(0, -hd * 0.65);
  ctx.stroke();
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(-hw, -hd * 0.65);
  ctx.lineTo(hw, -hd * 0.65);
  ctx.stroke();
  ctx.setLineDash([]);
  const nh = Math.max(2, Math.round(n * 0.5));
  ctx.lineWidth = 1;
  ctx.strokeStyle = col;
  for (let i = 1; i < nh; i++) {
    const y = hd - (hd * 1.65 * i) / nh;
    ctx.beginPath();
    ctx.moveTo(-hw, y);
    ctx.lineTo(-0.5, y);
    ctx.stroke();
  }
  for (let i = 1; i < nh; i++) {
    const y = -hd * 0.65 + (hd * 1.65 * i) / nh;
    ctx.beginPath();
    ctx.moveTo(0.5, y);
    ctx.lineTo(hw, y);
    ctx.stroke();
  }
  ctx.lineWidth = 1.5;
  arrowPx(ctx, -hw * 0.5, hd * 0.65, -hw * 0.5, -hd * 0.35);
}

function stairWinding(ctx, hw, hd) {
  const col = 'rgba(100,80,45,0.72)';
  const fanX = -hw;
  const fanY = hd;
  const fanR = Math.min(hw * 1.5, hd * 1.1);
  const nFan = 6;
  ctx.lineWidth = 1;
  ctx.strokeStyle = col;
  for (let i = 0; i <= nFan; i++) {
    const ang = (Math.PI * 0.07) + (Math.PI * 0.43 * i) / nFan;
    ctx.beginPath();
    ctx.moveTo(fanX, fanY);
    ctx.lineTo(fanX + fanR * Math.cos(ang), fanY - fanR * Math.sin(ang));
    ctx.stroke();
  }
  for (const r of [fanR * 0.55, fanR * 0.88]) {
    ctx.beginPath();
    ctx.arc(fanX, fanY, r, -Math.PI * 0.5, -Math.PI * 0.07);
    ctx.stroke();
  }
  const nSt = 4;
  for (let i = 1; i <= nSt; i++) {
    const y = -hd + (hd * 1.0 * i) / nSt;
    if (y + hd < fanR * 0.9) {
      ctx.beginPath();
      ctx.moveTo(-hw * 0.3, y);
      ctx.lineTo(hw, y);
      ctx.stroke();
    }
  }
  ctx.lineWidth = 1.5;
  arrowPx(ctx, hw * 0.3, hd * 0.6, hw * 0.3, -hd * 0.6);
}

function stairSpiral(ctx, hw, hd) {
  const col = 'rgba(100,80,45,0.72)';
  const r = Math.min(hw, hd) * 0.9;
  const rc = r * 0.22;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(100,80,45,0.90)';
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(190,165,120,0.5)';
  ctx.beginPath();
  ctx.arc(0, 0, rc, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(100,80,45,0.90)';
  ctx.beginPath();
  ctx.arc(0, 0, rc, 0, Math.PI * 2);
  ctx.stroke();
  const nRad = 8;
  ctx.lineWidth = 1;
  ctx.strokeStyle = col;
  for (let i = 0; i < nRad; i++) {
    const ang = (Math.PI * 2 * i) / nRad;
    ctx.beginPath();
    ctx.moveTo(rc * Math.cos(ang), rc * Math.sin(ang));
    ctx.lineTo(r * Math.cos(ang), r * Math.sin(ang));
    ctx.stroke();
  }
  ctx.lineWidth = 1.5;
  arrowPx(ctx, 0, r * 0.7, 0, -r * 0.7);
}

/**
 * 階段シンボルを canvas に描画する。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} stair
 * @param {number} centerX 画面座標 X
 * @param {number} centerY 画面座標 Y
 * @param {number} scale px/mm
 * @param {{ isRef?: boolean, fromLowerFloor?: string, showLabel?: boolean }} [opts]
 */
export function drawStair2d(ctx, stair, centerX, centerY, scale, opts = {}) {
  const isRef = opts.isRef || false;
  const hw = stair.widthMM * scale / 2;
  const hd = stair.depthMM * scale / 2;
  const n = Math.max(3, Math.min(15, Math.round(stair.depthMM / 250)));

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate((stair.rotationDeg || 0) * Math.PI / 180);

  ctx.beginPath();
  ctx.rect(-hw, -hd, hw * 2, hd * 2);
  ctx.fillStyle = isRef ? 'rgba(170,160,140,0.12)' : 'rgba(218,195,148,0.40)';
  ctx.fill();
  ctx.lineWidth = isRef ? 1 : 1.5;
  ctx.strokeStyle = isRef ? 'rgba(130,120,100,0.35)' : 'rgba(100,80,45,0.9)';
  ctx.stroke();

  if (!isRef) {
    switch (stair.type) {
      case 'straight': stairStraight(ctx, hw, hd, n); break;
      case 'l_shape': stairLShape(ctx, hw, hd, n); break;
      case 'u_shape': stairUShape(ctx, hw, hd, n); break;
      case 'winding': stairWinding(ctx, hw, hd); break;
      case 'spiral': stairSpiral(ctx, hw, hd); break;
      default: stairStraight(ctx, hw, hd, n); break;
    }
    if (opts.showLabel !== false && scale * stair.widthMM > 50) {
      const def = getStairType(stair.type);
      ctx.fillStyle = 'rgba(70,50,25,0.85)';
      ctx.font = `${Math.max(8, Math.min(11, hw * 0.32))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const prefix = opts.fromLowerFloor ? `${opts.fromLowerFloor}↑ ` : '';
      ctx.fillText(prefix + def.name, 0, hd - 2);
    }
  }

  ctx.restore();
}
