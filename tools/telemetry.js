#!/usr/bin/env node
'use strict';
// Inspect and repair Wreckfest 2's telemetry config.
//
// READ THIS BEFORE CHANGING ANYTHING HERE.
//
// The game OWNS this file. Its `udp` key is a JSON array, which looks like an invitation to
// add a second target — it is not. This build accepts exactly one entry: given two, the
// game rejects the file on launch and rewrites it from a default with `"enabled": 0`, which
// silently kills telemetry for SimHub as well. That was learned the expensive way, and it
// is why nothing here ever adds to the array.
//
// Editing the fields of the existing single entry does stick — that is how telemetry was
// turned on in the first place.
//
// THIS TOOL DOES NOT POINT THE GAME AT THE RECORDER. The game's one target belongs to SimHub,
// and the recorder takes SimHub's own UDP forward from there (Settings -> Games -> Wreckfest
// 2) — nothing in this file is involved. If an old `--forward` left the target pointed
// elsewhere, `--simhub` or `--revert` puts it back.
//
//   node tools/telemetry.js              # show the current state
//   node tools/telemetry.js --enable     # ensure telemetry is on (repairs enabled:0)
//   node tools/telemetry.js --simhub     # point the single target back at SimHub
//   node tools/telemetry.js --revert     # restore the backup

const fs = require('fs');
const path = require('path');
const os = require('os');

// Where the recorder listens. It is still that — SimHub forwards to it — and seeing it in
// the GAME's config is the specific thing that is now wrong, because it means an old
// --forward pointed the game here and left SimHub with nothing.
const RECORDER_PORT = '23124';
const SIMHUB_PORT = '23123';

function findConfigs() {
  const base = path.join(os.homedir(), 'Documents', 'My Games', 'Wreckfest 2');
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const id of fs.readdirSync(base)) {
    const p = path.join(base, id, 'savegame', 'telemetry', 'config.json');
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

function describe(cfg) {
  const lines = [];
  for (const t of cfg.udp || []) {
    const who =
      String(t.port) === SIMHUB_PORT ? 'SimHub'
      : String(t.port) === RECORDER_PORT ? 'the recorder — left by an old --forward, see below'
      : 'unknown';
    lines.push(`      ${t.enabled ? 'ON ' : 'OFF'}  ${t.ip}:${t.port}   ${who}`);
  }
  if (!lines.length) lines.push('      (no udp targets at all)');
  return lines.join('\n');
}

function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`  ${file} is not valid JSON — leaving it alone (${e.message})`);
    return null;
  }
}

function save(file, cfg) {
  const backup = file + '.bak';
  // Back up once, and never overwrite: a second run must not enshrine an already-modified
  // file as "the original".
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 4) + '\n');
}

function main() {
  const argv = process.argv.slice(2);
  const simhub = argv.includes('--simhub');
  const revert = argv.includes('--revert');
  const enable = argv.includes('--enable');

  if (argv.includes('--forward')) {
    console.error(
      `\n  --forward is gone. It pointed the game at the recorder and had the recorder relay` +
      `\n  onward, which left SimHub receiving telemetry only while the recorder was running.` +
      `\n\n  The recorder now reads SimHub's own UDP forward instead:` +
      `\n    SimHub -> Settings -> Games -> Wreckfest 2, forward UDP to 127.0.0.1:${RECORDER_PORT}` +
      `\n\n  The game's own target should stay on SimHub. --simhub puts it back.\n`
    );
    process.exit(1);
  }

  const files = findConfigs();
  if (!files.length) {
    console.error(
      `No Wreckfest 2 telemetry config found under\n  ${path.join(os.homedir(), 'Documents', 'My Games', 'Wreckfest 2')}`
    );
    process.exit(1);
  }

  for (const file of files) {
    const backup = file + '.bak';
    console.log(`  ${file}`);

    if (revert) {
      if (!fs.existsSync(backup)) { console.log('      no backup beside it — nothing to revert'); continue; }
      fs.copyFileSync(backup, file);
      console.log('      restored from config.json.bak');
      console.log(describe(load(file) || {}));
      continue;
    }

    const cfg = load(file);
    if (!cfg) continue;

    if (!Array.isArray(cfg.udp) || !cfg.udp.length) {
      console.log('      "udp" is missing or empty — run the game once with telemetry on.');
      continue;
    }
    if (cfg.udp.length > 1) {
      console.log(`      WARNING: ${cfg.udp.length} udp targets. This build accepts one and will`);
      console.log('               reset the file (disabling telemetry) on next launch.');
    }

    if (simhub) {
      cfg.udp[0].enabled = 1;
      cfg.udp[0].ip = '127.0.0.1';
      cfg.udp[0].port = SIMHUB_PORT;
      cfg.udp = [cfg.udp[0]]; // one entry, always
      save(file, cfg);
      console.log('      pointed back at SimHub (backup at config.json.bak):');
      console.log(describe(cfg));
      console.log('\n  Restart Wreckfest 2.');
      continue;
    }

    if (enable) {
      if (cfg.udp[0].enabled) {
        console.log('      already enabled:');
      } else {
        cfg.udp[0].enabled = 1;
        save(file, cfg);
        console.log('      re-enabled (backup at config.json.bak):');
      }
      console.log(describe(cfg));
      continue;
    }

    console.log(describe(cfg));
    const target = String(cfg.udp[0].port);
    if (!cfg.udp[0].enabled) {
      console.log('\n  Telemetry is OFF. Nothing will reach SimHub or the recorder.');
      console.log('  Fix:  node tools/telemetry.js --enable   (then restart the game)');
    } else if (target === SIMHUB_PORT) {
      console.log('\n  Correct: the game feeds SimHub, and nothing here needs changing.');
      console.log('  The recorder takes it from there, via SimHub\'s own UDP forward');
      console.log(`  (Settings -> Games -> Wreckfest 2, target 127.0.0.1:${RECORDER_PORT}).`);
    } else if (target === RECORDER_PORT) {
      console.log('\n  This is an old --forward setup: the game is feeding the recorder');
      console.log('  directly, and SimHub is getting nothing. That mode is gone.');
      console.log('  Fix:  node tools/telemetry.js --simhub   (then restart the game)');
    }
  }
}

main();
