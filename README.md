# wf2-telemetry

Captures **Wreckfest 2** telemetry to a `.jsonl` log — every frame, world position,
per-tyre slip, load and force — so it can be analyzed offline.

It reads the telemetry SimHub is already receiving. It does **not** touch the game's
configuration, is not in SimHub's path, and cannot affect the dashboards.

**One-time setup.** In SimHub: *Settings → Games → Wreckfest 2*, enable the UDP forward and
point it at `127.0.0.1:23124`. SimHub then sends the recorder a copy of every datagram, and
keeps its own feed regardless of whether the recorder is running.

```bash
node record.js                    # listen on 23124, write to ./sessions
node record.js --out D:\somewhere # Custom write directory
node record.js --udp-port 23125   # if something else already has 23124
```

Recording starts by itself when you go on track and stops when you leave. `Ctrl-C` when you
are done.

**No Node installed?** Releases ship `wf2-record.exe`, which is the same thing with the
runtime inside it — same flags, no install. See [Release executables](#release-executables).

The recording format is documented in [FORMAT.md](FORMAT.md)

---

## Using it as a library

```js
const wf2 = require('wf2-telemetry');

wf2.createSupervisor({ out: 'sessions' });      // run a recording behind a UI
wf2.shortEnum('SurfaceType', frame.T[0].su);   // 2 -> 'TARMAC'
wf2.frameOf(packet);                            // PacketMain -> a frame line
wf2.encodeMain(packet);                         // PacketMain -> a datagram, for tests

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

SimHub forwards a copy of each datagram to `127.0.0.1:23124`; the recorder decodes it.

### When nothing arrives

The one prerequisite lives in another program's settings. If twenty seconds pass with nothing on
the socket, the recorder reads `PluginsData\GameSettings.json` and names the likely cause.

Only after a silence, never as a precondition: SimHub holds its configuration in memory and
writes that file on exit, so it lags the running program and cannot predict whether the feed
works.

### Why the game is not read directly

Because it will not allow a second listener. Wreckfest 2's `telemetry/config.json` has a `udp` key holding a JSON **array**, which reads as an invitation to add a second target alongside SimHub's. It is not. This build accepts exactly one entry: given two, the game rejects the file on launch and rewrites it from a default with `"enabled": 0` — silently disabling telemetry for SimHub as well. Editing the fields of the existing single entry does stick; adding to the array does not.


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

## Release executables

`wf2-record.exe` and `wf2-telemetry-config.exe` are the two commands with a Node runtime
folded into them. Nothing to install, and the flags are identical:

```bash
wf2-record.exe --out D:\somewhere
```

The config tool ships alongside the recorder because it diagnoses the failure that makes the
recorder sit there receiving nothing — telemetry switched off in the game, or its one UDP
target pointed somewhere stale — and `node tools/telemetry.js` is not available to someone
who took the exe precisely to avoid installing Node.

To build them:

```bash
npm run release
```

That builds into `dist/` and then runs the suite against what it built. `npm run build` is
the build on its own. Both need Node 20 or newer — the *package* still runs on 18; SEA is
what needs 20.

**What they are.** Node can inject a script into a copy of itself, so the exe is literally
the `node.exe` that built it with the recorder's code inside. No packer and no third-party
runtime: what ships is what `npm test` ran. The cost is ~86 MB per binary, because a whole
runtime is in there, and there is no compressing that away.

**Build them on the platform you are shipping to.** The base is the local `node.exe`, so
this cannot cross-build. A macOS or Linux release means running the build there.

**Signing.** The build strips the Authenticode signature it inherits from `node.exe` before
injecting, because a signature that no longer matches its contents is treated worse by
Windows than none at all. That needs `signtool` from the Windows SDK; the build finds it
without help but says so if it cannot, and a release should not be cut from that build. The
result is unsigned, so SmartScreen will warn on first run.

**Cutting a release.** Push a version tag and
[`.github/workflows/release.yml`](.github/workflows/release.yml) does the rest — builds on a
Windows runner, runs the suite against the binaries it just built, and attaches
`wf2-telemetry-<tag>-win-x64.zip` (both exes, this README, `FORMAT.md`, `SHA256SUMS.txt`) to
the GitHub release.

```bash
git tag v2.1.0 && git push origin v2.1.0
```

Windows only, and not because of the build: SimHub is a Windows program, so a Linux binary
would run and then wait forever for a datagram nothing on that machine can send. The Node
version is pinned in the workflow rather than tracking `lts/*`, because it is not a build
detail — it is the runtime inside the executables. Publishing to npm stays a deliberate
`npm publish`; the workflow does not do it.

**Supervising an exe.** `createSupervisor` spawns `node record.js` by default. Point it at a
binary with `script: null`, which tells it the command *is* the recorder:

```js
createSupervisor({ out, udpPort: 23124, node: 'C:\\...\\wf2-record.exe', script: null });
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
| `tools/build-exe.js` | Builds the release executables into `dist/` |
| `verify.js` | The suite |

Recordings land in `sessions/` under the current directory. They are generated; they are not
source.

---

## Limits

What the game does not send, this cannot record: no opponent telemetry, no tyre temperatures,
no per-part damage. Overall car health is real. Everything the packet does carry is captured
whole — the recorder makes no decisions about what is worth keeping, because whatever is
dropped at capture time is gone.
