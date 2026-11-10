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
const storyParty = require('./story-party');
const formats = require('./formats');

// 2: a party can be a Story party, its Pokémon sent whole as `members`, and shorter than six.
// 3: rooms have formats (src/formats.js), team preview with picks, and best-of sets.
// 4: a room's rules may be Pokémon Platinum's battle rules (battleRules), which a launcher before 4 can't play.
// 5: rooms have timers (turnTime, battleTime), whose battle clock both games share: a launcher before 5 would leave
// its game without them, and the two games would end the battle at different turns.
// 6: under Platinum's rules four moves' rows changed (Astonish, Extrasensory and Needle Arm only flinch; Acupressure is
//    aimed), and both games must be given the same rows.
const PROTOCOL = 6;
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

// What tells two builds of the game apart. The room keeps 64 characters of it, and the page compares it with the
// list's, so two whole commit hashes wouldn't do.
function buildId(build) {
  return `${String(build?.commit || '').slice(0, 16)}-${String(build?.decomp || '').slice(0, 16)}`;
}

// A name on one line of the game's protocol: no spaces in it.
const lineName = name => String(name).replace(/ /g, '_') || 'Trainer';

function configLine({ side, rules, code }) {
  return `config ${side} ${rules.level} ${rules.size} ${rules.stage || 0}${code ? ` ${formatRoomCode(code)}` : ''}`;
}

// The battle's lines for the game: each Story party member, then the start, with a short party filled with 0.
function startLines({ seed, players }) {
  const party = player => Array.from({ length: storyParty.PARTY_SIZE }, (_, i) => player.party[i] || 0);
  // a member that isn't a party member's shape stays out, and the game makes that Pokemon from its species, as the other game does
  const members = players.flatMap((player, side) => (Array.isArray(player.members) ? player.members : []).slice(0, storyParty.PARTY_SIZE)
    .flatMap((member, slot) => storyParty.validWireMember(member, player.party[slot]) ? [storyParty.memberLine(side, slot, member)] : []));
  return [...members, `start ${seed} ${lineName(players[0].name)} ${lineName(players[1].name)} ${[...party(players[0]), ...party(players[1])].join(' ')}`];
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
    // only the game connected now: one let go by reset has already been forgotten
    connection.on('close', () => { if (socket === connection) { socket = null; onClose(); } });
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
    // the game that was connected is done with: lines from now wait for the next one
    reset() {
      const old = socket;
      socket = null;
      waiting = [];
      old?.destroy();
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
  launcher: 'That room\'s player has another version of the launcher. Both players need the newest one.',
  full: 'That battle has already started.',
  party: 'The room server didn\'t accept your party.',
  rules: 'Your party can\'t play by that room\'s rules.'
};

// One player's connection to one room: a battle, or a best-of set of them. Events: 'room' (code), 'preview' (the
// room's team preview: pick with pick()), 'start' (a game's start message), 'peer' (lost or back), 'end' (a game's
// or the room's end: { reason, winner }), 'set' (a set's end: { wins, reason }).
//
// The game runs once for each battle: playBattle in the main process starts it, and asks again() whether to start it
// once more, which it does for a host's game that waited in the stadium, and for each game of a set.
class Session extends EventEmitter {
  constructor({ url = serverUrl(), WebSocket = globalThis.WebSocket, setTimeout: later = global.setTimeout, features = {} } = {}) {
    super();
    this.url = url;
    this.WebSocket = WebSocket;
    this.later = later;
    this.features = features;  // rules: the game takes a rules line, and `close` for a game waiting in the stadium
    this.ws = null;
    this.bridge = null;
    this.code = null;
    this.key = null;
    this.start = null;      // this game's start message
    this.preview = null;    // this game's team preview, until it starts
    this.side = null;
    this.game = 0;          // which game of the set the start is for
    this.running = null;    // the game the running process plays: 0 for a host's waiting in the stadium
    this.outbox = [];       // what this game sent, in order: seq is its index + 1
    this.received = 0;      // the last seq delivered to this game
    this.pending = [];      // and those that came before its process started
    this.ended = false;     // this game has ended
    this.over = false;      // and so has the room: no game comes after it
    this.restart = false;
    this.peerFinished = false;
    this.stalled = false;     // this game's battle ended as the other's stopped choosing
    this.timeUp = false;      // or as its time ran out
    this.timers = [];
  }

  // A host's room: resolves with the code once the server has made it.
  async host({ name, build, version, launcher, party, members, rules, bestOf, listed }) {
    this.role = 'host';
    this.rules = { ...rules, stage: Number.isInteger(rules.stage) ? rules.stage : Math.floor(Math.random() * STAGES) };
    await this.connect(`${socketUrl(this.url)}/v1/rooms/new`);
    this.ws.send(JSON.stringify({ type: 'hello', name, build, version, launcher, protocol: PROTOCOL,
      rules: this.rules, bestOf: bestOf || 1, party, ...(members ? { members } : {}), public: listed !== false }));
    return this.answer('room', () => this.code);
  }

  // Into a host's room: resolves with the room's first message (its team preview, or the start), or rejects when refused.
  async join({ code, name, build, version, launcher, party, members }) {
    this.role = 'joiner';
    this.code = code;
    await this.connect(`${socketUrl(this.url)}/v1/rooms/${code}/join`);
    this.ws.send(JSON.stringify({ type: 'hello', name, build, version, launcher, protocol: PROTOCOL, party, ...(members ? { members } : {}) }));
    return this.answer(['start', 'preview'], message => message);
  }

  answer(events, value) {
    const names = [].concat(events);
    return new Promise((resolve, reject) => {
      const timer = this.later(() => reject(new Error('The room server didn\'t answer.')), REPLY_WAIT);
      const finish = (callback, argument) => {
        clearTimeout(timer);
        for (const name of names) this.off(name, done);
        this.off('refused', refused);
        this.off('dropped', dropped);
        callback(argument);
      };
      const done = message => finish(resolve, value(message));
      const refused = (reason, problems) => finish(reject, Object.assign(new Error(REFUSED[reason] || 'The room turned you away.'), { problems }));
      const dropped = () => finish(reject, new Error('That room is no longer open.'));
      for (const name of names) this.on(name, done);
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

  // The local port the game connects to. Lines go to it with prepareGame, before each time it starts.
  async attachGame(createBridgeImpl = createBridge) {
    this.bridge = createBridgeImpl({ onLine: line => this.onGameLine(line), onClose: () => this.onGameClosed() });
    return this.bridge.listen();
  }

  // What the game needs as it starts: the rules, its config, and the battle if there is one yet.
  prepareGame() {
    this.bridge.reset?.();
    const rules = this.start ? this.start.rules : this.rules;
    const line = this.features.rules ? formats.rulesLine(rules) : null;
    if (line) this.bridge.send(line);
    this.bridge.send(this.start ? configLine(this.start) : configLine({ side: 0, rules: this.rules, code: this.code }));
    if (this.start) for (const each of startLines(this.start)) this.bridge.send(each);
    this.running = this.start ? this.game : 0;
    // the other game's turns that came before this one started
    for (const line of this.pending) this.bridge.send(line);
    this.pending = [];
  }

  // Whether to start the game again, once it has closed: for a host whose game waited in the stadium, once the
  // battle starts; for a set, once its next game starts (after both players pick, with team preview). Prepares it.
  again() {
    const next = () => {
      if (this.start && this.game !== this.running && !this.ended) { this.restart = false; this.prepareGame(); return true; }
      return null;
    };
    const ready = next();
    // nothing to wait for: the room is over, or the game that ran wasn't one to start again
    if (ready || this.over || this.closing || (this.running !== null && !this.restart && !this.ended)) return Promise.resolve(Boolean(ready));
    return new Promise(resolve => {
      const check = () => {
        const go = next();
        if (go === null && !this.over && !this.closing) return;
        for (const name of ['start', 'end', 'set', 'end-session']) this.off(name, check);
        resolve(Boolean(go));
      };
      for (const name of ['start', 'end', 'set', 'end-session']) this.on(name, check);
    });
  }

  // This player's picks for the game: slots of their party, in order.
  pick(order) {
    if (!this.preview) return;
    this.sendJson({ type: 'pick', order });
    this.preview = { ...this.preview, picked: order };
  }

  onGameLine(line) {
    const [word, value] = line.split(' ');
    if (word === 'restart') this.restart = true;
    // how the battle is ending: the other player's game stopped choosing, or the battle's time ran out
    else if (word === 'stalled') this.stalled = true;
    else if (word === 'timeup') this.timeUp = true;
    else if (word === 'act' || word === 'irekae') {
      this.outbox.push(line);
      this.sendJson({ type: 'game', game: this.game, seq: this.outbox.length, line });
    } else if (word === 'desync') this.finish({ reason: 'desync' }, true);
    else if (word === 'end') {
      const winner = Number(value);
      this.sendJson({ type: 'result', winner });
      this.finish({ reason: 'over', winner: Number.isInteger(winner) && winner >= 0 ? winner : null,
        ...(this.stalled ? { stalled: true } : {}), ...(this.timeUp ? { timeUp: true } : {}) }, this.bestOf() === 1 || Boolean(this.peerGone));
    }
  }

  bestOf() { return (this.start || this.preview)?.bestOf || 1; }

  onGameClosed() {
    // to start again for the battle, or for a set's next game (or a game from before it, still showing its end): playBattle
    // asks again()
    if (this.restart || this.running !== (this.start ? this.game : 0) || (this.ended && !this.over)) return;
    if (!this.ended) this.finish({ reason: 'closed' }, true);
  }

  // A game of the set begins: its messages are numbered afresh.
  newGame(msg) {
    this.game = msg.game || 1;
    this.outbox = [];
    this.received = 0;
    this.pending = [];
    this.ended = false;
    this.peerFinished = false;
    this.peerGone = false;
    this.stalled = false;
    this.timeUp = false;
  }

  onMessage(ws, data) {
    if (ws !== this.ws || typeof data !== 'string' || data === 'pong') return;
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    if (msg.type === 'room') { this.code = msg.code; this.key = msg.key; this.emit('room', msg.code); }
    else if (msg.type === 'preview') this.onPreview(msg);
    else if (msg.type === 'start') this.onStart(msg);
    else if (msg.type === 'refused') this.emit('refused', msg.reason, Array.isArray(msg.problems) ? msg.problems.map(String) : null);
    else if (msg.type === 'game') this.onGame(msg);
    else if (msg.type === 'peer-lost') { this.bridge?.send('lost'); this.emit('peer', 'lost'); }
    else if (msg.type === 'peer-back') this.onPeerBack();
    else if (msg.type === 'resumed') this.onResumed();
    else if (msg.type === 'finished') this.peerFinished = true;
    else if (msg.type === 'left') this.onLeft();
    else if (msg.type === 'set') this.onSet(msg);
  }

  // A host's game waiting in the stadium closes when the challenger comes: it starts again for the battle.
  closeWaiting() {
    if (this.role !== 'host' || this.running !== 0 || this.restart) return false;
    this.restart = true;
    this.bridge?.send('close');
    return true;
  }

  onPreview(msg) {
    // sent again after a reconnection: this game's picks are made already
    if (this.preview && this.preview.game === msg.game) return;
    if ((msg.game || 1) <= this.game && this.start) return;
    this.side = msg.side;
    this.key = msg.key;
    this.preview = { ...msg, picked: null };
    if (this.features.rules) this.closeWaiting();
    this.emit('preview', msg);
  }

  onStart(msg) {
    if (this.start && (msg.game || 1) === this.game) return;   // sent again after a reconnection
    this.newGame(msg);
    this.start = msg;
    this.preview = null;
    this.side = msg.side;
    this.key = msg.key;
    this.emit('start', msg);
    // the game waiting in the stadium goes, to start again for the battle (one from before rules hears of the
    // battle, and says restart)
    if (this.role === 'host' && this.running === 0 && this.bridge && !this.restart) {
      if (this.features.rules) this.closeWaiting();
      else for (const line of startLines(msg)) this.bridge.send(line);
    }
  }

  onSet(msg) {
    this.over = true;
    this.emit('set', { wins: Array.isArray(msg.wins) ? msg.wins : [0, 0], reason: msg.reason || null });
  }

  onGame(msg) {
    if (Number.isInteger(msg.game) && msg.game !== this.game) return;
    // the other side is back and says what it last had: send it the rest
    if (Number.isInteger(msg.resume)) {
      for (let seq = msg.resume + 1; seq <= this.outbox.length; seq++) this.sendJson({ type: 'game', game: this.game, seq, line: this.outbox[seq - 1] });
      return;
    }
    if (!Number.isInteger(msg.seq) || msg.seq !== this.received + 1 || typeof msg.line !== 'string') return;
    this.received = msg.seq;
    // this game's process hasn't started yet: its turns wait for it
    if (this.running !== this.game) this.pending.push(msg.line);
    else this.bridge?.send(msg.line);
  }

  onPeerBack() {
    this.bridge?.send('back');
    this.emit('peer', 'back');
    this.sendJson({ type: 'game', game: this.game, resume: this.received });
  }

  onResumed() {
    this.sendJson({ type: 'game', game: this.game, resume: this.received });
    // picks made while away
    if (this.preview?.picked) this.sendJson({ type: 'pick', order: this.preview.picked });
  }

  onLeft() {
    if (this.over) return;
    // its game saw the end first and closed: this one gets there by itself, and says how it ended
    if (this.peerFinished && !this.ended) { this.peerGone = true; return; }
    this.bridge?.send('left');
    this.finish({ reason: 'left' }, true);
  }

  // Inside a battle or a set, a dropped connection comes back in.
  inRoom() { return Boolean(this.start || this.preview) && !this.over; }

  async onClose(ws, event) {
    if (ws !== this.ws || this.closing) return;
    this.ws = null;
    if (!this.inRoom()) {
      if (event?.code === 4409 || this.over) return;
      this.emit('dropped');
      if (this.start === null && this.preview === null && this.role === 'host') this.finish({ reason: 'dropped' }, true);
      return;
    }
    // the battle goes on: back in with this player's key
    const url = this.role === 'host'
      ? `${socketUrl(this.url)}/v1/rooms/new?code=${this.code}&key=${this.key}`
      : `${socketUrl(this.url)}/v1/rooms/${this.code}/join?key=${this.key}`;
    const until = Date.now() + RECONNECT_FOR;
    while (!this.over && !this.closing && Date.now() < until) {
      try { await this.connect(url); return; }
      catch (_) { await new Promise(resolve => this.later(resolve, RECONNECT_EVERY)); }
    }
    if (!this.over) { this.bridge?.send('left'); this.finish({ reason: 'dropped' }, true); }
  }

  // A game's end; `last` when no game comes after it.
  finish(result, last = false) {
    if (last) this.over = true;
    if (this.ended && !last) return;
    if (this.ended && last && result.reason === 'over') return;
    const first = !this.ended;
    this.ended = true;
    if (first || last) this.emit('end', result);
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
    this.emit('end-session');
  }
}

module.exports = { PROTOCOL, STAGES, parseRoomCode, formatRoomCode, buildId, serverUrl, listRooms, lookup, configLine, startLines, createBridge, Session };
