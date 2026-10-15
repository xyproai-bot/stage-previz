import { useEffect, useState } from 'react';

/**
 * 整數輸入欄：打到一半（還不是合法的整數）先不改外面的數字，離開欄位時補回外面現在的值；
 * 外面的數字變了（拖曳、微調）而你沒有在打字時，欄位跟著變 —— 所以可以跟畫面上的拖拉雙向連動。
 * 上下鍵加減 1（Shift 10）。
 */
interface Props {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  label: string;
  className?: string;
}

export default function NumField({ value, onChange, min = -65536, max = 65536, disabled, label, className }: Props) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(String(value)); }, [value, focused]);

  const apply = (raw: string): boolean => {
    if (!/^\s*-?\d+\s*$/.test(raw)) return false;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return false;
    if (n !== value) onChange(n);
    return true;
  };

  return (
    <input
      className={className}
      inputMode="numeric"
      value={text}
      disabled={disabled}
      aria-label={label}
      title={label}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); setText(String(value)); }}
      onChange={(e) => { setText(e.target.value); apply(e.target.value); }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const next = Math.min(max, Math.max(min, value + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)));
          setText(String(next));
          if (next !== value) onChange(next);
        } else if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
