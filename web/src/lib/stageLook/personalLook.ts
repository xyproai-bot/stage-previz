// 個人的現場設定：每個人（動畫師 / 導演 / 拿分享連結的人 / admin 自己）可以調成自己想看的亮度，
// 只存在自己這台電腦（localStorage，依專案分開），重新整理也會留著。
// 畫面 = 專案設定（admin 設的「所有人的預設」）→ 再蓋上自己調過的欄位。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LOOK_SETTING_RANGES, normalizeLookSettings, type LookSettings } from './lookSettings';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const key = (projectId: string) => `sp-look:${projectId}`;

export function mergeLook(project: LookSettings, personal: Partial<LookSettings> | null): LookSettings {
  return normalizeLookSettings({ ...project, ...(personal || {}) });
}

export function isLookCustomized(project: LookSettings, effective: LookSettings): boolean {
  return (Object.keys(LOOK_SETTING_RANGES) as (keyof LookSettings)[]).some(k => Math.abs(project[k] - effective[k]) > 1e-6);
}

/** 只留認識、而且是數字的欄位；沒有任何欄位 → null */
function cleanPartial(raw: unknown): Partial<LookSettings> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const full = normalizeLookSettings(src);
  const out: Partial<LookSettings> = {};
  for (const k of Object.keys(LOOK_SETTING_RANGES) as (keyof LookSettings)[]) {
    if (k in src && Number.isFinite(Number(src[k]))) out[k] = full[k];
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function readPersonalLook(storage: StorageLike, projectId: string): Partial<LookSettings> | null {
  try {
    const raw = storage.getItem(key(projectId));
    return raw ? cleanPartial(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writePersonalLook(storage: StorageLike, projectId: string, personal: Partial<LookSettings> | null) {
  try {
    if (personal && Object.keys(personal).length > 0) storage.setItem(key(projectId), JSON.stringify(personal));
    else storage.removeItem(key(projectId));
  } catch { /* 無痕模式 / 空間滿 → 這次不存 */ }
}

export interface PersonalLookState {
  /** 實際用在畫面上的設定 */
  effective: LookSettings;
  /** 跟專案設定不一樣嗎（面板顯示「回到專案預設」用） */
  customized: boolean;
  set: (patch: Partial<LookSettings>) => void;
  /** 清掉自己的調整，回到專案預設 */
  reset: () => void;
}

export function usePersonalLook(projectId: string | undefined, projectLook: LookSettings): PersonalLookState {
  const [personal, setPersonal] = useState<Partial<LookSettings> | null>(null);

  useEffect(() => {
    setPersonal(projectId ? readPersonalLook(localStorage, projectId) : null);
  }, [projectId]);

  const set = useCallback((patch: Partial<LookSettings>) => {
    setPersonal(prev => {
      const next = cleanPartial({ ...(prev || {}), ...patch });
      if (projectId) writePersonalLook(localStorage, projectId, next);
      return next;
    });
  }, [projectId]);

  const reset = useCallback(() => {
    setPersonal(null);
    if (projectId) writePersonalLook(localStorage, projectId, null);
  }, [projectId]);

  const effective = useMemo(() => mergeLook(projectLook, personal), [projectLook, personal]);
  const customized = useMemo(() => isLookCustomized(projectLook, effective), [projectLook, effective]);

  return { effective, customized, set, reset };
}
