// server/lobby.js — who is online, who is waiting, which matches and private lobbies exist, and the clocks.
// It has no idea what a WebSocket is: each player has a "conn" object with a send(obj) method
// (index.js wraps the real socket). Time and timers are injectable, so tests use a fake clock.
//
// Two ways to get into a game:
//   1. The public queue: two strangers in the same game and difficulty are paired into a 1v1 match.
//   2. A private lobby ("Invite friends"): up to 7 people join with a code or link. Everybody waits in a
//      waiting room until the host presses Start (needs 2+ people). The lobby keeps a win count per
//      player across games. After a game, each player chooses Play again (ready) or leaves; the host's next
//      Start only includes the players who said yes.

import { randomInt } from "node:crypto";
import { Match } from "./match.js";
import { TeamPicker } from "./picker.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no I, O, 0 or 1, so codes are easy to read out loud
export const ROOM_MAX = 7;

export class Lobby {
  constructor({ teamsByMode, turnMs, graceMs, roomTtlMs = 30 * 60 * 1000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random }) {
    this.teamsByMode = teamsByMode;           // { pro: [...], ncaa: [...], ucl: [...] }, only modes that loaded
    this.turnMs = turnMs;
    this.graceMs = graceMs;
    this.roomTtlMs = roomTtlMs;               // a lobby nobody touches for this long is closed
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.random = random;
    this.picker = new TeamPicker(teamsByMode);   // chooses each game's secret team, spreading the sports evenly
    this.players = new Map();                 // playerId -> { id, name, conn, status, mode, hard, matchId, roomCode, graceTimer }
    this.queues = new Map();                  // "mode:hard" -> [playerId, ...] in arrival order
    this.matches = new Map();                 // matchId -> Match
    this.timers = new Map();                  // matchId -> the turn timer for that match
    this.rooms = new Map();                   // code -> { code, mode, hard, hostId, status, members, scores, matchId, lastFirstId, games, timer }
  }

  // ---------- small helpers ----------
  send(p, obj) { if (p && p.conn) p.conn.send(obj); }
  err(p, code) { this.send(p, { type: "error", code }); }
  matchOf(p) { return p && p.matchId ? this.matches.get(p.matchId) : undefined; }
  roomOf(p) { return p && p.roomCode ? this.rooms.get(p.roomCode) : undefined; }

  stats() {
    const waiting = [...this.queues.values()].reduce((n, q) => n + q.length, 0);
    return { players: this.players.size, waiting, matches: this.matches.size, rooms: this.rooms.size };
  }

  // Sends every connected player in a public match their snapshot. Private-lobby matches go through pushRoom.
  broadcast(m) {
    const room = m.roomCode && this.rooms.get(m.roomCode);
    if (room) return this.pushRoom(room);
    m.players.forEach(pl => {
      const p = this.players.get(pl.id);
      if (p && p.matchId === m.id) this.send(p, { type: "state", state: m.view(pl.id, this.now()) });
    });
  }

  // ---------- connections ----------
  connect(id, name, conn) {
    let p = this.players.get(id);
    const resumed = !!p;
    if (!p) {
      p = { id, name, conn: null, status: "idle", mode: null, hard: false, matchId: null, roomCode: null, graceTimer: null };
      this.players.set(id, p);
    }
    if (!p.roomCode && !p.matchId) p.name = name;         // inside a lobby or match your name stays as it was
    if (p.conn && p.conn !== conn && p.conn.close) p.conn.close("replaced");   // another tab took over this id
    p.conn = conn;
    if (p.graceTimer) { this.clearTimer(p.graceTimer); p.graceTimer = null; }

    this.send(p, { type: "welcome", playerId: id, serverNow: this.now(), resumed });
    const room = this.roomOf(p), m = this.matchOf(p);
    if (m) m.connected[m.indexOf(id)] = true;
    if (room) this.pushRoom(room);                         // everyone sees you are back; you get the full picture
    else if (m) this.broadcast(m);
    else {
      p.matchId = null;
      if (p.status === "queued") this.send(p, { type: "queued", mode: p.mode, hard: p.hard });
      else this.send(p, { type: "idle" });
    }
    return p;
  }

  disconnect(id, conn) {
    const p = this.players.get(id);
    if (!p || p.conn !== conn) return;                    // an old, replaced connection closing: ignore
    p.conn = null;
    if (p.status === "queued") this.dequeue(id, false);   // queue entries must have a live socket
    const m = this.matchOf(p), room = this.roomOf(p);
    if (!m && !room) { this.players.delete(id); return; }
    if (m) m.connected[m.indexOf(id)] = false;
    if (room) this.pushRoom(room); else this.broadcast(m);
    p.graceTimer = this.setTimer(() => this.dropPlayer(id), this.graceMs);   // come back in time or you are out
  }

  dropPlayer(id) {                                        // the grace period ran out
    const p = this.players.get(id);
    if (!p) return;
    if (p.roomCode) { this.leaveRoom(p, false); this.players.delete(id); }
    else this.forfeitAndDrop(id);
  }

  // Frees a player from whatever they are in so they can start something new. Returns an error code if they can't.
  freeUp(p) {
    const room = this.roomOf(p);
    if (room) {
      if (room.status === "playing" && p.matchId) return "in_match";
      this.leaveRoom(p, false);
    } else {
      const cur = this.matchOf(p);
      if (cur) {
        if (cur.status === "playing") return "in_match";
        this.leaveMatch(p);                               // a finished match: just walk away from it
      }
    }
    this.dequeue(p.id, false);
    return null;
  }

  // ---------- public queue + pairing ----------
  enqueue(id, mode, hard, name) {
    const p = this.players.get(id);
    if (!p) return;
    if (!this.teamsByMode[mode]) return this.err(p, "bad_mode");
    const busy = this.freeUp(p);
    if (busy) return this.err(p, busy);
    if (name) p.name = name;                              // players can set their name when they queue
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
      target: this.picker.pick(mode),
      turnMs: this.turnMs,
    });
    m.start(this.now());
    this.matches.set(m.id, m);
    for (const p of [a, b]) { p.status = "playing"; p.matchId = m.id; p.mode = mode; p.hard = hard; }
    this.schedule(m);
    this.broadcast(m);
  }

  // ---------- private lobbies (invite friends) ----------
  newCode() {
    for (let tries = 0; tries < 50; tries++) {
      let c = "";
      for (let i = 0; i < 5; i++) c += CODE_CHARS[randomInt(CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error("could not make a free lobby code");
  }

  uniqueName(room, name, exceptId) {                      // two "Sam"s in one lobby become "Sam" and "Sam 2"
    const taken = new Set(room.members.filter(m => m.id !== exceptId).map(m => (this.players.get(m.id)?.name || "").toLowerCase()));
    let n = name, i = 2;
    while (taken.has(n.toLowerCase())) n = `${name.slice(0, 13)} ${i++}`;
    return n;
  }

  createRoom(id, mode, hard, name) {
    const p = this.players.get(id);
    if (!p) return;
    if (!this.teamsByMode[mode]) return this.err(p, "bad_mode");
    const busy = this.freeUp(p);
    if (busy) return this.err(p, busy);
    if (name) p.name = name;
    const code = this.newCode();
    const room = {
      code, mode, hard: !!hard, hostId: id, status: "waiting", members: [{ id, ready: true }], scores: new Map(),
      matchId: null, lastFirstId: null, games: 0, timer: null
    };
    this.rooms.set(code, room);
    p.roomCode = code; p.status = "lobby"; p.mode = mode; p.hard = room.hard;
    this.touch(room);
    this.pushRoom(room);
  }

  joinRoom(id, code, name) {
    const p = this.players.get(id);
    if (!p) return;
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) return this.err(p, "room_not_found");
    if (room.members.some(m => m.id === id)) return this.pushRoom(room);   // already inside (a refresh with the link): just resend
    if (room.status === "playing") return this.err(p, "room_busy");
    if (room.members.length >= ROOM_MAX) return this.err(p, "room_full");
    const busy = this.freeUp(p);
    if (busy) return this.err(p, busy);
    if (room.members.length >= ROOM_MAX) return this.err(p, "room_full");  // (leaving a lobby can't free a seat here, but be safe)
    if (name) p.name = name;
    p.name = this.uniqueName(room, p.name, id);
    room.members.push({ id, ready: true });                // joining means you want to play
    p.roomCode = room.code; p.status = "lobby"; p.mode = room.mode; p.hard = room.hard;
    this.touch(room);
    this.pushRoom(room);
  }

  // The host presses Start. Everyone who is ready (and still connected) plays; anyone else is released from the lobby.
  startRoom(id) {
    const p = this.players.get(id), room = this.roomOf(p);
    if (!room) return p && this.err(p, "no_room");
    if (room.hostId !== id) return this.err(p, "not_host");
    if (room.status === "playing") return this.err(p, "already_playing");
    room.members.find(m => m.id === id).ready = true;      // pressing Start counts as being ready
    const ready = room.members.filter(m => m.ready && this.players.get(m.id)?.conn);
    if (ready.length < 2) return this.err(p, "not_enough_players");
    const keep = new Set(ready.map(m => m.id));
    for (const mb of [...room.members]) if (!keep.has(mb.id)) this.dismiss(room, mb.id, "removed_not_ready");
    this.startRoomMatch(room);
  }

  startRoomMatch(room) {
    const parts = room.members.map(mb => this.players.get(mb.id));
    const j = parts.findIndex(pp => pp.id === room.lastFirstId);
    const first = room.lastFirstId ? (j + 1) % parts.length : Math.floor(this.random() * parts.length);   // the starter rotates each game
    const m = new Match({
      mode: room.mode, hard: room.hard,
      teams: this.teamsByMode[room.mode],
      players: parts.map(pp => ({ id: pp.id, name: pp.name })),
      firstTurn: first,
      target: this.picker.pick(room.mode),
      turnMs: this.turnMs,
    });
    m.roomCode = room.code;
    if (room.matchId) { this.killTimer(room.matchId); this.matches.delete(room.matchId); }   // retire the previous game's board
    room.matchId = m.id; room.lastFirstId = m.players[first].id; room.status = "playing"; room.games++;
    m.start(this.now());
    this.matches.set(m.id, m);
    for (const pp of parts) { pp.status = "playing"; pp.matchId = m.id; }
    this.touch(room);
    this.schedule(m);
    this.pushRoom(room);
  }

  // "Play again" for a lobby member: they are in for the next game. The host still has to press Start.
  readyUp(p) {
    const room = this.roomOf(p);
    if (!room) return;
    if (room.status === "playing") return this.err(p, "not_over");
    room.members.find(m => m.id === p.id).ready = true;
    this.touch(room);
    this.pushRoom(room);
  }

  // A member leaves (or is dropped). If a game is running they are skipped; the host role passes on; an empty lobby closes.
  leaveRoom(p, notify = true) {
    const room = this.roomOf(p);
    if (!room) return;
    const m = room.matchId && this.matches.get(room.matchId);
    const inMatch = !!m && p.matchId === m.id;
    if (inMatch) m.remove(p.id, this.now());
    room.members = room.members.filter(x => x.id !== p.id);
    p.roomCode = null; p.matchId = null; p.status = "idle";
    if (notify) this.send(p, { type: "idle" });
    if (!room.members.length) return this.closeRoom(room);
    if (room.hostId === p.id) {                            // pass the keys to the next person who is still connected
      const next = room.members.find(x => this.players.get(x.id)?.conn) || room.members[0];
      room.hostId = next.id;
    }
    this.touch(room);
    if (inMatch) this.afterChange(m);                      // may have ended the game; credits a win; re-broadcasts
    else this.pushRoom(room);
  }

  dismiss(room, id, code) {                                // the host started without this player: back to the lobby screen
    const p = this.players.get(id);
    room.members = room.members.filter(x => x.id !== id);
    if (!p) return;
    p.roomCode = null; p.matchId = null; p.status = "idle";
    if (p.conn) { this.send(p, { type: "idle" }); this.err(p, code); }
    else { if (p.graceTimer) this.clearTimer(p.graceTimer); this.players.delete(id); }
  }

  closeRoom(room, errCode) {
    if (room.timer) this.clearTimer(room.timer);
    this.rooms.delete(room.code);
    if (room.matchId) { this.killTimer(room.matchId); this.matches.delete(room.matchId); }
    for (const mb of room.members) {
      const p = this.players.get(mb.id);
      if (!p) continue;
      p.roomCode = null; p.matchId = null; p.status = "idle";
      if (p.conn) { this.send(p, { type: "idle" }); if (errCode) this.err(p, errCode); }
      else { if (p.graceTimer) this.clearTimer(p.graceTimer); this.players.delete(p.id); }
    }
  }

  touch(room) {                                            // any activity keeps the lobby open
    if (room.timer) this.clearTimer(room.timer);
    room.timer = this.setTimer(() => this.expireRoom(room.code), this.roomTtlMs);
  }

  expireRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.status === "playing") return this.touch(room);   // never close a lobby in the middle of a game
    this.closeRoom(room, "room_expired");
  }

  roomView(room, viewerId) {
    const live = room.members.filter(mb => this.players.get(mb.id)?.conn);
    const readyCount = live.filter(mb => mb.ready).length;
    const host = room.members.find(mb => mb.id === room.hostId);
    const hostLive = !!(host && this.players.get(host.id)?.conn);
    const startCount = readyCount + (host && !host.ready && hostLive ? 1 : 0);   // pressing Start makes the host ready
    return {
      code: room.code,
      max: ROOM_MAX,
      mode: room.mode,
      hard: room.hard,
      status: room.status,                                 // "waiting" | "playing"
      isHost: room.hostId === viewerId,
      members: room.members.map(mb => {
        const pl = this.players.get(mb.id);
        return { name: pl ? pl.name : "?", wins: room.scores.get(mb.id) || 0, ready: mb.ready, connected: !!(pl && pl.conn), host: mb.id === room.hostId, you: mb.id === viewerId };
      }),
      readyCount,
      startCount,                                          // how many would play if the host pressed Start now
      canStart: room.status === "waiting" && startCount >= 2,
      games: room.games,
    };
  }

  // Everyone in the lobby gets either the current game (with the lobby info attached) or, if they have no game yet, the waiting room.
  pushRoom(room) {
    for (const mb of room.members) {
      const p = this.players.get(mb.id);
      if (!p || !p.conn) continue;
      const m = this.matchOf(p);
      const lobby = this.roomView(room, mb.id);
      if (m && m.indexOf(mb.id) >= 0) {
        const state = m.view(mb.id, this.now());
        state.players = state.players.map((pl, i) => ({ ...pl, wins: room.scores.get(m.players[i].id) || 0 }));
        state.lobby = lobby;
        this.send(p, { type: "state", state });
      } else {
        this.send(p, { type: "room", room: lobby });
      }
    }
  }

  // When a lobby game ends: add the win, reopen the waiting room, and make everyone say if they want another game.
  scoreRoomMatch(m) {
    m.scored = true;
    const room = this.rooms.get(m.roomCode);
    if (!room) return;
    if (m.winner !== null) { const id = m.players[m.winner].id; room.scores.set(id, (room.scores.get(id) || 0) + 1); }
    room.status = "waiting";
    room.members.forEach(mb => { mb.ready = false; });
    this.touch(room);
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
    if (m.roomCode && m.status === "over" && !m.scored) this.scoreRoomMatch(m);
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

  // Public match: both players vote. Private lobby: this is "Play again" (ready for the next game).
  rematch(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.roomCode) return this.readyUp(p);
    const m = this.matchOf(p);
    if (!m || m.status !== "over") return this.err(p, "not_over");
    const i = m.indexOf(id), j = 1 - i, o = this.players.get(m.players[j].id);
    if (!o || !o.conn || m.left[j] || o.matchId !== m.id) return this.err(p, "opponent_gone");
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

  cancel(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.roomCode) return this.leave(id);
    this.dequeue(id);
  }

  leave(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.dequeue(id, false);
    if (p.roomCode) this.leaveRoom(p, false);
    else if (p.matchId) this.leaveMatch(p);
    p.status = "idle";
    this.send(p, { type: "idle" });
  }

  // ---------- leaving a public match, forfeits, cleanup ----------
  leaveMatch(p) {
    const m = this.matchOf(p);
    p.matchId = null;
    if (!m) return;
    const wasPlaying = m.status === "playing";
    m.remove(p.id, this.now());
    if (wasPlaying) this.afterChange(m); else this.broadcast(m);
    this.cleanup(m);
  }

  forfeitAndDrop(id) {                                    // grace period ran out in a public match
    const p = this.players.get(id);
    if (!p) return;
    const m = this.matchOf(p);
    if (m) {
      m.remove(id, this.now());
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
