'use strict';
// Online co-op (the game's host/netcoop.c): two players play the story together, each on their own screen. One hosts
// their own save; the other joins it by the host's address and plays the host's game beside them. The game does the
// networking (UDP straight to the host, as the SMS Launcher's multiplayer does); the launcher only starts it hosting or
// joining with these settings.

const DEFAULT_PORT = 24300;
const NAME_LENGTH = 23;

function port(value) {
  const text = String(value ?? '').trim();
  if (!text) return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) throw new Error('The port must be a number from 1 to 65535.');
  return Number(text);
}

// "host", "host:port", "1.2.3.4", "[::1]:24300": what the game's COLO_MULTIPLAYER_ADDRESS takes
function address(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('Enter the host\'s address to join.');
  if (text.length > 255 || /\s/.test(text)) throw new Error('That isn\'t an address: use a name or an IP address, with :port after it if the host chose one.');
  return text;
}

function name(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, NAME_LENGTH);
  return text || 'Player';
}

// A request from the Online page, checked: { mode: 'host' | 'join', port, address, name }
function request(value = {}) {
  const mode = value.mode === 'join' ? 'join' : value.mode === 'host' ? 'host' : null;
  if (!mode) throw new Error('Choose to host or to join.');
  return { mode, port: port(value.port), ...(mode === 'join' ? { address: address(value.address) } : {}), name: name(value.name) };
}

// The game's settings for it. `build` is the installed game's build: a game of another build is refused.
function environment(together, build = '') {
  if (!together) return {};
  return {
    COLO_MULTIPLAYER: together.mode,
    COLO_MULTIPLAYER_PORT: String(together.port),
    ...(together.mode === 'join' ? { COLO_MULTIPLAYER_ADDRESS: together.address } : {}),
    COLO_MULTIPLAYER_NAME: together.name,
    ...(build ? { COLO_GAME_VERSION: String(build).slice(0, 60) } : {}),
  };
}

// What the Online page keeps between visits
function remembered(value = {}) {
  let kept = DEFAULT_PORT;
  try { kept = port(value.port); } catch { kept = DEFAULT_PORT; }
  return { port: kept, address: typeof value.address === 'string' ? value.address.trim().slice(0, 255) : '' };
}

module.exports = { DEFAULT_PORT, request, environment, remembered };
