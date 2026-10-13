import { describe, it, expect } from 'vitest';
import { buildMechanismSheetCsv, csvCell, sheetFileName, sheetTime, sheetLegend } from './cueSheet';
import type { Mechanism } from './model';

const mech = (over: Partial<Mechanism> & Pick<Mechanism, 'id' | 'name'>): Mechanism => ({
  kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: 0, travelMax: 1, defaultValue: 0, maxSpeed: null,
  presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 0, metadata: null, cueCount: 0, updatedAt: '', ...over,
});

// 設計文件第 9 節的範例：S03 夜曲
const lift = mech({
  id: 'lift', name: '中央升降台', travelMin: 0, travelMax: 3.5, maxSpeed: 0.25, consoleLabel: 'Axis 3', order: 0,
  presets: [{ name: '收起', value: 0 }, { name: '半開', value: 1.75 }, { name: '全開', value: 3.5 }],
});
const rev = mech({
  id: 'rev', name: '旋轉舞台', kind: 'rotary', axis: { x: 0, y: -1, z: 0 }, pivot: { x: 0, y: 0, z: 0 }, travelMin: -180, travelMax: 180,
  maxSpeed: 6, consoleLabel: 'Revolve', order: 1,
  presets: [{ name: '正面', value: 0 }, { name: '側面', value: 90 }, { name: '背面', value: 180 }],
});
const slide = mech({
  id: 'slide', name: '左側 LED 滑軌', axis: { x: -1, y: 0, z: 0 }, travelMin: 0, travelMax: 4, maxSpeed: 0.5, consoleLabel: 'Axis 7', order: 2,
  presets: [{ name: '收起', value: 0 }, { name: '全開', value: 4 }],
});
const song = {
  id: 's03', name: '夜曲', code: 'S03', order: 2,
  cues: [
    { id: 'c1', name: '開場', order: 0, videoTimeSec: 0, crossfadeSeconds: 0 },
    { id: 'c2', name: '主歌', order: 1, videoTimeSec: 30, crossfadeSeconds: 20 },
    { id: 'c3', name: '副歌', order: 2, videoTimeSec: 65, crossfadeSeconds: 5 },
    { id: 'c4', name: '間奏', order: 3, videoTimeSec: 72, crossfadeSeconds: 10 },
    { id: 'c5', name: '尾奏', order: 4, videoTimeSec: null, crossfadeSeconds: 8 },
  ],
};
const P = (cueId: string, mechanismId: string, value: number) => ({ cueId, mechanismId, value, updatedAt: '' });
const positions = [
  P('c2', 'lift', 3.5), P('c3', 'rev', 90), P('c3', 'slide', 4), P('c4', 'lift', 0), P('c5', 'rev', 0), P('c5', 'slide', 0),
];

const GOLDEN = [
  '歌曲 Song,Cue #,Cue 名稱 Cue name,GO 時間 GO,到位時間 Arrive,轉場(秒) Move s,機關 Axis,控台編號 Console,起點 From,目標 Target,單位 Unit,常用位置 Preset,行程 Distance,可用(秒) Avail s,需要(秒) Need s,速度(單位/秒) Speed,最高速度 Max,檢查 Check',
  'S03 夜曲,1,開場,0:00.0,0:00.0,0,中央升降台,Axis 3,,0.000,m,收起,,,,,0.25,起始位置',
  'S03 夜曲,1,開場,0:00.0,0:00.0,0,旋轉舞台,Revolve,,0.0,°,正面,,,,,6,起始位置',
  'S03 夜曲,1,開場,0:00.0,0:00.0,0,左側 LED 滑軌,Axis 7,,0.000,m,收起,,,,,0.5,起始位置',
  'S03 夜曲,2,主歌,0:10.0,0:30.0,20,中央升降台,Axis 3,0.000,3.500,m,全開,3.500,20.0,14.0,0.175,0.25,OK',
  'S03 夜曲,2,主歌,0:10.0,0:30.0,20,旋轉舞台,Revolve,0.0,0.0,°,正面,0.0,,,,6,不動',
  'S03 夜曲,2,主歌,0:10.0,0:30.0,20,左側 LED 滑軌,Axis 7,0.000,0.000,m,收起,0.000,,,,0.5,不動',
  'S03 夜曲,3,副歌,1:00.0,1:05.0,5,中央升降台,Axis 3,3.500,3.500,m,全開,0.000,,,,0.25,不動',
  'S03 夜曲,3,副歌,1:00.0,1:05.0,5,旋轉舞台,Revolve,0.0,90.0,°,側面,90.0,5.0,15.0,18.0,6,太快：轉場要 15 秒',
  'S03 夜曲,3,副歌,1:00.0,1:05.0,5,左側 LED 滑軌,Axis 7,0.000,4.000,m,全開,4.000,5.0,8.0,0.800,0.5,太快：轉場要 8 秒',
  'S03 夜曲,4,間奏,1:05.0,1:12.0,10,中央升降台,Axis 3,3.500,0.000,m,收起,3.500,7.0,14.0,0.500,0.25,太快：跟上一個 cue 只隔 7 秒',
  // 副歌的轉台 60 秒開始轉、要 15 秒；間奏 65 秒開始時才轉到 30°，剩下 60° 要 10 秒 → 75 秒才到，比 1:12 晚 3 秒
  'S03 夜曲,4,間奏,1:05.0,1:12.0,10,旋轉舞台,Revolve,90.0,90.0,°,側面,0.0,,,,6,會晚 3 秒到位',
  'S03 夜曲,4,間奏,1:05.0,1:12.0,10,左側 LED 滑軌,Axis 7,4.000,4.000,m,全開,0.000,,,,0.5,不動',
  'S03 夜曲,5,尾奏,,,8,中央升降台,Axis 3,0.000,0.000,m,收起,0.000,,,,0.25,不動',
  'S03 夜曲,5,尾奏,,,8,旋轉舞台,Revolve,90.0,0.0,°,正面,90.0,8.0,15.0,11.3,6,太快：轉場要 15 秒',
  'S03 夜曲,5,尾奏,,,8,左側 LED 滑軌,Axis 7,4.000,0.000,m,收起,4.000,8.0,8.0,0.500,0.5,OK',
  '',
  '# 機關說明 Axes',
  '# 中央升降台（Axis 3）：直線，0 = cue 裡原本的位置，正的數字往上；行程 0 m ~ 3.5 m；最高 0.25 m/秒；常用位置 收起 0 / 半開 1.75 / 全開 3.5',
  '# 旋轉舞台（Revolve）：旋轉・水平轉（像轉台），0 = 模型原本的方向，正的角度從上面看順時針；行程 -180° ~ 180°；最高 6°/秒；常用位置 正面 0 / 側面 90 / 背面 180',
  '# 左側 LED 滑軌（Axis 7）：直線，0 = cue 裡原本的位置，正的數字往左（觀眾看過去）；行程 0 m ~ 4 m；最高 0.5 m/秒；常用位置 收起 0 / 全開 4',
  '# 註：需要秒數 = 行程 ÷ 最高速度，以等速計算、沒有算加減速，實際會再久一點。GO 時間 = 到位時間 − 可用秒數；沒有影片時間的 cue 由現場叫 GO。',
];

describe('機關總表（設計文件的範例當標準答案）', () => {
  const csv = buildMechanismSheetCsv({ songs: [song], positions, mechanisms: [slide, lift, rev], front: { x: 0, y: 0, z: 1 } });

  it('每一行都跟範例一樣', () => {
    expect(csv.replace(/^﻿/, '').split('\r\n').slice(0, -1)).toEqual(GOLDEN);
  });

  it('UTF-8 BOM、CRLF 換行（Windows 的 Excel 中文不會亂碼）', () => {
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  it('名稱裡有逗號 / 引號 / 換行 → 加引號', () => {
    expect(csvCell({ t: 'text', v: 'A,B' })).toBe('"A,B"');
    expect(csvCell({ t: 'text', v: '說"大"聲' })).toBe('"說""大""聲"');
    expect(csvCell({ t: 'text', v: '兩\n行' })).toBe('"兩\n行"');
    expect(csvCell(null)).toBe('');
  });

  it('文字開頭是 = + - @ → 前面加 \'；負數不加（還是數字）', () => {
    expect(csvCell({ t: 'text', v: '=SUM(A1)' })).toBe("'=SUM(A1)");
    expect(csvCell({ t: 'text', v: '-走位' })).toBe("'-走位");
    expect(csvCell({ t: 'text', v: '@x' })).toBe("'@x");
    expect(csvCell({ t: 'num', v: '-180.0' })).toBe('-180.0');
    const tricky = buildMechanismSheetCsv({
      songs: [{ ...song, code: null, name: '=HACK()', cues: [song.cues[0], { ...song.cues[1], name: '主歌, 第二段' }] }],
      positions: [P('c2', 'rev', -90)], mechanisms: [rev], front: null,
    });
    const lines = tricky.split('\r\n');
    expect(lines[1].startsWith("'=HACK(),1,")).toBe(true);
    expect(lines[2]).toContain('"主歌, 第二段"');
    expect(lines[2]).toContain(',0.0,-90.0,°,');
  });

  it('數字格式 / 時間 / 檔名', () => {
    expect(sheetTime(0)).toBe('0:00.0');
    expect(sheetTime(65)).toBe('1:05.0');
    expect(sheetTime(599.96)).toBe('10:00.0');
    expect(sheetFileName('金馬 2026', new Date(2026, 9, 14))).toBe('機關總表-金馬 2026-2026-10-14.csv');
    expect(sheetFileName('a/b:c', new Date(2026, 0, 2))).toBe('機關總表-a_b_c-2026-01-02.csv');
  });

  it('沒填最高速度的機關：檢查欄寫「沒填最高速度」，說明也寫', () => {
    const free = mech({ id: 'f', name: '布幕', travelMin: 0, travelMax: 2 });
    const csv2 = buildMechanismSheetCsv({ songs: [{ ...song, cues: song.cues.slice(0, 2) }], positions: [P('c2', 'f', 2)], mechanisms: [free] });
    expect(csv2.split('\r\n')[2].endsWith(',沒填最高速度')).toBe(true);
    expect(sheetLegend([free])[1]).toContain('沒填最高速度（不檢查）');
  });

  it('旋轉的說明不會括號疊括號：「旋轉・水平轉（像轉台）」「旋轉・前後翻」「旋轉・左右翻」', () => {
    const tilt = mech({ id: 't', name: '翻板', kind: 'rotary', axis: { x: 1, y: 0, z: 0 }, pivot: { x: 0, y: 0, z: 0 }, travelMin: -90, travelMax: 90 });
    const roll = mech({ id: 'r', name: '側翻', kind: 'rotary', axis: { x: 0, y: 0, z: 1 }, pivot: { x: 0, y: 0, z: 0 }, travelMin: -90, travelMax: 90 });
    const [, a, b, c] = sheetLegend([rev, { ...tilt, order: 1 }, { ...roll, order: 2 }]);
    expect(a).toContain('：旋轉・水平轉（像轉台），0 = 模型原本的方向');
    expect(b).toContain('：旋轉・前後翻，0 = 模型原本的方向');
    expect(c).toContain('：旋轉・左右翻，0 = 模型原本的方向');
    for (const line of [a, b, c]) expect(line).not.toMatch(/（[^）]*（/);
  });
});
