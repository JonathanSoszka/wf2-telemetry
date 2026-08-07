#!/usr/bin/env node
'use strict';
// Session recorder — captures Wreckfest 2 telemetry to a JSONL log for offline analysis.
//
// ONE SOURCE: SIMHUB'S UDP FORWARD
//
// The recorder binds udp/23124 and decodes what SimHub forwards to it. That is the whole
// capture path, and this process is a LEAF — nothing downstream of it, nothing depending on
// it. Two other topologies were tried and removed for putting something there; the reasoning
// is in the README and in commit a462892.
//
// One fact about the forward is worth having to hand: it costs no fidelity. SimHub passes on
// the datagram it received, unaltered, at the game's own rate — measured over a real 41.6 s
// session, 62.5 Hz with a 16 ms gap on 2598 of 2599 frames. It sits below whatever the reader
// chooses to publish, so it also survives a SimHub that stops exposing `Raw`.
//
// The one thing it needs is for SimHub to be told where to forward, once, in
// Settings -> Games -> Wreckfest 2. When nothing arrives, the recorder says so and names
// that as the likely reason — see lib/simhub-config.js for why it waits before doing so.
//
//   node record.js                       # listen on udp/23124
//   node record.js --udp-port 23125      # somewhere else
//   node record.js --out D:\somewhere
//   node record.js --supervised          # driven by another program, not a terminal
//
// SUPERVISED MODE
//
// `--supervised` is how lib/supervisor.js runs this, and therefore how any GUI with a record
// button does. Two things change, and both exist because the assumptions a terminal makes
// are wrong when a program is on the other end:
//
//   * Progress goes out as one JSON object per line instead of a `\r`-redrawn status line.
//     A carriage-returned line is unreadable to a parser, and a supervisor that scraped it
//     would break the first time the wording changed.
//   * `stop` on stdin shuts the recording down cleanly. Ctrl-C cannot be sent to a child on
//     Windows — Node's `child.kill('SIGINT')` maps to TerminateProcess, so the signal
//     handler below never runs and the recording is cut off mid-write. An explicit command
//     works the same way on every platform.

const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { decodeMain, packetTypeOf } = require('./lib/packet');
const { frameOf, sessionHeaderOf } = require('./lib/frame');
const { forwardStatus } = require('./lib/simhub-config');

const DEFAULTS = {
  udpPort: 23124,
};

/**
 * WHERE RECORDINGS GO BY DEFAULT
 *
 * `sessions/` under the CURRENT DIRECTORY, not under this file. That distinction did not
 * matter while the recorder lived inside the program that read its output; it does now.
 * Installed as a dependency, `__dirname/../sessions` resolves somewhere inside
 * `node_modules` — a plausible-looking directory that nothing will ever read from, and a
 * session recorded into it is simply lost.
 *
 * Callers that supervise this process pass `--out` explicitly and are unaffected either way.
 */
function parseArgs(argv) {
  const a = { ...DEFAULTS, out: path.join(process.cwd(), 'sessions'), supervised: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out') a.out = argv[++i];
    else if (v === '--udp-port') a.udpPort = Number(argv[++i]);
    else if (v === '--supervised') a.supervised = true;
  }
  return a;
}

// Where the running commentary goes. In a terminal it is prose; under a supervisor it is one
// JSON object per line, so nothing has to be scraped. Errors keep going to stderr either
// way — a supervisor wants those verbatim, and they must not land in the event stream.
let supervised = false;
const log = (text) => { if (!supervised) console.log(text); };
const event = (o) => { if (supervised) process.stdout.write(JSON.stringify(Object.assign({ _: 'rec' }, o)) + '\n'); };

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

// Models.PlayerStatusFlags
const PLAYER_IN_RACE = 1;
const PLAYER_PHYSICS_RUNNING = 4;

/**
 * Everything that is the same regardless of where the packet came from: deciding when a
 * session starts and stops, and writing the file.
 */
function createWriter(args) {
  fs.mkdirSync(args.out, { recursive: true });

  let stream = null, file = null, key = null;
  let frames = 0, lastRaceTime = null, lastLogAt = 0;
  let described = false;
  let idleSince = Date.now();
  let warnedIdle = false;

  /**
   * Finish the current file.
   *
   * `done` fires only once the stream has actually flushed. `stream.end()` is asynchronous,
   * so exiting the process straight after it discards whatever was still buffered — which
   * at the game's 62.5 Hz is real frames, and leaves the last line of the recording
   * half-written. That was survivable when stopping meant Ctrl-C at the end of a session;
   * it is not, now that stopping is a button someone presses routinely.
   */
  function close(done) {
    const finish = done || (() => {});
    if (!stream) return finish();

    const closing = stream;
    const name = path.basename(file);
    const n = frames;
    stream = null; file = null; frames = 0; lastRaceTime = null;

    closing.end(() => {
      log(`\n  closed ${name} — ${n} frames`);
      event({ state: 'closed', file: name, frames: n });
      finish();
    });
  }

  function open(m) {
    const now = new Date();
    const safe = (m.session.trackName || 'unknown').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    file = path.join(args.out, `${stamp(now)}_${safe}.jsonl`);
    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.write(JSON.stringify(sessionHeaderOf(m, now)) + '\n');
    log(
      `\n  recording -> ${path.basename(file)}\n` +
      `    ${m.session.trackName} · ${m.participantPlayerInfo.carName} · ${m.session.laps} laps`
    );
    event({
      state: 'recording',
      file: path.basename(file),
      trackName: m.session.trackName,
      carName: m.participantPlayerInfo.carName,
      laps: m.session.laps,
      frames: 0,
    });
  }

  /**
   * Report what the first packet actually contained. The failure this prevents is the
   * expensive one: driving a whole session and only then finding out that position or tyre
   * data never arrived.
   */
  function describeOnce(m) {
    // Deliberately not the first frame: a car sitting on the start line can legitimately be
    // at the origin, and reporting "no world position" there would be a false alarm.
    if (described || frames < 30) return;
    described = true;
    const o = m.carPlayer.orientation || {};
    const t = m.carPlayer.tires || [];
    const hasPos = Math.abs(Number(o.positionX) || 0) + Math.abs(Number(o.positionZ) || 0) > 0.01;
    const hasLoad = t.some((x) => Number(x.loadVertical) > 1);
    log(`\n  first packet:`);
    log(`    world position  ${hasPos ? 'yes' : 'NO — the track map and corner detection need this'}`);
    log(`    tyre loads      ${hasLoad ? 'yes' : 'NO — grip analysis will be unavailable'}`);
    log(`    tyres reported  ${t.length}`);
    if (!hasPos || !hasLoad) {
      log(`\n  Some data is missing. Everything else still records; see README.md.`);
    }
    event({ state: 'first-packet', hasPos, hasLoad, tyres: t.length });
  }

  return {
    /** Feed one decoded PacketMain. */
    push(m) {
      const live =
        (m.playerStatusFlags & PLAYER_PHYSICS_RUNNING) !== 0 &&
        (m.playerStatusFlags & PLAYER_IN_RACE) !== 0;

      const k = (m.session.trackId || '') + '|' + (m.participantPlayerInfo.carId || '');
      if (stream && (k !== key || (lastRaceTime !== null && m.header.raceTime < lastRaceTime - 2000))) {
        close(); // different track/car, or the clock ran backwards: a restart, not a dropped frame
      }

      if (!live) {
        // Say something if packets keep arriving but never qualify — otherwise a wrong
        // assumption about the status flags looks exactly like a dead connection.
        if (!warnedIdle && Date.now() - idleSince > 20000) {
          warnedIdle = true;
          const why = `Telemetry is arriving but the car is not in a running race (playerStatusFlags=${m.playerStatusFlags}). Recording starts when you are on track.`;
          log(
            `\n  Telemetry is arriving but the car is not in a running race` +
            ` (playerStatusFlags=${m.playerStatusFlags}).` +
            `\n  Recording starts when you are on track.`
          );
          event({ state: 'idle', note: why });
        }
        return;
      }
      idleSince = Date.now();

      if (!stream) { key = k; open(m); }

      // The clock must ADVANCE, not merely differ. A datagram delivered twice carries the
      // same raceTime, and comparing only against the immediately previous value lets the
      // repeat through — the file then fills with the same instant recorded over and over.
      // FORMAT.md makes this binding on readers too, for recordings written before the
      // recorder enforced it.
      const t = m.header.raceTime;
      if (lastRaceTime !== null && t <= lastRaceTime) return;
      lastRaceTime = t;

      stream.write(JSON.stringify(frameOf(m)) + '\n');
      frames++;

      const now = Date.now();
      if (now - lastLogAt > 2000) {
        lastLogAt = now;
        const lap = m.participantPlayerLeaderboard.lapCurrent;
        const prog = ((Number(m.participantPlayerTiming.lapProgress) || 0) * 100).toFixed(0);
        const kmh = ((Number(m.carPlayer.driveline.speed) || 0) * 3.6).toFixed(0);
        // A `\r`-redrawn line has no newline to end it, so under a supervisor it would run
        // into the front of the next event and make that line unparseable. The two output
        // modes are exclusive for that reason, not merely for tidiness.
        if (supervised) {
          event({ state: 'recording', file: path.basename(file), frames, lap, progress: Number(prog), kmh: Number(kmh) });
        } else {
          process.stdout.write(`\r    lap ${lap} · ${prog}% · ${kmh} km/h · ${frames} frames   `);
        }
      }
    },
    close,
  };
}

// -----------------------------------------------------------------------------------------
// The capture path: datagrams SimHub forwards to us. Binds a port, decodes what arrives, and
// sends nothing anywhere — verify.js is what holds that last part true.
// -----------------------------------------------------------------------------------------

// How long to wait before suggesting that nothing is configured to send here. Nothing
// arriving looks exactly like "no session started yet", and the two need different fixes.
const QUIET_MS = 20000;

function runUdp(args, writer) {
  const sock = dgram.createSocket('udp4');
  let sawAny = false;

  sock.on('message', (buf) => {
    const type = packetTypeOf(buf);
    if (type === null) return;
    if (!sawAny) { sawAny = true; log('  telemetry detected — packets are arriving'); }
    if (type !== 0) return; // participant packets share the port

    const m = decodeMain(buf);
    if (m) writer.push(m);
  });

  sock.on('error', (e) => {
    console.error(
      e.code === 'EADDRINUSE'
        ? `\nPort ${args.udpPort} is already in use — pick another with --udp-port.`
        : `\nsocket error: ${e.message}`
    );
    process.exit(1);
  });

  /**
   * Nothing has arrived, so say what probably needs setting.
   *
   * SIMHUB'S SETTINGS FILE IS CONSULTED HERE AND NOWHERE EARLIER, and that placement is the
   * whole lesson. SimHub holds its configuration in memory and writes GameSettings.json on
   * exit, so the file lags the running program — the first version of this checked it at
   * startup and announced "no port is set" while packets were already arriving from a
   * forward that had been switched on minutes before. The file cannot predict whether the
   * feed works.
   *
   * What it can do is explain a silence that has already happened. By the time this runs,
   * QUIET_MS has passed with nothing on the socket, so there is no live behaviour left for
   * a stale file to contradict — it is only being asked to name the likeliest cause.
   */
  const quiet = setTimeout(() => {
    if (sawAny) return;

    // Only quoted when SimHub's settings positively disagree; "cannot tell" adds nothing
    // here and would be noise on top of a real problem.
    const fwd = forwardStatus(args.udpPort);
    console.error(
      `\n  Nothing has arrived on udp/${args.udpPort} in ${QUIET_MS / 1000}s.` +
      (fwd.known && !fwd.ok ? `\n  ${fwd.why}  (${fwd.file},` +
        `\n  which SimHub rewrites on exit, so it may lag what is set in the UI.)` : '') +
      `\n  SimHub needs pointing here: Settings -> Games -> Wreckfest 2,` +
      `\n  enable the UDP forward and set its target to 127.0.0.1:${args.udpPort}.\n`
    );
    event({ state: 'quiet', note: fwd.known && !fwd.ok ? fwd.why : 'no datagrams received' });
  }, QUIET_MS);
  if (quiet.unref) quiet.unref();

  sock.bind(args.udpPort, () => {
    log(`Wreckfest 2 session recorder`);
    log(`  source      udp/${args.udpPort}, forwarded by SimHub`);
    log(`  writing to  ${args.out}`);
    log(`\n  SimHub does not depend on this process — it keeps its own feed either way.`);
    log(`  Waiting for a session. Start a race — Ctrl-C when you are done.`);
    event({ state: 'waiting', out: args.out });
  });

  return () => {
    clearTimeout(quiet);
    try { sock.close(); } catch (e) {}
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  supervised = args.supervised;

  const writer = createWriter(args);
  const stop = runUdp(args, writer);

  // Exit only once the recording has actually flushed, with a deadline so a wedged stream
  // cannot leave the process running forever after it has been asked to stop.
  let leaving = false;
  const bye = () => {
    if (leaving) return;
    leaving = true;
    stop();
    const deadline = setTimeout(() => process.exit(0), 4000);
    writer.close(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  };

  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);

  // Under a supervisor, `stop` on stdin is the shutdown path — see the note at the top of
  // this file about why a signal cannot be used. Stdin is only read when asked for, so an
  // interactive run is unaffected: reading it would otherwise hold the event loop open.
  if (args.supervised) {
    let pending = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) if (line.trim() === 'stop') return bye();
    });
    // The supervisor going away is also a stop — nothing is left to hand the recording to.
    process.stdin.on('end', bye);
    process.stdin.on('error', bye);
  }
}

if (require.main === module) main();

module.exports = { parseArgs };
