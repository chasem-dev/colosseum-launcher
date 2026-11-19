'use strict';
const test = require('node:test');
const assert = require('node:assert');
const together = require('../src/together');

test('hosting takes a port, or the default one', () => {
  assert.deepStrictEqual(together.request({ mode: 'host', port: '', name: 'Wes' }), { mode: 'host', port: 24300, name: 'Wes' });
  assert.deepStrictEqual(together.request({ mode: 'host', port: ' 25000 ', name: '' }), { mode: 'host', port: 25000, name: 'Player' });
  assert.throws(() => together.request({ mode: 'host', port: '70000' }), /1 to 65535/);
  assert.throws(() => together.request({ mode: 'host', port: 'abc' }), /1 to 65535/);
});

test('joining needs the host\'s address, with or without its port', () => {
  assert.deepStrictEqual(together.request({ mode: 'join', address: ' 192.168.1.20 ', port: '24300', name: 'Rui' }),
    { mode: 'join', port: 24300, address: '192.168.1.20', name: 'Rui' });
  assert.strictEqual(together.request({ mode: 'join', address: 'example.org:25000' }).address, 'example.org:25000');
  assert.strictEqual(together.request({ mode: 'join', address: '[::1]:24300' }).address, '[::1]:24300');
  assert.throws(() => together.request({ mode: 'join', address: '' }), /address/);
  assert.throws(() => together.request({ mode: 'join', address: 'two words' }), /address/);
  assert.throws(() => together.request({ mode: 'watch' }), /host or to join/);
});

test('names are cut to what the game shows and lose control characters', () => {
  assert.strictEqual(together.request({ mode: 'host', name: 'A\u0007very long trainer name indeed' }).name, 'Avery long trainer name');
});

test('the game\'s settings: hosting or joining, its name, and the build to match', () => {
  assert.deepStrictEqual(together.environment(together.request({ mode: 'host', port: 24301, name: 'Wes' }), 'abc123'),
    { COLO_MULTIPLAYER: 'host', COLO_MULTIPLAYER_PORT: '24301', COLO_MULTIPLAYER_NAME: 'Wes', COLO_GAME_VERSION: 'abc123' });
  assert.deepStrictEqual(together.environment(together.request({ mode: 'join', address: '10.0.0.2', name: 'Rui' })),
    { COLO_MULTIPLAYER: 'join', COLO_MULTIPLAYER_PORT: '24300', COLO_MULTIPLAYER_ADDRESS: '10.0.0.2', COLO_MULTIPLAYER_NAME: 'Rui' });
  assert.deepStrictEqual(together.environment(null), {});
});

test('the page remembers a good port and the last address', () => {
  assert.deepStrictEqual(together.remembered({ port: 25000, address: ' host.example ' }), { port: 25000, address: 'host.example' });
  assert.deepStrictEqual(together.remembered({ port: 'nope' }), { port: 24300, address: '' });
  assert.deepStrictEqual(together.remembered(undefined), { port: 24300, address: '' });
});
