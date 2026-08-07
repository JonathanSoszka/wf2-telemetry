# The `.jsonl` recording format

**Format version 1.**

This is the contract between whatever writes a recording and whatever reads one. It used to
be enforced by the two living in the same repository; now it is enforced by being written
down.

A recording is a UTF-8 text file of newline-terminated JSON objects. The **first line is a
session header**; every line after it is a **frame**. There is no trailing structure, no
index, and no footer — a recording that was cut off mid-write is still a valid recording of
everything before the cut, which is deliberate.

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
| `gridSize` | Number of cars |
| `sectorCount` | Sectors on this track |
| `sectorFract1`, `sectorFract2` | Sector boundaries as a fraction of the lap |
| `gameMode`, `damageMode` | Resolved to names, not left as numbers |
| `carId`, `carName`, `playerName` | Who was driving what |
| `driveline` | `FWD` / `RWD` / `AWD`, resolved to a name |
| `gearMax` | Top gear |
| `steeringLock` | Radians at full lock |
| `wheelBase` | Metres |
| `trackWidth` | `[front, rear]`, metres |
| `rpmRedline`, `rpmMax` | Engine limits |

Enums that identify the *session* are resolved to strings here, because they are written once
and read constantly. Enums that vary *per frame* are not — see `su` below.

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
difference between `2` and `"GRAVEL"` material to the file size. Resolve it on read with
`shortEnum('SurfaceType', n)`, exported from this package.

---

## Two rules a reader has to know

**`t` strictly increases.** Not "differs from the last value" — increases. SimHub republishes
the same game frame to every poll and the value jitters backwards by a frame or two, so a
writer comparing only against the immediately previous value lets repeats through. The
recorder drops non-advancing frames, and a reader should too: recordings made before that was
fixed are still out there.

**A backwards jump of more than 2 seconds is a restart, not a dropped frame.** It legitimately
begins a new run of times. The recorder closes the file and opens a new one; a reader holding
a whole file should treat it the same way rather than trying to reconcile the clock.

---

## What is not in a recording

No opponents, no sector times as such, no tyre temperatures or per-part damage — the game
does not report them. `hp` (overall health) is real. See the README for what Wreckfest 2
actually populates.
