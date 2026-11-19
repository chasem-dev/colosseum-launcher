'use strict';
// Online co-op (the game's host/netcoop.c): two players play the story together, each on their own screen. One hosts
// their own save and gets a co-op code; the other joins with the code and plays the host's game beside them. The games
// talk through the room server (src/coop-relay.js): nobody forwards a port. The launcher starts each game hosting or
// joining on this computer, and the relay passes the packets on.

const { parseCode } = require('./coop-relay');

const NAME_LENGTH = 23;
const COOP_BUILD = 64;   // what the room keeps of a build

function name(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, NAME_LENGTH);
  return text || 'Player';
}

// A request from the Online page, checked: { mode: 'host' | 'join', code (joining), name }
function request(value = {}) {
  const mode = value.mode === 'join' ? 'join' : value.mode === 'host' ? 'host' : null;
  if (!mode) throw new Error('Choose to host or to join.');
  if (mode === 'host') return { mode, name: name(value.name) };
  const code = parseCode(value.code);
  if (!code) throw new Error('Enter the host\'s co-op code: six letters and numbers, like KQ7-M2D.');
  return { mode, code, name: name(value.name) };
}

// Which games play together: the same game at the very same commit (the save's layout and the co-op messages must be
// alike), "colosseum-0123abcd4567ef89"
function coopBuild(game, installed) {
  const commit = installed?.commit || installed?.gameVersion || 'unknown';
  return `${game}-${String(commit).slice(0, 16)}`.slice(0, COOP_BUILD);
}

// The game's settings: hosting on `port` of this computer only, or joining the relay's port; its name, the code to
// show, and the build
function environment(together) {
  if (!together) return {};
  return {
    COLO_MULTIPLAYER: together.mode,
    COLO_MULTIPLAYER_NAME: together.name,
    ...(together.mode === 'host'
      ? { COLO_MULTIPLAYER_PORT: String(together.port), COLO_MULTIPLAYER_LOCAL: '1', COLO_MULTIPLAYER_CODE: together.code }
      : { COLO_MULTIPLAYER_ADDRESS: `127.0.0.1:${together.port}` }),
    ...(together.build ? { COLO_GAME_VERSION: together.build } : {}),
  };
}

// What the Online page keeps between visits: the last code joined
function remembered(value = {}) {
  return { code: parseCode(value?.code) || '' };
}

module.exports = { request, coopBuild, environment, remembered };
