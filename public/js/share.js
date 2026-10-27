// public/js/share.js — the text copied by the Share button, built from the final snapshot.

import { MODES } from "./modes.js";

export function buildShare(snap) {
  const me = snap.you, opp = 1 - me, won = snap.winner === me;
  const third = n => ["🟥", "🟨", "🟩"][n] || "🟥";
  const rows = snap.guesses.map(g => {
    const who = g.by === me ? "🟦" : "🟧";
    if (g.timedOut) return `${who} ⏱️`;
    const r = g.result;
    return `${who} ${r.sport ? "🟩" : "🟥"}${r.conf ? "🟩" : "🟥"}${third(r.third)}`;
  });
  const headline =
    snap.winner === null ? "🤝 Draw" :
    snap.reason === "forfeit" ? (won ? "🏆 Won by forfeit" : "🏳️ Forfeited") :
    won ? "🏆 I got it!" : `😤 ${snap.players[opp]} got it`;
  return [
    `PLAYOFF DUEL · ${MODES[snap.mode].label.toUpperCase()}${snap.hard ? " 🔥 HARD" : ""}`,
    `${snap.players[me]} 🟦 vs 🟧 ${snap.players[opp]}`,
    headline,
    "",
    ...rows,
    "",
    location.origin,
  ].join("\n");
}
