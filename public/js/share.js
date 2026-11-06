// public/js/share.js — the text copied by the Share button, built from the final snapshot.

import { MODES } from "./modes.js";

const MARKS = ["🟦", "🟧", "🟩", "🟪", "🟥", "🟨", "🟫"];   // one square per player, in turn order

export function buildShare(snap) {
  const me = snap.you, n = snap.players.length;
  const third = x => ["🟥", "🟨", "🟩"][x] || "🟥";
  const rows = snap.guesses.map(g => {
    const who = MARKS[g.by] || "⬜";
    if (g.left) return `${who} 🚪`;
    if (g.timedOut) return `${who} ⏱️`;
    const r = g.result;
    return `${who} ${r.sport ? "🟩" : "🟥"}${r.conf ? "🟩" : "🟥"}${third(r.third)}`;
  });
  const winName = snap.winner === null ? "" : snap.players[snap.winner].name;
  const won = snap.winner === me;
  const headline =
    snap.winner === null ? "🤝 Draw" :
      snap.reason === "forfeit" ? (won ? "🏆 Last one standing" : `🏆 ${winName} was last one standing`) :
        won ? "🏆 I got it!" : `😤 ${winName} got it`;
  const lines = [
    `PLAYOFF DUEL · ${MODES[snap.mode].label.toUpperCase()}${snap.hard ? " 🔥 HARD" : ""}`,
    snap.players.map((p, i) => `${MARKS[i]} ${p.name}`).join(n === 2 ? " vs " : "  "),
    headline,
  ];
  if (snap.lobby) {                                        // lobby games also share the running score
    const board = [...snap.lobby.members].sort((a, b) => b.wins - a.wins).map(m => `${m.name} ${m.wins}`).join(" · ");
    lines.push(`🏆 Lobby score: ${board}`);
  }
  return [...lines, "", ...rows, "", location.origin].join("\n");
}
