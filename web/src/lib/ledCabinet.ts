// LED 測試圖的網格 = 一格一片 LED 箱體。純算數（不碰 canvas），有單元測試。
// 一般箱體 1m × 0.5m = 256 × 128 像素（也有 128 × 256 的）；0.5m = 128 像素，所以預設一格 128 × 128，所有箱體的邊都會落在格線上。
// 網格從每塊螢幕自己的左上角（轉動、翻轉前的螢幕座標，單位 = 真實點數）開始畫，不足一格的邊緣照實畫出來。
// 版型畫布像素跟真實點數不是 1:1 的時候，格線是在「真實點數」的座標裡畫的，再照這塊螢幕的矩陣縮放，所以一格永遠是一片真實的箱體。

export interface Cabinet { w: number; h: number }

/** 沒設定 = 一格 128 × 128 像素（0.5m × 0.5m） */
export const DEFAULT_CABINET: Readonly<Cabinet> = Object.freeze({ w: 128, h: 128 });
export const CABINET_RANGE: readonly [number, number] = [16, 4096];

/** 後台 / 表單來的箱體大小 → 檢查過的 Cabinet；沒給（undefined / null）= null（用預設）；不對 = undefined */
export function parseCabinet(raw: unknown): Cabinet | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const w = r.w, h = r.h;
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isInteger(w) || !Number.isInteger(h)) return undefined;
  if (w < CABINET_RANGE[0] || h < CABINET_RANGE[0] || w > CABINET_RANGE[1] || h > CABINET_RANGE[1]) return undefined;
  return { w, h };
}

export const cabinetsEqual = (a: Cabinet | null | undefined, b: Cabinet | null | undefined) =>
  (a?.w ?? 0) === (b?.w ?? 0) && (a?.h ?? 0) === (b?.h ?? 0);

/** 這塊螢幕用的箱體大小：自己設的 → 版型的預設 → 128 × 128 */
export function resolveCabinet(own: Cabinet | null | undefined, templateDefault?: Cabinet | null): Cabinet {
  return own ?? templateDefault ?? DEFAULT_CABINET;
}

/** 一個方向上的格線位置（從 0 起算每 cell 一條，只留在螢幕裡面：0 和最外緣是邊框，不重複算） */
export function gridPositions(extent: number, cell: number): number[] {
  const out: number[] = [];
  if (!(extent > 0) || !(cell > 0)) return out;
  for (let i = 1; i * cell < extent - 1e-6; i++) out.push(i * cell);
  return out;
}

interface CabinetPanel { id: string; cabinet?: Cabinet }
interface CabinetPlan { cabinet?: Cabinet | null; screens: readonly { key: string; cabinet?: Cabinet | null }[] }

/**
 * 把版型的箱體設定填進整張畫布的測試圖排法（每塊 LED 一個 id：螢幕代號 o:xxx~名稱 / s:xxx，或舊的物件 id）。
 * 版型什麼都沒設 = 原樣回傳同一份（跟以前完全一樣，不重畫）。
 */
export function applyCabinets<L extends { panels: readonly CabinetPanel[] }>(layout: L, plan: CabinetPlan | null | undefined): L {
  if (!plan) return layout;
  const own = new Map<string, Cabinet>();
  for (const s of plan.screens) if (s.cabinet) own.set(s.key, s.cabinet);
  if (own.size === 0 && !plan.cabinet) return layout;
  return {
    ...layout,
    panels: layout.panels.map(p => {
      const c = own.get(p.id) ?? own.get(`o:${p.id}`) ?? plan.cabinet ?? null;
      return c ? { ...p, cabinet: c } : p;
    }),
  };
}

/** 這塊螢幕橫向、直向各有幾格（13 / 6.5：最後半格就是不足一格的邊緣） */
export function gridCells(native: { w: number; h: number }, cabinet: Cabinet): { cols: number; rows: number } {
  const r = (n: number) => Math.round(n * 100) / 100;
  return { cols: r(native.w / cabinet.w), rows: r(native.h / cabinet.h) };
}
