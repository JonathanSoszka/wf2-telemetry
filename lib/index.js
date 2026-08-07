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
// frame stores `su: 2` rather than "GRAVEL" (four tyres times tens of thousands of frames
// makes the difference material). So `shortEnum` and `enumName` are exported, and the
// tables behind them stay here.

const { decodeMain, encodeMain, packetTypeOf, enumName, shortEnum, MAIN_SIZE } = require('./packet');
const { frameOf, sessionHeaderOf, FORMAT_VERSION } = require('./frame');
const { normalizeMain, describe, bytesToString } = require('./apiframe');
const { createSupervisor, STOP_GRACE_MS } = require('./supervisor');
const { toJsonNet, buildPayloads } = require('../tools/mock-simhub');

module.exports = {
  // --- the recording format ---
  FORMAT_VERSION,
  frameOf,          // PacketMain -> one frame line
  sessionHeaderOf,  // PacketMain -> the header line

  // --- reading enums stored as numbers ---
  shortEnum,        // ('SurfaceType', 2) -> 'GRAVEL'
  enumName,         // the same, un-prefixed

  // --- the wire ---
  decodeMain,       // datagram -> PacketMain
  encodeMain,       // PacketMain -> datagram (for synthesising telemetry; see packet.js)
  packetTypeOf,
  MAIN_SIZE,

  // --- SimHub's API view of the same packet ---
  normalizeMain,    // /Api/GetGameData Raw.Main -> PacketMain
  describe,         // is this payload usable, and if not, why not
  bytesToString,

  // --- running a recording on someone else's behalf ---
  createSupervisor,
  STOP_GRACE_MS,

  // --- pretending to be SimHub ---
  //
  // Exported because anything driving a real recording in its own tests needs payloads that
  // are wrong in the ways SimHub's are: a C# `Byte[]` serialises as BASE64, so a track name
  // arrives as "U2F2b2xheCBTYW5kcGl0AAAA..." rather than text. A consumer that hand-rolled
  // its own stand-in would be testing a payload shape that never occurs, and would be
  // duplicating the one piece of knowledge most likely to change out from under it.
  toJsonNet,        // decoded-packet-shaped object -> its Json.NET representation
  buildPayloads,    // an iterable of PacketMain -> the envelopes /Api/GetGameData returns
};
