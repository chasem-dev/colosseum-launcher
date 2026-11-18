'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gciSave = require('../src/gci-save');
const sp = require('../src/save-pokemon');
const { Shadowtrade, LiveGame, cardAccess, liveAccess, parseResult, checkReceived } = require('../src/shadowtrade');
const { GameLink, createReader } = require('../src/game-link');
const net = require('node:net');

const utf16 = (bytes, offset, value) => Buffer.from(value, 'utf16le').swap16().copy(bytes, offset);
function pokemon({ species, rnd, trainer, nickname, shadowId = 0, heart = -100 }) {
  const p = Buffer.alloc(0x138);
  p.writeUInt16BE(species, 0); p.writeUInt32BE(rnd, 4); p.writeUInt32BE(trainer, 0x14); utf16(p, 0x2e, nickname);
  p[0x60] = 30; p.writeUInt16BE(40, 0x8a); p.writeUInt16BE(40, 0x8c); p.writeUInt16BE(shadowId, 0xd8); p.writeInt32BE(heart, 0xdc);
  return p;
}
function plainSave(trainerId, party) {
  const plain = Buffer.alloc(gciSave.SLOT_SIZE);
  plain[0] = 1; plain[1] = 1; plain.writeInt32BE(4, 4);
  utf16(plain, 0x78, 'WES'); plain.writeUInt32BE(trainerId, 0xa4);
  party.forEach((p, i) => p.copy(plain, 0xa8 + i * 0x138));
  for (let n = 1; n <= 0x60; n++) { plain.writeUInt16BE(20, 0x1b4ac + 0x18 * n + 0x16); plain.writeUInt16BE(0xffff, 0x1b4ac + 0x18 * n + 0x14); }
  return plain;
}
function card(dir, trainerId, party) {
  const data = Buffer.alloc(gciSave.SIZE);
  for (let i = 0; i < 3; i++) {
    const plain = i === 0 ? plainSave(trainerId, party) : Buffer.alloc(gciSave.SLOT_SIZE);
    if (i) { plain[0] = 1; plain[1] = 1; }
    gciSave.scramble(plain).copy(data, gciSave.SLOT_START + i * gciSave.SLOT_SIZE);
  }
  fs.writeFileSync(path.join(dir, 'pokemon_colosseum.dat'), data);
}
const folder = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colo-shadowtrade-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

// The server, pairing as colosseum-server-api's pool does (oldest accepted first), in memory.
function fakeServer() {
  const trades = new Map();
  let order = 0, failNext = null, failTimes = 0;
  const server = {
    trades,
    failNext(kind, times = 1) { failNext = kind; failTimes = times; },
    async fetch(url, init) {
      const action = url.split('/').pop(), body = JSON.parse(init.body);
      const reply = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
      if (failNext === 'down') { if (--failTimes <= 0) failNext = null; throw new Error('fetch failed'); }
      if (failNext === 'refuse' && action === 'offer') { failNext = null; return reply({ error: 'That isn\'t a Shadow Pokémon this pool takes.' }, 400); }
      if (failNext === 'nonsense' && action === 'offer') { failNext = null; return reply({ ok: true }); }
      const view = t => ({ tradeId: t.id, status: t.status, received: t.got ? { pokemon: t.got.pokemon, from: t.got.trainer, ...t.got.summary } : undefined,
        returned: t.status === 'cancelled' ? { pokemon: t.pokemon } : undefined });
      if (action === 'offer') {
        let t = trades.get(body.tradeId);
        if (!t) {
          const data = Buffer.from(body.pokemon.data, 'base64');
          t = { id: body.tradeId, owner: body.key, trainer: body.trainerName, pokemon: body.pokemon, shadowId: data.readUInt16BE(0xd8), accepts: body.accepts,
            inPool: true, status: 'waiting', order: order++, summary: { species: data.readUInt16BE(0), shadowId: data.readUInt16BE(0xd8), level: 30, nickname: 'X' } };
          trades.set(t.id, t);
          const got = [...trades.values()].filter(o => o.inPool && o.owner !== t.owner && t.accepts.includes(o.shadowId)).sort((a, b) => a.order - b.order)[0];
          if (got) { got.inPool = false; t.got = got; t.status = 'received'; }
          const taker = [...trades.values()].filter(o => o.status === 'waiting' && o.owner !== t.owner && o.accepts.includes(t.shadowId)).sort((a, b) => a.order - b.order)[0];
          if (taker) { t.inPool = false; taker.got = t; taker.status = 'received'; }
        }
        if (failNext === 'lost') { failNext = null; throw new Error('the answer was lost'); }
        return reply({ trade: view(t) });
      }
      if (action === 'status') return reply({ trades: [...trades.values()].filter(t => t.owner === body.key && ['waiting', 'received', 'cancelled'].includes(t.status)).map(view) });
      if (action === 'ack') { const t = trades.get(body.tradeId); if (t && t.owner === body.key) t.status = 'done'; return reply({ ok: true }); }
      if (action === 'cancel') {
        const t = trades.get(body.tradeId);
        if (!t || t.owner !== body.key) return reply({ error: 'No such trade.' }, 404);
        if (t.status === 'waiting' && t.inPool) { t.status = 'cancelled'; t.inPool = false; }
        return reply({ trade: view(t) });
      }
      return reply({ error: 'Not found' }, 404);
    }
  };
  return server;
}

function player(t, server, { trainerId, party }) {
  const dir = folder(t);
  card(dir, trainerId, party);
  const trade = new Shadowtrade({ folder: path.join(dir, 'launcher'), url: 'https://server', fetch: server.fetch });
  const access = cardAccess({ game: 'colosseum', saveDir: dir });
  return { dir, trade, access, accessFor: () => access, party: () => sp.readCard(dir, 'colosseum').party.filter(Boolean).map(p => p.nickname) };
}

const A_ID = 0x1111, B_ID = 0x2222;
const UMBREON = pokemon({ species: 197, rnd: 1, trainer: A_ID, nickname: 'UMBREON' });
const MAKUHITA = pokemon({ species: 296, rnd: 2, trainer: A_ID, nickname: 'MAKUHITA', shadowId: 1, heart: 1500 });
const ESPEON = pokemon({ species: 196, rnd: 3, trainer: B_ID, nickname: 'ESPEON' });
const BAYLEEF = pokemon({ species: 153, rnd: 4, trainer: B_ID, nickname: 'BAYLEEF', shadowId: 2, heart: 2000 });

test('two players trade: the first waits, the second receives at once, the first on their next sync', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  const b = player(t, server, { trainerId: B_ID, party: [ESPEON, BAYLEEF] });
  let view = await a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 });
  assert.equal(view.trades[0].stage, 'waiting');
  assert.deepEqual(a.party(), ['UMBREON'], 'it left A\'s save before it was sent');
  view = await b.trade.offer(b.access, { area: 'party', box: 0, slot: 1 });
  assert.equal(view.trades.length, 0);
  assert.equal(view.history[0].received.species, 296);
  assert.equal(view.history[0].from, 'WES');
  assert.deepEqual(b.party(), ['ESPEON', 'MAKUHITA']);
  view = await a.trade.sync(a.accessFor);
  assert.equal(view.trades.length, 0);
  assert.deepEqual(a.party(), ['UMBREON', 'BAYLEEF']);
  const save = sp.readCard(a.dir, 'colosseum');
  assert.equal(save.party[1].trainer, B_ID, 'B stays its original trainer');
  assert.deepEqual([save.party[1].traded, save.party[1].storyId, save.party[1].shadowId], [true, 2, 0x2d], 'on an entry of its own');
  assert.equal([...server.trades.values()].every(each => each.status === 'done'), true);
});

test('a refused Pokémon never leaves the save', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [MAKUHITA] });
  await assert.rejects(a.trade.offer(a.access, { area: 'party', box: 0, slot: 0 }), /last Pokémon/);
  await assert.rejects(a.trade.offer(a.access, { area: 'party', box: 0, slot: 3 }), /no Pokémon/);
  assert.deepEqual(a.party(), ['MAKUHITA']);
  assert.equal(a.trade.view().trades.length, 0);
});

test('an offer the server doesn\'t confirm is called off, and the Pokémon comes back at once', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  for (const kind of ['down', 'refuse', 'nonsense']) {
    server.failNext(kind);
    await assert.rejects(a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 }), /couldn't be sent to Shadowtrade .*back in your save/, kind);
    assert.deepEqual(a.party(), ['UMBREON', 'MAKUHITA'], kind);
    assert.equal(a.trade.view().trades.length, 0, kind);
    assert.equal(a.trade.view().history[0].returned, true, kind);
  }
  assert.equal(server.trades.size, 0, 'nothing in the pool');
});

test('with the server unreachable, it is never sent later: each sync asks to call it off, then it comes back', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  server.failNext('down', 2);   // the offer and its cancel
  await assert.rejects(a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 }), /coming back/);
  const [trade] = a.trade.view().trades;
  assert.equal(trade.stage, 'taken');
  assert.match(trade.message, /as soon as the Shadowtrade server can be reached/);
  assert.deepEqual(a.party(), ['UMBREON']);
  await a.trade.sync(a.accessFor);
  assert.equal(a.trade.view().trades.length, 0);
  assert.deepEqual(a.party(), ['UMBREON', 'MAKUHITA']);
  assert.equal(server.trades.size, 0, 'never sent');
});

test('a lost answer: the server had it, so it is taken back out of the pool before it comes home', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  server.failNext('lost');
  await assert.rejects(a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 }), /back in your save/);
  assert.deepEqual(a.party(), ['UMBREON', 'MAKUHITA']);
  assert.equal([...server.trades.values()][0].inPool, false, 'not left in the pool');
  assert.equal([...server.trades.values()][0].status, 'done');
});

test('a launcher that stopped mid-take settles it by looking at the save', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  // stopped before the save changed: the trade is dropped, the Pokémon stays
  a.trade.state.journal.push({ tradeId: 'f'.repeat(32), game: 'colosseum', pool: 'colosseum', stage: 'taking', trainerName: 'WES', accepts: [],
    sent: { data: MAKUHITA.toString('base64'), record: null, identity: { species: 296, rnd: 2, trainer: A_ID }, place: { area: 'party', box: 0, slot: 1 }, summary: {} } });
  await a.trade.sync(a.accessFor);
  assert.equal(a.trade.view().trades.length, 0);
  assert.deepEqual(a.party(), ['UMBREON', 'MAKUHITA']);
  // stopped after: never sent, so it is called off and comes back
  sp.editCard(a.dir, 'colosseum', ctx => sp.takeFrom(ctx, { species: 296, rnd: 2, trainer: A_ID }));
  a.trade.state.journal.push({ tradeId: 'e'.repeat(32), game: 'colosseum', pool: 'colosseum', stage: 'taking', trainerName: 'WES', accepts: [],
    sent: { data: MAKUHITA.toString('base64'), record: null, identity: { species: 296, rnd: 2, trainer: A_ID }, place: { area: 'party', box: 0, slot: 1 }, summary: {} } });
  await a.trade.sync(a.accessFor);
  assert.equal(a.trade.view().trades.length, 0);
  assert.deepEqual(a.party(), ['UMBREON', 'MAKUHITA']);
  assert.equal(server.trades.size, 0);
});

test('cancel brings a waiting Pokémon back; one already gone can\'t be', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  await a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 });
  const id = a.trade.view().trades[0].tradeId;
  const view = await a.trade.cancel(id, a.accessFor);
  assert.equal(view.trades.length, 0);
  assert.equal(view.history[0].returned, true);
  assert.deepEqual(a.party(), ['UMBREON', 'MAKUHITA']);
  // stuck coming back (server down for the offer and its call-off): Cancel asks again and brings it home
  server.failNext('down', 2);
  await assert.rejects(a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 }), /coming back/);
  await a.trade.cancel(a.trade.view().trades[0].tradeId, a.accessFor);
  assert.deepEqual(a.party(), ['UMBREON', 'MAKUHITA']);
});

test('a randomizer\'s Gen 4 Shadow Pokémon can\'t go, and one an earlier launcher took comes back when cancelled', async t => {
  const server = fakeServer();
  const SNOVER = pokemon({ species: 485, rnd: 5, trainer: A_ID, nickname: 'SNOVER', shadowId: 1, heart: 1500 });
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, SNOVER] });
  await assert.rejects(a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 }), /Gen 4/);
  assert.deepEqual(a.party(), ['UMBREON', 'SNOVER']);
  assert.equal(a.trade.view().trades.length, 0);
  // as an earlier launcher left it: out of the save, refused by the server (it never saw it)
  const identity = { species: 485, rnd: 5, trainer: A_ID }, place = { area: 'party', box: 0, slot: 1 };
  sp.editCard(a.dir, 'colosseum', ctx => sp.takeFrom(ctx, identity, place));
  assert.deepEqual(a.party(), ['UMBREON']);
  a.trade.state.journal.push({ tradeId: 'f'.repeat(32), game: 'colosseum', pool: 'colosseum', stage: 'taken', createdAt: Date.now(), trainerName: 'WES', accepts: [],
    sent: { data: SNOVER.toString('base64'), record: null, identity, place, summary: { species: 485, shadowId: 1, level: 30, nickname: 'SNOVER', shiny: false }, traded: false } });
  // the running game takes back only Shadowtrade's species: it waits for the game to close
  const live = { mode: 'live', game: 'colosseum' };
  await a.trade.cancel('f'.repeat(32), () => live);
  assert.match(a.trade.view().trades[0].message, /Close the game and SNOVER comes back/);
  const view = await a.trade.sync(a.accessFor);
  assert.equal(view.trades.length, 0);
  assert.equal(view.history[0].returned, true);
  assert.deepEqual(a.party(), ['UMBREON', 'SNOVER']);
});

test('a received Pokémon waits while its save can\'t be reached, and lands when it can', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  const b = player(t, server, { trainerId: B_ID, party: [ESPEON, BAYLEEF] });
  await a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 });
  await b.trade.offer(b.access, { area: 'party', box: 0, slot: 1 });
  await a.trade.sync(() => null);
  assert.equal(a.trade.view().trades[0].stage, 'received');
  assert.deepEqual(a.party(), ['UMBREON']);
  await a.trade.sync(a.accessFor);
  assert.deepEqual(a.party(), ['UMBREON', 'BAYLEEF']);
});

test('received Pokémon are checked before they go into a save', () => {
  const ok = { pokemon: { data: BAYLEEF.toString('base64') } };
  assert.equal(checkReceived('colosseum', ok).data.readUInt16BE(0), 153);
  assert.throws(() => checkReceived('colosseum', { pokemon: { data: UMBREON.toString('base64') } }), /isn't a Shadow/);
  assert.throws(() => checkReceived('xd', ok), /damaged/);
  const odd = Buffer.from(BAYLEEF); odd.writeUInt16BE(260, 0);
  assert.throws(() => checkReceived('colosseum', { pokemon: { data: odd.toString('base64') } }), /isn't one this game has/);
  assert.equal(checkReceived('colosseum', { pokemon: { data: odd.toString('base64') } }, { returned: true }).data.readUInt16BE(0), 260, 'its own comes back');
});

// A game on the other end of a real launcher link (src/game-link.js): it sends its live picture and does each
// command at its next frame (or holds it, while `held`), as host/shadowtrade_io.c does.
async function linkedGame(t, plain, { trainer = A_ID } = {}) {
  const link = new GameLink();
  await link.listen();
  const socket = net.connect(link.port, '127.0.0.1');
  t.after(() => { socket.destroy(); link.close(); });
  const game = { held: false, pending: null, done: new Map(), commands: 0 };
  const send = (verb, data) => socket.write(Buffer.concat([Buffer.from(`${verb} bytes=${data.length}\n`), data]));
  game.live = () => {
    const body = plain.subarray(8), head = Buffer.alloc(0x40);
    head.writeUInt32BE(0x4353544c, 0); head.writeUInt32BE(1, 4); head.writeUInt32BE(0, 8); head.writeUInt32BE(1, 0x0c);
    head.writeUInt32BE(7, 0x10); head.writeUInt32BE(trainer, 0x14); head.writeUInt32BE(4, 0x18); head.writeUInt32BE(body.length, 0x20);
    head.writeUInt32BE(2, 0x30);
    send('live part=all', Buffer.concat([head, body]));
  };
  const run = text => {
    const [idLine, line] = text.trim().split('\n');
    const words = line.split(' ');
    const ctx = { game: 'colosseum', plain, extra: null };
    let result;
    if (words[0] === 'take') {
      const done = sp.takeFrom(ctx, { species: parseInt(words[4], 16), rnd: parseInt(words[5], 16), trainer: parseInt(words[6], 16) }, { area: words[1], box: Number(words[2]), slot: Number(words[3]) });
      result = done ? `ok ${done.area} ${done.box} ${done.slot}` : 'error missing';
    } else {
      const done = sp.giveTo(ctx, Buffer.from(words[1], 'hex'));
      result = done ? `ok ${done.already ? 'already ' : ''}${done.area} ${done.box} ${done.slot}` : 'error full';
    }
    game.commands++;
    game.done.set(idLine.slice(3), result);
    game.live();
    send('result', Buffer.from(`${idLine}\n${result}\n`));
  };
  const push = createReader(({ verb, fields, data }) => {
    if (verb === 'command') { if (game.held) game.pending = data.toString(); else setTimeout(() => run(data.toString()), 5); }
    if (verb === 'cancel') {
      const id = fields.id;
      if (game.pending?.startsWith(`id ${id}`)) { game.pending = null; send('result', Buffer.from(`id ${id}\nerror cancelled\n`)); }
      else send('result', Buffer.from(`id ${id}\n${game.done.get(id) || 'error cancelled'}\n`));
    }
  });
  socket.on('data', chunk => push(chunk));
  const hello = new Promise(resolve => link.once('hello', resolve));
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`hello link=1 token=${link.token} game=colosseum caps=shadowtrade.2\n`);
  await hello;
  const live = new LiveGame(link);
  const first = new Promise(resolve => link.once('message:live', resolve));
  game.live();
  await first;
  return { link, live, game, socket };
}

test('the running game: commands go to it over the link, and only for the card\'s own save', async t => {
  const plain = plainSave(A_ID, [UMBREON, MAKUHITA]);
  const { live, link } = await linkedGame(t, plain);
  assert.equal(link.has('shadowtrade.2'), true);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const access = liveAccess({ game: 'colosseum', live, cardTrainerId: A_ID, wait });
  assert.deepEqual(access.read().model.party.filter(Boolean).map(p => p.nickname), ['UMBREON', 'MAKUHITA']);
  const taken = await access.take({ species: 296, rnd: 2, trainer: A_ID }, { area: 'party', box: 0, slot: 1 });
  assert.deepEqual([taken.ok, taken.area, taken.slot], [true, 'party', 1]);
  await wait(30);   // the picture after it
  assert.equal(access.has({ species: 296, rnd: 2, trainer: A_ID }), false);
  const given = await access.give(MAKUHITA);
  assert.deepEqual([given.ok, given.slot], [true, 1]);
  assert.equal((await access.give(MAKUHITA)).already, true);
  // a game playing a new, unsaved game (another trainer) gets no commands
  const other = liveAccess({ game: 'colosseum', live, cardTrainerId: 0x9999, wait });
  await assert.rejects(other.take({ species: 296, rnd: 2, trainer: A_ID }, { area: 'party', box: 0, slot: 1 }), /isn't saved yet/);
  assert.deepEqual(parseResult('id 0123456789abcdef\nerror last-pokemon\n'), { id: '0123456789abcdef', ok: false, code: 'last-pokemon', message: '' });
});

test('the running game: a command it never reached is cancelled, and never happens after', async t => {
  const plain = plainSave(A_ID, [UMBREON, MAKUHITA]);
  const { live, game } = await linkedGame(t, plain);
  game.held = true;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const access = liveAccess({ game: 'colosseum', live, cardTrainerId: A_ID, wait, timeoutMs: 100 });
  const taken = await access.take({ species: 296, rnd: 2, trainer: A_ID }, { area: 'party', box: 0, slot: 1 });
  assert.deepEqual(taken, { ok: false, code: 'timeout' });
  assert.equal(game.pending, null);
  assert.equal(game.commands, 0);
  assert.equal(access.has({ species: 296, rnd: 2, trainer: A_ID }), true);
});

test('the running game: when the link closes mid-command, the outcome is unknown and the trade is kept for sync', async t => {
  const dir = folder(t);
  const plain = plainSave(A_ID, [UMBREON, MAKUHITA]);
  const { live, game, socket } = await linkedGame(t, plain);
  game.held = true;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const access = liveAccess({ game: 'colosseum', live, cardTrainerId: A_ID, wait });
  const trades = new Shadowtrade({ folder: dir, url: 'http://server', fetch: async () => { throw new Error('no server in this test'); } });
  setTimeout(() => socket.destroy(), 50);
  await assert.rejects(trades.offer(access, { area: 'party', box: 0, slot: 1 }), /didn't say whether it traded/);
  assert.deepEqual(trades.state.journal.map(entry => entry.stage), ['taking']);
});
