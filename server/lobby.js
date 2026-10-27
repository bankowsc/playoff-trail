// server/lobby.js — who is online, who is waiting, which matches exist, and the clocks.
// It has no idea what a WebSocket is: each player has a "conn" object with a send(obj) method
// (index.js wraps the real socket). Time and timers are injectable, so tests use a fake clock.

import { randomInt } from "node:crypto";
import { Match } from "./match.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no I, O, 0 or 1, so codes are easy to read out loud

export class Lobby {
  constructor({ teamsByMode, turnMs, graceMs, roomTtlMs = 15 * 60 * 1000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random }) {
    this.teamsByMode = teamsByMode;           // { pro: [...], ncaa: [...], ucl: [...] }, only modes that loaded
    this.turnMs = turnMs;
    this.graceMs = graceMs;
    this.roomTtlMs = roomTtlMs;               // how long an unused invite stays open
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.random = random;
    this.players = new Map();                 // playerId -> { id, name, conn, status, mode, hard, matchId, graceTimer }
    this.queues = new Map();                  // "mode:hard" -> [playerId, ...] in arrival order
    this.matches = new Map();                 // matchId -> Match
    this.timers = new Map();                  // matchId -> the turn timer for that match
    this.rooms = new Map();                   // invite code -> { code, hostId, timer }
  }

  // ---------- small helpers ----------
  send(p, obj) { if (p && p.conn) p.conn.send(obj); }
  err(p, code) { this.send(p, { type: "error", code }); }

  matchOf(p) { return p && p.matchId ? this.matches.get(p.matchId) : undefined; }

  broadcast(m) {
    m.players.forEach((pl, i) => {
      const p = this.players.get(pl.id);
      if (p && p.matchId === m.id) this.send(p, { type: "state", state: m.view(pl.id, this.now()) });
    });
  }

  stats() {
    const waiting = [...this.queues.values()].reduce((n, q) => n + q.length, 0);
    return { players: this.players.size, waiting, matches: this.matches.size, rooms: this.rooms.size };
  }

  // ---------- connections ----------
  connect(id, name, conn) {
    let p = this.players.get(id);
    const resumed = !!p;
    if (!p) {
      p = { id, name, conn: null, status: "idle", mode: null, hard: false, matchId: null, roomCode: null, graceTimer: null };
      this.players.set(id, p);
    }
    p.name = name;
    if (p.conn && p.conn !== conn && p.conn.close) p.conn.close("replaced");   // another tab took over this id
    p.conn = conn;
    if (p.graceTimer) { this.clearTimer(p.graceTimer); p.graceTimer = null; }

    this.send(p, { type: "welcome", playerId: id, serverNow: this.now(), resumed });
    const m = this.matchOf(p);
    if (m) {
      m.players.find(pl => pl.id === id).name = name;
      m.connected[m.indexOf(id)] = true;
      this.broadcast(m);                                  // the reconnecting player gets the full snapshot
    } else {
      p.matchId = null;
      if (p.status === "queued") this.send(p, { type: "queued", mode: p.mode, hard: p.hard });
      else if (p.status === "hosting" && this.rooms.has(p.roomCode)) this.send(p, { type: "room", code: p.roomCode, mode: p.mode, hard: p.hard });
      else this.send(p, { type: "idle" });
    }
    return p;
  }

  disconnect(id, conn) {
    const p = this.players.get(id);
    if (!p || p.conn !== conn) return;                    // an old, replaced connection closing: ignore
    p.conn = null;
    if (p.status === "queued") this.dequeue(id, false);   // queue entries must have a live socket
    if (p.status === "hosting") {                         // a refresh or a flaky connection shouldn't kill the invite
      p.graceTimer = this.setTimer(() => this.dropHost(id), this.graceMs);
      return;
    }
    const m = this.matchOf(p);
    if (!m) { this.players.delete(id); return; }
    m.connected[m.indexOf(id)] = false;
    this.broadcast(m);
    p.graceTimer = this.setTimer(() => this.forfeitAndDrop(id), this.graceMs);   // come back in time or lose
  }

  // ---------- queue + pairing ----------
  enqueue(id, mode, hard, name) {
    const p = this.players.get(id);
    if (!p) return;
    if (name) p.name = name;                              // players can set their name when they queue
    if (!this.teamsByMode[mode]) return this.err(p, "bad_mode");
    const cur = this.matchOf(p);
    if (cur) {
      if (cur.status === "playing") return this.err(p, "in_match");
      this.leaveMatch(p);                                 // finished match: walk away from it
    }
    this.closeRoom(p.roomCode, false);
    this.dequeue(id, false);
    p.mode = mode; p.hard = !!hard; p.status = "queued";
    const k = `${mode}:${p.hard ? 1 : 0}`;
    if (!this.queues.has(k)) this.queues.set(k, []);
    this.queues.get(k).push(id);
    this.send(p, { type: "queued", mode, hard: p.hard });
    this.tryPair(k);
  }

  dequeue(id, notify = true) {
    const p = this.players.get(id);
    if (!p) return;
    for (const q of this.queues.values()) {
      const i = q.indexOf(id);
      if (i >= 0) q.splice(i, 1);
    }
    if (p.status === "queued") p.status = "idle";
    if (notify) this.send(p, { type: "idle" });
  }

  tryPair(k) {
    const q = this.queues.get(k) || [];
    while (q.length >= 2) {
      const a = this.players.get(q.shift());
      const b = this.players.get(q.shift());
      if (!a || !a.conn) { if (b) q.unshift(b.id); continue; }   // stale entries should not exist, but be safe
      if (!b || !b.conn) { q.unshift(a.id); continue; }
      this.startMatch(a, b);
    }
  }

  startMatch(a, b, prev = null) {
    const mode = a.mode, hard = a.hard;
    const m = new Match({
      mode, hard,
      teams: this.teamsByMode[mode],
      players: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }],
      firstTurn: prev ? 1 - prev.firstTurn : (this.random() < 0.5 ? 0 : 1),   // rematches swap who starts
      turnMs: this.turnMs,
    });
    m.start(this.now());
    this.matches.set(m.id, m);
    for (const p of [a, b]) { p.status = "playing"; p.matchId = m.id; p.mode = mode; p.hard = hard; }
    this.schedule(m);
    this.broadcast(m);
  }

  // ---------- private rooms (invite a friend) ----------
  newCode() {
    for (let tries = 0; tries < 50; tries++) {
      let c = "";
      for (let i = 0; i < 5; i++) c += CODE_CHARS[randomInt(CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error("could not make a free room code");
  }

  createRoom(id, mode, hard, name) {
    const p = this.players.get(id);
    if (!p) return;
    if (!this.teamsByMode[mode]) return this.err(p, "bad_mode");
    const cur = this.matchOf(p);
    if (cur) {
      if (cur.status === "playing") return this.err(p, "in_match");
      this.leaveMatch(p);
    }
    this.dequeue(id, false);
    this.closeRoom(p.roomCode, false);                    // a new invite replaces your old one
    if (name) p.name = name;
    const code = this.newCode();
    p.mode = mode; p.hard = !!hard; p.status = "hosting"; p.roomCode = code;
    this.rooms.set(code, { code, hostId: id, timer: this.setTimer(() => this.expireRoom(code), this.roomTtlMs) });
    this.send(p, { type: "room", code, mode, hard: p.hard });
  }

  joinRoom(id, code, name) {
    const p = this.players.get(id);
    if (!p) return;
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) return this.err(p, "room_not_found");
    if (room.hostId === id) return this.err(p, "own_room");
    const host = this.players.get(room.hostId);
    if (!host || !host.conn) return this.err(p, "room_not_found");   // the host dropped and is still inside the grace period
    const cur = this.matchOf(p);
    if (cur) {
      if (cur.status === "playing") return this.err(p, "in_match");
      this.leaveMatch(p);
    }
    this.dequeue(id, false);
    this.closeRoom(p.roomCode, false);                    // if the joiner had their own invite open, close it
    if (name) p.name = name;
    this.closeRoom(room.code, false);
    this.startMatch(host, p);                             // the host's mode and difficulty decide the game
  }

  cancel(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.status === "hosting") this.closeRoom(p.roomCode, true);
    else this.dequeue(id);
  }

  closeRoom(code, notify = true) {
    const room = code && this.rooms.get(code);
    if (!room) return;
    this.clearTimer(room.timer);
    this.rooms.delete(code);
    const h = this.players.get(room.hostId);
    if (h && h.roomCode === code) {
      h.roomCode = null;
      if (h.status === "hosting") h.status = "idle";
      if (notify) this.send(h, { type: "idle" });
    }
  }

  expireRoom(code) {
    const room = this.rooms.get(code);
    const h = room && this.players.get(room.hostId);
    this.closeRoom(code, true);
    if (h) this.err(h, "room_expired");
  }

  dropHost(id) {                                          // the host never came back
    const p = this.players.get(id);
    if (!p) return;
    this.closeRoom(p.roomCode, false);
    this.players.delete(id);
  }

  // ---------- the turn clock ----------
  schedule(m) {
    this.killTimer(m.id);
    if (m.status !== "playing") return;
    const turnNo = m.turnNo;
    const wait = Math.max(0, m.deadline - this.now()) + 25;     // a hair after the deadline so now >= deadline holds
    this.timers.set(m.id, this.setTimer(() => this.onTimeout(m.id, turnNo), wait));
  }

  killTimer(matchId) {
    const t = this.timers.get(matchId);
    if (t !== undefined) this.clearTimer(t);
    this.timers.delete(matchId);
  }

  onTimeout(matchId, turnNo) {
    const m = this.matches.get(matchId);
    if (m && m.timeout(this.now(), turnNo)) this.afterChange(m);
  }

  afterChange(m) {
    this.schedule(m);                                     // restarts the clock, or clears it when the match is over
    this.broadcast(m);
  }

  // ---------- in-match actions ----------
  guess(id, team) {
    const p = this.players.get(id), m = this.matchOf(p);
    if (!m) return p && this.err(p, "no_match");
    const r = m.submitGuess(id, team, this.now());
    if (r.changed) this.afterChange(m);
    if (!r.ok) return this.err(p, r.error);
    this.afterChange(m);
  }

  rematch(id) {
    const p = this.players.get(id), m = this.matchOf(p);
    if (!m || m.status !== "over") return p && this.err(p, "not_over");
    const i = m.indexOf(id), o = this.players.get(m.players[1 - i].id);
    if (!o || !o.conn || m.left[1 - i] || o.matchId !== m.id) return this.err(p, "opponent_gone");
    m.rematch[i] = true;
    if (m.rematch[0] && m.rematch[1]) {
      const a = this.players.get(m.players[0].id), b = this.players.get(m.players[1].id);
      this.killTimer(m.id);
      this.matches.delete(m.id);
      this.startMatch(a, b, m);
    } else {
      this.broadcast(m);
    }
  }

  newOpponent(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (!p.mode) return this.err(p, "bad_mode");
    this.enqueue(id, p.mode, p.hard);
  }

  leave(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.dequeue(id, false);
    this.closeRoom(p.roomCode, false);
    if (p.matchId) this.leaveMatch(p);
    p.status = "idle";
    this.send(p, { type: "idle" });
  }

  // ---------- leaving, forfeits, cleanup ----------
  leaveMatch(p) {
    const m = this.matchOf(p);
    p.matchId = null;
    if (!m) return;
    m.left[m.indexOf(p.id)] = true;
    if (m.status === "playing") { m.forfeit(p.id); this.afterChange(m); }
    else this.broadcast(m);
    this.cleanup(m);
  }

  forfeitAndDrop(id) {                                    // grace period ran out
    const p = this.players.get(id);
    if (!p) return;
    const m = this.matchOf(p);
    if (m) {
      m.left[m.indexOf(id)] = true;
      if (m.status === "playing") m.forfeit(id);
      p.matchId = null;
      this.players.delete(id);
      this.afterChange(m);
      this.cleanup(m);
    } else {
      this.players.delete(id);
    }
  }

  cleanup(m) {                                            // forget a match once nobody is attached to it
    const alive = m.players.some(pl => { const p = this.players.get(pl.id); return p && p.matchId === m.id; });
    if (!alive) { this.killTimer(m.id); this.matches.delete(m.id); }
  }
}
