'use strict';
const test = require('node:test');
const assert = require('node:assert');
const together = require('../src/together');

test('hosting needs only a name; joining needs the host\'s co-op code', () => {
  assert.deepStrictEqual(together.request({ mode: 'host', name: 'Wes' }), { mode: 'host', name: 'Wes' });
  assert.deepStrictEqual(together.request({ mode: 'host', name: '' }), { mode: 'host', name: 'Player' });
  assert.deepStrictEqual(together.request({ mode: 'join', code: 'kq7-m2d', name: 'Rui' }), { mode: 'join', code: 'KQ7M2D', name: 'Rui' });
  assert.strictEqual(together.request({ mode: 'join', code: 'OIL 23Z' }).code, '01123Z');
  assert.throws(() => together.request({ mode: 'join', code: '' }), /co-op code/);
  assert.throws(() => together.request({ mode: 'join', code: '192.168.1.20' }), /co-op code/);
  assert.throws(() => together.request({ mode: 'watch' }), /host or to join/);
});

test('names are cut to what the game shows and lose control characters', () => {
  assert.strictEqual(together.request({ mode: 'host', name: 'A\u0007very long trainer name indeed' }).name, 'Avery long trainer name');
});

test('games play together at the very same commit', () => {
  assert.strictEqual(together.coopBuild('colosseum', { commit: '0123456789abcdef0123456789abcdef01234567' }), 'colosseum-0123456789abcdef');
  assert.strictEqual(together.coopBuild('xd', { gameVersion: '2026.11.19.1' }), 'xd-2026.11.19.1');
  assert.strictEqual(together.coopBuild('xd', null), 'xd-unknown');
});

test('the game\'s settings: the host on this computer only with its code, the joiner at the relay', () => {
  assert.deepStrictEqual(together.environment({ mode: 'host', port: 51000, code: 'KQ7-M2D', name: 'Wes', build: 'colosseum-abc' }),
    { COLO_MULTIPLAYER: 'host', COLO_MULTIPLAYER_NAME: 'Wes', COLO_MULTIPLAYER_PORT: '51000', COLO_MULTIPLAYER_LOCAL: '1',
      COLO_MULTIPLAYER_CODE: 'KQ7-M2D', COLO_GAME_VERSION: 'colosseum-abc' });
  assert.deepStrictEqual(together.environment({ mode: 'join', port: 52000, name: 'Rui' }),
    { COLO_MULTIPLAYER: 'join', COLO_MULTIPLAYER_NAME: 'Rui', COLO_MULTIPLAYER_ADDRESS: '127.0.0.1:52000' });
  assert.deepStrictEqual(together.environment(null), {});
});

test('the page remembers the last code joined', () => {
  assert.deepStrictEqual(together.remembered({ code: 'KQ7M2D' }), { code: 'KQ7M2D' });
  assert.deepStrictEqual(together.remembered({ code: 'nope' }), { code: '' });
  assert.deepStrictEqual(together.remembered(undefined), { code: '' });
});
