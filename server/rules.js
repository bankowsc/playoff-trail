// server/rules.js — the game's rulebook.
// Pure functions only: no sockets, timers, files, DOM, Date.now or Math.random in here.
// Same inputs -> same outputs, which makes every function easy to unit test.

export const START_YEAR = 2026;                     // history[0] is this season, history[1] the one before, ...
export const YEARS = 21;                            // seasons of history per team
export const STEP = 3;                              // seasons revealed per turn
export const MAX_STEPS = Math.ceil(YEARS / STEP);   // 7 turns, then every season is revealed

// ---------- hashing + seeded randomness (unchanged from the single-file game) ----------
export function hash(s) {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// order[0] is the first season revealed, order[1] the next, and so on (0 = newest season).
export function makeOrder(seed, hard) {
  const o = Array.from({ length: YEARS }, (_, i) => i);
  if (!hard) return o;                               // normal: newest first
  const r = rng(hash(seed + ":order"));
  for (let i = YEARS - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [o[i], o[j]] = [o[j], o[i]];
  }
  return o;
}

export const pickTarget = (teams, seed) => teams[hash(seed) % teams.length];

// ---------- reveals ----------
export const visibleCount = step => Math.min(YEARS, STEP + STEP * step);   // step = turns completed so far

// What a browser is allowed to see: [[seasonIndex, level], ...]
export function revealedSeasons(target, order, step) {
  return order.slice(0, visibleCount(step)).map(i => [i, Number(target.history[i]) || 0]);
}

// ---------- matching ----------
export const key = c => c.replace(/\uFE0F/g, "").toLowerCase();     // ignore the invisible emoji variation selector

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function teamColors(t) {
  if (!t) return [];
  if (t.colors) return t.colors;                                     // preferred: an explicit array
  return [...graphemes.segment(t.division || "")].map(s => s.segment).filter(s => s.trim());  // old emoji-in-division data
}

// 0 = no shared color, 1 = one color, 2 = every one of the target's colors
export function colorScore(guess, target) {
  const tc = [...new Set(teamColors(target).map(key))];
  const gc = new Set(teamColors(guess).map(key));
  const hits = tc.filter(c => gc.has(c)).length;
  return !hits ? 0 : hits === tc.length ? 2 : 1;
}

// sport / conf are booleans. third is 0 (red), 1 (yellow) or 2 (green) in every mode:
//   NCAA   -> color score (works even when conferences differ)
//   others -> 2 only when sport + conference + division all match
export function compare(guess, target, mode) {
  const sport = guess.sport === target.sport;
  const conf = sport && guess.conference === target.conference;
  const third = mode === "ncaa" ? colorScore(guess, target)
    : conf && guess.division === target.division ? 2 : 0;
  return { sport, conf, third };
}

// Startup sanity check: returns a list of problems instead of crashing mid-match.
export function checkTeams(teams) {
  return teams.flatMap(t => {
    const p = [];
    if (!/^\d+$/.test(t.history || "") || t.history.length !== YEARS) p.push(`${t.name}: history must be ${YEARS} digits`);
    for (const f of ["name", "sport", "conference"]) if (!t[f]) p.push(`${t.name || "?"}: missing ${f}`);
    return p;
  });
}
