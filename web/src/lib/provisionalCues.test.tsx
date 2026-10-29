import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Cue, CueState } from './api';
import MechanismTimeline from '../components/mechanisms/MechanismTimeline';
import { cueWindows } from './cueTimeline';
import { cueSeekTime, loadTimeline, timelineFrame, useVideoCueTimeline, type FrameState } from './videoCueSync';
import { buildMechanismTimeline, type MotionCue, type OwnMoveFor } from './mechanisms/motion';
import type { Mechanism, MechanismTiming, MechanismValues } from './mechanisms/model';
import { STAGE_TIMELINE_TEXT, type TimelineMech } from './mechanisms/stageTimeline';
import { useShareMechanisms } from './mechanisms/useMechanisms';
import { planProvisionalTimes, provisionalCueTitle, withProvisionalTimes } from './provisionalCues';

// 暫排：沒設「對應影片時間」的正式 cue，先排在前一個 cue 的機關全部停下之後（只算在畫面上，不存）

type C = MotionCue & { name: string };
const cue = (id: string, order: number, videoTimeSec: number | null, crossfadeSeconds: number, status = 'master'): C =>
  ({ id, order, videoTimeSec, crossfadeSeconds, status, name: id });

const lift = { id: 'lift' };
const rev = { id: 'rev' };

/** cueId → mechId → 這個 cue 自己設的時間（沒有 = 沿用，不會叫機器出發） */
const ownOf = (spec: Record<string, Record<string, MechanismTiming>>): OwnMoveFor => (cueId, mechId) => spec[cueId]?.[mechId] ?? null;
const valuesOf = (spec: Record<string, MechanismValues>) => (cueId: string) => spec[cueId];
const T = (delaySec: number | null, durationSec: number | null): MechanismTiming => ({ delaySec, durationSec });

// ── 真實專案 S17：cue 1「30」影片時間 0、轉場 6 秒；cue 2「30-1」沒設時間、轉場 4 秒，機關設了延遲和走幾秒 ──
const s17Cues = [cue('c1', 0, 0, 6), cue('c2', 1, null, 4)];
const s17Values = { c1: { lift: 0, rev: 0 }, c2: { lift: 3, rev: 90 } };
const s17Own = ownOf({ c2: { lift: T(2, 8), rev: T(null, 3) } });
const s17Mech = { mechs: [lift, rev], valuesFor: valuesOf(s17Values), ownFor: s17Own };

describe('暫排規則', () => {
  it('S17：沒設時間的 cue 2 接在 cue 1 後面（cue 1 是起點，沒有機關要動）→ 0 秒 GO、轉場 4 秒後到位', () => {
    const plan = planProvisionalTimes(s17Cues, s17Mech);
    expect([...plan]).toEqual([['c2', 4]]);

    // 排完之後時間軸有 cue 2 的色塊：升降台延遲 2 秒、走 8 秒；旋轉台沒設延遲、走 3 秒
    const planned = withProvisionalTimes(s17Cues, plan);
    const tl = buildMechanismTimeline([lift, rev], planned, valuesOf(s17Values), s17Own)!;
    expect(cueWindows(planned)).toEqual([{ cueId: 'c1', start: 0, arrive: 0 }, { cueId: 'c2', start: 0, arrive: 4 }]);
    const liftMove = tl.moveFor('c2', 'lift')!;
    expect([liftMove.start, liftMove.end]).toEqual([2, 10]);
    const revMove = tl.moveFor('c2', 'rev')!;
    expect([revMove.start, revMove.end]).toEqual([0, 3]);
  });

  it('接在「前面機關全部停下」之後：cue 3 排在 cue 2 最後一個機關走完（10 秒）才 GO，再加自己的轉場', () => {
    const cues = [...s17Cues, cue('c3', 2, null, 5)];
    const values = { ...s17Values, c3: { lift: 0, rev: 90 } };
    const plan = planProvisionalTimes(cues, { ...s17Mech, valuesFor: valuesOf(values), ownFor: ownOf({ c2: { lift: T(2, 8), rev: T(null, 3) }, c3: { lift: T(null, null) } }) });
    expect(plan.get('c2')).toBe(4);
    expect(plan.get('c3')).toBe(15);   // 升降台 2 + 8 = 10 秒停下；GO 10；轉場 5 → 15
  });

  it('前一個 cue 的機關比它的轉場短 → 以前一個 cue 的到位為準', () => {
    const plan = planProvisionalTimes(s17Cues, { ...s17Mech, ownFor: ownOf({ c2: { lift: T(0, 1) } }) });
    expect(plan.get('c2')).toBe(4);   // c1 是起點，沒有機關要動
    const cues = [cue('c1', 0, 0, 0), cue('c2', 1, 20, 3), cue('c3', 2, null, 2)];
    const p2 = planProvisionalTimes(cues, { mechs: [lift], valuesFor: valuesOf({ c1: { lift: 0 }, c2: { lift: 1 }, c3: { lift: 0 } }), ownFor: ownOf({ c2: { lift: T(0, 1) } }) });
    expect(p2.get('c3')).toBe(22);   // cue 2 的機關 17 → 18 就停了，cue 2 到位 20；轉場 2
  });

  it('第一個正式 cue 沒設時間 → 當 0 秒；後面一個一個接', () => {
    const cues = [cue('c1', 0, null, 6), cue('c2', 1, null, 4), cue('c3', 2, null, 1)];
    const plan = planProvisionalTimes(cues, { mechs: [lift], valuesFor: valuesOf({ c1: { lift: 0 }, c2: { lift: 2 }, c3: { lift: 0 } }), ownFor: ownOf({ c2: { lift: T(1, 6) } }) });
    expect(plan.get('c1')).toBe(0);
    expect(plan.get('c2')).toBe(4);
    expect(plan.get('c3')).toBe(8);   // cue 2：GO 0、延遲 1、走 6 → 7 秒停下；7 + 轉場 1
  });

  it('沒有機關（沒給 / 空的）也能算：只看轉場', () => {
    const cues = [cue('c1', 0, 0, 6), cue('c2', 1, null, 4), cue('c3', 2, null, 1.5)];
    const expected = [['c2', 4], ['c3', 5.5]];
    expect([...planProvisionalTimes(cues)]).toEqual(expected);
    expect([...planProvisionalTimes(cues, null)]).toEqual(expected);
    expect([...planProvisionalTimes(cues, { mechs: [], valuesFor: () => null })]).toEqual(expected);
  });

  it('機關走一半被後面的 cue 接手 → 算到接手那一刻；還沒開始就被接手（取消）的不算', () => {
    // cue 2（10 秒到位）的升降台走 30 秒，cue 3（20 秒到位，轉場 2）在 18 秒叫它回去 → cue 2 那一段 18 秒就停了
    const cues = [cue('c1', 0, 0, 0), cue('c2', 1, 10, 10), cue('c3', 2, 20, 2), cue('c4', 3, null, 3)];
    const values = { c1: { lift: 0 }, c2: { lift: 3 }, c3: { lift: 0 }, c4: { lift: 0 } };
    const cut = planProvisionalTimes(cues, { mechs: [lift], valuesFor: valuesOf(values), ownFor: ownOf({ c2: { lift: T(null, 30) }, c3: { lift: T(null, null) } }) });
    expect(cut.get('c4')).toBe(23);   // 最後一條色塊是 cue 3 的 18 → 20；不是 cue 2 原本排的 30
    const tl = buildMechanismTimeline([lift], cues.slice(0, 3), valuesOf(values), ownOf({ c2: { lift: T(null, 30) }, c3: { lift: T(null, null) } }))!;
    expect(tl.moveFor('c2', 'lift')!.end).toBe(30);   // 沒被算進去的原因：被接手了

    const never = planProvisionalTimes(cues, { mechs: [lift], valuesFor: valuesOf({ ...values, c3: { lift: 1 } }), ownFor: ownOf({ c2: { lift: T(50, 10) }, c3: { lift: T(null, null) } }) });
    expect(never.get('c4')).toBe(23);   // cue 2 的延遲 50 秒，還沒開始就被 cue 3 接手，等於沒動過
  });

  it('擠不下：壓在後面有真時間的 cue 之前，順序不亂（同一秒清單排前面的先）', () => {
    // cue 2 的機關要到 10 秒才停，但 cue 3 設了 3 秒 → cue 2 壓在 3 秒
    const cues = [cue('c1', 0, 0, 0), cue('c2', 1, null, 4), cue('c3', 2, 3, 1), cue('c4', 3, null, 2)];
    const values = { c1: { lift: 0 }, c2: { lift: 3 }, c3: { lift: 3 }, c4: { lift: 0 } };
    const plan = planProvisionalTimes(cues, { mechs: [lift], valuesFor: valuesOf(values), ownFor: ownOf({ c2: { lift: T(2, 8) }, c4: { lift: T(null, null) } }) });
    expect(plan.get('c2')).toBe(3);
    expect(plan.get('c4')).toBe(12);   // 後面沒有真時間的 cue → 不用擠；cue 2 的升降台 10 秒才停，轉場 2
    const planned = withProvisionalTimes(cues, plan);
    expect(cueWindows(planned).map(w => w.cueId)).toEqual(['c1', 'c2', 'c3', 'c4']);

    // 連續好幾個都排不下 → 全部壓在那一秒，清單順序照舊
    const many = [cue('a', 0, 0, 0), cue('b', 1, null, 4), cue('c', 2, null, 4), cue('d', 3, 5, 1)];
    const p2 = planProvisionalTimes(many);
    expect(p2.get('b')).toBe(4);
    expect(p2.get('c')).toBe(5);
    expect(cueWindows(withProvisionalTimes(many, p2)).map(w => w.cueId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('有真的時間的 cue 一律照設的；提案不暫排；清單順序看 order，不看陣列', () => {
    const cues = [cue('c2', 1, null, 4), cue('x', 5, null, 4, 'proposal'), cue('c1', 0, 7, 6), cue('c3', 2, 40, 3)];
    const plan = planProvisionalTimes(cues);
    expect([...plan]).toEqual([['c2', 11]]);   // 7 秒到位的 cue 1 之後；提案不在裡面
    const planned = withProvisionalTimes(cues, plan);
    expect(planned.map(c => c.videoTimeSec)).toEqual([11, null, 7, 40]);
  });

  it('全部都有時間 → 什麼都不排，清單原封不動（同一個陣列，不會讓畫面重算）', () => {
    const cues = [cue('c1', 0, 0, 0), cue('c2', 1, 30, 20)];
    const plan = planProvisionalTimes(cues, s17Mech);
    expect(plan.size).toBe(0);
    expect(withProvisionalTimes(cues, plan)).toBe(cues);
  });

  it('只算在畫面上：原本的 cue 不會被改（對應影片時間照樣是空的）', () => {
    const cues = [cue('c1', 0, 0, 6), cue('c2', 1, null, 4)];
    const planned = withProvisionalTimes(cues, planProvisionalTimes(cues));
    expect(planned[1].videoTimeSec).toBe(4);
    expect(cues[1].videoTimeSec).toBeNull();
    expect(planned[0]).toBe(cues[0]);
  });

  it('cue 列的提示：暫排的 cue 加「（暫排 0:12.0）」', () => {
    expect(provisionalCueTitle('30-1', 12)).toBe('30-1（暫排 0:12.0）');
    expect(provisionalCueTitle('30-1', 4)).toBe('30-1（暫排 0:04.0）');
    expect(provisionalCueTitle('30-1', undefined)).toBe('30-1');
  });
});

// ── 有影片時：物件跟著影片切 cue（videoCueSync）也用暫排的時間，跟機關同一個時間 ──
function states(x: number): CueState[] {
  return [{
    objectId: 'led1', meshName: 'LED_1', displayName: 'LED 1', category: 'led_panel', order: 0, locked: false,
    default: { position: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 } },
    override: null,
    effective: { position: { x, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 }, visible: true },
  } as CueState];
}
const byCue: Record<string, CueState[]> = { c1: states(0), c2: states(10) };
const statesFor = (id: string) => (byCue[id] ? Promise.resolve(byCue[id]) : null);
const playing = (time: number, over: Partial<FrameState> = {}): FrameState => ({ active: true, ready: true, selectedCueId: 'c1', time, ...over });
const xAt = (pose: ReturnType<typeof timelineFrame>) => pose?.get('led1')?.position.x;

describe('有影片時：物件用暫排的時間切', () => {
  const planned = withProvisionalTimes(s17Cues, planProvisionalTimes(s17Cues, s17Mech));

  it('沒暫排：cue 2 沒時間，物件永遠停在 cue 1；暫排後 0 秒 GO、4 秒到位，等速走過去', async () => {
    const raw = await loadTimeline(s17Cues, statesFor);
    expect(xAt(timelineFrame(raw, playing(2)))).toBe(0);
    expect(timelineFrame(raw, playing(2, { selectedCueId: 'c2' }))).toBeNull();

    const tl = await loadTimeline(planned, statesFor);
    expect(xAt(timelineFrame(tl, playing(0)))).toBe(0);
    expect(xAt(timelineFrame(tl, playing(2)))).toBeCloseTo(5);
    expect(xAt(timelineFrame(tl, playing(4)))).toBe(10);
    expect(xAt(timelineFrame(tl, playing(9, { selectedCueId: 'c2' })))).toBe(10);   // 暫排的 cue 被點了也照影片時間（不是手動停住）
  });

  it('物件和機關是同一個時間：cue 2 的色塊 GO 在 0 秒，物件也是 0 秒開始動、4 秒到位', async () => {
    const w = cueWindows(planned).find(x => x.cueId === 'c2')!;
    const tl = await loadTimeline(planned, statesFor);
    expect(tl!.windows.find(x => x.cueId === 'c2')).toEqual(w);
    expect(w).toEqual({ cueId: 'c2', start: 0, arrive: 4 });
  });

  it('點暫排的 cue → 影片跳到它的暫排時間（點的是原本沒時間的那個 cue 也一樣）', () => {
    expect(cueSeekTime(s17Cues[1], true)).toBeNull();     // 原本：沒時間不跳
    expect(cueSeekTime(planned[1], true)).toBe(4);
    let select: ((c: C) => void) | null = null;
    const seeks: number[] = [];
    const picked: string[] = [];
    function Probe() {
      select = useVideoCueTimeline({
        cues: planned, statesFor: () => null, active: true, ready: true, video: { currentTime: 0 } as HTMLVideoElement, time: 0,
        selectedCueId: null, onSelectCue: id => { if (id) picked.push(id); }, seek: t => { seeks.push(t); },
      }).selectCueByUser;
      return null;
    }
    renderToStaticMarkup(<Probe />);
    select!(s17Cues[1]);   // 頁面傳進來的是原本的 cue（videoTimeSec 是空的）
    expect(picked).toEqual(['c2']);
    expect(seeks).toEqual([4]);
  });
});

// ── 頁面用的 hook：沒有機關的專案不暫排；有機關才排 ──
describe('useShareMechanisms：給頁面的暫排時間', () => {
  const rawLift = [{ id: 'lift', name: '升降台', kind: 'linear', travelMin: 0, travelMax: 3, defaultValue: 0 }];
  const probe = (mechanisms: unknown, cues: C[]) => {
    let out: ReturnType<typeof useShareMechanisms<C>> | null = null;
    function P() {
      out = useShareMechanisms<C>({ shareRef: null, mechanisms, songId: 's1', accessToken: null, cues, selectedCueId: null });
      return null;
    }
    renderToStaticMarkup(<P />);
    return out!;
  };

  it('有機關：plannedCues 填好暫排時間、provisional 記哪些是暫排；原本的 cue 不動', () => {
    const r = probe(rawLift, s17Cues);
    expect(r.provisional.get('c2')).toBe(4);
    expect(r.plannedCues[1].videoTimeSec).toBe(4);
    expect(s17Cues[1].videoTimeSec).toBeNull();
    expect(r.timeline!.windows.map(w => w.cueId)).toEqual(['c1', 'c2']);   // 時間軸上有 cue 2
  });
  it('沒有機關的專案：不暫排，沒設時間的 cue 跟以前一樣（同一個陣列）', () => {
    const r = probe([], s17Cues);
    expect(r.provisional.size).toBe(0);
    expect(r.plannedCues).toBe(s17Cues);
    expect(r.timeline).toBeNull();
  });
  it('舊後台沒給機關（undefined）：也不暫排', () => {
    const r = probe(undefined, s17Cues);
    expect(r.plannedCues).toBe(s17Cues);
  });
});

// ── 時間軸畫面 ──
describe('機關時間軸：暫排的 cue', () => {
  const liftMech = {
    id: 'lift', name: '中央升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: 0, travelMax: 3, defaultValue: 0,
    maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 0, metadata: null, cueCount: 2, updatedAt: '',
  } as Mechanism;
  const mechOf = (planned: C[]): TimelineMech => ({
    timeline: buildMechanismTimeline([liftMech], planned, valuesOf(s17Values), s17Own), mechanisms: [liftMech], groups: [], focusedId: null,
    setFocusedId: () => {}, setPreviewTime: () => {}, previewTimeRef: { current: null },
  });
  const render = (cues: C[], planned: C[]) => renderToStaticMarkup(
    <MechanismTimeline mech={mechOf(planned)} cues={cues as unknown as Cue[]} selectedCueId="c2" onSelectCue={() => {}} onClose={() => {}} readOnly />,
  );

  it('沒設時間的 cue 照樣在時間尺上：空心虛線記號、滑鼠移上去有說明；左上寫「N 個 cue 暫排」', () => {
    const planned = withProvisionalTimes(s17Cues, planProvisionalTimes(s17Cues, s17Mech));
    const html = render(s17Cues, planned);
    expect(html).toContain('mech-tl__cue is-selected is-provisional');
    expect(html).toContain('mech-tl__go is-provisional');
    expect(html).toContain(STAGE_TIMELINE_TEXT.provisionalTip);
    expect(html).toContain(`1 ${STAGE_TIMELINE_TEXT.provisionalCount}`);
    expect(html).toContain('還沒設時間，先暫排在前一個 cue 動完之後；製作設了時間就照設的');
    expect(html).not.toContain('沒設時間</span>');
    expect(html).toContain('mech-tl__move');   // 色塊照常畫
  });
  it('每個 cue 都有真的時間：跟以前一樣，沒有暫排的記號和字', () => {
    const cues = [cue('c1', 0, 0, 6), cue('c2', 1, 30, 20)];
    const html = render(cues, cues);
    expect(html).not.toContain('is-provisional');
    expect(html).not.toContain(STAGE_TIMELINE_TEXT.provisionalCount);
  });
  it('字：沒有英文叫人的字、沒有 emoji', () => {
    const all = `${STAGE_TIMELINE_TEXT.provisionalTip}\n${STAGE_TIMELINE_TEXT.provisionalCount}\n${STAGE_TIMELINE_TEXT.noCueTimes}`;
    expect(all).not.toMatch(/\b(users?|admins?|directors?|animators?)\b/i);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
