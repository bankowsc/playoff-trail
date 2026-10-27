// server/protocol.js — the messages between browser and server, plus input validation.
//
// Browser -> server (every message is JSON with a "type"):
//   hello        { playerId, name? }        first message on every connection
//   queue        { mode, hard?, name? }     join the matchmaking queue (mode: pro | ncaa | ucl)
//   createRoom   { mode, hard?, name? }     open a private room and get an invite code (wait for a friend)
//   joinRoom     { code, name? }            join a friend's room by code
//   cancel                                  leave the queue, or close your private room
//   guess        { team }                   your guess, only accepted on your turn
//   rematch                                 vote to play the same opponent again (after a match ends)
//   newOpponent                             leave the finished match and re-queue with the same settings
//   leave                                   forfeit / leave everything and go idle
//   ping                                    optional keep-alive; answered with pong
//
// Server -> browser:
//   welcome      { playerId, serverNow, resumed }
//   queued       { mode, hard }
//   room         { code, mode, hard }       your private room is open; share the code or link
//   idle                                    you are not queued and not in a match
//   state        { state }                  a full snapshot of your match (see Match.view in match.js)
//   error        { code }                   e.g. not_your_turn, unknown_team, already_guessed, too_late, bad_mode
//   pong         { serverNow }

export const MODE_NAMES = ["pro", "ncaa", "ucl"];

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function parse(text) {
  try {
    const m = JSON.parse(text);
    return m && typeof m === "object" && typeof m.type === "string" ? m : null;
  } catch { return null; }
}

export function cleanName(s) {
  const n = String(s ?? "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 16);
  return n || "Player";
}

// Returns an error code, or null when the message is well-formed.
export function check(m) {
  switch (m.type) {
    case "hello": return ID_RE.test(String(m.playerId)) ? null : "bad_id";
    case "queue": return MODE_NAMES.includes(m.mode) ? null : "bad_mode";
    case "createRoom": return MODE_NAMES.includes(m.mode) ? null : "bad_mode";
    case "joinRoom": return typeof m.code === "string" && /^[A-Za-z0-9]{4,8}$/.test(m.code) ? null : "bad_code";
    case "guess": return typeof m.team === "string" && m.team.length > 0 && m.team.length <= 80 ? null : "bad_team";
    case "cancel": case "rematch": case "newOpponent": case "leave": case "ping": return null;
    default: return "unknown_type";
  }
}
