// stairDraw2d.js — 2D 階段シンボル描画（エディタ・サムネイル共通）

import { getStairType, straightStairStepCount, stairCanMirror } from './catalog.js';
import { stairOutlineLocal } from './model.js';

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

/** 直進: 段（約 182mm ごと）と、登り口の点から上端の矢印まで通した線 */
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
  ctx.lineWidth = 1.5;
  arrowPx(ctx, 0, hd, 0, -hd);
  ctx.beginPath();
  ctx.arc(0, hd, 2.5, 0, Math.PI * 2);
  ctx.fill(); // arrowPx が塗りの色を設定済み
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

/**
 * L字（回り段）: +Z（下）から直進し、最上部の正方形（一辺 s = 短辺）を回り段 3 段で右へ曲がって +X 辺の上端から抜ける。
 * 左に曲がる形（stair.mirror）は呼び出し側で左右反転して描く。
 */
function stairLWinder(ctx, hw, hd, n) {
  const col = 'rgba(100,80,45,0.72)';
  const s = Math.min(hw * 2, hd * 2);
  const yW = -hd + s; // 直進部と回り段の境
  ctx.lineWidth = 1;
  ctx.strokeStyle = col;
  const k = Math.max(1, Math.round(n * (hd - yW) / (hd * 2)));
  for (let i = 0; i < k; i++) {
    const y = yW + ((hd - yW) * i) / k;
    ctx.beginPath();
    ctx.moveTo(-hw, y);
    ctx.lineTo(hw, y);
    ctx.stroke();
  }
  // 回り段：内側の角（+X 辺の回り段の下端）から、左辺の中ほどと上辺の中ほどへ
  ctx.beginPath();
  ctx.moveTo(-hw, -hd + s / 2);
  ctx.lineTo(hw, yW);
  ctx.lineTo(0, -hd);
  ctx.stroke();
  // 上り方向：中央を上がり、回り段で右へ
  const turnY = -hd + s * 0.45;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(60,40,20,0.85)';
  ctx.beginPath();
  ctx.moveTo(0, hd * 0.9);
  ctx.lineTo(0, turnY);
  ctx.stroke();
  arrowPx(ctx, 0, turnY, hw * 0.9, turnY);
  ctx.fillStyle = 'rgba(60,40,20,0.85)';
  ctx.beginPath();
  ctx.arc(0, hd * 0.9, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * L字（下で回る）: +X 辺の下端から入り、最下部の正方形（一辺 s = 短辺）を回り段 3 段で曲がって、
 * 上（−Z）へ直進して上の辺から抜ける。左から入る形（stair.mirror）は呼び出し側で左右反転して描く。
 */
function stairLWinderBottom(ctx, hw, hd, n) {
  const col = 'rgba(100,80,45,0.72)';
  const s = Math.min(hw * 2, hd * 2);
  const yW = hd - s; // 直進部と回り段の境
  ctx.lineWidth = 1;
  ctx.strokeStyle = col;
  const k = Math.max(1, Math.round(n * (yW + hd) / (hd * 2)));
  for (let i = 1; i <= k; i++) {
    const y = -hd + ((yW + hd) * i) / k;
    ctx.beginPath();
    ctx.moveTo(-hw, y);
    ctx.lineTo(hw, y);
    ctx.stroke();
  }
  // 回り段：内側の角（+X 辺の回り段の上端）から、左辺の中ほどと下辺の中ほどへ
  ctx.beginPath();
  ctx.moveTo(-hw, hd - s / 2);
  ctx.lineTo(hw, yW);
  ctx.lineTo(0, hd);
  ctx.stroke();
  // 上り方向：+X 辺の登り口から入り、中央で曲がって上へ
  const turnY = hd - s * 0.45;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(60,40,20,0.85)';
  ctx.beginPath();
  ctx.moveTo(hw * 0.9, turnY);
  ctx.lineTo(0, turnY);
  ctx.stroke();
  arrowPx(ctx, 0, turnY, 0, -hd);
  ctx.beginPath();
  ctx.arc(hw * 0.9, turnY, 2.5, 0, Math.PI * 2);
  ctx.fill(); // arrowPx が塗りの色を設定済み
}

/**
 * コの字（上下で回る）: +X 辺の下端から入り、最下部の回り段 3 段 → 直進 → 最上部の回り段 3 段で折り返して、
 * +X 辺の上端から抜ける。−X 辺から出入りする形（stair.mirror）は呼び出し側で左右反転して描く。
 */
function stairUWinder(ctx, hw, hd, nStraight) {
  const col = 'rgba(100,80,45,0.72)';
  const s = Math.min(hw * 2, hd); // 回り段の正方形の一辺
  const yB = hd - s; // 下の回り段と直進部の境
  const yT = -hd + s; // 直進部と上の回り段の境
  ctx.lineWidth = 1;
  ctx.strokeStyle = col;
  for (let i = 0; i <= nStraight; i++) {
    const y = yT + ((yB - yT) * i) / nStraight;
    ctx.beginPath();
    ctx.moveTo(-hw, y);
    ctx.lineTo(hw, y);
    ctx.stroke();
  }
  // 回り段：内側の角（出入り口の辺の、直進部との境）から、左辺の中ほどと上下の辺の中ほどへ
  for (const [py, sideY, endY] of [[yB, hd - s / 2, hd], [yT, -hd + s / 2, -hd]]) {
    ctx.beginPath();
    ctx.moveTo(-hw, sideY);
    ctx.lineTo(hw, py);
    ctx.lineTo(0, endY);
    ctx.stroke();
  }
  // 上り方向：登り口から中央へ入り、上へ進んで、出口へ
  const entryY = hd - s / 2;
  const exitY = -hd + s / 2;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(60,40,20,0.85)';
  ctx.beginPath();
  ctx.moveTo(hw * 0.9, entryY);
  ctx.lineTo(0, entryY);
  ctx.lineTo(0, exitY);
  ctx.stroke();
  arrowPx(ctx, 0, exitY, hw * 0.9, exitY);
  ctx.beginPath();
  ctx.arc(hw * 0.9, entryY, 2.5, 0, Math.PI * 2);
  ctx.fill(); // arrowPx が塗りの色を設定済み
}

/**
 * コの字（中央が空く）: +X 辺の下端から −X へ直進し、回り段 3 段で曲がって上へ直進、回り段 3 段で曲がって +X 辺の上端へ抜ける。
 * +X 側の中ほど（幅 1/2 × 奥行 1/3）は階段ではなく、3 方を壁で囲う。−X 辺から出入りする形（stair.mirror）は呼び出し側で左右反転して描く。
 */
function stairUOpen(ctx, hw, hd, nRun, nMid, wallPx) {
  const col = 'rgba(100,80,45,0.72)';
  const yB = hd / 3; // 下の帯と中央の境
  const yT = -hd / 3; // 中央と上の帯の境
  ctx.lineWidth = 1;
  ctx.strokeStyle = col;
  const line = (x1, y1, x2, y2) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  for (let i = 0; i <= nRun; i++) {
    const x = (hw * i) / nRun;
    line(x, yB, x, hd);
    line(x, -hd, x, yT);
  }
  for (let i = 0; i <= nMid; i++) {
    const y = yT + ((yB - yT) * i) / nMid;
    line(-hw, y, 0, y);
  }
  // 回り段：内側の角から、外側の辺の中ほどと上下の辺の中ほどへ
  line(0, yB, -hw, hd * 2 / 3);
  line(0, yB, -hw / 2, hd);
  line(0, yT, -hw, -hd * 2 / 3);
  line(0, yT, -hw / 2, -hd);
  // 空いている所を囲う壁（外形の内側に立てた 3D の囲い壁と同じ位置）
  ctx.strokeStyle = '#4a5260';
  ctx.lineWidth = wallPx;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(hw, yT + wallPx / 2);
  ctx.lineTo(wallPx / 2, yT + wallPx / 2);
  ctx.lineTo(wallPx / 2, yB - wallPx / 2);
  ctx.lineTo(hw, yB - wallPx / 2);
  ctx.stroke();
  // 上り方向：下の帯を −X へ、中央を上へ、上の帯を +X へ
  const entryY = hd * 2 / 3;
  const exitY = -hd * 2 / 3;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(60,40,20,0.85)';
  ctx.beginPath();
  ctx.moveTo(hw * 0.95, entryY);
  ctx.lineTo(-hw / 2, entryY);
  ctx.lineTo(-hw / 2, exitY);
  ctx.stroke();
  arrowPx(ctx, -hw / 2, exitY, hw * 0.95, exitY);
  ctx.beginPath();
  ctx.arc(hw * 0.95, entryY, 2.5, 0, Math.PI * 2);
  ctx.fill(); // arrowPx が塗りの色を設定済み
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
  stairOutlineLocal(stair).forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x * scale, p.z * scale);
    else ctx.lineTo(p.x * scale, p.z * scale);
  });
  ctx.closePath();
  ctx.fillStyle = isRef ? 'rgba(170,160,140,0.12)' : 'rgba(218,195,148,0.40)';
  ctx.fill();
  ctx.lineWidth = isRef ? 1 : 1.5;
  ctx.strokeStyle = isRef ? 'rgba(130,120,100,0.35)' : 'rgba(100,80,45,0.9)';
  ctx.stroke();

  if (!isRef) {
    ctx.save();
    if (stairCanMirror(stair.type) && stair.mirror) ctx.scale(-1, 1); // 左に曲がる形・右側から登る形
    switch (stair.type) {
      case 'straight': stairStraight(ctx, hw, hd, straightStairStepCount(stair.depthMM)); break;
      case 'l_shape': stairLShape(ctx, hw, hd, n); break;
      case 'l_winder': stairLWinder(ctx, hw, hd, n); break;
      case 'l_winder_bottom': stairLWinderBottom(ctx, hw, hd, straightStairStepCount(stair.depthMM)); break;
      case 'u_shape': stairUShape(ctx, hw, hd, n); break;
      case 'u_winder': stairUWinder(ctx, hw, hd, straightStairStepCount(stair.depthMM - 2 * Math.min(stair.widthMM, stair.depthMM / 2))); break;
      case 'u_open': stairUOpen(ctx, hw, hd, straightStairStepCount(stair.widthMM / 2), straightStairStepCount(stair.depthMM / 3), Math.max(2, 120 * scale)); break;
      default: stairStraight(ctx, hw, hd, straightStairStepCount(stair.depthMM)); break;
    }
    ctx.restore();
    if (opts.showLabel !== false && scale * stair.widthMM > 50) {
      const def = getStairType(stair.type);
      ctx.fillStyle = 'rgba(70,50,25,0.85)';
      ctx.font = `${Math.max(8, Math.min(11, hw * 0.32))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const prefix = opts.fromLowerFloor ? `${opts.fromLowerFloor}↑ ` : '';
      // 直進階段は登り口に「UP」（上の階に出す参考表示は、どの階からの階段か分かるよう名前のまま）
      const isStraight = (stair.type || 'straight') === 'straight';
      if (isStraight && !opts.fromLowerFloor) {
        ctx.font = `${Math.max(9, Math.min(16, hw * 0.45))}px system-ui, sans-serif`;
        ctx.fillText('UP', 0, hd - 6); // 登り口の点に重ならないよう少し上
      } else if (stair.type === 'l_winder_bottom' && !opts.fromLowerFloor) {
        // 登り口（横の辺の下端）の矢印の上に「UP」
        const s = Math.min(hw * 2, hd * 2);
        ctx.font = `${Math.max(9, Math.min(16, hw * 0.4))}px system-ui, sans-serif`;
        ctx.fillText('UP', (stair.mirror ? -1 : 1) * hw * 0.45, hd - s * 0.45 - 3);
      } else if (stair.type === 'u_open' && !opts.fromLowerFloor) {
        // 登り口（横の辺の下端）の矢印の上に「UP」
        ctx.font = `${Math.max(9, Math.min(16, hw * 0.2))}px system-ui, sans-serif`;
        ctx.fillText('UP', (stair.mirror ? -1 : 1) * hw * 0.7, hd * 2 / 3 - 3);
      } else if (stair.type === 'u_winder' && !opts.fromLowerFloor) {
        // 登り口（横の辺の下端）の矢印の上に「UP」
        const s = Math.min(hw * 2, hd);
        ctx.font = `${Math.max(9, Math.min(16, hw * 0.4))}px system-ui, sans-serif`;
        ctx.fillText('UP', (stair.mirror ? -1 : 1) * hw * 0.45, hd - s / 2 - 3);
      } else {
        ctx.fillText(prefix + def.name, 0, hd - 2);
      }
    }
  }

  ctx.restore();
}
