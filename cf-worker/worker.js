/**
 * Stage Previz — Google Drive CORS Proxy
 *
 * 解決 Google Drive 大檔案（>100MB）需要二段確認的問題：
 * 1. 第一次請求 ?id=XX&confirm=t → 會返回 HTML 警告頁
 * 2. 警告頁有 form 內含 uuid + at token
 * 3. 用 token 重新請求才能拿到真正的影片內容
 *
 * 此 Worker 自動處理這個流程，並串流回應給 client，加上 CORS headers。
 *
 * 部署：
 *   1. cd cf-worker
 *   2. npx wrangler login
 *   3. npx wrangler deploy
 *   4. 將 worker URL 放到 index.html 的 GDRIVE_PROXY 常數
 *
 * URL 格式：
 *   https://your-worker.workers.dev/?id=FILE_ID
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const fileId = url.searchParams.get('id');
    if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      return jsonResp({ error: 'Missing or invalid id parameter' }, 400);
    }

    try {
      // Step 1：嘗試直接下載（小於 100MB 會直接成功）
      const directURL = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
      let resp = await fetch(directURL, {
        headers: forwardHeaders(request)
      });

      const contentType = resp.headers.get('content-type') || '';
      // 如果回的是 HTML（病毒掃描警告頁）→ 解析 token 再重試
      if (contentType.includes('text/html')) {
        const html = await resp.text();
        const tokens = parseConfirmTokens(html);
        if (!tokens) return jsonResp({ error: 'Could not parse Drive confirm tokens' }, 502);

        const tokenURL = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=${tokens.confirm}&uuid=${tokens.uuid}&at=${encodeURIComponent(tokens.at)}`;
        resp = await fetch(tokenURL, { headers: forwardHeaders(request) });
      }

      // Step 2：串流回應 + 加 CORS headers
      const headers = new Headers(resp.headers);
      Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
      // 確保支援 range request（影片串流必要）
      headers.set('Accept-Ranges', 'bytes');

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers
      });
    } catch (e) {
      return jsonResp({ error: e.message }, 500);
    }
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };
}

function forwardHeaders(request) {
  // 轉發 Range header 讓 video 元素能做 partial fetch
  const fwd = new Headers();
  const range = request.headers.get('range');
  if (range) fwd.set('Range', range);
  fwd.set('User-Agent', 'Mozilla/5.0 (compatible; StagePrevizProxy/1.0)');
  return fwd;
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  });
}

/**
 * 從 Drive 警告頁 HTML 解析 confirm tokens
 * Form fields: id, export, confirm, uuid, at
 */
function parseConfirmTokens(html) {
  const inputs = {};
  // 匹配 <input type="hidden" name="X" value="Y">
  const re = /<input\s+[^>]*name="([^"]+)"\s+value="([^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    inputs[m[1]] = m[2];
  }
  if (!inputs.confirm || !inputs.uuid) return null;
  return {
    confirm: inputs.confirm,
    uuid: inputs.uuid,
    at: inputs.at || ''
  };
}
