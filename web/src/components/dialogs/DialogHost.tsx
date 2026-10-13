// 站內對話框的畫面（確認 / 輸入 / 選一個），放在 App 最外層一次。
//
//   - 鍵盤：Esc = 取消；Enter = 確定（輸入中文選字時不算；焦點在別的按鈕上 = 按那個按鈕）；Tab 只在對話框裡面轉
//   - 開著的時候，後面的頁面不能點、不能用快捷鍵（J/K、C、Ctrl+Z…都不會觸發）
//   - 關掉後焦點回到原本的按鈕
//   - 會刪掉 / 弄不回來的動作：紅色按鈕，按鈕上寫動作（「刪除」不是「確定」）
//   - 手機：靠上（不會被鍵盤蓋住）、按鈕夠大
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { TriangleAlert } from 'lucide-react';
import Icon from '../Icon';
import { dialogs, primaryChoice, type DialogRequest } from './dialogStore';
import './DialogHost.css';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function useCurrentDialog(): DialogRequest | null {
  const queue = useSyncExternalStore(
    (cb) => dialogs.subscribe(cb),
    () => dialogs.snapshot(),
    () => dialogs.snapshot(),
  );
  return queue[0] ?? null;
}

export default function DialogHost() {
  const req = useCurrentDialog();
  const layerRef = useRef<HTMLDivElement>(null);
  const open = !!req;

  // 打開前焦點在哪（關掉後回去）：要在對話框把焦點搶走之前記下來 → 在畫面算出來的那一刻記
  const wasOpenRef = useRef(false);
  const restoreRef = useRef<HTMLElement | null>(null);
  if (open && !wasOpenRef.current && typeof document !== 'undefined') {
    const active = document.activeElement;
    restoreRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }

  // 開著的時候：後面的頁面不能用（inert = 不能點、Tab 不會跑進去、螢幕報讀也跳過），頁面不能捲
  useLayoutEffect(() => {
    wasOpenRef.current = open;
    const layer = layerRef.current;
    const parent = layer?.parentElement;
    if (!open || !layer || !parent) return;
    const others = Array.from(parent.children).filter(
      (el): el is HTMLElement => el !== layer && el instanceof HTMLElement && !el.classList.contains('toast-container') && !el.hasAttribute('inert'),
    );
    for (const el of others) el.setAttribute('inert', '');
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      for (const el of others) el.removeAttribute('inert');
      html.style.overflow = prevOverflow;
      // 拿掉 inert 之後才能把焦點放回去
      const back = restoreRef.current;
      restoreRef.current = null;
      if (back && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [open]);

  return (
    <div ref={layerRef} className="sp-dialog-layer">
      {req && <DialogView key={req.id} req={req} />}
    </div>
  );
}

function DialogView({ req }: { req: DialogRequest }) {
  const titleId = useId();
  const descId = useId();
  const fieldId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isPrompt = req.kind === 'prompt';
  const prompt = isPrompt ? req.options : null;
  const initial = prompt?.defaultValue ?? '';
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);

  const required = prompt ? prompt.required !== false : false;
  const empty = !value.trim();
  const validation = prompt?.validate && !empty ? prompt.validate(value) : null;
  const canConfirm = !prompt || prompt.readOnly || ((!required || !empty) && !validation);
  const destructive = req.kind === 'confirm' && !!req.options.destructive;
  const { title, message, cancelLabel = '取消' } = req.options;
  const icon = req.options.icon ?? (destructive ? TriangleAlert : undefined);
  const primary = req.kind === 'choose' ? primaryChoice(req.options.choices) : null;

  function cancel() {
    dialogs.cancel(req.id);
  }
  function accept() {
    if (req.kind === 'confirm') dialogs.settle(req.id, true);
    else if (req.kind === 'prompt') {
      setTouched(true);
      if (!canConfirm) { inputRef.current?.focus(); return; }
      dialogs.settle(req.id, value);
    } else if (primary) dialogs.settle(req.id, primary.value);
  }
  const acceptRefFn = useRef(accept);
  acceptRefFn.current = accept;
  const cancelRefFn = useRef(cancel);
  cancelRefFn.current = cancel;

  // 一打開：輸入框（選好全部字）或確定按鈕拿到焦點（關掉後焦點回到原本的地方：DialogHost 處理）
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    } else {
      confirmRef.current?.focus();
    }
  }, []);

  // 鍵盤（掛在 document：React 的事件先處理完，再擋住不讓頁面的快捷鍵收到）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const panel = panelRef.current;
      if (!panel) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelRefFn.current();
      } else if (e.key === 'Enter') {
        // 輸入中文選字時按的 Enter 不算
        if (!(e.isComposing || e.keyCode === 229)) {
          const t = e.target as HTMLElement | null;
          // 焦點在按鈕上 → 讓瀏覽器按那個按鈕（取消、選項…）
          if (!(t instanceof HTMLButtonElement && panel.contains(t))) {
            e.preventDefault();
            acceptRefFn.current();
          }
        }
      } else if (e.key === 'Tab') {
        const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null || el === document.activeElement);
        if (items.length > 0) {
          const first = items[0];
          const last = items[items.length - 1];
          const active = document.activeElement as HTMLElement | null;
          if (!active || !panel.contains(active)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
          } else if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
      // 對話框開著時，頁面的快捷鍵一律收不到
      e.stopPropagation();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // 點外面 = 取消（輸入框打過字就不算，免得手滑整段不見）；按下和放開都在外面才算（從輸入框拖選文字拖到外面不會關）
  const downOnBackdrop = useRef(false);
  const dirty = isPrompt && !prompt?.readOnly && value !== initial;

  const showError = isPrompt && touched && (validation || (required && empty && !prompt?.readOnly));

  return (
    <div
      className="sp-dialog-backdrop"
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current && !dirty) cancel();
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={panelRef}
        className={'sp-dialog' + (destructive ? ' sp-dialog--danger' : '') + (isPrompt ? ' sp-dialog--prompt' : '')}
        role={req.kind === 'confirm' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? descId : undefined}
      >
        <div className="sp-dialog__head">
          {icon && (
            <span className={'sp-dialog__icon' + (destructive ? ' sp-dialog__icon--danger' : '')}>
              <Icon icon={icon} size="lg" />
            </span>
          )}
          <h2 id={titleId} className="sp-dialog__title">{title}</h2>
        </div>
        {message != null && message !== '' && (
          <div id={descId} className="sp-dialog__message">{message}</div>
        )}

        {prompt && (
          <form
            className="sp-dialog__field"
            onSubmit={(e) => { e.preventDefault(); accept(); }}
          >
            {prompt.label && <label htmlFor={fieldId} className="sp-dialog__label">{prompt.label}</label>}
            <input
              ref={inputRef}
              id={fieldId}
              className={'sp-dialog__input' + (showError ? ' is-invalid' : '')}
              type="text"
              value={value}
              readOnly={prompt.readOnly}
              placeholder={prompt.placeholder}
              maxLength={prompt.maxLength}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="done"
              aria-invalid={showError ? true : undefined}
              aria-describedby={showError || prompt.hint ? `${fieldId}-hint` : undefined}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => { if (value !== initial) setTouched(true); }}
              onFocus={(e) => { if (prompt.readOnly) e.currentTarget.select(); }}
            />
            {(showError || prompt.hint || prompt.maxLength) && (
              <div id={`${fieldId}-hint`} className={'sp-dialog__hint' + (showError ? ' is-error' : '')}>
                <span>{showError ? (validation || `${prompt.label || '這一格'}不能空白`) : prompt.hint}</span>
                {prompt.maxLength && !prompt.readOnly && <span className="sp-dialog__count">{value.length}/{prompt.maxLength}</span>}
              </div>
            )}
          </form>
        )}

        <div className="sp-dialog__actions">
          {cancelLabel !== null && (
            <button type="button" className="sp-dialog__btn sp-dialog__btn--ghost" onClick={cancel}>
              {cancelLabel}
            </button>
          )}
          {req.kind === 'choose' ? (
            req.options.choices.map(c => (
              <button
                key={c.value}
                ref={c === primary ? confirmRef : undefined}
                type="button"
                className={'sp-dialog__btn ' + (c === primary ? 'sp-dialog__btn--primary' : 'sp-dialog__btn--ghost')}
                onClick={() => dialogs.settle(req.id, c.value)}
              >
                {c.label}
              </button>
            ))
          ) : (
            <button
              ref={confirmRef}
              type="button"
              className={'sp-dialog__btn ' + (destructive ? 'sp-dialog__btn--danger' : 'sp-dialog__btn--primary')}
              onClick={accept}
              aria-disabled={!canConfirm || undefined}
            >
              {req.options.confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
