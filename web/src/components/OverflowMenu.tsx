// 上方列的「⋯」選單：畫面窄（手機，640px 以下）時，次要的按鈕收進這裡。
//
// 用法：
//   <button className="ovf-hide-narrow" …>活動</button>          ← 寬的時候直接顯示
//   <OverflowMenu className="ovf-only-narrow" items={[…]} />      ← 窄的時候才出現
//
// 鍵盤：Enter / 空白鍵 / ↓ 打開並選第一個；↑↓ 換、Home / End 跳頭尾；Esc 關掉並回到「⋯」；Tab 離開就關。
// 點外面也會關。選單用 fixed 定位（上方列 overflow: hidden 也不會被切掉），不會超出畫面。
//
// 不是「⋯」的下拉選單也可以用（例：編輯頁的「用其他身分看」）：trigger = 按鈕上的圖示 + 字 + class；onOpen = 打開時叫（例：先讀資料）
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Ellipsis, type LucideIcon } from 'lucide-react';
import Icon from './Icon';
import './OverflowMenu.css';

export interface OverflowItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  /** 有給 = 連結（開新分頁用 external） */
  href?: string;
  external?: boolean;
  disabled?: boolean;
  /** 打開的狀態（例：整場串播中）→ 打勾樣式 */
  active?: boolean;
  /** 紅字（例：登出） */
  danger?: boolean;
  /** 跟上一個之間畫一條線 */
  separatorBefore?: boolean;
  /** 字後面的小標記（例：Drive 已設定） */
  badge?: ReactNode;
  /** 這個項目上面的小標題（例：「用其他身分看」）；有給也會畫一條線 */
  section?: string;
}

interface Props {
  items: OverflowItem[];
  /** 按鈕的說明（預設「更多」） */
  label?: string;
  /** 選單最上面的小字（例：登入的人的名字） */
  header?: ReactNode;
  className?: string;
  /** 不用「⋯」：按鈕上的圖示、字、class（例：上方列的「用其他身分看」） */
  trigger?: { icon?: LucideIcon; text?: ReactNode; className?: string; /** 帶著做要亮這顆按鈕時用的標記（data-tour） */ dataTour?: string };
  /** 打開時叫（例：先去讀分享連結） */
  onOpen?: () => void;
  /** 選單怎麼對齊按鈕：預設靠右；'auto' = 按鈕太靠左、靠右會超出畫面時改靠左 */
  align?: 'right' | 'auto';
}

/** 選單最寬大概多少（min-width 210 + 內距） */
const MENU_ROOM = 232;

export default function OverflowMenu({ items, label = '更多', header, className, trigger, onOpen, align = 'right' }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right?: number; left?: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const focusFirstRef = useRef(false);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const top = Math.round(r.bottom + 6);
    // auto：按鈕在畫面左邊（工具列換行、排到最左邊的時候），靠右對齊的選單會被切掉 → 改成靠左對齊；其他照舊靠右對齊
    if (align === 'auto' && r.right < MENU_ROOM) {
      setPos({ top, left: Math.max(8, Math.round(r.left)) });
      return;
    }
    setPos({ top, right: Math.max(8, Math.round(window.innerWidth - r.right)) });
  }, [align]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onResize = () => place();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open, place]);

  // 用鍵盤打開 → 焦點放到第一個能按的
  useEffect(() => {
    if (!open || !pos || !focusFirstRef.current) return;
    focusFirstRef.current = false;
    menuItems(menuRef.current)[0]?.focus();
  }, [open, pos]);

  function onButtonKey(e: React.KeyboardEvent) {
    // 用滑鼠打開時焦點還在按鈕上：Esc 一樣只關選單（不要讓外面的對話框也跟著關）
    if (open && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      close(true);
      return;
    }
    if (open && e.key === 'ArrowDown') {
      e.preventDefault();
      menuItems(menuRef.current)[0]?.focus();
      return;
    }
    if (e.key === 'ArrowDown' || ((e.key === 'Enter' || e.key === ' ') && !open)) {
      e.preventDefault();
      focusFirstRef.current = true;
      setOpen(true);
    }
  }

  function onMenuKey(e: React.KeyboardEvent) {
    const list = menuItems(menuRef.current);
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      close(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
    }
  }

  function pick(it: OverflowItem) {
    if (it.disabled) return;
    close(!it.href);
    it.onSelect?.();
  }

  return (
    <span className={'ovf' + (className ? ` ${className}` : '')}>
      <button
        ref={btnRef}
        type="button"
        className={(trigger ? (trigger.className ?? 'ovf__trigger') : 'ovf__btn') + (open ? ' is-open' : '')}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onButtonKey}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-tour={trigger?.dataTour}
      >
        {trigger
          ? <>{trigger.icon && <Icon icon={trigger.icon} />}{trigger.text}</>
          : <Icon icon={Ellipsis} size="md" />}
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          id={menuId}
          className="ovf__menu"
          role="menu"
          aria-label={label}
          style={{ top: pos.top, right: pos.right, left: pos.left }}
          onKeyDown={onMenuKey}
        >
          {header && <div className="ovf__header">{header}</div>}
          {items.map(it => {
            const content = (
              <>
                <span className="ovf__icon">{it.icon && <Icon icon={it.icon} size="sm" />}</span>
                <span className="ovf__label">{it.label}</span>
                {it.badge}
                {it.active && <span className="ovf__on" aria-hidden="true" />}
              </>
            );
            const cls = 'ovf__item' + (it.danger ? ' is-danger' : '') + (it.active ? ' is-active' : '');
            return (
              <div key={it.key} role="none">
                {(it.separatorBefore || it.section) && <div className="ovf__sep" role="separator" />}
                {it.section && <div className="ovf__section">{it.section}</div>}
                {it.href && !it.disabled ? (
                  <a
                    role="menuitem"
                    className={cls}
                    href={it.href}
                    target={it.external ? '_blank' : undefined}
                    rel={it.external ? 'noopener' : undefined}
                    tabIndex={-1}
                    onClick={() => pick(it)}
                  >{content}</a>
                ) : (
                  <button
                    type="button"
                    role={it.active === undefined ? 'menuitem' : 'menuitemcheckbox'}
                    aria-checked={it.active === undefined ? undefined : it.active}
                    className={cls}
                    disabled={it.disabled}
                    tabIndex={-1}
                    onClick={() => pick(it)}
                  >{content}</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>('.ovf__item:not([disabled])'));
}
