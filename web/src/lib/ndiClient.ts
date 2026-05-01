// NDI WebSocket client — 連 ndi-helper.exe 拿即時 frames
//
// Server 在動畫師本機 ws://127.0.0.1:7777
// 協議：
//   - 連線後 server 送一次 text {"type":"hello",...}
//   - 之後每幀：binary message = JPEG bytes
//   - 客戶端可送 "status" → 回 {"type":"status",...}
//
// 用法：
//   const client = new NdiClient({
//     onFrame: (bitmap, w, h) => { /* drawImage / texture upload */ },
//     onStatus: (s) => console.log(s),
//   });
//   client.connect();
//   ...
//   client.disconnect();

export interface NdiHelloMessage {
  type: 'hello';
  version: string;
  source: string;
}

export interface NdiStatusMessage {
  type: 'status';
  source: string | null;
  fps: number;
  frameCount: number;
  clients: number;
  lastError: string | null;
  availableSources?: string[];
}

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
  /** 自動 reconnect 間隔（毫秒）；0 = 不重連 */
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
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      // 等 hello 才視為 connected（server 開連線後立刻送）
    };

    ws.onmessage = async (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'hello') {
            this.setStatus({ kind: 'connected', url: this.url, helperVersion: msg.version, source: msg.source || '(no source)' });
            // 連上之後立刻問一次 status 拿 available sources
            this.send('status');
          } else if (msg.type === 'status') {
            if (Array.isArray(msg.availableSources)) {
              this.opts.onSources?.(msg.availableSources);
            }
            if (typeof msg.source === 'string' && msg.source && this.status.kind === 'connected') {
              this.setStatus({ ...this.status, source: msg.source });
            }
          } else if (msg.type === 'select_ack') {
            // helper 已收到切換指令
          }
        } catch {
          /* ignore parse errors */
        }
      } else {
        // Binary = JPEG bytes
        if (this.decoding) return;          // 跳過上一幀沒解完的
        this.decoding = true;
        try {
          const blob = new Blob([ev.data as ArrayBuffer], { type: 'image/jpeg' });
          const bitmap = await createImageBitmap(blob);
          this.opts.onFrame(bitmap, performance.now());
        } catch (e) {
          console.warn('[NdiClient] decode failed:', e);
        } finally {
          this.decoding = false;
        }
      }
    };

    ws.onclose = () => {
      this.setStatus({ kind: 'disconnected' });
      this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      this.setStatus({ kind: 'error', message: 'WebSocket error（NDI helper.exe 沒在跑？）' });
      // onclose 會被觸發 → reconnect
    };
  }

  disconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  destroy() {
    this.destroyed = true;
    this.disconnect();
  }

  /** 送 text frame 給 helper */
  send(text: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(text); } catch { /* swallow */ }
    }
  }

  /** 拉一次最新 status（含 availableSources） */
  requestStatus() { this.send('status'); }

  /** 切換 NDI source（helper 收到會 restart receiver） */
  selectSource(name: string) {
    this.send(JSON.stringify({ type: 'select_source', name }));
  }

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
