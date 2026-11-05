// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// One ComfyUI websocket per client id, shared by everything in this process that wants
// that client's events.
//
// ComfyUI keeps exactly ONE socket per client id: a second connection with the same id
// silently takes over and the first simply stops receiving (server.py pops the old entry
// before storing the new one, without closing it). `progress` and `executed` go only to
// the prompt's own client id, so two independent listeners here would not both hear them
// — hence one socket, many listeners.
//
// Best-effort by design: a socket that will not open costs its listeners their events
// and nothing else. Binary frames are live previews and are skipped.

const taps = new Map();   // `${wsUrl}` → { ws, listeners, retry }

function open(key, tap) {
  if (!tap.listeners.size) return;
  try { tap.ws = new WebSocket(key); }
  catch { tap.ws = null; return; }
  tap.ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    for (const fn of tap.listeners) { try { fn(m); } catch { /* one listener must not silence the rest */ } }
  };
  tap.ws.onerror = () => {};
  // A long render can outlive a dropped socket; ComfyUI keeps addressing the same client
  // id, so reconnecting resumes the stream.
  tap.ws.onclose = () => {
    if (!tap.listeners.size || tap.retry) return;
    tap.retry = setTimeout(() => { tap.retry = null; open(key, tap); }, 2000);
  };
}

// Calls onMessage(parsedJson) for each text frame sent to clientId. Returns close().
function tapComfy(comfyUrl, clientId, onMessage) {
  if (!comfyUrl || !clientId || typeof WebSocket === "undefined") return () => {};
  const key = `${String(comfyUrl).replace(/\/+$/, "").replace(/^http/i, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`;
  let tap = taps.get(key);
  const fresh = !tap;
  if (fresh) { tap = { ws: null, listeners: new Set(), retry: null }; taps.set(key, tap); }
  tap.listeners.add(onMessage);
  if (fresh) open(key, tap);
  return () => {
    tap.listeners.delete(onMessage);
    if (tap.listeners.size) return;
    if (tap.retry) { clearTimeout(tap.retry); tap.retry = null; }
    if (taps.get(key) === tap) taps.delete(key);
    try { tap.ws && tap.ws.close(); } catch { /* already gone */ }
  };
}

module.exports = { tapComfy };
