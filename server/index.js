// server/index.js — the entry point. Run with:  npm run dev
// It does four things: loads the team data, serves the files in public/, accepts WebSocket
// connections at /ws, and routes each incoming message to the lobby.

import http from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, normalize, extname } from "node:path";
import { WebSocketServer } from "ws";

import { PORT, TURN_MS, GRACE_MS, HEARTBEAT_MS, MAX_MSG_BYTES, MSGS_PER_SEC } from "./config.js";
import { checkTeams } from "./rules.js";
import { parse, check, cleanName, MODE_NAMES } from "./protocol.js";
import { Lobby } from "./lobby.js";

// ---------- load the team data (full data, histories included, stays on the server) ----------
const dataDir = process.env.DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url));
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

const teamsByMode = {};
for (const mode of MODE_NAMES) {
  const file = join(dataDir, `${mode}.json`);
  try {
    teamsByMode[mode] = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.warn(`[data] ${mode}.json missing or invalid (${e.message.split("\n")[0]}), so "${mode}" mode is disabled`);
    continue;
  }
  if (!teamsByMode[mode].length) { delete teamsByMode[mode]; console.warn(`[data] ${mode}.json is empty, so "${mode}" mode is disabled`); continue; }
  checkTeams(teamsByMode[mode]).forEach(problem => console.warn(`[data] ${mode}: ${problem}`));
}

// What browsers may see: everything except "history". Used for the autocomplete list.
const publicTeams = JSON.stringify(Object.fromEntries(
  Object.entries(teamsByMode).map(([mode, list]) => [mode, list.map(({ history, ...pub }) => pub)])
));

const lobby = new Lobby({ teamsByMode, turnMs: TURN_MS, graceMs: GRACE_MS });

// ---------- HTTP: static files ----------
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

function reply(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "text/plain", "Method not allowed");
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/teams.json") return reply(res, 200, TYPES[".json"], publicTeams);
    if (pathname === "/healthz") return reply(res, 200, TYPES[".json"], JSON.stringify({ ok: true, ...lobby.stats() }));

    const file = normalize(join(publicDir, decodeURIComponent(pathname === "/" ? "/index.html" : pathname)));
    if (!file.startsWith(publicDir)) return reply(res, 403, "text/plain", "Forbidden");   // blocks ../ tricks
    reply(res, 200, TYPES[extname(file)] || "application/octet-stream", await readFile(file));
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "EISDIR") return reply(res, 404, "text/plain", "Not found");
    console.error(e);
    reply(res, 500, "text/plain", "Server error");
  }
});

// ---------- WebSocket ----------
// Optional: only accept sockets opened by your own site. Set ALLOWED_ORIGINS=https://duel.yourdomain.com (comma separated).
const ALLOWED = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const wss = new WebSocketServer({
  server, path: "/ws", maxPayload: MAX_MSG_BYTES,
  verifyClient: ({ origin }) => ALLOWED.length === 0 || ALLOWED.includes(origin),
});

wss.on("connection", socket => {
  const conn = {                                           // the lobby only ever sees this small wrapper
    send(obj) { if (socket.readyState === 1) socket.send(JSON.stringify(obj)); },
    close(reason) { socket.close(4000, String(reason).slice(0, 100)); },
  };
  let id = null;                                           // set by the first "hello"
  let windowStart = Date.now(), count = 0;                 // simple flood guard
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  socket.on("message", raw => {
    const t = Date.now();
    if (t - windowStart > 1000) { windowStart = t; count = 0; }
    if (++count > MSGS_PER_SEC) return;

    const m = parse(raw.toString());
    if (!m) return conn.send({ type: "error", code: "bad_json" });
    const problem = check(m);
    if (problem) return conn.send({ type: "error", code: problem });

    if (!id) {                                             // the first message must be hello
      if (m.type !== "hello") return conn.send({ type: "error", code: "say_hello_first" });
      id = m.playerId;
      lobby.connect(id, cleanName(m.name), conn);
      return;
    }

    switch (m.type) {
      case "queue": lobby.enqueue(id, m.mode, !!m.hard, m.name === undefined ? undefined : cleanName(m.name)); break;
      case "cancel": lobby.cancel(id); break;
      case "createRoom": lobby.createRoom(id, m.mode, !!m.hard, m.name === undefined ? undefined : cleanName(m.name)); break;
      case "joinRoom": lobby.joinRoom(id, m.code, m.name === undefined ? undefined : cleanName(m.name)); break;
      case "guess": lobby.guess(id, m.team); break;
      case "rematch": lobby.rematch(id); break;
      case "newOpponent": lobby.newOpponent(id); break;
      case "leave": lobby.leave(id); break;
      case "ping": conn.send({ type: "pong", serverNow: Date.now() }); break;
      // "hello" again on the same socket is ignored
    }
  });

  socket.on("close", () => { if (id) lobby.disconnect(id, conn); });
  socket.on("error", () => { });                           // 'close' follows; nothing else to do
});

// Heartbeat: drop sockets that stopped answering so they don't sit in the queue as ghosts.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

server.listen(PORT, () => {
  console.log(`Playoff Duel listening on http://localhost:${PORT}  (turn ${TURN_MS / 1000}s, modes: ${Object.keys(teamsByMode).join(", ") || "none loaded"})`);
});
