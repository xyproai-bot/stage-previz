import { useEffect, useRef, useState } from 'react';
import { LED_CANVAS_RANGE, normalizeLedCanvas, sameLedCanvas, type LedCanvas } from '../lib/ledCanvas';

interface Props {
  value: LedCanvas | null;
  /** null = 清掉 */
  onChange: (v: LedCanvas | null) => void;
}

const toText = (v: LedCanvas | null) => ({ w: v ? String(v.width) : '', h: v ? String(v.height) : '' });

/**
 * AE 畫布尺寸（寬 × 高，像素）：admin 每個專案填一次。
 * 動畫師用 NDI Webcam 預覽時，要靠這個把 16:9 的畫面放回 LED 的 UV 排版上。
 * 按 Enter 或離開這兩格才存（寬 → 高之間用 Tab 跳不會先存一半）；Esc 回到已存的值。
 * 可以直接在寬那格貼「10496x5120」，會自己拆成寬高。
 */
export default function LedCanvasField({ value, onChange }: Props) {
  const [draft, setDraft] = useState(() => toText(value));
  const [error, setError] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef<HTMLInputElement>(null);
  // Esc 之後馬上 blur：這次離開不要存（state 還沒更新，會拿到改到一半的值）
  const skipBlurCommitRef = useRef(false);

  // 專案載入 / 別處改了 → 跟著顯示已存的值
  useEffect(() => {
    setDraft(toText(value));
    setError(false);
  }, [value?.width, value?.height]);  // eslint-disable-line react-hooks/exhaustive-deps

  const commit = () => {
    const w = draft.w.trim(), h = draft.h.trim();
    if (!w && !h) {
      setError(false);
      if (value) onChange(null);
      return;
    }
    const next = normalizeLedCanvas({ width: w, height: h });
    if (!next) { setError(true); return; }
    setError(false);
    setDraft(toText(next));
    if (!sameLedCanvas(next, value)) onChange(next);
  };

  const revert = () => {
    setDraft(toText(value));
    setError(false);
  };

  const onWidthChange = (text: string) => {
    // 貼上「10496x5120」「10496 × 5120」→ 拆成寬高
    const m = text.match(/^\s*(\d+)\s*[x×X*,]\s*(\d+)\s*$/);
    if (m) setDraft({ w: m[1], h: m[2] });
    else setDraft(d => ({ ...d, w: text }));
    setError(false);
  };

  const onKeyDown = (which: 'w' | 'h') => (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();  // 不要觸發編輯器的快捷鍵（Delete / 數字鍵等）
    if (e.key === 'Enter') {
      e.preventDefault();
      // 寬填好、高還空著 → 跳去高那格
      if (which === 'w' && draft.w.trim() && !draft.h.trim()) { heightRef.current?.focus(); return; }
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      revert();
      skipBlurCommitRef.current = true;
      (e.target as HTMLInputElement).blur();
      skipBlurCommitRef.current = false;
    }
  };

  // 焦點離開整組（不是在寬高兩格之間移動）才存
  const onBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (skipBlurCommitRef.current) return;
    if (groupRef.current && e.relatedTarget instanceof Node && groupRef.current.contains(e.relatedTarget)) return;
    commit();
  };

  const [min, max] = LED_CANVAS_RANGE;
  const dirty = draft.w.trim() !== (value ? String(value.width) : '') || draft.h.trim() !== (value ? String(value.height) : '');

  return (
    <div className="led-canvas-field" data-ui-element>
      <div className="led-canvas-field__head">
        <span className="led-canvas-field__title">AE 畫布尺寸</span>
        <button
          type="button"
          className="led-canvas-field__clear"
          onMouseDown={e => e.preventDefault()}  // 不搶焦點：不然輸入格先 blur 會先存一次再清掉
          onClick={() => { setDraft({ w: '', h: '' }); setError(false); if (value) onChange(null); }}
          disabled={!value && !draft.w && !draft.h}
          title="清掉 AE 畫布尺寸"
          aria-label="清掉 AE 畫布尺寸"
        >✕</button>
      </div>
      <div className="led-canvas-field__inputs" ref={groupRef} onBlur={onBlur}>
        <input
          type="text"
          inputMode="numeric"
          className={'led-canvas-field__input' + (error ? ' is-error' : '')}
          value={draft.w}
          placeholder="寬"
          aria-label="AE 合成寬度（像素）"
          onChange={e => onWidthChange(e.target.value)}
          onKeyDown={onKeyDown('w')}
        />
        <span className="led-canvas-field__x">×</span>
        <input
          ref={heightRef}
          type="text"
          inputMode="numeric"
          className={'led-canvas-field__input' + (error ? ' is-error' : '')}
          value={draft.h}
          placeholder="高"
          aria-label="AE 合成高度（像素）"
          onChange={e => { setDraft(d => ({ ...d, h: e.target.value })); setError(false); }}
          onKeyDown={onKeyDown('h')}
        />
        <span className="led-canvas-field__unit">px</span>
        {dirty && !error && <span className="led-canvas-field__pending" title="按 Enter 或點別的地方就會存">未存</span>}
      </div>
      <div className={'led-canvas-field__hint' + (error ? ' is-error' : '')}>
        {error
          ? `寬高要填 ${min}~${max} 的整數（Esc 回到原本的）`
          : '動畫師用 NDI Webcam 預覽時需要，填 AE 合成的寬高'}
      </div>
    </div>
  );
}
