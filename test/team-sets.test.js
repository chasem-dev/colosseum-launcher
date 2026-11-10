'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('../src/team-sets');
const storyParty = require('../src/story-party');
const online = require('../src/online');

const UMBREON = 197;

test('a set keeps only what the game accepts', () => {
  const set = T.normalizeSet({ species: UMBREON, nickname: '  Moon\u0001light  long name ', item: 200, ability: 1, nature: 23, gender: 'F', shiny: true,
    moves: [236, 185, 236, 999, 0x163, 92, 104], evs: [252, 252, 252, 0, 0, 0], ivs: [31, 40, -1, 0, 31, 30], friendship: 300, ball: 13 }, UMBREON);
  assert.equal(set.nickname, 'Moonlight');
  assert.deepEqual(set.moves, [236, 185, 92, 104]);
  assert.deepEqual(set.evs, [252, 252, 6, 0, 0, 0]);
  assert.deepEqual(set.ivs, [31, 31, 31, 0, 31, 30]);
  assert.equal(set.friendship, 255);
  assert.equal(set.ball, 4);
  assert.equal(set.ability, 1);
  // a set for another species starts again from this one
  assert.deepEqual(T.normalizeSet({ ...set, species: 196 }, UMBREON), T.defaultSet(UMBREON));
  assert.deepEqual(T.normalizeSet(null, UMBREON).moves, []);
});

test('stats are the third generation\'s, with the nature\'s tenth', () => {
  const set = { ...T.defaultSet(130), nature: 3, evs: [6, 252, 0, 0, 0, 252], ivs: [31, 31, 31, 30, 30, 30] };
  assert.deepEqual(T.stats([95, 125, 79, 60, 100, 81], set, 50), [171, 194, 99, 72, 120, 132]);
  assert.deepEqual(T.stats([95, 125, 79, 60, 100, 81], T.defaultSet(130), 100), [331, 286, 194, 156, 236, 198]);
  assert.equal(T.stats([1, 90, 45, 30, 30, 40], T.defaultSet(303), 100)[0], 1);   // Shedinja
  assert.equal(T.natureLabel(3), 'Adamant (+Atk, −SpA)');
  assert.equal(T.natureLabel(12), 'Serious');
});

test('Hidden Power follows the IVs, and IVs can be found for any type', () => {
  assert.deepEqual(T.hiddenPower([31, 31, 31, 31, 31, 31]), { type: 'Dark', power: 70 });
  assert.deepEqual(T.hiddenPower([31, 30, 31, 30, 31, 30]), { type: 'Fire', power: 70 });
  for (const type of T.HIDDEN_POWER_TYPES) {
    const ivs = T.hiddenPowerIvs(type);
    assert.equal(T.hiddenPower(ivs).type, type);
    assert.equal(T.hiddenPower(ivs).power, 70);
  }
});

test('a personality gives the set its nature, gender and shininess', () => {
  for (const [nature, gender, shiny] of [[0, 'M', false], [23, 'F', true], [13, '', true], [24, 'F', false]]) {
    const set = { ...T.defaultSet(UMBREON), nature, gender, shiny };
    const pid = T.personality(set, 31, 2);
    assert.equal(pid % 25, nature);
    if (gender) assert.equal(T.genderOf(pid, 31), gender);
    const shinyValue = ((T.TRAINER >>> 16) ^ (T.TRAINER & 0xffff) ^ (pid >>> 16) ^ (pid & 0xffff)) < 8;
    assert.equal(shinyValue, shiny);
    assert.equal(storyParty.isShiny({ trainer: T.TRAINER, rnd: pid }), shiny);
    assert.equal(T.personality(set, 31, 2), pid, 'the same each time');
  }
  // one gender only, or none: what's asked for can't change it
  assert.equal(T.personality({ ...T.defaultSet(150), nature: 5, gender: 'F' }, T.GENDER.none) % 25, 5);
});

test('a set goes to the game as a Story party member does', () => {
  const set = T.normalizeSet({ species: UMBREON, nickname: 'Umbra', item: 200, nature: 23, moves: [236, 185], evs: [252, 0, 4, 0, 252, 0] }, UMBREON);
  const wire = T.toWire(set, 31, 0);
  assert.ok(storyParty.validWireMember(wire, UMBREON));
  assert.equal(wire.length, storyParty.WIRE_NUMBERS + 1);
  assert.deepEqual(wire.slice(7, 15), [236, 3, 185, 3, 0, 0, 0, 0]);
  assert.deepEqual(wire.slice(15, 21), [31, 31, 31, 31, 31, 31]);
  assert.deepEqual(wire.slice(21, 27), [252, 0, 4, 0, 252, 0]);
  assert.equal(wire[27], '0055006d006200720061');
  assert.equal(T.toWire(T.defaultSet(UMBREON), 31)[27], '-');
  const [line] = online.startLines({ seed: 1, players: [{ name: 'A', party: [UMBREON], members: [wire] }, { name: 'B', party: [1] }] });
  assert.match(line, /^member 0 0 197 \d+ 0 4 0 200 255 236 3 185 3 0 0 0 0 (31 ){6}252 0 4 0 252 0 0055006d006200720061$/);
});

// A small Pokédex for Showdown's text.
const dex = {
  species: [{ id: 376, name: 'Metagross' }, { id: 135, name: 'Jolteon' }, { id: 29, name: 'Nidoran♀' }, { id: 250, name: 'Ho-Oh' }, { id: 201, name: 'Unown' }],
  moves: [{ id: 309, name: 'Meteor Mash' }, { id: 89, name: 'Earthquake' }, { id: 85, name: 'Thunderbolt' }, { id: 237, name: 'Hidden Power' },
    { id: 185, name: 'Faint Attack' }, { id: 136, name: 'Hi Jump Kick' }],
  items: [{ id: 186, name: 'Choice Band' }, { id: 171, name: 'Petaya Berry' }, { id: 179, name: 'Brightpowder' }],
  balls: [{ id: 4, name: 'Poké Ball' }, { id: 11, name: 'Luxury Ball' }],
  abilities: id => ({ 376: [{ slot: 0, name: 'Clear Body' }], 135: [{ slot: 0, name: 'Volt Absorb' }], 29: [{ slot: 0, name: 'Poison Point' }] }[id] || [{ slot: 0, name: 'Pressure' }, { slot: 1, name: 'Other' }]),
  gender: id => ({ 376: 255, 135: 31, 29: 254 }[id] ?? 127)
};

test('Showdown\'s text comes in, with its names for this game\'s moves and items', () => {
  const text = `=== [gen3] Team ===

Metagross @ Choice Band
Ability: Clear Body
Level: 100
EVs: 252 HP / 252 Atk / 4 SpD
Adamant Nature
- Meteor Mash
- Earthquake
- Feint Attack
- High Jump Kick

Sparky (Jolteon) (F) @ Bright Powder
Ability: Volt Absorb
Shiny: Yes
Happiness: 0
EVs: 4 HP / 252 SpA / 252 Spe
Timid Nature
- Thunderbolt
- Hidden Power [Grass]

Nidoran-F
- Splash

Mew @ Leftovers
- Psychic

Ho-Oh @ Lucky Charm
Ability: Pressure
- Earthquake
`;
  const { sets, problems } = T.parseShowdown(text, dex);
  assert.deepEqual(sets.map(set => set.species), [376, 135, 29, 250]);
  const [metagross, jolteon, nidoran] = sets;
  assert.equal(metagross.item, 186);
  assert.deepEqual(metagross.moves, [309, 89, 185, 136]);
  assert.deepEqual(metagross.evs, [252, 252, 0, 0, 4, 0]);
  assert.equal(metagross.nature, 3);
  assert.equal(jolteon.nickname, 'Sparky');
  assert.equal(jolteon.gender, 'F');
  assert.equal(jolteon.shiny, true);
  assert.equal(jolteon.friendship, 0);
  assert.equal(jolteon.item, 179);
  assert.deepEqual(T.hiddenPower(jolteon.ivs), { type: 'Grass', power: 70 });
  assert.equal(nidoran.species, 29);
  assert.deepEqual(problems, ['Nidoran♀: no move called Splash.', 'Mew: not a Pokémon this game has.', 'Ho-Oh: no held item called Lucky Charm.']);
});

test('a team goes out as Showdown\'s text and comes back the same', () => {
  const team = [
    T.normalizeSet({ species: 376, item: 186, nature: 3, moves: [309, 89, 185, 136], evs: [252, 252, 0, 0, 4, 0] }, 376),
    T.normalizeSet({ species: 135, nickname: 'Sparky', gender: 'F', shiny: true, friendship: 0, item: 171, nature: 10, moves: [85, 237],
      evs: [4, 0, 0, 252, 0, 252], ivs: T.hiddenPowerIvs('Grass') }, 135)
  ];
  const text = T.formatShowdown(team, dex, 50);
  assert.match(text, /^Metagross @ Choice Band\nAbility: Clear Body\nLevel: 50\nEVs: 252 HP \/ 252 Atk \/ 4 SpD\nAdamant Nature\n- Meteor Mash\n- Earthquake\n- Feint Attack\n- High Jump Kick\n\nSparky \(Jolteon\) \(F\) @ Petaya Berry/);
  assert.match(text, /- Hidden Power \[Grass\]/);
  assert.deepEqual(T.parseShowdown(text, dex), { sets: team, problems: [] });
});

test('a species learns what any game of the third generation teaches it, not Colosseum\'s alone', () => {
  const { generationMoves } = require('../src/battle-data');
  const machines = Array.from({ length: 58 }, () => 0);
  machines[5] = 92;   // TM06 Toxic
  const learned = new Map(generationMoves(94, machines).map(({ move, how }) => [move, how]));   // Gengar
  assert.equal(learned.get(8), 'Tutor');   // Ice Punch
  assert.equal(learned.get(92), 'TM06');
  assert.equal(learned.get(85), 'TM');     // Thunderbolt, a machine this table leaves out
  assert.ok(!learned.has(261));            // Will-O-Wisp: a TM from generation 4 on
  assert.ok(!learned.has(72));             // Mega Drain: generation 1's TM, which couldn't come to generation 3
  assert.equal(new Map(generationMoves(172, machines).map(({ move, how }) => [move, how])).get(344), 'Egg');   // Pichu: Volt Tackle
  const sketch = new Map(generationMoves(235, machines).map(({ move, how }) => [move, how]));
  assert.equal(sketch.get(147), 'Sketch');   // Smeargle: Spore
  assert.ok(!sketch.has(165));               // but not Struggle
  assert.deepEqual(generationMoves(387, machines), []);   // Turtwig: no Pokémon of later generations
});

// --- The real disc: COLO_TEST_DISC=/path/to/GC6E01.iso npm test
const disc = process.env.COLO_TEST_DISC;
const withDisc = { skip: disc && fs.existsSync(disc) ? false : 'set COLO_TEST_DISC to your disc to run this' };

test('the disc\'s moves, items and learnsets are where the team builder reads them', withDisc, () => {
  const data = require('../src/battle-data').readBattleData(disc);
  assert.equal(data.moves.length, T.MOVE_LAST);
  const move = name => data.moves.find(entry => entry.name === name);
  assert.deepEqual({ ...move('Thunderbolt'), doc: undefined }, { id: 85, name: 'Thunderbolt', type: 'Electric', power: 95, accuracy: 100, pp: 15, priority: 0,
    category: 'Special', contact: false, doc: undefined });
  assert.equal(move('Quick Attack').priority, 1);
  assert.equal(move('Swords Dance').category, 'Status');
  assert.equal(move('Psycho Boost').id, T.MOVE_LAST);
  assert.equal(data.items.find(item => item.name === 'Leftovers').doc, 'A hold item that gradually restores HP in battle.');
  assert.ok(!data.items.some(item => item.name === 'Potion'));
  assert.equal(data.balls.length, 12);
  const umbreon = new Map(data.species[UMBREON].learnset);
  assert.equal(umbreon.get(236), 'Lv 52');     // Moonlight
  assert.equal(umbreon.get(92), 'TM06');       // Toxic
  assert.equal(umbreon.get(204), 'Earlier form');   // Charm, an Eevee egg move
  assert.equal(new Map(data.species[94].learnset).get(8), 'Tutor');   // Gengar: Ice Punch, a FireRed, Emerald and XD tutor move
  assert.equal(new Map(data.species[25].learnset).get(344), 'Earlier form');   // Pikachu: Volt Tackle, a Pichu egg move
  assert.equal(new Map(data.species[400].learnset).get(153), 'Tutor');   // Metagross, by the game's own number: Explosion
  assert.equal(new Map(data.species[235].learnset).get(147), 'Sketch');   // Smeargle: Spore
  assert.equal(data.species[UMBREON].gender, 31);
  assert.deepEqual(data.species[400].abilities.map(ability => ability.name), ['Clear Body']);   // Metagross, by the game's own numbers
  assert.deepEqual(data.species[94].abilities.map(ability => ability.name), ['Levitate']);
  assert.deepEqual(data.species[121].abilities.map(ability => ability.slot), [0, 1]);   // Starmie: Illuminate, Natural Cure
});
