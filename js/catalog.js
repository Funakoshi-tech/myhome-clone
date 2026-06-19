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

// ---- 家具（最小限。箱で表現） ----------------------------------------------
// w=間口(X), d=奥行(Z), h=高さ(Y)（mm）。
export const FURNITURE = [
  { id: 'sofa', name: 'ソファ', wMM: 1800, dMM: 800, hMM: 700, color: '#c0392b' },
  { id: 'sofa1', name: '1人ソファ', wMM: 800, dMM: 800, hMM: 700, color: '#a93226' },
  { id: 'table', name: 'テーブル', wMM: 1200, dMM: 800, hMM: 700, color: '#b9770e' },
  { id: 'lowtable', name: 'ローテーブル', wMM: 1000, dMM: 500, hMM: 380, color: '#8e6310' },
  { id: 'bed', name: 'ベッド', wMM: 1000, dMM: 2000, hMM: 450, color: '#2471a3' },
  { id: 'beddouble', name: 'ダブルベッド', wMM: 1400, dMM: 2000, hMM: 450, color: '#1f618d' },
  { id: 'chair', name: '椅子', wMM: 450, dMM: 450, hMM: 850, color: '#7d6608' },
  { id: 'desk', name: 'デスク', wMM: 1200, dMM: 600, hMM: 720, color: '#9c640c' },
  { id: 'shelf', name: '本棚', wMM: 900, dMM: 300, hMM: 1800, color: '#6e2c00' },
  { id: 'fridge', name: '冷蔵庫', wMM: 700, dMM: 700, hMM: 1800, color: '#566573' },
  { id: 'tvboard', name: 'TVボード', wMM: 1500, dMM: 400, hMM: 450, color: '#515a5a' },
  { id: 'dining', name: 'ダイニングセット', wMM: 1500, dMM: 900, hMM: 720, color: '#9a7d0a' },
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
