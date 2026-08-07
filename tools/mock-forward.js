'use strict';
// A stand-in for SimHub's UDP forward, so the capture path can be tested without SimHub and
// without the game.
//
// There is very little to it, and that is the point: SimHub forwards the datagram it
// received rather than a view of it, so a stand-in only has to put real PacketMain bytes on
// a socket. Nothing here needs to know how SimHub would have rendered a packet, only how the
// game encodes one, and `lib/packet.js` already owns that.
//
//   node tools/mock-forward.js --port 23124 [--hz 60] [--repeat 1]

const dgram = require('dgram');
const { encodeMain } = require('../lib/packet');

/**
 * Send fixture packets to a UDP port at roughly the game's rate.
 *
 * `repeat` sends each frame more than once. The recorder drops frames whose clock has not
 * advanced, and a mock that never repeats one would leave that guard — a rule FORMAT.md
 * makes binding on readers too — asserted nowhere.
 */
function createForwarder(options) {
  const opts = options || {};
  const port = opts.port || 23124;
  const host = opts.host || '127.0.0.1';
  const hz = opts.hz || 60;
  const repeat = opts.repeat || 1;
  const datagrams = [];
  for (const m of opts.packets || require('./fixture').packets()) {
    for (let r = 0; r < repeat; r++) datagrams.push(encodeMain(m));
  }

  const sock = dgram.createSocket('udp4');
  let timer = null;
  let sent = 0;

  function start(done) {
    timer = setInterval(() => {
      if (sent >= datagrams.length) {
        // Exhausted rather than looped: a mock that wrapped around would replay the clock
        // backwards, which the recorder reads as a restart and answers with a second file.
        stop();
        if (done) done(sent);
        return;
      }
      sock.send(datagrams[sent++], port, host);
    }, Math.max(1, Math.round(1000 / hz)));
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    try { sock.close(); } catch (e) { /* already closed */ }
  }

  return { start, stop, total: datagrams.length };
}

function main() {
  const argv = process.argv.slice(2);
  const num = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number(argv[i + 1]) : dflt;
  };
  const port = num('--port', 23124);
  const hz = num('--hz', 60);
  const repeat = num('--repeat', 1);

  const fwd = createForwarder({ port, hz, repeat });
  console.log(`mock SimHub forward -> 127.0.0.1:${port}`);
  console.log(`  ${fwd.total} datagrams · ${hz} Hz · each frame sent ${repeat}x`);
  console.log(`  then it stops, and the recorder should close its file`);
  fwd.start((n) => {
    console.log(`  sent ${n} datagrams`);
    process.exit(0);
  });
  // The forwarder's own timer is unref'd so it cannot hold a test harness open; as a CLI
  // this is the only thing running, so something has to.
  setInterval(() => {}, 1 << 30);
}

if (require.main === module) main();

module.exports = { createForwarder };
