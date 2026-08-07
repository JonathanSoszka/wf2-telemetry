'use strict';
// Reading SimHub's own record of where it forwards Wreckfest 2 telemetry.
//
// This exists because the one thing the capture path depends on lives in another program's
// settings rather than in this one's. A machine where the forward was never configured
// otherwise looks exactly like a machine where nobody has started a race yet: a recorder
// sitting quietly on a port nothing sends to.
//
// THIS IS A DIAGNOSIS, NOT A PRECONDITION, AND THE DIFFERENCE IS NOT ACADEMIC. SimHub holds
// its configuration in memory and writes GameSettings.json when it exits, so the file lags
// the running program by an entire session. Called at startup, this reported "no port is
// set" on a machine that was at that moment receiving forwarded packets perfectly well —
// the forward had been switched on in the UI and never yet flushed to disk.
//
// So record.js calls this only after a silence long enough to be a real problem, where
// there is no live behaviour left for a stale file to contradict. Do not move it earlier.
//
// THE POLARITY IS THE REST OF THE DESIGN. This reports a problem only when it can
// POSITIVELY establish one — settings found, parsed, and saying in so many words that the
// forward is off, unset, or pointed somewhere else. Everything unrecognised (SimHub
// installed somewhere these paths do not cover, a settings format that has moved on, an
// extra redirect list that may well already cover us) returns "cannot tell" and says
// nothing. A confident wrong warning sends someone to change a setting that was working.

const fs = require('fs');
const path = require('path');

// Where SimHub installs by default. SIMHUB_DIR covers everyone else rather than this list
// trying to be exhaustive — a wrong guess costs nothing, because not finding the file is
// already a supported outcome.
const INSTALL_DIRS = [
  'C:\\Program Files (x86)\\SimHub',
  'C:\\Program Files\\SimHub',
];

/** SimHub's per-game settings file, or null if it is not where this knows to look. */
function settingsFile() {
  if (process.platform !== 'win32') return null; // SimHub is Windows-only
  const dirs = (process.env.SIMHUB_DIR ? [process.env.SIMHUB_DIR] : []).concat(INSTALL_DIRS);
  for (const dir of dirs) {
    const f = path.join(dir, 'PluginsData', 'GameSettings.json');
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch (e) {
      /* not there — try the next */
    }
  }
  return null;
}

const isLoopback = (ip) => !ip || ip === '127.0.0.1' || ip === 'localhost' || ip === '0.0.0.0';

/**
 * Is SimHub forwarding Wreckfest 2 telemetry to `port` on this machine?
 *
 *   { known: false }                     -> no opinion; say nothing
 *   { known: true, ok: true,  file }     -> pointed here
 *   { known: true, ok: false, file, why }-> positively pointed elsewhere, or off
 */
function forwardStatus(port, opts) {
  const file = (opts && opts.file) || settingsFile();
  if (!file) return { known: false };

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { known: false };
  }

  const g = cfg && cfg.Wreckfest2;
  if (!g || typeof g !== 'object') return { known: false };

  // SimHub's own spelling, typo and all. A non-empty list here is a second way to be
  // pointed at us that this does not attempt to parse, so its presence means "cannot tell"
  // rather than "not configured".
  const extra = g.AddictionnalUDPRedirects;
  if (Array.isArray(extra) && extra.length) return { known: false };

  const want = Number(port);
  const target = g.UDPForwardPort === null || g.UDPForwardPort === undefined
    ? null
    : Number(g.UDPForwardPort);

  if (g.UDPForwardActive !== true) {
    return { known: true, ok: false, file, why: `SimHub's UDP forward for Wreckfest 2 is switched off.` };
  }
  if (target === null || !Number.isFinite(target)) {
    return { known: true, ok: false, file, why: `SimHub's UDP forward for Wreckfest 2 is on, but no port is set.` };
  }
  if (target !== want) {
    return { known: true, ok: false, file, why: `SimHub forwards Wreckfest 2 to port ${target}, not ${want}.` };
  }
  if (!isLoopback(g.UDPForwardIpAddress)) {
    return {
      known: true,
      ok: false,
      file,
      why: `SimHub forwards Wreckfest 2 to ${g.UDPForwardIpAddress}:${target} — another machine, not this one.`,
    };
  }
  return { known: true, ok: true, file };
}

module.exports = { forwardStatus };
