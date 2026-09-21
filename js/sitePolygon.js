// sitePolygon.js — 敷地（site.boundary）用の純粋幾何ヘルパー（DOM/Three.js 非依存）
// boundary は [{ x, z }, ...]（mm、閉じた多角形。始点を末尾に重ねない）。
// 編集関数はいずれも新しい配列を返し、引数を破壊しない。

import { polygonAreaM2, tsuboCount } from './model.js';

/** 敷地作図の座標スナップ（mm）。下絵のなぞり書き向けにグリッドより細かく */
export const SITE_SNAP_MM = 10;
/** 辺の長さの下限（mm） */
export const MIN_SITE_EDGE_MM = 100;
/** 頂点として最低限必要な数 */
export const MIN_SITE_VERTICES = 3;

const clonePt = (p) => ({ x: p.x, z: p.z });

export function cloneBoundary(poly) {
  return (poly || []).map(clonePt);
}

/** 3 頂点以上で面を成しているか */
export function isValidSite(poly) {
  return Array.isArray(poly) && poly.length >= MIN_SITE_VERTICES;
}

export function snapToMM(pt, unit = SITE_SNAP_MM) {
  return { x: Math.round(pt.x / unit) * unit, z: Math.round(pt.z / unit) * unit };
}

/**
 * from → to の向きを stepDeg 刻み（既定 45°）に丸め、to をその向きの直線へ射影した点を返す。
 * 水平・垂直に揃えたときカーソルの X/Z がずれないよう、長さ保持ではなく射影にしている。
 */
export function constrainAngle(from, to, stepDeg = 45, unit = SITE_SNAP_MM) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 1e-6) return clonePt(to);
  const step = (stepDeg * Math.PI) / 180;
  const ang = Math.round(Math.atan2(dz, dx) / step) * step;
  const c = Math.cos(ang), s = Math.sin(ang);
  const len = dx * c + dz * s;
  return snapToMM({ x: from.x + c * len, z: from.z + s * len }, unit);
}

/** 辺 i（頂点 i → i+1）の長さ（mm） */
export function edgeLengthMM(poly, i) {
  const a = poly[i];
  const b = poly[(i + 1) % poly.length];
  return Math.hypot(b.x - a.x, b.z - a.z);
}

export function edgeLengths(poly) {
  return poly.map((_, i) => edgeLengthMM(poly, i));
}

/** 周長（m） */
export function perimeterM(poly) {
  return edgeLengths(poly).reduce((s, l) => s + l, 0) / 1000;
}

/** 符号付き面積（shoelace, mm²）。向き判定用 */
function signedArea2(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.z - q.x * p.z;
  }
  return s;
}

/** 頂点 i の内角（度）。凹角は 180° 超 */
export function interiorAngleDeg(poly, i) {
  const n = poly.length;
  const prev = poly[(i - 1 + n) % n];
  const cur = poly[i];
  const next = poly[(i + 1) % n];
  const ax = prev.x - cur.x, az = prev.z - cur.z;
  const bx = next.x - cur.x, bz = next.z - cur.z;
  const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb)));
  const theta = (Math.acos(cos) * 180) / Math.PI;
  // 進行方向の外積が多角形の向きと逆なら凹角
  const turn = (cur.x - prev.x) * (next.z - cur.z) - (cur.z - prev.z) * (next.x - cur.x);
  const orient = Math.sign(signedArea2(poly)) || 1;
  return turn * orient < 0 ? 360 - theta : theta;
}

/**
 * 辺 i の長さを lenMM にする。終点（頂点 i+1）を辺の向きに沿って動かす。
 * 隣の辺（i+1）の長さ・向きはその分変わる。
 */
export function setEdgeLength(poly, i, lenMM) {
  const n = poly.length;
  const a = poly[i];
  const j = (i + 1) % n;
  const b = poly[j];
  const dx = b.x - a.x, dz = b.z - a.z;
  const cur = Math.hypot(dx, dz);
  const len = Math.max(MIN_SITE_EDGE_MM, lenMM);
  const out = cloneBoundary(poly);
  if (cur < 1e-9) {
    // 長さ 0 の辺は向きが定まらないので +X 方向へ伸ばす
    out[j] = { x: a.x + len, z: a.z };
    return out;
  }
  out[j] = { x: Math.round(a.x + (dx / cur) * len), z: Math.round(a.z + (dz / cur) * len) };
  return out;
}

/** 辺 i 上に頂点を挿入する（挿入点は辺へ射影し 1mm に丸める。10mm 丸めだと辺が折れて内角が 180° を外れる） */
export function insertVertex(poly, i, pt) {
  const a = poly[i];
  const b = poly[(i + 1) % poly.length];
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 < 1e-9 ? 0.5 : Math.max(0.05, Math.min(0.95, ((pt.x - a.x) * dx + (pt.z - a.z) * dz) / len2));
  const np = snapToMM({ x: a.x + dx * t, z: a.z + dz * t }, 1);
  const out = cloneBoundary(poly);
  out.splice(i + 1, 0, np);
  return out;
}

/** 頂点を削除する。3 頂点未満になる場合は変更せずコピーを返す */
export function removeVertex(poly, i) {
  const out = cloneBoundary(poly);
  if (out.length <= MIN_SITE_VERTICES) return out;
  out.splice(i, 1);
  return out;
}

function segmentsCross(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.z - p3.z) - (p2.z - p1.z) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((p3.x - p1.x) * (p4.z - p3.z) - (p3.z - p1.z) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.z - p1.z) - (p3.z - p1.z) * (p2.x - p1.x)) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

/** 辺同士が交差している（8 の字などの）多角形か */
export function hasSelfIntersection(poly) {
  const n = poly.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // 隣接辺
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** 「128.32㎡（38.8坪）」形式（敷地面積は坪表記が一般的なため畳ではなく坪） */
export function siteAreaLabel(poly) {
  const m2 = polygonAreaM2(poly);
  return `${m2.toFixed(2)}㎡（${tsuboCount(m2).toFixed(1)}坪）`;
}
