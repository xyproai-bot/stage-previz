import { describe, expect, it } from 'vitest';
import { isTextEntryTarget, isTypingTarget } from './keyTarget';

const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra }) as unknown as EventTarget;

describe('isTextEntryTarget（Ctrl+Z 要不要讓給欄位）', () => {
  it('文字框、多行文字、可編輯區塊 → 讓給瀏覽器', () => {
    expect(isTextEntryTarget(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isTextEntryTarget(el('INPUT', { type: 'number' }))).toBe(true);
    expect(isTextEntryTarget(el('INPUT', { type: 'search' }))).toBe(true);
    expect(isTextEntryTarget(el('INPUT', {}))).toBe(true);  // 沒寫 type = text
    expect(isTextEntryTarget(el('TEXTAREA'))).toBe(true);
    expect(isTextEntryTarget(el('DIV', { isContentEditable: true }))).toBe(true);
  });
  it('勾選框、滑桿、按鈕、下拉選單 → 照樣復原 / 重做', () => {
    expect(isTextEntryTarget(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isTextEntryTarget(el('INPUT', { type: 'range' }))).toBe(false);
    expect(isTextEntryTarget(el('INPUT', { type: 'radio' }))).toBe(false);
    expect(isTextEntryTarget(el('BUTTON'))).toBe(false);
    expect(isTextEntryTarget(el('SELECT'))).toBe(false);
    expect(isTextEntryTarget(el('BODY'))).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

describe('isTypingTarget（J / K 這種字母快捷鍵）', () => {
  it('下拉選單也讓（打字會跳到那個選項）', () => {
    expect(isTypingTarget(el('SELECT'))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'text' }))).toBe(true);
  });
  it('勾選框、滑桿照樣切歌', () => {
    expect(isTypingTarget(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isTypingTarget(el('INPUT', { type: 'range' }))).toBe(false);
  });
});
