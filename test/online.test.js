'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const online = require('../src/online');

test('room codes read forgivingly and print with a dash', () => {
  assert.equal(online.parseRoomCode('kq7-m2d'), 'KQ7M2D');
  assert.equal(online.parseRoomCode(' KQ7 M2D '), 'KQ7M2D');
  assert.equal(online.parseRoomCode('OI1234'), '011234');
  assert.equal(online.parseRoomCode('nope'), null);
  assert.equal(online.formatRoomCode('KQ7M2D'), 'KQ7-M2D');
});

test('a build id fits what the room keeps, and tells builds apart', () => {
  const commit = 'a'.repeat(40), decomp = 'b'.repeat(40);
  assert.ok(online.buildId({ commit, decomp }).length <= 64);
  assert.equal(online.buildId({ commit, decomp }), online.buildId({ commit, decomp }));
  assert.notEqual(online.buildId({ commit, decomp }), online.buildId({ commit: `c${commit.slice(1)}`, decomp }));
  assert.notEqual(online.buildId({ commit, decomp }), online.buildId({ commit, decomp: `c${decomp.slice(1)}` }));
});

test('the game is told what to set up, and who is in the battle', () => {
  assert.equal(online.configLine({ side: 1, rules: { level: 100, size: 3, stage: 2 } }), 'config 1 100 3 2');
  assert.equal(online.configLine({ side: 0, rules: { level: 50, size: 6 }, code: 'KQ7M2D' }), 'config 0 50 6 0 KQ7-M2D');
  assert.deepEqual(online.startLines({ seed: 7, players: [{ name: 'Ash K', party: [1, 2, 3, 4, 5, 6] }, { name: 'Misty', party: [7, 8, 9, 10, 11, 12] }] }),
    ['start 7 Ash_K Misty 1 2 3 4 5 6 7 8 9 10 11 12']);
});

test('a Story party\'s Pokemon reach the game before the start, and a short party is filled with 0', () => {
  const umbreon = [197, 925108171, 2923127179, 4, 0, 0, 220, 44, 0, 290, 0, 269, 0, 289, 0, 23, 17, 30, 19, 2, 17, 0, 0, 0, 0, 0, 0, '0055004d004200520045004f004e'];
  const espeon = [196, 3998980838, 2923127179, 4, 0, 0, 220, 93, 0, 216, 0, 115, 0, 270, 0, 20, 17, 26, 27, 23, 23, 0, 0, 0, 0, 0, 0, '-'];
  const lines = online.startLines({ seed: 9, players: [{ name: 'Ash', party: [1, 2, 3, 4, 5, 6] },
    { name: 'Wes', party: [197, 196, 250], members: [umbreon, espeon, [250, ...umbreon.slice(1)]] }] });
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'member 1 0 197 925108171 2923127179 4 0 0 220 44 0 290 0 269 0 289 0 23 17 30 19 2 17 0 0 0 0 0 0 0055004d004200520045004f004e');
  assert.match(lines[1], /^member 1 1 196 .* -$/);
  assert.equal(lines[3], 'start 9 Ash Wes 1 2 3 4 5 6 197 196 250 0 0 0');
});

// A room's WebSocket, as a session uses it.
class FakeSocket extends EventTarget {
  static last = null;
  constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; FakeSocket.last = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(text) { this.sent.push(text); }
  close(code) { this.readyState = 3; this.closedWith = code; }
  receive(value) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(value) })); }
  drop(code = 1006) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code })); }
  messages() { return this.sent.filter(text => text !== 'ping').map(text => JSON.parse(text)); }
}

const START = { type: 'start', key: 'k'.repeat(32), side: 0, seed: 42, rules: { level: 50, size: 6, stage: 1 },
  players: [{ name: 'Ash', party: [1, 2, 3, 4, 5, 6] }, { name: 'Misty', party: [7, 8, 9, 10, 11, 12] }] };
const details = { name: 'Ash', build: 'b', version: 'v', launcher: 'l', party: [1, 2, 3, 4, 5, 6] };

function fakeBridge() {
  const bridge = { lines: [], send: line => bridge.lines.push(line), listen: async () => 5555, close: () => { bridge.closed = true; } };
  return options => Object.assign(bridge, options);
}

async function hosted(session) {
  const opened = session.host({ ...details, rules: { level: 50, size: 6 }, listed: true });
  await new Promise(resolve => setImmediate(resolve));
  FakeSocket.last.receive({ type: 'room', code: 'KQ7M2D', key: 'k'.repeat(32) });
  await opened;
  return FakeSocket.last;
}

test('a host opens a room, and its game hears of the opponent once it is waiting', async () => {
  const session = new online.Session({ url: 'http://rooms.test', WebSocket: FakeSocket });
  const ws = await hosted(session);
  assert.equal(ws.url, 'ws://rooms.test/v1/rooms/new');
  const hello = ws.messages()[0];
  assert.equal(hello.type, 'hello');
  assert.deepEqual(hello.party, details.party);
  assert.equal(hello.protocol, online.PROTOCOL);
  assert.ok(hello.rules.stage >= 0 && hello.rules.stage < online.STAGES);
  const make = fakeBridge();
  await session.attachGame(make);
  const bridge = make({});
  assert.match(bridge.lines[0], /^config 0 50 6 \d KQ7-M2D$/);
  ws.receive(START);
  assert.equal(bridge.lines[1], 'start 42 Ash Misty 1 2 3 4 5 6 7 8 9 10 11 12');
  session.close();
});

test('a game waiting in the stadium starts again for the battle, which ends nothing', async () => {
  const session = new online.Session({ url: 'http://rooms.test', WebSocket: FakeSocket });
  const ws = await hosted(session);
  const make = fakeBridge();
  await session.attachGame(make);
  const bridge = make({});
  ws.receive(START);
  let ended = false;
  session.on('end', () => { ended = true; });
  bridge.onLine('restart');
  bridge.onClose();
  assert.equal(ended, false);
  assert.deepEqual(bridge.lines.slice(-2), ['config 0 50 6 1', 'start 42 Ash Misty 1 2 3 4 5 6 7 8 9 10 11 12']);
  assert.equal(session.takeRestart(), true);
  assert.equal(session.takeRestart(), false);
  bridge.onClose();
  assert.equal(ended, true);
  session.close();
});

test('a refused joiner hears why', async () => {
  const session = new online.Session({ url: 'http://rooms.test', WebSocket: FakeSocket });
  const joined = session.join({ ...details, code: 'KQ7M2D' });
  await new Promise(resolve => setImmediate(resolve));
  FakeSocket.last.receive({ type: 'refused', reason: 'version' });
  await assert.rejects(joined, /another version/);
  session.close();
});

test('turns are numbered, delivered once and in order', async () => {
  const session = new online.Session({ url: 'http://rooms.test', WebSocket: FakeSocket });
  const ws = await hosted(session);
  const make = fakeBridge();
  await session.attachGame(make);
  const bridge = make({});
  ws.receive(START);
  bridge.onLine('act 0 1 2 0');
  assert.deepEqual(ws.messages().at(-1), { type: 'game', seq: 1, line: 'act 0 1 2 0' });
  ws.receive({ type: 'game', seq: 1, line: 'act 0 1 2 1' });
  ws.receive({ type: 'game', seq: 1, line: 'act 0 1 2 1' });
  ws.receive({ type: 'game', seq: 3, line: 'too soon' });
  assert.equal(bridge.lines.filter(line => line.startsWith('act')).length, 1);
  session.close();
});

test('whoever comes back after a drop gets what it missed', async () => {
  const session = new online.Session({ url: 'http://rooms.test', WebSocket: FakeSocket });
  const ws = await hosted(session);
  const make = fakeBridge();
  await session.attachGame(make);
  const bridge = make({});
  ws.receive(START);
  bridge.onLine('act 0 1 2 0');
  bridge.onLine('irekae 1 1 2 8');
  ws.receive({ type: 'peer-lost' });
  assert.equal(bridge.lines.at(-1), 'lost');
  ws.receive({ type: 'peer-back' });
  assert.equal(bridge.lines.at(-1), 'back');
  assert.deepEqual(ws.messages().at(-1), { type: 'game', resume: 0 });
  ws.receive({ type: 'game', resume: 1 });
  assert.deepEqual(ws.messages().at(-1), { type: 'game', seq: 2, line: 'irekae 1 1 2 8' });
  session.close();
});

test('a dropped connection comes back in with its key', async () => {
  const session = new online.Session({ url: 'http://rooms.test', WebSocket: FakeSocket });
  const ws = await hosted(session);
  ws.receive(START);
  ws.drop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(FakeSocket.last.url, `ws://rooms.test/v1/rooms/new?code=KQ7M2D&key=${'k'.repeat(32)}`);
  session.close();
});

test('the other player leaving tells the game, and ends the session', async () => {
  const session = new online.Session({ url: 'http://rooms.test', WebSocket: FakeSocket });
  const ws = await hosted(session);
  const make = fakeBridge();
  await session.attachGame(make);
  const bridge = make({});
  ws.receive(START);
  const ended = new Promise(resolve => session.once('end', resolve));
  ws.receive({ type: 'left' });
  assert.equal(bridge.lines.at(-1), 'left');
  assert.deepEqual(await ended, { reason: 'left' });
  session.close();
});

test('a game that finished first and left is no walkout', async () => {
  const session = new online.Session({ url: 'http://rooms.test', WebSocket: FakeSocket });
  const ws = await hosted(session);
  const make = fakeBridge();
  await session.attachGame(make);
  const bridge = make({});
  ws.receive(START);
  let ended = null;
  session.on('end', result => { ended = result; });
  ws.receive({ type: 'finished' });
  ws.receive({ type: 'left' });
  assert.equal(ended, null);
  assert.equal(bridge.lines.includes('left'), false);
  bridge.onLine('end 0');
  assert.deepEqual(ended, { reason: 'over', winner: 0 });
  session.close();
});

test('the game saying how it ended reaches the room', async () => {
  const session = new online.Session({ url: 'http://rooms.test', WebSocket: FakeSocket });
  const ws = await hosted(session);
  const make = fakeBridge();
  await session.attachGame(make);
  const bridge = make({});
  ws.receive(START);
  const ended = new Promise(resolve => session.once('end', resolve));
  bridge.onLine('end 1');
  assert.deepEqual(ws.messages().at(-1), { type: 'result', winner: 1 });
  assert.deepEqual(await ended, { reason: 'over', winner: 1 });
  session.close();
});

test('the bridge holds lines for the game, then passes both ways', async () => {
  const lines = [];
  const bridge = online.createBridge({ onLine: line => lines.push(line) });
  const port = await bridge.listen();
  bridge.send('config 0 50 6 0');
  const socket = net.connect(port, '127.0.0.1');
  socket.setEncoding('utf8');
  const first = await new Promise(resolve => socket.once('data', resolve));
  assert.equal(first, 'config 0 50 6 0\n');
  socket.write('hello 1\nwai');
  socket.write('ting\n');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(lines, ['hello 1', 'waiting']);
  socket.destroy();
  bridge.close();
});

test("a room's rules carry its battle rules, Colosseum's unless Platinum's are chosen", () => {
  const parties = require('../src/parties');
  assert.equal(parties.normalize({}).battleRules, 3);
  assert.equal(parties.normalize({ battleRules: 4 }).battleRules, 4);
  assert.equal(parties.normalize({ battleRules: 7 }).battleRules, 3);
});
