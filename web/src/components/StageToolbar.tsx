// 3D 工具列：永遠一排。寬度不夠時先拿掉字、再把不常用的收進「更多」（⋯）選單（lib/toolbarLayout.ts 決定怎麼收）。
// 每個工具的寬度在一份看不到的複本上量（帶字 / 只剩圖示兩種），3D 區塊變寬變窄（ResizeObserver）就重新排。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Check, Ellipsis } from 'lucide-react';
import Icon from './Icon';
import { isLabeled, planToolbar, type ToolbarPlanItem } from '../lib/toolbarLayout';

export interface ToolMenuEntry {
  icon: LucideIcon;
  label: string;
  /** 快捷鍵（顯示在右邊） */
  shortcut?: string;
  /** 開關類：有給就是開關，true = 開著 */
  checked?: boolean;
  disabled?: boolean;
  /** 滑鼠移上去的說明 */
  hint?: string;
  onSelect: () => void;
  /** 選了之後選單不要關（開關類，例：LED 顯示測試圖） */
  keepOpen?: boolean;
}

export interface ToolDef {
  id: string;
  group: string;
  /** 0 = 一定要看得到；越大越早收進「更多」 */
  priority: number;
  noSepBefore?: boolean;
  /** 伸縮（當前 cue 的名字）：最小寬度 */
  flex?: { min: number; compactMin: number };
  /** labeled = 帶字；flexWidth = 伸縮項目分到的寬度 */
  render: (labeled: boolean, flexWidth?: number) => ReactNode;
  /** 收進「更多」後在選單裡長怎樣；null = 不放進選單（例：cue 名字另外寫在選單最上面） */
  menu: ToolMenuEntry | null;
}

export interface ToolMenuSection {
  id: string;
  title: ReactNode;
  items: ToolMenuEntry[];
  /** 這一段最下面的小字 */
  note?: ReactNode;
}

interface Props {
  tools: ToolDef[];
  /** 選單最上面的一行：哪些被收起來了 → 要不要寫（例：cue 名字被收起來時寫在這） */
  menuHeader?: (overflow: ReadonlySet<string>) => ReactNode;
  /** 選單下面固定的段落（LED 對位圖）；有給 → 「更多」一直都在 */
  sections?: ToolMenuSection[];
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  className?: string;
  /** 工具列下面的彈出框（視角書籤、AE 即時狀態…）：對齊 3D 區塊右邊 */
  children?: ReactNode;
}

type Widths = Record<string, number>;

const sameWidths = (a: Widths, b: Widths) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Math.abs(a[k] - (b[k] ?? -1)) < 0.5);
};

export default function StageToolbar({ tools, menuHeader, sections = [], menuOpen, onMenuOpenChange, className, children }: Props) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<Widths>({});
  const [available, setAvailable] = useState(0);
  const [chrome, setChrome] = useState({ gap: 4, pad: 14 });

  const idKey = tools.map(t => t.id).join('|');

  // 量每個工具的寬度（帶字 :1 / 只剩圖示 :0）+ 分隔線 + 更多按鈕
  const measure = useCallback(() => {
    const m = measureRef.current;
    if (!m) return;
    const next: Widths = {};
    m.querySelectorAll<HTMLElement>('[data-mid]').forEach(el => {
      next[el.dataset.mid!] = el.getBoundingClientRect().width;
    });
    setWidths(prev => (sameWidths(prev, next) ? prev : next));
    const tb = toolbarRef.current;
    if (tb) {
      const cs = getComputedStyle(tb);
      const gap = parseFloat(cs.columnGap) || 0;
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
        + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
      setChrome(prev => (Math.abs(prev.gap - gap) < 0.1 && Math.abs(prev.pad - pad) < 0.1 ? prev : { gap, pad }));
    }
  }, []);

  // 可以用多寬：工具列那一排（左右各離 3D 區塊 10px，CSS .stage-scene__toolbar-row）
  // 順便記下 3D 區塊多高（彈出框 / 選單不能超出去）、工具列右邊離那一排右邊多遠（彈出框對齊工具列右邊）
  const readAvailable = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    setAvailable(row.clientWidth);
    const stage = row.offsetParent as HTMLElement | null;
    if (stage) row.style.setProperty('--stage-h', stage.clientHeight + 'px');
    const tb = toolbarRef.current;
    if (tb) row.style.setProperty('--tb-right', Math.max(0, row.clientWidth - tb.offsetLeft - tb.offsetWidth) + 'px');
  }, []);

  // 第一次 / 工具換了：先同步量一次（畫面出來前就排好，不會閃一下兩排）
  useLayoutEffect(() => {
    measure();
    readAvailable();
  }, [idKey, measure, readAvailable]);

  // 之後內容變了（字換了、字型載好了）、3D 區塊變寬變窄 / 工具列變寬變窄：ResizeObserver
  useEffect(() => {
    const m = measureRef.current;
    const row = rowRef.current;
    const stage = row?.offsetParent as HTMLElement | null | undefined;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    if (m) m.querySelectorAll('[data-mid]').forEach(n => ro.observe(n));
    const ro2 = new ResizeObserver(() => readAvailable());
    if (stage) ro2.observe(stage);
    if (row) ro2.observe(row);
    if (toolbarRef.current) ro2.observe(toolbarRef.current);
    return () => { ro.disconnect(); ro2.disconnect(); };
  }, [idKey, measure, readAvailable]);

  // 量的那份不能被點、不能被 Tab 到、螢幕報讀不念
  useEffect(() => { measureRef.current?.setAttribute('inert', ''); }, []);

  const plan = useMemo(() => {
    const items: ToolbarPlanItem[] = tools.map(t => ({
      id: t.id,
      group: t.group,
      priority: t.priority,
      noSepBefore: t.noSepBefore,
      labeled: widths[t.id + ':1'] ?? 0,
      compact: widths[t.id + ':0'] ?? 0,
      flexMin: t.flex?.min,
      flexCompactMin: t.flex?.compactMin,
    }));
    return planToolbar(items, {
      available: Math.max(0, available - chrome.pad),
      gap: chrome.gap,
      separator: widths['__sep'] ?? 5,
      more: widths['__more'] ?? 32,
      alwaysMore: sections.length > 0,
    });
  }, [tools, widths, available, chrome, sections.length]);

  const overflowSet = useMemo(() => new Set(plan.overflow), [plan.overflow]);
  const byId = useMemo(() => new Map(tools.map(t => [t.id, t])), [tools]);

  // ── 選單：點外面 / Esc / Tab 關掉；打開時游標到第一個 ──
  const closeMenu = useCallback((focusMore: boolean) => {
    onMenuOpenChange(false);
    if (focusMore) moreRef.current?.focus();
  }, [onMenuOpenChange]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || moreRef.current?.contains(t)) return;
      onMenuOpenChange(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [menuOpen, onMenuOpenChange]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    readAvailable();
    const first = menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])');
    first?.focus({ preventScroll: true });
  }, [menuOpen, readAvailable]);

  // 「更多」不見了（變寬了、選單沒東西）→ 選單也關掉
  useEffect(() => {
    if (menuOpen && !plan.showMore) onMenuOpenChange(false);
  }, [menuOpen, plan.showMore, onMenuOpenChange]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
    // 選單開著時，W / E / L… 這些 3D 快捷鍵不要跟著觸發
    if (e.key.length === 1) e.stopPropagation();
  };

  const entryButton = (key: string, it: ToolMenuEntry) => {
    const isToggle = it.checked !== undefined;
    return (
      <button
        key={key}
        type="button"
        role={isToggle ? 'menuitemcheckbox' : 'menuitem'}
        aria-checked={isToggle ? !!it.checked : undefined}
        className={'tb-menu__item' + (it.checked ? ' is-checked' : '')}
        disabled={it.disabled}
        title={it.hint}
        tabIndex={-1}
        onClick={() => {
          it.onSelect();
          if (!it.keepOpen) closeMenu(false);
        }}
      >
        <Icon icon={it.icon} size="sm" />
        <span className="tb-menu__label">{it.label}</span>
        {it.shortcut && <kbd className="tb-menu__kbd">{it.shortcut}</kbd>}
        {isToggle && <span className="tb-menu__check" aria-hidden="true">{it.checked ? <Icon icon={Check} size="sm" /> : null}</span>}
      </button>
    );
  };

  // 收起來的工具，照原本順序、每組之間一條線
  const overflowEntries: ReactNode[] = [];
  let lastGroup: string | null = null;
  for (const id of plan.overflow) {
    const t = byId.get(id);
    if (!t?.menu) continue;
    if (lastGroup !== null && lastGroup !== t.group) overflowEntries.push(<div key={'sep-' + id} className="tb-menu__sep" role="separator" />);
    overflowEntries.push(entryButton(id, t.menu));
    lastGroup = t.group;
  }
  const header = menuHeader?.(overflowSet);

  // 工具列上的：每組之間一條分隔線
  const visibleNodes: ReactNode[] = [];
  let prev: ToolDef | null = null;
  for (const id of plan.visible) {
    const t = byId.get(id);
    if (!t) continue;
    if (prev && prev.group !== t.group && !t.noSepBefore) visibleNodes.push(<span key={'sep-' + id} className="tool-sep" aria-hidden="true" />);
    const labeled = isLabeled(t.priority, plan.labelUpTo);
    visibleNodes.push(
      <div key={id} className={'tool-slot' + (t.flex ? ' tool-slot--flex' : '')} data-tool={id}>
        {t.render(labeled, plan.flexWidth[id])}
      </div>,
    );
    prev = t;
  }

  return (
    <div className="stage-scene__toolbar-row" ref={rowRef}>
      <div
        ref={toolbarRef}
        className={'stage-scene__toolbar' + (className ? ' ' + className : '') + (plan.overfull ? ' is-overfull' : '')}
        role="toolbar"
        aria-label="3D 工具列"
        data-label-mode={plan.labelUpTo === Infinity ? 'all' : plan.labelUpTo < 0 ? 'none' : 'some'}
      >
        {visibleNodes}
        {plan.showMore && (
          <button
            ref={moreRef}
            type="button"
            className={'tool tool--icon tool--more' + (menuOpen ? ' is-active' : '')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={plan.overflow.length > 0 ? `更多工具（還有 ${plan.overflow.filter(id => byId.get(id)?.menu).length} 個收在這裡）` : '更多：LED 對位圖'}
            aria-label="更多工具"
            onClick={() => onMenuOpenChange(!menuOpen)}
          ><Icon icon={Ellipsis} size="md" /></button>
        )}
      </div>

      {menuOpen && plan.showMore && (
        <div
          ref={menuRef}
          className="tb-menu"
          role="menu"
          aria-label="更多工具"
          onKeyDown={onMenuKeyDown}
        >
          {header && <div className="tb-menu__header">{header}</div>}
          {overflowEntries}
          {sections.map((s, i) => (
            <div key={s.id} role="group" aria-label={typeof s.title === 'string' ? s.title : undefined} className="tb-menu__section">
              {(i > 0 || overflowEntries.length > 0 || header) && <div className="tb-menu__sep" role="separator" />}
              <div className="tb-menu__title">{s.title}</div>
              {s.items.map((it, k) => entryButton(s.id + ':' + k, it))}
              {s.note && <div className="tb-menu__note">{s.note}</div>}
            </div>
          ))}
        </div>
      )}

      {children}

      {/* 量寬度用（看不到）：每個工具帶字 / 只剩圖示各一份 */}
      <div ref={measureRef} className="stage-scene__toolbar stage-scene__toolbar--measure" aria-hidden="true">
        {tools.map(t => (
          <div key={t.id + ':1'} className="tool-slot" data-mid={t.id + ':1'}>{t.render(true)}</div>
        ))}
        {tools.map(t => (
          <div key={t.id + ':0'} className="tool-slot" data-mid={t.id + ':0'}>{t.render(false)}</div>
        ))}
        <div className="tool-slot" data-mid="__sep"><span className="tool-sep" /></div>
        <div className="tool-slot" data-mid="__more"><span className="tool tool--icon"><Icon icon={Ellipsis} size="md" /></span></div>
      </div>
    </div>
  );
}
