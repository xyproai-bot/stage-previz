import { describe, expect, it } from 'vitest';
import { textEditResult } from './textEdit';

describe('textEditResult：改一段文字要不要存', () => {
  it('按取消 → 什麼都不做', () => {
    expect(textEditResult('原本的', null)).toEqual({ kind: 'cancel' });
  });

  it('跟原本一樣（前後空白不算）→ 不用送出', () => {
    expect(textEditResult('修了轉場', '修了轉場')).toEqual({ kind: 'same' });
    expect(textEditResult('修了轉場', '  修了轉場  ')).toEqual({ kind: 'same' });
    expect(textEditResult('  修了轉場 ', '修了轉場')).toEqual({ kind: 'same' });
  });

  it('原本沒有、還是空白 → 一樣', () => {
    expect(textEditResult('', '')).toEqual({ kind: 'same' });
    expect(textEditResult(null, '   ')).toEqual({ kind: 'same' });
    expect(textEditResult(undefined, '')).toEqual({ kind: 'same' });
  });

  it('改了 → 存，前後空白去掉', () => {
    expect(textEditResult('舊的', '  新的說明 ')).toEqual({ kind: 'save', value: '新的說明' });
  });

  it('清成空白 = 把說明拿掉（存空字串）', () => {
    expect(textEditResult('舊的', '')).toEqual({ kind: 'save', value: '' });
    expect(textEditResult('舊的', '   ')).toEqual({ kind: 'save', value: '' });
  });

  it('超過字數上限 → 切掉', () => {
    expect(textEditResult('', '一二三四五六', 4)).toEqual({ kind: 'save', value: '一二三四' });
    // 切掉以後跟原本一樣 → 不用送
    expect(textEditResult('一二三四', '一二三四五六', 4)).toEqual({ kind: 'same' });
  });
});
