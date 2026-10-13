// NDI WebSocket client — 連 NDI 小程序拿即時 frames
//
// Server 在動畫師本機 ws://127.0.0.1:7777（協議見 ndi-helper/README.md）
//   - 連線後 server 送一次 text {"type":"hello",...}，接著 {"type":"status",...}（有變就推 + 每秒一次）
//   - 每幀：binary message = JPEG bytes
//   - 客戶端可送 "status" / {"type":"select_source"} / {"type":"pause"} / {"type":"resume"}
//
// 這層只管 WebSocket + 解 JPEG；「現在卡在哪一步、要不要重連」在 ndiConnection.ts
//
// 用法：
//   const client = new NdiClient({
//     onFrame: (bitmap, w, h) => { /* drawImage / texture upload */ },
//     onStatus: (s) => console.log(s),
//   });
//   client.connect();
//   ...
//   client.disconnect();

export type NdiClientStatus =
  | { kind: 'idle' }
  | { kind: 'connecting'; url: string }
  | { kind: 'connected'; url: string; helperVersion: string; source: string }
  | { kind: 'error'; message: string }
  | { kind: 'disconnected' };

interface Options {
  url?: string;                                       // 預設 ws://127.0.0.1:7777
  onFrame: (bitmap: ImageBitmap, ts: number) => void; // 每幀
  onStatus?: (s: NdiClientStatus) => void;
  onSources?: (sources: string[]) => void;            // 可用 source 清單（從 status 回應）
  /** 每一則 JSON 訊息（hello / status / select_ack / error）原樣給 */
  onMessage?: (msg: Record<string, unknown>) => void;
  /** 每收到一張 JPEG（還沒解）就叫一次；回 false = 這張不用解（暫停中） */
  onBinary?: () => boolean | void;
  /** 自動 reconnect 間隔（毫秒）；0 = 不重連（交給上層） */
  reconnectIntervalMs?: number;
}

const DEFAULT_URL = 'ws://127.0.0.1:7777';

export class NdiClient {
  private url: string;
  private ws: WebSocket | null = null;
  private opts: Options;
  private status: NdiClientStatus = { kind: 'idle' };
  private reconnectTimer: number | null = null;
  private destroyed = false;
  // 上一幀如果還在 decode，新幀進來就丟掉（節流防止記憶體爆掉）
  private decoding = false;

  constructor(opts: Options) {
    this.url = opts.url || DEFAULT_URL;
    this.opts = opts;
  }

  getStatus(): NdiClientStatus { return this.status; }

  connect() {
    if (this.destroyed) return;
    this.disconnect();
    this.setStatus({ kind: 'connecting', url: this.url });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      this.setStatus({ kind: 'disconnected' });
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onmessage = async (ev) => {
      if (this.ws !== ws) return;  // 舊的連線（已經換新的了）
      if (typeof ev.data === 'string') {
        let msg: Record<string, unknown>;
        try {
          const parsed = JSON.parse(ev.data);
          if (!parsed || typeof parsed !== 'object') return;
          msg = parsed as Record<string, unknown>;
        } catch {
          return;  // 看不懂的不理
        }
        if (msg.type === 'hello') {
          const source = typeof msg.source === 'string' && msg.source ? msg.source : '(no source)';
          this.setStatus({ kind: 'connected', url: this.url, helperVersion: String(msg.version ?? ''), source });
          // 舊版小程序不會自己送 status → 連上之後問一次（新版會回一則，無害）
          this.send('status');
        } else if (msg.type === 'status') {
          if (Array.isArray(msg.availableSources)) {
            this.opts.onSources?.(msg.availableSources.filter((s): s is string => typeof s === 'string'));
          }
          if (typeof msg.source === 'string' && msg.source && this.status.kind === 'connected') {
            this.setStatus({ ...this.status, source: msg.source });
          }
        }
        this.opts.onMessage?.(msg);
      } else {
        // Binary = JPEG bytes
        if (this.opts.onBinary?.() === false) return;
        if (this.decoding) return;          // 跳過上一幀沒解完的
        this.decoding = true;
        try {
          const blob = new Blob([ev.data as ArrayBuffer], { type: 'image/jpeg' });
          const bitmap = await createImageBitmap(blob);
          if (this.ws === ws) this.opts.onFrame(bitmap, performance.now());
          else bitmap.close?.();
        } catch {
          /* 壞掉的一張就跳過 */
        } finally {
          this.decoding = false;
        }
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus({ kind: 'disconnected' });
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.setStatus({ kind: 'error', message: '連不到 NDI 小程序' });
      // onclose 會接著觸發 → reconnect
    };
  }

  disconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    if (ws) {
      this.ws = null;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  destroy() {
    this.destroyed = true;
    this.disconnect();
  }

  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** 送 text frame 給 helper */
  send(text: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(text); } catch { /* swallow */ }
    }
  }

  /** 拉一次最新 status（含 availableSources） */
  requestStatus() { this.send('status'); }

  /** 切換 NDI source；null = 回到自動挑（這台電腦的 AE 優先） */
  selectSource(name: string | null) {
    this.send(JSON.stringify({ type: 'select_source', name }));
  }

  /** 這條連線先不要畫面（小程序沒人要畫面時就不解碼） */
  pause() { this.send(JSON.stringify({ type: 'pause' })); }

  /** 恢復收畫面 */
  resume() { this.send(JSON.stringify({ type: 'resume' })); }

  private setStatus(s: NdiClientStatus) {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    const delay = this.opts.reconnectIntervalMs ?? 3000;
    if (delay <= 0) return;
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
