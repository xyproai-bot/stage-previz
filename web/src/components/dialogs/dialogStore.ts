// 站內對話框（取代瀏覽器的 confirm() / prompt()）的「排隊」和「回答」：純邏輯，畫面在 DialogHost.tsx。
//
// 用法（任何地方都能叫，回傳 Promise）：
//   if (!(await confirmDialog({ title: '刪除歌曲「S03」？', message: '它的 cue 會一起刪掉。', confirmLabel: '刪除', destructive: true }))) return;
//   const name = await promptDialog({ title: '新增歌曲', label: '歌名', placeholder: '例：S03 主題曲', confirmLabel: '新增' });
//   const scope = await chooseDialog({ title: '要給誰用？', choices: [{ value: 'project', label: '只給這個專案' }, ...] });
//
// 一次只顯示一個；前一個還沒回答，下一個先排隊。取消（Esc、按取消、點外面）→ confirm 回 false、其他回 null。

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface BaseOptions {
  /** 標題（一句話問清楚，例：刪除 cue「開場」？） */
  title: string;
  /** 補充說明（會發生什麼事）；字串裡的換行會照樣顯示 */
  message?: ReactNode;
  /** 取消按鈕的字（預設「取消」）；null = 不要取消按鈕（例：只是給你看一個連結） */
  cancelLabel?: string | null;
  /** 標題旁的圖示（destructive 預設是警告三角形） */
  icon?: LucideIcon;
}

export interface ConfirmOptions extends BaseOptions {
  /** 確定按鈕的字：寫動作本身（「刪除」「封存」「登出」），不要寫「確定」 */
  confirmLabel: string;
  /** 會刪掉 / 弄不回來的動作：紅色按鈕 */
  destructive?: boolean;
}

export interface PromptOptions extends BaseOptions {
  /** 輸入框上面的字（例：歌名） */
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  /** 確定按鈕的字（「新增」「改名」「儲存」） */
  confirmLabel: string;
  /** 一定要填（預設 true）：空白時確定按鈕不能按 */
  required?: boolean;
  maxLength?: number;
  /** 輸入框下面的小字 */
  hint?: string;
  /** 只能看、不能改（例：瀏覽器不准複製時，把連結顯示出來讓人自己選） */
  readOnly?: boolean;
  /** 檢查輸入；回傳要顯示的錯誤（中文），沒問題回 null */
  validate?: (value: string) => string | null;
}

export interface Choice {
  value: string;
  label: string;
  /** 主要選項（綠色、按 Enter 就是選它）；沒有標的話第一個是主要 */
  primary?: boolean;
}

export interface ChooseOptions extends BaseOptions {
  choices: Choice[];
}

export type DialogRequest =
  | { id: number; kind: 'confirm'; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { id: number; kind: 'prompt'; options: PromptOptions; resolve: (v: string | null) => void }
  | { id: number; kind: 'choose'; options: ChooseOptions; resolve: (v: string | null) => void };

type Listener = (queue: readonly DialogRequest[]) => void;

export class DialogStore {
  private queue: readonly DialogRequest[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;

  snapshot(): readonly DialogRequest[] { return this.queue; }

  /** 現在顯示的那一個（排在最前面的） */
  current(): DialogRequest | null { return this.queue[0] ?? null; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise(resolve => this.push({ id: this.nextId++, kind: 'confirm', options, resolve }));
  }

  prompt(options: PromptOptions): Promise<string | null> {
    return new Promise(resolve => this.push({ id: this.nextId++, kind: 'prompt', options, resolve }));
  }

  choose(options: ChooseOptions): Promise<string | null> {
    return new Promise(resolve => this.push({ id: this.nextId++, kind: 'choose', options, resolve }));
  }

  /**
   * 回答某一個（只認還在排隊的；回答過的再回答一次不理）。
   * value：confirm = true / false；prompt / choose = 字串或 null（取消）
   */
  settle(id: number, value: boolean | string | null): void {
    const req = this.queue.find(r => r.id === id);
    if (!req) return;
    this.queue = this.queue.filter(r => r.id !== id);
    this.emit();
    if (req.kind === 'confirm') req.resolve(value === true);
    else req.resolve(typeof value === 'string' ? value : null);
  }

  /** 取消某一個（confirm → false，其他 → null） */
  cancel(id: number): void {
    this.settle(id, null);
  }

  private push(req: DialogRequest) {
    this.queue = [...this.queue, req];
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l(this.queue);
  }
}

/** 全站共用的一份（DialogHost 顯示它） */
export const dialogs = new DialogStore();

/** 確認對話框：按確定 → true；取消 / Esc / 點外面 → false */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return dialogs.confirm(options);
}

/** 輸入對話框：回傳輸入的字（沒有自動去掉前後空白）；取消 → null */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return dialogs.prompt(options);
}

/** 選一個：回傳選到的 value；取消 → null */
export function chooseDialog(options: ChooseOptions): Promise<string | null> {
  return dialogs.choose(options);
}

/**
 * 舊的「一整段文字」（第一段是問題、空一行之後是說明）→ 標題 + 說明。
 * 例：'要刪掉 V2 嗎？\n\n刪掉後…' → { title: '要刪掉 V2 嗎？', message: '刪掉後…' }
 */
export function splitQuestion(text: string): { title: string; message?: string } {
  const i = text.indexOf('\n\n');
  if (i < 0) return { title: text.trim() };
  const message = text.slice(i + 2).trim();
  return message ? { title: text.slice(0, i).trim(), message } : { title: text.slice(0, i).trim() };
}

/** 主要選項：有標 primary 的那個，沒有就第一個 */
export function primaryChoice(choices: readonly Choice[]): Choice | null {
  return choices.find(c => c.primary) ?? choices[0] ?? null;
}
