'use strict';

// Online battle formats: a room's rules, how the Online page names them, and which parties they allow.
//
// A room plays one format: Casual (the default: a level and how many each, no clauses), or one of the competitive
// formats players already know from Pokémon Showdown and OrreLink, each of which a host can change. A room's rules are
// its format's settings with the host's changes; a room whose rules are a named variant (Orre Limited) shows that
// name, and any other change shows as "Orre Colosseum* (custom)" with what changed.
//
// What the battle itself checks (the sleep, freeze and self-KO clauses, a last Pokémon's Perish Song and Destiny Bond,
// the other player's HP as a bar) the game does, as its own Battle Mode rules (the game's host/online.c, rulesLine
// here). What a party may hold (which Pokémon, items, moves and abilities) is checked here, by the launcher before it
// makes or joins a room, and by the room server (colosseum-server-api keeps a copy of this file) before a battle.
//
// Species, moves, items and abilities are the game's numbers: the third generation's, with the Hoenn Pokémon at
// 277 to 411. Shared by the main process, the Online page and the room server, so it needs nothing but itself.
(function (root) {
  const LEVELS = [50, 100];
  const BEST_OF = [1, 3, 5];
  const SIZES = { single: [3, 6], double: [4, 6] };
  const POOLS = ['any', 'restricted', 'legends', 'ou'];
  const SLEEP = ['off', 'stadium', 'smogon'];
  // Whose battle rules both games play by, whatever the format: Colosseum's own (3), or Pokémon Platinum's (4, the
  // launcher's src/generations.js). Not a change to a format: any format plays by either.
  const BATTLE_RULES = [3, 4];
  const PLATINUM_RULES = 'Pokémon Platinum\'s battle rules';

  // Box legendaries, mythical Pokémon, and the other legendaries (the game's numbers, which are the National Pokédex's
  // up to Celebi).
  const RESTRICTED = [150, 249, 250, 404, 405, 406];   // Mewtwo, Lugia, Ho-Oh, Kyogre, Groudon, Rayquaza
  const MYTHICAL = [151, 251, 409, 410];               // Mew, Celebi, Jirachi, Deoxys
  const LEGENDARY = [144, 145, 146, 243, 244, 245, 401, 402, 403, 407, 408];   // birds, beasts, Regis, Latias, Latios
  // Smogon's third-generation Ubers (Showdown's data/mods/gen3/formats-data.ts)
  const UBERS = [150, 151, 249, 250, 404, 405, 406, 407, 408, 410, 202, 360];   // ... Latias, Latios, Deoxys, Wobbuffet, Wynaut
  const POOL_BANS = { any: [], restricted: [...RESTRICTED, ...MYTHICAL], legends: [...RESTRICTED, ...MYTHICAL, ...LEGENDARY], ou: UBERS };

  const MOVE = { fissure: 90, guillotine: 12, hornDrill: 32, sheerCold: 329, doubleTeam: 104, minimize: 107, assist: 274,
    swagger: 207, ingrain: 275, batonPass: 226, block: 335, meanLook: 212, spiderWeb: 169 };
  const ITEM = { soulDew: 191, brightPowder: 179, laxIncense: 221, quickClaw: 183 };
  const ABILITY = { sandVeil: 8, soundproof: 43, speedBoost: 3, arenaTrap: 71, magnetPull: 42, shadowTag: 23 };
  const SMEARGLE = 235;
  const OHKO = [MOVE.fissure, MOVE.guillotine, MOVE.hornDrill, MOVE.sheerCold];
  const EVASION_MOVES = [MOVE.doubleTeam, MOVE.minimize];
  const EVASION_ITEMS = [ITEM.brightPowder, ITEM.laxIncense];
  // Showdown's rules for Baton Pass and trapping in [Gen 3] OU (data/rulesets.ts), as far as the third generation has
  // them. Moves, then items, then abilities, by the game's numbers.
  const TRAPPING_MOVES = [MOVE.block, MOVE.meanLook, MOVE.spiderWeb];
  const TRAPPING_ABILITIES = [ABILITY.arenaTrap, ABILITY.magnetPull, ABILITY.shadowTag];
  const ACCURACY_DROPS = [28, 108, 134, 148, 189];   // Sand-Attack, Smokescreen, Kinesis, Flash, Mud-Slap
  const SPEED_BOOSTS = { moves: [97, 349, 246, 318], items: [170, 174], abilities: [ABILITY.speedBoost] };   // Agility, Dragon Dance, AncientPower, Silver Wind; Salac, Starf
  const STAT_BOOSTS = {
    // Acid Armor, Agility, Amnesia, Barrier, Belly Drum, Bulk Up, Calm Mind, Cosmic Power, Curse, Defense Curl,
    // Dragon Dance, Growth, Harden, Howl, Iron Defense, Meditate, Sharpen, Swords Dance, Tail Glow, Withdraw
    moves: [151, 97, 133, 112, 187, 339, 347, 322, 174, 111, 349, 74, 106, 336, 334, 96, 159, 14, 294, 110],
    items: [172, 169, 168, 171, 170, 174],   // Apicot, Ganlon, Liechi, Petaya, Salac, Starf
    abilities: [ABILITY.speedBoost]
  };
  // The abilities those rules ask about, for the species that can have them: [first, second].
  const ABILITIES = { 27: [8], 28: [8], 50: [8, 71], 51: [8, 71], 81: [42, 5], 82: [42, 5], 100: [43, 9], 101: [43, 9], 122: [43],
    193: [3, 14], 202: [23], 207: [52, 8], 302: [3], 320: [5, 42], 332: [52, 71], 344: [8], 345: [8], 360: [23], 370: [43],
    371: [43], 372: [43] };

  const OFF = { preview: false, pool: 'any', soulDew: true, speciesClause: false, itemClause: false, sleep: 'off', freeze: false,
    selfKO: false, lastMon: false, hideHp: false, ohko: false, evasion: false, smogonBans: false };
  // Each format's settings. Casual is the rooms from before formats: the host picks its level and how many each.
  const FORMATS = {
    casual: { name: 'Casual', ...OFF, level: 50, battle: 'single', size: 6 },
    orre: { name: 'Orre Colosseum', ...OFF, level: 100, battle: 'double', size: 4, preview: true, pool: 'restricted', soulDew: false,
      speciesClause: true, itemClause: true, sleep: 'stadium', freeze: true, selfKO: true, lastMon: true },
    hoenn: { name: 'Hoenn Stadium', ...OFF, level: 100, battle: 'single', size: 3, preview: true, pool: 'restricted', soulDew: false,
      speciesClause: true, itemClause: true, sleep: 'stadium', freeze: true, selfKO: true, lastMon: true },
    gen3ou: { name: 'Gen 3 OU', ...OFF, level: 100, battle: 'single', size: 6, pool: 'ou', speciesClause: true, sleep: 'smogon',
      freeze: true, hideHp: true, ohko: true, evasion: true, smogonBans: true }
  };
  const FORMAT_IDS = Object.keys(FORMATS);
  const SETTINGS = ['level', 'battle', 'size', 'preview', 'pool', 'soulDew', 'speciesClause', 'itemClause', 'sleep', 'freeze',
    'selfKO', 'lastMon', 'hideHp', 'ohko', 'evasion', 'smogonBans'];
  // Changes with names of their own, as players have called them for years.
  const VARIANTS = [
    { name: 'Orre Unlimited', format: 'orre', changes: { pool: 'any', soulDew: true } },
    { name: 'Orre Limited', format: 'orre', changes: { level: 50, pool: 'legends' } },
    { name: 'Hoenn Unlimited', format: 'hoenn', changes: { pool: 'any', soulDew: true } },
    { name: 'Hoenn Limited', format: 'hoenn', changes: { level: 50, pool: 'legends' } }
  ];

  const POOL_TEXT = { any: 'all Pokémon allowed', restricted: 'no box legendaries or mythical Pokémon',
    legends: 'no legendary or mythical Pokémon', ou: 'no Ubers' };
  const SLEEP_TEXT = { off: 'no sleep clause', stadium: 'sleep clause', smogon: 'sleep clause (Smogon\'s: Rest doesn\'t count)' };
  const on = (value, text, offText) => value ? text : offText;
  // One setting as the room list says it.
  const DESCRIBE = {
    level: value => `Level ${value}`,
    battle: value => value === 'double' ? 'double battles' : 'single battles',
    size: (value, rules) => rules.preview ? `bring 6, pick ${value}` : `${value} each`,
    preview: value => on(value, 'team preview', 'no team preview'),
    pool: value => POOL_TEXT[value],
    soulDew: value => on(value, 'Soul Dew allowed', 'no Soul Dew'),
    speciesClause: value => on(value, 'species clause', 'no species clause'),
    itemClause: value => on(value, 'item clause', 'no item clause'),
    sleep: value => SLEEP_TEXT[value],
    freeze: value => on(value, 'freeze clause', 'no freeze clause'),
    selfKO: value => on(value, 'self-KO clause', 'no self-KO clause'),
    lastMon: value => on(value, 'no Perish Song or Destiny Bond from a last Pokémon', 'Perish Song and Destiny Bond allowed on a last Pokémon'),
    hideHp: value => on(value, 'opponent\'s HP as a bar', 'opponent\'s exact HP shown'),
    ohko: value => on(value, 'no one-hit KO moves', 'one-hit KO moves allowed'),
    evasion: value => on(value, 'no evasion moves or items', 'evasion moves and items allowed'),
    smogonBans: value => on(value, 'Smogon\'s OU bans', 'none of Smogon\'s OU bans')
  };

  const has = (list, value) => list.includes(value);
  const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;

  // A room's rules from what a host sent (or a launcher saved): its format's settings, with each change the format
  // allows. Anything else is the format's own. Without a format, Casual (as rooms from before formats are).
  function normalize(input) {
    const format = FORMAT_IDS.includes(input?.format) ? input.format : 'casual';
    const base = FORMATS[format], rules = { format };
    for (const key of SETTINGS) rules[key] = base[key];
    rules.level = has(LEVELS, input?.level) ? input.level : base.level;
    if (format === 'casual') {
      // Casual is a level and how many each, as rooms always were
      rules.size = has(SIZES.single, input?.size) ? input.size : base.size;
    } else {
      rules.battle = input?.battle === 'double' || input?.battle === 'single' ? input.battle : base.battle;
      rules.size = has(SIZES[rules.battle], input?.size) ? input.size : has(SIZES[rules.battle], base.size) ? base.size : SIZES[rules.battle][0];
      rules.preview = bool(input?.preview, base.preview);
      rules.pool = has(POOLS, input?.pool) ? input.pool : base.pool;
      rules.sleep = has(SLEEP, input?.sleep) ? input.sleep : base.sleep;
      for (const key of ['soulDew', 'speciesClause', 'itemClause', 'freeze', 'selfKO', 'lastMon', 'hideHp', 'ohko', 'evasion', 'smogonBans'])
        rules[key] = bool(input?.[key], base[key]);
    }
    rules.battleRules = has(BATTLE_RULES, input?.battleRules) ? input.battleRules : BATTLE_RULES[0];
    rules.stage = Number.isInteger(input?.stage) && input.stage >= 0 ? input.stage : 0;
    return rules;
  }

  const bestOf = value => has(BEST_OF, value) ? value : 1;

  // What the rules change from their format's settings: [key, ...].
  function changes(rules) {
    const base = FORMATS[rules.format] || FORMATS.casual;
    return SETTINGS.filter(key => rules[key] !== base[key]);
  }

  // How the room list names the rules: { name, custom, changes: [text], summary }. A Casual room is its level and
  // size. Pokémon Platinum's battle rules follow the summary, as they aren't a change to the format.
  function describe(input) {
    const rules = normalize(input), described = describeFormat(rules);
    return rules.battleRules === 4 ? { ...described, summary: `${described.summary} · ${PLATINUM_RULES}` } : described;
  }

  function describeFormat(rules) {
    const base = FORMATS[rules.format];
    if (rules.format === 'casual') return { name: base.name, custom: false, changes: [], summary: `Level ${rules.level}, ${rules.size} Pokémon each` };
    const changed = changes(rules);
    const variant = VARIANTS.find(each => each.format === rules.format
      && changed.length === Object.keys(each.changes).length && changed.every(key => each.changes[key] === rules[key]));
    if (!changed.length || variant) return { name: variant ? variant.name : base.name, custom: false, changes: [], summary: variant ? variant.name : base.name };
    const text = changed.map(key => DESCRIBE[key](rules[key], rules));
    return { name: `${base.name}*`, custom: true, changes: text, summary: `${base.name}* (custom): ${text.join(', ')}` };
  }

  // A format's rules, for the page to list: what it plays and the rules that apply, [text].
  function rulesText(input) {
    const rules = normalize(input);
    const out = rules.format === 'casual' ? [`Level ${rules.level}`, `${rules.size} Pokémon each`, 'no clauses']
      : ['level', 'battle', 'size'].map(key => DESCRIBE[key](rules[key], rules));
    if (rules.battleRules === 4) out.push(PLATINUM_RULES);
    if (rules.format === 'casual') return out;
    if (!rules.preview && rules.size === 6) out.push(DESCRIBE.preview(false));
    if (rules.pool !== 'any') out.push(DESCRIBE.pool(rules.pool));
    if (!rules.soulDew) out.push(DESCRIBE.soulDew(false));
    for (const key of ['speciesClause', 'itemClause']) if (rules[key]) out.push(DESCRIBE[key](true));
    if (rules.sleep !== 'off') out.push(DESCRIBE.sleep(rules.sleep));
    for (const key of ['freeze', 'selfKO', 'lastMon', 'hideHp', 'ohko', 'evasion', 'smogonBans']) if (rules[key]) out.push(DESCRIBE[key](true));
    return out;
  }

  // The game's rules line for these rules (host/online.c take_rules), or null when there's nothing for it to check.
  function rulesLine(input) {
    const rules = normalize(input);
    const values = { double: rules.battle === 'double' ? 1 : 0, sleep: SLEEP.indexOf(rules.sleep), freeze: +rules.freeze,
      selfko: +rules.selfKO, lastmon: +rules.lastMon, hp: +rules.hideHp };
    if (!Object.values(values).some(Boolean)) return null;
    return `rules ${Object.entries(values).map(([key, value]) => `${key}=${value}`).join(' ')}`;
  }

  // A party member as these rules look at it: { species, item, ability (the game's number, or 0), moves }.
  // From a member as the room sends it (src/story-party.js wireMember: species, personality, trainer, ball, ability
  // slot, item, friendship, (move, PP Ups) x4, ...) or from the species alone (its level-up moves, no item).
  function member(species, wire) {
    if (!Array.isArray(wire) || wire[0] !== species) return { species, item: 0, ability: 0, moves: [] };
    const abilities = ABILITIES[species] || [];
    return { species, item: wire[5] || 0, ability: abilities[wire[4] === 1 && abilities[1] ? 1 : 0] || 0,
      moves: [wire[7], wire[9], wire[11], wire[13]].filter(move => Number.isInteger(move) && move > 0) };
  }

  // Why a party can't play under these rules: [text], empty when it can. party: species; members: their wire members,
  // when it has them; name(species), item(id) and move(id) give names for the messages.
  function problems(input, party, members = null, names = {}) {
    const rules = normalize(input);
    const species = id => names.species?.(id) || `Pokémon #${id}`;
    const itemName = id => names.item?.(id) || `item #${id}`;
    const moveName = id => names.move?.(id) || `move #${id}`;
    const out = [];
    const list = (Array.isArray(party) ? party : []).filter(Boolean);
    if (list.length < rules.size) out.push(`This room plays ${rules.size} Pokémon each: your party has ${list.length}.`);
    if (rules.format === 'casual') return out;
    const team = list.map((id, slot) => member(id, Array.isArray(members) ? members[slot] : null));
    const banned = POOL_BANS[rules.pool];
    for (const each of team) if (has(banned, each.species)) out.push(`${species(each.species)} isn't allowed (${POOL_TEXT[rules.pool]}).`);
    if (rules.speciesClause) {
      const seen = new Set();
      for (const each of team) {
        if (seen.has(each.species)) out.push(`Two ${species(each.species)}: species clause allows one of each.`);
        seen.add(each.species);
      }
    }
    if (rules.itemClause) {
      const seen = new Set();
      for (const each of team.filter(each => each.item)) {
        if (seen.has(each.item)) out.push(`Two Pokémon hold ${itemName(each.item)}: item clause allows one of each.`);
        seen.add(each.item);
      }
    }
    if (!rules.soulDew) for (const each of team) if (each.item === ITEM.soulDew) out.push(`${species(each.species)} holds Soul Dew, which isn't allowed.`);
    for (const each of team) {
      const bad = [];
      if (rules.ohko) bad.push(...each.moves.filter(move => has(OHKO, move)));
      if (rules.evasion) bad.push(...each.moves.filter(move => has(EVASION_MOVES, move)));
      if (rules.smogonBans) bad.push(...each.moves.filter(move => move === MOVE.assist || move === MOVE.swagger));
      for (const move of bad) out.push(`${species(each.species)} knows ${moveName(move)}, which isn't allowed.`);
      if (rules.evasion && has(EVASION_ITEMS, each.item)) out.push(`${species(each.species)} holds ${itemName(each.item)}, which isn't allowed (no evasion items).`);
    }
    if (rules.smogonBans) out.push(...smogonProblems(team, species, itemName, moveName));
    return [...new Set(out)];
  }

  // Smogon's other [Gen 3] OU bans: Sand Veil, Soundproof, Quick Claw, Smeargle with Ingrain, Baton Pass with a
  // trapping move, a Baton Passer that boosts its Speed or more than one way, more than one Baton Passer that boosts,
  // and a trapping move or ability with a sure accuracy drop.
  function smogonProblems(team, species, itemName, moveName) {
    const out = [];
    const knows = (each, list) => each.moves.filter(move => has(list, move));
    let passers = 0;
    for (const each of team) {
      const name = species(each.species);
      if (each.ability === ABILITY.sandVeil) out.push(`${name} has Sand Veil, which isn't allowed.`);
      if (each.ability === ABILITY.soundproof) out.push(`${name} has Soundproof, which isn't allowed.`);
      if (each.item === ITEM.quickClaw) out.push(`${name} holds ${itemName(ITEM.quickClaw)}, which isn't allowed.`);
      if (each.species === SMEARGLE && has(each.moves, MOVE.ingrain)) out.push(`Smeargle can't have ${moveName(MOVE.ingrain)}.`);
      const accuracy = knows(each, ACCURACY_DROPS);
      if (accuracy.length && (knows(each, TRAPPING_MOVES).length || has(TRAPPING_ABILITIES, each.ability)))
        out.push(`${name} can trap and has ${moveName(accuracy[0])}: a trapping move or ability with a sure accuracy drop isn't allowed.`);
      if (!has(each.moves, MOVE.batonPass)) continue;
      const trap = knows(each, TRAPPING_MOVES);
      if (trap.length) out.push(`${name} has Baton Pass with ${moveName(trap[0])}, which isn't allowed.`);
      const speed = knows(each, SPEED_BOOSTS.moves).length + has(SPEED_BOOSTS.items, each.item) + has(SPEED_BOOSTS.abilities, each.ability);
      if (speed) out.push(`${name} has Baton Pass and a way to boost its Speed, which isn't allowed.`);
      const boosts = knows(each, STAT_BOOSTS.moves).length + has(STAT_BOOSTS.items, each.item) + has(STAT_BOOSTS.abilities, each.ability);
      if (boosts > 1) out.push(`${name} has Baton Pass and more than one way to boost its stats, which isn't allowed.`);
      if (boosts === 1 && ++passers > 1) out.push('More than one Pokémon has Baton Pass and a way to boost its stats, which isn\'t allowed.');
    }
    return out;
  }

  // A player's picks: `size` different slots of their party, each with a Pokémon. null when they aren't.
  function validPick(order, party, size) {
    if (!Array.isArray(order) || order.length !== size) return null;
    const slots = order.filter(slot => Number.isInteger(slot) && slot >= 0 && slot < party.length && party[slot]);
    return new Set(slots).size === size ? slots : null;
  }

  // How many games win a best-of set.
  const toWin = games => Math.floor(bestOf(games) / 2) + 1;

  const api = { LEVELS, BEST_OF, SIZES, POOLS, SLEEP, BATTLE_RULES, FORMATS, FORMAT_IDS, SETTINGS, VARIANTS, RESTRICTED, MYTHICAL, LEGENDARY, UBERS,
    normalize, bestOf, changes, describe, rulesText, rulesLine, member, problems, validPick, toWin };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.coloFormats = api;
})(typeof self !== 'undefined' ? self : this);
