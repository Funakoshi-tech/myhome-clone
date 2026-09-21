// geometry2d.js
// 2D キャンバス用の純粋幾何ヘルパー（editor2d から分離）

/** 画面上の点 (px,py) から線分 sa-sb への最短距離（px） */
export function ptSegDistScreen(px, py, sa, sb) {
  const wx = sb.x - sa.x, wy = sb.y - sa.y;
  const len2 = wx * wx + wy * wy;
  if (len2 < 1) return Math.hypot(px - sa.x, py - sa.y);
  let t = ((px - sa.x) * wx + (py - sa.y) * wy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (sa.x + wx * t), py - (sa.y + wy * t));
}

export function pointInPolygonScreen(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

export function pointInTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const p = { x: px, y: py };
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

export function segIntersectsRect(ax, ay, bx, by, rx0, ry0, rx1, ry1) {
  const left = Math.min(rx0, rx1), right = Math.max(rx0, rx1);
  const top = Math.min(ry0, ry1), bottom = Math.max(ry0, ry1);
  const inRect = (x, y) => x >= left && x <= right && y >= top && y <= bottom;
  if (inRect(ax, ay) || inRect(bx, by)) return true;
  const edges = [
    [left, top, right, top],
    [right, top, right, bottom],
    [right, bottom, left, bottom],
    [left, bottom, left, top],
  ];
  const cross = (x1, y1, x2, y2, x3, y3, x4, y4) => {
    const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
    const u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };
  for (const [x1, y1, x2, y2] of edges) {
    if (cross(ax, ay, bx, by, x1, y1, x2, y2)) return true;
  }
  return false;
}
