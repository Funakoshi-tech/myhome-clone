// 下絵の回転と方位（真北）の純粋幾何。DOM・three.js に依存しない（tests/siteOrientation.test.mjs）。
//
// 座標規約（2D 図面）: X=右, Z=下。角度はすべて「画面上で時計回り」が正。
// site.azimuth = 図面の上方向から真北までの時計回りの角度（viewer3d の root.rotation.y と同じ値）。
// 例: azimuth=30 なら、2D 図面では真上から右へ 30° 傾いた方向が北。

/** 角度を [0, 360) に正規化 */
export function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/** 点 p を pivot まわりに deg（時計回り）回転 */
export function rotatePointAbout(p, pivot, deg) {
  const r = deg * Math.PI / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - pivot.x;
  const dz = p.z - pivot.z;
  return { x: pivot.x + dx * cos - dz * sin, z: pivot.z + dx * sin + dz * cos };
}

/**
 * a→b の線を水平または垂直（近いほう）にするための回転角（時計回り、-45〜45°）。
 * 2 点が近すぎるときは null。
 */
export function straightenDeltaDeg(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 1e-6) return null;
  const ang = Math.atan2(dz, dx) * 180 / Math.PI;
  const delta = Math.round(ang / 90) * 90 - ang;
  return Object.is(delta, -0) ? 0 : delta;
}

/** 下絵上の方位記号を 根元 a → 先端 b でなぞったときの site.azimuth。2 点が近すぎるときは null */
export function azimuthFromNorthLine(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 1e-6) return null;
  return normalizeDeg(Math.atan2(dx, -dz) * 180 / Math.PI);
}

/**
 * 敷地まわり（下絵・敷地境界・方位）を pivot まわりに deltaDeg 回転する（site を直接書き換える）。
 * 下絵に写っている北も一緒に回るので、azimuth も同じだけ回して真北の向きを保つ。
 * 下絵は「中心まわりの回転 + offset」で表しているので、pivot が動かないよう offset を補正する。
 */
export function rotateSiteAbout(site, pivot, deltaDeg) {
  if (!site || !deltaDeg) return;
  const bg = site.backgroundImage;
  if (bg && bg.scaleMMperPx > 0) {
    const wMM = bg.naturalWidthPx * bg.scaleMMperPx;
    const hMM = bg.naturalHeightPx * bg.scaleMMperPx;
    const c = { x: (bg.offsetX ?? 0) + wMM / 2, z: (bg.offsetZ ?? 0) + hMM / 2 };
    const c2 = rotatePointAbout(c, pivot, deltaDeg);
    bg.offsetX = c2.x - wMM / 2;
    bg.offsetZ = c2.z - hMM / 2;
    bg.rotationDeg = normalizeDeg((bg.rotationDeg || 0) + deltaDeg);
  }
  if (Array.isArray(site.boundary)) {
    site.boundary = site.boundary.map((p) => rotatePointAbout(p, pivot, deltaDeg));
  }
  site.azimuth = normalizeDeg((site.azimuth || 0) + deltaDeg);
}

/** 下絵の中心（世界座標 mm）。未スケールなら null */
export function backgroundCenter(bg) {
  if (!bg || !(bg.scaleMMperPx > 0)) return null;
  return {
    x: (bg.offsetX ?? 0) + (bg.naturalWidthPx * bg.scaleMMperPx) / 2,
    z: (bg.offsetZ ?? 0) + (bg.naturalHeightPx * bg.scaleMMperPx) / 2,
  };
}

/** 方位角を「北は上から右へ 30°」のような短い表示にする */
export function azimuthLabel(azimuth) {
  const a = Math.round(normalizeDeg(azimuth || 0) * 10) / 10 % 360;
  if (a === 0) return '真上が北';
  return a <= 180 ? `北は上から右へ ${a}°` : `北は上から左へ ${Math.round((360 - a) * 10) / 10}°`;
}
