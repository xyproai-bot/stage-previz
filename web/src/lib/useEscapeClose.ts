// 視窗開著時按 Esc 關掉（跟站內確認框一樣）
// 站內確認框（DialogHost）開在上面時，它自己處理 Esc 並擋住事件，不會把底下這個也一起關掉；打中文選字時的 Esc 不算
import { useEffect, useRef } from 'react';

export function useEscapeClose(open: boolean, onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}
