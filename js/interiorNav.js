// interiorNav.js — 内観モードの衝突・ワープ・スナップ（純関数）

import * as M from './model.js';
import { getFurniture } from './catalog.js';

export const EYE_HEIGHT_MM = 1600;
export const PLAYER_RADIUS_MM = 260;
export const WALK_SPEED_MM_S = 2200;
/** ドア・間口の通過判定用：開口幅の両端をこの分だけ広げる */
const OPENING_PASSAGE_PAD_MM = 280;

const PASSABLE_OPENING_TYPES = new Set([
  'door', 'maguchi', 'sliding', 'hikite', 'hikichigai2', 'hikichigai3',
]);
const NO_FLOOR_TYPES = new Set(['fukinuke']);

export function floorHasContent(floor) {
  return !!(floor.rooms?.length || floor.furniture?.length
    || (floor.stairs || []).length || (floor.partitions || []).length);
}

export function floorsWithContent(plan) {
  return plan.floors.filter(floorHasContent);
}

export function isFirstFloor(floor) {
  return (floor.level ?? 0) === 0 || floor.id === '1F';
}

function isPassableOpening(op) {
  return PASSABLE_OPENING_TYPES.has(op.type);
}

function walkableRoomPolygons(floor) {
  return (floor.rooms || []).filter(
    (r) => !NO_FLOOR_TYPES.has(r.type) && r.polygon?.length >= 3,
  );
}

function circleIntersectsSegment(p, radius, a, b, thicknessMM) {
  const d = M.pointToSegmentDist(p, a, b);
  const halfT = (thicknessMM || M.DEFAULT_WALL_THICKNESS_MM) * 0.42;
  return d < radius + halfT;
}

function mergeOpeningGaps(gaps) {
  if (!gaps.length) return gaps;
  const merged = [{ t0: gaps[0].t0, t1: gaps[0].t1 }];
  for (let i = 1; i < gaps.length; i++) {
    const g = gaps[i];
    const last = merged[merged.length - 1];
    if (g.t0 <= last.t1 + 30) last.t1 = Math.max(last.t1, g.t1);
    else merged.push({ t0: g.t0, t1: g.t1 });
  }
  return merged;
}

function splitWallSolidSegments(wall, openings) {
  const ax = wall.start.x, az = wall.start.z;
  const bx = wall.end.x, bz = wall.end.z;
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 1) return [];
  const ux = dx / len, uz = dz / len;
  const gaps = mergeOpeningGaps(
    (openings || [])
      .filter(isPassableOpening)
      .map((op) => ({
        t0: Math.max(0, op.offsetMM - op.widthMM / 2 - OPENING_PASSAGE_PAD_MM),
        t1: Math.min(len, op.offsetMM + op.widthMM / 2 + OPENING_PASSAGE_PAD_MM),
      }))
      .filter((g) => g.t1 > g.t0 + 40)
      .sort((a, b) => a.t0 - b.t0),
  );

  const solids = [];
  let t = 0;
  const minSolid = 60;
  const minJamb = 120;
  for (const g of gaps) {
    if (g.t0 > t + minSolid) {
      const jambLen = g.t0 - t;
      if (jambLen >= minJamb) {
        solids.push({
          start: { x: ax + ux * t, z: az + uz * t },
          end: { x: ax + ux * g.t0, z: az + uz * g.t0 },
          thicknessMM: wall.thicknessMM,
        });
      }
    }
    t = Math.max(t, g.t1);
  }
  if (len > t + minSolid) {
    const tailLen = len - t;
    if (tailLen >= minJamb) {
      solids.push({
        start: { x: ax + ux * t, z: az + uz * t },
        end: { x: ax + ux * len, z: az + uz * len },
        thicknessMM: wall.thicknessMM,
      });
    }
  }
  return solids;
}

export function buildCollisionSegments(floor) {
  const segs = [];
  for (const { wall, ops } of M.wallsToRender(floor)) {
    if (M.isWallEdgeRemoved(floor, wall)) continue;
    segs.push(...splitWallSolidSegments(wall, ops));
  }
  for (const p of floor.partitions || []) {
    const { start, end } = M.partitionEndpoints(p);
    segs.push({ start, end, thicknessMM: p.thicknessMM });
  }
  return segs;
}

export function buildFurnitureObstacles(floor) {
  const obs = [];
  for (const f of floor.furniture || []) {
    const cat = getFurniture(f.catalogId);
    obs.push({
      x: f.x,
      z: f.z,
      wMM: f.wMM || cat?.wMM || 500,
      dMM: f.dMM || cat?.dMM || 500,
      rotationDeg: f.rotationDeg || 0,
      inflate: PLAYER_RADIUS_MM * 0.45,
    });
  }
  return obs;
}

function pointInObstacle(p, ob) {
  const rad = -((ob.rotationDeg || 0) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = p.x - ob.x, dz = p.z - ob.z;
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  const hw = ob.wMM / 2 + (ob.inflate || 0);
  const hd = ob.dMM / 2 + (ob.inflate || 0);
  return Math.abs(lx) <= hw && Math.abs(lz) <= hd;
}

export function collidesAt(p, floor, segments, obstacles) {
  for (const s of segments) {
    if (circleIntersectsSegment(p, PLAYER_RADIUS_MM, s.start, s.end, s.thicknessMM)) return true;
  }
  for (const ob of obstacles) {
    if (pointInObstacle(p, ob)) return true;
  }
  return false;
}

export function isInWalkableArea(p, floor, segments, obstacles) {
  if (collidesAt(p, floor, segments, obstacles)) return false;
  if (isFirstFloor(floor)) return true;
  const rooms = walkableRoomPolygons(floor);
  return rooms.some((room) => M.pointInPolygon(p, room.polygon));
}

export function tryMove(from, to, floor, segments, obstacles) {
  let p = { x: from.x, z: from.z };
  const tryX = { x: to.x, z: p.z };
  if (!collidesAt(tryX, floor, segments, obstacles)) p = tryX;
  const tryZ = { x: p.x, z: to.z };
  if (!collidesAt(tryZ, floor, segments, obstacles)) p = tryZ;
  if (!isInWalkableArea(p, floor, segments, obstacles)) return from;
  return p;
}

function nearestPointInPolygons(p, polygons) {
  for (const poly of polygons) {
    if (M.pointInPolygon(p, poly)) return { x: p.x, z: p.z };
  }
  let best = null;
  let bestD = Infinity;
  for (const poly of polygons) {
    const c = M.polygonCentroid(poly);
    const d = Math.hypot(p.x - c.x, p.z - c.z);
    if (d < bestD) { bestD = d; best = { x: c.x, z: c.z }; }
    for (const v of poly) {
      const dv = Math.hypot(p.x - v.x, p.z - v.z);
      if (dv < bestD) { bestD = dv; best = { x: v.x, z: v.z }; }
    }
  }
  return best;
}

function searchFreeNearby(p, floor, segments, obstacles, allowOutside, polys) {
  for (let r = 150; r <= 4000; r += 150) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
      const cand = { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r };
      if (collidesAt(cand, floor, segments, obstacles)) continue;
      if (!allowOutside && !polys.some((poly) => M.pointInPolygon(cand, poly))) continue;
      return cand;
    }
  }
  return null;
}

export function snapWarpPosition(x, z, floor, segments, obstacles) {
  const allowOutside = isFirstFloor(floor);
  const polys = walkableRoomPolygons(floor).map((r) => r.polygon);
  let p = { x, z };

  if (!allowOutside && polys.length && !polys.some((poly) => M.pointInPolygon(p, poly))) {
    const near = nearestPointInPolygons(p, polys);
    if (near) p = near;
    else return null;
  }

  if (collidesAt(p, floor, segments, obstacles)) {
    const found = searchFreeNearby(p, floor, segments, obstacles, allowOutside, polys);
    if (!found) return null;
    p = found;
  }

  if (!allowOutside && polys.length && !polys.some((poly) => M.pointInPolygon(p, poly))) {
    const near = nearestPointInPolygons(p, polys);
    if (!near || collidesAt(near, floor, segments, obstacles)) return null;
    p = near;
  }

  return p;
}

const ENTRY_NEIGHBOR_TYPES = new Set(['porch', 'doma', 'garage']);

function pointsNear(a, b, eps = 2) {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.z - b.z) < eps;
}

function wallMatchesEdge(wall, a, b) {
  return (pointsNear(wall.start, a) && pointsNear(wall.end, b))
    || (pointsNear(wall.start, b) && pointsNear(wall.end, a));
}

function wallOnRoomEdge(floor, roomId, a, b) {
  return (floor.walls || []).find(
    (w) => M.inferWallRoomId(w) === roomId && wallMatchesEdge(w, a, b),
  );
}

function neighborRoomAcrossEdge(floor, room, a, b) {
  const key = M.wallEdgeKey(a, b);
  for (const w of floor.walls || []) {
    if (M.inferWallRoomId(w) === room.id) continue;
    if (M.wallEdgeKeyFromWall(w) !== key) continue;
    if (!wallMatchesEdge(w, a, b)) continue;
    const rid = M.inferWallRoomId(w);
    return (floor.rooms || []).find((r) => r.id === rid) || null;
  }
  return null;
}

function edgeOutwardNormal(a, b, polygon) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1) return null;
  const nx1 = -dz / len, nz1 = dx / len;
  const nx2 = dz / len, nz2 = -dx / len;
  const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  const t = 400;
  const p1 = { x: mid.x + nx1 * t, z: mid.z + nz1 * t };
  const p2 = { x: mid.x + nx2 * t, z: mid.z + nz2 * t };
  const in1 = M.pointInPolygon(p1, polygon);
  const in2 = M.pointInPolygon(p2, polygon);
  if (!in1 && in2) return { nx: nx1, nz: nz1 };
  if (in1 && !in2) return { nx: nx2, nz: nz2 };
  return { nx: nx1, nz: nz1 };
}

function yawToward(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 1) return 0;
  return Math.atan2(dx, -dz);
}

function hasDoorLikeOpening(floor, wall) {
  const key = M.wallEdgeKeyFromWall(wall);
  return (floor.openings || []).some((op) => {
    if (!isPassableOpening(op)) return false;
    if (op.wallEdgeKey === key) return true;
    const ref = floor.walls.find((w) => w.id === op.wallId);
    return ref && M.wallEdgeKeyFromWall(ref) === key;
  });
}

/** 内観モードの初期位置・向き（玄関前の外側から家側を見る） */
export function findInteriorSpawn(floor, plan) {
  const STAND_OFF_MM = 1500;
  const genkan = (floor.rooms || []).find(
    (r) => r.type === 'genkan' && r.polygon?.length >= 3,
  );

  if (!genkan) {
    const porch = (floor.rooms || []).find(
      (r) => r.type === 'porch' && r.polygon?.length >= 3,
    );
    if (porch) {
      const rooms = walkableRoomPolygons(floor);
      const target = rooms.find((r) => r.id !== porch.id) || rooms[0];
      const pos = M.polygonCentroid(porch.polygon);
      const lookAt = target ? M.polygonCentroid(target.polygon) : pos;
      return { x: pos.x, z: pos.z, yaw: yawToward(pos, lookAt) };
    }
    const rooms = walkableRoomPolygons(floor);
    if (rooms.length) {
      const c = M.polygonCentroid(rooms[0].polygon);
      return { x: c.x, z: c.z - STAND_OFF_MM, yaw: 0 };
    }
    return { x: 0, z: -STAND_OFF_MM, yaw: 0 };
  }

  const centroid = M.polygonCentroid(genkan.polygon);
  const poly = genkan.polygon;
  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const elen = Math.hypot(b.x - a.x, b.z - a.z);
    if (elen < 500) continue;

    const outward = edgeOutwardNormal(a, b, poly);
    if (!outward) continue;

    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const wall = wallOnRoomEdge(floor, genkan.id, a, b);
    const neighbor = neighborRoomAcrossEdge(floor, genkan, a, b);

    let score = elen;
    if (wall && M.isExteriorWall(wall, floor, plan)) score += 8000;
    if (wall && hasDoorLikeOpening(floor, wall)) score += 5000;
    if (neighbor && ENTRY_NEIGHBOR_TYPES.has(neighbor.type)) score += 6000;
    if (!neighbor) score += 2500;

    if (score > bestScore) {
      bestScore = score;
      best = { mid, outward, neighbor };
    }
  }

  let x;
  let z;
  if (best?.neighbor && best.neighbor.type === 'porch') {
    const porchC = M.polygonCentroid(best.neighbor.polygon);
    x = best.mid.x + best.outward.nx * STAND_OFF_MM * 0.85;
    z = best.mid.z + best.outward.nz * STAND_OFF_MM * 0.85;
    const t = 0.55;
    x = x * (1 - t) + porchC.x * t;
    z = z * (1 - t) + porchC.z * t;
  } else if (best) {
    x = best.mid.x + best.outward.nx * STAND_OFF_MM;
    z = best.mid.z + best.outward.nz * STAND_OFF_MM;
  } else {
    x = centroid.x;
    z = centroid.z - STAND_OFF_MM;
  }

  const pos = { x, z };
  return { x, z, yaw: yawToward(pos, centroid) };
}

/** @deprecated findInteriorSpawn を使用 */
export function findGenkanSpawn(floor, plan = null) {
  const s = findInteriorSpawn(floor, plan || { floors: [floor], site: {} });
  return { x: s.x, z: s.z };
}

export function floorBounds(floor) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const add = (p) => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  };
  for (const room of floor.rooms || []) {
    for (const p of room.polygon || []) add(p);
  }
  for (const s of floor.stairs || []) {
    for (const c of M.stairFootprintCorners(s)) add(c);
  }
  if (!Number.isFinite(minX)) return { minX: -5000, maxX: 5000, minZ: -5000, maxZ: 5000 };
  const pad = 1500;
  return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
}
