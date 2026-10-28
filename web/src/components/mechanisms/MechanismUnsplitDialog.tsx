// 「拆成兩個各自動的機關」的確認框（用站內的確認對話框，不是瀏覽器的 confirm）：
// 說明會發生什麼事 + 兩個名字可以在框裡改；名字不合（空白 / 兩個一樣 / 跟別的機關重複）→ 框會再出現一次，寫出哪裡不對，已經打的字還在。
import { useId } from 'react';
import { Split } from 'lucide-react';
import { confirmDialog } from '../dialogs';
import type { Mechanism } from '../../lib/mechanisms/model';
import { defaultUnsplitNames, planUnsplit } from '../../lib/mechanisms/unsplit';

/** 框裡兩個名字（輸入的時候直接改這個物件，按確定後讀回來） */
export interface UnsplitNames { a: string; b: string }

export function UnsplitMessage({ names, sidesText, error }: { names: UnsplitNames; sidesText: string; error: string | null }) {
  const id = useId();
  return (
    <div className="mech-unsplit">
      <p>拆完 A 邊、B 邊變成兩個機關，可以各自設位置。每個 cue 現在的位置會原樣抄過去，畫面不會變。拆完不能一鍵合回去。</p>
      <p className="mech-unsplit__sides">{sidesText}</p>
      <div className="sp-dialog__field">
        <label className="sp-dialog__label" htmlFor={`${id}-a`}>A 邊的名字</label>
        <input id={`${id}-a`} className={'sp-dialog__input' + (error ? ' is-invalid' : '')} type="text" defaultValue={names.a} maxLength={40}
          autoComplete="off" spellCheck={false} onChange={e => { names.a = e.target.value; }} />
      </div>
      <div className="sp-dialog__field">
        <label className="sp-dialog__label" htmlFor={`${id}-b`}>B 邊的名字</label>
        <input id={`${id}-b`} className={'sp-dialog__input' + (error ? ' is-invalid' : '')} type="text" defaultValue={names.b} maxLength={40}
          autoComplete="off" spellCheck={false} onChange={e => { names.b = e.target.value; }} />
      </div>
      {error && <div className="sp-dialog__hint is-error" role="alert">{error}</div>}
    </div>
  );
}

/**
 * 問使用者要不要拆、兩個名字叫什麼。取消 → null；確定 → 檢查過的兩個名字。
 * @param mechanisms 這個專案所有的機關（檢查名字有沒有跟別的機關重複）
 */
export async function askUnsplitNames(m: Mechanism, mechanisms: Mechanism[]): Promise<{ nameA: string; nameB: string } | null> {
  const d = defaultUnsplitNames(m.name);
  const names: UnsplitNames = { a: d.a, b: d.b };
  const siblings = mechanisms.map(x => ({ id: x.id, name: x.name, parentId: x.parentId, variant: x.variant ?? null }));
  const bCount = m.objectIds.filter(id => m.objectSides?.[id] === 'b').length;
  const sidesText = `A 邊 ${m.objectIds.length - bCount} 個物件，B 邊 ${bCount} 個物件。`;
  let error: string | null = null;
  for (;;) {
    const ok = await confirmDialog({
      title: `把「${m.name}」拆成兩個各自動的機關？`,
      message: <UnsplitMessage names={names} sidesText={sidesText} error={error} />,
      confirmLabel: '拆開',
      icon: Split,
    });
    if (!ok) return null;
    const plan = planUnsplit(m, { nameA: names.a, nameB: names.b }, siblings);
    if (plan.ok) return { nameA: plan.value.nameA, nameB: plan.value.nameB };
    error = plan.error;
  }
}
