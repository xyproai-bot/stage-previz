// 小播放器的「比較」（A/B）：選第二個版本，一個按鈕（或按 C）在兩版之間切，停在同一秒、播放 / 暫停照舊。
// 只用同一個 <video>（換網址再跳到同一秒），不會同時放兩支影片 → 電腦負擔跟只看一版一樣。
// 取代以前的「並排對比」。純函式（abCompare.test.ts 有測）；換網址那段在 localVideo.ts 的 replaceUrl。

export interface AbPair {
  /** 開始比較時正在看的那一版（VersionItem.key） */
  a: string;
  /** 選來比較的那一版 */
  b: string;
}

export interface CompareOption {
  key: string;
  label: string;
}

interface Item { key: string; label: string; url: string | null }

/** 可以拿來比較的版本（可以播的、不是正在看的那一版） */
export function compareOptions(items: readonly Item[], currentKey: string | null): CompareOption[] {
  return items.filter(it => it.url && it.key !== currentKey).map(it => ({ key: it.key, label: it.label }));
}

/**
 * 按「比較」時預設選哪一版：正在看的下一個舊版（V3 → V2）；已經是最舊的 → 上一個新版。
 * items 是 V3、V2、V1 這樣新的在前。
 */
export function defaultCompareKey(items: readonly Item[], currentKey: string | null): string | null {
  const ready = items.filter(it => it.url);
  const i = ready.findIndex(it => it.key === currentKey);
  if (i < 0) return ready.find(it => it.key !== currentKey)?.key ?? null;
  return ready[i + 1]?.key ?? ready[i - 1]?.key ?? null;
}

/** 開始比較（同一版不能比） */
export function startCompare(currentKey: string | null, otherKey: string | null): AbPair | null {
  if (!currentKey || !otherKey || currentKey === otherKey) return null;
  return { a: currentKey, b: otherKey };
}

/** 現在在 A → 切到 B；在 B → 切回 A；兩個都不是（中間自己點了別版）→ 切到 B */
export function flipTarget(pair: AbPair, currentKey: string | null): string {
  return currentKey === pair.b ? pair.a : pair.b;
}

/** 比較中「另一版」是哪一版（按鈕上寫「切到 V2」） */
export function otherKey(pair: AbPair, currentKey: string | null): string {
  return flipTarget(pair, currentKey);
}

/**
 * 版本清單變了 / 自己點了別版 → 比較要不要留著：
 *   - 兩版其中一版不在了（被刪）→ 不比了
 *   - 正在看的是 A 或 B → 照舊
 *   - 自己點了第三版 → 那一版變成 A，B 不變（B 剛好就是它 → 換成原本的 A）
 */
export function syncPair(pair: AbPair | null, currentKey: string | null, availableKeys: readonly string[]): AbPair | null {
  if (!pair || !currentKey) return null;
  const has = new Set(availableKeys);
  if (!has.has(pair.a) || !has.has(pair.b)) {
    // 還在的那一版跟正在看的不一樣 → 繼續比
    const keep = [pair.a, pair.b].find(k => has.has(k) && k !== currentKey);
    return keep && has.has(currentKey) ? { a: currentKey, b: keep } : null;
  }
  if (currentKey === pair.a || currentKey === pair.b) return pair;
  return { a: currentKey, b: pair.b };
}

/** 按 C 要不要切：在打字（輸入框、留言）或按著 Ctrl / Cmd / Alt 時不算 */
export function isCompareShortcut(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; target?: unknown }): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  if (e.key !== 'c' && e.key !== 'C') return false;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
  return true;
}
