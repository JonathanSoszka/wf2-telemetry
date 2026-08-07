'use strict';
// Normalising SimHub's JSON view of the raw packet into the shape lib/frame.js expects.
//
// SimHub's /Api/GetGameData serialises the reader's own `NewData.Raw` object, and for
// Wreckfest 2 that is `WreckFest2Data`, whose `Main` property is the very same `PacketMain`
// struct the UDP decoder produces. So the two capture paths converge on one frame builder
// and cannot drift apart.
//
// Two things do differ, both artefacts of JSON rather than of the game:
//
//  - `Byte[]` fields (trackName, carName, ...) are fixed-width ANSI buffers in the struct,
//    and Json.NET serialises a byte array as BASE64. Left alone they arrive as
//    "U2F2b2xheCBTYW5kcGl0AAAA..." rather than a track name.
//  - Enums may serialise as either an integer or a name depending on the converters in
//    play, so both are accepted.

/** Fixed-width ANSI buffer -> string, from either base64 or a plain byte array. */
function bytesToString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    // Already a string? Only if it is not base64 of a byte buffer. Decode and keep the
    // result if it looks like text, otherwise assume it was a plain string all along.
    let buf;
    try {
      buf = Buffer.from(v, 'base64');
    } catch (e) {
      return v;
    }
    const s = decodeAnsi(buf);
    // Base64 of a name buffer decodes to printable text; a value that was genuinely a
    // string decodes to noise, so fall back to it.
    if (s && /^[\x20-\x7e]+$/.test(s)) return s;
    return /^[\x20-\x7e]*$/.test(v) ? v.replace(/\0.*$/, '').trim() : s;
  }
  if (Array.isArray(v)) return decodeAnsi(Buffer.from(v));
  return '';
}

function decodeAnsi(buf) {
  let s = '';
  for (const b of buf) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s.trim();
}

/** Enum as int, or as its name — accept either and hand back a number. */
function enumInt(v, names) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (names && names[v] !== undefined) return names[v];
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

const SURFACE = require('./layout.json').enums.SurfaceType.values;
const TRACK_STATUS = require('./layout.json').enums.ParticipantTrackStatus.values;
const PLAYER_STATUS = require('./layout.json').enums.PlayerStatusFlags.values;
const SESSION_STATUS = require('./layout.json').enums.SessionStatus.values;

/**
 * Take `NewData.Raw.Main` as JSON and return it in the same shape decodeMain() produces.
 * Returns null if the object is not recognisably a PacketMain.
 */
function normalizeMain(main) {
  if (!main || typeof main !== 'object') return null;
  if (!main.carPlayer || !main.header) return null;

  const c = main.carPlayer;
  const tires = Array.isArray(c.tires) ? c.tires : [];

  return {
    header: {
      raceTime: Number(main.header.raceTime) || 0,
      sessionTime: Number(main.header.sessionTime) || 0,
    },
    participantPlayerLeaderboard: {
      ...main.participantPlayerLeaderboard,
      trackStatus: enumInt((main.participantPlayerLeaderboard || {}).trackStatus, TRACK_STATUS),
      lapCurrent: Number((main.participantPlayerLeaderboard || {}).lapCurrent) || 0,
      health: Number((main.participantPlayerLeaderboard || {}).health) || 0,
      position: Number((main.participantPlayerLeaderboard || {}).position) || 0,
    },
    participantPlayerTiming: main.participantPlayerTiming || {},
    participantPlayerInfo: {
      ...main.participantPlayerInfo,
      carId: bytesToString((main.participantPlayerInfo || {}).carId),
      carName: bytesToString((main.participantPlayerInfo || {}).carName),
      playerName: bytesToString((main.participantPlayerInfo || {}).playerName),
      lastCollisionTime: Number((main.participantPlayerInfo || {}).lastCollisionTime) || 0,
    },
    session: {
      ...main.session,
      trackId: bytesToString((main.session || {}).trackId),
      trackName: bytesToString((main.session || {}).trackName),
      status: enumInt((main.session || {}).status, SESSION_STATUS),
    },
    playerStatusFlags: enumInt(main.playerStatusFlags, PLAYER_STATUS),
    carPlayer: {
      ...c,
      chassis: c.chassis || {},
      driveline: c.driveline || {},
      engine: c.engine || {},
      input: c.input || {},
      orientation: c.orientation || {},
      velocity: c.velocity || {},
      tires: tires.map((t) => ({ ...t, surfaceType: enumInt(t.surfaceType, SURFACE) })),
    },
  };
}

/**
 * What a live API frame actually contains. The recorder prints this once, because the
 * difference between "SimHub is not exposing the raw packet" and "the game is not sending"
 * is otherwise invisible and costs a whole driving session to discover.
 */
function describe(payload) {
  const nd = payload && payload.NewData;
  const raw = nd && (nd.Raw || nd.raw);
  const main = raw && (raw.Main || raw.main);
  const norm = normalizeMain(main);

  if (!nd) return { ok: false, why: 'SimHub reports no game data (NewData is null) — is a session actually running?' };
  if (!raw) return { ok: false, why: 'SimHub is not exposing the raw packet over the API (NewData.Raw absent).' };
  if (!norm) return { ok: false, why: 'NewData.Raw is present but does not look like a Wreckfest 2 PacketMain.' };

  const t = norm.carPlayer.tires;
  const o = norm.carPlayer.orientation;
  return {
    ok: true,
    main: norm,
    facts: {
      track: norm.session.trackName || '(blank)',
      car: norm.participantPlayerInfo.carName || '(blank)',
      position: `${Number(o.positionX).toFixed(1)}, ${Number(o.positionZ).toFixed(1)}`,
      hasPosition: Math.abs(Number(o.positionX) || 0) + Math.abs(Number(o.positionZ) || 0) > 0.01,
      tyres: t.length,
      hasTyreLoad: t.some((x) => Number(x.loadVertical) > 1),
      lapProgress: Number(norm.participantPlayerTiming.lapProgress) || 0,
    },
  };
}

module.exports = { normalizeMain, describe, bytesToString };
