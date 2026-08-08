# The `.jsonl` recording format

**Format version 2.** Version 1 was the player alone; version 2 adds the rest of the grid.
The rules below apply to both, and the added line types are described under "The other cars".

This is the contract between whatever writes a recording and whatever reads one. It used to
be enforced by the two living in the same repository; now it is enforced by being written
down.

A recording is a UTF-8 text file of newline-terminated JSON objects. The **first line is a
session header**. After it, a line with **no `_` key is a player frame**, and a line **with**
one is a participant record — see "The other cars". In format 1 there were no participant
records, so every line after the header was a frame; code written against that assumption is
exactly what the version bump exists to stop.

There is no trailing structure, no index, and no footer — a recording that was cut off
mid-write is still a valid recording of everything before the cut, which is deliberate.

Keys are short because a race is tens of thousands of frames and the key names would
otherwise be most of the file.

---

## Versioning

The header carries `v`. **A missing `v` means 1** — recordings made before the field existed
are format 1 by definition, and a reader that treats absence as anything else orphans them.

`v` is bumped when an existing key **changes meaning or disappears**. Adding a key does not
bump it: readers ignore what they do not recognise, and a reader that refused unknown keys
could never be forward compatible at all.

A reader should refuse a recording whose `v` is higher than it understands, rather than read
it anyway. The failure being prevented is not a crash — it is a confident, well-formatted,
wrong answer derived from a field that changed under it.

---

## The session header

One object, first line, `_` is always `"session"`.

| Key | Meaning |
| --- | --- |
| `_` | `"session"` — how a reader knows it has the header |
| `v` | Format version (see above) |
| `startedAt` | ISO 8601 timestamp of when recording began |
| `trackId` | The game's track identifier |
| `trackName` | Display name |
| `trackLength` | Metres |
| `laps` | Laps the session was set to |
| `gridSize` | Number of cars **that raced** — not necessarily how many were recorded |
| `bots` | Were the AI drivers recorded? (format 2) — **absent means yes** |
| `sectorCount` | Sectors on this track |
| `sectorFract1`, `sectorFract2` | Sector boundaries as a fraction of the lap |
| `gameMode`, `damageMode` | Resolved to names, not numbers — `MODE_BANGER`, `MODE_NORMAL` |
| `carId`, `carName`, `playerName` | Who was driving what |
| `playerIndex` | Which participant slot is the player (format 2) |
| `driveline` | `TYPE_FWD` / `TYPE_RWD` / `TYPE_AWD` |
| `gearMax` | Top gear |
| `steeringLock` | Radians at full lock |
| `wheelBase` | Metres |
| `trackWidth` | `[front, rear]`, metres |
| `rpmRedline`, `rpmMax` | Engine limits |

Enums that identify the *session* are resolved to strings here, because they are written once
and read constantly. Enums that vary *per frame* are not — see `su` below.

The resolved name keeps everything after the **first** underscore, so `DRIVELINE_TYPE_RWD`
is stored as `TYPE_RWD`, not `RWD`. Match on the stored value, not on the tail of it.

## A frame

One object per line, one per game tick. Floats are rounded to the precision noted; physics
floats carry no meaning past about four significant figures, and the rounding is most of why
a recording is the size it is.

| Key | Meaning | Unit / precision |
| --- | --- | --- |
| `t` | Race time — **strictly increasing**, see below | ms |
| `lap` | Current lap number | |
| `prog` | Position around the lap, 0..1 | 6 dp |
| `lt`, `ll`, `lb` | Lap time current / last / best | ms |
| `x`, `y`, `z` | World position | m, 3 dp |
| `sp` | Driveline (wheel) speed | m/s, 4 dp |
| `vx`, `vy`, `vz` | Velocity, car-local axes | m/s, 4 dp |
| `wy` | Yaw rate — the basis of curvature | rad/s, 5 dp |
| `ax`, `ay`, `az` | Acceleration, car-local axes | m/s², 4 dp |
| `g` | Gear | |
| `rpm` | Engine speed — integer on the wire | |
| `thr`, `brk`, `clu`, `hb`, `str` | Throttle, brake, clutch, handbrake, steering | 0..1 (`str` is −1..1), 4 dp |
| `T` | Four tyres, **FL, FR, RL, RR** | see below |
| `ts` | Track status (on track, cutting, …) | numeric enum |
| `hp` | Car health | |
| `p` | Race position | |
| `ss` | Session status | numeric enum |
| `psf` | Player status flags — bit 0 in race, bit 2 physics running | bitfield |
| `col` | Time of the last collision | ms |

### `T` — per tyre

| Key | Meaning | Unit / precision |
| --- | --- | --- |
| `sa` | Slip angle | rad, 5 dp |
| `sr` | Slip ratio — **signed**; negative is locking | 5 dp |
| `fl` | Lateral force | N, 1 dp |
| `fo` | Longitudinal force | N, 1 dp |
| `lv` | Vertical load | N, 1 dp |
| `cam` | Camber | rad, 4 dp |
| `sd` | Suspension displacement, normalised | 4 dp |
| `su` | Surface type | **numeric enum** |

Corner order is FL, FR, RL, RR, and it was proved live on a RWD car under power rather than
assumed. A reader that has this backwards produces a plausible report about the wrong end of
the car.

`su` stays numeric on purpose: four tyres times tens of thousands of frames makes the
difference between `2` and `"TARMAC"` material to the file size. Resolve it on read with
`shortEnum('SurfaceType', n)`, exported from this package.

---

## Two rules a reader has to know

**`t` strictly increases.** Not "differs from the last value" — increases. A duplicated
datagram repeats a `raceTime`, and a writer comparing only against the immediately previous
value lets it through. The recorder drops non-advancing frames and a reader should too:
recordings made before it enforced that are still out there.

**A backwards jump of more than 2 seconds is a restart, not a dropped frame.** It legitimately
begins a new run of times. The recorder closes the file and opens a new one; a reader holding
a whole file should treat it the same way rather than trying to reconcile the clock.

---

## The other cars — format 2

Format 1 was a header and a stream of frames, all about the player, and a reader could take
"every line after the first is a frame" as given. **It no longer can.** Format 2 interleaves
four more line types, each carrying a `_` discriminator. **A line with a `_` is not a frame.
A reader that does not recognise one must skip it, not parse it.**

That is why this is version 2 rather than an added key: what an existing line *position*
means has changed. A format 1 reader pointed at a format 2 recording would push an opponent's
position into its frame list — and because these lines share a `raceTime` with the player
frame beside them, a reader deduplicating on a non-advancing clock would then discard roughly
half of what it read. It would not crash. It would produce a shorter, plausible, wrong
session. Refusing the file on `v` is the only outcome worth having.

Every participant record is `{_, t, P}`:

| Key | Meaning |
| --- | --- |
| `_` | `cars`, `pos`, `prg` or `st` |
| `t` | The `raceTime` off **that packet's own header** — see the joining rule below |
| `P` | Per-slot array. **The index is the car**, and it means the same car in every record type |

The header gains `playerIndex`: which slot in `P` is the player. Without it a reader has to
find itself by matching its own name against the roster, which breaks the moment two drivers
share one — and on a grid of bots called `*BOT 1`..`*BOT 24` that is not far-fetched.

### `cars` — the roster

`P[i]` is `[playerName, carName, carId, extentX, extentY, extentZ]`, or `null` for a slot
holding nobody. Written when the roster **changes**, which in practice is once, as the grid
forms. Extents are the car's bounding box; they describe the car rather than its movement, so
they live here rather than on every position line.

### `pos` — where everyone is

`P[i]` is `[x, y, z, qx, qy, qz, qw, speed]` — world position, orientation quaternion, speed
in m/s. Written every time a motion packet arrives. This is the bulk of a multi-car recording
and the only thing a replay strictly needs. The quaternion is the difference between drawing
cars and drawing dots.

### `prg` — how far round each car is

`P[i]` is `[lapProgress, lapTimeCurrent, deltaAhead, deltaBehind]`. Written every time a
timing packet arrives. These are kept out of `st` **because they change every tick** — left
in there they would defeat the elision that makes `st` almost free.

### `st` — the discrete state

`P[i]` is a positional row, and `ST_FIELDS` — exported from this package — is the key to it.
It carries status, track status, lap, race position, health, wrecks, frags, score, gap to the
leader, last and best lap, and last/best sector times.

**`null` means unchanged since the previous record of the same type, and a reader carries the
last value forward.** That is lossless — delta encoding, not sampling — and it is most of the
difference between 14 MB/min and 7. It elides constantly on `st`, where a car's position and
health change a handful of times a lap, and never fires on `pos` or `prg`, where every car
moves every tick.

### The joining rule, which is not optional

**Join on `t`. Never on arrival order, and never by pairing "the next of each".**

The streams are *not* 1:1, and that was measured rather than assumed. Over one 206-second
race the recorder saw **12903** MAIN packets, **12324** each of leaderboard, timing and
sectors, and **12198** motion. MAIN keeps arriving outside the session; motion skips ticks.

So a frame may have no `pos` beside it, and a reader has to let that be true — interpolating,
holding, or refusing as it sees fit — rather than treating the file as malformed. What it must
not do is take the next `pos` in the file as belonging to the frame above it. That skews every
car by a tick and yields a replay that looks almost right.

### `bots: false` — a grid recorded without its AI

`record.js --no-bots` keeps the drivers who are people and leaves the game's AI out. The
slots it drops are written as `null`, in every record type, exactly like a slot nobody is in
— **there is no per-line marker saying a car was suppressed**, because a reader that had to
interpret one would be worse off than a reader looking at an emptier grid.

So the header is the only thing that says it happened, and a reader that cares must check it:

* `bots` absent or `true` — the roster is the grid.
* `bots: false` — the roster is the people on the grid. `gridSize` still reports how many
  cars raced, so the difference between the two is the AI that was not recorded.

Slot indices are unaffected: a dropped slot keeps its place, and index *i* still means the
same car in every record. Note that on an `st` line `null` therefore carries two meanings —
"unchanged since the last one" for a slot that is being recorded, and "not here" for one that
is not. They cannot be told apart from the line, only from the header, which is why the flag
is in the header rather than inferred from an empty-looking roster.

### What is deliberately not recorded

`PARTICIPANTS_DAMAGE` arrives and is decoded, and is **not written**. It populates 4 of its 21
bytes with powers of two — a bitfield of damaged parts, about 0.2 MB/min. That was measured,
so if it is ever wanted the answer is already known rather than costing another session to
find out. Per-car `health` is in `st` and is a different thing.

---

## What is not in a recording

No tyre temperatures and no per-part damage for the player — the game does not report them.
`hp` (overall health) is real. See the README for what Wreckfest 2 actually populates.

Opponents were on this list until format 2. They are here now.
