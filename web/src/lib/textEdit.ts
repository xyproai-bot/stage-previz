// 「改一段文字」的小判斷：輸入對話框回來的字，要不要存。
//   - 按了取消（null）→ 什麼都不做
//   - 跟原本一樣（前後空白不算）→ 不用送出
//   - 其他 → 存下去（前後空白去掉、超過字數上限的切掉；清成空白 = 把這段文字拿掉）
// 例：影片版本的說明、Show 的說明。

export type TextEditResult =
  | { kind: 'cancel' }
  | { kind: 'same' }
  | { kind: 'save'; value: string };

export function textEditResult(current: string | null | undefined, input: string | null, maxLength?: number): TextEditResult {
  if (input === null) return { kind: 'cancel' };
  let value = input.trim();
  if (maxLength !== undefined && maxLength >= 0 && value.length > maxLength) value = value.slice(0, maxLength).trimEnd();
  if (value === (current ?? '').trim()) return { kind: 'same' };
  return { kind: 'save', value };
}
