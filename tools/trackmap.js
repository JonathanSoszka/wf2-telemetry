#!/usr/bin/env node
'use strict';
// Derive a track map from a recording: a centreline, the surface under it, the jumps, and
// where the sectors fall.
//
//   node tools/trackmap.js sessions/<file>.jsonl                 # summary to stdout
//   node tools/trackmap.js <file> --json map.json                # the map, as data
//   node tools/trackmap.js <file> --svg map.svg                  # the map, as a picture
//   node tools/trackmap.js <file> --bins 720                     # resolution, default 360
//
// WHAT THIS IS BUILT ON
//
// `prog` is the game's own position around the lap, 0..1, and it is the thing that makes this
// possible: it is a distance parameter that every lap shares. Bin `x, y, z` by `prog` and
// average across laps and the result is a centreline, in metres, in world coordinates. The
// racing line wanders within the track — that scatter is bounded by the track's own width, so
// averaging several laps lands near the middle of it rather than on any one lap's line.
//
// The map is therefore only as good as the number of clean laps behind it. One lap gives the
// racing line, not the track. `laps` in the output says which ones were used.
//
// WHAT THIS DELIBERATELY DOES NOT PRODUCE: TRACK WIDTH
//
// The obvious next field is a left and right edge, and the obvious way to get it is to place
// the four wheels and watch the surface under them change. It does not work on the recordings
// this was written against, for three separate reasons, and a width field that quietly meant
// "wherever the driver happened to go off" would be worse than none:
//
//   * `ts` (track status) is 0 on every frame of every recording seen so far. The game's own
//     off-track signal never fires, so it cannot be the trigger.
//   * Kerbs (`RUMBLE_LOFQ`) — which are exactly the painted edge — are under 1% of tyre
//     samples. Too rare to trace an edge with.
//   * The off-track surfaces that do appear reach a fifth of the lap at best, and none of it
//     where the driver stayed on. Width would exist only where someone made a mistake.
//
// And placing the wheels needs the car's heading, which is NOT in a frame: `CarMotionOrientation`
// carries an orientation quaternion, `frameOf` writes only the three positions from it, and
// heading recovered from the path tangent is wrong in exactly the moments a banger race is
// made of — slides, spins, anything sideways. Recording the quaternion is the prerequisite for
// this ever being attempted; the opponent `pos` rows already keep it.
//
// A grid recording (format 2, `pos` lines) is the other way in: many cars tracing many lines
// gives an envelope of driven positions, and that approximates drivable width without needing
// a surface transition at all. This tool reads the player's frames only, so it does not.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { shortEnum, FORMAT_VERSION } = require('../lib/index.js');

// A lap is used if the distance actually driven is close to the track length. Too short means
// the lap was cut or clipped by the start of the recording; too long means an off and a
// recovery, which drags the mean line off the track entirely. The window is wide because a
// racing line is legitimately a couple of percent shorter than the measured centreline.
const LAP_MIN = 0.85;
const LAP_MAX = 1.15;

// Below this the car is manoeuvring, not lapping, and its position says nothing about where
// the track goes. It also keeps the grid and the pit lane out of the average.
const MIN_SPEED = 3; // m/s

// All four wheels off the ground. On these tracks that is a jump, not a kerb hop.
const AIR_BIN = 0.3;

// The distance over which curvature is measured. Short enough to resolve a 10 m hairpin,
// long enough that the scatter in a bin's mean position does not invent one.
const CURVE_SPAN_M = 12;

const r = (v, d) => {
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
};

// --- reading ------------------------------------------------------------------------------

async function read(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  let header = null;
  const frames = [];
  let skipped = 0;   // participant records — format 2 lines that are not frames
  let repeats = 0;   // `t` failed to advance; the duplicate datagram the format warns about
  let restarts = 0;  // a backwards jump of more than 2s begins a new run
  let lineNo = 0;

  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;

    let o;
    try {
      o = JSON.parse(line);
    } catch (e) {
      throw new Error(`${file}:${lineNo} is not JSON — ${e.message}`);
    }

    if (!header) {
      if (o._ !== 'session') throw new Error(`${file}: first line is not a session header`);
      // A missing `v` means 1. Refusing a file from the future is the point: a key that
      // changed meaning would give a confident, well-formatted, wrong map.
      const v = o.v === undefined ? 1 : o.v;
      if (v > FORMAT_VERSION) {
        throw new Error(`${file}: format v${v}, and this reads up to v${FORMAT_VERSION}`);
      }
      header = { ...o, v };
      continue;
    }

    if (o._ !== undefined) { skipped++; continue; } // not a frame — skip, never parse

    const prev = frames.length ? frames[frames.length - 1] : null;
    if (prev) {
      if (o.t <= prev.t) {
        // More than two seconds backwards is a restart, which legitimately begins a new run
        // of times. Everything after it belongs to a different session on the same track.
        if (prev.t - o.t > 2000) { restarts++; frames.push({ ...o, restart: true }); continue; }
        repeats++;
        continue;
      }
    }
    frames.push(o);
  }

  if (!header) throw new Error(`${file}: empty`);
  return { header, frames, skipped, repeats, restarts };
}

// Split at restarts and keep the longest run. Reconciling the clock across one is not
// possible; mapping both halves as if they were one lap sequence is worse than dropping one.
function longestRun(frames) {
  const runs = [[]];
  for (const f of frames) {
    if (f.restart) runs.push([]);
    runs[runs.length - 1].push(f);
  }
  runs.sort((a, b) => b.length - a.length);
  return { run: runs[0], runs: runs.length };
}

// --- laps ---------------------------------------------------------------------------------

function lapReport(frames, trackLength) {
  const laps = new Map();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let L = laps.get(f.lap);
    if (!L) laps.set(f.lap, (L = { lap: f.lap, n: 0, dist: 0, pmin: 1, pmax: 0 }));
    L.n++;
    L.pmin = Math.min(L.pmin, f.prog);
    L.pmax = Math.max(L.pmax, f.prog);
    const p = frames[i - 1];
    if (p && p.lap === f.lap) L.dist += Math.hypot(f.x - p.x, f.z - p.z);
  }

  const out = [];
  for (const L of [...laps.values()].sort((a, b) => a.lap - b.lap)) {
    const ratio = L.dist / trackLength;
    let reason = null;
    if (L.pmax - L.pmin < 0.9) reason = 'partial lap';
    else if (ratio < LAP_MIN) reason = `drove ${L.dist.toFixed(0)}m of ${trackLength.toFixed(0)}m`;
    else if (ratio > LAP_MAX) reason = `drove ${L.dist.toFixed(0)}m of ${trackLength.toFixed(0)}m — an off and a recovery`;
    out.push({ lap: L.lap, frames: L.n, metres: r(L.dist, 1), used: !reason, reason });
  }
  return out;
}

// --- the map ------------------------------------------------------------------------------

function build(header, frames, nbins) {
  const used = new Set(
    lapReport(frames, header.trackLength).filter((l) => l.used).map((l) => l.lap)
  );

  const bins = Array.from({ length: nbins }, () => ({
    n: 0, x: 0, y: 0, z: 0, sp: 0, yaw: 0, yawN: 0, air: 0, surf: new Map(),
  }));

  for (const f of frames) {
    if (!used.has(f.lap) || f.sp < MIN_SPEED) continue;
    const b = bins[Math.min(nbins - 1, Math.floor(f.prog * nbins))];
    b.n++;
    b.x += f.x; b.y += f.y; b.z += f.z; b.sp += f.sp;
    if (f.sp > 0) { b.yaw += Math.abs(f.wy) / f.sp; b.yawN++; }

    const names = f.T.map((t) => shortEnum('SurfaceType', t.su));
    if (names.every((n) => n === 'NOCONTACT')) b.air++;
    // NOCONTACT is a wheel in the air, not a surface. Counting it would make the dominant
    // surface of a jump "no surface" long before the car actually left the ground.
    for (const n of names) if (n !== 'NOCONTACT') b.surf.set(n, (b.surf.get(n) || 0) + 1);
  }

  const line = [];
  for (let i = 0; i < nbins; i++) {
    const b = bins[i];
    if (!b.n) continue; // a hole. Filling it would be inventing track.
    const total = [...b.surf.values()].reduce((a, c) => a + c, 0);
    const dom = [...b.surf].sort((a, c) => c[1] - a[1])[0];
    line.push({
      bin: i,
      p: r((i + 0.5) / nbins, 5),
      s: r(((i + 0.5) / nbins) * header.trackLength, 2), // metres around the lap
      x: r(b.x / b.n, 2),
      y: r(b.y / b.n, 2),
      z: r(b.z / b.n, 2),
      sp: r(b.sp / b.n, 2),
      surface: dom ? dom[0] : null, // null: airborne through the whole bin, every lap
      surfaceFrac: dom ? r(dom[1] / total, 3) : 0,
      air: r(b.air / b.n, 3),
      samples: b.n,
      // Curvature of the CAR, not of the line: |yaw rate| / speed. Where it exceeds the
      // geometric curvature below, the car was rotating more than the line was turning —
      // which is to say it was sliding.
      yawK: b.yawN ? r(b.yaw / b.yawN, 5) : null,
    });
  }

  addCurvature(line, header.trackLength / nbins);
  return { line, laps: used };
}

// Signed curvature of the binned centreline, 1/m. Heading is atan2(dx, dz), so it increases
// clockwise on a plot drawn with +x right and +z up — positive curvature is a right-hand bend
// in that view. Radius is 1/|k|.
//
// The window is a distance, not a bin count, so that --bins changes the resolution of the map
// without changing what curvature means. A bin holds a couple of dozen samples and its mean
// position carries perhaps a metre of noise; differencing adjacent bins at a fine resolution
// turns that metre into a hairpin that is not there. Over CURVE_SPAN_M the noise is small
// against the real turn.
function addCurvature(line, binMetres) {
  const n = line.length;
  const h = Math.max(1, Math.round(CURVE_SPAN_M / 2 / binMetres));
  if (n < 4 * h + 1) { for (const p of line) { p.k = null; p.radius = null; } return; }
  const span = 2 * h * binMetres;
  const head = [];
  for (let i = 0; i < n; i++) {
    const a = line[(i - h + n) % n], b = line[(i + h) % n];
    head.push(Math.atan2(b.x - a.x, b.z - a.z));
  }
  for (let i = 0; i < n; i++) {
    let d = head[(i + h) % n] - head[(i - h + n) % n];
    while (d > Math.PI) d -= 2 * Math.PI;   // the wrap at ±π is a straight, not a hairpin
    while (d < -Math.PI) d += 2 * Math.PI;
    const k = d / span;
    line[i].k = r(k, 5);
    line[i].radius = Math.abs(k) > 1e-4 ? r(1 / Math.abs(k), 1) : null;
  }
}

// Contiguous runs of one surface. The lap is a loop, so a run spanning the start/finish line
// is one run and not two — it is reported starting where it starts, which is before 0%, and
// the list is ordered round the lap from there.
function segments(line, nb, trackLength, key, label) {
  if (!line.length) return [];
  const runs = [];
  for (const p of line) {
    const last = runs[runs.length - 1];
    const v = key(p);
    if (last && last.v === v && last.endBin === p.bin - 1) { last.endBin = p.bin; last.bins++; }
    else runs.push({ v, startBin: p.bin, endBin: p.bin, bins: 1 });
  }
  const first = runs[0], last = runs[runs.length - 1];
  if (runs.length > 1 && first.v === last.v && first.startBin === 0 && last.endBin === nb - 1) {
    first.startBin = last.startBin - nb; // negative: it began before the start/finish line
    first.bins += last.bins;
    runs.pop();
  }
  return runs
    .map((run) => ({
      [label]: run.v,
      from: r(((run.startBin + nb) % nb) / nb, 4),
      to: r(((run.endBin + 1) % nb || nb) / nb, 4),
      fromM: r((((run.startBin + nb) % nb) / nb) * trackLength, 1),
      metres: r((run.bins / nb) * trackLength, 1),
    }))
    .sort((a, b) => a.from - b.from);
}

// Runs of bins spent airborne. Wrapped like `segments`, for the same reason: a jump landing
// after the start/finish line is one jump, and reporting it as two would put a phantom one at
// each end of the lap.
function jumps(line, nb, trackLength) {
  const out = [];
  let cur = null;
  for (const p of line) {
    if (p.air <= AIR_BIN) continue;
    if (cur && cur.endBin === p.bin - 1) { cur.endBin = p.bin; cur.pts.push(p); }
    else { cur = { startBin: p.bin, endBin: p.bin, pts: [p] }; out.push(cur); }
  }
  const first = out[0], last = out[out.length - 1];
  if (out.length > 1 && first.startBin === 0 && last.endBin === nb - 1) {
    first.startBin = last.startBin - nb;
    first.pts = last.pts.concat(first.pts); // in lap order across the line
    out.pop();
  }
  return out
    .map((j) => {
      const mid = j.pts[j.pts.length >> 1];
      const bins = j.endBin - j.startBin + 1;
      return {
        from: r(((j.startBin + nb) % nb) / nb, 4),
        to: r(((j.endBin + 1) % nb || nb) / nb, 4),
        fromM: r((((j.startBin + nb) % nb) / nb) * trackLength, 1),
        metres: r((bins / nb) * trackLength, 1),
        x: mid.x, y: mid.y, z: mid.z,
        speed: mid.sp,
        peakAir: r(Math.max(...j.pts.map((p) => p.air)), 3),
      };
    })
    .sort((a, b) => a.from - b.from);
}

function at(line, p) {
  return line.reduce((best, q) => (Math.abs(q.p - p) < Math.abs(best.p - p) ? q : best));
}

function sectors(line, header) {
  const fr = [0];
  if (header.sectorFract1 != null) fr.push(header.sectorFract1);
  if (header.sectorFract2 != null) fr.push(header.sectorFract2);
  return fr.slice(0, header.sectorCount || fr.length).map((p, i) => {
    const q = at(line, p);
    return { sector: i + 1, p, x: q.x, y: q.y, z: q.z, s: r(p * header.trackLength, 1) };
  });
}

function mapOf(file, data, nbins) {
  const { header } = data;
  const { run, runs } = longestRun(data.frames);
  const laps = lapReport(run, header.trackLength);
  const { line } = build(header, run, nbins);
  if (!line.length) throw new Error(`${file}: no lap survived — nothing to map`);

  const ys = line.map((p) => p.y);
  const xs = line.map((p) => p.x);
  const zs = line.map((p) => p.z);

  return {
    track: {
      id: header.trackId,
      name: header.trackName,
      length: header.trackLength,
      sectorCount: header.sectorCount,
    },
    source: {
      file: path.basename(file),
      startedAt: header.startedAt,
      formatVersion: header.v,
      bins: nbins,
      binMetres: r(header.trackLength / nbins, 2),
      binsCovered: line.length,
      lapsUsed: laps.filter((l) => l.used).map((l) => l.lap),
      laps,
      restarts: data.restarts,
      repeatedFrames: data.repeats,
      participantRecordsSkipped: data.skipped,
      runsInFile: runs,
    },
    bounds: {
      x: [r(Math.min(...xs), 2), r(Math.max(...xs), 2)],
      y: [r(Math.min(...ys), 2), r(Math.max(...ys), 2)],
      z: [r(Math.min(...zs), 2), r(Math.max(...zs), 2)],
      elevation: r(Math.max(...ys) - Math.min(...ys), 2),
    },
    sectors: sectors(line, header),
    surfaces: segments(line, nbins, header.trackLength, (p) => p.surface, 'surface'),
    jumps: jumps(line, nbins, header.trackLength),
    centreline: line,
  };
}

// --- output -------------------------------------------------------------------------------

function summarise(m) {
  const S = m.source;
  console.log(`\n  ${m.track.name}  (${m.track.id})  ${m.track.length} m`);
  console.log(`  ${S.file} — format v${S.formatVersion}, ${S.bins} bins of ${S.binMetres} m, ${S.binsCovered} covered`);
  if (S.restarts) console.log(`  ${S.restarts} restart(s) in the file — mapped the longest of ${S.runsInFile} runs`);
  if (S.repeatedFrames) console.log(`  ${S.repeatedFrames} frame(s) dropped for a non-advancing clock`);

  console.log(`\n  Laps`);
  for (const l of S.laps) {
    console.log(`    lap ${String(l.lap).padStart(2)}  ${String(l.frames).padStart(5)} frames  ${String(l.metres).padStart(7)} m  ${l.used ? 'used' : 'skipped — ' + l.reason}`);
  }
  if (!S.lapsUsed.length) return;
  if (S.lapsUsed.length === 1) {
    console.log(`\n  Only one lap survived. This is that lap's racing line, not the track.`);
  }

  console.log(`\n  Surface around the lap`);
  for (const s of m.surfaces) {
    console.log(`    ${(s.from * 100).toFixed(1).padStart(6)}% ${String(s.fromM).padStart(7)} m  ${String(s.metres).padStart(6)} m  ${s.surface || '(airborne)'}`);
  }

  if (m.jumps.length) {
    console.log(`\n  Airborne (all four wheels, over ${AIR_BIN * 100}% of samples)`);
    for (const j of m.jumps) {
      console.log(`    ${(j.from * 100).toFixed(1).padStart(6)}% ${String(j.fromM).padStart(7)} m  ${String(j.metres).padStart(6)} m  at ${j.speed} m/s`);
    }
  }

  const tight = [...m.centreline].filter((p) => p.radius).sort((a, b) => a.radius - b.radius).slice(0, 3);
  console.log(`\n  Elevation ${m.bounds.y[0]}..${m.bounds.y[1]} m (${m.bounds.elevation} m of relief)`);
  console.log(`  Tightest bends  ${tight.map((p) => `${(p.p * 100).toFixed(0)}% r=${p.radius}m`).join('   ')}`);
  console.log(`  Sectors  ${m.sectors.map((s) => `S${s.sector} at ${s.s}m`).join('   ')}\n`);
}

const SURFACE_COLOUR = {
  TARMAC: '#5b6470', CONCRETE: '#8d94a0', GRAVEL: '#b8894a', DIRT: '#9a7248',
  MUD: '#6f5537', SAND: '#d9c37a', ROCKS: '#8a8070', FOLIAGE: '#4a8c46',
  SNOW: '#dfe6ee', RUMBLE_LOFQ: '#c8494f', SLOWDOWN: '#8a5ba8', DEFAULT: '#999999',
};

function svgOf(m) {
  const W = 720, H = 720, PAD = 60;
  const L = m.centreline;
  const x0 = Math.min(...L.map((p) => p.x)), x1 = Math.max(...L.map((p) => p.x));
  const z0 = Math.min(...L.map((p) => p.z)), z1 = Math.max(...L.map((p) => p.z));
  const sc = Math.min((W - 2 * PAD) / Math.max(x1 - x0, 1), (H - 2 * PAD) / Math.max(z1 - z0, 1));
  const X = (x) => (W / 2 + (x - (x0 + x1) / 2) * sc).toFixed(1);
  const Y = (z) => (H / 2 - (z - (z0 + z1) / 2) * sc).toFixed(1); // world +z drawn up
  const font = 'ui-sans-serif,system-ui,-apple-system,sans-serif';

  let s = `<rect width="100%" height="100%" fill="#fbfbfc"/>`;
  for (let i = 0; i < L.length; i++) {
    const a = L[i], b = L[(i + 1) % L.length];
    const col = a.air > AIR_BIN ? '#e0474c' : SURFACE_COLOUR[a.surface] || '#999';
    s += `<line x1="${X(a.x)}" y1="${Y(a.z)}" x2="${X(b.x)}" y2="${Y(b.z)}" stroke="${col}" stroke-width="8" stroke-linecap="round"/>`;
  }
  for (const j of m.jumps) s += `<circle cx="${X(j.x)}" cy="${Y(j.z)}" r="9" fill="none" stroke="#e0474c" stroke-width="2.5"/>`;
  for (const q of m.sectors) {
    s += `<circle cx="${X(q.x)}" cy="${Y(q.z)}" r="5.5" fill="#111" stroke="#fff" stroke-width="2"/>`;
    s += `<text x="${+X(q.x) + 11}" y="${+Y(q.z) - 8}" font-size="12" font-weight="600" fill="#111" font-family="${font}">${q.sector === 1 ? 'S/F' : 'S' + q.sector}</text>`;
  }
  s += `<text x="${W / 2}" y="30" text-anchor="middle" font-size="17" font-weight="700" fill="#111" font-family="${font}">${m.track.name}</text>`;
  s += `<text x="${W / 2}" y="50" text-anchor="middle" font-size="12" fill="#556" font-family="${font}">${m.track.length} m · ${m.source.lapsUsed.length} lap(s) · ${(x1 - x0).toFixed(0)} × ${(z1 - z0).toFixed(0)} m · ${m.bounds.elevation} m of relief</text>`;

  const seen = [...new Set(m.centreline.map((p) => p.surface).filter(Boolean))];
  seen.forEach((k, i) => {
    s += `<rect x="${24 + i * 116}" y="${H - 26}" width="24" height="8" rx="4" fill="${SURFACE_COLOUR[k] || '#999'}"/>`;
    s += `<text x="${54 + i * 116}" y="${H - 19}" font-size="12" fill="#334" font-family="${font}">${k.toLowerCase()}</text>`;
  });
  if (m.jumps.length) {
    s += `<circle cx="${32 + seen.length * 116}" cy="${H - 22}" r="6" fill="none" stroke="#e0474c" stroke-width="2.5"/>`;
    s += `<text x="${46 + seen.length * 116}" y="${H - 18}" font-size="12" fill="#334" font-family="${font}">airborne</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
}

// --- cli ----------------------------------------------------------------------------------

const TAKES_VALUE = new Set(['--json', '--svg', '--bins']);

// Positional arguments are files, `--x value` pairs are options, and an unknown `--x` is an
// error rather than a silently ignored word — a mistyped flag that maps the wrong thing
// without saying so is the failure worth preventing.
function parse(argv) {
  const files = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { files.push(a); continue; }
    if (!TAKES_VALUE.has(a)) throw new Error(`unknown option ${a}`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    opts[a] = argv[++i];
  }
  return { files, opts };
}

async function main() {
  const { files, opts } = parse(process.argv.slice(2));

  if (!files.length) {
    console.error(
      `\n  Derive a track map from a recording.\n` +
      `\n    node tools/trackmap.js sessions/<file>.jsonl` +
      `\n    node tools/trackmap.js <file> --json map.json` +
      `\n    node tools/trackmap.js <file> --svg map.svg` +
      `\n    node tools/trackmap.js <file> --bins 720\n`
    );
    process.exit(1);
  }

  const nbins = Number(opts['--bins'] || 360);
  if (!Number.isInteger(nbins) || nbins < 20 || nbins > 20000) {
    throw new Error(`--bins ${opts['--bins']} is not a usable resolution (20..20000)`);
  }
  const jsonOut = opts['--json'];
  const svgOut = opts['--svg'];

  const maps = [];
  for (const file of files) {
    if (!fs.existsSync(file)) { console.error(`  ${file}: no such file`); process.exit(1); }
    const data = await read(file);
    const m = mapOf(file, data, nbins);
    maps.push(m);
    summarise(m);
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(maps.length === 1 ? maps[0] : maps, null, 2) + '\n');
    console.log(`  wrote ${jsonOut}`);
  }
  if (svgOut) {
    if (maps.length > 1) {
      // One picture per track rather than a silently-overwritten file.
      maps.forEach((m, i) => {
        const p = svgOut.replace(/(\.svg)?$/i, `.${i + 1}.svg`);
        fs.writeFileSync(p, svgOf(m));
        console.log(`  wrote ${p}`);
      });
    } else {
      fs.writeFileSync(svgOut, svgOf(maps[0]));
      console.log(`  wrote ${svgOut}`);
    }
  }
}

main().catch((e) => {
  console.error(`\n  ${e.message}\n`);
  process.exit(1);
});
