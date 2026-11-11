'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const formats = require('../src/formats');

// a wire member (src/story-party.js wireMember) with an item, an ability slot and moves
const wire = (species, { item = 0, ability = 0, moves = [] } = {}) => {
  const m = [0, 0, 0, 0];
  moves.forEach((move, i) => { m[i] = move; });
  return [species, 0, 0, 4, ability, item, 255, m[0], 3, m[1], 3, m[2], 3, m[3], 3, 31, 31, 31, 31, 31, 31, 0, 0, 0, 0, 0, 0, '-'];
};

test('a room without a format is Casual, with its level and size as before', () => {
  const rules = formats.normalize({ level: 100, size: 3, stage: 2 });
  assert.equal(rules.format, 'casual');
  assert.equal(rules.level, 100);
  assert.equal(rules.size, 3);
  assert.equal(rules.stage, 2);
  assert.equal(rules.battle, 'single');
  assert.equal(formats.rulesLine(rules), null);
  assert.deepEqual(formats.problems(rules, [6, 9, 3, 150, 150, 251]), []);
  assert.equal(formats.describe(rules).summary, 'Level 100, 3 Pokémon each');
});

test('Casual takes only its level and size', () => {
  const rules = formats.normalize({ format: 'casual', level: 50, size: 6, sleep: 'stadium', battle: 'double', pool: 'ou' });
  assert.equal(rules.sleep, 'off');
  assert.equal(rules.battle, 'single');
  assert.equal(rules.pool, 'any');
});

test('the three formats as players set them up', () => {
  const orre = formats.normalize({ format: 'orre' });
  assert.equal(orre.battle, 'double');
  assert.equal(orre.size, 4);
  assert.equal(orre.level, 100);
  assert.equal(orre.preview, true);
  assert.equal(formats.rulesLine(orre), 'rules double=1 sleep=1 freeze=1 selfko=1 lastmon=1 hp=0 turn=60 battle=20');
  const hoenn = formats.normalize({ format: 'hoenn' });
  assert.equal(hoenn.battle, 'single');
  assert.equal(hoenn.size, 3);
  assert.equal(formats.rulesLine(hoenn), 'rules double=0 sleep=1 freeze=1 selfko=1 lastmon=1 hp=0 turn=60 battle=20');
  const ou = formats.normalize({ format: 'gen3ou' });
  assert.equal(ou.size, 6);
  assert.equal(ou.preview, false);
  assert.equal(formats.rulesLine(ou), 'rules double=0 sleep=2 freeze=1 selfko=0 lastmon=0 hp=1 turn=60 battle=30');
  assert.equal(formats.describe(ou).name, 'Gen 3 OU');
});

test('timers: a minute a turn and a battle timer in the formats, none in Casual unless the host sets them', () => {
  const casual = formats.normalize({ format: 'casual' });
  assert.equal(casual.turnTime, 0);
  assert.equal(casual.battleTime, 0);
  assert.equal(formats.rulesLine(casual), null);
  const timed = formats.normalize({ format: 'casual', level: 100, size: 3, turnTime: 60, battleTime: 20 });
  assert.equal(formats.rulesLine(timed), 'rules double=0 sleep=0 freeze=0 selfko=0 lastmon=0 hp=0 turn=60 battle=20');
  assert.equal(formats.describe(timed).summary, 'Level 100, 3 Pokémon each, 60-second turn timer, 20-minute battle timer');
  assert.equal(formats.describe(timed).custom, false);
  assert.ok(formats.rulesText(timed).includes('60-second turn timer'));
  const orre = formats.normalize({ format: 'orre' });
  assert.deepEqual([orre.turnTime, orre.battleTime], [60, 20]);
  assert.ok(formats.rulesText(orre).includes('20-minute battle timer'));
  assert.deepEqual([formats.normalize({ format: 'gen3ou' }).turnTime, formats.normalize({ format: 'gen3ou' }).battleTime], [60, 30]);
  // a change to a format's timers is a change to the format
  const slower = formats.describe({ format: 'orre', turnTime: 90, battleTime: 0 });
  assert.equal(slower.custom, true);
  assert.deepEqual(slower.changes, ['90-second turn timer', 'no battle timer']);
  // any whole number in range, else the format's own
  assert.equal(formats.normalize({ format: 'orre', turnTime: 37 }).turnTime, 37);
  for (const bad of [5, 100, 60.5, '60', -1, null]) assert.equal(formats.normalize({ format: 'orre', turnTime: bad }).turnTime, 60);
  for (const bad of [100, 0.5, '20']) assert.equal(formats.normalize({ format: 'hoenn', battleTime: bad }).battleTime, 20);
  assert.equal(formats.normalize({ format: 'hoenn', battleTime: 0 }).battleTime, 0);
  // a game from before timers plays without them
  const plain = formats.withoutTimers(orre);
  assert.deepEqual([plain.turnTime, plain.battleTime, plain.format, plain.size], [0, 0, 'orre', 4]);
  for (const value of [...formats.TURN_TIMES, ...formats.BATTLE_TIMES]) assert.ok(Number.isInteger(value));
});

test('a named variant shows its name, anything else as custom with what changed', () => {
  assert.equal(formats.describe({ format: 'orre', pool: 'any', soulDew: true }).name, 'Orre Unlimited');
  assert.equal(formats.describe({ format: 'hoenn', level: 50, pool: 'legends' }).name, 'Hoenn Limited');
  const custom = formats.describe({ format: 'orre', level: 50 });
  assert.equal(custom.name, 'Orre Colosseum*');
  assert.equal(custom.custom, true);
  assert.deepEqual(custom.changes, ['Level 50']);
  assert.equal(custom.summary, 'Orre Colosseum* (custom): Level 50');
  assert.equal(formats.describe({ format: 'orre' }).custom, false);
});

test('a size the battle can\'t have falls back to the format\'s', () => {
  assert.equal(formats.normalize({ format: 'orre', battle: 'single' }).size, 3);
  assert.equal(formats.normalize({ format: 'hoenn', size: 4 }).size, 3);
  assert.equal(formats.normalize({ format: 'hoenn', battle: 'double', size: 6 }).size, 6);
});

test('Orre Colosseum: box legendaries and mythical Pokémon out, Articuno and Latios in', () => {
  const rules = { format: 'orre' };
  assert.deepEqual(formats.problems(rules, [144, 408, 6, 9, 3, 25]), []);
  assert.equal(formats.problems(rules, [405, 408, 6, 9, 3, 25]).length, 1);
  assert.equal(formats.problems(rules, [251, 408, 6, 9, 3, 25]).length, 1);
  assert.deepEqual(formats.problems({ format: 'orre', pool: 'any' }, [405, 251, 6, 9, 3, 25]), []);
  assert.equal(formats.problems({ format: 'orre', pool: 'legends' }, [144, 408, 6, 9, 3, 25]).length, 2);
});

test('species, item and Soul Dew clauses', () => {
  const names = { species: id => ({ 6: 'Charizard', 408: 'Latios' })[id], item: id => ({ 200: 'Leftovers', 191: 'Soul Dew' })[id] };
  const party = [6, 6, 9, 3, 25, 408];
  assert.match(formats.problems({ format: 'hoenn' }, party, null, names)[0], /Two Charizard/);
  const members = [wire(6, { item: 200 }), wire(9, { item: 200 }), wire(3), wire(25), wire(130), wire(408, { item: 191 })];
  const found = formats.problems({ format: 'hoenn' }, [6, 9, 3, 25, 130, 408], members, names);
  assert.ok(found.some(text => /Two Pokémon hold Leftovers/.test(text)));
  assert.ok(found.some(text => /Latios holds Soul Dew/.test(text)));
  assert.deepEqual(formats.problems({ format: 'hoenn', pool: 'any', soulDew: true, itemClause: false }, [6, 9, 3, 25, 130, 408], members, names), []);
});

test('Gen 3 OU: Ubers, OHKO and evasion, and Smogon\'s bans', () => {
  const rules = { format: 'gen3ou' };
  assert.equal(formats.problems(rules, [407, 6, 9, 3, 25, 130]).length, 1);   // Latias
  assert.equal(formats.problems(rules, [202, 6, 9, 3, 25, 130]).length, 1);   // Wobbuffet
  assert.deepEqual(formats.problems(rules, [251, 409, 9, 3, 25, 130]), []);   // Celebi and Jirachi are OU
  const party = [131, 113, 143, 101, 235, 197];
  // Smogon's rules alone: some of these sets couldn't be legal either (Lapras with Baton Pass)
  const check = (members, ids = party) => formats.problems({ ...rules, legal: false }, ids, members);
  const plain = [wire(131), wire(113), wire(143), wire(101, { ability: 1 }), wire(235), wire(197)];
  const swap = (slot, member) => plain.map((each, i) => i === slot ? member : each);
  assert.deepEqual(check(plain), []);
  assert.equal(check(swap(0, wire(131, { moves: [329] }))).length, 1);              // Sheer Cold
  assert.equal(check(swap(1, wire(113, { moves: [104] }))).length, 1);              // Double Team
  assert.equal(check(swap(1, wire(113, { item: 179 }))).length, 1);                 // BrightPowder
  assert.equal(check(swap(2, wire(27)), [131, 113, 27, 101, 235, 197]).length, 1);  // Sandslash: Sand Veil
  assert.equal(check(swap(3, wire(101, { ability: 0 }))).length, 1);                // Electrode: Soundproof
  assert.equal(check(swap(4, wire(235, { moves: [275] }))).length, 1);              // Smeargle + Ingrain
  assert.equal(check(swap(5, wire(197, { moves: [226, 212] }))).length, 1);         // Baton Pass + Mean Look
  assert.equal(check(swap(5, wire(197, { moves: [226, 97] }))).length, 1);          // Baton Pass + Agility
  assert.equal(check(swap(5, wire(197, { moves: [226, 14, 347] }))).length, 1);     // two boosts
  assert.equal(check(swap(0, wire(131, { moves: [226, 14] })).map((each, i) => i === 5 ? wire(197, { moves: [226, 347] }) : each)).length, 1);   // two passers
  assert.equal(check(swap(1, wire(113, { item: 183 }))).length, 1);                 // Quick Claw
  assert.equal(check(swap(5, wire(197, { moves: [212, 28] }))).length, 1);          // Mean Look + Sand-Attack
});

test('only legal Pokémon: moves each could know in the third generation, items it can hold, numbers in range', () => {
  const rules = { format: 'hoenn' };
  const ids = [143, 6, 235, 9, 3, 25];
  const check = (slot, member) => formats.problems(rules, ids, ids.map((id, i) => i === slot ? member : wire(id)));
  assert.equal(formats.normalize(rules).legal, true);
  assert.equal(formats.normalize({ format: 'casual' }).legal, false);
  assert.deepEqual(check(0, wire(143, { moves: [34, 156, 214, 89], item: 200 })), []);   // Snorlax: tutor Body Slam, Rest, Sleep Talk, EQ, Leftovers
  assert.deepEqual(check(1, wire(6, { moves: [349, 89] })), []);                          // Charizard: Dragon Dance (Charmander's egg move)
  assert.deepEqual(check(2, wire(235, { moves: [147, 14, 226, 187] })), []);              // Smeargle sketches anything
  const spore = check(0, wire(143, { moves: [147] }));
  assert.equal(spore.length, 1);
  assert.match(spore[0], /can't learn move #147 in the third generation/);
  assert.equal(check(2, wire(235, { moves: [165] })).length, 1);                          // not even Smeargle: Struggle
  assert.equal(check(0, wire(143, { moves: [34, 34] })).length, 1);                       // the same move twice
  assert.equal(check(0, wire(143, { moves: [0x163] })).length, 1);                        // a Shadow move
  assert.match(check(0, wire(143, { item: 289 }))[0], /item #289, which a Pokémon can't hold/);   // TM01
  assert.equal(check(0, wire(143, { item: 500 })).length, 1);                             // a key item
  assert.equal(check(0, wire(143, { item: 60 })).length, 1);                              // an empty row
  assert.deepEqual(check(0, wire(143, { item: 13 })), []);                                // a Potion can be held
  const odd = (slot, edit) => { const w = wire(143); edit(w); return check(0, w); };
  assert.equal(odd(0, w => { w[21] = 255; w[22] = 255; w[23] = 10; }).length, 1);       // 520 EVs
  assert.equal(odd(0, w => { w[21] = 256; }).length, 1);
  assert.equal(odd(0, w => { w[15] = 32; }).length, 1);
  assert.equal(odd(0, w => { w[8] = 4; }).length, 1);
  assert.equal(odd(0, w => { w[3] = 13; }).length, 1);
  // a host can allow them, which makes the format custom; species alone are always legal; Casual checks none of it
  assert.deepEqual(formats.problems({ format: 'hoenn', legal: false }, ids, ids.map((id, i) => i ? wire(id) : wire(143, { moves: [147] }))), []);
  assert.deepEqual(formats.describe({ format: 'hoenn', legal: false }).changes, ['moves and items a Pokémon couldn\'t have allowed']);
  assert.deepEqual(formats.problems(rules, ids), []);
  assert.deepEqual(formats.problems({ format: 'casual', size: 6 }, ids, ids.map((id, i) => i ? wire(id) : wire(143, { moves: [147], item: 289 }))), []);
  assert.ok(formats.rulesText(rules).includes('only legal Pokémon'));
});

test('a short party, and picks', () => {
  assert.equal(formats.problems({ format: 'casual', size: 6 }, [6, 9, 3]).length, 1);
  assert.deepEqual(formats.problems({ format: 'hoenn' }, [6, 9, 3]), []);
  assert.deepEqual(formats.validPick([2, 0, 5], [6, 9, 3, 25, 130, 150], 3), [2, 0, 5]);
  assert.equal(formats.validPick([2, 2, 5], [6, 9, 3, 25, 130, 150], 3), null);
  assert.equal(formats.validPick([2, 0], [6, 9, 3, 25, 130, 150], 3), null);
  assert.equal(formats.validPick([0, 1, 4], [6, 9, 3, 0, 0, 0], 3), null);
  assert.equal(formats.toWin(1), 1);
  assert.equal(formats.toWin(3), 2);
  assert.equal(formats.toWin(5), 3);
  assert.equal(formats.bestOf(7), 1);
});

test('any format plays by Colosseum\'s or Pokémon Platinum\'s battle rules, without becoming custom', () => {
  assert.equal(formats.normalize({}).battleRules, 3);
  assert.equal(formats.normalize({ format: 'orre', battleRules: 4 }).battleRules, 4);
  assert.equal(formats.normalize({ format: 'casual', battleRules: 5 }).battleRules, 3);
  assert.deepEqual(formats.changes(formats.normalize({ format: 'orre', battleRules: 4 })), []);
  const orre = formats.describe({ format: 'orre', battleRules: 4 });
  assert.equal(orre.name, 'Orre Colosseum');
  assert.equal(orre.custom, false);
  assert.equal(orre.summary, 'Orre Colosseum · Pokémon Platinum\'s battle rules');
  assert.equal(formats.describe({ format: 'casual', level: 100, size: 3, battleRules: 4 }).summary,
    'Level 100, 3 Pokémon each · Pokémon Platinum\'s battle rules');
  assert.equal(formats.describe({ format: 'casual' }).summary, 'Level 50, 6 Pokémon each');
  assert.ok(formats.rulesText({ format: 'hoenn', battleRules: 4 }).includes('Pokémon Platinum\'s battle rules'));
  assert.ok(formats.rulesText({ format: 'casual', battleRules: 4 }).includes('Pokémon Platinum\'s battle rules'));
});

test('Generation 4 Pokémon and moves play only under Pokémon Platinum\'s battle rules, and not in Gen 3 OU', () => {
  const GARCHOMP = 471, OUTRAGE = 200, STONE_EDGE = 444 + 3, FIRE_FANG = 424 + 3, BULLET_PUNCH = 418 + 3;
  const ids = [GARCHOMP, 6, 9, 3, 25, 212];
  const party = ids.map(id => id === GARCHOMP ? wire(id, { moves: [OUTRAGE, STONE_EDGE, FIRE_FANG] }) : id === 212 ? wire(id, { moves: [BULLET_PUNCH] }) : wire(id));
  const casual = formats.problems({ format: 'casual' }, ids, party, { species: id => ({ [GARCHOMP]: 'Garchomp', 212: 'Scizor' })[id], move: id => `move ${id}` });
  assert.deepEqual(casual, [
    'Garchomp is a Generation 4 Pokémon, which play only under Pokémon Platinum\'s battle rules.',
    'Garchomp knows move 447, a Generation 4 move, which play only under Pokémon Platinum\'s battle rules.',
    'Garchomp knows move 427, a Generation 4 move, which play only under Pokémon Platinum\'s battle rules.',
    'Scizor knows move 421, a Generation 4 move, which play only under Pokémon Platinum\'s battle rules.']);
  assert.deepEqual(formats.problems({ format: 'casual', battleRules: 4 }, ids, party), []);
  assert.deepEqual(formats.problems({ format: 'hoenn', battleRules: 4 }, ids, party), []);   // legal in the fourth generation
  assert.ok(formats.problems({ format: 'gen3ou', battleRules: 4 }, ids, party).some(text => /Gen 3 OU doesn't have/.test(text)));
  // a species alone too
  assert.equal(formats.problems({ format: 'casual' }, [GARCHOMP, 6, 9, 3, 25, 1]).length, 1);
});

test('only legal Pokémon under Platinum\'s rules: what each could learn in the fourth generation, or bring from the third', () => {
  const rules = { format: 'hoenn', battleRules: 4 }, ids = [143, 474, 6, 9, 3, 25];
  const check = (slot, member) => formats.problems(rules, ids, ids.map((id, i) => i === slot ? member : wire(id)));
  assert.deepEqual(check(0, wire(143, { moves: [34, 156, 214, 120] })), []);         // Snorlax: Self-Destruct, a third generation tutor move
  assert.deepEqual(check(1, wire(474, { moves: [370 + 3, 396 + 3, 245, 242] })), []);   // Lucario: Close Combat, Aura Sphere, Extreme Speed, Riolu's Crunch
  assert.match(check(0, wire(143, { moves: [437 + 3] }))[0], /can't learn move #440 in the fourth generation/);   // Snorlax: Leaf Storm
  assert.equal(check(0, wire(143, { moves: [147] })).length, 1);                     // nor Spore
  assert.equal(check(0, wire(143, { moves: [356] })).length, 1);                     // Colosseum's own Shadow Rush
  assert.equal(check(0, wire(143, { moves: [471] })).length, 1);                     // past Shadow Force
  // under Colosseum's rules the third generation's, as before
  const gen3 = [143, 1, 6, 9, 3, 25];
  assert.deepEqual(formats.problems({ format: 'hoenn' }, gen3, gen3.map((id, i) => i ? wire(id) : wire(143, { moves: [120] }))), []);
});

test('the fourth generation\'s legendaries are restricted, mythical or legendary', () => {
  const party = id => [id, 6, 9, 3, 25, 143];
  assert.equal(formats.problems({ format: 'orre', battleRules: 4 }, party(509)).length, 1);      // Dialga
  assert.equal(formats.problems({ format: 'orre', battleRules: 4 }, party(519)).length, 1);      // Arceus
  assert.deepEqual(formats.problems({ format: 'orre', battleRules: 4 }, party(511)), []);         // Heatran
  assert.equal(formats.problems({ format: 'orre', pool: 'legends', battleRules: 4 }, party(511)).length, 1);
  assert.deepEqual(formats.problems({ format: 'orre', battleRules: 4 }, party(471)), []);         // Garchomp
});
