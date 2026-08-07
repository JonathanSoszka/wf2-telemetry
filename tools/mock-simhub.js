'use strict';
// A stand-in for SimHub's /Api/GetGameData, so the API capture path can be tested without
// SimHub or the game.
//
// The point is not to serve *some* JSON — it is to serve the JSON Json.NET would actually
// produce from the reader's objects. In particular a C# `Byte[]` serialises as BASE64, not
// as a string and not as an array of numbers, so `session.trackName` arrives looking like
// "U2F2b2xheCBTYW5kcGl0AAAA...". Anything that does not reproduce that quirk would test a
// payload shape that never occurs in practice.
//
//   node tools/mock-simhub.js --port 8899 [--frames-per-request 0.5]

const http = require('http');
const LAYOUT = require('../lib/layout.json');

const STRING_FIELDS = { trackId: 64, trackName: 96, carId: 64, carName: 96, playerName: 24 };

/** C# Byte[] -> base64 of a fixed-width, null-padded ANSI buffer. */
function toBase64Field(value, size) {
  const buf = Buffer.alloc(size);
  buf.write(String(value === undefined || value === null ? '' : value), 0, 'ascii');
  return buf.toString('base64');
}

/** Recursively convert a decoded-packet-shaped object into its Json.NET representation. */
function toJsonNet(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(toJsonNet);
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRING_FIELDS[k] !== undefined && typeof v === 'string') out[k] = toBase64Field(v, STRING_FIELDS[k]);
    else out[k] = toJsonNet(v);
  }
  return out;
}

/**
 * Wrap decoded-packet-shaped objects in the envelope SimHub's API puts them in.
 *
 * The packets come in as an argument rather than being generated here. This file knows about
 * SimHub's serialisation and nothing else; where a plausible race comes from is the caller's
 * business. That separation is also what stops the synthetic-session generator and this mock
 * from requiring each other.
 */
function buildPayloads(frames) {
  const out = [];
  for (const m of frames) {
    out.push({
      NewData: {
        // A handful of the 257 mapped properties, to look like the real thing.
        SpeedKmh: (m.carPlayer.driveline.speed || 0) * 3.6,
        CurrentLap: m.participantPlayerLeaderboard.lapCurrent,
        TrackName: m.session.trackName,
        CarModel: m.participantPlayerInfo.carName,
        Raw: { Main: toJsonNet(m) },
      },
      IsGameInRace: true,
      GameRunning: true,
      GameName: 'Wreckfest2',
      RunningGameProcessDetected: true,
    });
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf('--port');
  const port = pi >= 0 ? Number(argv[pi + 1]) : 8899;
  const fi = argv.indexOf('--frames-per-request');
  // Below 1 means the client polls faster than the game ticks — the normal case, and the
  // one that exercises duplicate-frame rejection.
  const fpr = fi >= 0 ? Number(argv[fi + 1]) : 0.5;

  const payloads = buildPayloads(require('./fixture').packets());
  const idle = JSON.stringify({ NewData: null, GameRunning: false, GameName: 'Wreckfest2', RunningGameProcessDetected: true });
  const bodies = payloads.map((p) => JSON.stringify(p));

  let served = 0;
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/Api/GetGameData')) {
      res.writeHead(404).end('no');
      return;
    }
    const idx = Math.floor(served * fpr);
    served++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(idx < bodies.length ? bodies[idx] : idle);
  });

  server.listen(port, () => {
    console.log(`mock SimHub on http://localhost:${port}`);
    console.log(`  ${bodies.length} frames · ${fpr} frames per request · byte[] fields base64-encoded`);
    console.log(`  exhausts after ${Math.ceil(bodies.length / fpr)} requests, then reports no game`);
  });
}

if (require.main === module) main();

module.exports = { toJsonNet, toBase64Field, buildPayloads };
