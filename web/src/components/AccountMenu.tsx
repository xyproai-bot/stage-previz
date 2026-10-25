// 自己的帳號：「改名字」「換顏色」（每個登入的人都可以改自己的，不用找製作）。
//
//   useAccountEdit()   兩個動作 + 現成的選單項目（itemsAfterSeparator 放進任何「⋯」選單，登出的前面）
//   <AccountMenu />    上方列右邊「頭像 + 名字」變成一個小選單（寬畫面用；窄畫面的「⋯」直接放選單項目）
//
// 後台：PATCH /api/auth/me，只收名字和頭像顏色（規則見 lib/userProfileRules.ts）。
// 顏色選項跟用戶頁、新增用戶用同一組（lib/avatarColors.ts）。
import { useCallback, useMemo } from 'react';
import { ChevronDown, Palette, Pencil } from 'lucide-react';
import Icon from './Icon';
import OverflowMenu, { type OverflowItem } from './OverflowMenu';
import { chooseDialog, promptDialog } from './dialogs';
import { useAuth } from '../lib/auth';
import { toast } from '../lib/toast';
import { AVATAR_COLORS, avatarColorName, sameAvatarColor } from '../lib/avatarColors';
import { USER_NAME_MAX, cleanUserName, userNameProblem } from '../lib/userProfileRules';
import './AccountMenu.css';

export const RENAME_ME_LABEL = '改名字';
export const RECOLOR_ME_LABEL = '換顏色';

export function useAccountEdit() {
  const { user, updateProfile } = useAuth();
  const currentName = user?.name ?? '';
  const currentColor = user?.avatarColor ?? '';

  const renameMe = useCallback(async () => {
    const raw = await promptDialog({
      title: RENAME_ME_LABEL,
      label: '名字（大家在專案裡看到的）',
      defaultValue: currentName,
      confirmLabel: '儲存',
      maxLength: USER_NAME_MAX,
      validate: (v) => userNameProblem(v),
    });
    if (raw == null) return;
    const name = cleanUserName(raw);
    if (!name || name === currentName) return;
    try {
      await updateProfile({ name });
      toast.success(`名字改成「${name}」了`);
    } catch (e) {
      toast.error('名字沒有改成：' + (e instanceof Error ? e.message : String(e)));
    }
  }, [currentName, updateProfile]);

  const recolorMe = useCallback(async () => {
    const picked = await chooseDialog({
      title: '換頭像顏色',
      message: '大家在專案裡看到的你的頭像會跟著變。',
      choices: AVATAR_COLORS.map(c => ({ value: c.value, label: c.name, swatch: c.value, current: sameAvatarColor(c.value, currentColor) })),
      layout: 'list',
    });
    if (!picked || sameAvatarColor(picked, currentColor)) return;
    try {
      await updateProfile({ avatarColor: picked });
      toast.success(`頭像換成${avatarColorName(picked)}色了`);
    } catch (e) {
      toast.error('顏色沒有換成：' + (e instanceof Error ? e.message : String(e)));
    }
  }, [currentColor, updateProfile]);

  /** 放進「⋯」選單用的兩個項目（登出的前面） */
  const items = useMemo((): OverflowItem[] => [
    { key: 'account-rename', label: RENAME_ME_LABEL, icon: Pencil, onSelect: () => { void renameMe(); } },
    { key: 'account-recolor', label: RECOLOR_ME_LABEL, icon: Palette, onSelect: () => { void recolorMe(); } },
  ], [renameMe, recolorMe]);

  /** 放進「⋯」選單用：跟前面的項目之間畫一條線 */
  const itemsAfterSeparator = useMemo((): OverflowItem[] => items.map((it, i) => (i === 0 ? { ...it, separatorBefore: true } : it)), [items]);

  return { renameMe, recolorMe, items, itemsAfterSeparator };
}

/** 上方列右邊的「頭像 + 名字」：點開有「改名字」「換顏色」 */
export default function AccountMenu({ nameClassName }: { nameClassName?: string }) {
  const { user } = useAuth();
  const account = useAccountEdit();
  if (!user) return null;
  return (
    <OverflowMenu
      className="account-menu"
      label="我的帳號（改名字、換顏色）"
      header={user.name}
      align="auto"
      items={account.items}
      trigger={{
        className: 'account-menu__trigger',
        text: (
          <>
            <span className="avatar avatar--sm" style={{ background: user.avatarColor || '#10c78a' }}>{user.name?.[0] || '?'}</span>
            <span className={'account-menu__name' + (nameClassName ? ` ${nameClassName}` : '')}>{user.name}</span>
            <Icon icon={ChevronDown} size="xs" />
          </>
        ),
      }}
    />
  );
}
