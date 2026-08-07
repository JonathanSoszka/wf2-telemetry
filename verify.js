'use strict';
// Verification for the capture path: the wire codec, the two telemetry sources, and the
// supervisor that runs a recording on someone else's behalf.
//
// Everything here is about getting bytes off the game and onto disk intact. Nothing here
// knows what a corner is — what a recording MEANS is a question for whatever reads it, and
// it has its own suite.
//
// The failures worth catching are the ones that produce a recording that LOOKS fine:
// a tyre array read one slot out, a track name left as base64, a stop that truncates the
// last line, a progress line that corrupts the event stream. Each of those analyses
// cleanly and means something wrong.
//
//   node verify.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const packet = require('./lib/packet');
const { frameOf, sessionHeaderOf, FORMAT_VERSION } = require('./lib/frame');
const { normalizeMain, describe } = require('./lib/apiframe');
const { toJsonNet, buildPayloads } = require('./tools/mock-simhub');
const { createSupervisor } = require('./lib/supervisor');
const fixture = require('./tools/fixture');

let passed = 0;
const failures = [];
const pending = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) {
      passed++;
      return;
    }
    failures.push(`${name}\n      ${r}`);
  } catch (e) {
    failures.push(`${name}\n      threw: ${e.message}`);
  }
}

/** Deferred until the mock SimHub is listening; run in order, never concurrently. */
const checkAsync = (name, fn) => pending.push([name, fn]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =========================================================================================
// packet codec
// =========================================================================================

check('packet: PacketMain is 1218 bytes', () =>
  packet.MAIN_SIZE === 1218 ? true : `got ${packet.MAIN_SIZE}`);

check('packet: nested struct sizes reconcile with the parent offsets', () => {
  const want = { CarTire: 72, CarFull: 532, Session: 208, ParticipantLeaderboard: 32, ParticipantTiming: 32 };
  for (const [t, n] of Object.entries(want)) {
    const got = packet.sizeOfType(t);
    if (got !== n) return `${t}: got ${got}, expected ${n}`;
  }
  return true;
});

check('packet: encode -> decode preserves every kind of field', () => {
  const src = {
    header: { raceTime: 918273, sessionTime: 5, statusFlags: 32 },
    participantPlayerTiming: { lapProgress: 0.4271, lapTimeCurrent: 42123, lapTimeLast: 51999 },
    participantPlayerLeaderboard: { lapCurrent: 7, health: 88, position: 3, trackStatus: 2 },
    participantPlayerInfo: { carName: 'Sunrise Super', carId: 'sunrise', lastCollisionTime: 1234 },
    session: { trackName: 'Savolax Sandpit', trackLength: 1873.5, gridSize: 24, status: 3, sectorCount: 3 },
    playerStatusFlags: 15,
    carPlayer: {
      driveline: { gear: 4, speed: 38.75, type: 1 },
      engine: { rpm: 5400, rpmRedline: 6800 },
      input: { throttle: 0.82, brake: 0.0, steering: -0.37 },
      orientation: { positionX: -412.25, positionY: 3.5, positionZ: 88.125 },
      velocity: { velocityLocalZ: 38.5, angularVelocityY: 0.244 },
      chassis: { steeringLock: 0.55, wheelBase: 2.72, trackWidth: [1.5, 1.52], cornerWeights: [1, 2, 3, 4] },
      tires: [0, 1, 2, 3].map((i) => ({ slipAngle: 0.05 * (i + 1), slipRatio: 0.01 * i, loadVertical: 3000 + i, forceLat: 1500 + i, surfaceType: 2 })),
    },
  };
  const out = packet.decodeMain(packet.encodeMain(src));
  if (!out) return 'decode returned null';
  const eq = (a, b, t = 1e-3) => Math.abs(a - b) <= t;
  if (out.header.raceTime !== 918273) return 'raceTime';
  if (!eq(out.participantPlayerTiming.lapProgress, 0.4271, 1e-6)) return `lapProgress ${out.participantPlayerTiming.lapProgress}`;
  if (out.participantPlayerLeaderboard.health !== 88) return 'health';
  if (out.session.trackName !== 'Savolax Sandpit') return `trackName "${out.session.trackName}"`;
  if (out.participantPlayerInfo.carName !== 'Sunrise Super') return 'carName';
  if (!eq(out.carPlayer.orientation.positionX, -412.25)) return 'positionX';
  if (!eq(out.carPlayer.input.steering, -0.37)) return 'steering';
  if (out.carPlayer.tires.length !== 4) return 'tire count';
  if (!eq(out.carPlayer.tires[3].slipAngle, 0.2)) return `tires[3].slipAngle ${out.carPlayer.tires[3].slipAngle}`;
  if (out.carPlayer.tires[2].surfaceType !== 2) return 'surfaceType';
  return true;
});

check('packet: rejects foreign, truncated and non-MAIN datagrams', () => {
  if (packet.decodeMain(Buffer.alloc(40)) !== null) return 'accepted a zeroed buffer';
  if (packet.decodeMain(Buffer.from('not telemetry at all, really')) !== null) return 'accepted junk';
  const good = packet.encodeMain({ header: { raceTime: 1 } });
  if (packet.decodeMain(good.slice(0, 200)) !== null) return 'accepted a truncated packet';
  const other = Buffer.from(good);
  other.writeUInt8(4, 4); // PACKET_TYPE_PARTICIPANTS_MOTION
  if (packet.decodeMain(other) !== null) return 'accepted a participants packet as MAIN';
  return true;
});

check('packet: tyre array is read 1-based (tires[0] is FL, not padding)', () => {
  // The 1-based/0-based trap costs a whole driving session when it goes wrong, so it is
  // asserted rather than assumed: writing to slot 0 must be readable at index 0.
  const b = packet.encodeMain({ carPlayer: { tires: [{ loadVertical: 4321 }, {}, {}, {}] } });
  const out = packet.decodeMain(b);
  return Math.abs(out.carPlayer.tires[0].loadVertical - 4321) < 1 ? true : 'FL load did not round-trip';
});

// =========================================================================================
// the two capture paths must agree
// =========================================================================================

check('capture: the API path and the UDP path produce the same frames', () => {
  // The recorder can read the game's UDP stream or SimHub's JSON view of the very same
  // packet. If those disagree, a recording means something different depending on how it
  // was captured, and no analysis is comparable across sessions. Both are pushed through
  // the one frame builder, so this pins that they converge.
  //
  // The UDP side is quantised to float32 by the wire format; the JSON side is not. So the
  // comparison is to a tolerance, not to the bit.
  let n = 0;
  for (const m of fixture.packets()) {
    if (n++ % 7 !== 0) continue; // sample across the whole fixture
    const viaUdp = frameOf(packet.decodeMain(packet.encodeMain(m)));
    const viaApi = frameOf(normalizeMain(toJsonNet(m)));

    const diff = compare(viaUdp, viaApi, '');
    if (diff) return `frame ${n}: ${diff}`;
  }
  return true;

  function compare(a2, b2, p) {
    if (typeof a2 === 'number' && typeof b2 === 'number') {
      const tol = Math.max(1e-3, Math.abs(a2) * 1e-4);
      return Math.abs(a2 - b2) <= tol ? null : `${p}: udp ${a2} vs api ${b2}`;
    }
    if (Array.isArray(a2)) {
      if (!Array.isArray(b2) || a2.length !== b2.length) return `${p}: array shape differs`;
      for (let i = 0; i < a2.length; i++) {
        const d = compare(a2[i], b2[i], `${p}[${i}]`);
        if (d) return d;
      }
      return null;
    }
    if (a2 && typeof a2 === 'object') {
      for (const k of Object.keys(a2)) {
        const d = compare(a2[k], (b2 || {})[k], `${p}.${k}`);
        if (d) return d;
      }
      return null;
    }
    return a2 === b2 ? null : `${p}: udp ${JSON.stringify(a2)} vs api ${JSON.stringify(b2)}`;
  }
});

check('capture: base64 byte[] fields survive the API path', () => {
  // Json.NET serialises a C# Byte[] as base64, so a track name arrives as
  // "U3ludGhldGlj..." rather than text. Left undecoded it silently names every recording
  // after a base64 blob and breaks session identity.
  const one = fixture.packets().next().value;
  const wire = toJsonNet(one);

  if (!/^[A-Za-z0-9+/]+=*$/.test(wire.session.trackName)) return 'the mock did not base64-encode trackName, so this proves nothing';
  const back = normalizeMain(wire);
  if (back.session.trackName !== one.session.trackName) {
    return `trackName came back as ${JSON.stringify(back.session.trackName)}`;
  }
  if (back.participantPlayerInfo.carName !== one.participantPlayerInfo.carName) {
    return `carName came back as ${JSON.stringify(back.participantPlayerInfo.carName)}`;
  }
  return true;
});

check('capture: a payload with no Raw is reported, not silently half-recorded', () => {
  if (describe({ NewData: null }).ok) return 'accepted a null NewData';
  if (describe({ NewData: { SpeedKmh: 100 } }).ok) return 'accepted a payload with no Raw';
  if (describe({ NewData: { Raw: { Main: { nonsense: 1 } } } }).ok) return 'accepted a Raw that is not a PacketMain';
  return true;
});

// =========================================================================================
// the recording format
// =========================================================================================

check('format: the session header states which format it is', () => {
  // Without this a reader on a different release cadence cannot tell a field it does not
  // recognise from a field that changed meaning under it.
  const h = sessionHeaderOf(fixture.packets().next().value, new Date('2026-08-07T12:00:00Z'));
  if (h.v !== FORMAT_VERSION) return `header says v=${h.v}, writer says ${FORMAT_VERSION}`;
  return typeof h.v === 'number' ? true : `v is ${typeof h.v}`;
});

// =========================================================================================
// the recorder, end to end
//
// A real record.js child against a real HTTP server serving the payloads SimHub would —
// base64 byte[] fields and all. Nothing here is stubbed, because the failures worth catching
// are exactly the ones a stub would paper over: a stop that truncates the file, a progress
// line that corrupts the event stream, a child left running.
// =========================================================================================

const recDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf2-capture-'));
const bodies = buildPayloads(fixture.packets()).map((p) => JSON.stringify(p));
const noGame = JSON.stringify({ NewData: null, GameRunning: false });

// The mock walks the fixture at half a frame per request, which is the normal case: the
// recorder polls faster than the game ticks, so duplicate-frame rejection is exercised
// rather than bypassed. It is rewound before each check that needs frames — the fixture is
// deliberately short, and a check that silently ran off the end of it would look like a
// recorder that stopped writing.
let served = 0;
const rewind = () => { served = 0; };
const simhub = http.createServer((req, res) => {
  const idx = Math.floor(served * 0.5);
  served++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(idx < bodies.length ? bodies[idx] : noGame);
});

/** Wait for the supervisor to reach a state, or give up. */
function until(rec, want, ms) {
  return new Promise((done) => {
    if (want(rec.status())) return done(true);
    const off = rec.subscribe((s) => {
      if (want(s)) {
        off();
        clearTimeout(timer);
        done(true);
      }
    });
    const timer = setTimeout(() => {
      off();
      done(false);
    }, ms);
  });
}

let recorded = null;

checkAsync('a recording starts, writes frames, and reports them as it goes', async () => {
  rewind();
  const rec = createSupervisor({ out: recDir, port: simhub.address().port });
  const seen = [];
  rec.subscribe((s) => seen.push(s.state));

  const started = rec.start({ source: 'api' });
  if (started.error) return started.error;

  const writing = await until(rec, (s) => s.state === 'recording' && s.frames > 0, 15000);
  if (!writing) return `never reported frames; states were ${seen.join(' -> ')}`;

  const mid = rec.status();
  if (!mid.file) return 'reported recording without naming the file';
  if (mid.trackName !== fixture.TRACK.name) return `track is ${mid.trackName}`;

  await rec.stop();
  if (rec.status().running) return 'still running after stop resolved';

  const files = fs.readdirSync(recDir).filter((f) => f.endsWith('.jsonl'));
  if (files.length !== 1) return `${files.length} recordings written, expected 1`;
  recorded = path.join(recDir, files[0]);
  return true;
});

checkAsync('a stopped recording is complete, not cut off mid-write', async () => {
  // The failure this catches is silent and total: `stream.end()` is asynchronous, so exiting
  // straight after it drops whatever was still buffered and leaves the last line half
  // written. The recording still opens, still analyses, and is simply missing its end.
  if (!recorded) return 'no recording was produced above';

  const text = fs.readFileSync(recorded, 'utf8');
  if (!text.endsWith('\n')) return 'the file does not end on a line boundary';

  const lines = text.split('\n').filter(Boolean);
  let parsed;
  try {
    parsed = lines.map((l) => JSON.parse(l));
  } catch (e) {
    return `one of ${lines.length} lines is not valid JSON — the recording was truncated`;
  }

  if (parsed[0]._ !== 'session') return 'the first line is not a session header';
  if (parsed.length < 2) return 'no frames were written';

  // Asserted here rather than left to the reader: the recorder drops frames whose clock has
  // not advanced, and SimHub republishing one game frame to many polls is the normal case,
  // so a regression would fill the file with the same instant over and over.
  for (let i = 2; i < parsed.length; i++) {
    if (!(parsed[i].t > parsed[i - 1].t)) {
      return `frame ${i} has t=${parsed[i].t} after t=${parsed[i - 1].t} — the clock did not advance`;
    }
  }
  return true;
});

checkAsync('a second recorder is refused rather than started alongside the first', async () => {
  // Two recorders both decide a session has begun and both open a file, so one race becomes
  // two recordings of it, each missing whatever the other's poll won.
  rewind();
  const rec = createSupervisor({ out: recDir, port: simhub.address().port });
  try {
    if (rec.start({ source: 'api' }).error) return 'the first recorder would not start';
    const second = rec.start({ source: 'api' });
    if (!second.error) return 'a second recorder started alongside the first';
    return second.code === 'already-recording' ? true : `code is ${second.code}`;
  } finally {
    await rec.stop();
  }
});

checkAsync('stopping when nothing is recording is refused, not ignored', async () => {
  const rec = createSupervisor({ out: recDir, port: simhub.address().port });
  const r = await rec.stop();
  return r.code === 'not-recording' ? true : `code is ${r.code}`;
});

checkAsync('supervised output is machine-readable, and interactive output is not', async () => {
  // The two modes are exclusive: the `\r`-redrawn progress line has no newline to end it, so
  // one of them appearing in supervised mode runs into the next event and makes it
  // unparseable — which the supervisor would silently drop rather than report.
  rewind();
  const rec = createSupervisor({ out: recDir, port: simhub.address().port });
  const lines = [];
  const raw = [];
  rec.subscribe((s) => lines.push(s));
  rec.start({ source: 'api' });
  await until(rec, (s) => s.state === 'recording' && s.frames > 0, 15000);
  await rec.stop();

  // Now the same recorder without --supervised, and only for long enough to print its banner.
  rewind();
  const proc = require('child_process').spawn(process.execPath,
    [path.join(__dirname, 'record.js'), '--out', recDir, '--port', String(simhub.address().port)],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdout.on('data', (c) => raw.push(String(c)));
  await sleep(2500);
  proc.kill();

  const prose = raw.join('');
  if (!/Wreckfest 2 session recorder/.test(prose)) return 'the interactive recorder stopped printing its banner';
  if (/"_":"rec"/.test(prose)) return 'the interactive recorder emitted event lines';
  return lines.some((s) => s.state === 'recording' && s.frames > 0)
    ? true
    : 'the supervised recorder reported no frames';
});

// =========================================================================================

const keep = process.argv.includes('--keep');

function finish() {
  if (!keep) fs.rmSync(recDir, { recursive: true, force: true });

  console.log('');
  if (failures.length) {
    console.log(`  ${passed} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.log(`  x  ${f}\n`);
    process.exit(1);
  }
  console.log(`  ${passed} checks passed — codec, both capture paths, format version, recorder lifecycle`);
}

simhub.listen(0, '127.0.0.1', async () => {
  for (const [name, fn] of pending) {
    try {
      const r = await fn();
      if (r === true || r === undefined) passed++;
      else failures.push(`${name}\n      ${r}`);
    } catch (e) {
      failures.push(`${name}\n      threw: ${e.message}`);
    }
  }
  simhub.close();
  finish();
});
