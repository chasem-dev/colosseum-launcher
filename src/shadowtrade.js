'use strict';

// Shadowtrade: a Wonder Trade for Shadow Pokémon. The player picks a Shadow Pokémon from their party or PC on the
// Pokémon page; it leaves their save and goes to colosseum-server-api's pool (its src/shadowtrade.js), and the
// Pokémon another player sent comes back into the save, at once when one is waiting, or later.
//
// A Pokémon is never in two places and never lost on the way:
//   1. It is written into the journal (state.json here) before anything else, then taken out of the save. With the
//      game closed, the launcher edits the card (save-pokemon.js editCard); with it running, the game takes it out
//      itself and saves (a command: SPEC in host/shadowtrade.c), as the launcher must never write a card the game is
//      using.
//   2. Only once the save no longer has it is it sent, and it counts as sent only when the server's answer says so
//      for this trade id. Without that answer (no server, a refusal, a lost answer) the trade is called off: the
//      server is asked to cancel it, as it may hold the Pokémon though its answer was lost, and the Pokémon comes back
//      once the server says it doesn't have it. Nothing unconfirmed is ever sent again.
//   3. The Pokémon received is put into the save the same two ways, then acknowledged, and only then forgotten here.
// After a crash at any step, sync() picks the trade up where it was, by looking at the save itself.
//
// The rules for which Shadow Pokémon can go and which a save can take are save-pokemon.js's (offerProblem,
// shadowAccepts), worked out from the research into each game's Shadow data.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const telemetry = require('./telemetry');
const savePokemon = require('./save-pokemon');

const STATE_VERSION = 1;
const HISTORY = 30;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;   // how long a command waits for the game to reach a safe moment
const COMMAND_POLL_MS = 250;

const b64 = bytes => Buffer.from(bytes).toString('base64');
const unb64 = text => Buffer.from(String(text || ''), 'base64');

function serverUrl(env = process.env) { return telemetry.endpoint(env); }

// Which pool a save trades in: its game's. A randomizer run trades with every other save of its game: a Shadow Pokémon
// received gets an entry of its own in the save (save-pokemon.js), so what the run made of each Shadow id doesn't
// matter. (`randomized` is kept for the server's randomized pools, which nothing sends to now.)
function poolFor(game, _randomized) { return game; }
const gameOfPool = pool => pool.split('-')[0];

// What the player sees of a Pokémon in a trade.
function summary(pokemon) {
  // a traded-in one by the story id it travels as
  return { species: pokemon.species, shadowId: pokemon.storyId || pokemon.shadowId, level: pokemon.level, nickname: pokemon.nickname, shiny: Boolean(pokemon.shiny) };
}

// Reads a received Pokémon's bytes as the game would (save-pokemon.js), and checks it is one this game can take:
// the right size, a species the game has, not an egg, a Shadow of the story. One coming back (a cancelled trade) left
// this same save, so its species isn't checked: a randomizer's Gen 4 or pack Shadow must still come home.
function checkReceived(game, received, { returned = false } = {}) {
  const data = unb64(received?.pokemon?.data), record = received?.pokemon?.record ? unb64(received.pokemon.record) : null;
  const size = game === 'xd' ? savePokemon.XD.size : savePokemon.COLOSSEUM.size;
  if (data.length !== size || (game === 'xd' && (!record || record.length !== savePokemon.XD.recordSize))) throw new Error('The Pokémon received is damaged.');
  const species = data.readUInt16BE(0);
  if (!returned && !savePokemon.shadowtradeSpecies(species)) throw new Error('The Pokémon received isn\'t one this game has.');
  if (game === 'xd') {
    const id = data.readUInt16BE(savePokemon.XD.at.shadow);
    if ((data[savePokemon.XD.at.flags] & 0x80) || id < 1 || id > 0x53 || id === 73 || (record[0] >> 5) !== 3) throw new Error('The Pokémon received isn\'t a Shadow Pokémon.');
  } else {
    const id = data.readUInt16BE(savePokemon.COLOSSEUM.at.shadow), heart = data.readInt32BE(savePokemon.COLOSSEUM.at.heart);
    if (data[savePokemon.COLOSSEUM.at.egg] || !savePokemon.COLOSSEUM_STORY_IDS.includes(id) || heart < 0) throw new Error('The Pokémon received isn\'t a Shadow Pokémon.');
  }
  return { data, record };
}

// ---- access to a save: the card (game closed) or the running game (its live picture + commands, over the launcher link) ----

// The card: read it, and change it with a backup first. backup(reason) makes one (main.js makeSaveBackup).
function cardAccess({ game, saveDir, randomized = false, backup = () => {} }) {
  return {
    game, mode: 'card', pool: poolFor(game, randomized),
    read() {
      const { copies } = savePokemon.cardCopies(saveDir, game);
      if (!copies.length) return null;
      return { model: savePokemon.model(copies[0].ctx), ctx: copies[0].ctx };
    },
    async take(identity, place) {
      backup('before-shadowtrade');
      const done = savePokemon.editCard(saveDir, game, ctx => savePokemon.takeFrom(ctx, identity, place));
      return done ? { ok: true, area: done.area, box: done.box, slot: done.slot } : { ok: false, code: 'missing' };
    },
    async give(data, record) {
      backup('before-shadowtrade');
      const done = savePokemon.editCard(saveDir, game, ctx => savePokemon.giveTo(ctx, data, record));
      return done && !done.refused ? { ok: true, area: done.area, box: done.box, slot: done.slot, entry: done.entry, already: Boolean(done.already) } : { ok: false, code: done?.refused || 'full' };
    },
    async restore(data) {
      backup('before-shadowtrade');
      const done = savePokemon.editCard(saveDir, game, ctx => savePokemon.restoreTo(ctx, data));
      return done && !done.refused ? { ok: true, area: done.area, box: done.box, slot: done.slot, already: Boolean(done.already) } : { ok: false, code: done?.refused || 'full' };
    },
    // Online Trades (online-trades.js): any Pokémon not a Shadow out, one made this game's in (trade-convert.js)
    async tradeTake(identity, place) {
      backup('before-trade');
      const done = savePokemon.editCard(saveDir, game, ctx => savePokemon.takeFrom(ctx, identity, place));
      return done ? { ok: true, area: done.area, box: done.box, slot: done.slot } : { ok: false, code: 'missing' };
    },
    async tradeGive(data) {
      backup('before-trade');
      const done = savePokemon.editCard(saveDir, game, ctx => savePokemon.restoreTo(ctx, data));
      return done && !done.refused ? { ok: true, area: done.area, box: done.box, slot: done.slot, already: Boolean(done.already) } : { ok: false, code: done?.refused || 'full' };
    },
    // a trade evolution needs the game's own scene: it waits for the game (online-trades.js sends it then)
    async evolve() { return { ok: false, code: 'later' }; },
    has(identity) {
      const { copies } = savePokemon.cardCopies(saveDir, game);
      return Boolean(copies.length && savePokemon.findPokemon(copies[0].ctx, identity));
    }
  };
}

function writeAtomic(file, text) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, text);
  try { fs.renameSync(temporary, file); } catch (error) {
    if (process.platform !== 'win32') throw error;
    fs.rmSync(file, { force: true });
    fs.renameSync(temporary, file);
  }
}

function parseResult(text) {
  const lines = String(text).split('\n').map(line => line.trim()).filter(Boolean);
  const id = /^id ([0-9a-f]{16})$/.exec(lines[0] || '')?.[1];
  const words = (lines[1] || '').split(' ');
  if (!id) return null;
  if (words[0] === 'ok') {
    const already = words[1] === 'already', rest = already ? words.slice(2) : words.slice(1);
    // (arrive: "ok party|box B S [shown] [evolved N] [pc]")
    const evolved = rest.indexOf('evolved');
    return { id, ok: true, already, area: rest[0], box: Number(rest[1]), slot: Number(rest[2]),
      evolved: evolved >= 0 ? Number(rest[evolved + 1]) || 0 : 0, pc: rest.includes('pc') };
  }
  return { id, ok: false, code: words[1] || 'error', message: words.slice(2).join(' ') };
}

// The running game over the launcher link (game-link.js): the game sends its live picture ("live": the whole of it when
// its save changes, its 0x40-byte header alone when only that does; save-pokemon.js parseLive reads it), takes a
// "command" at a safe moment, does it and saves, and answers "result" (SPEC: host/shadowtrade.c, host/shadowtrade_io.c).
const LIVE_HEADER = 0x40;
const CANCEL_WAIT_MS = 30 * 1000;   // how long a cancelled command's answer is waited for (more while the game is busy)

class LiveGame {
  constructor(link, { onChange = () => {} } = {}) {
    this.link = link;
    this.bytes = null;
    this.parsed = undefined;
    this.results = new Map();
    this.waiters = new Map();
    this.closed = false;
    this.lock = Promise.resolve();   // one command at a time: the game keeps one waiting, and lets an earlier go
    link.on('message:live', ({ fields, data }) => {
      if (fields.part === 'head' && this.bytes && data.length === LIVE_HEADER) data.copy(this.bytes, 0);
      else if (fields.part === 'all' || !this.bytes) this.bytes = Buffer.from(data);
      else return;
      this.parsed = undefined;
      onChange({ whole: fields.part === 'all' });
    });
    link.on('message:result', ({ data }) => {
      const result = parseResult(data.toString('latin1'));
      if (!result) return;
      const waiter = this.waiters.get(result.id);
      if (waiter) { this.waiters.delete(result.id); waiter(result); } else this.results.set(result.id, result);
    });
    link.on('close', () => {
      this.closed = true;
      for (const waiter of this.waiters.values()) waiter(null);
      this.waiters.clear();
      onChange({ closed: true });
    });
  }

  get linked() { return this.link.linked; }

  // { head, model, ctx } as save-pokemon.js readLive gives, or null before the game's first picture
  current() {
    if (this.parsed === undefined) this.parsed = this.bytes ? savePokemon.liveFrom(this.bytes) : null;
    return this.parsed;
  }

  send(verb, fields, text) { this.link.send(verb, fields, text === undefined || text === null ? null : Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8')); }

  // work() alone among the commands sent to the game (Shadowtrade's, Online Trades' and the arrivals' all go through here)
  exclusive(work) {
    const run = this.lock.then(work, work);
    this.lock = run.catch(() => {});
    return run;
  }

  // the result of command `id` once it comes, or null if the link closes first (forget(id) stops waiting)
  result(id) {
    if (this.results.has(id)) { const done = this.results.get(id); this.results.delete(id); return Promise.resolve(done); }
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => this.waiters.set(id, resolve));
  }

  forget(id) { this.waiters.get(id)?.(null); this.waiters.delete(id); this.results.delete(id); }
}

// What Shadowtrade asks of the running game. Commands only go to a game playing the card's own save (its trainer), so
// a new game never saved can't save over it.
function liveAccess({ game, live, cardTrainerId, randomized = false, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = COMMAND_TIMEOUT_MS, onWaiting = () => {} }) {
  const current = () => live.current();
  // waits for the answer to `id` until `deadline` says it is time to stop (it may move it on): the result, or null
  async function waitFor(answer, deadline) {
    for (;;) {
      const result = await Promise.race([answer, wait(COMMAND_POLL_MS).then(() => undefined)]);
      if (result !== undefined) return result;   // (null: the link closed)
      if (live.closed) return null;
      if (deadline(current()?.head)) return undefined;
    }
  }
  const command = (lines, before = null) => live.exclusive(() => commandNow(lines, before));
  async function commandNow(lines, before) {
    const now = current();
    if (!now?.head.loaded) throw new Error('Load your save in the game first.');
    if (cardTrainerId !== null && cardTrainerId !== undefined && now.head.trainerId !== cardTrainerId)
      throw new Error('The game is playing a game that isn\'t saved yet. Save it in the game first.');
    if (!live.linked) return { ok: false, code: 'timeout' };
    const id = crypto.randomBytes(8).toString('hex');
    const answer = live.result(id);
    before?.();
    live.send('command', {}, `id ${id}\n${lines}\n`);
    try {
      // The game's save ends on its own "saved" message, which waits for A: while it says it's busy with the command,
      // the command is under way however long that takes, and it's left for the game to finish.
      let until = Date.now() + timeoutMs, told = false;
      let result = await waitFor(answer, head => {
        if (head?.busy) until = Math.max(until, Date.now() + COMMAND_POLL_MS * 8);
        if (!told && head && !(head.safe && head.canSave)) { told = true; onWaiting(); }
        return Date.now() >= until;
      });
      if (result) return result;
      if (result === null) return { ok: false, code: 'unknown' };
      // given up: the game lets the command go if it hasn't started it ("error cancelled"), else it answers how it went
      live.send('cancel', { id });
      let limit = Date.now() + CANCEL_WAIT_MS;
      result = await waitFor(answer, head => {
        if (head?.busy) limit = Math.max(limit, Date.now() + COMMAND_POLL_MS * 8);
        return Date.now() >= limit;
      });
      if (!result) return { ok: false, code: 'unknown' };
      return result.code === 'cancelled' ? { ok: false, code: 'timeout' } : result;
    } finally { live.forget(id); }
  }
  return {
    game, mode: 'live', pool: poolFor(game, randomized),
    read() {
      const now = current();
      return now?.ctx ? { model: now.model, ctx: now.ctx, head: now.head } : null;
    },
    take(identity, place) {
      const hex = n => (n >>> 0).toString(16);
      return command(`take ${place.area} ${place.box} ${place.slot} ${hex(identity.species)} ${hex(identity.rnd)} ${hex(identity.trainer)}`);
    },
    give(data, record) { return command(`give ${data.toString('hex')}${record ? ` record ${record.toString('hex')}` : ''}`); },
    // one of the save's own story Shadows back as it was (a cancelled trade), needs a game with the return command
    restore(data) { return command(`return ${data.toString('hex')}`); },
    // Online Trades (online-trades.js; the game's trade-take, trade-give and evolve: a game whose hello says trade.1, evolve.1)
    tradeTake(identity, place) {
      const hex = n => (n >>> 0).toString(16);
      return command(`trade-take ${place.area} ${place.box} ${place.slot} ${hex(identity.species)} ${hex(identity.rnd)} ${hex(identity.trainer)}`);
    },
    tradeGive(data) { return command(`trade-give ${data.toString('hex')}`); },
    evolve(identity, place) {
      const hex = n => (n >>> 0).toString(16);
      return command(`evolve ${place.area} ${place.box} ${place.slot} ${hex(identity.species)} ${hex(identity.rnd)} ${hex(identity.trainer)}`);
    },
    has(identity) {
      const now = current();
      return Boolean(now?.ctx && savePokemon.findPokemon(now.ctx, identity));
    },
    // A Pokémon that came from a trade, shown by the game (a game whose hello says arrive.1; arrivals.js): its notice, its
    // trade evolution when evolve, the card from `lines` (arrival-show.js) with the pictures in `art`, "Open PC" or "Close".
    ...(live.link?.has?.('arrive.1') ? {
      arrive(identity, place, { evolve = false, lines = [], art = [] } = {}) {
        const hex = n => (n >>> 0).toString(16), at = place || { area: 'party', box: 0, slot: 0 };
        return command([`arrive ${at.area} ${at.box} ${at.slot} ${hex(identity.species)} ${hex(identity.rnd)} ${hex(identity.trainer)} ${evolve ? 1 : 0}`, ...lines].join('\n'),
          () => art.forEach((picture, slot) => picture && live.link.send('art', { slot, w: picture.width, h: picture.height }, picture.rgba)));
      }
    } : {})
  };
}

// ---- the trades ----

class Shadowtrade {
  // arrivals: arrivals.js, which has the running game show each Pokémon received (null: none shown)
  constructor({ folder, url = serverUrl(), fetch = globalThis.fetch, log = () => {}, onChange = () => {}, arrivals = null }) {
    this.folder = folder; this.url = url; this.fetch = fetch; this.log = log; this.onChange = onChange; this.arrivals = arrivals;
    this.file = path.join(folder, 'state.json');
    this.busy = null;
    this.state = this.load();
  }

  load() {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (state.version === STATE_VERSION && /^[0-9a-f]{64}$/.test(state.key)) return { journal: [], history: [], ...state };
    } catch (_) { /* a new one */ }
    return { version: STATE_VERSION, key: crypto.randomBytes(32).toString('hex'), journal: [], history: [] };
  }

  save() {
    fs.mkdirSync(this.folder, { recursive: true });
    writeAtomic(this.file, JSON.stringify(this.state, null, 2));
    this.onChange(this.view());
  }

  view() {
    const each = entry => ({ tradeId: entry.tradeId, game: entry.game, pool: entry.pool, stage: entry.stage, sent: entry.sent.summary,
      received: entry.received ? { ...entry.received.summary, from: entry.received.from, returned: Boolean(entry.received.returned) } : null,
      placedAt: entry.placedAt || null, message: entry.message || null, createdAt: entry.createdAt });
    return { trades: this.state.journal.map(each), history: this.state.history.slice(0, HISTORY), busy: Boolean(this.busy) };
  }

  async post(action, body) {
    const response = await this.fetch(`${this.url}/v1/shadowtrade/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: this.state.key, ...body }) });
    let reply = null;
    try { reply = await response.json(); } catch (_) { /* below */ }
    if (!response.ok) throw Object.assign(new Error(reply?.error || `The Shadowtrade server answered ${response.status}.`), { status: response.status });
    return reply;
  }

  async exclusive(work) {
    while (this.busy) await this.busy.catch(() => {});
    this.busy = work();
    try { return await this.busy; } finally { this.busy = null; this.onChange(this.view()); }
  }

  // Sends the Shadow Pokémon at `place` ({ area, box, slot }) of the save `access` reaches.
  offer(access, place) {
    return this.exclusive(async () => {
      const read = access.read();
      if (!read) throw new Error('There is no save to trade from yet.');
      const list = place.area === 'party' ? read.model.party : read.model.boxes[place.box]?.pokemon;
      const pokemon = list?.[place.slot];
      const problem = savePokemon.offerProblem(read.model, pokemon);
      if (problem) throw new Error(problem);
      const identity = { species: pokemon.species, rnd: pokemon.rnd, trainer: pokemon.trainer };
      const found = savePokemon.findPokemon(read.ctx, identity, place);
      const record = access.game === 'xd' ? read.ctx.plain.subarray(read.ctx.sections.darkPokemon + pokemon.shadowId * savePokemon.XD.recordSize,
        read.ctx.sections.darkPokemon + (pokemon.shadowId + 1) * savePokemon.XD.recordSize) : null;
      // what is sent: a traded-in one with its story id again (save-pokemon.js outgoing), as the game sends it too
      const out = savePokemon.outgoing(read.ctx, found.bytes, record);
      const entry = { tradeId: crypto.randomBytes(16).toString('hex'), game: access.game, pool: access.pool, stage: 'taking', createdAt: Date.now(),
        trainerName: read.model.trainer, accepts: savePokemon.acceptsAfterTaking(read.model, read.ctx, pokemon),
        sent: { data: b64(out.bytes), record: out.record ? b64(out.record) : null, identity, place, summary: summary(pokemon), traded: Boolean(pokemon.traded) } };
      this.state.journal.push(entry);
      this.save();
      const taken = await access.take(identity, place);
      if (!taken.ok && taken.code === 'unknown') {
        // the game didn't say how it went (it closed, or stopped answering): sync() looks at the save and sends it if it left
        entry.message = 'The game didn\'t say whether it traded. Shadowtrade checks your save, and sends the Pokémon if it left.';
        this.save();
        throw new Error(entry.message);
      }
      if (!taken.ok) {
        if (taken.code === 'missing' && !access.has(identity)) this.log('Shadowtrade: the Pokémon had already left the save.');
        else {
          this.state.journal = this.state.journal.filter(each => each !== entry);
          this.save();
          throw new Error(this.commandError(taken));
        }
      }
      entry.stage = 'taken';
      this.save();
      this.log(`Shadowtrade: ${pokemon.nickname} left the save for the ${entry.pool} pool.`);
      await this.send(entry);
      const returned = entry.received?.returned;
      if (entry.stage === 'received') await this.deliver(entry, access);
      if (returned) {
        const back = entry.stage === 'given' || !this.state.journal.includes(entry);
        throw new Error(`${pokemon.nickname} couldn't be sent to Shadowtrade (${entry.recall || 'the server didn\'t confirm it'}), so the trade was called off${back ? ' and it\'s back in your save' : `: ${entry.message || 'it\'s coming back to your save'}`}.`);
      }
      if (entry.stage === 'taken') throw new Error(entry.message);
      return this.view();
    });
  }

  commandError(result) {
    return { 'last-pokemon': 'You can\'t trade your last Pokémon that can battle: keep one in your party.', 'not-shadow': 'Only Shadow Pokémon can go to Shadowtrade.',
      lugia: 'XD-001 can\'t be traded.', full: 'Your party and PC boxes are full: make room for the Pokémon you\'ll receive.',
      save: 'The game couldn\'t save, so nothing was traded.', timeout: 'The game didn\'t reach a moment it could trade in: walk around in the field, outside menus and battles, and try again.',
      unknown: 'The game didn\'t say whether it traded. Shadowtrade looks at your save and tries again.',
      invalid: 'The game refused the Pokémon received. Update the game if Shadowtrade is new to it.',
      entries: 'Your save holds as many traded-in Shadow Pokémon as it can: purify some, and the next one comes.', missing: 'That Pokémon isn\'t in the save any more.' }[result.code] || `The game couldn't trade (${result.code}${result.message ? `: ${result.message}` : ''}).`;
  }

  // Sends a taken Pokémon. It is sent only when the server answers for this trade that it's in the pool or already
  // matched; anything else calls the trade off (recall).
  async send(entry) {
    let trade = null, problem;
    try {
      const reply = await this.post('offer', { pool: entry.pool, tradeId: entry.tradeId, trainerName: entry.trainerName, accepts: entry.accepts,
        pokemon: { data: entry.sent.data, ...(entry.sent.record ? { record: entry.sent.record } : {}) } });
      if (reply?.trade?.tradeId === entry.tradeId && ['waiting', 'received'].includes(reply.trade.status)) trade = reply.trade;
      else problem = 'the server didn\'t confirm it';
    } catch (error) { problem = error.message.replace(/\.$/, ''); }
    if (trade) { this.apply(entry, trade); this.save(); return; }
    this.log(`Shadowtrade: ${entry.sent.summary?.nickname || 'the Pokémon'} wasn't sent (${problem}): calling the trade off.`);
    entry.recall = problem;
    this.save();
    await this.recall(entry);
  }

  // Calls off a trade the server never confirmed. Afterwards the entry is 'received' (its own Pokémon on its way back,
  // or, had the server taken it after all, what it was matched with), 'waiting' (the server had it and sent it on), or
  // still 'taken' when the server can't be reached: then each sync asks again.
  async recall(entry) {
    try { await this.callOff(entry); } catch (error) {
      entry.message = `It couldn't be sent (${entry.recall || error.message.replace(/\.$/, '')}), so it's coming back: as soon as the Shadowtrade server can be reached, it's back in your save.`;
      this.save();
      return;
    }
    if (entry.stage !== 'taken') { entry.recall = undefined; entry.message = null; }
    this.save();
  }

  // Asks the server to take a trade back out of the pool. One it never saw (404) comes straight back. Throws when the
  // server can't be reached.
  async callOff(entry) {
    let reply;
    try { reply = await this.post('cancel', { pool: entry.pool, tradeId: entry.tradeId }); } catch (error) {
      if (error.status !== 404) throw error;
      entry.stage = 'received';
      entry.received = { data: entry.sent.data, record: entry.sent.record, from: entry.trainerName, returned: true, own: !entry.sent.traded, summary: entry.sent.summary };
      return;
    }
    this.apply(entry, reply?.trade);
  }

  // The server's view of a trade, into the journal.
  apply(entry, trade) {
    if (!trade) return;
    entry.message = null;
    if (trade.status === 'waiting' && entry.stage === 'taken') entry.stage = 'waiting';
    if (trade.status === 'received' && trade.received && ['taken', 'waiting'].includes(entry.stage)) {
      entry.stage = 'received';
      entry.received = { data: trade.received.pokemon.data, record: trade.received.pokemon.record || null, from: trade.received.from,
        summary: summary(trade.received) };
    }
    if (trade.status === 'cancelled' && trade.returned && ['taken', 'waiting'].includes(entry.stage)) {
      entry.stage = 'received';
      entry.received = { data: trade.returned.pokemon.data, record: trade.returned.pokemon.record || null, from: entry.trainerName, returned: true,
        own: !entry.sent.traded, summary: entry.sent.summary };
    }
  }

  // Puts a received Pokémon into the save, then tells the server it's there.
  async deliver(entry, access) {
    if (!access) return;
    let checked;
    try { checked = checkReceived(entry.game, { pokemon: { data: entry.received.data, record: entry.received.record } }, { returned: Boolean(entry.received.returned) }); } catch (error) {
      entry.message = error.message;
      this.save();
      return;
    }
    if (entry.received.returned && access.mode === 'live' && !savePokemon.shadowtradeSpecies(checked.data.readUInt16BE(0))) {
      // the running game takes back only the species it trades (host/shadowtrade.c): the card takes any, once it's closed
      entry.message = `Close the game and ${entry.received.summary?.nickname || 'your Pokémon'} comes back into your save.`;
      this.save();
      return;
    }
    if (entry.stage === 'received') { entry.stage = 'giving'; this.save(); }
    if (entry.stage === 'giving') {
      const identity = { species: checked.data.readUInt16BE(0), rnd: checked.data.readUInt32BE(entry.game === 'xd' ? 0x28 : 0x04),
        trainer: checked.data.readUInt32BE(entry.game === 'xd' ? 0x24 : 0x14) };
      let record = checked.record;
      if (entry.game === 'xd' && access.mode === 'live' && !entry.received.own) {
        // the game writes the record as given: merged here from this save's own (save-pokemon.js mergeXdRecord)
        const read = access.read();
        const at = read.ctx.sections.darkPokemon + checked.data.readUInt16BE(savePokemon.XD.at.shadow) * savePokemon.XD.recordSize;
        const party = read.model.party.filter(Boolean).length < savePokemon.PARTY_SIZE;
        record = savePokemon.mergeXdRecord(read.ctx.plain.subarray(at, at + savePokemon.XD.recordSize), checked.record, checked.data.readUInt16BE(savePokemon.XD.at.shadow),
          { area: party ? 'party' : 'box', box: 0 }, read.ctx.plain[read.ctx.sections.hero + savePokemon.XD.meetCount]);
      }
      const given = access.has(identity) ? { ok: true, already: true }
        : entry.received.own ? await access.restore(checked.data) : await access.give(checked.data, record);
      if (!given.ok) {
        entry.stage = 'received';
        entry.message = this.commandError(given);
        this.save();
        return;
      }
      entry.stage = 'given';
      entry.placedAt = given.area ? { area: given.area, box: given.box, slot: given.slot } : entry.placedAt || null;
      if (!entry.received.own && !entry.received.returned && !given.already)
        this.arrivals?.add({ game: entry.game, kind: 'shadowtrade', from: entry.received.from || '', data: b64(checked.data), identity,
          place: entry.placedAt, evolvesInto: 0, tradeId: entry.tradeId });
      this.save();
      this.log(`Shadowtrade: ${entry.received.summary.nickname} from ${entry.received.from || 'another player'} is in the save.`);
    }
    await this.finish(entry);
  }

  async finish(entry) {
    try { await this.post('ack', { pool: entry.pool, tradeId: entry.tradeId }); } catch (error) {
      entry.message = null;
      this.log(`Shadowtrade: couldn't tell the server yet (${error.message}).`);
      this.save();
      return;
    }
    this.state.journal = this.state.journal.filter(each => each !== entry);
    this.state.history.unshift({ tradeId: entry.tradeId, game: entry.game, sent: entry.sent.summary, received: entry.received.summary,
      from: entry.received.from, returned: Boolean(entry.received.returned), placedAt: entry.placedAt, at: Date.now() });
    this.state.history = this.state.history.slice(0, HISTORY);
    this.save();
  }

  // Everything not finished, moved on: interrupted takes and gives settled by looking at the save, unsent Pokémon
  // sent, waiting trades asked about (with each save's Shadow ids as they are now), received ones delivered.
  // accessFor(game) gives the access for a game's save now, or null when it can't be reached (then its trades wait).
  sync(accessFor) {
    return this.exclusive(async () => {
      const accesses = new Map();
      const access = game => { if (!accesses.has(game)) accesses.set(game, accessFor(game)); return accesses.get(game); };
      for (const entry of [...this.state.journal]) {
        const a = access(entry.game);
        if (entry.stage === 'taking') {
          if (!a) continue;
          // the take was cut short: did it happen?
          if (a.has(entry.sent.identity)) { this.state.journal = this.state.journal.filter(each => each !== entry); this.save(); continue; }
          entry.stage = 'taken';
          this.save();
        }
        // never confirmed by the server (the launcher stopped, or it couldn't be sent): called off, never sent again
        if (entry.stage === 'taken') await this.recall(entry);
      }
      const accepts = {};
      for (const pool of new Set(this.state.journal.filter(entry => entry.stage === 'waiting').map(entry => entry.pool))) {
        const read = access(gameOfPool(pool))?.read();
        if (read) accepts[pool] = savePokemon.shadowAccepts(read.model, read.ctx);
      }
      if (this.state.journal.some(entry => entry.stage === 'waiting')) {
        try {
          const reply = await this.post('status', { accepts });
          for (const trade of reply.trades || []) {
            const entry = this.state.journal.find(each => each.tradeId === trade.tradeId);
            if (entry) this.apply(entry, trade);
          }
          this.save();
        } catch (error) { this.log(`Shadowtrade: ${error.message}`); }
      }
      for (const entry of [...this.state.journal]) {
        if (['received', 'giving'].includes(entry.stage)) await this.deliver(entry, access(entry.game));
        else if (entry.stage === 'given') await this.finish(entry);
      }
      return this.view();
    });
  }

  // Takes a waiting Pokémon back out of the pool, if no one has it yet; it then comes back into the save.
  cancel(tradeId, accessFor) {
    return this.exclusive(async () => {
      const entry = this.state.journal.find(each => each.tradeId === tradeId);
      if (!entry) throw new Error('That trade is finished.');
      if (entry.stage === 'taken' || entry.stage === 'waiting') {
        // A taken one may have reached the server even if its answer was lost: ask. Only one the server has never
        // seen comes straight back.
        try { await this.callOff(entry); } catch (error) {
          throw new Error(`The Shadowtrade server can't be reached, so it can't be cancelled yet: ${error.message}`);
        }
        if (entry.stage === 'waiting') { this.save(); throw new Error('It has already gone to another player: yours is on its way.'); }
        if (entry.stage === 'taken') { this.save(); throw new Error('The Shadowtrade server didn\'t answer the cancel: try again in a moment.'); }
      } else throw new Error('That trade can\'t be cancelled now.');
      this.save();
      await this.deliver(entry, accessFor(entry.game));
      return this.view();
    });
  }
}

module.exports = { Shadowtrade, LiveGame, cardAccess, liveAccess, checkReceived, poolFor, parseResult, serverUrl, COMMAND_TIMEOUT_MS };
