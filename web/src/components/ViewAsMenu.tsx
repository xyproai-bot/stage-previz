// 「用其他身分看」選單的項目（編輯頁上方列、手機的「⋯」、管理頁專案卡片的選單共用）：
//   導演畫面 / 動畫師畫面 / 動畫師「小明」的畫面… / 客戶畫面（分享連結）
// 導演、動畫師都開新分頁（預覽模式，只能看；lib/viewAs.ts）；客戶 = 打開這個專案最新的分享連結，
// 還沒有分享連結 → 站內對話框說怎麼建立。分享連結清單在選單打開時才讀（load）。

import { useCallback, useMemo, useRef, useState } from 'react';
import { Clapperboard, Globe, Palette, UserRound } from 'lucide-react';
import * as api from '../lib/api';
import type { ShareLink } from '../lib/api';
import type { OverflowItem } from './OverflowMenu';
import { confirmDialog } from './dialogs';
import { toast } from '../lib/toast';
import { parseServerTime } from '../lib/serverTime';
import { shareSlugUrl, shareTokenUrl } from '../lib/siteUrl';
import { friendlyError } from '../lib/songReview';
import { pickClientShareLink, viewAsPath } from '../lib/viewAs';

export const VIEW_AS_MENU_LABEL = '用其他身分看';

interface Options {
  projectId: string;
  /** 這個專案的動畫師（每個人一個「動畫師「小明」的畫面」） */
  animators: readonly { id: string; name: string }[];
  /** 還沒有分享連結時，對話框上的「去建立」要做什麼（編輯頁：打開分享連結視窗；卡片：到編輯頁打開） */
  onCreateShare: () => void;
  /** 第一個項目上面要不要寫小標題「用其他身分看」（手機的「⋯」裡跟別的項目放在一起時） */
  withSection?: boolean;
}

type LinksState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; link: ShareLink | null }
  | { status: 'error'; error: string };

export function clientShareUrl(link: Pick<ShareLink, 'token' | 'slug'>): string {
  return link.slug ? shareSlugUrl(link.slug) : shareTokenUrl(link.token);
}

export function useViewAsMenu({ projectId, animators, onCreateShare, withSection }: Options): { items: OverflowItem[]; load: () => void } {
  const [links, setLinks] = useState<LinksState>({ status: 'idle' });
  const loadingRef = useRef(false);
  const createRef = useRef(onCreateShare);
  createRef.current = onCreateShare;

  // 每次打開選單都重讀（剛在分享連結視窗建了一個，馬上就用得到）
  const load = useCallback(() => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLinks(prev => (prev.status === 'ready' ? prev : { status: 'loading' }));
    api.listShareLinks(projectId)
      .then(list => setLinks({ status: 'ready', link: pickClientShareLink(list, Date.now(), parseServerTime) }))
      .catch(e => setLinks({ status: 'error', error: friendlyError(e) }))
      .finally(() => { loadingRef.current = false; });
  }, [projectId]);

  const items = useMemo<OverflowItem[]>(() => {
    const list: OverflowItem[] = [
      {
        key: 'viewas-director', label: '導演畫面（只能看）', icon: Clapperboard,
        href: viewAsPath(projectId, 'director'), external: true,
        section: withSection ? VIEW_AS_MENU_LABEL : undefined,
      },
      {
        key: 'viewas-animator', label: animators.length > 0 ? '動畫師畫面（還沒指派歌的，只能看）' : '動畫師畫面（只能看）', icon: Palette,
        href: viewAsPath(projectId, 'animator'), external: true,
      },
      ...animators.map(a => ({
        key: `viewas-animator-${a.id}`, label: `動畫師「${a.name}」的畫面（只能看）`, icon: UserRound,
        href: viewAsPath(projectId, 'animator', a.id), external: true,
      })),
    ];
    const clientLabel = '客戶畫面（分享連結）';
    if (links.status === 'ready' && links.link) {
      list.push({
        key: 'viewas-client', label: links.link.hasPassword ? '客戶畫面（分享連結，要密碼）' : clientLabel, icon: Globe,
        href: clientShareUrl(links.link), external: true,
      });
    } else if (links.status === 'ready') {
      list.push({
        key: 'viewas-client', label: clientLabel, icon: Globe,
        onSelect: () => {
          void confirmDialog({
            title: '這個專案還沒有分享連結',
            message: '客戶看到的是分享連結打開的畫面（不用登入、只能看）。\n先到編輯頁上方的「分享」建立一個連結（可以設密碼、到期日），再回來按「客戶畫面」就會打開它。',
            confirmLabel: '建立分享連結',
            cancelLabel: '先不要',
          }).then(ok => { if (ok) createRef.current(); });
        },
      });
    } else if (links.status === 'error') {
      list.push({
        key: 'viewas-client', label: clientLabel, icon: Globe,
        onSelect: () => toast.error(`分享連結讀不到：${links.error}（再打開一次選單會重讀）`),
      });
    } else {
      list.push({ key: 'viewas-client', label: '客戶畫面（讀取分享連結中…）', icon: Globe, disabled: true });
    }
    return list;
  }, [projectId, animators, links, withSection]);

  return { items, load };
}
