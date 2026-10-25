// Show 的「改說明」：問新的說明 → PATCH /api/shows/:id { description }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dialogs } from '../components/dialogs/dialogStore';
import { toast } from './toast';
import { editShowDescription, SHOW_DESC_MAX } from './editShowDescription';

const show = { id: 'sh_1', name: '巡迴 2026', description: '十場' };

function mockFetch(status: number, body: unknown) {
  const f = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', f);
  return f;
}
const lastCall = (f: ReturnType<typeof mockFetch>) => {
  const [url, init] = f.mock.calls[f.mock.calls.length - 1] as unknown as [string, RequestInit];
  return { url: url.replace(/^https?:\/\/[^/]+/, ''), method: (init.method || 'GET').toUpperCase(), body: init.body ? JSON.parse(init.body as string) : undefined };
};
async function answer(value: string | null) {
  await vi.waitFor(() => expect(dialogs.current()).not.toBeNull());
  dialogs.settle(dialogs.current()!.id, value);
}

// 沒有 jsdom：給 apiBase / saveStatus 用的最小 window
const store = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
beforeEach(() => {
  vi.stubGlobal('window', { localStorage: store, setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
  vi.stubGlobal('localStorage', store);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const t of [...toast.items]) toast.dismiss(t.id);
});

describe('editShowDescription：改 Show 的說明', () => {
  it('對話框帶入現在的說明、字數上限跟後台一樣；改了就 PATCH description', async () => {
    const f = mockFetch(200, { ok: true });
    const p = editShowDescription(show);
    await vi.waitFor(() => expect(dialogs.current()).not.toBeNull());
    const d = dialogs.current()!;
    expect(d.kind === 'prompt' && d.options.defaultValue).toBe('十場');
    expect(d.kind === 'prompt' && d.options.maxLength).toBe(SHOW_DESC_MAX);
    expect(d.kind === 'prompt' && d.options.required).toBe(false);
    dialogs.settle(d.id, ' 十二場，含加場 ');
    expect(await p).toBe(true);
    expect(lastCall(f)).toMatchObject({ url: '/api/shows/sh_1', method: 'PATCH', body: { description: '十二場，含加場' } });
    expect(SHOW_DESC_MAX).toBe(300);
  });

  it('清空 = 拿掉說明', async () => {
    const f = mockFetch(200, { ok: true });
    const p = editShowDescription(show);
    await answer('');
    expect(await p).toBe(true);
    expect(lastCall(f).body).toEqual({ description: '' });
  });

  it('取消 / 沒改 → 不送出', async () => {
    const f = mockFetch(200, {});
    let p = editShowDescription(show);
    await answer(null);
    expect(await p).toBe(false);
    p = editShowDescription(show);
    await answer('十場');
    expect(await p).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('不是製作 → 後台 403，回 false 並告訴他', async () => {
    mockFetch(403, { error: '只有製作可以管理 Show' });
    const p = editShowDescription(show);
    await answer('新的');
    expect(await p).toBe(false);
    expect(toast.items.some(t => t.kind === 'error' && t.text.includes('只有製作可以管理 Show'))).toBe(true);
  });
});
