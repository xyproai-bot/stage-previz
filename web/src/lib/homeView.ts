// 「🎥 重置攝影機」要回到的畫面：admin 設、全專案共用（存在 projects.home_view）。
// 沒設 → 自動算正面全景（stageCamera.ts）。數值是場景單位（畫面上顯示時乘上測距校準倍率變公尺）。
// 範圍要跟 cf-worker/worker.js 的 sanitizeHomeView 一致。

export interface HomeView {
  position: [number, number, number];
  target: [number, number, number];
  /** 上下視角（度） */
  fov: number;
}

const MAX_COORD = 100000;
export const HOME_FOV_RANGE: [number, number] = [10, 120];

function vec3(raw: unknown): [number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const v = raw.map(Number);
  return v.every(n => Number.isFinite(n) && Math.abs(n) <= MAX_COORD) ? [v[0], v[1], v[2]] : null;
}

export function normalizeHomeView(raw: unknown): HomeView | null {
  let obj = raw;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const src = obj as Record<string, unknown>;
  const position = vec3(src.position);
  const target = vec3(src.target);
  const fov = Number(src.fov);
  if (!position || !target || !Number.isFinite(fov)) return null;
  if (position.every((n, i) => Math.abs(n - target[i]) < 1e-6)) return null;  // 看向自己 → 沒有方向
  const [min, max] = HOME_FOV_RANGE;
  return { position, target, fov: Math.min(max, Math.max(min, fov)) };
}
