'use strict';
// A small, self-contained stream of PacketMain objects for testing the capture path.
//
// WHY IT DOES NOT LOOK LIKE A LAP
//
// A program that ANALYSES telemetry has to be tested against ground truth about driving — a
// track of known corner radii, driven with planted faults — because it can emit
// confident-looking conclusions from nonsense. This package draws no conclusions. It cares
// only that every field survives a round trip through the wire format, which is a question
// about field kinds, not about racing.
//
// So the fixture is built to sweep the things that break in transit: negative and positive
// floats, values small enough to expose float32 quantisation and large enough to expose it
// differently, every tyre carrying DISTINCT values so a corner-order or off-by-one error
// cannot hide behind symmetry, and text in the fixed-width `Byte[]` string fields.
//
// EVERY FIELD MUST RESPECT ITS WIRE TYPE. `engine.rpm` is `Int32`: give it a fractional
// value and the codec truncates it, so the round trip fails over a number the game cannot
// emit in the first place. That reads exactly like a codec bug. Check lib/layout.json
// before adding a signal here.

// Enough frames to sample across, few enough to build instantly. The recorder drops frames
// whose clock does not advance, so `raceTime` must strictly increase.
const COUNT = 240;
const TICK_MS = 16; // ~60 Hz, the game's own rate

const TRACK = { id: 'fixture-circuit', name: 'Fixture Circuit', length: 1873.5 };
const CAR = { id: 'fixture-car', name: 'Fixture Runabout', driver: 'Test Driver' };

// Models.PlayerStatusFlags — IN_RACE | PHYSICS_RUNNING. The recorder only writes frames
// while both are set, so a fixture without them records nothing and every test built on it
// fails for a reason that has nothing to do with what it was checking.
const PLAYER_LIVE = 1 | 4;

/**
 * One PacketMain at step `i`.
 *
 * The signals are cheap trigonometry rather than anything physical. That is deliberate: a
 * fixture that looked like real telemetry would invite assertions about its *values*, and
 * what the numbers mean is not this package's question.
 */
function packetAt(i) {
  const p = i / COUNT;             // 0..1 through the fixture
  const a = p * Math.PI * 2;
  const sin = Math.sin(a);
  const cos = Math.cos(a);

  const speed = 18 + 20 * (0.5 + 0.5 * cos);   // 18..38 m/s
  const lap = 1 + Math.floor(p * 3);           // three laps, so lap transitions are covered
  const prog = (p * 3) % 1;

  return {
    header: {
      raceTime: 1000 + i * TICK_MS,
      sessionTime: 1000 + i * TICK_MS,
      statusFlags: 32,
    },
    playerStatusFlags: PLAYER_LIVE,

    session: {
      trackId: TRACK.id,
      trackName: TRACK.name,
      trackLength: TRACK.length,
      laps: 3,
      gridSize: 24,
      sectorCount: 3,
      sectorFract1: 0.3333,
      sectorFract2: 0.6667,
      gameMode: 0,
      damageMode: 1,
      status: 3,
    },

    participantPlayerInfo: {
      carId: CAR.id,
      carName: CAR.name,
      playerName: CAR.driver,
      // Which participant slot the player occupies. Deliberately not 0 — a recording where
      // the player happened to be first would let a reader assume it and still pass. Kept
      // equal to PLAYER_SLOT below, because the header and the roster disagreeing is exactly
      // the fault this fixture exists to make visible.
      participantIndex: 2,
      // Non-zero on part of the run so the collision channel is not uniformly empty.
      lastCollisionTime: i > COUNT * 0.6 ? 1000 + Math.floor(COUNT * 0.6) * TICK_MS : 0,
    },

    participantPlayerTiming: {
      lapProgress: prog,
      lapTimeCurrent: Math.round(prog * 62000),
      lapTimeLast: lap > 1 ? 61500 : 0,
      lapTimeBest: lap > 1 ? 61500 : 0,
    },

    participantPlayerLeaderboard: {
      lapCurrent: lap,
      position: 3,
      health: 100 - Math.floor(p * 12),
      trackStatus: 0,
    },

    carPlayer: {
      driveline: { speed, gear: 1 + (i % 6), gearMax: 6, type: 1 },
      // rpm is Int32 on the wire, so it is rounded HERE rather than left to the codec. A
      // fractional value would come back truncated and fail the round trip over a number the
      // game cannot emit in the first place — a fixture defect that reads as a codec bug.
      engine: { rpm: Math.round(2000 + 4000 * (0.5 + 0.5 * sin)), rpmRedline: 6800, rpmMax: 7200 },
      input: {
        throttle: 0.5 + 0.5 * cos,
        brake: Math.max(0, -cos),
        clutch: i % 60 === 0 ? 1 : 0,
        handbrake: 0,
        steering: sin,          // spans the full -1..1, both signs
      },
      orientation: {
        // Deliberately off the origin and through zero on both axes: the recorder's
        // first-packet report treats a car at the origin as "no world position".
        positionX: -412.25 + 300 * sin,
        positionY: 3.5 + 0.75 * sin,
        positionZ: 88.125 + 300 * cos,
        rotationY: a,
      },
      velocity: {
        velocityLocalX: 2.5 * sin,
        velocityLocalY: 0.25 * cos,
        velocityLocalZ: speed,
        angularVelocityY: 0.244 * sin,
        accelerationLocalX: 4.5 * cos,
        accelerationLocalY: 0.5 * sin,
        accelerationLocalZ: 2.0 * sin,
      },
      chassis: {
        steeringLock: 0.55,
        wheelBase: 2.72,
        trackWidth: [1.5, 1.52],
        cornerWeights: [412, 408, 380, 376],
      },
      // FL, FR, RL, RR — every value distinct per corner, and the surfaces differ so the
      // enum path is exercised rather than assumed.
      tires: [0, 1, 2, 3].map((t) => ({
        slipAngle: (0.02 + 0.01 * t) * sin,
        slipRatio: (0.03 + 0.015 * t) * cos,
        forceLat: (1500 + 60 * t) * sin,
        forceLong: (900 + 40 * t) * cos,
        loadVertical: 3000 + 100 * t + 200 * sin,
        camber: -0.02 - 0.005 * t,
        suspensionDispNorm: 0.4 + 0.05 * t + 0.1 * sin,
        surfaceType: t < 2 ? 2 : 3,
      })),
    },
  };
}

/** The whole fixture, as a generator. */
function* packets() {
  for (let i = 0; i < COUNT; i++) yield packetAt(i);
}

// =========================================================================================
// the rest of the grid
//
// Same principle as the frames above: this is not a race, it is a sweep of the things that
// break when reading a 36-slot array. So the grid is deliberately awkward —
//
//   * FEWER CARS THAN SLOTS. Six occupied out of thirty-six, so anything that reads or
//     writes all 36 shows up as garbage in slots nobody is in.
//   * SLOT ORDER IS NOT RACE ORDER. If the leader sat in slot 0, code that confused race
//     position with slot index would still produce the right answer and pass.
//   * THE PLAYER IS NOT SLOT 0. It sits at index 2, so `playerIndex` must be read rather
//     than assumed.
//   * THE PRE-GRID SPELLING IS INCLUDED. Before GRID_FORMS_AT every INFO row is the
//     empty-slot sentinel — blank name, carId "none". Read as a driver, that writes a roster
//     of ghosts and then reports the entire grid changing hands the moment a race starts.
//   * ONE CAR TAKES DAMAGE PARTWAY, and lap times appear only after the first lap. Without
//     something that changes mid-session, a format that writes state every tick and one that
//     writes it on change produce identical files and the elision is asserted nowhere.
// =========================================================================================

const SLOTS = 36;
const GRID = 6;
const PLAYER_SLOT = 2;
const GRID_FORMS_AT = 40;              // before this, every INFO row reads "none"
const LAPPED_AT = 100;                 // when completed lap and sector times first appear
const HURT_AT = 120;                   // when slot 4 loses health
const RACE_ORDER = [4, 6, 1, 5, 2, 3]; // slot i runs Nth — deliberately not slot order

const gridCar = (i) => ({
  name: i === PLAYER_SLOT ? CAR.driver : '*BOT ' + (i * 7),
  carName: i === PLAYER_SLOT ? CAR.name : 'Fixture Banger',
  carId: i === PLAYER_SLOT ? CAR.id : 'fixture-car:ai_' + (1 + (i % 3)),
  position: RACE_ORDER[i],
  prog: 0.95 - RACE_ORDER[i] * 0.13,
});

/** The five participant arrays at step `i`, shaped for `encodeParticipants`. */
function participantsAt(i) {
  const formed = i >= GRID_FORMS_AT;
  const info = [], mot = [], lb = [], tm = [], sec = [];
  for (let s = 0; s < SLOTS; s++) {
    const c = s < GRID ? gridCar(s) : null;

    info[s] = c && formed
      ? { playerName: c.name, carName: c.carName, carId: c.carId, participantIndex: s }
      : { playerName: '', carName: '', carId: 'none', participantIndex: s };

    if (!c) { mot[s] = {}; lb[s] = { status: 1 }; tm[s] = {}; sec[s] = {}; continue; }

    const a = (c.prog + i * 0.0007) * Math.PI * 2;
    mot[s] = {
      orientation: {
        positionX: 187.3 * Math.cos(a), positionY: 4 + s * 0.01, positionZ: 187.3 * Math.sin(a),
        orientationQuaternionX: 0, orientationQuaternionY: Math.sin(a / 2),
        orientationQuaternionZ: 0, orientationQuaternionW: Math.cos(a / 2),
        extentsX: 180 + s, extentsY: 140 + s, extentsZ: 420 + s,
      },
      velocity: { velocityMagnitude: 30 + s },
    };
    lb[s] = {
      status: 2, trackStatus: 0, lapCurrent: 1 + Math.floor(i / 100), position: c.position,
      health: 100 - (i >= HURT_AT && s === 4 ? 35 : 0),
      wrecks: 0, frags: 0, assists: 0, score: 10 * s, points: 0, deltaLeader: 1000 * c.position,
    };
    tm[s] = {
      lapProgress: (c.prog + i * 0.0007) % 1,
      lapTimeCurrent: i * TICK_MS,
      lapTimeLast: i >= LAPPED_AT ? 61000 + s * 137 : 0,
      lapTimeBest: i >= LAPPED_AT ? 60500 + s * 91 : 0,
      lapBest: i >= LAPPED_AT ? 1 : 0,
      deltaAhead: -500 * s, deltaBehind: 500 * s,
    };
    sec[s] = {
      sectorTimeLastLap1: i >= LAPPED_AT ? 20000 + s * 31 : 0,
      sectorTimeLastLap2: i >= LAPPED_AT ? 21000 + s * 29 : 0,
      sectorTimeBest1: i >= LAPPED_AT ? 19900 + s * 23 : 0,
      sectorTimeBest2: 0, sectorTimeBest3: 0,
    };
  }
  return { info, mot, lb, tm, sec };
}

module.exports = {
  packets, TRACK, CAR, COUNT,
  participantsAt, SLOTS, GRID, PLAYER_SLOT, GRID_FORMS_AT, LAPPED_AT, HURT_AT, RACE_ORDER,
};
