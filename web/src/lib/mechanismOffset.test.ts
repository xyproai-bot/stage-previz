import { describe, it, expect } from 'vitest';
import { cuePositionFromScene } from './mechanismOffset';
import { scenePosition } from './cueTimeline';

describe('cuePositionFromScene（3D 拖 LED 後存回 cue 的位置，要扣掉機關位移）', () => {
  const offsets = { led: { x: 2, y: 1 } };

  it('LED 有機關位移：拖到哪就停在哪（存的位置再加回位移 = 放手的位置，不會跳）', () => {
    // cue 存 (1, 1, 3)，機關 +2m / +1m，校準 ×2 → 畫面上在 (2, 1.5, 3)
    const shown = scenePosition({ x: 1, y: 1, z: 3 }, 'led_panel', 'led', offsets, 2);
    expect(shown).toEqual({ x: 2, y: 1.5, z: 3 });
    // 往右拖 1 → 放手在 (3, 1.5, 3)
    const dropped = { x: shown.x + 1, y: shown.y, z: shown.z };
    const saved = cuePositionFromScene(dropped, 'led_panel', 'led', offsets, 2);
    expect(saved).toEqual({ x: 2, y: 1, z: 3 });
    // 存完重畫：還是在放手的位置
    expect(scenePosition(saved, 'led_panel', 'led', offsets, 2)).toEqual(dropped);
  });

  it('只轉不移：存回去的位置跟原本 cue 一樣（以前會多加一次位移）', () => {
    const cue = { x: -4.25, y: 0.5, z: 7 };
    const shown = scenePosition(cue, 'led_panel', 'led', offsets, 1.6);
    const saved = cuePositionFromScene(shown, 'led_panel', 'led', offsets, 1.6);
    expect(saved.x).toBeCloseTo(cue.x, 10);
    expect(saved.y).toBeCloseTo(cue.y, 10);
    expect(saved.z).toBe(cue.z);
  });

  it('不是 LED 面板 → 不扣（機關滑桿本來就不動它）', () => {
    const p = { x: 3, y: 1.5, z: 3 };
    expect(cuePositionFromScene(p, 'mechanism', 'led', offsets, 2)).toEqual(p);
    expect(cuePositionFromScene(p, undefined, 'led', offsets, 2)).toEqual(p);
  });

  it('沒有這片 LED 的位移 / 沒有位移資料 → 原樣', () => {
    const p = { x: 3, y: 1.5, z: 3 };
    expect(cuePositionFromScene(p, 'led_panel', 'other-led', offsets, 2)).toEqual(p);
    expect(cuePositionFromScene(p, 'led_panel', 'led', undefined, 2)).toEqual(p);
  });

  it('回傳新的物件，不改到傳進來的', () => {
    const p = { x: 1, y: 2, z: 3 };
    const out = cuePositionFromScene(p, 'mechanism', 'm', undefined, 1);
    expect(out).not.toBe(p);
  });
});
