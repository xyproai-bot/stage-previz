import { describe, expect, it } from 'vitest';
import { clampPanelWidth } from './usePanelWidth';

describe('編輯頁兩欄調寬：寬度範圍', () => {
  it('在最小、最大之間照拖的寬度', () => {
    expect(clampPanelWidth(420, 300, 800, 1920)).toBe(420);
  });
  it('太窄 → 最小值；太寬 → 最大值', () => {
    expect(clampPanelWidth(100, 300, 800, 1920)).toBe(300);
    expect(clampPanelWidth(5000, 300, 800, 1920)).toBe(800);
  });
  it('最大不超過視窗的一半（小螢幕不會把 3D 畫面擠掉）', () => {
    expect(clampPanelWidth(700, 300, 800, 1200)).toBe(600);
  });
  it('視窗很小時至少還有最小寬度', () => {
    expect(clampPanelWidth(700, 300, 800, 400)).toBe(300);
  });
  it('不是數字 → 最小值', () => {
    expect(clampPanelWidth(Number.NaN, 300, 800, 1920)).toBe(300);
  });
});
