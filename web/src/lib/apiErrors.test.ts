import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('後台錯誤顯示給使用者的說明', () => {
  it('英文的錯誤（Not found）換成白話，狀態碼和內容留著', async () => {
    mockFetch(404, { error: 'Not found' });
    const e = await api.listSongs('p_x').catch(x => x) as api.ApiError;
    expect(e.message).toBe('找不到這筆資料，可能剛被刪除，或專案已封存');
    expect(e.status).toBe(404);
    expect(e.data).toEqual({ error: 'Not found' });
  });
  it('中文的說明照原樣', async () => {
    mockFetch(403, { error: '只有製作可以修改專案內容' });
    const e = await api.listSongs('p_x').catch(x => x) as api.ApiError;
    expect(e.message).toBe('只有製作可以修改專案內容');
  });
  it('沒有說明的 500 → 伺服器暫時出了問題', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    const e = await api.listSongs('p_x').catch(x => x) as api.ApiError;
    expect(e.message).toBe('伺服器暫時出了問題，請稍後再試');
  });
});
