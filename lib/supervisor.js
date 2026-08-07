'use strict';
// Supervising one `record.js` child on behalf of a program with a UI — a GUI's record
// button, typically, rather than someone at a terminal.
//
// This is the only part of the package that runs a process rather than moving bytes, and
// the only part with a lifecycle to get wrong. Four rules shape it.
//
// ONE AT A TIME. SimHub forwards to one port, so a second recorder would not even bind it —
// which makes this a question of how that gets reported rather than whether it can happen. A
// child spawned only to die on EADDRINUSE surfaces as a recording that failed; refusing the
// start outright says the true thing. There is no useful reason to run two either way, so
// starting one while another is alive is refused rather than queued.
//
// STOPPING IS A CONVERSATION, NOT A KILL. `child.kill()` on Windows is TerminateProcess: the
// child's signal handlers never run, its write stream never flushes, and the recording ends
// mid-line. So a stop is a `stop` written to the child's stdin, and the kill is only the
// backstop for a child that will not go.
//
// THE CHILD'S ARGUMENTS ARE NOT THE CALLER'S. Nothing in a request reaches the command line:
// the output directory and the port are both fixed when the supervisor is created. Passing
// request parameters through to a spawned process is how a browsable local tool becomes an
// arbitrary-file-write endpoint for whatever else the browser is running.
//
// A DEAD CHILD IS A STATE, NOT A CRASH. SimHub can be closed, the game can take the port,
// the process can be killed from Task Manager. Every one of those ends as a reportable
// status rather than an exception, because the user is looking at a page that has to say
// something sensible.

const { spawn } = require('child_process');

// Resolved rather than joined. The two are the same today, and stop being the same the
// moment this package is installed somewhere with a different layout — a symlinked or
// hoisted install, or a bundler that flattens the tree. `require.resolve` asks Node where
// the file actually is instead of assuming.
const RECORD = require.resolve('../record.js');

// How long a child gets to flush and exit after being asked to stop, before it is killed.
// Generous next to the ~4 s the recorder allows itself internally, so the polite path wins
// whenever it is going to.
const STOP_GRACE_MS = 8000;

function createSupervisor(options) {
  const opts = options || {};
  const out = opts.out;
  const script = opts.script || RECORD;
  const node = opts.node || process.execPath;
  // The port SimHub forwards to. A property of the machine, so it is configured on the
  // server and never taken from a request.
  const udpPort = opts.udpPort;

  let child = null;
  let stopping = null; // the promise everyone waiting on a stop shares
  let pending = '';
  const listeners = new Set();

  // What the last child said about itself, kept so a page loaded halfway through a session
  // has something to show without waiting for the next event.
  let status = { running: false, state: 'stopped' };

  function publish(next) {
    status = next;
    for (const fn of listeners) {
      try {
        fn(status);
      } catch (e) {
        /* a broken listener must not stop the others, or take the recording down */
      }
    }
  }

  /** Merge one event from the child into the status the app sees. */
  function onEvent(e) {
    const fields = Object.assign({}, e);
    delete fields._; // the wire marker that said this line was an event, not prose
    const merged = Object.assign({}, status, fields, { running: true, pid: child ? child.pid : null });
    // `frames` belongs to the file currently open. A new file, or a closed one, must not
    // inherit the previous count — a counter that only ever goes up would read as one long
    // recording across what were really several.
    if (e.state === 'waiting' || e.state === 'idle') {
      delete merged.file;
      delete merged.frames;
      delete merged.trackName;
      delete merged.carName;
    }
    publish(merged);
  }

  function readStdout(chunk) {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try {
        const e = JSON.parse(s);
        if (e && e._ === 'rec') onEvent(e);
      } catch (err) {
        /* not an event line — the child is allowed to say things we do not model */
      }
    }
  }

  function start() {
    if (child) return { code: 'already-recording', error: 'A recording is already running.' };

    const args = [script, '--supervised', '--out', out];
    if (udpPort) args.push('--udp-port', String(udpPort));

    let proc;
    try {
      proc = spawn(node, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return { code: 'spawn-failed', error: `Could not start the recorder: ${e.message}` };
    }

    child = proc;
    pending = '';
    let stderr = '';

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', readStdout);
    proc.stderr.setEncoding('utf8');
    // The recorder puts real trouble on stderr — a port taken, a forward that was never
    // configured. Only the tail is kept, so a repeated complaint cannot grow without bound.
    proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });

    const finish = (state, extra) => {
      if (child !== proc) return;
      child = null;
      stopping = null;
      publish(Object.assign({ running: false, state, stderr: stderr.trim() || undefined }, extra));
    };

    proc.on('error', (e) => finish('failed', { note: e.message }));
    proc.on('exit', (code, signal) => {
      // A child that exits on its own has hit something the user needs told about; one that
      // exits after being asked to is simply done.
      finish(stopping ? 'stopped' : code === 0 ? 'stopped' : 'failed', {
        note: stopping || code === 0 ? undefined : `The recorder exited (${signal || 'code ' + code}).`,
      });
    });

    publish({ running: true, state: 'starting', pid: proc.pid });
    return { ok: true, pid: proc.pid };
  }

  function stop() {
    if (!child) return Promise.resolve({ code: 'not-recording', error: 'Nothing is recording.' });
    if (stopping) return stopping;

    const proc = child;
    publish(Object.assign({}, status, { state: 'stopping' }));

    stopping = new Promise((done) => {
      const kill = setTimeout(() => {
        // Only reached if the child ignored `stop` — the recording is likely truncated, but
        // a supervisor that can be left holding a process it cannot end is worse.
        try {
          proc.kill();
        } catch (e) {
          /* already gone */
        }
      }, STOP_GRACE_MS);

      proc.once('exit', () => {
        clearTimeout(kill);
        done({ ok: true });
      });

      try {
        proc.stdin.write('stop\n');
        proc.stdin.end();
      } catch (e) {
        clearTimeout(kill);
        try { proc.kill(); } catch (err) { /* already gone */ }
        done({ ok: true });
      }
    });

    return stopping;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** Server shutting down: end the recording rather than orphaning it. */
  function shutdown() {
    listeners.clear();
    return child ? stop() : Promise.resolve({ ok: true });
  }

  return { start, stop, subscribe, shutdown, status: () => status };
}

module.exports = { createSupervisor, STOP_GRACE_MS };
