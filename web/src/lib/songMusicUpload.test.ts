import { describe, expect, it, vi, type Mock } from 'vitest';
import { runMusicRemove, runMusicUpload, type UploadDeps } from './songMusicUpload';
import type { SongMusic, SongMusicSummary } from './musicApi';
import { MIB } from './songMusic';

const existing: SongMusicSummary = { id: 'sm_old', filename: '舊的.mp3', mime: 'audio/mpeg', sizeBytes: 100, durationSec: 100, uploadedAt: 't' };
const saved: SongMusic = { id: 'sm_new', songId: 's1', filename: 'S01.wav', mime: 'audio/wav', sizeBytes: 5 * MIB, durationSec: 215.5, uploadedAt: 't', uploadedBy: null, streamUrl: '/x' };
const file = (name = 'S01.wav', type = 'audio/wav', size = 5 * MIB) => ({ name, type, size } as unknown as File);

function deps(over: Partial<UploadDeps> = {}): { confirm: Mock; readDuration: Mock; upload: Mock; remove: Mock } {
  return {
    confirm: vi.fn(async () => true),
    readDuration: vi.fn(async () => 215.5 as number | null),
    upload: vi.fn(async () => saved),
    remove: vi.fn(async () => {}),
    ...over,
  } as unknown as { confirm: Mock; readDuration: Mock; upload: Mock; remove: Mock };
}
const base = { projectId: 'p1', songId: 's1' };

describe('上傳音樂的流程', () => {
  it('第一次上傳：量長度 → 傳（帶長度、進度、取消用的 signal）→ done，不用問', async () => {
    const d = deps();
    const phases: string[] = [];
    const ctrl = new AbortController();
    const out = await runMusicUpload({ ...base, file: file(), existing: null, signal: ctrl.signal, onPhase: p => phases.push(p), onProgress: () => {}, deps: d });
    expect(out).toEqual({ kind: 'done', music: saved, replaced: false });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(phases).toEqual(['checking', 'uploading']);
    expect(d.upload).toHaveBeenCalledTimes(1);
    const [pid, sid, f, opts] = d.upload.mock.calls[0] as unknown as [string, string, File, { durationSec: number; signal: AbortSignal }];
    expect([pid, sid, f.name, opts.durationSec, opts.signal]).toEqual(['p1', 's1', 'S01.wav', 215.5, ctrl.signal]);
  });

  it('換音樂：先用站內確認框問（寫舊檔名、新檔名、舊的會刪掉救不回來）；按取消就什麼都不做', async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    const out = await runMusicUpload({ ...base, file: file('新的.wav'), existing, deps: d });
    expect(out).toEqual({ kind: 'declined' });
    expect(d.readDuration).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
    const arg = d.confirm.mock.calls[0][0] as { title: string; message: string; confirmLabel: string; destructive: boolean };
    expect(arg.title).toContain('新的.wav');
    expect(arg.message).toContain('舊的.mp3');
    expect(arg.message).toContain('救不回來');
    expect(arg.destructive).toBe(true);
    // 同意了 → 傳；結果標成換掉
    const d2 = deps();
    expect(await runMusicUpload({ ...base, file: file(), existing, deps: d2 })).toEqual({ kind: 'done', music: saved, replaced: true });
    expect(d2.confirm).toHaveBeenCalledTimes(1);
  });

  it('不能傳的檔案在最前面就擋掉（影片、別的格式、太大、空的），不問、不量、不傳', async () => {
    const d = deps();
    for (const f of [file('mv.mp4', 'video/mp4'), file('a.txt', 'text/plain'), file('big.wav', 'audio/wav', 200 * MIB), file('empty.mp3', 'audio/mpeg', 0)]) {
      const out = await runMusicUpload({ ...base, file: f, existing, deps: d });
      expect(out.kind).toBe('rejected');
      expect((out as { text: string }).text.length).toBeGreaterThan(0);
    }
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.readDuration).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
    const video = await runMusicUpload({ ...base, file: file('mv.mp4', 'video/mp4'), existing: null, deps: d });
    expect((video as { text: string }).text).toContain('加影片');
  });

  it('瀏覽器打不開的檔案（量不到長度）：擋掉並說原因，不傳', async () => {
    const d = deps({ readDuration: vi.fn(async () => null) });
    const out = await runMusicUpload({ ...base, file: file(), existing: null, deps: d });
    expect(out.kind).toBe('unreadable');
    expect((out as { text: string }).text).toMatch(/瀏覽器打不開「S01\.wav」.*MP3 \/ WAV/);
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('量長度的時候就按了取消：不傳', async () => {
    const ctrl = new AbortController();
    const d = deps({ readDuration: vi.fn(async () => { ctrl.abort(); return 10; }) });
    const out = await runMusicUpload({ ...base, file: file(), existing: null, signal: ctrl.signal, deps: d });
    expect(out).toEqual({ kind: 'cancelled' });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('傳到一半取消 → cancelled；後台說不行 → failed（後台的中文說明）；網路斷 → failed（白話）', async () => {
    const abort = deps({ upload: vi.fn(async () => { throw new DOMException('Aborted', 'AbortError'); }) });
    expect(await runMusicUpload({ ...base, file: file(), existing: null, deps: abort })).toEqual({ kind: 'cancelled' });
    const refused = deps({ upload: vi.fn(async () => { throw Object.assign(new Error('只有製作或導演可以上傳、換或移除音樂；動畫師可以聽'), { status: 403 }); }) });
    expect(await runMusicUpload({ ...base, file: file(), existing: null, deps: refused })).toEqual({ kind: 'failed', text: '只有製作或導演可以上傳、換或移除音樂；動畫師可以聽' });
    const offline = deps({ upload: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) });
    const out = await runMusicUpload({ ...base, file: file(), existing: null, deps: offline });
    expect(out.kind).toBe('failed');
    expect((out as { text: string }).text).toMatch(/網路斷了/);
  });
});

describe('移除音樂的流程', () => {
  it('先問（寫檔名、檔案會刪掉救不回來）；按取消什麼都不做；同意才刪', async () => {
    const no = deps({ confirm: vi.fn(async () => false) });
    expect(await runMusicRemove({ ...base, existing, deps: no })).toEqual({ kind: 'declined' });
    expect(no.remove).not.toHaveBeenCalled();
    const arg = no.confirm.mock.calls[0][0] as { title: string; message: string; confirmLabel: string; destructive: boolean };
    expect(arg.message).toContain('舊的.mp3');
    expect(arg.message).toContain('救不回來');
    expect([arg.confirmLabel, arg.destructive]).toEqual(['移除', true]);
    const yes = deps();
    expect(await runMusicRemove({ ...base, existing, deps: yes })).toEqual({ kind: 'removed' });
    expect(yes.remove).toHaveBeenCalledWith('p1', 's1');
  });
  it('別人已經先移除了（404）也算移除好了；其他錯誤顯示原因', async () => {
    const gone = deps({ remove: vi.fn(async () => { throw Object.assign(new Error('這首歌還沒有音樂'), { status: 404 }); }) });
    expect(await runMusicRemove({ ...base, existing, deps: gone })).toEqual({ kind: 'removed' });
    const denied = deps({ remove: vi.fn(async () => { throw Object.assign(new Error('只有製作或導演可以上傳、換或移除音樂；動畫師可以聽'), { status: 403 }); }) });
    expect((await runMusicRemove({ ...base, existing, deps: denied })).kind).toBe('failed');
  });
  it('流程裡的字沒有英文叫人的字', async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    await runMusicUpload({ ...base, file: file(), existing, deps: d });
    await runMusicRemove({ ...base, existing, deps: d });
    const texts = d.confirm.mock.calls.map(c => JSON.stringify(c[0])).join('');
    expect(texts).not.toMatch(/\b(users?|admins?|directors?|animators?)\b/i);
  });
});
