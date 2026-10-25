// 影片版本「改說明」：問新的說明 → PATCH 影片 → 通知。
// 直接用站內對話框的排隊（dialogs）當「使用者」按確定 / 取消，打 API 的地方用假的 fetch。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dialogs } from '../components/dialogs/dialogStore';
import { toast } from './toast';
import { editVersionNote, VERSION_NOTE_MAX } from './editVersionNote';

const item = { id: 'sv_7', label: 'V3', note: '修了第二段' };

function mockFetch(status: number, body: unknown) {
  const f = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', f);
  return f;
}
const lastCall = (f: ReturnType<typeof mockFetch>) => {
  const [url, init] = f.mock.calls[f.mock.calls.length - 1] as unknown as [string, RequestInit];
  return { url: url.replace(/^https?:\/\/[^/]+/, ''), method: (init.method || 'GET').toUpperCase(), body: init.body ? JSON.parse(init.body as string) : undefined };
};

/** 等對話框出現，回答它 */
async function answer(value: string | null) {
  await vi.waitFor(() => expect(dialogs.current()).not.toBeNull());
  const d = dialogs.current()!;
  expect(d.kind).toBe('prompt');
  dialogs.settle(d.id, value);
}

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const t of [...toast.items]) toast.dismiss(t.id);
});

describe('editVersionNote：改影片版本的說明', () => {
  it('對話框先帶入現在的說明；改了就 PATCH 這一版的 note', async () => {
    const f = mockFetch(200, { video: { id: 'sv_7', note: '換了新轉場' } });
    const p = editVersionNote('p 1', 's1', item);
    await vi.waitFor(() => expect(dialogs.current()).not.toBeNull());
    const d = dialogs.current()!;
    expect(d.kind === 'prompt' && d.options.defaultValue).toBe('修了第二段');
    expect(d.kind === 'prompt' && d.options.title).toContain('V3');
    expect(d.kind === 'prompt' && d.options.maxLength).toBe(VERSION_NOTE_MAX);
    expect(d.kind === 'prompt' && d.options.required).toBe(false);
    dialogs.settle(d.id, '  換了新轉場 ');
    expect(await p).toBe(true);
    expect(lastCall(f)).toMatchObject({
      url: '/api/projects/p%201/songs/s1/videos/sv_7',
      method: 'PATCH',
      body: { note: '換了新轉場' },
    });
    expect(toast.items.some(t => t.kind === 'success' && t.text.includes('V3'))).toBe(true);
  });

  it('清空 = 拿掉說明（送空字串）', async () => {
    const f = mockFetch(200, { video: { id: 'sv_7', note: '' } });
    const p = editVersionNote('p1', 's1', item);
    await answer('');
    expect(await p).toBe(true);
    expect(lastCall(f).body).toEqual({ note: '' });
    expect(toast.items.some(t => t.text.includes('拿掉'))).toBe(true);
  });

  it('按取消、或沒改 → 不送出', async () => {
    const f = mockFetch(200, {});
    let p = editVersionNote('p1', 's1', item);
    await answer(null);
    expect(await p).toBe(false);
    p = editVersionNote('p1', 's1', item);
    await answer('修了第二段');
    expect(await p).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('後台不准（例如不是自己交的）→ 回 false，用中文告訴他', async () => {
    mockFetch(403, { error: '只有製作或交這一版的人可以改' });
    const p = editVersionNote('p1', 's1', item);
    await answer('新的');
    expect(await p).toBe(false);
    expect(toast.items.some(t => t.kind === 'error' && t.text.includes('只有製作或交這一版的人可以改'))).toBe(true);
  });
});
