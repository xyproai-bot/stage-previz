// 全域 toast 通知（取代 alert / confirm 的失敗訊息）
//
// 用法：
//   import { toast } from '../lib/toast';
//   toast.success('已存好');
//   toast.error('存檔失敗：' + err.message);
//   toast.info('已複製連結');
//
// 顯示在右下角，滑入動畫 + 自動消失（success 3s / info 4s / error 6s）

import { useEffect, useState } from 'react';

export type ToastKind = 'success' | 'info' | 'warn' | 'error';

export interface ToastItem {
  id: string;
  kind: ToastKind;
  text: string;
  durationMs: number;
}

type Listener = (items: ToastItem[]) => void;

const DEFAULT_DURATIONS: Record<ToastKind, number> = {
  success: 3000,
  info: 4000,
  warn: 5000,
  error: 6000,
};

class ToastStore {
  items: ToastItem[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;

  push(kind: ToastKind, text: string, durationMs?: number): string {
    const id = 't' + this.nextId++;
    const item: ToastItem = { id, kind, text, durationMs: durationMs ?? DEFAULT_DURATIONS[kind] };
    this.items = [...this.items, item];
    this.notify();
    if (item.durationMs > 0) {
      setTimeout(() => this.dismiss(id), item.durationMs);
    }
    return id;
  }

  dismiss(id: string): void {
    this.items = this.items.filter(t => t.id !== id);
    this.notify();
  }

  success(text: string, durationMs?: number) { return this.push('success', text, durationMs); }
  info(text: string, durationMs?: number)    { return this.push('info', text, durationMs); }
  warn(text: string, durationMs?: number)    { return this.push('warn', text, durationMs); }
  error(text: string, durationMs?: number)   { return this.push('error', text, durationMs); }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.items);
    return () => { this.listeners.delete(fn); };
  }

  private notify() {
    for (const l of this.listeners) l(this.items);
  }
}

export const toast = new ToastStore();

export function useToasts(): ToastItem[] {
  const [items, setItems] = useState<ToastItem[]>(toast.items);
  useEffect(() => toast.subscribe(setItems), []);
  return items;
}
