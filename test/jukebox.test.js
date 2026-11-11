'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const jukebox = require('../src/jukebox');

const MOCK = path.join(__dirname, '..', 'scripts', 'mock-jukebox.js');
const run = (args = ['--jukebox'], env = {}) => ({ command: process.execPath, args: [MOCK, ...args], cwd: __dirname, env: { ...process.env, MOCK_SONG_MS: '60', ...env } });
const wait = (player, name) => new Promise(resolve => player.on(name, resolve));
const until = (player, done) => new Promise(resolve => {
  if (done(player.state())) return resolve(player.state());
  player.on('state', state => { if (done(state)) resolve(state); });
});

test('the game runs in jukebox mode with the flag added to its command', () => {
  const base = { command: '/game/colosseum', args: ['/disc.iso'], cwd: '/game', env: {} };
  assert.deepEqual(jukebox.command(base).args, ['/disc.iso', '--jukebox']);
  assert.deepEqual(base.args, ['/disc.iso']);
});

test('tracks keep valid, distinct group and song ids and get a name', () => {
  const list = jukebox.normalizeTracks([
    { group: 1, song: 2, name: 'Title' }, { group: 1, song: 2, name: 'Again' }, { group: -1, song: 0 },
    { group: 'x', song: 0 }, { group: 70000, song: 0 }, { group: 3, song: 4 }, null
  ]);
  assert.deepEqual(list, [{ id: '1:2', group: 1, song: 2, name: 'Title' }, { id: '3:4', group: 3, song: 4, name: 'Track 002' }]);
  assert.deepEqual(jukebox.normalizeTracks(undefined), []);
  assert.ok(Array.isArray(jukebox.tracks()));
});

test('the game\'s lines are read as events, and anything else is left alone', () => {
  assert.deepEqual(jukebox.parseEvent('ready'), { type: 'ready' });
  assert.deepEqual(jukebox.parseEvent('playing 4 12\r'), { type: 'playing', group: 4, song: 12 });
  assert.deepEqual(jukebox.parseEvent('error no such song'), { type: 'error', message: 'no such song' });
  assert.equal(jukebox.parseEvent('playing x y'), null);
  assert.equal(jukebox.parseEvent('[audio] opened device'), null);
  assert.equal(jukebox.parseEvent(''), null);
});

test('the volume is a whole number from 0 to 100', () => {
  assert.deepEqual([150, -5, 33.6, 'loud', undefined].map(jukebox.volumeOf), [100, 0, 34, 0, 0]);
});

test('a song plays, pauses, resumes, stops and ends', async () => {
  const player = jukebox.create({ spawn });
  const track = { id: '4:12', group: 4, song: 12 };
  assert.equal((await player.start(run())).ready, true);
  player.play(track);
  assert.equal((await until(player, state => state.playing === '4:12')).paused, false);
  player.pause();
  assert.equal((await until(player, state => state.paused)).playing, '4:12');
  player.resume();
  await until(player, state => !state.paused);
  player.stop();
  assert.equal((await until(player, state => state.playing === null)).paused, false);
  const ended = wait(player, 'ended');
  player.play(track);
  assert.equal(await ended, '4:12');
  player.setVolume(250);
  assert.equal(player.state().volume, 100);
  player.quit();
  await until(player, state => !state.running);
});

test('starting twice at once starts the game once', async () => {
  const player = jukebox.create({ spawn });
  const [first, second] = await Promise.all([player.start(run()), player.start(run())]);
  assert.equal(first, second);
  player.quit();
  await until(player, state => !state.running);
});

test('a game that closes before it is ready is reported, and can be started again', async () => {
  const player = jukebox.create({ spawn });
  await assert.rejects(player.start(run([])), /closed before its music started/);
  assert.equal(player.state().running, false);
  assert.throws(() => player.play({ group: 1, song: 1 }), /not ready/);
  assert.equal((await player.start(run())).ready, true);
  player.quit();
  await until(player, state => !state.running);
});

test('a game that never says ready is ended after the timeout', async () => {
  const player = jukebox.create({ spawn, readyTimeout: 100 });
  const silent = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: __dirname, env: process.env };
  await assert.rejects(player.start(silent), /did not start its music/);
  await until(player, state => !state.running);
});

test('a game that cannot be started is reported', async () => {
  const player = jukebox.create({ spawn });
  await assert.rejects(player.start({ command: path.join(__dirname, 'no-such-game'), args: [], cwd: __dirname, env: process.env }), /ENOENT/);
  assert.equal(player.state().running, false);
});
