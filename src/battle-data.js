'use strict';

// What the team builder offers, read from the player's disc: every move with its type, power, accuracy and PP, the
// items a Pokémon can hold, each species' abilities and gender ratio, and the moves each species can learn. The tables
// are the game's own (the decomp's waza.c, people_data.c and pokemon_data.h), so what's offered is what the game plays.
// What a species can learn is the whole third generation's, as Pokémon Showdown has it (generations/gen3-learnsets.json,
// made by scripts/generation-data/learnsets.js): Colosseum's own moves, and those of the other games of its generation
// (move tutors, Ruby and Sapphire's level-up moves and so on), as a Pokémon traded in from them would know.
//
// A party of the fourth generation (src/team-sets.js) is offered what that generation has under Pokémon Platinum's
// battle rules (src/generations.js): its Pokémon, its moves, and each move and ability as it plays there, with what each
// Pokémon can learn in that generation (generations/gen4-learnsets.json) and what it could know in the third, as one
// brought over from those games by Pal Park would (`generations[4]`).

const fsys = require('./fsys');
const { Disc } = require('./disc');
const pokedex = require('./pokedex');
const { category } = require('./team-sets');
const GEN3 = require('./generations/gen3-learnsets.json').species;

// common_rel: the moves, 0x38 bytes each, from move 0 (none). The species table follows them.
const MOVES = { offset: 0x11c7c4, size: 0x38, last: 0x162 };   // 0x163 on are the Shadow moves
// main.dol: item rows by a slot that a table of item ids gives, and the machines' moves.
const ITEMS = { rows: 0x80363ce8, size: 0x28, slots: 0x803681e8, count: 0x200 };
const MACHINES = { address: 0x80368018, size: 8, count: 58 };   // TM01 to TM50, then HM01 to HM08
const KIND = { ball: 1, item: 2, berry: 3 };
const ABILITY_DOCS = 3300;
// The bag's own text, where the items' descriptions are: a message table as common_rel's are, at the start of its entry.
const BAG_TEXT = { file: 'pocket_menu.fsys', entry: 0x2e90a00 };
const ABILITY_NAMES = 3100;

// The game's descriptions shout names: FIRE-type, SP. ATK, POKéMON. Here they read as the rest of the launcher does.
function prose(text) {
  return String(text || '').replace(/POKéMON/g, 'Pokémon').replace(/\bSP\./g, 'Sp.')
    .replace(/\b[A-Z][A-Z']{2,}\b/g, word => word[0] + word.slice(1).toLowerCase());
}

function readMoves(data, messages) {
  const moves = [];
  for (let id = 1; id <= MOVES.last; id++) {
    const at = MOVES.offset + id * MOVES.size;
    const name = messages.get(data.readUInt32BE(at + 0x20));
    if (!name) continue;
    const type = pokedex.TYPES[data[at + 0x02]] || '???', power = data.readInt16BE(at + 0x16);
    moves.push({ id, name: pokedex.displayName(name), type, power, accuracy: data[at + 0x04], pp: data[at + 0x01],
      priority: data.readInt8(at), category: power ? category(type) : 'Status',
      contact: Boolean(data[at + 0x06]), doc: prose(messages.get(data.readUInt32BE(at + 0x2c))) });
  }
  return moves;
}

// The items to hold in battle: those the game gives a held effect, and its balls for the Pokémon to come out of.
function readItems(dol, messages, docs) {
  const rows = pokedex.dolOffset(dol, ITEMS.rows), slots = pokedex.dolOffset(dol, ITEMS.slots);
  const items = [], balls = [];
  for (let id = 1; id < ITEMS.count; id++) {
    const slot = dol.readUInt16BE(slots + id * 2);
    if (!slot) continue;
    const at = rows + slot * ITEMS.size, kind = dol[at], name = messages.get(dol.readUInt32BE(at + 0x10));
    if (!name) continue;
    const entry = { id, name: pokedex.displayName(name), doc: prose(docs.get(dol.readUInt32BE(at + 0x14))) };
    if (kind === KIND.ball) balls.push(entry);
    else if ((kind === KIND.item || kind === KIND.berry) && dol.readUInt16BE(at + 0x0a)) items.push({ ...entry, berry: kind === KIND.berry });
  }
  return { items: items.sort((a, b) => a.name.localeCompare(b.name)), balls };
}

function bagText(disc) {
  const text = new Map();
  try {
    const data = fsys.entries(disc.file(BAG_TEXT.file)).find(entry => entry.id === BAG_TEXT.entry)?.data();
    const count = data ? data.readUInt16BE(4) : 0;
    for (let i = 0; i < count && 0x18 + i * 8 <= data.length; i++)
      text.set(data.readUInt32BE(0x10 + i * 8), pokedex.messageText(data, data.readUInt32BE(0x14 + i * 8), 400));
  } catch (_) { /* the items go without descriptions */ }
  return text;
}

function machineMoves(dol) {
  const at = pokedex.dolOffset(dol, MACHINES.address);
  return Array.from({ length: MACHINES.count }, (_, i) => dol.readUInt32BE(at + i * MACHINES.size + 4));
}

const machineName = index => index < 50 ? `TM${String(index + 1).padStart(2, '0')}` : `HM${String(index - 49).padStart(2, '0')}`;

// One species' own moves: by level, by machine, and as an egg (none can hatch in this game, but a traded one can).
function ownMoves(data, at, machines) {
  const moves = [];
  for (let i = 0; i < 20; i++) {
    const level = data[at + 0xba + i * 4], move = data.readUInt16BE(at + 0xba + i * 4 + 2);
    if (level && move) moves.push({ move, how: `Lv ${level}`, order: level });
  }
  for (let i = 0; i < MACHINES.count; i++) if (data[at + 0x34 + i] && machines[i]) moves.push({ move: machines[i], how: machineName(i), order: 200 + i });
  for (let i = 0; i < 8; i++) {
    const move = data.readUInt16BE(at + 0x74 + i * 2);
    if (move) moves.push({ move, how: 'Egg', order: 300 });
  }
  return moves;
}

// What the other games of the generation teach the species of national number `national`, after what the disc gives.
function generationMoves(national, machines) {
  const entry = GEN3[national];
  if (!entry) return [];
  const machine = new Map(machines.map((move, i) => [move, i]).reverse());
  const moves = entry.levelUp.map(([level, move]) => ({ move, how: `Lv ${level}`, order: level }));
  for (const move of entry.tm || []) moves.push({ move, how: machine.has(move) ? machineName(machine.get(move)) : 'TM', order: 200 + (machine.get(move) ?? 60) });
  for (const move of entry.tutor || []) moves.push({ move, how: 'Tutor', order: 270 });
  for (const move of entry.egg || []) moves.push({ move, how: 'Egg', order: 300 });
  for (const move of entry.event || []) moves.push({ move, how: 'Event', order: 350 });
  for (const move of entry.sketch || []) moves.push({ move, how: 'Sketch', order: 380 });
  return moves;
}

function readSpecies(data, messages, machines) {
  const { offset, count, size } = pokedex.SPECIES, rows = new Map();
  for (let id = 0; id < count; id++) {
    const at = offset + id * size;
    if (!data.readUInt16BE(at + 0x12)) continue;
    const abilities = [data[at + 0x32], data[at + 0x33]].map((ability, slot) => ability && {
      slot, id: ability, name: pokedex.displayName(messages.get(ABILITY_NAMES + ability) || ''), doc: prose(messages.get(ABILITY_DOCS + ability)) })
      .filter(ability => ability?.name);
    const evolutions = [];
    for (let i = 0; i < 5; i++) {
      const target = data.readUInt16BE(at + 0x9c + i * 6 + 4);
      if (data[at + 0x9c + i * 6] && target) evolutions.push(target);
    }
    // The second ability only where it differs: the game gives either, and two of one are the same.
    rows.set(id, { gender: data[at + 0x02], abilities: abilities.filter((a, i) => !i || a.id !== abilities[0].id),
      own: [...ownMoves(data, at, machines), ...generationMoves(data.readUInt16BE(at + 0x12), machines)], evolutions });
  }
  // What an earlier form learned comes along when it evolves.
  const before = new Map();
  for (const [id, row] of rows) for (const target of row.evolutions) if (!before.has(target)) before.set(target, id);
  const species = {};
  for (const [id, row] of rows) {
    const learnset = new Map();
    for (let form = id, depth = 0; form !== undefined && depth < 3; form = before.get(form), depth++) {
      for (const { move, how, order } of rows.get(form).own) {
        if (move > MOVES.last || learnset.has(move)) continue;
        learnset.set(move, depth ? { how: 'Earlier form', order: 400 } : { how, order });
      }
    }
    species[id] = { gender: row.gender, abilities: row.abilities,
      learnset: [...learnset].sort((a, b) => a[1].order - b[1].order).map(([move, { how }]) => [move, how]) };
  }
  return species;
}

function readBattleData(rom) {
  const disc = new Disc(rom);
  let base;
  try {
    const rel = fsys.entries(disc.file('common.fsys')).find(entry => entry.name === 'common_rel');
    if (!rel) throw new Error('The game disc has no Pokémon data.');
    const data = pokedex.relData(rel.data()), messages = pokedex.readMessages(data, 400), dol = pokedex.readDol(disc);
    const moves = readMoves(data, messages);
    if (moves[0]?.name !== 'Pound' || moves[0].power !== 40) throw new Error('The move data on this disc isn\'t where it should be.');
    base = { moves, ...readItems(dol, messages, bagText(disc)), species: readSpecies(data, messages, machineMoves(dol)) };
  } finally { disc.close(); }
  return { ...base, generations: { 4: laterGeneration(rom, base) } };
}

// What a later generation's party is offered (the module's header): { moves: [as readMoves's, the generation's numbers
// and text], species: { id: { name, national, gender, abilities, learnset } } } for the game's own Pokémon and the
// generation's new ones, by the game's numbers. `tables` is src/pokemon-packs.js readGameTables's.
function laterGeneration(rom, base, generation = 4, tables = null) {
  const generations = require('./generations'), pokemonPacks = require('./pokemon-packs');
  const data = generations.load(generation), learned = require(`./generations/gen${generation}-learnsets.json`).species;
  tables ||= pokemonPacks.readGameTables(rom);
  const built = generations.build(tables, { battleRules: generation, generationPokemon: [generation] });
  const rows = pokemonPacks.generationPokemon(tables, built).pokemon;
  const moveId = number => number < generations.FIRST_NEW_MOVE ? number : number + generations.MOVE_OFFSET;
  const disc = new Map(base.moves.map(move => [move.id, move])), added = new Set(built.moves.map(move => move.id));
  // each move the game plays under these rules: Colosseum's own by its name, with the generation's numbers
  const moves = [];
  for (const [number, move] of Object.entries(data.moves).map(([n, move]) => [Number(n), move])) {
    const id = moveId(number), own = disc.get(id);
    if (number < generations.FIRST_NEW_MOVE ? !own : !added.has(id)) continue;
    // a move whose power is worked out as it's used has 1 (Colosseum's Spit Up keeps its own: generations.js rules)
    const power = move.power === 1 && own ? own.power : move.power;
    moves.push({ id, name: own ? own.name : move.name, type: move.type, power, accuracy: move.accuracy, pp: move.pp,
      priority: move.priority, category: move.category, contact: Boolean(move.contact), doc: move.description || own?.doc || '' });
  }
  const playable = new Set(moves.map(move => move.id));

  // the game's numbers for each National Pokédex number: its own Pokémon's, then the generation's
  const idOf = new Map(), nationalOf = new Map();
  for (const each of tables.species) if (each.national >= 1 && each.national < data.newSpecies[0] && !idOf.has(each.national)) idOf.set(each.national, each.id);
  for (const each of rows) idOf.set(each.national, each.id);
  for (const [national, id] of idOf) nationalOf.set(id, national);

  // abilities by the game's number: the disc's names, as the game shows them, with what they do under these rules
  const discAbilities = new Map();
  for (const entry of Object.values(base.species)) for (const ability of entry.abilities) discAbilities.set(ability.id, ability);
  const ability = (id, slot) => {
    const later = data.abilities[id === 124 ? 77 : id], own = discAbilities.get(id);   // 124: Tangled Feet (generations.js colosseumAbility)
    const name = own?.name || (later && pokedex.displayName(later.name));
    return name ? { slot, id, name, doc: later?.description || own?.doc || '' } : null;
  };
  const changed = new Map((built.rules?.species || []).map(each => [each.id, each.abilities]));
  const abilitiesOf = ids => ids.map((id, slot) => id ? ability(id, slot) : null).filter(Boolean)
    .filter((each, i, all) => !i || each.id !== all[0].id);

  // what each learns in the generation itself, by the game's numbers
  const ownMoves = new Map();
  for (const [national, entry] of Object.entries(learned)) {
    const id = idOf.get(Number(national));
    if (!id) continue;
    const list = [...entry.levelUp.map(([level, move]) => [move, `Lv ${level}`]), ...(entry.tm || []).map(move => [move, 'TM']),
      ...(entry.tutor || []).map(move => [move, 'Tutor']), ...(entry.egg || []).map(move => [move, 'Egg']),
      ...(entry.event || []).map(move => [move, 'Event']), ...(entry.sketch || []).map(move => [move, 'Sketch'])];
    ownMoves.set(id, list.map(([move, how]) => [moveId(move), how]).filter(([move]) => playable.has(move)));
  }
  // and what it could know in the third, brought over from those games
  const fromBefore = id => (base.species[id]?.learnset || []).filter(([, how]) => how !== 'Earlier form')
    .map(([move, how]) => [move, `${how} (Gen ${generation - 1})`]).filter(([move]) => playable.has(move));
  const parent = new Map();
  for (const [national, entry] of Object.entries(data.species))
    for (const evolution of entry.evolutions || []) if (!parent.has(evolution.into)) parent.set(evolution.into, Number(national));

  const species = {};
  for (const [id, national] of nationalOf) {
    const row = id >= data.newSpecies[0] + generations.SPECIES_OFFSET ? rows.find(each => each.id === id)?.row : tables.species.find(each => each.id === id)?.row;
    if (!row) continue;
    const learnset = new Map();
    for (let form = national, depth = 0; form && depth < 3; form = parent.get(form), depth++) {
      const formId = idOf.get(form);
      for (const [move, how] of [...(ownMoves.get(formId) || []), ...fromBefore(formId)])
        if (!learnset.has(move)) learnset.set(move, depth ? 'Earlier form' : how);
    }
    species[id] = { name: pokedex.displayName(data.species[national].name), national, gender: row[0x02],
      abilities: abilitiesOf(changed.get(id) || [row[0x32], row[0x33]]), learnset: [...learnset] };
  }
  return { generation, moves, species };
}

// Kept once read: the team builder and each battle ask again.
function create(read = readBattleData) {
  let kept = null;
  return rom => {
    if (kept?.rom !== rom) kept = { rom, data: read(rom) };
    return kept.data;
  };
}

module.exports = { create, readBattleData, laterGeneration, generationMoves, prose, MOVES };
