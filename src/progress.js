'use strict';

const { StringDecoder } = require('node:string_decoder');

function cleanOutputLine(line) {
  return String(line).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

// Pipe output can split a UTF-8 character, a progress line, or a CRLF across
// chunks. Each stream gets its own reader, including its final unterminated line.
function createLineReader(onLine) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  function consume(text) {
    const parts = (pending + text).split(/[\r\n]/);
    pending = parts.pop();
    for (const part of parts) if (part) onLine(cleanOutputLine(part));
  }
  return {
    write(bytes) { consume(decoder.write(bytes)); },
    end() { consume(decoder.end()); if (pending) onLine(cleanOutputLine(pending)); pending = ''; }
  };
}

function buildDetail(output) {
  return /^(?:Linking|Generating .*syms|Renaming)/i.test(output) ? 'Finishing the game build' : 'Building your game';
}

function activityFromLine(line) {
  const value = cleanOutputLine(line).trim();
  if (!value) return null;
  const output = value.replace(/^\[\s*(?:\d{1,3}%|\d+\s*\/\s*\d+)\]\s*/, '');
  // These run after compilation. Their command may print 100% before copying
  // the disc, so keep this separate phase indeterminate until the process exits.
  if (value === 'mirror: reused') return { detail: "Reusing the game's prepared source", percent: null };
  if (/^game objs \d+/.test(value) || /^linked /.test(value) || /^ninja: no work to do\./.test(value))
    return { detail: 'Finishing setup', percent: null };
  if (value === "Preparing the decomp's build") return { detail: "Preparing the game's source", percent: null };
  const ninja = value.match(/^\[\s*(\d+)\s*\/\s*(\d+)\]\s*(.*)/);
  if (ninja) {
    const completed = Number(ninja[1]), total = Number(ninja[2]);
    if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total <= 0 || completed > total) return null;
    return { detail: `${buildDetail(ninja[3])} · ${completed.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} steps`,
      percent: Math.floor(completed * 100 / total) };
  }
  const build = value.match(/^\[\s*(\d{1,3})%\]\s*(.*)/);
  if (build) return { detail: buildDetail(build[2]), percent: Math.min(100, Number(build[1])) };
  const git = value.match(/^(Receiving objects|Resolving deltas|Updating files|Compressing objects):\s*(\d{1,3})%/);
  if (git) return { detail: git[1] === 'Receiving objects' ? 'Downloading files' : 'Preparing downloaded files', percent: Math.min(100, Number(git[2])) };
  const textureDownload = value.match(/^Texture download: (\d+)\/(\d+) bytes$/);
  if (textureDownload) {
    const received = Number(textureDownload[1]), total = Number(textureDownload[2]);
    if (!Number.isSafeInteger(received) || !Number.isSafeInteger(total) || (total && received > total)) return null;
    const mb = bytes => `${(bytes / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`;
    return { detail: `Downloading HD textures · ${mb(received)}${total ? ` of ${mb(total)}` : ' downloaded'}`,
      percent: total ? Math.floor(received / total * 100) : null };
  }
  if (value === 'Checking HD texture download')
    return { detail: 'Checking HD textures', percent: null };
  if (value === 'Checking the HD textures') return { detail: 'Checking HD textures', percent: null };
  const installing = value.match(/^Installing HD textures: (\d+)\/(\d+)$/);
  if (installing) {
    const done = Number(installing[1]), total = Number(installing[2]);
    if (!total || done > total) return null;
    return { detail: `Installing HD textures · ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`, percent: Math.floor(done * 100 / total) };
  }
  if (/^Installed \d+ textures/.test(value))
    return { detail: 'HD textures installed', percent: 100 };
  // Battle Revolution assets: models, icons and cries (the game's tools/pbr2pkx/make_models.py)
  if (/^Downloading the model tools/.test(value)) return { detail: 'Downloading the model tools', percent: null };
  if (/^Preparing the model tools/.test(value)) return { detail: 'Preparing the model tools', percent: null };
  if (value === 'Reading your Battle Revolution disc') return { detail: 'Reading your Battle Revolution disc', percent: null };
  if (/^Making models for \d+ Pokémon$/.test(value)) return { detail: 'Making Battle Revolution assets', percent: 0 };
  const pbr = value.match(/^Made (\d+) of (\d+) Pokémon$/);
  if (pbr) {
    const done = Number(pbr[1]), total = Number(pbr[2]);
    if (!total || done > total) return null;
    return { detail: `Making Battle Revolution assets · ${done} of ${total} Pokémon`, percent: Math.floor(done * 100 / total) };
  }
  if (/^-- (?:Configuring|Generating)/.test(value))
    return { detail: 'Getting your game ready', percent: null };
  if (/^Cloning into /.test(value))
    return { detail: 'Downloading setup files', percent: null };
  if (/^(?:Applying|Patching|Writing|Bundling) /.test(value))
    return { detail: 'Preparing game files', percent: null };
  return null;
}

// The port's build runs ninja three times (the game, the game again once every function's arguments are known,
// the renderer), each counting from one. Each gets its part of one bar, which only moves forward.
const BUILD_STAGES = [[0, 60], [60, 90], [90, 100]];

function createActivityReader() {
  let stage = 0, last = 0, bar = 0;
  return function read(line) {
    const activity = activityFromLine(line);
    const steps = cleanOutputLine(line).trim().match(/^\[\s*(\d+)\s*\/\s*\d+\]/);
    if (!activity || !steps || !Number.isFinite(activity.percent)) return activity;
    const completed = Number(steps[1]);
    if (completed < last && stage < BUILD_STAGES.length - 1) stage += 1;
    last = completed;
    const [from, to] = BUILD_STAGES[stage];
    bar = Math.max(bar, Math.floor(from + (to - from) * activity.percent / 100));
    return { detail: activity.detail.replace(/ · [\d,]+ of [\d,]+ steps$/, ''), percent: bar };
  };
}

// A task that did not exit by itself. Its last output is then whatever it
// printed before, not the reason. Linux: killed by the signal (the game's crash
// handler re-raises it). macOS: the game's handler exits with the shell's
// 128 + signal instead (platform/port_runtime.cpp: a re-raised signal hangs
// under Rosetta). Windows: an exception status, or a native program's crash as
// MSYS bash reports it (the signal in the second byte: 2816 for SIGSEGV).
const CRASH_SIGNALS = { SIGSEGV: 'a memory access error', SIGBUS: 'a memory access error', SIGILL: 'an illegal instruction',
  SIGFPE: 'a math error', SIGABRT: 'an internal error' };
// Signal numbers as macOS and MSYS (Cygwin) number them, and as Linux does.
const BSD_SIGNALS = { 4: 'SIGILL', 6: 'SIGABRT', 8: 'SIGFPE', 10: 'SIGBUS', 11: 'SIGSEGV' };
const LINUX_SIGNALS = { 4: 'SIGILL', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 11: 'SIGSEGV' };
const WINDOWS_STATUSES = { 0xC0000005: 'SIGSEGV', 0xC00000FD: 'SIGSEGV', 0xC000001D: 'SIGILL', 0xC0000094: 'SIGFPE',
  0xC0000409: 'SIGABRT' };

function crashReason(code, signal, platform = process.platform) {
  let name = signal;
  if (!name && Number.isInteger(code))
    name = platform === 'win32' ? BSD_SIGNALS[code / 256] || WINDOWS_STATUSES[code >>> 0]
      : (platform === 'darwin' ? BSD_SIGNALS : LINUX_SIGNALS)[code - 128];
  return CRASH_SIGNALS[name] ? `crashed with ${CRASH_SIGNALS[name]}` : null;
}

// The line that best explains a failed task, from its last lines of output.
function failureReason(lines) {
  const recent = lines.map(line => cleanOutputLine(line).trim()).filter(Boolean);
  const cmake = recent.findLastIndex(line => /^CMake Error\b/.test(line));
  const detail = [];
  if (cmake >= 0) for (const line of recent.slice(cmake + 1)) {
    if (/^(?:Call Stack|CMake |-- )/.test(line)) break;
    detail.push(line);
  }
  const noise = line => /^(?:ninja: build stopped|make(?:\[\d+\])?: \*\*\*|-- Configuring incomplete|\d+ errors? generated|compilation terminated)/.test(line);
  const explains = line => /\berror\b|fatal|FAILED|failed|missing|not found|No such file|cannot|could not/i.test(line);
  // ninja prints FAILED: and the target, then the command, then what the command
  // printed. That output says why it failed; the FAILED line only names the target.
  const failed = recent.findLastIndex(line => /^FAILED: /.test(line));
  const after = failed >= 0 ? recent.slice(failed + 1).filter(line => !noise(line)) : [];
  const printed = after.length > 1 ? after.slice(1) : after.filter(explains);
  const reason = detail.join(' ') || printed.findLast(explains) || printed.at(-1) ||
    recent.findLast(line => !noise(line) && explains(line)) || recent.at(-1) || '';
  return reason.slice(0, 400).replace(/[.\s]+$/, '');
}

module.exports = { activityFromLine, cleanOutputLine, crashReason, createActivityReader, createLineReader, failureReason };
