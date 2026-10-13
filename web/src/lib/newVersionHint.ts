// 「有新版 V3 · 切換」小提示（導演頁、動畫師工作站）：
// 看到一半有人交了新版（25 秒自動更新抓到的）→ 播放照舊停在正在看的那一版（不會突然換掉），
// 版本列旁邊出現一個小提示；按「切換」= 換到新版、停在同一秒（跟比較 A/B 一樣，lib/useAbCompare.ts）。
// 看過那一版（按了切換、或自己在版本列點了它）就收掉；換歌重來。
// 一打開就已經有的舊版不算「新來的」（自己選了看 V1 的人不會一直被提醒）。
// 規則是純函式（newVersionHint.test.ts 有測）；hook 在下面。

import { useEffect, useMemo, useState } from 'react';
import { useVersionSwitch } from './useAbCompare';
import type { LoadUrlOptions } from './localVideo';

interface HintItem {
  key: string;
  kind: 'version' | 'drive';
  label: string;
}

export interface NewVersionHintState {
  /** 這些記錄是哪首歌的 */
  scope: string | null;
  /** 這首歌已經看過清單的版本（null = 這首歌的清單還沒讀到） */
  known: string[] | null;
  /** 看的時候新進來、還沒看的那一版 */
  arrived: string | null;
}

export const EMPTY_NEW_VERSION_HINT: NewVersionHintState = { scope: null, known: null, arrived: null };

export interface NewVersionHintInput {
  /** 哪首歌 */
  scope: string | null;
  /** 這首歌的版本清單讀到了沒（剛換歌、還在讀 = false） */
  loaded: boolean;
  /** 可以播的版本，新的在前（V3、V2、V1） */
  items: readonly HintItem[];
  /** 正在看的那一版（沒在看 = null） */
  currentKey: string | null;
}

/** 下一個狀態（沒變就回原本那個） */
export function nextNewVersionHint(prev: NewVersionHintState, input: NewVersionHintInput): NewVersionHintState {
  const { scope, loaded, items, currentKey } = input;
  let state = prev;
  // 換歌 → 重來
  if (state.scope !== scope) state = { scope, known: null, arrived: null };
  if (!scope || !loaded) return state;
  const keys = items.map(it => it.key);
  // 這首歌第一次讀到清單：現在有的都算「本來就有」
  if (state.known === null) return { ...state, known: keys };

  let { arrived } = state;
  const known = new Set(state.known);
  const fresh = keys.filter(k => !known.has(k));
  const top = items[0];
  // 最新的那一版是剛進來的，而且正在看的不是它 → 提醒（又有更新的進來 → 換成更新的那版）
  if (top && top.kind === 'version' && fresh.includes(top.key) && currentKey && currentKey !== top.key) arrived = top.key;
  // 看過了（切換了 / 自己點了它）、或那一版被刪了 → 收掉
  if (arrived && (currentKey === arrived || !keys.includes(arrived))) arrived = null;

  const nextKnown = fresh.length > 0 ? [...state.known, ...fresh] : state.known;
  if (arrived === state.arrived && nextKnown === state.known) return state;
  return { ...state, known: nextKnown, arrived };
}

/** 要顯示的那一版（沒有 = 不顯示；正在看的就是它 → 不顯示） */
export function newVersionToShow<T extends HintItem>(
  state: NewVersionHintState, scope: string | null, items: readonly T[], currentKey: string | null,
): T | null {
  if (!state.arrived || state.scope !== scope || state.arrived === currentKey) return null;
  return items.find(it => it.key === state.arrived) ?? null;
}

export interface NewVersionHint {
  /** 'V3' */
  label: string;
  /** 換到新版、停在同一秒 */
  onSwitch: () => void;
}

interface SwitchItem extends HintItem {
  url: string | null;
  crossOrigin?: LoadUrlOptions['crossOrigin'];
}

/**
 * 頁面用。scope = 歌曲 id；select = 記住選了哪一版（工作站還會順便把 LED 切到「影片」）；
 * player.replaceUrl 換網址、停在同一秒。回 null = 不用顯示
 */
export function useNewVersionHint(o: {
  scope: string | null;
  loaded: boolean;
  items: readonly SwitchItem[];
  currentKey: string | null;
  select: (key: string) => void;
  player: { replaceUrl: (url: string, opts: LoadUrlOptions) => void };
}): NewVersionHint | null {
  const { scope, loaded, items, currentKey } = o;
  const [state, setState] = useState<NewVersionHintState>(EMPTY_NEW_VERSION_HINT);
  useEffect(() => {
    setState(prev => nextNewVersionHint(prev, { scope, loaded, items, currentKey }));
  }, [scope, loaded, items, currentKey]);
  const switchTo = useVersionSwitch(items, o.player, o.select);
  const item = newVersionToShow(state, scope, items, currentKey);
  const key = item?.key ?? null;
  const label = item?.label ?? '';
  return useMemo(() => (key ? { label, onSwitch: () => switchTo(key) } : null), [key, label, switchTo]);
}
