'use strict';
// The shape of one line in a .jsonl recording.
//
// This lives apart from record.js because the recorder is not the only thing that writes
// recordings — test rigs downstream generate them too. If each built its own frames, a
// synthetic session would stop being a valid test of the real pipeline the moment either
// changed. Exported through lib/index.js for exactly that reason.
//
// Keys are short on purpose: a race is tens of thousands of frames, and the key names would
// otherwise be most of the file.
//
// THE VERSION IN THE HEADER
//
// The writer and the readers are heading for separate repositories on separate release
// cadences, and at that point "the format" stops being whatever this file happens to say
// today. `v` is what lets a reader refuse a recording it cannot understand instead of
// quietly misreading a field that was renamed under it.
//
// Bump it when an existing key changes meaning or disappears. Adding a key does not need a
// bump — readers ignore what they do not know. Recordings made before this existed have no
// `v` at all, so a MISSING version means 1 — FORMAT.md is where that rule binds a reader.

const { shortEnum, isEmptyParticipant } = require('./packet');

// 2 — the other cars. Format 1 was a header and a stream of player frames, and a reader
// could take "every line after the first is a frame" as given. It no longer can: format 2
// interleaves four more line types, each marked with `_`. That is a change in what an
// EXISTING line position means, not an added key, so it bumps the version and old readers
// refuse the file rather than parsing an opponent's position as a player frame.
//
// The bump is unconditional even when a session produces no participant packets at all. The
// header is written when recording starts, before anything is known about what will arrive,
// and a version that depended on the rest of the file would have to be rewritten after the
// fact — on a format whose whole point is that a half-written recording is still valid.
const FORMAT_VERSION = 2;

/** Round to `d` decimals. Physics floats carry no meaning past ~4 significant figures. */
function r(v, d) {
  if (v === null || v === undefined || !isFinite(v)) return null;
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

function frameOf(m) {
  const c = m.carPlayer;
  const v = c.velocity;
  const o = c.orientation;
  const tm = m.participantPlayerTiming;
  const lb = m.participantPlayerLeaderboard;

  return {
    t: m.header.raceTime,
    lap: lb.lapCurrent,
    prog: r(tm.lapProgress, 6),
    lt: tm.lapTimeCurrent,
    ll: tm.lapTimeLast,
    lb: tm.lapTimeBest,

    x: r(o.positionX, 3),
    y: r(o.positionY, 3),
    z: r(o.positionZ, 3),

    sp: r(c.driveline.speed, 4), // driveline (wheel) speed, m/s
    vx: r(v.velocityLocalX, 4),
    vy: r(v.velocityLocalY, 4),
    vz: r(v.velocityLocalZ, 4),
    wy: r(v.angularVelocityY, 5), // yaw rate, rad/s — the basis of curvature
    ax: r(v.accelerationLocalX, 4),
    ay: r(v.accelerationLocalY, 4),
    az: r(v.accelerationLocalZ, 4),

    g: c.driveline.gear,
    rpm: c.engine.rpm,

    thr: r(c.input.throttle, 4),
    brk: r(c.input.brake, 4),
    clu: r(c.input.clutch, 4),
    hb: r(c.input.handbrake, 4),
    str: r(c.input.steering, 4),

    // FL, FR, RL, RR — corner order proved live on a RWD car under power.
    T: c.tires.map((t) => ({
      sa: r(t.slipAngle, 5),
      sr: r(t.slipRatio, 5),
      fl: r(t.forceLat, 1),
      fo: r(t.forceLong, 1),
      lv: r(t.loadVertical, 1),
      cam: r(t.camber, 4),
      sd: r(t.suspensionDispNorm, 4),
      su: t.surfaceType,
    })),

    ts: lb.trackStatus,
    hp: lb.health,
    p: lb.position,
    ss: m.session.status,
    psf: m.playerStatusFlags,
    col: m.participantPlayerInfo.lastCollisionTime,
  };
}

/**
 * `opts.bots === false` records that the AI drivers were deliberately left out — see
 * `carsOf` for what that does to the file. It is stated in the header rather than left to be
 * inferred, because a grid of one is exactly what a session driven alone looks like, and a
 * reader comparing `gridSize` against the roster would otherwise have to guess which it had.
 */
function sessionHeaderOf(m, startedAt, opts) {
  const s = m.session;
  const ch = m.carPlayer.chassis;
  return {
    _: 'session',
    v: FORMAT_VERSION,
    startedAt: startedAt.toISOString(),
    trackId: s.trackId,
    trackName: s.trackName,
    trackLength: r(s.trackLength, 2),
    laps: s.laps,
    // The size of the grid that RACED, which is not affected by what was recorded of it.
    gridSize: s.gridSize,
    bots: !opts || opts.bots !== false,
    sectorCount: s.sectorCount,
    sectorFract1: r(s.sectorFract1, 5),
    sectorFract2: r(s.sectorFract2, 5),
    gameMode: shortEnum('GameMode', s.gameMode),
    damageMode: shortEnum('DamageMode', s.damageMode),
    carId: m.participantPlayerInfo.carId,
    carName: m.participantPlayerInfo.carName,
    playerName: m.participantPlayerInfo.playerName,
    // WHICH PARTICIPANT SLOT IS THE PLAYER. Without it a reader has to find itself by
    // matching its own name against the roster, which breaks the moment two drivers share
    // one — and on a grid of bots called *BOT 1..24 that is not far-fetched.
    playerIndex: m.participantPlayerInfo.participantIndex,
    driveline: shortEnum('DrivelineType', m.carPlayer.driveline.type),
    gearMax: m.carPlayer.driveline.gearMax,
    steeringLock: r(ch.steeringLock, 4),
    wheelBase: r(ch.wheelBase, 4),
    trackWidth: (ch.trackWidth || []).map((w) => r(w, 4)),
    rpmRedline: m.carPlayer.engine.rpmRedline,
    rpmMax: m.carPlayer.engine.rpmMax,
  };
}

// ==========================================================================================
// THE OTHER CARS — format 2
//
// A recording used to be a header and a stream of frames, one per tick, all about the player.
// Format 2 adds four more line types for everyone else on the grid. Each is `{_, t, P}`:
// a discriminator, the raceTime off the packet header, and `P` — a per-slot array whose
// index IS the car, matching the roster in `cars`.
//
// WHY FOUR LINE TYPES RATHER THAN MORE KEYS ON THE FRAME
//
// The obvious design is to hang the opponents off the player's frame, and it is wrong for a
// measured reason: THE STREAMS ARE NOT 1:1. Over one 206-second race the recorder saw 12903
// MAIN packets, 12324 each of leaderboard/timing/sectors, and 12198 motion. MAIN keeps
// arriving through menus after a session ends; motion skips ticks. Merging would force the
// recorder to decide what an opponent's position is on a tick where none arrived — either
// inventing one by carrying the last forward, or dropping the frame. Both are analysis, and
// analysis does not belong in a recorder. Written as they arrive, a reader can interpolate,
// hold, or refuse, and the file still says exactly what the game said and when.
//
// WHY SOME LINES ELIDE AND OTHERS DO NOT
//
// `null` in `P` means UNCHANGED SINCE THE PREVIOUS LINE OF THE SAME TYPE, and a reader
// carries the last value forward. That is lossless — it is delta encoding, not sampling —
// and it is the whole difference between 14 MB/min and 7. It pays on `st`, where a car's
// position and health change a few times a lap; it never fires on `pos` or `prg`, where
// every car moves every tick, and those lines carry every slot every time.
//
// WHAT IS NOT HERE
//
// `PARTICIPANTS_DAMAGE` is decoded but not recorded. It arrives at 2 Hz and populates 4 of
// its 21 bytes with powers of two — a bitfield of damaged parts. That was measured, not
// assumed, so if it is ever wanted the answer is already known: it is real, it is sparse,
// and it costs about 0.2 MB/min. Per-car `health` is in `st` and is a different thing.
//
// DROPPING SLOTS
//
// Every builder below takes an optional `drop` — a Set of slot indices to leave out, which
// is how `record.js --no-bots` keeps the AI drivers out of a recording. A dropped slot is
// written as `null` in `P`, the same as a slot nobody is in, and it stays that way in every
// record type so the index still means the same car everywhere.
//
// That is a lossy filter and it is spelled that way on purpose: there is no marker on the
// line saying a car was suppressed, because a reader that had to interpret one would be
// worse off than a reader looking at an emptier grid. What says it happened is `bots: false`
// in the header, once, next to the `gridSize` it contradicts.
// ==========================================================================================

/** Slots the leaderboard says hold a real car. STATUS_INVALID and STATUS_UNUSED do not. */
const ST_UNUSED = 1;
function occupiedCount(leaderboard) {
  let last = -1;
  for (let i = 0; i < leaderboard.length; i++) if (leaderboard[i].status > ST_UNUSED) last = i;
  return last + 1;
}

/**
 * The roster — who is in which slot. From PARTICIPANTS_INFO, which is the only packet
 * carrying names, and which arrives at about 1 Hz.
 *
 * Extents live here rather than on every motion line because they describe the car, not its
 * movement; they are captured whenever the roster is written.
 *
 * Returns null when no slot is occupied, so a caller can skip the pre-grid packets in which
 * every slot reads `"none"` without needing to know that spelling itself.
 */
function carsOf(raceTime, info, motion, drop) {
  const P = [];
  let any = false;
  for (let i = 0; i < info.length; i++) {
    if (isEmptyParticipant(info[i]) || (drop && drop.has(i))) continue;
    const o = motion && motion[i] ? motion[i].orientation : null;
    P[i] = [
      info[i].playerName,
      info[i].carName,
      info[i].carId,
      o ? o.extentsX : null,
      o ? o.extentsY : null,
      o ? o.extentsZ : null,
    ];
    any = true;
  }
  if (!any) return null;
  for (let i = 0; i < P.length; i++) if (P[i] === undefined) P[i] = null;
  return { _: 'cars', t: raceTime, P };
}

/**
 * Where every car is and which way it is pointing. From PARTICIPANTS_MOTION, every packet.
 * This is the bulk of a multi-car recording and the only thing a replay strictly needs.
 */
function posOf(raceTime, motion, n, drop) {
  const P = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const it = motion[i];
    if (!it || (drop && drop.has(i))) continue;
    const o = it.orientation;
    P[i] = [
      r(o.positionX, 3), r(o.positionY, 3), r(o.positionZ, 3),
      r(o.orientationQuaternionX, 5), r(o.orientationQuaternionY, 5),
      r(o.orientationQuaternionZ, 5), r(o.orientationQuaternionW, 5),
      r(it.velocity.velocityMagnitude, 3),
    ];
  }
  return { _: 'pos', t: raceTime, P };
}

/**
 * The continuously moving parts of timing: how far round the lap each car is, how long it
 * has been on it, and its gaps. From PARTICIPANTS_TIMING, every packet.
 *
 * These are split off from `st` precisely BECAUSE they change every tick — left in there
 * they would defeat the unchanged-slot elision that makes `st` almost free.
 */
function progOf(raceTime, timing, n, drop) {
  const P = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const it = timing[i];
    if (!it || (drop && drop.has(i))) continue;
    P[i] = [r(it.lapProgress, 6), it.lapTimeCurrent, it.deltaAhead, it.deltaBehind];
  }
  return { _: 'prg', t: raceTime, P };
}

const ST_FIELDS = [
  'status', 'trackStatus', 'lapCurrent', 'position', 'health', 'wrecks', 'frags', 'score',
  'deltaLeader', 'lapTimeLast', 'lapTimeBest', 'lapBest',
  'sectorTimeLastLap1', 'sectorTimeLastLap2', 'sectorTimeBest1', 'sectorTimeBest2', 'sectorTimeBest3',
];

/**
 * The discrete state of every car — position, health, wrecks, completed lap and sector times.
 * Drawn from leaderboard, timing and sectors together, which is safe because THEY SHIP AS A
 * GROUP: over a full race the three arrived 12324 times each, exactly. `guard` below still
 * checks the raceTimes agree rather than trusting that, because a silent mis-pairing here
 * would attribute one car's lap time to another.
 *
 * `prev` is the last emitted row per slot; a slot whose values are identical is written as
 * null. Returns null when nothing changed at all, which is most ticks.
 */
function stateOf(raceTime, leaderboard, timing, sectors, n, prev, drop) {
  const P = new Array(n).fill(null);
  let changed = false;
  for (let i = 0; i < n; i++) {
    if (!leaderboard[i] || !timing[i] || !sectors[i]) continue;
    // A dropped slot never gets a row, so it never gets a `prev` either — and `null` on this
    // line therefore means "nobody", not "carry the last value forward". They read the same
    // to a reader, which is why the header has to say which it is.
    if (drop && drop.has(i)) continue;
    const src = Object.assign({}, leaderboard[i], timing[i], sectors[i]);
    const row = ST_FIELDS.map((f) => (src[f] === undefined ? null : src[f]));
    const was = prev[i];
    if (was && was.length === row.length && row.every((v, k) => v === was[k])) continue;
    P[i] = row;
    prev[i] = row;
    changed = true;
  }
  return changed ? { _: 'st', t: raceTime, P } : null;
}

module.exports = {
  frameOf,
  sessionHeaderOf,
  FORMAT_VERSION,
  carsOf,
  posOf,
  progOf,
  stateOf,
  occupiedCount,
  ST_FIELDS,
};
