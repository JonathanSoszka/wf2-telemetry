#!/usr/bin/env node
'use strict';
// Inspect and repair Wreckfest 2's telemetry config.
//
// READ THIS BEFORE CHANGING ANYTHING HERE.
//
// The game OWNS this file. Its `udp` key is a JSON array, which looks like an invitation to
// add a second target — it is not. This build accepts exactly one entry: given two, the
// game rejects the file on launch and rewrites it from a default with
// `"enabled": 0`, which silently kills telemetry for SimHub as well. That was learned the
// expensive way, and it is why `--forward` REPLACES the single entry rather than adding to
// it, and why the recorder's default source is SimHub's API and needs none of this.
//
// Editing the fields of the existing single entry does stick — that is how telemetry was
// turned on in the first place.
//
// `--forward` is now the LAST resort, not the first. If SimHub is running at all, its own
// UDP forwarding (Settings -> Games -> Wreckfest 2) sends the same datagrams to the
// recorder without touching this file and without SimHub depending on the recorder —
// `node record.js --source simhub-udp`. Reach for `--forward` only when SimHub is not in
// the picture.
//
//   node tools/telemetry.js              # show the current state
//   node tools/telemetry.js --enable     # ensure telemetry is on (repairs enabled:0)
//   node tools/telemetry.js --forward    # send to the recorder, which relays onward
//   node tools/telemetry.js --revert     # restore the backup

const fs = require('fs');
const path = require('path');
const os = require('os');

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
      String(t.port) === RECORDER_PORT ? 'this recorder, which relays to SimHub'
      : String(t.port) === SIMHUB_PORT ? 'SimHub'
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
  const forward = argv.includes('--forward');
  const revert = argv.includes('--revert');
  const enable = argv.includes('--enable');

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

    if (forward) {
      cfg.udp[0].enabled = 1;
      cfg.udp[0].ip = '127.0.0.1';
      cfg.udp[0].port = RECORDER_PORT;
      cfg.udp = [cfg.udp[0]]; // one entry, always
      save(file, cfg);
      console.log('      set to forward mode (backup at config.json.bak):');
      console.log(describe(cfg));
      console.log('\n  Restart Wreckfest 2. From now on SimHub only receives telemetry while');
      console.log('  `node record.js --source udp` is running. Undo with --revert.');
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
      console.log('\n  Normal setup: the game feeds SimHub, and `node record.js` reads');
      console.log('  SimHub over its API. No change to this file is needed.');
      console.log('\n  If the API view is ever unusable, prefer SimHub\'s own UDP forward');
      console.log(`  (Settings -> Games -> Wreckfest 2, target 127.0.0.1:${RECORDER_PORT}) with`);
      console.log('  `node record.js --source simhub-udp`. That also needs nothing here, and');
      console.log('  leaves SimHub\'s feed independent of the recorder. --forward does not.');
    } else if (target === RECORDER_PORT) {
      console.log('\n  Forward mode: the game feeds the recorder, which relays to SimHub.');
      console.log('  SimHub gets telemetry only while `record.js --source udp` is running.');
    }
  }
}

main();
