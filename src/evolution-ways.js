'use strict';

// How a Pokémon evolves, as the Pokédex says it: { text, note }, text short enough for the arrow between two Pokémon
// and note, when there is one, what the player should know besides (that it can't happen in this game, or how Platinum
// had it). An evolution is a species row's 6 bytes: its kind, what that needs (`condition`), and what it evolves into.
//
// Kinds 1 to 15 are the third generation's, which both games keep (getEvoPokemonLevelUp and pokemonEvolutionCheck in
// the decompilation). XD's 16 is its own: friendship with an item in the bag (Eevee's Sun and Moon Shards). The rows
// the launcher writes (Pokémon packs and later generations, pokemon-packs.js EVOLVE) are in Colosseum's numbers, with the
// port's kinds from 16 (host/evolutions.c), XD's game making them its own as it loads them.

const ITEMS = { 93: 'Sun Stone', 94: 'Moon Stone', 95: 'Fire Stone', 96: 'Thunder Stone', 97: 'Water Stone', 98: 'Leaf Stone',
  187: 'King\'s Rock', 192: 'Deep Sea Tooth', 193: 'Deep Sea Scale', 199: 'Metal Coat', 201: 'Dragon Scale', 218: 'Up-Grade',
  516: 'Sun Shard', 517: 'Moon Shard' };
const NO_CLOCK = 'The game keeps no time of day, so it can\'t evolve this way here.';

const itemName = id => ITEMS[id] || 'an item';
const article = name => `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;

// The move the port's kind 16 names: Colosseum's numbers to 354, then a later generation's, numbered 3 past its own
// (generations.js colosseumMove).
function moveName(id) {
  try {
    const moves = require('./generations').load(4).moves;
    return moves[id >= 358 ? id - 3 : id]?.name || 'a move';
  } catch { return 'a move'; }
}

// `game`: 'xd' for a row of XD's own disc, else Colosseum's numbers. `speciesName(id)`: a species row's name, for the
// port's kind 17.
function describe(kind, condition, { game = 'colosseum', speciesName = () => null } = {}) {
  switch (kind) {
    case 1: return { text: 'High friendship' };
    case 2: return { text: 'High friendship in the day', note: NO_CLOCK, blocked: true };
    case 3: return { text: 'High friendship at night', note: NO_CLOCK, blocked: true };
    case 4: return { text: `Level ${condition}`, level: condition };
    case 5: return { text: 'Trade' };
    case 6: return { text: `Trade holding ${itemName(condition)}` };
    case 7: return { text: itemName(condition) };
    case 8: return { text: `Level ${condition}, Attack above Defense` };
    case 9: return { text: `Level ${condition}, Attack equal to Defense` };
    case 10: return { text: `Level ${condition}, Defense above Attack` };
    case 11: case 12:
      return { text: `Level ${condition}, by personality`, note: 'Which of the two it becomes is set by its personality, half and half.' };
    case 13: return { text: `Level ${condition}` };
    case 14: return { text: `Level ${condition}, with room in the party`, note: 'It appears beside Ninjask when Nincada evolves, if there is a free place in the party.' };
    case 15: return { text: 'High Beauty', note: 'Beauty can\'t be raised in this game, so only one traded in with high Beauty evolves.', blocked: true };
  }
  if (game === 'xd') {
    if (kind === 16) return { text: `High friendship, ${itemName(condition)} in the bag` };
    kind--;   // the port's kinds, one later in XD
  }
  switch (kind) {
    case 16: return { text: `Level up knowing ${moveName(condition)}` };
    case 17: return { text: `Level up with ${speciesName(condition) || 'another Pokémon'} in the party` };
    case 18: return { text: `Level ${condition}, male`, level: condition, gender: 'male' };
    case 19: return { text: `Level ${condition}, female`, level: condition, gender: 'female' };
  }
  return { text: 'A way of its own' };
}

// Notes for one Pokémon's evolutions by level that overlap, as the port's for one gender do the game's own (Kirlia's
// into Gardevoir at 30 and Gallade at 35, male): where both could happen the higher level's is taken
// (host/evolutions.c), so the lower comes first, and is stopped with B for the other. `ways` are describe's for each
// evolution and `names` what each evolves into; gives the ways back with those notes added.
function overlappingLevels(ways, names) {
  const who = gender => gender ? `a ${gender} one` : 'it';
  return ways.map((way, i) => {
    if (!way.level) return way;
    const extra = [];
    ways.forEach((other, j) => {
      if (j === i || !other.level || other.level === way.level || (way.gender && other.gender && way.gender !== other.gender)) return;
      const whose = other.gender && !way.gender ? who(other.gender) : 'it';
      if (other.level < way.level)
        extra.push(`${capital(whose)} evolves into ${names[j]} at level ${other.level} first: press B to stop that, and it evolves into ${names[i]} from level ${way.level}.`);
      else extra.push(`From level ${other.level}, ${whose} evolves into ${names[j]} instead.`);
    });
    return extra.length ? { ...way, note: [way.note, ...extra].filter(Boolean).join(' ') } : way;
  });
}
const capital = text => text[0].toUpperCase() + text.slice(1);

// A 6-byte evolution (kind, 0, condition, into) at `at` of a row
const describeBytes = (row, at, options) => describe(row[at], row.readUInt16BE(at + 2), options);

// How Platinum has `from` evolve into `into` (National Pokédex numbers), when the game does it another way: an item, a
// held item, a trade holding one, or a place. Null where the two are the same, or Platinum has no such evolution.
function platinumWay(from, into) {
  let evolution;
  try { evolution = require('./generations').load(4).species[from]?.evolutions.find(each => each.into === into); } catch { return null; }
  if (!evolution) return null;
  const time = evolution.time ? ` ${evolution.time === 'day' ? 'in the day' : 'at night'}` : '';
  if (evolution.place === 'magnetic field') return 'In Platinum, it evolves as it levels up at Mt. Coronet.';
  if (evolution.place === 'moss rock') return 'In Platinum, it evolves as it levels up near the Moss Rock in Eterna Forest.';
  if (evolution.place === 'ice rock') return 'In Platinum, it evolves as it levels up near the Ice Rock on Route 217.';
  if (evolution.place) return `In Platinum, it evolves as it levels up at ${article(evolution.place)}.`;
  if (evolution.heldItem) return `In Platinum, it evolves as it levels up holding ${article(evolution.heldItem)}${time}.`;
  if (typeof evolution.trade === 'string' && !gameHas(evolution.trade)) return `In Platinum, it evolves when traded holding ${article(evolution.trade)}.`;
  if (evolution.item && !gameHas(evolution.item)) return `In Platinum, it evolves with ${article(evolution.item)}.`;
  return null;
}

// Whether an item of Platinum's (named as Showdown names them: Thunderstone, Deepseatooth) is one the game has
const itemKey = name => name.toLowerCase().replace(/[^a-z']/g, '');
const gameHas = name => Object.values(ITEMS).some(item => itemKey(item) === itemKey(name));

// Platinum's evolutions into `into` that the game can't make (Eevee's at the Moss and Ice Rocks): [{ from, text, note }]
function platinumOnly(into) {
  let data;
  try { data = require('./generations').load(4); } catch { return []; }
  const out = [];
  for (const [from, entry] of Object.entries(data.species))
    for (const evolution of entry.evolutions || []) {
      if (evolution.into !== into || !evolution.place || data.colosseum.evolutionPlaces?.[evolution.place]) continue;
      out.push({ from: Number(from), text: 'Can\'t evolve here', note: `${platinumWay(Number(from), into)} This game has no such place.`, blocked: true });
    }
  return out;
}

module.exports = { describe, describeBytes, overlappingLevels, platinumWay, platinumOnly, ITEMS };
