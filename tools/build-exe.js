#!/usr/bin/env node
'use strict';
// Build the release executables — self-contained .exe files that need no Node install.
//
// WHY AN EXE AT ALL
//
// The npm package assumes Node. The people who record sessions are running a game, and
// asking them to install a runtime first is asking most of them to stop. A release binary
// is the same code with that step removed; the package stays the way anything that
// consumes this as a library wants it.
//
// HOW: NODE'S OWN SINGLE EXECUTABLE APPLICATION
//
// Node can inject a script into a copy of itself (`--experimental-sea-config`, then
// postject writes the blob into a spare PE section). No packer, no third-party runtime —
// the exe IS the node.exe that built it, so what runs in the release is what ran in
// `npm test`. The cost is size: ~110 MB, because a whole runtime is in there. That is the
// honest price and there is no compressing it away.
//
// SEA takes ONE script. It has no module resolver and no files beside it, so `require`
// of a sibling would fail at runtime rather than at build time. Everything is bundled to
// a single file first — which also inlines lib/layout.json, so the packet layout travels
// inside the binary instead of being a loose file the exe would go looking for.
//
//   node tools/build-exe.js              # build every target into dist/
//   node tools/build-exe.js wf2-record   # just the one
//   node tools/build-exe.js --strict     # fail if the signature cannot be stripped
//
// Builds for the platform and architecture it runs on. Cross-building is not possible
// this way: the base is the local node.exe. A Linux or macOS release means running this
// on that platform (or in CI on that runner).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');   // intermediates — bundles and blobs
const DIST = path.join(ROOT, 'dist');     // the executables themselves

const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';

// The two things a person with no Node needs. The recorder is the point; the config tool
// ships with it because the failure it diagnoses — telemetry switched off in the game, or
// its one UDP target pointed somewhere stale — is the failure that makes the recorder sit
// there receiving nothing, and `node tools/telemetry.js` is not an option for this
// audience either.
const TARGETS = [
  { name: 'wf2-record', entry: path.join(ROOT, 'record.js') },
  { name: 'wf2-telemetry-config', entry: path.join(ROOT, 'tools', 'telemetry.js') },
];

function log(s) { console.log(s); }

/**
 * Bundle one entry point and everything it requires into a single CommonJS file.
 *
 * `platform: 'node'` keeps the built-in modules external — fs, dgram and the rest are
 * inside the runtime already and must not be bundled. The target is pinned to the Node
 * that is doing the building, since that same binary is about to become the exe: there is
 * no older runtime to downlevel for.
 */
function bundle(target) {
  const outfile = path.join(BUILD, `${target.name}.bundle.js`);
  esbuild.buildSync({
    entryPoints: [target.entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${process.versions.node.split('.')[0]}`,
    // Not minified on purpose. It saves a rounding error against a 110 MB runtime, and a
    // stack trace out of a release build stays readable.
    minify: false,
  });
  return outfile;
}

/**
 * Turn a bundle into the blob that gets injected.
 *
 * The code cache is built here rather than at every startup. It is tied to this exact V8
 * version and architecture, which is fine — nothing else will ever load this blob.
 */
function blob(target, bundlePath) {
  const configPath = path.join(BUILD, `${target.name}.sea-config.json`);
  const blobPath = path.join(BUILD, `${target.name}.blob`);
  fs.writeFileSync(configPath, JSON.stringify({
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  }, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' });
  return blobPath;
}

/**
 * Find signtool.exe.
 *
 * It ships with the Windows SDK and is almost never on PATH — it lives under a versioned
 * directory that nothing adds for you. Looked up rather than required, because the build
 * has to work on a machine without the SDK at all.
 */
function findSigntool() {
  try {
    execFileSync('signtool', ['/?'], { stdio: 'pipe' });
    return 'signtool';
  } catch { /* not on PATH, which is the normal case */ }

  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
  for (const root of roots) {
    const bin = path.join(root, 'Windows Kits', '10', 'bin');
    if (!fs.existsSync(bin)) continue;
    // Newest SDK first — the older ones work too, this just avoids surprises.
    const versions = fs.readdirSync(bin).filter((d) => /^10\./.test(d)).sort().reverse();
    for (const v of versions) {
      const candidate = path.join(bin, v, process.arch === 'arm64' ? 'arm64' : 'x64', 'signtool.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Copy the running node.exe and write the blob into it.
 *
 * The copy is stripped of its Authenticode signature first. Injecting into a signed binary
 * leaves a signature that no longer matches its contents, and Windows treats a broken
 * signature worse than an absent one — postject says as much on the way past ("the
 * signature seems corrupted"), and some machines refuse to launch the result outright.
 * Without the SDK the build still succeeds and the exe still runs on a normal desktop, but
 * a release should not be cut that way — which is what `--strict` is for. A local build
 * warns and carries on; the release workflow passes `--strict` and stops, because a warning
 * in a thousand lines of CI log is a warning nobody reads.
 */
function inject(target, blobPath, strict) {
  const exePath = path.join(DIST, target.name + EXE);
  fs.copyFileSync(process.execPath, exePath);
  if (!WIN) fs.chmodSync(exePath, 0o755);

  if (WIN) {
    const signtool = findSigntool();
    let problem = null;
    if (!signtool) {
      problem = 'signtool not found — install the Windows SDK';
    } else {
      try {
        execFileSync(signtool, ['remove', '/s', exePath], { stdio: 'pipe' });
        log(`  signature removed`);
      } catch (e) {
        problem = `signtool failed: ${String(e.message).trim().split('\n')[0]}`;
      }
    }
    if (problem) {
      if (strict) {
        console.error(`\n${target.name}: ${problem}`);
        console.error('The exe would ship carrying a signature that no longer matches its');
        console.error('contents, which Windows treats worse than an unsigned binary.');
        process.exit(1);
      }
      log(`  ${problem} — shipping this exe would leave a broken signature on it`);
    }
  }

  // postject is a library first and a CLI second, and its bin resolves differently across
  // installs. Going through its own entry point with the package's node avoids depending
  // on npx being able to reach the network mid-build.
  const postject = require.resolve('postject/dist/cli.js');
  execFileSync(process.execPath, [
    postject, exePath, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ], { stdio: 'inherit' });

  return exePath;
}

function main() {
  // The package runs on Node 18; building a SEA does not. `--experimental-sea-config`
  // arrived in 20, and this is a build-time requirement only — it says nothing about what
  // the exe or the published package need.
  if (Number(process.versions.node.split('.')[0]) < 20) {
    console.error(`Building needs Node 20 or newer for SEA support; this is ${process.version}.`);
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const only = argv.filter((a) => !a.startsWith('--'));
  const targets = only.length ? TARGETS.filter((t) => only.includes(t.name)) : TARGETS;
  if (!targets.length) {
    console.error(`No such target. Known: ${TARGETS.map((t) => t.name).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  for (const t of targets) {
    log(`${t.name}:`);
    const b = bundle(t);
    log(`  bundled  ${(fs.statSync(b).size / 1024).toFixed(0)} KB`);
    const blobPath = blob(t, b);
    const exePath = inject(t, blobPath, strict);
    log(`  ${path.relative(ROOT, exePath)}  ${(fs.statSync(exePath).size / 1024 / 1024).toFixed(0)} MB`);
  }

  log(`\nBuilt with Node ${process.version} for ${process.platform}-${process.arch}.`);
}

main();
