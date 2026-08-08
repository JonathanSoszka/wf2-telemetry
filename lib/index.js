'use strict';
// The public surface of this package.
//
// Deliberately narrow. Everything here is either something a consumer needs to READ a
// recording, something it needs to WRITE one for testing, or the supervisor. What is left
// out matters as much: `layout.json` is not exported, and neither is the machinery that
// walks it. A consumer that wanted a value out of the layout would be reaching past the
// format into the wire, and the two are allowed to diverge — that is the whole point of
// there being a format.
//
// The one thing an analysis program genuinely needs from the wire is enum NAMES, because a
// frame stores `su: 2` rather than "TARMAC" (four tyres times tens of thousands of frames
// makes the difference material). So `shortEnum` and `enumName` are exported, and the
// tables behind them stay here.

const {
  decodeMain, encodeMain, packetTypeOf, enumName, shortEnum, MAIN_SIZE,
  decodeParticipants, encodeParticipants, isEmptyParticipant, botMarkers, PARTICIPANT_SLOTS,
} = require('./packet');
const {
  frameOf, sessionHeaderOf, FORMAT_VERSION,
  carsOf, posOf, progOf, stateOf, occupiedCount, ST_FIELDS,
} = require('./frame');
const { createSupervisor, STOP_GRACE_MS } = require('./supervisor');

module.exports = {
  // --- the recording format ---
  FORMAT_VERSION,
  frameOf,          // PacketMain -> one frame line
  sessionHeaderOf,  // PacketMain -> the header line

  // --- the other cars, format 2 ---
  carsOf,           // INFO      -> the `cars` roster line
  posOf,            // MOTION    -> a `pos` line
  progOf,           // TIMING    -> a `prg` line
  stateOf,          // LB+TM+SEC -> an `st` line, or null when nothing changed
  occupiedCount,    // leaderboard -> how many slots hold a car
  ST_FIELDS,        // what the numbers in an `st` row mean, in order

  // --- reading enums stored as numbers ---
  shortEnum,        // ('SurfaceType', 2) -> 'TARMAC'
  enumName,         // the same, un-prefixed

  // --- the wire ---
  decodeMain,       // datagram -> PacketMain
  encodeMain,       // PacketMain -> datagram (for synthesising telemetry; see packet.js)
  decodeParticipants, // datagram -> { type, raceTime, visibility, items[] }
  encodeParticipants, // the inverse, so a test can drive a full grid over a real socket
  isEmptyParticipant, // an INFO row that is an empty slot, not a driver — it spells it "none"
  // Exported because a `cars` line carries the same playerName and carId the wire did, so a
  // reader labelling a grid faces exactly the question `--no-bots` does — and a second guess
  // at the convention, in another repository, is one that can drift from this one.
  botMarkers,       // { playerName, carId } -> { byName, byCar, bot, disagree }
  packetTypeOf,
  MAIN_SIZE,
  PARTICIPANT_SLOTS,

  // --- running a recording on someone else's behalf ---
  createSupervisor,
  STOP_GRACE_MS,
};

// GONE IN 2.0.0. `normalizeMain`, `describe`, `bytesToString`, `toJsonNet` and `buildPayloads`
// all described the HTTP API capture path, which no longer exists. Nothing replaces them: a
// consumer driving a recording in its own tests writes datagrams, and `encodeMain` above
// produces those in the game's own encoding rather than a reconstruction of SimHub's view of
// one — so the stand-in and the real thing cannot drift apart in the first place.
