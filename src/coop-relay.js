'use strict';
// Online co-op through the room server (colosseum-server-api's src/coop.js), so nobody forwards a port: the two games
// talk UDP (the game's host/mp_net.cpp), each only to its own launcher on the same computer, and the launchers pass
// every packet through a co-op room over a WebSocket, untouched.
//
//   Host:   a room (its code for the other player), and its game hosting on a free port of this computer only
//           (COLO_MULTIPLAYER_LOCAL): its packets to the room, the room's to it.
//   Joiner: the room by its code, and a port of this computer its game joins as if it were the host's.
//
// The packets go in batches: a WebSocket message holds every packet its game sent in the last BATCH_MS (up to
// BATCH_BYTES), each as its length (2 bytes, big-endian) and its bytes. A room passes each message along as it is,
// so however many packets the games send (a save is ~170 at once), the room passes at most ~60 messages a second each
// way: a room handles its messages one at a time, and each one costs.
//
// Events: 'peer' ({ name, game }: the other player is in), 'peer-lost', 'left', 'closed'.

const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const telemetry = require('./telemetry');

const COOP_PROTOCOL = 1;   // (the room's: its hello, and batched packets)
const REPLY_WAIT = 8000;
const PING_EVERY = 30000;
const LOCAL = '127.0.0.1';
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BATCH_MS = 15;
const BATCH_BYTES = 12000;   // the room takes messages of 16 KB at most

const serverUrl = (env = process.env) => telemetry.endpoint(env);
const socketUrl = url => url.replace(/^http/, 'ws');

// The code in `text` ("kq7-m2d", "KQ7 M2D", O for 0, I or L for 1), or null: as the room server reads it
function parseCode(text) {
  const raw = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return raw.length === 6 && [...raw].every(c => CODE_ALPHABET.includes(c)) ? raw : null;
}
const formatCode = code => `${code.slice(0, 3)}-${code.slice(3)}`;

const REFUSED = {
  game: 'That co-op game is on the other game. Choose the same game as the host on the Play page.',
  version: 'That co-op game is on another build of the game. Both players need the very same one: update the game, or ask the host to.',
  launcher: 'That host\'s launcher plays co-op another way. Both players need the same launcher version.',
};

// A free UDP port of this computer, for the host's game to listen on
function freePort(sockets = dgram) {
  return new Promise((resolve, reject) => {
    const probe = sockets.createSocket('udp4');
    probe.once('error', reject);
    probe.bind(0, LOCAL, () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

class CoopRelay extends EventEmitter {
  constructor({ url = serverUrl(), WebSocket = globalThis.WebSocket, fetch = globalThis.fetch, sockets = dgram } = {}) {
    super();
    this.url = url;
    this.WebSocket = WebSocket;
    this.fetch = fetch;
    this.sockets = sockets;
    this.ws = null;
    this.udp = null;
    this.game = null;        // where this computer's game is: { port, address }
    this.code = null;
    this.closed = false;
    this.counts = { up: 0, down: 0 };   // packets from this computer's game to the room, and from the room to it
    this.batch = []; this.batchBytes = 0; this.batchTimer = null;
  }

  // a packet of this computer's game, into the next message to the room
  queue(packet) {
    if (this.batchBytes + packet.length + 2 > BATCH_BYTES) this.flush();
    this.batch.push(packet); this.batchBytes += packet.length + 2;
    this.counts.up++;
    if (!this.batchTimer) this.batchTimer = setTimeout(() => this.flush(), BATCH_MS);
  }

  flush() {
    clearTimeout(this.batchTimer); this.batchTimer = null;
    if (!this.batch.length) return;
    const message = Buffer.alloc(this.batchBytes);
    let at = 0;
    for (const packet of this.batch) { message.writeUInt16BE(packet.length, at); packet.copy(message, at + 2); at += packet.length + 2; }
    this.batch = []; this.batchBytes = 0;
    if (this.ws?.readyState === 1) this.ws.send(message);
  }

  // a message from the room: each packet in it to this computer's game
  deliver(data) {
    const message = Buffer.from(data);
    for (let at = 0; at + 2 <= message.length;) {
      const size = message.readUInt16BE(at);
      if (at + 2 + size > message.length) break;
      if (this.game && this.udp) { this.udp.send(message.subarray(at + 2, at + 2 + size), this.game.port, this.game.address); this.counts.down++; }
      at += 2 + size;
    }
  }

  open(path) {
    return new Promise((resolve, reject) => {
      if (!this.WebSocket) return reject(new Error('This launcher can\'t reach the room server.'));
      let ws;
      try { ws = new this.WebSocket(`${socketUrl(this.url)}${path}`); } catch (error) { return reject(error); }
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('The room server didn\'t answer.')); }, REPLY_WAIT);
      // the room's first word is its code and key
      ws.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        let msg; try { msg = JSON.parse(event.data); } catch (_) { return; }
        if (msg.type === 'room') { clearTimeout(timer); resolve({ ws, room: msg }); }
      }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Couldn\'t reach the room server.')); }, { once: true });
      ws.addEventListener('close', event => { clearTimeout(timer); reject(new Error(event.reason || 'The room server closed the room.')); }, { once: true });
    });
  }

  // this computer's side of the game's packets: a UDP socket on this computer only
  async listen() {
    const udp = this.sockets.createSocket('udp4');
    await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(0, LOCAL, resolve); });
    udp.on('message', (packet, from) => {
      if (from.address !== LOCAL) return;
      if (this.role === 'host' && from.port !== this.game.port) return;
      if (this.role === 'joiner') this.game = { port: from.port, address: from.address };   // the joining game, whichever port it took
      if (this.ws?.readyState === 1) this.queue(packet);
    });
    udp.on('error', () => {});
    this.udp = udp;
    return udp.address().port;
  }

  wire() {
    const ws = this.ws;
    ws.addEventListener('message', event => {
      if (typeof event.data !== 'string') {
        this.deliver(event.data);
        return;
      }
      let msg; try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (msg.type === 'peer') this.emit('peer', { name: msg.name, game: msg.game });
      else if (msg.type === 'peer-lost') this.emit('peer-lost');
      else if (msg.type === 'left') this.emit('left');
      else if (msg.type === 'refused') this.emit('refused', REFUSED[msg.reason] || 'The room server didn\'t take this game.');
    });
    ws.addEventListener('close', () => { if (!this.closed) this.emit('closed'); });
    this.ping = setInterval(() => { try { if (ws.readyState === 1) ws.send('ping'); } catch (_) {} }, PING_EVERY);
  }

  // hello: { name, game, build, version, launcher }. Resolves with { code, gamePort }: the game hosts on gamePort.
  async host(hello) {
    this.role = 'host';
    const { ws, room } = await this.open('/v1/coop/new');
    this.ws = ws; this.code = room.code;
    ws.send(JSON.stringify({ type: 'hello', protocol: COOP_PROTOCOL, ...hello }));
    this.game = { port: await freePort(this.sockets), address: LOCAL };
    await this.listen();
    this.wire();
    return { code: room.code, gamePort: this.game.port };
  }

  // Resolves with { relayPort, host }: the game joins 127.0.0.1:relayPort
  async join(text, hello) {
    this.role = 'joiner';
    const code = parseCode(text);
    if (!code) throw new Error('A co-op code is six letters and numbers, like KQ7-M2D.');
    const response = await this.fetch(`${this.url}/v1/coop/${code}`);
    const info = await response.json().catch(() => null);
    if (response.status === 404) throw new Error(`There's no co-op game ${formatCode(code)}. Check the code, or ask the host to host again.`);
    if (!response.ok || !info) throw new Error('The room server didn\'t answer.');
    if (info.game !== hello.game) throw new Error(REFUSED.game);
    if (info.build !== hello.build) throw new Error(REFUSED.version);
    if (info.status === 'playing') throw new Error(`${info.host} is playing with someone already.`);
    const { ws } = await this.open(`/v1/coop/${code}/join`);
    this.ws = ws; this.code = code;
    const relayPort = await this.listen();
    // in once the room says who the host is; refused otherwise
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The host didn\'t answer.')), REPLY_WAIT);
      this.once('peer', peer => { clearTimeout(timer); resolve(peer); });
      this.once('refused', why => { clearTimeout(timer); reject(new Error(why)); });
    });
    this.wire();
    ws.send(JSON.stringify({ type: 'hello', protocol: COOP_PROTOCOL, ...hello }));
    try { await answer; } catch (error) { this.close(); throw error; }
    return { relayPort, host: info.host };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    clearTimeout(this.batchTimer);
    try { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'leave' })); } catch (_) {}
    try { this.ws?.close(1000, 'Done'); } catch (_) {}
    try { this.udp?.close(); } catch (_) {}
  }
}

module.exports = { COOP_PROTOCOL, CoopRelay, parseCode, formatCode, freePort };
