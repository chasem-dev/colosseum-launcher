'use strict';
// The Jukebox: the launcher asks the game itself to play a song, so the music is the game's own, from the
// player's disc. The game is started in a window-less jukebox mode (FLAG) and takes one command per line on
// stdin; it answers with one event per line on stdout. Nothing here plays sound or reads the disc.
//
//   launcher -> game:  play <group> <song> | pause | resume | stop | volume <0-100> | quit
//   game -> launcher:  ready | playing <group> <song> | paused | resumed | stopped | ended | error <message>
const { EventEmitter } = require('node:events');
const readline = require('node:readline');
const tracksFile = require('./jukebox-tracks.json');

const FLAG = '--jukebox';
const READY_TIMEOUT = 20000;  // ms the game gets to start its sound before the launcher gives up on it

// The game's run command (port.gameRunCommand), started in jukebox mode.
function command(run) { return { ...run, args: [...run.args, FLAG] }; }

// What the tracks file lists: a song is a MusyX group and song id (the game's sndSeqPlayEx), with a name to show.
function normalizeTracks(list) {
  const seen = new Set(), tracks = [];
  for (const each of Array.isArray(list) ? list : []) {
    const group = Number(each?.group), song = Number(each?.song);
    if (!Number.isInteger(group) || !Number.isInteger(song) || group < 0 || song < 0 || group > 0xFFFF || song > 0xFFFF) continue;
    const id = `${group}:${song}`;
    if (seen.has(id)) continue;
    seen.add(id);
    tracks.push({ id, group, song, name: String(each.name || `Track ${String(tracks.length + 1).padStart(3, '0')}`) });
  }
  return tracks;
}
const tracks = (file = tracksFile) => normalizeTracks(file.tracks);
// Three silent songs for developing the page without a game (scripts/mock-jukebox.js).
const mockTracks = () => normalizeTracks([1, 2, 3].map(song => ({ group: 0, song, name: `Mock track ${song}` })));

// One line from the game, as an event; null for a line that isn't one (the game's own logging).
function parseEvent(line) {
  const [name, ...rest] = String(line).trim().split(/\s+/);
  switch (name) {
    case 'ready': case 'paused': case 'resumed': case 'stopped': case 'ended': return { type: name };
    case 'playing': {
      const [group, song] = rest.map(Number);
      return Number.isInteger(group) && Number.isInteger(song) ? { type: name, group, song } : null;
    }
    case 'error': return { type: name, message: rest.join(' ') || 'The game stopped the music.' };
    default: return null;
  }
}

const volumeOf = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

function create({ spawn, readyTimeout = READY_TIMEOUT } = {}) {
  const events = new EventEmitter();
  let child = null, starting = null;
  let state = { running: false, ready: false, playing: null, paused: false, volume: 100, error: null };

  function update(change) {
    state = { ...state, ...change };
    events.emit('state', state);
  }
  function send(line) {
    if (!child || !child.stdin || !child.stdin.writable) throw new Error('The jukebox is not running.');
    child.stdin.write(`${line}\n`);
  }

  function handle(event) {
    switch (event.type) {
      case 'ready': return update({ ready: true, error: null });
      case 'playing': return update({ playing: `${event.group}:${event.song}`, paused: false, error: null });
      case 'paused': return update({ paused: true });
      case 'resumed': return update({ paused: false });
      case 'stopped': return update({ playing: null, paused: false });
      case 'ended': events.emit('ended', state.playing); return update({ playing: null, paused: false });
      case 'error': return update({ error: event.message });
    }
  }

  // Starts the game in jukebox mode: resolves once it says it is ready.
  function start(run) {
    if (starting) return starting;
    if (child) return Promise.resolve(state);
    starting = new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        starting = null;
        if (error) reject(error); else resolve(state);
      };
      const process = spawn(run.command, run.args, { cwd: run.cwd, env: run.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child = process;
      update({ running: true, ready: false, playing: null, paused: false, error: null });
      const timer = setTimeout(() => { quit(); finish(new Error('The game did not start its music. Update the game, then try again.')); }, readyTimeout);
      readline.createInterface({ input: process.stdout }).on('line', line => {
        const event = parseEvent(line);
        if (!event) return;
        handle(event);
        if (event.type === 'ready') finish();
      });
      process.stderr?.on('data', () => {});
      process.stdin?.on('error', () => {});
      process.on('error', error => { child = null; update({ running: false, ready: false, playing: null, paused: false, error: error.message }); finish(error); });
      process.on('exit', () => {
        if (child === process) child = null;
        update({ running: false, ready: false, playing: null, paused: false });
        finish(new Error('The game closed before its music started. It may be too old for the Jukebox: update the game, then try again.'));
      });
    });
    return starting;
  }

  function play(track) {
    if (!state.ready) throw new Error('The jukebox is not ready.');
    send(`play ${track.group} ${track.song}`);
    update({ playing: track.id, paused: false });
  }
  function pause() { send('pause'); }
  function resume() { send('resume'); }
  function stop() { send('stop'); }
  function setVolume(value) {
    const volume = volumeOf(value);
    send(`volume ${volume}`);
    update({ volume });
  }
  // Asks the game to close, and ends it if it doesn't.
  function quit() {
    const process = child;
    if (!process) return;
    try { send('quit'); } catch (_) { /* already closing */ }
    setTimeout(() => { if (child === process) process.kill(); }, 1500).unref();
  }

  return { start, play, pause, resume, stop, setVolume, quit, state: () => state, on: (name, listener) => events.on(name, listener) };
}

module.exports = { FLAG, command, normalizeTracks, tracks, mockTracks, parseEvent, volumeOf, create };
