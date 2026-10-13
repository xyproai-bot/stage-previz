#!/usr/bin/env python3
"""CI 冒煙測試：連上剛啟動的 helper，確認 hello + status 會來、Origin 檢查有作用。

用法：python3 ci/smoke.py <port>
（helper 要先用 STAGE_PREVIZ_NDI_HEADLESS=1 STAGE_PREVIZ_NDI_PORT=<port> 跑起來）
不需要任何套件，只用標準函式庫手刻 WebSocket 握手。
"""
import base64
import json
import os
import socket
import sys
import time


def connect(port, origin=None, timeout=20):
    deadline = time.time() + timeout
    while True:
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=5)
            break
        except OSError:
            if time.time() > deadline:
                sys.exit("FAIL: helper did not open port %d" % port)
            time.sleep(0.5)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        "GET / HTTP/1.1\r\n"
        "Host: 127.0.0.1:%d\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n" % (port, key)
    )
    if origin:
        req += "Origin: %s\r\n" % origin
    s.sendall((req + "\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    status_line = head.split(b"\r\n")[0].decode(errors="replace")
    return s, status_line, rest


def read_text_messages(s, rest, count):
    buf = bytearray(rest)

    def need(n):
        while len(buf) < n:
            chunk = s.recv(65536)
            if not chunk:
                sys.exit("FAIL: connection closed early")
            buf.extend(chunk)

    out = []
    while len(out) < count:
        need(2)
        opcode = buf[0] & 0x0F
        ln = buf[1] & 0x7F
        off = 2
        if ln == 126:
            need(4)
            ln = int.from_bytes(buf[2:4], "big")
            off = 4
        elif ln == 127:
            need(10)
            ln = int.from_bytes(buf[2:10], "big")
            off = 10
        need(off + ln)
        payload = bytes(buf[off:off + ln])
        del buf[:off + ln]
        if opcode == 1:
            out.append(json.loads(payload.decode()))
    return out


def main():
    port = int(sys.argv[1])

    s, status_line, rest = connect(port)
    if " 101 " not in status_line:
        sys.exit("FAIL: handshake: %s" % status_line)
    hello, status = read_text_messages(s, rest, 2)
    s.close()
    print("hello :", json.dumps(hello))
    print("status:", json.dumps(status))
    assert hello["type"] == "hello" and hello["protocol"] >= 2, hello
    assert status["type"] == "status", status
    assert status["ndi"] in ("starting", "missing", "ready", "error"), status
    for k in ("state", "sources", "availableSources", "source", "fps", "maxFps", "receiving", "error", "autostart"):
        assert k in status, "status missing %s" % k
    # CI 機器沒裝 NDI → 應該回報 missing（讓網頁顯示「請先安裝 NDI Tools」）
    if status["ndi"] == "missing":
        assert status["state"] == "ndi_missing" and status["error"]["code"] == "ndi_missing", status
    # 開機自動啟動的實際狀況（CI 設了 STAGE_PREVIZ_NDI_NO_AUTOSTART → 不寫，也不會有錯誤）
    auto = status["autostart"]
    assert set(auto) >= {"wanted", "registered", "error"}, auto
    if os.environ.get("STAGE_PREVIZ_NDI_NO_AUTOSTART"):
        assert auto["error"] is None, auto

    # log 也要寫進設定資料夾的 helper.log（Release 版沒有主控台，不然出錯看不到）
    cfg_dir = os.environ.get("STAGE_PREVIZ_NDI_CONFIG_DIR")
    if cfg_dir:
        log_path = os.path.join(cfg_dir, "helper.log")
        with open(log_path, encoding="utf-8", errors="replace") as f:
            log_text = f.read()
        assert "Stage Previz NDI Helper v" in log_text, log_text[:500]
        print("helper.log OK (%d bytes)" % len(log_text))

    s, status_line, _ = connect(port, origin="https://evil.example.com")
    s.close()
    if " 403 " not in status_line:
        sys.exit("FAIL: foreign origin should get 403, got: %s" % status_line)
    s, status_line, _ = connect(port, origin="https://stage-previz.vercel.app")
    s.close()
    if " 101 " not in status_line:
        sys.exit("FAIL: production origin should be allowed, got: %s" % status_line)
    print("OK")


if __name__ == "__main__":
    main()
