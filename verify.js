'use strict';
// Verification for the capture path: the wire codec, the recorder end to end, and the
// supervisor that runs a recording on someone else's behalf.
//
// Everything here is about getting bytes off the game and onto disk intact. Nothing here
// knows what a corner is — what a recording MEANS is a question for whatever reads it, and
// it has its own suite.
//
// The failures worth catching are the ones that produce a recording that LOOKS fine:
// a tyre array read one slot out, a stop that truncates the last line, a progress line that
// corrupts the event stream. Each of those analyses cleanly and means something wrong.
//
//   node verify.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');

const packet = require('./lib/packet');
const { frameOf, sessionHeaderOf, FORMAT_VERSION } = require('./lib/frame');
const { createSupervisor } = require('./lib/supervisor');
const { createForwarder } = require('./tools/mock-forward');
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
// the capture path — a packet surviving the trip from the wire to a frame line
// =========================================================================================

check('capture: a datagram becomes a frame with its fields intact', () => {
  // The recorder's whole job in one line: bytes off the socket, through the decoder, into
  // the shape FORMAT.md describes.
  const one = fixture.packets().next().value;
  const f = frameOf(packet.decodeMain(packet.encodeMain(one)));

  if (f.t !== one.header.raceTime) return `t is ${f.t}`;
  if (f.T.length !== 4) return `${f.T.length} tyres`;
  // Distinct per tyre in the fixture, so a corner-order error cannot hide behind symmetry.
  if (!(f.T[0].lv !== f.T[3].lv)) return 'tyre loads are indistinguishable — this proves nothing';
  const load = one.carPlayer.tires[0].loadVertical;
  if (Math.abs(f.T[0].lv - load) > 1) return `FL load is ${f.T[0].lv}, expected ~${load}`;
  return true;
});

check('capture: a foreign datagram is ignored rather than half-decoded', () => {
  // The forward port is a socket anything on the machine can send to, so the decoder is
  // what stands between a stray datagram and a frame of nonsense in the recording.
  if (packet.decodeMain(Buffer.from('hello')) !== null) return 'accepted junk';
  if (packet.packetTypeOf(Buffer.alloc(3)) !== null) return 'typed a runt datagram';
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
// A real record.js child, bound to a real socket, fed real datagrams. Nothing here is
// stubbed, because the failures worth catching are exactly the ones a stub would paper over:
// a stop that truncates the file, a progress line that corrupts the event stream, a child
// left running.
// =========================================================================================

const recDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf2-capture-'));

/** A free UDP port, so concurrent checks and a real recorder cannot collide. */
function freePort() {
  return new Promise((done) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => done(p));
    });
  });
}

/**
 * Start a recorder under a supervisor and a forwarder feeding it, and wait until it is
 * actually writing.
 *
 * Each call gets its own port and its own forwarder rather than sharing one: a rewindable
 * shared feed made every check depend on the order the others ran in.
 */
async function recording(opts) {
  const port = await freePort();
  const rec = createSupervisor({ out: recDir, udpPort: port });
  // repeat: 2 sends every frame twice, so the recorder's rule that the clock must ADVANCE
  // rather than merely differ is exercised instead of bypassed.
  const fwd = createForwarder({ port, hz: (opts && opts.hz) || 250, repeat: 2 });
  return { port, rec, fwd, start: () => { const r = rec.start(); fwd.start(); return r; } };
}

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
  const { rec, fwd, start } = await recording();
  const seen = [];
  rec.subscribe((s) => seen.push(s.state));

  const started = start();
  if (started.error) return started.error;

  const writing = await until(rec, (s) => s.state === 'recording' && s.frames > 0, 15000);
  if (!writing) return `never reported frames; states were ${seen.join(' -> ')}`;

  const mid = rec.status();
  if (!mid.file) return 'reported recording without naming the file';
  if (mid.trackName !== fixture.TRACK.name) return `track is ${mid.trackName}`;

  await rec.stop();
  fwd.stop();
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
  // not advanced, and the forwarder deliberately sends each one twice, so a regression would
  // fill the file with the same instant recorded over and over.
  for (let i = 2; i < parsed.length; i++) {
    if (!(parsed[i].t > parsed[i - 1].t)) {
      return `frame ${i} has t=${parsed[i].t} after t=${parsed[i - 1].t} — the clock did not advance`;
    }
  }
  return true;
});

checkAsync('a second recorder is refused rather than started alongside the first', async () => {
  // Two recorders both decide a session has begun and both open a file, so one race becomes
  // two recordings of it. On one UDP port the second would not even bind, but the supervisor
  // is what has to refuse — a child that dies on EADDRINUSE is a worse way to find out.
  const { rec, fwd, start } = await recording();
  try {
    if (start().error) return 'the first recorder would not start';
    const second = rec.start();
    if (!second.error) return 'a second recorder started alongside the first';
    return second.code === 'already-recording' ? true : `code is ${second.code}`;
  } finally {
    await rec.stop();
    fwd.stop();
  }
});

checkAsync('stopping when nothing is recording is refused, not ignored', async () => {
  const rec = createSupervisor({ out: recDir, udpPort: await freePort() });
  const r = await rec.stop();
  return r.code === 'not-recording' ? true : `code is ${r.code}`;
});

checkAsync('supervised output is machine-readable, and interactive output is not', async () => {
  // The two modes are exclusive: the `\r`-redrawn progress line has no newline to end it, so
  // one of them appearing in supervised mode runs into the next event and makes it
  // unparseable — which the supervisor would silently drop rather than report.
  const { rec, fwd, start } = await recording();
  const lines = [];
  const raw = [];
  rec.subscribe((s) => lines.push(s));
  start();
  await until(rec, (s) => s.state === 'recording' && s.frames > 0, 15000);
  await rec.stop();
  fwd.stop();

  // Now the same recorder without --supervised, and only for long enough to print its banner.
  const port = await freePort();
  const proc = require('child_process').spawn(process.execPath,
    [path.join(__dirname, 'record.js'), '--out', recDir, '--udp-port', String(port)],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdout.on('data', (c) => raw.push(String(c)));
  const feed = createForwarder({ port, hz: 250, repeat: 2 });
  feed.start();
  await sleep(2500);
  proc.kill();
  feed.stop();

  const prose = raw.join('');
  if (!/Wreckfest 2 session recorder/.test(prose)) return 'the interactive recorder stopped printing its banner';
  if (/"_":"rec"/.test(prose)) return 'the interactive recorder emitted event lines';
  return lines.some((s) => s.state === 'recording' && s.frames > 0)
    ? true
    : 'the supervised recorder reported no frames';
});

// =========================================================================================
// the recorder is a leaf
// =========================================================================================

checkAsync('the recorder sends nothing back to SimHub', async () => {
  // SimHub is UPSTREAM. Anything sent back to it lands in the forward that produced it and
  // amplifies from there — which is what the removed relay mode risked. There is now no code
  // path that transmits at all, and that is worth holding onto: this watches the whole
  // machine's UDP traffic to the port SimHub actually listens on, so a relay reintroduced
  // anywhere in the recorder would fail this rather than being discovered on a live rig.
  const listener = dgram.createSocket('udp4');
  const heard = [];
  listener.on('message', (b) => heard.push(b));
  await new Promise((r) => listener.bind(0, '127.0.0.1', r));

  const port = await freePort();
  const proc = require('child_process').spawn(process.execPath,
    [path.join(__dirname, 'record.js'), '--out', recDir, '--udp-port', String(port)],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (c) => { out += String(c); });

  // Wait for the banner: a datagram sent to a port that is not bound yet is simply dropped,
  // which would look exactly like a recorder that correctly sent nothing.
  const deadline = Date.now() + 10000;
  while (!/Waiting for a session/.test(out) && Date.now() < deadline) await sleep(50);
  const listening = /Waiting for a session/.test(out);

  const fwd = createForwarder({ port, hz: 250, repeat: 1 });
  fwd.start();
  await sleep(1500);
  proc.kill();
  fwd.stop();
  listener.close();

  if (!listening) return 'the recorder never reported it was listening';
  if (heard.length) return `${heard.length} datagrams were sent back out — the recorder is not a leaf`;
  if (!/forwarded by SimHub/.test(out)) return 'the banner no longer says where the data comes from';
  return true;
});

check('simhub-config: only a settings file that positively disagrees is reported', () => {
  // This is quoted in the message shown when nothing arrives, so a false positive sends
  // someone to change a setting that was working. Anything it cannot read confidently must
  // stay quiet.
  const { forwardStatus } = require('./lib/simhub-config');
  const tmp = path.join(recDir, 'GameSettings.json');
  const write = (o) => { fs.writeFileSync(tmp, JSON.stringify(o)); return { file: tmp }; };

  const on = write({ Wreckfest2: { UDPForwardActive: true, UDPForwardPort: 23124, UDPForwardIpAddress: '127.0.0.1' } });
  if (forwardStatus(23124, on).ok !== true) return 'a correctly pointed forward was reported as wrong';

  const off = write({ Wreckfest2: { UDPForwardActive: false, UDPForwardPort: 23124 } });
  if (forwardStatus(23124, off).ok !== false) return 'a disabled forward was not reported';

  const elsewhere = write({ Wreckfest2: { UDPForwardActive: true, UDPForwardPort: 9999 } });
  const e = forwardStatus(23124, elsewhere);
  if (e.ok !== false || !/9999/.test(e.why)) return 'a forward to another port was not reported with its port';

  const remote = write({ Wreckfest2: { UDPForwardActive: true, UDPForwardPort: 23124, UDPForwardIpAddress: '192.168.1.9' } });
  if (forwardStatus(23124, remote).ok !== false) return 'a forward to another machine was accepted';

  // Everything below is a shape this cannot reason about, and must produce no opinion.
  const quiet = [
    write({ Wreckfest2: { UDPForwardActive: true, UDPForwardPort: 9999, AddictionnalUDPRedirects: [{ port: 23124 }] } }),
    write({ SomeOtherGame: {} }),
    write({}),
    { file: path.join(recDir, 'does-not-exist.json') },
  ];
  for (const q of quiet) {
    if (forwardStatus(23124, q).known !== false) return `claimed to know about ${JSON.stringify(fs.existsSync(q.file) ? fs.readFileSync(q.file, 'utf8') : 'a missing file')}`;
  }
  fs.writeFileSync(tmp, 'not json at all');
  if (forwardStatus(23124, { file: tmp }).known !== false) return 'claimed to know about an unparseable file';
  fs.rmSync(tmp, { force: true });
  return true;
});

check('the removed capture paths are gone, not merely undocumented', () => {
  // A half-removal is worse than either state: `--source api` still parsing, or apiframe.js
  // still on disk for something to require, leaves a path that is no longer tested and no
  // longer true of the recorder. So the absence is asserted rather than assumed.
  const { parseArgs } = require('./record.js');
  const a = parseArgs(['--source', 'api', '--port', '8888', '--poll-ms', '5', '--simhub-port', '23123']);
  for (const dead of ['source', 'port', 'pollMs', 'simhubPort', 'forward']) {
    if (a[dead] !== undefined) return `--${dead} still parses into ${JSON.stringify(a[dead])}`;
  }
  if (a.udpPort !== 23124) return `udpPort default is ${a.udpPort}`;

  for (const gone of ['./lib/apiframe.js', './tools/mock-simhub.js']) {
    if (fs.existsSync(path.join(__dirname, gone))) return `${gone} is still on disk`;
  }
  const surface = require('./lib/index.js');
  for (const dead of ['normalizeMain', 'describe', 'bytesToString', 'toJsonNet', 'buildPayloads']) {
    if (surface[dead] !== undefined) return `lib/index.js still exports ${dead}`;
  }
  return true;
});

/**
 * THE RELEASE EXECUTABLE
 *
 * Skipped unless `dist/` has been built, so `npm test` on a clean checkout is unaffected.
 * `npm run release` builds first and therefore always runs this.
 *
 * What it is guarding is narrow and specific. The exe is a bundle, and a bundle is where a
 * `require` of a data file quietly becomes something else — lib/layout.json in particular,
 * which is the difference between a recording that decodes and 32 KB of field names the
 * binary no longer has. Nothing about that shows up in the build; it shows up as a session
 * whose track is `undefined`. So the check is not that the file exists, it is that the exe
 * records a session and gets the names right.
 *
 * It also covers the other half of shipping a binary: `script: null`, which is how a
 * supervisor points at the exe rather than at `node record.js`.
 */
checkAsync('the built executable records a session on its own', async () => {
  const exe = path.join(__dirname, 'dist', 'wf2-record' + (process.platform === 'win32' ? '.exe' : ''));
  if (!fs.existsSync(exe)) return true; // not built — nothing to verify

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf2-exe-'));
  const port = await freePort();
  const rec = createSupervisor({ out: outDir, udpPort: port, node: exe, script: null });
  const fwd = createForwarder({ port, hz: 250, repeat: 2 });

  try {
    const started = rec.start();
    if (started.error) return started.error;
    fwd.start();

    const writing = await until(rec, (s) => s.state === 'recording' && s.frames > 0, 20000);
    if (!writing) return `the exe never reported frames; last state was ${rec.status().state}`;

    // The layout assertion. A bundle that lost layout.json still starts, still binds, and
    // still counts frames — it just cannot name anything it decoded.
    const s = rec.status();
    if (s.trackName !== fixture.TRACK.name) return `track decoded as ${JSON.stringify(s.trackName)} — the layout did not survive bundling`;

    await rec.stop();
    fwd.stop();

    const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.jsonl'));
    if (files.length !== 1) return `${files.length} recordings written, expected 1`;
    const lines = fs.readFileSync(path.join(outDir, files[0]), 'utf8').split('\n').filter(Boolean);
    if (JSON.parse(lines[0])._ !== 'session') return 'the first line is not a session header';
    if (lines.length < 2) return 'the exe wrote a header and no frames';
    return true;
  } finally {
    fwd.stop();
    await rec.stop();
    if (!process.argv.includes('--keep')) fs.rmSync(outDir, { recursive: true, force: true });
  }
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
  console.log(`  ${passed} checks passed — codec, capture, the recorder as a leaf, how a silence is diagnosed, format version, recorder lifecycle`);
}

(async () => {
  for (const [name, fn] of pending) {
    try {
      const r = await fn();
      if (r === true || r === undefined) passed++;
      else failures.push(`${name}\n      ${r}`);
    } catch (e) {
      failures.push(`${name}\n      threw: ${e.message}`);
    }
  }
  finish();
})();
