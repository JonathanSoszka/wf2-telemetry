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

module.exports = { packets, TRACK };
