// catalog.js
// 部屋種別・家具・建具・住設の定義（データ）。ここを増やせば項目が増える。
// 実体は catalogId で結ぶ。

// ---- 部屋種別 ---------------------------------------------------------------
// color は 2D の塗り／3D の床色に使う。
export const ROOM_TYPES = [
  { id: 'yoshitsu', name: '洋室', color: '#3b6ea5' },
  { id: 'washitsu', name: '和室', color: '#7a8b3a' },
  { id: 'genkan', name: '玄関', color: '#8a6d3b' },
  { id: 'porch', name: 'ポーチ', color: '#6b5b4b' },
  { id: 'garage', name: 'ガレージ', color: '#555a60' },
  { id: 'L', name: 'L（リビング）', color: '#2f8f6b' },
  { id: 'D', name: 'D（ダイニング）', color: '#3a9b85' },
  { id: 'K', name: 'K（キッチン）', color: '#4aa0a0' },
  { id: 'LD', name: 'LD', color: '#2f8f7f' },
  { id: 'LDK', name: 'LDK', color: '#2e9e7a' },
  { id: 'bath', name: '浴室', color: '#2d7fa6' },
  { id: 'toilet', name: 'トイレ', color: '#9a5b8a' },
  { id: 'washroom', name: '洗面所', color: '#5b8aa6' },
  { id: 'corridor', name: '廊下', color: '#6a6a72' },
  { id: 'balcony', name: 'バルコニー', color: '#7d7d55' },
  { id: 'tokonoma', name: '床の間', color: '#8a7340' },
  { id: 'hiroen', name: '広縁', color: '#80764a' },
  { id: 'fukinuke', name: '吹抜け', color: '#4a5570' },
  { id: 'closet', name: '収納', color: '#7a6a55' },
  { id: 'doma', name: '土間', color: '#6e6258' },
];

export function getRoomType(id) {
  return ROOM_TYPES.find((r) => r.id === id) || ROOM_TYPES[0];
}

// ---- 家具 -------------------------------------------------------------------
// w=間口(X), d=奥行(Z), h=高さ(Y)（mm）。model3d は 3D 表示用（Kenney Furniture Kit）。
const KENNEY_GLB = 'assets/kenney-furniture/Models/GLTF format';

export const FURNITURE = [
  { id: 'kitchen', name: 'キッチン', wMM: 2580, dMM: 970, hMM: 850, color: '#4aa0a0', model3d: `${KENNEY_GLB}/kitchenBar.glb` },
  { id: 'cupboard', name: 'カップボード', wMM: 1800, dMM: 450, hMM: 900, color: '#4aa0a0', model3d: `${KENNEY_GLB}/kitchenCabinetUpperDouble.glb` },
  { id: 'table', name: 'ダイニングテーブル', wMM: 1600, dMM: 850, hMM: 700, color: '#b9770e', model3d: `${KENNEY_GLB}/table.glb` },
  { id: 'sofaL', name: 'L字ソファ', wMM: 2400, dMM: 1800, hMM: 800, color: '#c0392b', model3d: `${KENNEY_GLB}/loungeSofaCorner.glb` },
  { id: 'tv', name: 'TV', wMM: 1300, dMM: 400, hMM: 700, color: '#333333', model3d: `${KENNEY_GLB}/televisionModern.glb` },
  { id: 'bed', name: 'シングルベッド', wMM: 1000, dMM: 2000, hMM: 450, color: '#2471a3', model3d: `${KENNEY_GLB}/bedSingle.glb` },
  { id: 'bedsemi', name: 'セミダブルベッド', wMM: 1200, dMM: 2000, hMM: 450, color: '#1f618d', model3d: `${KENNEY_GLB}/bedDouble.glb` },
  { id: 'desk', name: '勉強デスク', wMM: 1100, dMM: 600, hMM: 700, color: '#9c640c', model3d: `${KENNEY_GLB}/desk.glb` },
  { id: 'chair', name: '椅子', wMM: 900, dMM: 500, hMM: 800, color: '#7d6608', model3d: `${KENNEY_GLB}/chair.glb` },
  { id: 'vanity', name: '洗面化粧台', wMM: 1200, dMM: 450, hMM: 1800, color: '#5b8aa6', model3d: `${KENNEY_GLB}/bathroomCabinetDrawer.glb` },
  { id: 'tansu', name: 'タンス', wMM: 900, dMM: 500, hMM: 800, color: '#6e2c00', model3d: `${KENNEY_GLB}/sideTableDrawers.glb` },
  { id: 'washer', name: '洗濯機', wMM: 600, dMM: 600, hMM: 1000, color: '#566573', model3d: `${KENNEY_GLB}/washer.glb` },
  { id: 'carSuv', name: '車（SUV）', wMM: 1840, dMM: 4650, hMM: 1700, color: '#4a5568', kind: 'vehicle' },
  { id: 'carKei', name: '車（軽自動車）', wMM: 1475, dMM: 3395, hMM: 1525, color: '#5a6270', kind: 'vehicle' },
  // その他
  { id: 'beddouble', name: 'ダブルベッド', wMM: 1400, dMM: 2000, hMM: 450, color: '#1a5276', model3d: `${KENNEY_GLB}/bedDouble.glb` },
  { id: 'sofa', name: 'ソファ', wMM: 1800, dMM: 800, hMM: 700, color: '#c0392b', model3d: `${KENNEY_GLB}/loungeSofa.glb` },
  { id: 'sofa1', name: '1人ソファ', wMM: 800, dMM: 800, hMM: 700, color: '#a93226', model3d: `${KENNEY_GLB}/loungeChair.glb` },
  { id: 'lowtable', name: 'ローテーブル', wMM: 1000, dMM: 500, hMM: 380, color: '#8e6310', model3d: `${KENNEY_GLB}/tableCoffee.glb` },
  { id: 'shelf', name: '本棚', wMM: 900, dMM: 300, hMM: 1800, color: '#6e2c00', model3d: `${KENNEY_GLB}/bookcaseClosedDoors.glb` },
  { id: 'fridge', name: '冷蔵庫', wMM: 700, dMM: 700, hMM: 1800, color: '#566573', model3d: `${KENNEY_GLB}/kitchenFridge.glb` },
  { id: 'tvboard', name: 'TVボード', wMM: 1500, dMM: 400, hMM: 450, color: '#515a5a', model3d: `${KENNEY_GLB}/cabinetTelevision.glb` },
  { id: 'dining', name: 'ダイニングセット', wMM: 1500, dMM: 900, hMM: 720, color: '#9a7d0a', model3d: `${KENNEY_GLB}/tableCross.glb` },
];

export function getFurniture(id) {
  return FURNITURE.find((f) => f.id === id) || FURNITURE[0];
}

// ---- 階段（独立カテゴリ） ---------------------------------------------------
// defaultW=間口(X mm), defaultD=奥行(Z mm)
// 直線系: 3P×1P / 折返し系: 2P×2P
const P = 910;
export const STAIR_TYPES = [
  { id: 'straight', name: '直進階段',   icon: '↑', defaultW: 3 * P, defaultD: 1 * P },
  { id: 'l_shape',  name: 'L字階段',    icon: '↳', defaultW: 2 * P, defaultD: 2 * P },
  { id: 'u_shape',  name: 'U字折返し',  icon: '⇅', defaultW: 2 * P, defaultD: 2 * P },
  { id: 'winding',  name: '廻り階段',   icon: '↻', defaultW: 2 * P, defaultD: 2 * P },
  { id: 'spiral',   name: '螺旋階段',   icon: '⊛', defaultW: 2 * P, defaultD: 2 * P },
];

export function getStairType(id) {
  return STAIR_TYPES.find((s) => s.id === id) || STAIR_TYPES[0];
}

// ---- 建具（窓・ドア）--------------------------------------------------------
// sillMM=腰高, heightMM=開口高, widthMM=既定幅 (すべて mm)
export const OPENING_TYPES = [
  { id: 'window',  name: '窓',         sillMM: 800, heightMM: 1100, widthMM: 1650 },
  { id: 'sliding', name: '掃き出し窓', sillMM: 0,   heightMM: 2000, widthMM: 1650 },
  { id: 'door',    name: 'ドア',       sillMM: 0,   heightMM: 2000, widthMM: 900  },
];

export function getOpeningType(id) {
  return OPENING_TYPES.find((o) => o.id === id) || OPENING_TYPES[0];
}

// ---- 住設（設備）------------------------------------------------------------
export const PLUMBING_TYPES = [
  { id: 'toilet', name: '便器', color: '#9a5b8a' },
  { id: 'washbasin', name: '洗面台', color: '#5b8aa6' },
  { id: 'unitbath', name: 'ユニットバス', color: '#2d7fa6' },
  { id: 'kitchen', name: 'キッチン', color: '#4aa0a0' },
  { id: 'waterheater', name: '給湯器', color: '#566573' },
];

export function getPlumbingType(id) {
  return PLUMBING_TYPES.find((p) => p.id === id) || PLUMBING_TYPES[0];
}

// ---- 外構 -------------------------------------------------------------------
export const EXTERIOR_TYPES = [
  { id: 'parking', name: '駐車場', color: '#555a60' },
  { id: 'gate', name: '門扉', color: '#6b5b4b' },
  { id: 'fence', name: 'フェンス', color: '#7a6a55' },
  { id: 'deck', name: 'デッキ', color: '#8a7340' },
  { id: 'planting', name: '植栽', color: '#7a8b3a' },
];

export function getExteriorType(id) {
  return EXTERIOR_TYPES.find((e) => e.id === id) || EXTERIOR_TYPES[0];
}
