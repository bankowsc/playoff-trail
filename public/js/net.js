// public/js/net.js — the WebSocket connection: hello handshake, reconnecting, and server-clock offset.

const ID_KEY = "duel:playerId";

// One id per TAB (sessionStorage), so two tabs on one computer are two different players while testing.
// A refresh keeps the id, which is what lets the server put you back into your match.
export function getPlayerId() {
  try {
    let id = sessionStorage.getItem(ID_KEY);
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
      sessionStorage.setItem(ID_KEY, id);
    }
    return id;
  } catch {
    return "anon" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

export function createNet({ url, getName, onMessage, onStatus }) {
  let ws = null, tries = 0, timer = null, stopped = false;
  const api = { offset: 0, playerId: getPlayerId(), connected: false, connect, send, close };

  function connect() {
    if (stopped || (ws && ws.readyState <= 1)) return;          // already connecting or open
    clearTimeout(timer);
    onStatus("connecting");
    ws = new WebSocket(url);

    ws.onopen = () => {
      tries = 0;
      api.connected = true;
      onStatus("online");
      raw({ type: "hello", playerId: api.playerId, name: getName() });
    };

    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const serverNow = typeof m.serverNow === "number" ? m.serverNow : m.state && m.state.serverNow;
      if (typeof serverNow === "number") api.offset = serverNow - Date.now();   // add this to Date.now() to get server time
      onMessage(m);
    };

    ws.onclose = ev => {
      api.connected = false;
      if (ev.code === 4000) { stopped = true; onStatus("replaced"); return; }   // another tab took over this player
      onStatus("reconnecting");
      const wait = Math.min(5000, 400 * 2 ** tries++) * (0.7 + Math.random() * 0.6);
      timer = setTimeout(connect, wait);
    };
    ws.onerror = () => { };                                    // onclose always follows
  }

  function raw(obj) { ws.send(JSON.stringify(obj)); }

  function send(type, data = {}) {
    if (!ws || ws.readyState !== 1) return false;
    raw({ type, ...data });
    return true;
  }

  function close() { stopped = true; clearTimeout(timer); if (ws) ws.close(); }

  // Coming back to a tab that lost its connection: reconnect now instead of waiting for the back-off timer.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !api.connected && !stopped) connect();
  });

  return api;
}
