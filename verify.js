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
const {
  frameOf, sessionHeaderOf, FORMAT_VERSION,
  carsOf, posOf, progOf, stateOf, occupiedCount, ST_FIELDS,
} = require('./lib/frame');
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

check('format: the version is 2, pinned', () => {
  // Deliberately a literal rather than a comparison against the writer, which is what the
  // check above already does and which passes no matter what the writer says. Format 2
  // interleaves line types a format 1 reader would parse as frames, so the number is a
  // promise to every reader in another repository — it should not be able to drift silently.
  return FORMAT_VERSION === 2 ? true : `FORMAT_VERSION is ${FORMAT_VERSION}`;
});

check('format: the header says which slot the player is', () => {
  const h = sessionHeaderOf(fixture.packets().next().value, new Date('2026-08-07T12:00:00Z'));
  return typeof h.playerIndex === 'number'
    ? true
    : `playerIndex is ${JSON.stringify(h.playerIndex)} — a reader cannot find itself on the grid`;
});

// =========================================================================================
// the participant packets
// =========================================================================================

check('participants: every type round-trips through the wire', () => {
  const p = fixture.participantsAt(fixture.GRID_FORMS_AT + 5);
  const cases = [[1, p.lb], [2, p.tm], [3, p.sec], [4, p.mot], [5, p.info]];
  for (const [type, items] of cases) {
    const buf = packet.encodeParticipants(type, items, { raceTime: 12345 }, 0);
    const got = packet.decodeParticipants(buf);
    if (!got) return `type ${type} did not decode`;
    if (got.type !== type) return `type ${type} decoded as ${got.type}`;
    if (got.raceTime !== 12345) return `type ${type} lost raceTime: ${got.raceTime}`;
    if (got.items.length !== packet.PARTICIPANT_SLOTS) return `type ${type} gave ${got.items.length} slots`;
  }
  return true;
});

check('participants: a decoder given MAIN says so rather than guessing', () =>
  packet.decodeParticipants(packet.encodeMain(fixture.packets().next().value)) === null
    ? true
    : 'decodeParticipants accepted a MAIN datagram');

check('participants: names and ids survive the fixed-width string fields', () => {
  const p = fixture.participantsAt(fixture.GRID_FORMS_AT + 5);
  const got = packet.decodeParticipants(packet.encodeParticipants(5, p.info, { raceTime: 1 }, 0));
  const me = got.items[fixture.PLAYER_SLOT];
  if (me.playerName !== fixture.CAR.driver) return `player name came back ${JSON.stringify(me.playerName)}`;
  if (me.participantIndex !== fixture.PLAYER_SLOT) return `player index came back ${me.participantIndex}`;
  return true;
});

check('participants: the empty-slot sentinel is "none", not ""', () => {
  // The bug this pins cost a whole race: read as a driver, the placeholder makes every slot
  // appear to change hands the instant the grid forms, and the player unfindable.
  const before = fixture.participantsAt(0).info;
  const after = fixture.participantsAt(fixture.GRID_FORMS_AT).info;
  if (!packet.isEmptyParticipant(before[0])) return 'a pre-grid slot was not recognised as empty';
  if (packet.isEmptyParticipant(after[0])) return 'a real driver was mistaken for an empty slot';
  return packet.isEmptyParticipant({ playerName: '', carId: '' }) ? true : 'an empty carId is empty too';
});

check('format: a roster of nothing but placeholders is no roster', () => {
  const p = fixture.participantsAt(0);
  return carsOf(0, p.info, p.mot) === null ? true : 'carsOf built a roster out of empty slots';
});

check('format: the roster names the grid and sizes to it', () => {
  const p = fixture.participantsAt(fixture.GRID_FORMS_AT + 1);
  const rec = carsOf(500, p.info, p.mot);
  if (!rec || rec._ !== 'cars') return 'no roster';
  const filled = rec.P.filter(Boolean);
  if (filled.length !== fixture.GRID) return `roster holds ${filled.length}, grid is ${fixture.GRID}`;
  if (rec.P[fixture.PLAYER_SLOT][0] !== fixture.CAR.driver) return 'the player is not in their own slot';
  if (rec.P[0][3] !== 180) return `extents did not come through: ${rec.P[0][3]}`;
  return true;
});

check('format: occupancy comes from the leaderboard, not the array length', () => {
  const p = fixture.participantsAt(fixture.GRID_FORMS_AT + 1);
  const n = occupiedCount(p.lb);
  return n === fixture.GRID ? true : `counted ${n} of ${fixture.SLOTS} as occupied, expected ${fixture.GRID}`;
});

check('format: a state line elides slots that did not change', () => {
  const prev = [];
  const at = (i) => {
    const p = fixture.participantsAt(i);
    return stateOf(i, p.lb, p.tm, p.sec, occupiedCount(p.lb), prev);
  };
  const first = at(fixture.HURT_AT - 5);
  if (!first || first.P.filter(Boolean).length !== fixture.GRID) return 'the first state line should carry every car';
  if (at(fixture.HURT_AT - 4) !== null) return 'an unchanged tick still wrote a state line';

  const hurt = at(fixture.HURT_AT);
  if (!hurt) return 'the health drop wrote no state line';
  const rows = hurt.P.filter(Boolean).length;
  if (rows !== 1) return `one car changed but ${rows} rows were written`;
  const health = hurt.P[4][ST_FIELDS.indexOf('health')];
  return health === 65 ? true : `the changed row says health ${health}`;
});

check('format: state rows are positional, and ST_FIELDS is the key to them', () => {
  const p = fixture.participantsAt(fixture.LAPPED_AT + 1);
  const rec = stateOf(1, p.lb, p.tm, p.sec, occupiedCount(p.lb), []);
  const row = rec.P[0];
  if (row.length !== ST_FIELDS.length) return `row is ${row.length} long, ST_FIELDS is ${ST_FIELDS.length}`;
  if (row[ST_FIELDS.indexOf('lapTimeLast')] !== 61000) return 'lapTimeLast is not where ST_FIELDS says';
  if (row[ST_FIELDS.indexOf('position')] !== fixture.RACE_ORDER[0]) return 'position is not where ST_FIELDS says';
  return true;
});

check('format: positions carry orientation, not just a point', () => {
  const p = fixture.participantsAt(fixture.GRID_FORMS_AT + 1);
  const rec = posOf(7, p.mot, fixture.GRID);
  if (rec._ !== 'pos' || rec.t !== 7) return 'wrong record';
  if (rec.P.length !== fixture.GRID) return `sized ${rec.P.length}, expected ${fixture.GRID}`;
  // 3 position + 4 quaternion + speed. Without the quaternion a replay draws dots, not cars.
  return rec.P.every((r) => r && r.length === 8) ? true : 'a row is not 8 wide';
});

// =========================================================================================
// telling a bot from a person
//
// What `--no-bots` rests on. The failure worth catching is not that a bot survives — that
// costs a few hundred KB — but that a PERSON is dropped, which deletes a car from a
// recording of a session that cannot be driven again and leaves a file in which nothing
// looks wrong. So the checks below are mostly about what must NOT be called a bot.
// =========================================================================================

check('bots: a driver is AI only when both markers say so', () => {
  const bot = packet.botMarkers({ playerName: '*BOT 19', carId: 'car02:ai_1' });
  if (!bot.bot) return 'a *BOT with an :ai_ carId was not recognised';
  const human = packet.botMarkers({ playerName: 'Varteix', carId: 'car04:default' });
  if (human.bot || human.disagree) return 'a person was flagged';

  // Either marker alone is a convention this package guessed at, and a patch can move one.
  // A slot the two disagree about is recorded, and the disagreement is reported.
  const byNameOnly = packet.botMarkers({ playerName: '*BOT 4', carId: 'car02:default' });
  if (byNameOnly.bot) return 'the name alone was enough to drop a car';
  if (!byNameOnly.disagree) return 'a one-sided marker was not reported as a disagreement';
  const byCarOnly = packet.botMarkers({ playerName: 'Varteix', carId: 'car02:ai_1' });
  if (byCarOnly.bot) return 'the carId alone was enough to drop a car';

  // An empty slot is not a bot. It is not anything, and calling it one would make the
  // pre-grid packets — every slot blank — look like a grid of AI.
  return packet.botMarkers({ playerName: '', carId: 'none' }).bot ? 'an empty slot read as AI' : true;
});

check('format: the header says whether the AI was recorded', () => {
  const m = fixture.packets().next().value;
  const at = new Date('2026-08-07T12:00:00Z');
  if (sessionHeaderOf(m, at).bots !== true) return 'the default header does not say the grid was recorded whole';
  if (sessionHeaderOf(m, at, {}).bots !== true) return 'an options object with nothing in it changed the answer';
  if (sessionHeaderOf(m, at, { bots: false }).bots !== false) return '--no-bots was not recorded in the header';
  // The grid that raced, not the grid that was recorded. Without this a filtered recording
  // is indistinguishable from a session driven alone.
  return sessionHeaderOf(m, at, { bots: false }).gridSize === 24 ? true : 'gridSize followed the filter';
});

check('format: a dropped slot is null everywhere and keeps its index', () => {
  const p = fixture.participantsAt(fixture.LAPPED_AT + 1);
  const n = occupiedCount(p.lb);
  const drop = new Set([0, 1, 3, 4, 5]); // everyone but the player, who is slot 2
  const kept = fixture.PLAYER_SLOT;

  const rows = [
    ['cars', carsOf(1, p.info, p.mot, drop).P],
    ['pos', posOf(1, p.mot, n, drop).P],
    ['prg', progOf(1, p.tm, n, drop).P],
    ['st', stateOf(1, p.lb, p.tm, p.sec, n, [], drop).P],
  ];
  for (const [name, P] of rows) {
    const filled = P.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
    if (filled.length !== 1 || filled[0] !== kept) return `${name} kept slots ${filled.join(', ')}`;
    // Sized to the grid, not compacted onto the survivors: index i must go on meaning the
    // same car, in this record type and in every other.
    if (name !== 'cars' && P.length !== n) return `${name} was resized to ${P.length}, not ${n}`;
  }
  return true;
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
  const fwd = createForwarder({ port, hz: (opts && opts.hz) || 250, repeat: 2, grid: !!(opts && opts.grid) });
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

// =========================================================================================
// the other cars, end to end
//
// A real record.js child on a real socket, fed MAIN and the four participant packets
// interleaved the way the game sends them. What this catches that the unit checks above
// cannot: the recorder opening a file off a participant packet and having no header to
// write, opponent lines landing in a file that a reader then takes for frames, and the
// arrays being sized from the 36-slot wire array instead of the grid.
// =========================================================================================

checkAsync('a recording carries the rest of the grid, not just the player', async () => {
  // Its own directory. The checks below count the files in recDir and assert there is
  // exactly one, which is a real thing to assert — so this must not leave a second there.
  const gridDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf2-grid-'));
  const port = await freePort();
  const rec = createSupervisor({ out: gridDir, udpPort: port });
  const fwd = createForwarder({ port, hz: 400, repeat: 2, grid: true });
  const started = rec.start();
  fwd.start();
  if (started.error) return started.error;

  // Far enough in that the grid has formed, a lap has completed and one car has been hurt —
  // before any of that the roster is all placeholders and nothing has changed to elide.
  const writing = await until(rec, (s) => s.state === 'recording' && s.frames > fixture.HURT_AT + 20, 25000);
  const reached = rec.status().frames;
  await rec.stop();
  fwd.stop();
  if (!writing) return `only reached ${reached} frames of the ${fixture.HURT_AT + 20} needed`;

  const files = fs.readdirSync(gridDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(gridDir, f));
  if (!files.length) return 'no recording was written';
  const recs = fs.readFileSync(files[0], 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const header = recs[0];
  const frames = recs.filter((r) => r._ === undefined);
  const by = (k) => recs.filter((r) => r._ === k);

  if (header._ !== 'session') return 'first line is not a session header';
  if (header.v !== 2) return `header says v=${header.v}`;
  if (header.playerIndex !== fixture.PLAYER_SLOT) return `header playerIndex is ${header.playerIndex}`;
  if (!frames.length) return 'the player frames stopped being written';
  if (frames.some((f) => f.T === undefined)) return 'a player frame lost its tyres';

  const roster = by('cars');
  if (!roster.length) return 'no roster was written';
  // Written on change, and the grid forms once — a roster per INFO packet means the
  // recorder is not comparing, and the file grows by 8 KB a second for nothing.
  if (roster.length > 2) return `${roster.length} rosters written for one grid`;
  const cars = roster[roster.length - 1].P;
  if (cars.filter(Boolean).length !== fixture.GRID) return `roster holds ${cars.filter(Boolean).length} cars`;
  if (cars[fixture.PLAYER_SLOT][0] !== fixture.CAR.driver) return 'the player is not in the slot the header names';
  if (cars.filter(Boolean).some((c) => /none/i.test(c[2]))) return 'the empty-slot placeholder was recorded as a driver';

  const pos = by('pos'), prg = by('prg'), st = by('st');
  if (!pos.length) return 'no positions were recorded';
  if (pos.some((r) => r.P.length !== fixture.GRID)) return 'a position line was sized to the wire array, not the grid';
  if (pos.some((r) => r.P.some((row) => !row || row.length !== 8))) return 'a position row is not 8 wide';
  if (!prg.length) return 'no lap progress was recorded';

  // The whole point of the on-change encoding. If `st` tracks `prg` the elision is broken
  // and the file is twice the size it needs to be.
  if (!st.length) return 'no state lines at all — the grid never changed?';
  if (st.length > prg.length / 5) return `${st.length} state lines against ${prg.length} progress lines — nothing is being elided`;
  const hurt = st.some((s) => (s.P[4] || [])[ST_FIELDS.indexOf('health')] === 65);
  if (!hurt) return 'the car that lost health never appeared in a state line';

  // Every record carries the raceTime off its own packet header — that is the only thing a
  // reader can join them on, because the streams are not 1:1.
  if (recs.slice(1).some((r) => typeof r.t !== 'number')) return 'a record has no raceTime';
  if (!keep) fs.rmSync(gridDir, { recursive: true, force: true });
  return true;
});

checkAsync('--no-bots keeps the people on the grid and drops the AI', async () => {
  // The fixture grid is one person in slot 2 and five bots, each carrying both markers. A
  // recorder that filtered on nothing would keep six; one that filtered on everything, or
  // that never opened its gate, would keep none. Neither passes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf2-nobots-'));
  const port = await freePort();
  const rec = createSupervisor({ out: dir, udpPort: port });
  const fwd = createForwarder({ port, hz: 400, repeat: 2, grid: true });
  const started = rec.start({ bots: false });
  fwd.start();
  if (started.error) return started.error;

  const writing = await until(rec, (s) => s.state === 'recording' && s.frames > fixture.HURT_AT + 20, 25000);
  const reached = rec.status().frames;
  await rec.stop();
  fwd.stop();
  if (!writing) return `only reached ${reached} frames of the ${fixture.HURT_AT + 20} needed`;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (files.length !== 1) return `${files.length} recordings written, expected 1`;
  const recs = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const header = recs[0];
  if (header.bots !== false) return `the header says bots=${JSON.stringify(header.bots)}`;
  // A filtered recording and a session driven alone look identical without this.
  if (header.gridSize !== 24) return `gridSize followed the filter: ${header.gridSize}`;
  if (!recs.some((r) => r._ === undefined)) return 'the player frames stopped being written';

  const others = recs.filter((r) => r._ !== undefined && r._ !== 'session');
  if (!others.length) return 'nothing about the other cars was recorded at all';
  // The gate. Only the roster carries names, so a line written before one arrived would be a
  // line nothing could have classified — a bot recorded by a recorder asked not to.
  if (others[0]._ !== 'cars') return `the first participant line is a ${others[0]._}, written before any roster`;

  const roster = others.filter((r) => r._ === 'cars');
  const cars = roster[roster.length - 1].P;
  const kept = cars.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  if (kept.length !== 1 || kept[0] !== fixture.PLAYER_SLOT) return `the roster kept slots [${kept.join(', ')}]`;
  if (cars[fixture.PLAYER_SLOT][0] !== fixture.CAR.driver) return 'the driver kept is not the person';

  // Every other line type has to agree with the roster. A `pos` for a car with no name in
  // the roster is a replay drawing a ghost.
  for (const r of others) {
    if (r._ === 'cars') continue;
    const filled = r.P.map((row, i) => (row ? i : -1)).filter((i) => i >= 0);
    if (filled.some((i) => i !== fixture.PLAYER_SLOT)) return `a ${r._} line carries slots [${filled.join(', ')}]`;
  }
  // And the person must actually be IN them — everything above also passes for a recorder
  // that dropped the whole grid.
  for (const type of ['pos', 'prg', 'st']) {
    if (!others.some((r) => r._ === type && r.P[fixture.PLAYER_SLOT])) return `no ${type} line carries the player`;
  }

  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  return true;
});

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
  console.log(`  ${passed} checks passed — codec, participants, capture, the recorder as a leaf, how a silence is diagnosed, format version, the grid end to end, recorder lifecycle`);
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
