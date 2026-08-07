# wf2-telemetry

Captures **Wreckfest 2** telemetry to a `.jsonl` log — every frame, world position,
per-tyre slip, load and force — so it can be analysed offline.

It reads the telemetry SimHub is already receiving. It does **not** touch the game's
configuration, is not in SimHub's path, and cannot affect the dashboards.

**One-time setup.** In SimHub: *Settings → Games → Wreckfest 2*, enable the UDP forward and
point it at `127.0.0.1:23124`. SimHub then sends the recorder a copy of every datagram, and
keeps its own feed regardless of whether the recorder is running.

```bash
node record.js                    # listen on 23124, write to ./sessions
node record.js --out D:\somewhere
node record.js --udp-port 23125   # if something else already has 23124
```

If nothing arrives, the recorder says what probably needs setting rather than sitting on a
silent port.

Recording starts by itself when you go on track and stops when you leave. `Ctrl-C` when you
are done.

The recording format is documented in [FORMAT.md](FORMAT.md) — that file is the contract, not
this one.

---

## Using it as a library

```js
const wf2 = require('wf2-telemetry');

wf2.shortEnum('SurfaceType', frame.T[0].su);   // 2 -> 'TARMAC'
wf2.frameOf(packet);                            // PacketMain -> a frame line
wf2.encodeMain(packet);                         // PacketMain -> a datagram, for tests
wf2.createSupervisor({ out: 'sessions' });      // run a recording behind a UI
```

The surface is deliberately narrow — see [lib/index.js](lib/index.js) for what is exported and,
more usefully, what is not.

**`createSupervisor`** is for programs with a record button rather than a terminal. It runs one
`record.js` child, refuses a second, and stops by asking rather than killing: `child.kill()` on
Windows is `TerminateProcess`, so the child's handlers never run, its stream never flushes, and
the recording ends mid-line.

---

## How the capture works

One path:

```
game  --udp-->  SimHub  --forward-->  recorder
```

SimHub forwards a copy of each datagram to `127.0.0.1:23124`; the recorder decodes it and sends
nothing anywhere. It is a **leaf** — nothing downstream of it, nothing depending on it. A tool
that records a thing should not be able to break the thing it records.

Being a leaf costs no fidelity. Measured against a real 41.6 s session, the forward delivers the
game's own tick intact — **62.5 Hz, a 16 ms gap on 2598 of 2599 frames**, one 32 ms gap, nothing
larger. SimHub passes the datagrams straight through rather than resampling at its own rate. It
also works below the level of whatever SimHub's reader chooses to publish, so it survives a
SimHub that stops exposing `Raw`.

`verify.js` watches the machine's UDP traffic while a real recorder runs and fails if a single
datagram leaves it, so "leaf" is a property that is checked rather than a claim in a README.

### When nothing arrives

The one prerequisite lives in another program's settings. If twenty seconds pass with nothing on
the socket, the recorder reads `PluginsData\GameSettings.json` and names the likely cause.

Only after a silence, never as a precondition: SimHub holds its configuration in memory and
writes that file on exit, so it lags the running program and cannot predict whether the feed
works — checked at startup it announced "no port is set" on a machine that was receiving
forwarded packets at that moment. It also stays quiet unless the settings *positively* disagree.
See [lib/simhub-config.js](lib/simhub-config.js).

### Why the game is not read directly

Because it will not allow a second listener, and finding that out cost a broken telemetry feed.
SimHub *forwarding* to a second listener is a different thing, and it is what this uses.

Wreckfest 2's `telemetry/config.json` has a `udp` key holding a JSON **array**, which reads as
an invitation to add a second target alongside SimHub's. It is not. This build accepts exactly
one entry: given two, the game rejects the file on launch and rewrites it from a default with
`"enabled": 0` — silently disabling telemetry for SimHub as well. Editing the fields of the
existing single entry does stick; adding to the array does not.

```bash
node tools/telemetry.js            # show the current state
node tools/telemetry.js --enable   # repair a feed disabled this way
node tools/telemetry.js --simhub   # point it back at SimHub, if an old --forward moved it
```

### Two paths that were removed

The game feeding the recorder, which relayed onward to SimHub (`--source udp`), and polling
SimHub's HTTP API (`--source api`). Both worked; both put something downstream of the recorder,
and the API also read a view SimHub *chooses* to publish rather than the datagram itself. The
reasoning is in the commit that removed them, `a462892`.

### The packet layout is not guessed

`lib/packet.js` contains no hand-typed byte offsets. `lib/layout.json` is dumped out of
SimHub's own `GSIReader.dll`, where every packet struct is
`[StructLayout(Sequential, Pack = 1)]`, so .NET's `Marshal.OffsetOf` reports the exact offset of
every field; the codec just walks that description. The reconstruction is self-checking —
`CarTire` comes out at 72 bytes, and `CarFull`'s four-tyre array lands its next field at exactly
the offset the dump independently reports. `PacketMain` totals 1218.

If SimHub ever ships a reader for a new packet revision, run `tools/dump-layout.ps1` again
rather than editing code.

`Pack = 1` means fields are unaligned, which is why every read goes through a `DataView` at an
explicit little-endian offset instead of a typed-array view.

---

## Testing without the game

```bash
npm test
```

The codec is round-tripped field kind by field kind; a real `record.js` child is fed real
datagrams on a real socket, to pin that stopping a recording flushes it rather than truncating
it; the recorder is watched for outbound traffic and must emit none; and the settings probe
behind the silence message is held to reporting only what it can positively establish.

`tools/mock-forward.js` stands in for SimHub's forward. There is little to it, which is the
point: SimHub forwards the datagram it received rather than a rendering of it, so imitating it
means putting `encodeMain` output on a socket. It sends each frame twice by default under test,
because the recorder's rule that the clock must *advance* rather than merely differ would
otherwise be asserted nowhere.

`tools/fixture.js` is the packet stream behind it, built to sweep field kinds rather than to
look like a lap. Read its header before adding a signal to it: a fixture field that ignores its
wire type reads exactly like a codec bug.

```bash
node tools/mock-forward.js --port 23124       # then: node record.js
```

---

## Files

| Path | Purpose |
| --- | --- |
| `record.js` | The recorder — **the command you run** |
| `lib/index.js` | The public surface |
| `lib/packet.js` | Packet codec, driven entirely by `layout.json` |
| `lib/layout.json` | Byte layout, dumped from SimHub's `GSIReader.dll` |
| `lib/simhub-config.js` | Reads SimHub's forward setting, to explain a silence |
| `lib/frame.js` | The shape of one logged frame, and the format version |
| `lib/supervisor.js` | Runs one `record.js` child: start, stop, status, events |
| `tools/telemetry.js` | Inspects and repairs the game's telemetry config |
| `tools/mock-forward.js` | A stand-in for SimHub's forward, for testing capture offline |
| `tools/fixture.js` | The packet stream behind it |
| `tools/dump-layout.ps1` | Regenerates `layout.json` from the SimHub DLL |
| `verify.js` | The suite |

Recordings land in `sessions/` under the current directory. They are generated; they are not
source.

---

## Limits

What the game does not send, this cannot record: no opponent telemetry, no tyre temperatures,
no per-part damage. Overall car health is real. Everything the packet does carry is captured
whole — the recorder makes no decisions about what is worth keeping, because whatever is
dropped at capture time is gone.
