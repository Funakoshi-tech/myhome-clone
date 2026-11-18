// bicycleDraw2d.js — 自転車（3D モデル素材が無いので手描き）の 2D 平面図アイコン
//
// 家具のローカル座標で描く：X = 幅（ハンドル方向）、Z = 全長。前輪は -Z 側（回転 0 で画面の上）。
// 寸法は一般的な 26 インチのシティサイクル（全長 1900・幅 600）を基準にし、家具の w/d に合わせて伸縮する。

export const BICYCLE_BASE = { wMM: 600, dMM: 1900 };

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number}} sc 家具中心のスクリーン座標
 * @param {{rotationDeg?:number, flipLR?:boolean, flipUD?:boolean, color?:string}} f
 * @param {number} hw 幅の半分（px）
 * @param {number} hd 全長の半分（px）
 */
export function drawBicycle2d(ctx, sc, f, hw, hd) {
  const kx = hw / (BICYCLE_BASE.wMM / 2);
  const kz = hd / (BICYCLE_BASE.dMM / 2);
  const X = (mm) => mm * kx;
  const Z = (mm) => mm * kz;
  const lw = (mm) => Math.max(1, mm * Math.min(kx, kz));
  const frame = f.color || '#2e86c1';

  ctx.save();
  ctx.translate(sc.x, sc.y);
  ctx.rotate(((f.rotationDeg || 0) * Math.PI) / 180);
  ctx.scale(f.flipLR ? -1 : 1, f.flipUD ? -1 : 1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 占有範囲（選択・配置の目安）
  ctx.beginPath();
  ctx.rect(-hw, -hd, hw * 2, hd * 2);
  ctx.fillStyle = 'rgba(46,134,193,0.06)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(44,52,68,0.25)';
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  // タイヤ（上から見ると細長い）
  ctx.fillStyle = '#2b2b2b';
  for (const zc of [-620, 620]) {
    roundRect(ctx, -X(25), Z(zc - 330), X(50), Z(660), Math.min(X(25), Z(25)));
    ctx.fill();
  }

  // 後ろの荷台
  ctx.fillStyle = '#9aa3ad';
  roundRect(ctx, -X(85), Z(380), X(170), Z(420), 2);
  ctx.fill();

  // フレーム
  ctx.strokeStyle = frame;
  ctx.lineWidth = lw(45);
  ctx.beginPath();
  ctx.moveTo(0, Z(-540));
  ctx.lineTo(0, Z(620));
  ctx.stroke();

  // サドル
  ctx.fillStyle = '#3a3a3a';
  ctx.beginPath();
  ctx.ellipse(0, Z(370), X(80), Z(130), 0, 0, Math.PI * 2);
  ctx.fill();

  // 前かご
  ctx.strokeStyle = '#7f8c8d';
  ctx.lineWidth = lw(18);
  ctx.strokeRect(-X(170), Z(-920), X(340), Z(300));

  // ハンドル
  ctx.strokeStyle = '#5d6d7e';
  ctx.lineWidth = lw(28);
  ctx.beginPath();
  ctx.moveTo(-X(280), Z(-380));
  ctx.quadraticCurveTo(0, Z(-520), X(280), Z(-380));
  ctx.stroke();
  ctx.strokeStyle = '#2b2b2b';
  ctx.lineWidth = lw(34);
  ctx.beginPath();
  ctx.moveTo(-X(290), Z(-375)); ctx.lineTo(-X(220), Z(-395));
  ctx.moveTo(X(290), Z(-375)); ctx.lineTo(X(220), Z(-395));
  ctx.stroke();

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
