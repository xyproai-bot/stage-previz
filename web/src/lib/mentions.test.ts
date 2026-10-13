import { describe, it, expect } from 'vitest';
import { extractMentions, mentionCandidates } from './mentions';

const members = [
  { id: 'u_ming', name: '小明' },
  { id: 'u_mingming', name: '小明明' },
  { id: 'u_dir', name: '王導演' },
  { id: 'u_hao', name: 'hao' },
  { id: 'u_audit', name: 'Audit Anim' },
];
const ids = (text: string) => extractMentions(text, members).map(m => m.userId);

describe('extractMentions', () => {
  it('中文名字：後面接空白、標點、直接接字都算（以前的 \\b 永遠對不到）', () => {
    expect(ids('@小明 你好')).toEqual(['u_ming']);
    expect(ids('@小明，請改')).toEqual(['u_ming']);
    expect(ids('@小明請改 C2')).toEqual(['u_ming']);
    expect(ids('請 @王導演 看一下')).toEqual(['u_dir']);
    expect(ids('結尾 @王導演')).toEqual(['u_dir']);
  });

  it('名字有長有短 → 對最長的那個', () => {
    expect(ids('@小明明 這段')).toEqual(['u_mingming']);
    expect(ids('@小明明 和 @小明')).toEqual(['u_mingming', 'u_ming']);
  });

  it('英文名字：後面不能再接英文字母或數字；不分大小寫；名字可以有空白', () => {
    expect(ids('@hao 你好')).toEqual(['u_hao']);
    expect(ids('@haoran 你好')).toEqual([]);
    expect(ids('@HAO, hi')).toEqual(['u_hao']);
    expect(ids('@hao你好')).toEqual(['u_hao']);
    expect(ids('@Audit Anim hi')).toEqual(['u_audit']);
  });

  it('同一個人提到兩次只算一次；回傳成員本來的名字', () => {
    expect(extractMentions('@小明 @小明', members)).toEqual([{ userId: 'u_ming', name: '小明' }]);
    expect(extractMentions('@HAO', members)).toEqual([{ userId: 'u_hao', name: 'hao' }]);
  });

  it('不是提及：email、沒有這個成員、只有 @', () => {
    expect(ids('寄到 hao@example.com')).toEqual([]);
    expect(ids('@路人甲 你好')).toEqual([]);
    expect(ids('@')).toEqual([]);
    expect(ids('沒有提到人')).toEqual([]);
  });

  it('沒有成員名單 / 名單有空名字 → 不會壞', () => {
    expect(extractMentions('@小明', [])).toEqual([]);
    expect(extractMentions('@小明', null)).toEqual([]);
    expect(extractMentions('@小明', [{ id: 'x', name: '' }, { id: 'u_ming', name: '小明' }])).toEqual([{ userId: 'u_ming', name: '小明' }]);
  });
});

describe('mentionCandidates（打 @ 之後列出的人）', () => {
  const people = [
    { id: 'u_admin', name: '製作小林' },
    { id: 'u_mei', name: '小美' },
    { id: 'u_kai', name: '阿凱' },
  ];
  it('名字開頭對上的排前面', () => {
    expect(mentionCandidates(people, '小').map(m => m.name)).toEqual(['小美', '製作小林']);
  });
  it('沒打字 → 照原本的順序；找不到 → 空的；最多幾個', () => {
    expect(mentionCandidates(people, '').map(m => m.name)).toEqual(['製作小林', '小美', '阿凱']);
    expect(mentionCandidates(people, '王')).toEqual([]);
    expect(mentionCandidates(people, '', 2)).toHaveLength(2);
    expect(mentionCandidates(null, '小')).toEqual([]);
  });
});
