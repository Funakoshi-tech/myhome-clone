// openingModel.js
// 建具の壁スナップ・軸計算（純関数。2D/3D 共通ロジックの核）

import * as M from './model.js';

/** 建具が参照する壁（wallId / wallEdgeKey で解決） */
export function openingWallFor(floor, op) {
  if (!op) return null;
  let wall = floor.walls.find((w) => w.id === op.wallId);
  if (wall && !M.isWallEdgeRemoved(floor, wall)) return wall;
  if (op.wallEdgeKey) {
    wall = floor.walls.find((w) => M.wallEdgeKeyFromWall(w) === op.wallEdgeKey);
    if (wall && !M.isWallEdgeRemoved(floor, wall)) return wall;
  }
  return null;
}

/** 壁ローカル座標系（ux/nx, 開口端 oStart/oEnd, 半厚 halfT） */
export function openingWallAxes(wall, opening) {
  const ax = wall.start.x, az = wall.start.z;
  const dx = wall.end.x - ax, dz = wall.end.z - az;
  const lenMM = Math.hypot(dx, dz);
  if (lenMM < 1) return null;
  const ux = dx / lenMM, uz = dz / lenMM;
  const nx = -uz, nz = ux;
  const halfT = M.wallThicknessMM(wall) / 2;
  const oStart = opening.offsetMM - opening.widthMM / 2;
  const oEnd = opening.offsetMM + opening.widthMM / 2;
  return { ax, az, ux, uz, nx, nz, halfT, oStart, oEnd, lenMM };
}

/**
 * 建具を壁にスナップ（wallId / offsetMM / wallEdgeKey を更新）
 * @returns {boolean} 壁が変わったか
 */
export function applyOpeningToWall(op, wall, w, snapDivisions, opts = {}) {
  const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
  const lenMM = Math.hypot(dx, dz);
  if (lenMM < 1) return false;
  const ux = dx / lenMM, uz = dz / lenMM;
  const halfW = op.widthMM / 2;
  let offsetMM = opts.offsetMM;
  if (offsetMM == null) {
    offsetMM = M.snap((w.x - wall.start.x) * ux + (w.z - wall.start.z) * uz, snapDivisions);
  }
  offsetMM = Math.max(halfW, Math.min(lenMM - halfW, offsetMM));
  const wallChanged = op.wallId !== wall.id;
  op.wallId = wall.id;
  op.wallEdgeKey = M.wallEdgeKeyFromWall(wall);
  op.offsetMM = offsetMM;
  if (wallChanged && w && op.type !== 'door' && op.type !== 'maguchi') {
    const nx = -uz, nz = ux;
    const onWall = { x: wall.start.x + ux * offsetMM, z: wall.start.z + uz * offsetMM };
    const side = nx * (w.x - onWall.x) + nz * (w.z - onWall.z);
    op.wallFaceSign = side > 0 ? 1 : -1;
  }
  return wallChanged;
}
