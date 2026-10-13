// 現場模式的可調設定（全專案共用，存在 projects.look_settings）
// 範圍要跟 cf-worker/worker.js 的 LOOK_SETTING_RANGES 一致

export interface LookSettings {
  /** 現場底光：舞台結構看得多清楚（0 = 全暗，只有 LED） */
  houseLight: number;
  /** 曝光：整體亮暗，像相機 */
  exposure: number;
  /** LED 照明：LED 照到舞台的強度 */
  ledLightStrength: number;
  /** 光暈：亮的 LED 周圍暈開多少 */
  bloomStrength: number;
  /** 地板倒影：亮面地板映出 LED 的強度（0 = 關） */
  floorReflection: number;
  /** 倒影清晰度 */
  reflectionSharpness: number;
  /** LED 側看變暗 */
  ledViewFalloff: number;
}

export const LOOK_SETTING_RANGES: Record<keyof LookSettings, [number, number]> = {
  houseLight: [0, 1],
  exposure: [0.2, 3],
  ledLightStrength: [0, 5],
  bloomStrength: [0, 3],
  floorReflection: [0, 1],
  reflectionSharpness: [0, 1],
  ledViewFalloff: [0, 1],
};

export const DEFAULT_LOOK_SETTINGS: LookSettings = {
  houseLight: 0.15,
  exposure: 1,
  ledLightStrength: 1,
  bloomStrength: 0.6,
  floorReflection: 0.5,
  reflectionSharpness: 0.6,
  ledViewFalloff: 0.3,
};

export function normalizeLookSettings(raw: unknown): LookSettings {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_LOOK_SETTINGS };
  for (const key of Object.keys(LOOK_SETTING_RANGES) as (keyof LookSettings)[]) {
    if (!(key in src)) continue;
    const n = Number(src[key]);
    if (!Number.isFinite(n)) continue;
    const [min, max] = LOOK_SETTING_RANGES[key];
    out[key] = Math.min(max, Math.max(min, n));
  }
  return out;
}
