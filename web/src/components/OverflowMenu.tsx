// 上方列的「⋯」選單：畫面窄（手機，640px 以下）時，次要的按鈕收進這裡。
//
// 用法：
//   <button className="ovf-hide-narrow" …>活動</button>          ← 寬的時候直接顯示
//   <OverflowMenu className="ovf-only-narrow" items={[…]} />      ← 窄的時候才出現
//
// 鍵盤：Enter / 空白鍵 / ↓ 打開並選第一個；↑↓ 換、Home / End 跳頭尾；Esc 關掉並回到「⋯」；Tab 離開就關。
// 點外面也會關。選單用 fixed 定位（上方列 overflow: hidden 也不會被切掉），不會超出畫面。
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
}

interface Props {
  items: OverflowItem[];
  /** 按鈕的說明（預設「更多」） */
  label?: string;
  /** 選單最上面的小字（例：登入的人的名字） */
  header?: ReactNode;
  className?: string;
}

export default function OverflowMenu({ items, label = '更多', header, className }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const focusFirstRef = useRef(false);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ top: Math.round(r.bottom + 6), right: Math.max(8, Math.round(window.innerWidth - r.right)) });
  }, []);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

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
        className={'ovf__btn' + (open ? ' is-open' : '')}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onButtonKey}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <Icon icon={Ellipsis} size="md" />
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          id={menuId}
          className="ovf__menu"
          role="menu"
          aria-label={label}
          style={{ top: pos.top, right: pos.right }}
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
                {it.separatorBefore && <div className="ovf__sep" role="separator" />}
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
