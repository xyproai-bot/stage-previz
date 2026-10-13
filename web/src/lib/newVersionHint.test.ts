import { describe, it, expect } from 'vitest';
import { EMPTY_NEW_VERSION_HINT, newVersionToShow, nextNewVersionHint, type NewVersionHintInput, type NewVersionHintState } from './newVersionHint';

const V = (n: number) => ({ key: `v:${n}`, kind: 'version' as const, label: `V${n}` });
const list = (...ns: number[]) => ns.map(V);

/** 照順序餵進去，回最後的狀態 */
function run(steps: Partial<NewVersionHintInput>[], start: NewVersionHintState = EMPTY_NEW_VERSION_HINT) {
  let s = start;
  let last: NewVersionHintInput = { scope: 'song1', loaded: true, items: [], currentKey: null };
  for (const step of steps) {
    last = { ...last, ...step };
    s = nextNewVersionHint(s, last);
  }
  return { s, shown: newVersionToShow(s, last.scope, last.items, last.currentKey) };
}

describe('有新版 · 切換', () => {
  it('看 V2 看到一半交了 V3 → 出現「有新版 V3」，播放照舊停在 V2', () => {
    const { shown } = run([
      { items: list(2, 1), currentKey: 'v:2' },
      { items: list(3, 2, 1) },  // 25 秒自動更新抓到 V3；正在看的還是 V2
    ]);
    expect(shown?.label).toBe('V3');
  });

  it('按了切換（或自己點了 V3）= 看過了 → 收掉；切回 V2 也不會再出現', () => {
    const { s, shown } = run([
      { items: list(2, 1), currentKey: 'v:2' },
      { items: list(3, 2, 1) },
      { currentKey: 'v:3' },
      { currentKey: 'v:2' },
    ]);
    expect(s.arrived).toBeNull();
    expect(shown).toBeNull();
  });

  it('一打開就已經有的版本不算新來的：自己選了看 V1 的人不會被提醒', () => {
    const { shown } = run([
      { items: list(3, 2, 1), currentKey: 'v:3' },
      { currentKey: 'v:1' },
      { items: list(3, 2, 1) },
    ]);
    expect(shown).toBeNull();
  });

  it('比較 A/B 在 V3、V2 之間切也不會跳出提醒', () => {
    const { shown } = run([
      { items: list(3, 2), currentKey: 'v:3' },
      { currentKey: 'v:2' },
      { currentKey: 'v:3' },
      { currentKey: 'v:2' },
    ]);
    expect(shown).toBeNull();
  });

  it('還沒看 V3 又交了 V4 → 改成「有新版 V4」', () => {
    const { shown } = run([
      { items: list(2, 1), currentKey: 'v:2' },
      { items: list(3, 2, 1) },
      { items: list(4, 3, 2, 1) },
    ]);
    expect(shown?.label).toBe('V4');
  });

  it('新版被刪掉了 → 收掉', () => {
    const { shown } = run([
      { items: list(2, 1), currentKey: 'v:2' },
      { items: list(3, 2, 1) },
      { items: list(2, 1) },
    ]);
    expect(shown).toBeNull();
  });

  it('本來沒有影片、交了 V1（自動就放 V1）→ 不用提醒', () => {
    const { shown } = run([
      { items: [], currentKey: null },
      { items: list(1), currentKey: 'v:1' },
    ]);
    expect(shown).toBeNull();
  });

  it('沒在看影片（例：工作站在 AE 即時，也沒有選過哪一版）時進來的不提醒', () => {
    const { shown } = run([
      { items: [], currentKey: null },
      { items: list(1), currentKey: null },
    ]);
    expect(shown).toBeNull();
  });

  it('換歌 → 重來；新的一首歌還在讀清單時不算', () => {
    const a = run([
      { items: list(2, 1), currentKey: 'v:2' },
      { items: list(3, 2, 1) },
    ]);
    expect(a.shown?.label).toBe('V3');
    const b = run([
      { scope: 'song2', loaded: false, items: [], currentKey: null },
      { loaded: true, items: list(5, 4), currentKey: 'v:5' },
    ], a.s);
    expect(b.s.scope).toBe('song2');
    expect(b.shown).toBeNull();
  });

  it('還在讀清單（第一次）時不記；讀到了才當作「本來就有」', () => {
    const { s } = run([{ loaded: false, items: [] }]);
    expect(s.known).toBeNull();
    const r = run([{ loaded: false, items: [] }, { loaded: true, items: list(2, 1), currentKey: 'v:2' }]);
    expect(r.s.known).toEqual(['v:2', 'v:1']);
    expect(r.shown).toBeNull();
  });

  it('舊的 Drive 影片不會出現「有新版」', () => {
    const drive = (id: string, label: string) => ({ key: `d:${id}`, kind: 'drive' as const, label });
    const { shown } = run([
      { items: [drive('a', 'Drive 最新')], currentKey: 'd:a' },
      { items: [drive('b', 'Drive 最新'), drive('a', 'Drive 舊版 1')] },
    ]);
    expect(shown).toBeNull();
  });

  it('沒變就回同一個物件（React 不用重畫）', () => {
    const first = run([{ items: list(2, 1), currentKey: 'v:2' }]).s;
    const again = nextNewVersionHint(first, { scope: 'song1', loaded: true, items: list(2, 1), currentKey: 'v:2' });
    expect(again).toBe(first);
  });
});
