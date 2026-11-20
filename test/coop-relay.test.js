'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const { CoopRelay, parseCode, formatCode } = require('../src/coop-relay');

// A stand-in for the room server's co-op room (colosseum-server-api src/coop.js): the code and key first, 'peer' to both
// once both said hello, binary passed to the other side
function fakeServer({ refuse = null } = {}) {
  const room = { host: null, joiner: null, hello: {} };
  class FakeSocket {
    constructor(url) {
      this.url = url; this.readyState = 0; this.listeners = {};
      this.side = url.endsWith('/v1/coop/new') ? 'host' : 'joiner';
      room[this.side] = this;
      setTimeout(() => { this.readyState = 1; this.emit('open', {}); this.emit('message', { data: JSON.stringify({ type: 'room', code: 'KQ7M2D', key: 'k' }) }); }, 5);
    }
    addEventListener(type, fn, options = {}) { (this.listeners[type] ||= []).push({ fn, once: options.once }); }
    emit(type, event) {
      const list = this.listeners[type] || [];
      this.listeners[type] = list.filter(l => !l.once);
      for (const l of list) l.fn(event);
    }
    send(data) {
      const other = room[this.side === 'host' ? 'joiner' : 'host'];
      if (typeof data !== 'string') { if (other) setTimeout(() => other.emit('message', { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }), 1); return; }
      if (data === 'ping') return;
      const msg = JSON.parse(data);
      if (msg.type === 'hello') {
        if (refuse && this.side === 'joiner') return setTimeout(() => this.emit('message', { data: JSON.stringify({ type: 'refused', reason: refuse }) }), 1);
        room.hello[this.side] = msg;
        if (room.hello.host && room.hello.joiner) for (const side of ['host', 'joiner']) {
          const peer = room.hello[side === 'host' ? 'joiner' : 'host'];
          setTimeout(() => room[side].emit('message', { data: JSON.stringify({ type: 'peer', name: peer.name, game: peer.game }) }), 1);
        }
      }
    }
    close() { this.readyState = 3; }
  }
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ host: room.hello.host?.name, game: room.hello.host?.game, build: room.hello.host?.build, status: 'waiting' }) });
  return { FakeSocket, fetch, room };
}

const hello = name => ({ name, game: 'colosseum', build: 'colosseum-abc', version: '1', launcher: '0.5.2' });
const next = socket => new Promise(resolve => socket.once('message', (data, from) => resolve({ data, from })));

test('the two games\' packets go through the room, both ways, untouched', async () => {
  const { FakeSocket, fetch } = fakeServer();
  const host = new CoopRelay({ url: 'http://room', WebSocket: FakeSocket, fetch });
  const joiner = new CoopRelay({ url: 'http://room', WebSocket: FakeSocket, fetch });
  const { code, gamePort } = await host.host(hello('Wes'));
  assert.strictEqual(code, 'KQ7M2D');
  // the host's game, listening where the launcher told it
  const hostGame = dgram.createSocket('udp4');
  await new Promise(resolve => hostGame.bind(gamePort, '127.0.0.1', resolve));
  const peer = new Promise(resolve => host.once('peer', resolve));
  const { relayPort, host: hostName } = await joiner.join('kq7-m2d', hello('Rui'));
  assert.strictEqual(hostName, 'Wes');
  assert.deepStrictEqual(await peer, { name: 'Rui', game: 'colosseum' });
  // the joining game, joining its own launcher
  const joinGame = dgram.createSocket('udp4');
  await new Promise(resolve => joinGame.bind(0, '127.0.0.1', resolve));
  const atHost = next(hostGame);
  joinGame.send(Buffer.from('CONNECT'), relayPort, '127.0.0.1');
  const got = await atHost;
  assert.strictEqual(got.data.toString(), 'CONNECT');
  const atJoiner = next(joinGame);
  hostGame.send(Buffer.from('ACCEPT'), got.from.port, got.from.address);
  assert.strictEqual((await atJoiner).data.toString(), 'ACCEPT');
  host.close(); joiner.close(); hostGame.close(); joinGame.close();
});

test('a refusal and a wrong game say why, before the game starts', async () => {
  const refused = fakeServer({ refuse: 'version' });
  const host = new CoopRelay({ url: 'http://room', WebSocket: refused.FakeSocket, fetch: refused.fetch });
  await host.host(hello('Wes'));
  const joiner = new CoopRelay({ url: 'http://room', WebSocket: refused.FakeSocket, fetch: async () => ({ ok: true, status: 200, json: async () => ({ host: 'Wes', game: 'colosseum', build: 'colosseum-abc', status: 'waiting' }) }) });
  await assert.rejects(joiner.join('KQ7M2D', hello('Rui')), /another build/);
  const xd = new CoopRelay({ url: 'http://room', WebSocket: refused.FakeSocket, fetch: refused.fetch });
  await assert.rejects(xd.join('KQ7M2D', { ...hello('Rui'), game: 'xd' }), /other game/);
  const gone = new CoopRelay({ url: 'http://room', WebSocket: refused.FakeSocket, fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  await assert.rejects(gone.join('KQ7M2D', hello('Rui')), /no co-op game KQ7-M2D/);
  await assert.rejects(gone.join('nope', hello('Rui')), /six letters/);
  host.close();
});

test('codes read as the room server reads them', () => {
  assert.strictEqual(parseCode('kq7 m2d'), 'KQ7M2D');
  assert.strictEqual(parseCode('KQ7M2'), null);
  assert.strictEqual(formatCode('KQ7M2D'), 'KQ7-M2D');
});
