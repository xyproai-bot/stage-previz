// 編輯頁「物件狀態」：裝在機關上的物件，位置 / 角度數字欄不能改（灰掉）+ 一句說明；重置、顯示 / 隱藏、材質照舊
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CueState } from '../lib/api';
import type { Mechanism } from '../lib/mechanisms/model';
import type { EditorMechanisms } from '../lib/mechanisms/useMechanisms';
import { MechanismHintProvider } from '../components/mechanisms/MechanismObjectHint';
import { ObjectAttributePanel, ObjectAttributePanelMulti } from './ProjectEditor';

const mech = (id: string, name: string, objectIds: string[]): Mechanism => ({
  id, name, kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: 0, travelMax: 3, defaultValue: 0,
  maxSpeed: null, presets: [], parentId: null, objectIds, consoleLabel: null, order: 0, metadata: null, cueCount: 0, updatedAt: '',
});
const cueState = (objectId: string, override = true): CueState => ({
  objectId, meshName: objectId, displayName: objectId, category: 'led_panel', order: 0, locked: false,
  default: { position: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 } },
  override: override ? { position: { x: 1, y: 2, z: 3 }, rotation: null, scale: null, visible: null, customProps: null, updatedAt: '' } : null,
  effective: { position: { x: 1, y: 2, z: 3 }, rotation: { pitch: 0, yaw: 10, roll: 0 }, scale: { x: 1, y: 1, z: 1 }, visible: true },
});

/** 只有這個頁面的畫面用得到 mechanisms / targets / status */
const ctx = (mechanisms: Mechanism[], status: 'loading' | 'ready' | 'error' = 'ready') =>
  ({ mechanisms, targets: {}, status }) as unknown as EditorMechanisms;

const noop = async () => {};
const single = (objectId: string, value: EditorMechanisms | null) => renderToStaticMarkup(
  <MechanismHintProvider value={value as EditorMechanisms}>
    <ObjectAttributePanel
      state={cueState(objectId)} scaleCorrection={1} unitsReady
      onSet={noop} onReset={noop} onUpdateMaterial={noop} onUpdateLed={noop}
    />
  </MechanismHintProvider>,
);
const multi = (ids: string[], value: EditorMechanisms | null) => renderToStaticMarkup(
  <MechanismHintProvider value={value as EditorMechanisms}>
    <ObjectAttributePanelMulti
      selectedStates={ids.map(id => cueState(id))} scaleCorrection={1} unitsReady
      onSet={noop} onReset={noop} onUpdateMaterial={noop}
    />
  </MechanismHintProvider>,
);

/** 位置（3 格）+ 角度（3 格）一共 6 個數字欄；回傳灰掉（disabled）的有幾個 */
const disabledFields = (html: string) => (html.match(/<input type="text" inputMode="decimal"[^>]*>/g) ?? []).filter(t => /\sdisabled(=|\s|>)/.test(t)).length;
const allFields = (html: string) => (html.match(/<input type="text" inputMode="decimal"[^>]*>/g) ?? []).length;

const LOCK_SENTENCE = '這個物件裝在「中央升降台」上，只能用機關的滑桿動（不會超過上下限）';

describe('物件狀態：單選', () => {
  const lift = mech('m1', '中央升降台', ['led1']);

  it('裝在機關上的物件：位置 3 格、角度 3 格都灰掉，旁邊寫那一句話', () => {
    const html = single('led1', ctx([lift]));
    expect(allFields(html)).toBe(6);
    expect(disabledFields(html)).toBe(6);
    expect(html).toContain(LOCK_SENTENCE);
    expect(html).toContain('data-testid="mech-lock-note"');
  });

  it('重置按鈕照舊在（可以把以前拖歪的清掉）', () => {
    expect(single('led1', ctx([lift]))).toContain('重置');
  });

  it('沒裝在機關上的物件：數字欄照舊能改，沒有那句話', () => {
    const html = single('speaker', ctx([lift]));
    expect(disabledFields(html)).toBe(0);
    expect(html).not.toContain('mech-lock-note');
    expect(html).not.toContain('只能用機關的滑桿動');
  });

  it('專案沒有機關 / 這頁沒有機關資料：照舊能改', () => {
    expect(disabledFields(single('led1', ctx([])))).toBe(0);
    expect(disabledFields(single('led1', null))).toBe(0);
  });

  it('機關清單還在讀：先灰掉（讀到之前分不出來），但沒有那句話', () => {
    const html = single('speaker', ctx([], 'loading'));
    expect(disabledFields(html)).toBe(6);
    expect(html).not.toContain('mech-lock-note');
  });

  it('機關清單讀失敗（讀成空的）：不鎖，照舊能改', () => {
    expect(disabledFields(single('led1', ctx([], 'error')))).toBe(0);
  });

  it('吊掛整組帶的物件也鎖', () => {
    const rig = { ...mech('rig', '吊掛一組', ['truss']), variant: 'hoist_rig' as const };
    const html = single('truss', ctx([rig]));
    expect(disabledFields(html)).toBe(6);
    expect(html).toContain('這個物件裝在「吊掛一組」上');
  });
});

describe('物件狀態：多選', () => {
  const lift = mech('m1', '中央升降台', ['led1']);

  it('只要有一個裝在機關上，位置 / 角度整組都灰掉，寫那一句話', () => {
    const html = multi(['speaker', 'led1'], ctx([lift]));
    expect(allFields(html)).toBe(6);
    expect(disabledFields(html)).toBe(6);
    expect(html).toContain('選到的物件裡有裝在「中央升降台」上的');
    expect(html).toContain('不會超過上下限');
  });

  it('材質顏色、全部重置照舊能用', () => {
    const html = multi(['speaker', 'led1'], ctx([lift]));
    expect(html).toContain('全部重置成預設');
    expect(html).toContain('材質顏色');
    expect(html).not.toMatch(/<input type="color"[^>]*disabled/);
  });

  it('都沒裝在機關上：照舊能改', () => {
    const html = multi(['speaker', 'piano'], ctx([lift]));
    expect(disabledFields(html)).toBe(0);
    expect(html).not.toContain('mech-lock-note');
  });
});
