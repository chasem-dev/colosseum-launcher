'use strict';

// Battle mechanics, each a choice of its own: what a later generation changed about how a battle plays, by name. A
// generation's battle rules (Settings → Gameplay → Battle rules, a room's Rules) are a preset of them, and a player can
// turn any of them on or off on top (Mechanics). Shared by the main process, the settings page, the Online page and the
// room server (which keeps a copy of src/formats.js and this file), so it needs nothing but itself.
//
// Each mechanic is one of:
//   - the game's: a bit of the features the expansion file's MECH chunk gives the game (host/mechanics.c, FEATURE_*),
//     which its battle code tests; a generation's own engine (Pokémon Platinum's battle code, host/gen4.c) plays them,
//     so they need rules of generation 4 or later (`engine`);
//   - the launcher's: what the launcher writes into the game's tables (src/generations.js): base stats, types.
// A mechanic later generations changed again is the generation that changed it last before the preset's (generation 6
// is the latest the presets go to).
(function (root) {
  const MECHANICS = [
    { id: 'physicalSpecialSplit', bit: 0, generation: 4, engine: false, name: 'Physical/special split',
      note: 'Each move is physical or special by itself, not by its type.' },
    { id: 'sandstormRockSpecialDefense', bit: 1, generation: 4, engine: false, name: 'Sandstorm boosts Rock types',
      note: 'A sandstorm raises Rock types\' Sp. Def by half.' },
    { id: 'gen6Types', generation: 6, engine: false, name: 'Gen 6 types',
      note: 'The Fairy type and generation 6\'s type chart, the Pokémon and moves it made Fairy types, and the Fairy moves.' },
    { id: 'gen6Stats', generation: 6, engine: false, name: 'Gen 6 base stats',
      note: 'Generation 6\'s higher base stats for Pikachu, Butterfree, Beedrill, Clefable and the others it changed.' },
    { id: 'criticalHits', bit: 2, generation: 6, engine: true, name: 'Gen 6 critical hits',
      note: 'A critical hit does 1.5 times the damage, not twice, and a raised critical-hit ratio rises faster.' },
    { id: 'sleep', bit: 3, generation: 5, engine: true, name: 'Shorter sleep',
      note: 'Sleep lasts 1 to 3 turns, not 1 to 4.' },
    { id: 'electricParalysis', bit: 4, generation: 6, engine: true, name: 'Electric types can\'t be paralyzed',
      note: 'Electric-type Pokémon can\'t be paralyzed.' },
    { id: 'powder', bit: 5, generation: 6, engine: true, name: 'Powder immunity',
      note: 'Grass types aren\'t affected by powder and spore moves: Spore, Sleep Powder, Stun Spore, Poison Powder and Cotton Spore.' },
    { id: 'ghostTrapping', bit: 6, generation: 6, engine: true, name: 'Ghost types escape traps',
      note: 'Ghost-type Pokémon can always switch out: Mean Look, Block, Shadow Tag, Arena Trap and binding moves don\'t hold them.' },
    { id: 'weatherTurns', bit: 7, generation: 6, engine: true, name: 'Weather abilities last 5 turns',
      note: 'Drizzle, Drought, Sand Stream and Snow Warning\'s weather lasts 5 turns (8 with its rock), not until it\'s replaced.' },
    { id: 'protect', bit: 8, generation: 6, engine: true, name: 'Gen 6 Protect',
      note: 'Each Protect, Detect or Endure in a row is a third as likely to work, not half.' },
    { id: 'multiHit', bit: 9, generation: 5, engine: true, name: 'Gen 5 multi-hit moves',
      note: 'Moves that hit 2 to 5 times hit 2 or 3 times more often (35% each) and 4 or 5 times less (15% each).' },
    { id: 'damage', bit: 10, generation: 5, engine: true, name: 'Gen 5 damage',
      note: 'Damage is worked out as generations 5 and 6 do it: its boosts in 4096ths, in their order, rounded as they round.' },
    { id: 'soundSubstitute', bit: 11, generation: 6, engine: true, name: 'Sound moves pass substitutes',
      note: 'Sound moves such as Hyper Voice hit through a substitute.' },
    { id: 'moves', bit: 12, generation: 6, engine: true, name: 'Gen 6 move effects',
      note: 'Knock Off does half again to a Pokémon holding an item, Hidden Power is always 60, Toxic never misses when a Poison type uses it, Defog clears hazards from both sides, Wring Out and Crush Grip go by the HP as generation 5 works it, Disable, Encore and Taunt last generation 6\'s turns, and binding moves last 4 or 5 turns (7 with Grip Claw) and hurt an eighth.' },
    { id: 'abilities', bit: 13, generation: 6, engine: true, name: 'Gen 6 abilities',
      note: 'Sturdy survives a hit from full HP with 1 HP left, Lightning Rod and Storm Drain take their type\'s moves and raise Sp. Atk, Effect Spore doesn\'t affect Grass types, Keen Eye ignores the target\'s raised evasion, Frisk shows every foe\'s item, Oblivious stops Taunt, and Stench may make the target flinch.' },
    { id: 'items', bit: 14, generation: 6, engine: true, name: 'Gen 6 items',
      note: 'Assault Vest, Eviolite, Rocky Helmet and Weakness Policy can be held, in the team builder and online, and Mental Herb also cures Taunt, Encore, Torment and Disable.' },
    { id: 'hiddenAbilities', bit: 15, generation: 5, engine: true, name: 'Hidden abilities',
      note: 'A Pokémon can have its hidden ability, where it\'s one the game has (Ninetales\' Drought), in the team builder and online.' }
  ];
  const byId = new Map(MECHANICS.map(each => [each.id, each]));
  // The generations whose battle rules there are, the last first: Colosseum's own (3), Pokémon Platinum's (4), X and Y's (6)
  const GENERATIONS = [3, 4, 6];

  // The mechanics a generation's rules have, by id
  const preset = generation => MECHANICS.filter(each => each.generation <= generation && generation >= 4).map(each => each.id);

  // A choice of mechanics as kept: the preset of `generation` with `changes` ({ id: true or false }) on top, sorted as
  // MECHANICS lists them; a mechanic of the engine needs rules of generation 4 or later.
  function choose(generation, changes = {}) {
    const on = new Set(preset(generation));
    for (const [id, value] of Object.entries(changes && typeof changes === 'object' ? changes : {})) {
      if (!byId.has(id) || typeof value !== 'boolean') continue;
      if (value) on.add(id); else on.delete(id);
    }
    return MECHANICS.filter(each => on.has(each.id) && (!each.engine || generation >= 4)).map(each => each.id);
  }

  // The changes a choice makes to its generation's preset: { id: true or false }, for the settings to keep
  function changesFrom(generation, chosen) {
    const base = new Set(preset(generation)), have = new Set(chosen), out = {};
    for (const each of MECHANICS) if (base.has(each.id) !== have.has(each.id)) out[each.id] = have.has(each.id);
    return out;
  }

  // The bits of the game's features for a choice (the MECH chunk's u32)
  const features = chosen => chosen.reduce((bits, id) => byId.get(id)?.bit === undefined ? bits : bits | (1 << byId.get(id).bit), 0) >>> 0;
  const has = (chosen, id) => Array.isArray(chosen) && chosen.includes(id);

  const api = { MECHANICS, GENERATIONS, preset, choose, changesFrom, features, has, get: id => byId.get(id) };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.coloMechanics = api;
})(typeof self !== 'undefined' ? self : this);
