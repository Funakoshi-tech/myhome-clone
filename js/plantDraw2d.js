// plantDraw2d.js — 植栽（3D 素材が無いので手描き）の 2D 平面図アイコン
//
// 家具のローカル座標で、占有範囲（幅 hw*2 × 奥行 hd*2 px）いっぱいに上から見た形を描く。
// 葉の色は家具の色（f.color）を使うので、プロパティの「色」で変えられる。

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} kind catalog の procedural（'plant:tree' など）の ':' 以降
 * @param {{x:number,y:number}} sc 家具中心のスクリーン座標
 * @param {{id?:string, rotationDeg?:number, flipLR?:boolean, flipUD?:boolean, color?:string}} f
 * @param {number} hw 幅の半分（px）
 * @param {number} hd 奥行の半分（px）
 */
export function drawPlant2d(ctx, kind, sc, f, hw, hd) {
  const leaf = f.color || '#5a8f3c';
  ctx.save();
  ctx.translate(sc.x, sc.y);
  ctx.rotate(((f.rotationDeg || 0) * Math.PI) / 180);
  ctx.scale(f.flipLR ? -1 : 1, f.flipUD ? -1 : 1);
  ctx.lineJoin = 'round';
  const lw = Math.max(1, Math.min(hw, hd) * 0.04);

  if (kind === 'tree') {
    bumpyEllipse(ctx, hw, hd, 11);
    fillStroke(ctx, alpha(leaf, 0.55), shade(leaf, -0.35), lw);
    bumpyEllipse(ctx, hw * 0.62, hd * 0.62, 8);
    fillStroke(ctx, alpha(shade(leaf, 0.15), 0.6), null);
    trunkDot(ctx, hw, hd);
  } else if (kind === 'conifer') {
    // 上から見た針葉樹：中心から放射状のとがった輪郭
    starPath(ctx, hw, hd, 14, 0.72);
    fillStroke(ctx, alpha(leaf, 0.75), shade(leaf, -0.4), lw);
    starPath(ctx, hw * 0.55, hd * 0.55, 10, 0.6);
    fillStroke(ctx, alpha(shade(leaf, 0.12), 0.8), null);
    trunkDot(ctx, hw, hd);
  } else if (kind === 'shrub') {
    bumpyEllipse(ctx, hw, hd, 8);
    fillStroke(ctx, alpha(leaf, 0.7), shade(leaf, -0.35), lw);
    bumpyEllipse(ctx, hw * 0.5, hd * 0.5, 6);
    fillStroke(ctx, alpha(shade(leaf, 0.18), 0.7), null);
  } else if (kind === 'hedge') {
    bumpyRect(ctx, hw, hd);
    fillStroke(ctx, alpha(leaf, 0.75), shade(leaf, -0.35), lw);
    // 刈り込みの筋
    ctx.strokeStyle = alpha(shade(leaf, 0.2), 0.7);
    ctx.lineWidth = Math.max(1, lw * 0.8);
    ctx.beginPath();
    if (hw >= hd) { ctx.moveTo(-hw * 0.85, 0); ctx.lineTo(hw * 0.85, 0); } else { ctx.moveTo(0, -hd * 0.85); ctx.lineTo(0, hd * 0.85); }
    ctx.stroke();
  } else if (kind === 'lawn') {
    ctx.beginPath();
    ctx.rect(-hw, -hd, hw * 2, hd * 2);
    fillStroke(ctx, alpha(leaf, 0.35), alpha(shade(leaf, -0.3), 0.8), 1);
    // 芝の印（短い縦線を散らす）
    ctx.strokeStyle = alpha(shade(leaf, -0.25), 0.7);
    ctx.lineWidth = 1;
    const step = Math.max(8, Math.min(hw, hd) / 3);
    ctx.beginPath();
    for (let y = -hd + step / 2; y < hd; y += step) {
      for (let x = -hw + step / 2; x < hw; x += step) {
        const ox = (Math.round((y + hd) / step) % 2) * step / 2;
        const px = x + ox;
        if (px > hw - 3) continue;
        ctx.moveTo(px - 2, y + 2); ctx.lineTo(px, y - 2); ctx.lineTo(px + 2, y + 2);
      }
    }
    ctx.stroke();
  } else if (kind === 'flowerbed') {
    ctx.beginPath();
    ctx.rect(-hw, -hd, hw * 2, hd * 2);
    fillStroke(ctx, '#8b6b4a', '#5b4430', Math.max(1.5, lw * 1.5));
    const inset = Math.max(2, Math.min(hw, hd) * 0.12);
    ctx.beginPath();
    ctx.rect(-hw + inset, -hd + inset, (hw - inset) * 2, (hd - inset) * 2);
    ctx.fillStyle = alpha(leaf, 0.55);
    ctx.fill();
    // 花（決まった並びで散らす）
    const rnd = seeded(f.id || 'bed');
    const colors = ['#e74c3c', '#f1c40f', '#ffffff', '#e67e22', '#c0392b', '#f5b7d1'];
    const r = Math.max(1.5, Math.min(hw, hd) * 0.09);
    const n = Math.max(6, Math.min(60, Math.round((hw * hd) / (r * r * 6))));
    for (let i = 0; i < n; i++) {
      const x = (-hw + inset + r) + rnd() * Math.max(0, (hw - inset - r) * 2);
      const y = (-hd + inset + r) + rnd() * Math.max(0, (hd - inset - r) * 2);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
    }
  }
  ctx.restore();
}

function fillStroke(ctx, fill, stroke, lw = 1) {
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

function trunkDot(ctx, hw, hd) {
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(1.5, Math.min(hw, hd) * 0.07), 0, Math.PI * 2);
  ctx.fillStyle = '#6e4b2a';
  ctx.fill();
}

/** もこもこした楕円（樹冠） */
function bumpyEllipse(ctx, rx, ry, n) {
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.cos(a) * rx * 0.9, y = Math.sin(a) * ry * 0.9;
    if (i === 0) { ctx.moveTo(x, y); continue; }
    const m = a - Math.PI / n;
    ctx.quadraticCurveTo(Math.cos(m) * rx * 1.12, Math.sin(m) * ry * 1.12, x, y);
  }
  ctx.closePath();
}

/** とがった放射状の輪郭（針葉樹） */
function starPath(ctx, rx, ry, n, inner) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const k = i % 2 === 0 ? 1 : inner;
    const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** もこもこした長方形（生垣） */
function bumpyRect(ctx, hw, hd) {
  const along = hw >= hd;
  const len = along ? hw : hd;
  const thick = along ? hd : hw;
  const n = Math.max(2, Math.round(len / Math.max(thick, 1)));
  const seg = (len * 2) / n;
  const bump = thick * 0.25;
  const P = (u, v) => (along ? [u, v] : [v, u]);
  ctx.beginPath();
  ctx.moveTo(...P(-len, -thick * 0.85));
  for (let i = 0; i < n; i++) {
    const u0 = -len + seg * i;
    ctx.quadraticCurveTo(...P(u0 + seg / 2, -thick - bump * 0.4), ...P(u0 + seg, -thick * 0.85));
  }
  ctx.quadraticCurveTo(...P(len + bump, 0), ...P(len, thick * 0.85));
  for (let i = n - 1; i >= 0; i--) {
    const u0 = -len + seg * i;
    ctx.quadraticCurveTo(...P(u0 + seg / 2, thick + bump * 0.4), ...P(u0, thick * 0.85));
  }
  ctx.quadraticCurveTo(...P(-len - bump, 0), ...P(-len, -thick * 0.85));
  ctx.closePath();
}

function parseHex(hex) {
  const h = String(hex || '#5a8f3c').replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function alpha(hex, a) {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** amount > 0 で明るく、< 0 で暗く */
function shade(hex, amount) {
  const [r, g, b] = parseHex(hex);
  const f = (c) => Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  return `#${[f(r), f(g), f(b)].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`;
}

/** id から決まる疑似乱数（再描画しても花の位置が変わらない） */
export function seeded(key) {
  let h = 2166136261;
  for (const ch of String(key)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
