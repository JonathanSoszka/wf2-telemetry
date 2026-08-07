#!/usr/bin/env node
'use strict';
// Session recorder — captures Wreckfest 2 telemetry to a JSONL log for offline analysis.
//
// TWO SOURCES, AND WHY THE DEFAULT IS THE API
//
// The obvious way to get full-rate telemetry is to read the game's UDP stream directly. It
// does not work here, and the reason is worth writing down: Wreckfest 2 OWNS its
// telemetry config. Its `udp` key is an array, but this build accepts exactly one entry —
// adding a second made the game reject the file on launch and rewrite it from a default
// with telemetry DISABLED, silently killing SimHub's feed too.
//
// So the recorder does not touch the game's configuration at all. It reads SimHub, which is
// already receiving the packets, through /Api/GetGameData. That endpoint serialises the
// reader's own `NewData.Raw` — the whole PacketMain, the same struct the UDP decoder
// produces — so nothing is lost by going this way. Measured at over 5000 polls/second on
// loopback, which is two orders of magnitude clear of the game's own tick.
//
// `--source udp` remains for the case where SimHub is not running or does not expose Raw.
// It requires pointing the game's SINGLE udp target at this recorder and letting it relay
// onward to SimHub (`node tools/telemetry.js --forward`), which makes SimHub depend
// on this process being up. That is why it is not the default.
//
//   node record.js                    # poll SimHub (no game config change)
//   node record.js --source udp       # bind udp/23124 and relay to SimHub
//   node record.js --out D:\somewhere
//   node record.js --supervised       # driven by another program, not a terminal
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
const http = require('http');
const path = require('path');
const dgram = require('dgram');
const { decodeMain, packetTypeOf } = require('./lib/packet');
const { frameOf, sessionHeaderOf } = require('./lib/frame');
const { normalizeMain, describe } = require('./lib/apiframe');

const DEFAULTS = {
  source: 'api',
  host: 'localhost',
  port: 8888,
  udpPort: 23124,
  simhubPort: 23123,
  pollMs: 5, // ~200 Hz ceiling; the game ticks far slower, and duplicates are dropped
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
  const a = { ...DEFAULTS, out: path.join(process.cwd(), 'sessions'), forward: false, supervised: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--source') a.source = argv[++i];
    else if (v === '--udp') a.source = 'udp';
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--port') a.port = Number(argv[++i]);
    else if (v === '--udp-port') a.udpPort = Number(argv[++i]);
    else if (v === '--forward') a.forward = true;
    else if (v === '--poll-ms') a.pollMs = Number(argv[++i]);
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
   * at 200 Hz is real frames, and leaves the last line of the recording half-written. That
   * was survivable when stopping meant Ctrl-C at the end of a session; it is not, now that
   * stopping is a button someone presses routinely.
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

      // The clock must ADVANCE, not merely differ. SimHub republishes the same game frame to
      // every poll, and the value observed jitters backwards by a frame or two — comparing
      // only against the immediately previous value lets those repeats through, and the file
      // fills with the same instant recorded over and over.
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
// source: SimHub's HTTP API
// -----------------------------------------------------------------------------------------

function runApi(args, writer) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let reported = false;
  let sawGame = false;
  let stopped = false;

  log(`Wreckfest 2 session recorder`);
  log(`  source      SimHub API at http://${args.host}:${args.port}`);
  log(`  writing to  ${args.out}`);
  log(`\n  Waiting for a session. Start a race — Ctrl-C when you are done.`);
  event({ state: 'waiting', source: 'api', out: args.out });

  function poll() {
    if (stopped) return;

    // EXACTLY ONE continuation per request.
    //
    // `res.on('end')` and `req.on('error')` are not mutually exclusive — a keep-alive socket
    // torn down after a completed response fires both. Scheduling the next poll from each of
    // them forks the loop, and every recurrence doubles the number of concurrent loops. That
    // is not a slow leak: it ran away to ~6800 polls/second and wrote an 830 MB file for a
    // three-lap session before anything looked wrong.
    let continued = false;
    const next = (delay) => {
      if (continued || stopped) return;
      continued = true;
      setTimeout(poll, delay);
    };

    const req = http.get(
      { host: args.host, port: args.port, path: '/Api/GetGameData', agent, timeout: 4000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            handle(JSON.parse(body));
          } catch (e) {
            /* a malformed poll is not worth reporting; the next one is milliseconds away */
          }
          next(args.pollMs);
        });
        res.on('error', () => next(args.pollMs));
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', (e) => {
      if (!stopped && !reported) {
        reported = true;
        console.error(
          `\n  Cannot reach SimHub at http://${args.host}:${args.port} (${e.code || e.message}).` +
          `\n  Is SimHub running, and its web server enabled?` +
          `\n  Retrying...`
        );
      }
      next(500);
    });
  }

  function handle(payload) {
    if (reported) { reported = false; log('  reconnected to SimHub'); event({ state: 'waiting', note: 'reconnected to SimHub' }); }

    const nd = payload && payload.NewData;
    if (!nd) return;

    if (!sawGame) {
      sawGame = true;
      const d = describe(payload);
      if (!d.ok) {
        console.error(
          `\n  A game is running but the raw packet is not usable:` +
          `\n    ${d.why}` +
          `\n\n  Fall back to reading the game directly:` +
          `\n    node tools/telemetry.js --forward   (then restart Wreckfest 2)` +
          `\n    node record.js --source udp\n`
        );
        return;
      }
    }

    const raw = nd.Raw || nd.raw;
    const m = normalizeMain(raw && (raw.Main || raw.main));
    if (m) writer.push(m);
  }

  poll();
  return () => { stopped = true; };
}

// -----------------------------------------------------------------------------------------
// source: the game's UDP stream (fallback)
// -----------------------------------------------------------------------------------------

function runUdp(args, writer) {
  const sock = dgram.createSocket('udp4');
  const relay = dgram.createSocket('udp4');
  let sawAny = false;

  sock.on('message', (buf) => {
    // Relay FIRST and unconditionally: in this mode SimHub is downstream of us, so a decode
    // problem here must never cost it a packet.
    relay.send(buf, args.simhubPort, '127.0.0.1');

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

  sock.bind(args.udpPort, () => {
    log(`Wreckfest 2 session recorder`);
    log(`  source      udp/${args.udpPort}, relaying to SimHub on ${args.simhubPort}`);
    log(`  writing to  ${args.out}`);
    log(`\n  SimHub only receives telemetry while this process is running.`);
    log(`  Waiting for a session. Start a race — Ctrl-C when you are done.`);
    event({ state: 'waiting', source: 'udp', out: args.out });
  });

  return () => { try { sock.close(); relay.close(); } catch (e) {} };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  supervised = args.supervised;

  const writer = createWriter(args);
  const stop = args.source === 'udp' ? runUdp(args, writer) : runApi(args, writer);

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

module.exports = { createWriter, parseArgs };
