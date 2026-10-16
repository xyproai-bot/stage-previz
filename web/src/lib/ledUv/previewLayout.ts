// 自動貼 UV：排版預覽 / 套用後下載用的「對位圖版面」（純函式）
// 每一片螢幕（或保留的物件）一塊長方形；用的是跟模型真的寫進去的 UV 一樣的長方形（套用時已經逐一檢查過）。

import { buildLedLayout, type LedLayout, type LedPanelInput } from '../ledMap';
import type { Plan } from './plan';

function rectTris(x: number, y: number, w: number, h: number, canvas: { width: number; height: number }): number[] {
  const u0 = x / canvas.width, v0 = y / canvas.height, u1 = (x + w) / canvas.width, v1 = (y + h) / canvas.height;
  return [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1];
}

export function previewPanels(plan: Plan): LedPanelInput[] {
  const out: LedPanelInput[] = [];
  for (const o of plan.objects) {
    if (o.mode === 'auto') {
      for (const p of o.pieces) if (p.placed) out.push({ id: p.key, name: p.name, tris: rectTris(p.placed.x, p.placed.y, p.placed.w, p.placed.h, plan.canvas) });
    } else if (o.mode === 'keep' && o.keep) {
      out.push({ id: o.id, name: o.name, tris: rectTris(o.keep.placed.x, o.keep.placed.y, o.keep.rect.w, o.keep.rect.h, plan.canvas) });
    }
  }
  return out;
}

export function previewLayout(plan: Plan): LedLayout {
  return buildLedLayout(previewPanels(plan), plan.canvas);
}
