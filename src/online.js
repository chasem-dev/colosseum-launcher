'use strict';

// Online battles. The room server is colosseum-server-api (its src/rooms.js
// describes the messages): it finds a host by room code or on the public list,
// and passes turns between two players' launchers over WebSockets.
//
// Both games play the same battle from one seed, so a turn is only what each
// player chose, a few dozen bytes. The launcher stands between its game and the
// room: it starts the game with COLO_ONLINE=<port>, the game connects to that
// local port, and the two exchange lines of text (the game's host/online.c
// lists them).
//
// A room's WebSocket can drop in the middle of a battle. Messages between the
// games are numbered, each launcher keeps what it sent, and when a connection
// comes back each side says what it last received.

const net = require('node:net');
const { EventEmitter } = require('node:events');
const telemetry = require('./telemetry');

const PROTOCOL = 1;
const STAGES = 6;              // the game's stadiums a room can use
const PING_EVERY = 30000;      // ms between WebSocket keepalives
const STATUS_EVERY = 30000;    // ms between a host's refreshes of its row on the room list
const REPLY_WAIT = 8000;       // ms to wait for the room server
const RECONNECT_FOR = 40000;   // ms a dropped connection keeps trying (the room waits 45 seconds)
const RECONNECT_EVERY = 2000;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// The code in `text` ("kq7-m2d", "KQ7 M2D", O typed for 0), or null.
function parseRoomCode(text) {
  const raw = String(text || '').trim();
  if (!/^[0-9a-z]{3}[-\s]?[0-9a-z]{3}$/i.test(raw)) return null;
  const code = raw.toUpperCase().replace(/[-\s]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return [...code].every(char => CODE_ALPHABET.includes(char)) ? code : null;
}

function formatRoomCode(code) {
  return code ? `${code.slice(0, 3)}-${code.slice(3)}` : '';
}

function serverUrl(env = process.env) { return telemetry.endpoint(env); }
const socketUrl = url => url.replace(/^http/, 'ws');

async function reply(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(body?.error || 'The room server didn\'t answer.'), { status: response.status });
  return body;
}

async function listRooms({ url = serverUrl(), fetch = globalThis.fetch } = {}) {
  return (await reply(await fetch(`${url}/v1/rooms`))).rooms;
}

async function lookup(code, { url = serverUrl(), fetch = globalThis.fetch } = {}) {
  try { return await reply(await fetch(`${url}/v1/rooms/${code}`)); }
  catch (error) {
    if (error.status === 404) throw new Error(`There's no room ${formatRoomCode(code)}.`);
    throw error;
  }
}

// A name on one line of the game's protocol: no spaces in it.
const lineName = name => String(name).replace(/ /g, '_') || 'Trainer';

function configLine({ side, rules, code }) {
  return `config ${side} ${rules.level} ${rules.size} ${rules.stage || 0}${code ? ` ${formatRoomCode(code)}` : ''}`;
}

function startLine({ seed, players }) {
  return `start ${seed} ${lineName(players[0].name)} ${lineName(players[1].name)} ${[...players[0].party, ...players[1].party].join(' ')}`;
}

// The local port the game connects to. Lines sent before it does wait for it.
function createBridge({ onLine, onClose = () => {}, createServer = net.createServer } = {}) {
  let socket = null, waiting = [], rest = '';
  const server = createServer(connection => {
    if (socket) return connection.destroy();
    socket = connection;
    connection.setNoDelay?.(true);
    connection.setEncoding('utf8');
    for (const line of waiting) connection.write(`${line}\n`);
    waiting = [];
    connection.on('data', data => {
      rest += data;
      const lines = rest.split('\n');
      rest = lines.pop();
      for (const line of lines) if (line) onLine(line.trim());
    });
    connection.on('error', () => {});
    connection.on('close', () => { socket = null; onClose(); });
  });
  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    }),
    send(line) {
      if (socket) socket.write(`${line}\n`);
      else waiting.push(line);
    },
    close() {
      socket?.destroy();
      server.close();
    }
  };
}

function openSocket(url, WebSocketImpl = globalThis.WebSocket) {
  return new Promise((resolve, reject) => {
    if (!WebSocketImpl) return reject(new Error('This launcher can\'t reach the room server.'));
    let ws;
    try { ws = new WebSocketImpl(url); } catch (error) { return reject(error); }
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('The room server didn\'t answer.')); }, REPLY_WAIT);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Couldn\'t reach the room server.')); }, { once: true });
  });
}

const REFUSED = {
  version: 'That room is on another version of the game. Both players need the same version.',
  full: 'That battle has already started.',
  party: 'The room server didn\'t accept your party.'
};

// One player's connection to one battle. Events: 'room' (code), 'start' (the
// room's start message), 'peer' (lost or back), 'end' ({ reason, winner }).
class Session extends EventEmitter {
  constructor({ url = serverUrl(), WebSocket = globalThis.WebSocket, setTimeout: later = global.setTimeout } = {}) {
    super();
    this.url = url;
    this.WebSocket = WebSocket;
    this.later = later;
    this.ws = null;
    this.bridge = null;
    this.code = null;
    this.key = null;
    this.start = null;
    this.side = null;
    this.outbox = [];       // what this game sent, in order: seq is its index + 1
    this.received = 0;      // the last seq delivered to this game
    this.ended = false;
    this.restart = false;
    this.peerFinished = false;
    this.timers = [];
  }

  // A host's room: resolves with the code once the server has made it.
  async host({ name, build, version, launcher, party, rules, listed }) {
    this.role = 'host';
    this.rules = { ...rules, stage: Number.isInteger(rules.stage) ? rules.stage : Math.floor(Math.random() * STAGES) };
    await this.connect(`${socketUrl(this.url)}/v1/rooms/new`);
    this.ws.send(JSON.stringify({ type: 'hello', name, build, version, launcher, protocol: PROTOCOL,
      rules: this.rules, party, public: listed !== false }));
    return this.answer('room', () => this.code);
  }

  // Into a host's room: resolves with the room's start message, or rejects when refused.
  async join({ code, name, build, version, launcher, party }) {
    this.role = 'joiner';
    this.code = code;
    await this.connect(`${socketUrl(this.url)}/v1/rooms/${code}/join`);
    this.ws.send(JSON.stringify({ type: 'hello', name, build, version, launcher, protocol: PROTOCOL, party }));
    return this.answer('start', message => message);
  }

  answer(event, value) {
    return new Promise((resolve, reject) => {
      const timer = this.later(() => reject(new Error('The room server didn\'t answer.')), REPLY_WAIT);
      const finish = (callback, argument) => {
        clearTimeout(timer);
        this.off(event, done);
        this.off('refused', refused);
        this.off('dropped', dropped);
        callback(argument);
      };
      const done = message => finish(resolve, value(message));
      const refused = reason => finish(reject, new Error(REFUSED[reason] || 'The room turned you away.'));
      const dropped = () => finish(reject, new Error('That room is no longer open.'));
      this.on(event, done);
      this.on('refused', refused);
      this.on('dropped', dropped);
    });
  }

  async connect(url) {
    const ws = await openSocket(url, this.WebSocket);
    this.ws = ws;
    ws.addEventListener('message', event => this.onMessage(ws, event.data));
    ws.addEventListener('close', event => this.onClose(ws, event));
    this.keepAlive();
  }

  keepAlive() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [setInterval(() => this.send('ping'), PING_EVERY)];
    if (this.role === 'host') this.timers.push(setInterval(() => this.sendJson({ type: 'status' }), STATUS_EVERY));
    for (const timer of this.timers) timer.unref?.();
  }

  send(text) {
    if (this.ws?.readyState === 1) this.ws.send(text);
  }

  sendJson(value) { this.send(JSON.stringify(value)); }

  // Connects the local game: lines it sends go to the other player.
  async attachGame(createBridgeImpl = createBridge) {
    this.bridge = createBridgeImpl({ onLine: line => this.onGameLine(line), onClose: () => this.onGameClosed() });
    const port = await this.bridge.listen();
    this.setUpGame();
    return port;
  }

  // What the game needs as it starts, and the battle if there is one yet.
  setUpGame() {
    this.bridge.send(this.start ? configLine(this.start) : configLine({ side: 0, rules: this.rules, code: this.code }));
    if (this.start) this.bridge.send(startLine(this.start));
  }

  // A host's game waited in the stadium, and has gone so that it can start again for the battle.
  takeRestart() {
    const restart = this.restart;
    this.restart = false;
    return restart;
  }

  onGameLine(line) {
    const [word, value] = line.split(' ');
    if (word === 'restart') this.restart = true;
    else if (word === 'act' || word === 'irekae') {
      this.outbox.push(line);
      this.sendJson({ type: 'game', seq: this.outbox.length, line });
    } else if (word === 'desync') this.finish({ reason: 'desync' });
    else if (word === 'end') {
      const winner = Number(value);
      this.sendJson({ type: 'result', winner });
      this.finish({ reason: 'over', winner: Number.isInteger(winner) && winner >= 0 ? winner : null });
    }
  }

  onGameClosed() {
    if (this.restart) return this.setUpGame();
    this.finish({ reason: 'closed' });
    this.close();
  }

  onMessage(ws, data) {
    if (ws !== this.ws || typeof data !== 'string' || data === 'pong') return;
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    if (msg.type === 'room') { this.code = msg.code; this.key = msg.key; this.emit('room', msg.code); }
    else if (msg.type === 'start') {
      this.start = msg;
      this.side = msg.side;
      this.key = msg.key;
      this.emit('start', msg);
      this.bridge?.send(startLine(msg));
    } else if (msg.type === 'refused') this.emit('refused', msg.reason);
    else if (msg.type === 'game') this.onGame(msg);
    else if (msg.type === 'peer-lost') { this.bridge?.send('lost'); this.emit('peer', 'lost'); }
    else if (msg.type === 'peer-back') this.onPeerBack();
    else if (msg.type === 'resumed') this.sendJson({ type: 'game', resume: this.received });
    else if (msg.type === 'finished') this.peerFinished = true;
    else if (msg.type === 'left') this.onLeft();
  }

  onGame(msg) {
    // the other side is back and says what it last had: send it the rest
    if (Number.isInteger(msg.resume)) {
      for (let seq = msg.resume + 1; seq <= this.outbox.length; seq++) this.sendJson({ type: 'game', seq, line: this.outbox[seq - 1] });
      return;
    }
    if (!Number.isInteger(msg.seq) || msg.seq !== this.received + 1 || typeof msg.line !== 'string') return;
    this.received = msg.seq;
    this.bridge?.send(msg.line);
  }

  onPeerBack() {
    this.bridge?.send('back');
    this.emit('peer', 'back');
    this.sendJson({ type: 'game', resume: this.received });
  }

  onLeft() {
    // its game saw the end first and closed: this one gets there by itself, and says how it ended
    if (this.peerFinished) return;
    this.bridge?.send('left');
    this.finish({ reason: 'left' });
  }

  async onClose(ws, event) {
    if (ws !== this.ws || this.closing) return;
    this.ws = null;
    if (!this.start || this.ended) {
      if (event?.code === 4409 || this.ended) return;
      this.emit('dropped');
      if (this.start === null && this.role === 'host') this.finish({ reason: 'dropped' });
      return;
    }
    // the battle goes on: back in with this player's key
    const url = this.role === 'host'
      ? `${socketUrl(this.url)}/v1/rooms/new?code=${this.code}&key=${this.key}`
      : `${socketUrl(this.url)}/v1/rooms/${this.code}/join?key=${this.key}`;
    const until = Date.now() + RECONNECT_FOR;
    while (!this.ended && !this.closing && Date.now() < until) {
      try { await this.connect(url); return; }
      catch (_) { await new Promise(resolve => this.later(resolve, RECONNECT_EVERY)); }
    }
    if (!this.ended) { this.bridge?.send('left'); this.finish({ reason: 'dropped' }); }
  }

  finish(result) {
    if (this.ended) return;
    this.ended = true;
    this.emit('end', result);
  }

  // Everything goes: the room, and the port the game was using.
  close() {
    this.closing = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    try { this.ws?.close(1000, 'Done'); } catch (_) {}
    this.ws = null;
    this.bridge?.close();
    this.bridge = null;
  }
}

module.exports = { PROTOCOL, STAGES, parseRoomCode, formatRoomCode, serverUrl, listRooms, lookup, configLine, startLine, createBridge, Session };
