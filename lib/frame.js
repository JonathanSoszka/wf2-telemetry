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

const { shortEnum } = require('./packet');

const FORMAT_VERSION = 1;

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

function sessionHeaderOf(m, startedAt) {
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
    gridSize: s.gridSize,
    sectorCount: s.sectorCount,
    sectorFract1: r(s.sectorFract1, 5),
    sectorFract2: r(s.sectorFract2, 5),
    gameMode: shortEnum('GameMode', s.gameMode),
    damageMode: shortEnum('DamageMode', s.damageMode),
    carId: m.participantPlayerInfo.carId,
    carName: m.participantPlayerInfo.carName,
    playerName: m.participantPlayerInfo.playerName,
    driveline: shortEnum('DrivelineType', m.carPlayer.driveline.type),
    gearMax: m.carPlayer.driveline.gearMax,
    steeringLock: r(ch.steeringLock, 4),
    wheelBase: r(ch.wheelBase, 4),
    trackWidth: (ch.trackWidth || []).map((w) => r(w, 4)),
    rpmRedline: m.carPlayer.engine.rpmRedline,
    rpmMax: m.carPlayer.engine.rpmMax,
  };
}

module.exports = { frameOf, sessionHeaderOf, FORMAT_VERSION };
