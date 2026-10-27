// server/config.js — tunables. Every value can be overridden with an environment variable,
// e.g.  TURN_MS=5000 npm run dev   (Windows PowerShell:  $env:TURN_MS=5000; npm run dev)

export const PORT = Number(process.env.PORT) || 3000;
export const TURN_MS = Number(process.env.TURN_MS) || 30_000;            // length of one turn
export const GRACE_MS = Number(process.env.GRACE_MS) || 20_000;          // how long a dropped player has to come back
export const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 15_000;  // ping interval; dead sockets get dropped
export const MAX_MSG_BYTES = 2048;                                       // bigger messages are rejected
export const MSGS_PER_SEC = 12;                                          // per-connection flood guard

