// server/match.js — one match between two players.
// This class knows the rules and holds the match state, but it has NO sockets and NO timers.
// The caller passes in "now" (milliseconds), so tests can drive it with a fake clock.
// The lobby (lobby.js) owns the actual setTimeout that calls timeout() when a turn expires.
//
// Flow: step counts completed turns. Turn 1 shows 3 seasons, turn 2 shows 6, ... turn 7 shows all 21.
// After the 7th turn without a correct guess the match is a draw. The player who starts gets turns
// 1, 3, 5, 7 (4 turns) but sees the fewest clues; the other player gets 3 turns with more clues.
// Rematches swap who starts.

import { randomUUID } from "node:crypto";
import { MAX_STEPS, START_YEAR, YEARS, makeOrder, pickTarget, revealedSeasons, compare, teamColors, key } from "./rules.js";
import { TURN_MS } from "./config.js";

export class Match {
  constructor({ id = randomUUID(), mode, hard = false, teams, players, firstTurn = 0, seed = randomUUID(), turnMs = TURN_MS, target = null }) {
    this.id = id;
    this.mode = mode;
    this.hard = !!hard;
    this.teams = teams;                       // every guessable team in this mode
    this.players = players;                   // [{ id, name }, { id, name }]
    this.firstTurn = firstTurn;               // index of the player who goes first
    this.turn = firstTurn;                    // index of the player on the clock
    this.turnMs = turnMs;
    this.order = makeOrder(seed, this.hard);  // reveal order of the 21 seasons
    this.target = target || pickTarget(teams, seed);   // the secret answer (never sent until the match is over)
    this.step = 0;                            // turns completed
    this.turnNo = 0;                          // bumps on every turn change; lets a stale timer recognise itself
    this.guesses = [];                        // shared board: both players see everything
    this.status = "waiting";                  // waiting -> playing -> over
    this.winner = null;                       // 0 | 1 | null
    this.reason = null;                       // "guess" | "draw" | "forfeit"
    this.deadline = 0;                        // epoch ms when the current turn ends
    this.connected = [true, true];            // maintained by the lobby
    this.left = [false, false];               // true once a player has walked away for good
    this.rematch = [false, false];            // rematch votes
  }

  indexOf(playerId) { return this.players.findIndex(p => p.id === playerId); }

  start(now) {
    this.status = "playing";
    this.deadline = now + this.turnMs;
  }

  findTeam(name) {
    const n = String(name).trim().toLowerCase();
    return this.teams.find(t => t.name.toLowerCase() === n);
  }

  // -> { ok: true, correct } or { ok: false, error, changed? }  (changed = the guess arrived after the clock
  // ran out, so the match advanced and the caller should broadcast)
  submitGuess(playerId, teamName, now) {
    if (this.status !== "playing") return { ok: false, error: "not_playing" };
    const idx = this.indexOf(playerId);
    if (idx < 0) return { ok: false, error: "not_in_match" };
    if (idx !== this.turn) return { ok: false, error: "not_your_turn" };
    if (now >= this.deadline) {                           // the server's clock decides, not the player's
      this.timeout(now, this.turnNo);
      return { ok: false, error: "too_late", changed: true };
    }
    const team = this.findTeam(teamName);
    if (!team) return { ok: false, error: "unknown_team" };                   // does not use up the turn
    if (this.guesses.some(g => g.team === team.name)) return { ok: false, error: "already_guessed" };

    this.guesses.push({
      by: idx,
      team: team.name,
      sport: team.sport,
      conference: team.conference,
      division: team.division ?? "",
      colors: this.mode === "ncaa" ? teamColors(team) : undefined,
      result: compare(team, this.target, this.mode),
    });

    if (team.name === this.target.name) {
      this.status = "over"; this.winner = idx; this.reason = "guess"; this.deadline = 0;
      return { ok: true, correct: true };
    }
    this.advance(now);
    return { ok: true, correct: false };
  }

  // Called by the lobby's timer. Ignored unless it is for the current turn and the deadline has really passed.
  timeout(now, turnNo) {
    if (this.status !== "playing" || turnNo !== this.turnNo || now < this.deadline) return false;
    this.guesses.push({ by: this.turn, team: null, timedOut: true });
    this.advance(now);
    return true;
  }

  advance(now) {
    this.step++;
    this.turnNo++;
    if (this.step >= MAX_STEPS) {                          // every season has been shown and nobody got it
      this.status = "over"; this.winner = null; this.reason = "draw"; this.deadline = 0;
      return;
    }
    this.turn = 1 - this.turn;
    this.deadline = now + this.turnMs;
  }

  forfeit(playerId) {
    if (this.status === "over") return;
    const i = this.indexOf(playerId);
    this.status = "over"; this.winner = 1 - i; this.reason = "forfeit"; this.deadline = 0;
  }

  // What the hint boxes show: a value once someone has matched it (or the match is over), otherwise null.
  hints() {
    const over = this.status === "over", t = this.target;
    const real = this.guesses.filter(g => g.result);
    const sport = over || real.some(g => g.result.sport);
    const conf = over || real.some(g => g.result.conf);
    let third;
    if (this.mode === "ncaa") {                            // one slot per target color, revealed individually
      const found = new Set();
      real.forEach(g => (g.colors || []).forEach(c => found.add(key(c))));
      third = teamColors(t).map(c => over || found.has(key(c)) ? c : null);
    } else {
      third = over || real.some(g => g.result.third === 2) ? (t.division || "None") : null;
    }
    return { sport: sport ? t.sport : null, conf: conf ? t.conference : null, third };
  }

  // The only thing a browser ever receives about this match. Never includes the target while playing.
  view(playerId, now) {
    const idx = this.indexOf(playerId), opp = 1 - idx, over = this.status === "over", t = this.target;
    return {
      matchId: this.id,
      mode: this.mode,
      hard: this.hard,
      you: idx,
      players: this.players.map(p => p.name),
      opponent: { name: this.players[opp].name, connected: this.connected[opp], left: this.left[opp] },
      status: this.status,
      turn: this.turn,
      yourTurn: this.status === "playing" && this.turn === idx,
      step: this.step,
      maxSteps: MAX_STEPS,
      turnMs: this.turnMs,
      deadline: this.status === "playing" ? this.deadline : null,
      serverNow: now,                                      // the browser compares this with its own clock
      startYear: START_YEAR,
      years: YEARS,
      revealed: revealedSeasons(t, this.order, over ? MAX_STEPS : this.step),   // [[seasonIndex, level], ...]
      guesses: this.guesses,
      hints: this.hints(),
      winner: this.winner,
      reason: this.reason,
      answer: over ? { name: t.name, sport: t.sport, conference: t.conference, division: t.division ?? "", colors: this.mode === "ncaa" ? teamColors(t) : undefined } : null,
      rematch: this.rematch,
    };
  }
}
