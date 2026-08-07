# wf2-telemetry

Captures **Wreckfest 2** telemetry to a `.jsonl` log — every frame, world position,
per-tyre slip, load and force — so it can be analysed offline.

It reads the telemetry SimHub is already receiving, over SimHub's HTTP API. It does **not**
touch the game's configuration, is not in SimHub's path, and cannot affect the dashboards.

```bash
node record.js                    # poll SimHub, write to ./sessions
node record.js --out D:\somewhere
```

Recording starts by itself when you go on track and stops when you leave. `Ctrl-C` when you
are done.

The recording format is documented in [FORMAT.md](FORMAT.md) — that file is the contract, not
this one.

---

## Using it as a library

```js
const wf2 = require('wf2-telemetry');

wf2.shortEnum('SurfaceType', frame.T[0].su);   // 2 -> 'GRAVEL'
wf2.frameOf(packet);                            // PacketMain -> a frame line
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

The recorder reads **SimHub** over `http://localhost:8888/Api/GetGameData`.

That endpoint carries far more than the mapped properties. `NewData.Raw` is the public `Raw`
field on `GameReaderCommon.StatusData<T>`, and for Wreckfest 2 that is `WreckFest2Data.Main` —
a `PacketMain` property, serialised whole. So world position, per-tyre slip, load and lateral
force all come through HTTP, and the JSON path and the UDP path are pushed through the same
frame builder so a recording means the same thing either way (asserted in `verify.js`).

Polling is fast enough by a wide margin: over **5000 polls/second** on loopback, against a game
that ticks at around 60. The recorder caps itself at ~200 Hz and drops duplicate frames by
`raceTime`.

One wrinkle: C# `Byte[]` fields — `trackName`, `carName`, `carId` — are serialised by Json.NET
as **base64**, so they arrive as `"U3ludGhldGlj..."` rather than text. `lib/apiframe.js`
decodes them; without that, every recording is named after a base64 blob.

### Why not read the game's UDP stream directly

Because the game will not allow it, and finding that out cost a broken telemetry feed.

Wreckfest 2's `telemetry/config.json` has a `udp` key holding a JSON **array**, which reads as
an invitation to add a second target alongside SimHub's. It is not. This build accepts exactly
one entry: given two, the game rejects the file on launch and rewrites it from a default with
`"enabled": 0` — silently disabling telemetry for SimHub as well. Editing the fields of the
existing single entry does stick; adding to the array does not.

```bash
node tools/telemetry.js            # show the current state
node tools/telemetry.js --enable   # repair a feed disabled this way
```

**The UDP fallback**, for when SimHub is not running or a future version stops exposing `Raw`:

```bash
node tools/telemetry.js --forward   # single target -> 23124, then restart the game
node record.js --source udp         # bind 23124, relay every datagram to SimHub
```

This replaces the one target rather than adding to it, and the recorder relays onward, so
SimHub keeps working — but **only while the recorder is running**. That dependency is why it is
not the default. `--revert` puts the config back.

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

14 checks. The codec is round-tripped field kind by field kind; both capture paths are asserted
to produce **identical frames** from the same packet — otherwise a recording means something
different depending on how it was captured; and a real `record.js` child is driven against a
mock SimHub to pin that stopping a recording flushes it rather than truncating it.

`tools/mock-simhub.js` serves what SimHub's API would, base64 `Byte[]` fields and all — serving
*some* JSON would test a payload shape that never occurs. `tools/fixture.js` is the packet
stream behind it, built to sweep field kinds rather than to look like a lap. Read its header
before adding a signal to it: a fixture field that ignores its wire type reads exactly like a
codec bug.

```bash
node tools/mock-simhub.js --port 8899        # then: node record.js --port 8899
```

---

## Files

| Path | Purpose |
| --- | --- |
| `record.js` | The recorder — **the command you run** |
| `lib/index.js` | The public surface |
| `lib/packet.js` | Packet codec, driven entirely by `layout.json` |
| `lib/layout.json` | Byte layout, dumped from SimHub's `GSIReader.dll` |
| `lib/apiframe.js` | Normalises SimHub's JSON view of the packet (base64, enums) |
| `lib/frame.js` | The shape of one logged frame, and the format version |
| `lib/supervisor.js` | Runs one `record.js` child: start, stop, status, events |
| `tools/telemetry.js` | Inspects and repairs the game's telemetry config |
| `tools/mock-simhub.js` | A fake `/Api/GetGameData`, for testing capture offline |
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
