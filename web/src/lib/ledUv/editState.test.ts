// 自動貼 UV：排到一半的東西存起來 / 讀回來（後台、別人、舊版本寫的都不能信）
import { describe, expect, it } from 'vitest';
import { EMPTY_FORM } from './sizeForm';
import { editSignature, parseEditSnapshot, pruneEditSnapshot, type UvEditSnapshot } from './editState';

const SNAP: UvEditSnapshot = {
  v: 1,
  selected: { so_a: true, so_b: false },
  forms: { 'o:so_a': { ...EMPTY_FORM, pitch: '3.9' }, 'o:so_c#1': { ...EMPTY_FORM, mode: 'pixels', pw: '3077', ph: '1026' } },
  overrides: { so_a: 'arc' },
  gutter: '8',
  arrangement: {
    v: 1, canvasMode: 'custom', canvas: { width: 8800, height: 2024 },
    items: [{ key: 'o:so_a', x: 0, y: 387, rotate: 90, flipH: true, flipV: false }, { key: 'o:so_c#1', x: 10, y: 20, rotate: 0, flipH: false, flipV: false }],
    groups: [['o:so_a', 'o:so_c#1']],
  },
};

describe('editState', () => {
  it('存成 JSON 再讀回來一模一樣（含轉動、翻轉、連在一起、自己填的畫布）', () => {
    expect(parseEditSnapshot(JSON.parse(JSON.stringify(SNAP)))).toEqual(SNAP);
    expect(editSignature(SNAP)).toBe(editSignature(parseEditSnapshot(JSON.parse(JSON.stringify(SNAP)))!));
  });

  it('沒動過排法 = null 也讀得回來', () => {
    const s = { ...SNAP, arrangement: null };
    expect(parseEditSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('格式不對的整份丟掉（回 null，從頭開始）；壞掉的單筆跳過；多的欄位忽略', () => {
    expect(parseEditSnapshot(null)).toBeNull();
    expect(parseEditSnapshot([])).toBeNull();
    expect(parseEditSnapshot({ v: 2 })).toBeNull();
    // 排法壞掉 → 整份不用（不要拿一半的排法）
    expect(parseEditSnapshot({ ...SNAP, arrangement: { v: 1, items: [{ key: 'a', x: 1.5, y: 0, rotate: 0, flipH: false, flipV: false }] } })).toBeNull();
    const dirty = parseEditSnapshot({
      v: 1, extra: 'x', selected: { a: true, b: 'yes' }, overrides: { a: 'auto', b: 'arc', c: 'weird' }, gutter: 'abc',
      forms: { ok: { mode: 'pitch', pitch: '3.9' }, badMode: { mode: 'x' }, tooLong: { mode: 'pitch', pitch: 'x'.repeat(100) } },
    })!;
    expect(dirty.selected).toEqual({ a: true });
    expect(dirty.overrides).toEqual({ b: 'arc' });
    expect(dirty.gutter).toBe('0');
    expect(Object.keys(dirty.forms)).toEqual(['ok']);
    expect(dirty.forms.ok).toEqual({ ...EMPTY_FORM, pitch: '3.9' });
    expect(dirty.arrangement).toBeNull();
  });

  it('模型換過了、物件不見了：只留還在的物件和它的螢幕片', () => {
    const p = pruneEditSnapshot(SNAP, new Set(['so_a']));
    expect(p.selected).toEqual({ so_a: true });
    expect(Object.keys(p.forms)).toEqual(['o:so_a']);
    expect(p.overrides).toEqual({ so_a: 'arc' });
  });
});
