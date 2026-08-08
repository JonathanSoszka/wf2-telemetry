'use strict';
// Decoder for Wreckfest 2's native UDP telemetry packets.
//
// No byte offset in here is guessed or hand-typed. `layout.json` is dumped straight out of
// SimHub's own `GSIReader.dll` by `tools/dump-layout.ps1`: every packet struct there is
// [StructLayout(LayoutKind.Sequential, Pack = 1)], so .NET's Marshal.OffsetOf reports the
// exact byte offset of every field, and this file just walks that description. If SimHub
// ships a reader for a new packet revision, regenerate layout.json rather than editing code.
//
// Pack = 1 means fields are NOT aligned — a Single can start at an odd offset. That is why
// everything goes through DataView at an explicit offset instead of a typed-array view.
// Wreckfest 2 is x86, so every read is little-endian.

const LAYOUT = require('./layout.json');

const SIGNATURE = 0x6f726b70; // Models.Const.PINO_SIGNATURE
const PACKET_MAIN = 0; // Models.PacketType.PACKET_TYPE_MAIN

// .NET primitive name -> [byte width, DataView reader]
const PRIM = {
  Single: [4, 'getFloat32'],
  Double: [8, 'getFloat64'],
  Int32: [4, 'getInt32'],
  UInt32: [4, 'getUint32'],
  Int16: [2, 'getInt16'],
  UInt16: [2, 'getUint16'],
  SByte: [1, 'getInt8'],
  Byte: [1, 'getUint8'],
};

// Byte[] fields that are really fixed-width ANSI strings. Everything else that is a Byte[]
// (damageStates, reserved) stays numeric.
const STRING_FIELDS = new Set(['trackId', 'trackName', 'carId', 'carName', 'name', 'playerName']);

// ---------------------------------------------------------------------------------------
// sizing
//
// Marshal.SizeOf() refused to report a size for these types during the dump, so sizes are
// derived from the offsets instead: a struct is as long as its furthest-reaching field.
// That reconstruction is self-checking — CarTire comes out at 72 bytes, and CarFull's
// `tires` array (4 x 72 = 288) lands its `reserved` field at exactly the offset the dump
// reports (230 + 288 = 518). PacketMain totals 1218.
// ---------------------------------------------------------------------------------------

const _sizeCache = new Map();

function sizeOfType(t) {
  if (PRIM[t]) return PRIM[t][0];
  const e = LAYOUT.enums[t];
  if (e) return PRIM[e.underlying][0];
  if (_sizeCache.has(t)) return _sizeCache.get(t);
  const s = LAYOUT.structs[t];
  if (!s) throw new Error('packet.js: unknown type "' + t + '" in layout.json');
  let end = 0;
  for (const f of s.fields) end = Math.max(end, f.offset + sizeOfField(f));
  _sizeCache.set(t, end);
  return end;
}

function sizeOfField(f) {
  const isArray = f.type.endsWith('[]');
  const elem = isArray ? f.type.slice(0, -2) : f.type;
  const n = isArray ? f.sizeConst || 0 : 1;
  return n * sizeOfType(elem);
}

// ---------------------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------------------

function readScalar(dv, off, t) {
  const p = PRIM[t] || PRIM[(LAYOUT.enums[t] || {}).underlying];
  if (!p) throw new Error('packet.js: not a scalar type "' + t + '"');
  return dv[p[1]](off, true);
}

function readAnsi(dv, off, n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const c = dv.getUint8(off + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function decodeType(typeName, dv, base) {
  const s = LAYOUT.structs[typeName];
  const out = {};
  for (const f of s.fields) {
    if (f.name === 'reserved') continue; // padding, never populated
    const off = base + f.offset;
    const isArray = f.type.endsWith('[]');
    const elem = isArray ? f.type.slice(0, -2) : f.type;

    if (isArray) {
      const n = f.sizeConst || 0;
      if (elem === 'Byte' && STRING_FIELDS.has(f.name)) {
        out[f.name] = readAnsi(dv, off, n);
        continue;
      }
      const w = sizeOfType(elem);
      const a = new Array(n);
      for (let i = 0; i < n; i++) {
        a[i] = LAYOUT.structs[elem]
          ? decodeType(elem, dv, off + i * w)
          : readScalar(dv, off + i * w, elem);
      }
      out[f.name] = a;
    } else if (LAYOUT.structs[elem]) {
      out[f.name] = decodeType(elem, dv, off);
    } else {
      out[f.name] = readScalar(dv, off, elem);
    }
  }
  return out;
}

const MAIN_SIZE = sizeOfType('PacketMain');

/** Packet type byte, or null if this datagram is not Wreckfest 2 telemetry at all. */
function packetTypeOf(buf) {
  if (buf.length < 5) return null;
  if (buf.readUInt32LE(0) !== SIGNATURE) return null;
  return buf.readUInt8(4);
}

/**
 * Decode a PACKET_TYPE_MAIN datagram into a nested object mirroring PacketMain.
 * Returns null for any other packet type or a datagram that fails validation, so a caller
 * can try this and decodeParticipants() in turn and let whichever matches answer.
 */
function decodeMain(buf) {
  if (packetTypeOf(buf) !== PACKET_MAIN) return null;
  if (buf.length < MAIN_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  return decodeType('PacketMain', dv, 0);
}

// ---------------------------------------------------------------------------------------
// the participant packets — everyone else on the grid
//
// The game emits seven packet types and SimHub forwards all of them to the same port. Until
// 3.0.0 this decoder read type 0 and the recorder dropped the other six, which is why a
// recording made on a grid of twenty-four contained one car.
//
// Each participant packet is a header, a visibility byte, and a FIXED 36-SLOT ARRAY — the
// same 36 slots in every type, whatever the grid size. Three things about those slots are
// worth knowing before reading one, and all three were measured on a full race rather than
// inferred from the layout:
//
//   * ONLY `ParticipantInfo` CARRIES IDENTITY. Motion, timing, leaderboard and sectors have
//     no name and no index in them at all; slot position is the only thing tying a row to a
//     car. That the slots DO correspond across packets was established by ranking the grid
//     two independent ways — by leaderboard position and by timing lap progress — and
//     finding the same ordering throughout a 24-car race. They cannot agree if a slot means
//     a different car in each packet.
//   * AN EMPTY SLOT IS SPELLED `"none"`, NOT `""`. Before the grid forms, INFO reports every
//     slot with an empty player name and a carId of the literal string "none". Read as a
//     driver, that makes the entire grid appear to change hands the instant a race starts.
//     `isEmptyParticipant` is the one place that knows it.
//   * THE STREAMS ARE NOT 1:1. Over one 206-second race: 12903 MAIN, 12324 of each of
//     leaderboard/timing/sectors, 12198 motion. MAIN keeps arriving outside the session and
//     motion skips ticks, so nothing may pair "the next of each" — the join is raceTime.
// ---------------------------------------------------------------------------------------

const PARTICIPANT_PACKETS = {
  1: ['PacketParticipantsLeaderboard', 'participantsLeaderboard'],
  2: ['PacketParticipantsTiming', 'participantsTiming'],
  3: ['PacketParticipantsTimingSectors', 'participantsTimingSectors'],
  4: ['PacketParticipantsMotion', 'participantsMotion'],
  5: ['PacketParticipantsInfo', 'participantsInfo'],
  6: ['PacketParticipantsDamage', 'participantsDamage'],
};

/** How many slots every participant array carries — read off the layout, not assumed. */
const PARTICIPANT_SLOTS = LAYOUT.structs.PacketParticipantsMotion.fields
  .find((f) => f.name === 'participantsMotion').sizeConst;

/** Is this INFO row an unoccupied slot rather than a driver? See the `"none"` note above. */
function isEmptyParticipant(info) {
  return !info || (!info.playerName && (!info.carId || /^none$/i.test(info.carId)));
}

/**
 * Is the driver in this INFO row the game's own AI rather than a person?
 *
 * TWO MARKERS, AND THIS REPORTS A BOT ONLY WHEN BOTH AGREE. Observed on a 24-car offline
 * grid: bots carry a player name of `*BOT 19` and a carId of `car02:ai_1`, while the human
 * was `Varteix` / `car04:default`. Either looks decisive on its own, and both are guesses
 * about a naming convention that nothing documents and a patch can change.
 *
 * The polarity is the design, and it is the same one lib/simhub-config.js takes: act only on
 * what can be POSITIVELY established, because the two mistakes do not cost the same. Keeping
 * a bot that should have been dropped costs a few hundred KB of a file. Dropping a driver
 * who was a person deletes a car from a recording of a session that will not happen again,
 * and leaves a file in which nothing looks wrong. So a slot the two markers disagree about
 * is not a bot.
 *
 * Returns the workings as well as the verdict, so a caller can say that the markers have
 * started disagreeing instead of silently recording more than it was asked to.
 */
function botMarkers(info) {
  const name = (info && info.playerName) || '';
  const car = (info && info.carId) || '';
  const byName = /^\*/.test(name) || /^bot\b/i.test(name);
  const byCar = /:ai[_\d]/i.test(car);
  return { byName, byCar, bot: byName && byCar, disagree: byName !== byCar };
}

/**
 * Decode any PACKET_TYPE_PARTICIPANTS_* datagram into
 *
 *   { type, raceTime, visibility, items[PARTICIPANT_SLOTS] }
 *
 * Null for MAIN, an unknown type, or a datagram too short to hold what the layout describes.
 */
function decodeParticipants(buf) {
  const type = packetTypeOf(buf);
  const spec = PARTICIPANT_PACKETS[type];
  if (!spec) return null;
  if (buf.length < sizeOfType(spec[0])) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const p = decodeType(spec[0], dv, 0);
  return { type, raceTime: p.header.raceTime, visibility: p.participantVisibility, items: p[spec[1]] };
}

// ---------------------------------------------------------------------------------------
// encoding
//
// The inverse of the decoder. Nothing in the capture path needs it — the game does the
// encoding in production. It exists so telemetry can be SYNTHESISED: emitted over a real
// UDP socket, or pushed through both capture paths and compared. That is what lets
// record.js be tested end to end — socket, session segmentation and file writing included —
// without starting the game, and it is why the encoder is part of the public surface.
// ---------------------------------------------------------------------------------------

function writeScalar(dv, off, t, val) {
  const p = PRIM[t] || PRIM[(LAYOUT.enums[t] || {}).underlying];
  if (!p) throw new Error('packet.js: not a scalar type "' + t + '"');
  const setter = 'set' + p[1].slice(3);
  const v = typeof val === 'number' && isFinite(val) ? val : 0;
  dv[setter](off, p[1] === 'getFloat32' || p[1] === 'getFloat64' ? v : Math.trunc(v), true);
}

function writeAnsi(dv, off, n, s) {
  const str = String(s === undefined || s === null ? '' : s);
  for (let i = 0; i < n; i++) dv.setUint8(off + i, i < str.length ? str.charCodeAt(i) & 0x7f : 0);
}

function encodeType(typeName, dv, base, obj) {
  const s = LAYOUT.structs[typeName];
  const src = obj || {};
  for (const f of s.fields) {
    if (f.name === 'reserved') continue;
    const off = base + f.offset;
    const isArray = f.type.endsWith('[]');
    const elem = isArray ? f.type.slice(0, -2) : f.type;
    const val = src[f.name];

    if (isArray) {
      const n = f.sizeConst || 0;
      if (elem === 'Byte' && STRING_FIELDS.has(f.name)) {
        writeAnsi(dv, off, n, val);
        continue;
      }
      const w = sizeOfType(elem);
      for (let i = 0; i < n; i++) {
        const item = Array.isArray(val) ? val[i] : undefined;
        if (LAYOUT.structs[elem]) encodeType(elem, dv, off + i * w, item);
        else writeScalar(dv, off + i * w, elem, item);
      }
    } else if (LAYOUT.structs[elem]) {
      encodeType(elem, dv, off, val);
    } else {
      writeScalar(dv, off, elem, val);
    }
  }
}

/** Build a wire-format PACKET_TYPE_MAIN datagram from a decodeMain()-shaped object. */
function encodeMain(obj) {
  const buf = Buffer.alloc(MAIN_SIZE);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  encodeType('PacketMain', dv, 0, obj);
  dv.setUint32(0, SIGNATURE, true); // never trust the caller for these two
  dv.setUint8(4, PACKET_MAIN);
  return buf;
}

/**
 * Build a wire-format participant datagram. `items` is a sparse array indexed by slot;
 * anything missing encodes as zeroes, which is what an unoccupied slot looks like.
 *
 * Same reason encodeMain exists: it lets a test drive the recorder over a real socket with
 * a real grid, in the game's own encoding rather than a reconstruction of it, so the stand-in
 * and the real thing cannot drift apart.
 */
function encodeParticipants(type, items, header, visibility) {
  const spec = PARTICIPANT_PACKETS[type];
  if (!spec) throw new Error('packet.js: not a participant packet type: ' + type);
  const buf = Buffer.alloc(sizeOfType(spec[0]));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const obj = { header: header || {}, participantVisibility: visibility || 0 };
  obj[spec[1]] = items || [];
  encodeType(spec[0], dv, 0, obj);
  dv.setUint32(0, SIGNATURE, true);
  dv.setUint8(4, type);
  return buf;
}

// Reverse maps so logs and reports can carry readable names (SURFACE_TYPE_GRAVEL) rather
// than bare enum ordinals.
const _enumNames = {};
for (const [name, def] of Object.entries(LAYOUT.enums)) {
  const rev = {};
  for (const [k, v] of Object.entries(def.values)) rev[v] = k;
  _enumNames[name] = rev;
}

function enumName(typeName, value) {
  const m = _enumNames[typeName];
  if (!m) return String(value);
  return m[value] !== undefined ? m[value] : String(value);
}

/** Strip the SURFACE_TYPE_ / STATUS_ style prefix for display. */
function shortEnum(typeName, value) {
  const n = enumName(typeName, value);
  const i = n.indexOf('_');
  return n.startsWith('SURFACE_TYPE_') ? n.slice(13) : i >= 0 && /^[A-Z_]+$/.test(n) ? n.slice(i + 1) : n;
}

// LAYOUT stays internal, and so do the recursive walkers over it. A caller reaching for a
// value out of the layout would be reaching past the format into the wire, and the two are
// allowed to diverge — see the note at the top of index.js.
module.exports = {
  MAIN_SIZE,
  PARTICIPANT_SLOTS,
  sizeOfType,
  packetTypeOf,
  decodeMain,
  encodeMain,
  decodeParticipants,
  encodeParticipants,
  isEmptyParticipant,
  botMarkers,
  enumName,
  shortEnum,
};
