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
 * Returns null for any other packet type or a datagram that fails validation — the
 * recorder relies on that to filter the participant packets sharing the same port.
 */
function decodeMain(buf) {
  if (packetTypeOf(buf) !== PACKET_MAIN) return null;
  if (buf.length < MAIN_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  return decodeType('PacketMain', dv, 0);
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
  sizeOfType,
  packetTypeOf,
  decodeMain,
  encodeMain,
  enumName,
  shortEnum,
};
