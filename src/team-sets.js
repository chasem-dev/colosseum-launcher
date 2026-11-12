'use strict';

// A built party's Pokémon, each as a set: its moves, nature, EVs and IVs, held item, ability, nickname, gender and
// whether it's shiny. Shared by the Online page, which edits them, and the main process, which sends them to the game
// as a Story party's Pokémon are sent (src/story-party.js wireMember, the game's host/online.c `member` lines).
// Stats are the third generation's (the fourth's are the same), in the game's order: HP, Attack, Defense, Sp. Atk,
// Sp. Def, Speed.
//
// A party is of the third generation or the fourth: the fourth's (which plays under Pokémon Platinum's battle rules)
// may also have that generation's Pokémon and moves, by the game's numbers for them (src/generations.js: Pokémon 26
// past their National Pokédex number, moves 3 past theirs).
(function (root) {
  const STATS = ['HP', 'Atk', 'Def', 'SpA', 'SpD', 'Spe'];
  const STAT_NAMES = ['HP', 'Attack', 'Defense', 'Sp. Atk', 'Sp. Def', 'Speed'];
  const EV_MAX = 252, EV_TOTAL = 510, IV_MAX = 31;
  const MOVE_LAST = 0x162;        // the game's Shadow moves come after
  const GENERATIONS = [3, 4];
  // The fourth generation's Pokémon (Turtwig to Arceus), its last move (Shadow Force) and its held items (Adamant Orb to
  // Zoom Lens, and the Enigma Berry, blank in Colosseum), by the game's numbers.
  const LATER = { 4: { species: [413, 519], lastMove: 470, items: [0x224, 0x289], enigmaBerry: 175 } };
  const ITEM_LAST = 0xffff;
  const BALLS = 12, BALL = 4;     // Poké Ball
  const NICKNAME_LENGTH = 10;
  const TRAINER = 0;              // the original trainer's ID the game checks shininess against
  const PP_UPS = 3;               // every move at its most PP
  const NATURES = ['Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
    'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
    'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky'];
  // A nature's number is five times the stat it raises plus the one it lowers, in this order.
  const NATURE_STATS = [1, 2, 5, 3, 4];
  const HIDDEN_POWER_TYPES = ['Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel',
    'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark'];
  const HIDDEN_POWER = 237;
  // The order Hidden Power reads the IVs in: HP, Attack, Defense, Speed, Sp. Atk, Sp. Def.
  const HIDDEN_POWER_ORDER = [0, 1, 2, 5, 3, 4];
  // Shedinja always has 1 HP.
  const ONE_HP = new Set([303]);
  // A species' gender ratio: the chance out of 256 of female, with these three fixed.
  const GENDER = { male: 0, female: 254, none: 255 };

  // Moves of these types hit with Attack, the rest with Sp. Atk (the third generation's rule).
  const PHYSICAL_TYPES = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', '???'];
  const category = type => PHYSICAL_TYPES.includes(type) ? 'Physical' : 'Special';

  const int = (value, low, high, fallback) => Number.isInteger(value) && value >= low && value <= high ? value : fallback;
  const generationOf = value => GENERATIONS.includes(value) ? value : GENERATIONS[0];
  // The species a party of the generation can have: the game numbers its own up to 411, with a gap between the second
  // generation and the third.
  const validSpecies = (id, generation = 3) => Number.isInteger(id) && ((id >= 1 && id <= 251) || (id >= 277 && id <= 411)
    || (generation >= 4 && id >= LATER[4].species[0] && id <= LATER[4].species[1]));
  // The last move a party of the generation can have: the third's, or the fourth's new ones after the game's own.
  const lastMove = generation => generation >= 4 ? LATER[4].lastMove : MOVE_LAST;
  // Whether the species or move is one only a later generation's party can have: the generation, or 3.
  const speciesGeneration = id => id >= LATER[4].species[0] && id <= LATER[4].species[1] ? 4 : 3;
  const moveGeneration = id => id > MOVE_LAST && id <= LATER[4].lastMove ? 4 : 3;
  const itemGeneration = id => id === LATER[4].enigmaBerry || (id >= LATER[4].items[0] && id <= LATER[4].items[1]) ? 4 : 3;

  function natureEffect(nature) {
    const up = NATURE_STATS[Math.floor(nature / 5)], down = NATURE_STATS[nature % 5];
    return up === down ? null : { up, down };
  }

  function natureLabel(nature) {
    const effect = natureEffect(nature);
    return effect ? `${NATURES[nature]} (+${STATS[effect.up]}, −${STATS[effect.down]})` : NATURES[nature];
  }

  // The game's letters for a Pokémon's name (host/online.c nickname_letter): what it can show, and no commands.
  function nicknameLetter(code) {
    return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0x17f) || code === 0x2640 || code === 0x2642 || (code >= 0x3041 && code <= 0x30fe);
  }

  function cleanNickname(value) {
    const text = [...String(typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim()].filter(char => nicknameLetter(char.charCodeAt(0)));
    return text.join('').slice(0, NICKNAME_LENGTH).trim();
  }

  // EVs as the game takes them: 252 at most each, 510 in all, the last ones cut down to fit.
  function cleanEvs(evs) {
    let left = EV_TOTAL;
    return STATS.map((_, i) => {
      const value = Math.min(int(Array.isArray(evs) ? evs[i] : 0, 0, EV_MAX, 0), left);
      left -= value;
      return value;
    });
  }

  const cleanIvs = ivs => STATS.map((_, i) => int(Array.isArray(ivs) ? ivs[i] : IV_MAX, 0, IV_MAX, IV_MAX));

  function cleanMoves(moves, generation = 3) {
    const out = [];
    for (const move of Array.isArray(moves) ? moves : []) {
      // Colosseum's own moves 355 to 357 (its Shadow Rush and two unnamed) are no party's
      if (out.length < 4 && int(move, 1, lastMove(generation), 0) && (move <= MOVE_LAST || move > 357) && !out.includes(move)) out.push(move);
    }
    return out;
  }

  // A species as a set to start from: no moves picked, so it battles with the moves it learned on the way up.
  function defaultSet(species) {
    return { species, nickname: '', item: 0, ability: 0, nature: 0, gender: '', shiny: false, moves: [],
      evs: [0, 0, 0, 0, 0, 0], ivs: [31, 31, 31, 31, 31, 31], friendship: 255, ball: BALL };
  }

  // A set as saved, kept to what the game accepts for a party of the generation; anything else is the default.
  function normalizeSet(input, species, generation = 3) {
    const set = defaultSet(species);
    if (!input || typeof input !== 'object' || input.species !== species) return set;
    return { species, nickname: cleanNickname(input.nickname), item: int(input.item, 0, ITEM_LAST, 0), ability: input.ability === 1 ? 1 : 0,
      nature: int(input.nature, 0, 24, 0), gender: input.gender === 'M' || input.gender === 'F' ? input.gender : '',
      shiny: input.shiny === true, moves: cleanMoves(input.moves, generation), evs: cleanEvs(input.evs), ivs: cleanIvs(input.ivs),
      friendship: int(input.friendship, 0, 255, 255), ball: int(input.ball, 1, BALLS, BALL) };
  }

  // Which genders a species can be: [] when it has none.
  function genders(ratio) {
    if (ratio === GENDER.none) return [];
    if (ratio === GENDER.male) return ['M'];
    if (ratio === GENDER.female) return ['F'];
    return ['M', 'F'];
  }

  // The stats at `level`: the third generation's sums, with the nature's tenth up or down.
  function stats(base, set, level) {
    const effect = natureEffect(set.nature);
    return STATS.map((_, i) => {
      const core = Math.floor((2 * base[i] + set.ivs[i] + Math.floor(set.evs[i] / 4)) * level / 100);
      if (i === 0) return ONE_HP.has(set.species) ? 1 : core + level + 10;
      const value = core + 5;
      return effect?.up === i ? Math.floor(value * 1.1) : effect?.down === i ? Math.floor(value * 0.9) : value;
    });
  }

  function hiddenPower(ivs) {
    let type = 0, power = 0;
    HIDDEN_POWER_ORDER.forEach((stat, bit) => {
      type += (ivs[stat] & 1) << bit;
      power += ((ivs[stat] >> 1) & 1) << bit;
    });
    return { type: HIDDEN_POWER_TYPES[Math.floor(type * 15 / 63)], power: Math.floor(power * 40 / 63) + 30 };
  }

  // IVs for a Hidden Power of `type` at its strongest, keeping as many 31s as can be.
  function hiddenPowerIvs(type) {
    let best = null;
    for (let mask = 0; mask < 64; mask++) {
      const ivs = STATS.map((_, i) => (mask >> i) & 1 ? 30 : 31);
      const power = hiddenPower(ivs), lowered = ivs.filter(iv => iv < 31).length;
      if (power.type !== type) continue;
      if (!best || power.power > best.power || (power.power === best.power && lowered < best.lowered)) best = { ivs, power: power.power, lowered };
    }
    return best?.ivs || null;
  }

  // A small random stream from a seed, so a set gets the same personality each time it's sent.
  function stream(seed) {
    let state = (seed >>> 0) || 0x9e3779b9;
    return () => {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      return state;
    };
  }

  function seedOf(set, slot) {
    let hash = 2166136261;
    for (const char of `${slot}:${set.species}:${set.nature}:${set.gender}:${set.shiny}:${set.nickname}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return hash >>> 0;
  }

  // A personality with the set's nature, gender and shininess. The game takes all three from it.
  function personality(set, ratio, slot = 0) {
    const next = stream(seedOf(set, slot)), wanted = genders(ratio).includes(set.gender) ? set.gender : '';
    for (let tries = 0; tries < 200000; tries++) {
      const low = next() & 0xffff, high = set.shiny ? (low ^ (TRAINER >>> 16) ^ (TRAINER & 0xffff) ^ (next() & 7)) : next() >>> 16;
      const pid = ((high << 16) | low) >>> 0;
      if (pid % 25 !== set.nature) continue;
      if (!set.shiny && (((TRAINER >>> 16) ^ (TRAINER & 0xffff) ^ high ^ low) < 8)) continue;
      if (wanted && genders(ratio).length === 2 && ((low & 0xff) < ratio ? 'F' : 'M') !== wanted) continue;
      return pid;
    }
    return set.nature;
  }

  function genderOf(pid, ratio) {
    const options = genders(ratio);
    return options.length === 2 ? ((pid & 0xff) < ratio ? 'F' : 'M') : options[0] || '';
  }

  // The set as the game's `member` numbers (src/story-party.js wireMember has the order) and its nickname in hex.
  function toWire(set, ratio, slot = 0) {
    const units = [...set.nickname].map(char => char.charCodeAt(0));
    const hex = units.map(unit => unit.toString(16).padStart(4, '0')).join('') || '-';
    const moves = Array.from({ length: 4 }, (_, i) => set.moves[i] ? [set.moves[i], PP_UPS] : [0, 0]).flat();
    return [set.species, personality(set, ratio, slot), TRAINER, set.ball, set.ability, set.item, set.friendship,
      ...moves, ...set.ivs, ...set.evs, hex];
  }

  // --- Showdown's text: a team as players paste it between builders.
  const key = text => String(text || '').toLowerCase().replace(/♀/g, 'f').replace(/♂/g, 'm').replace(/[^a-z0-9]/g, '');
  // Names this game spells as the third generation did, and Showdown as later games do.
  const RENAMED = { feintattack: 'faintattack', highjumpkick: 'hijumpkick', visegrip: 'vicegrip', smellingsalts: 'smellingsalt' };
  const SHOWDOWN_NAMES = { faintattack: 'Feint Attack', hijumpkick: 'High Jump Kick', vicegrip: 'Vise Grip', smellingsalt: 'Smelling Salts' };

  // dex: { species: [{ id, name }], moves: [{ id, name }], items: [{ id, name }], balls, abilities(id) => [{ slot, name }],
  // gender(id) => ratio }, with what a party of `generation` can have. Returns { sets, problems }: lines it couldn't
  // use, to show the player.
  function parseShowdown(text, dex, generation = 3) {
    const find = (list, name) => {
      const wanted = key(name);
      return list.find(entry => key(entry.name) === wanted || key(entry.name) === RENAMED[wanted]);
    };
    const sets = [], problems = [];
    for (const block of String(text || '').replace(/\r/g, '').split(/\n\s*\n/)) {
      const lines = block.split('\n').map(line => line.trim()).filter(line => line && !/^===.*===$/.test(line));
      if (!lines.length) continue;
      let [first, itemName] = lines[0].split(/\s+@\s+/);
      let gender = '';
      first = first.replace(/\s*\((M|F)\)\s*$/, (_, g) => { gender = g; return ''; }).trim();
      const named = /^(.*)\(([^()]+)\)$/.exec(first);
      const speciesName = named ? named[2].trim() : first, nickname = named ? named[1].trim() : '';
      // a form's name (Unown-B, Castform-Sunny) is its species' here
      const species = find(dex.species, speciesName) || find(dex.species, speciesName.replace(/-[^-]*$/, ''));
      if (!species || !validSpecies(species.id, generation)) {
        problems.push(species && validSpecies(species.id, 4) ? `${speciesName}: a Generation 4 Pokémon, which only a Generation 4 party can have.`
          : `${speciesName}: not a Pokémon this game has.`);
        continue;
      }
      if (sets.length >= 6) { problems.push(`${speciesName}: a party has six Pokémon at most.`); continue; }
      const set = defaultSet(species.id);
      set.nickname = key(nickname) === key(species.name) ? '' : cleanNickname(nickname);
      if (genders(dex.gender(species.id)).includes(gender)) set.gender = gender;
      if (itemName) {
        const item = find(dex.items, itemName);
        if (item && itemGeneration(item.id) > generation) problems.push(`${species.name}: ${item.name} is a Generation 4 item, which only a Generation 4 party can hold.`);
        else if (item) set.item = item.id; else problems.push(`${species.name}: no held item called ${itemName}.`);
      }
      let ivsGiven = false, hiddenType = null;
      for (const line of lines.slice(1)) {
        const field = /^([A-Za-z ]+):\s*(.*)$/.exec(line), nature = /^(\w+)\s+Nature$/i.exec(line);
        if (line.startsWith('-')) {
          const name = line.replace(/^-\s*/, '').trim(), hidden = /^Hidden Power\s*\[?\s*(\w+)\s*\]?$/i.exec(name);
          const move = hidden ? dex.moves.find(entry => entry.id === HIDDEN_POWER) : find(dex.moves, name);
          if (hidden) hiddenType = HIDDEN_POWER_TYPES.find(type => key(type) === key(hidden[1])) || null;
          if (!move) problems.push(`${species.name}: no move called ${name}.`);
          else if (set.moves.length < 4 && !set.moves.includes(move.id)) set.moves.push(move.id);
        } else if (nature) {
          const index = NATURES.findIndex(name => key(name) === key(nature[1]));
          if (index >= 0) set.nature = index; else problems.push(`${species.name}: no nature called ${nature[1]}.`);
        } else if (field) {
          const [, name, value] = field, label = key(name);
          if (label === 'ability') {
            const ability = dex.abilities(species.id).find(entry => key(entry.name) === key(value));
            if (ability) set.ability = ability.slot; else problems.push(`${species.name} can't have ${value} in this game.`);
          } else if (label === 'shiny') set.shiny = /^y/i.test(value);
          else if (label === 'happiness' || label === 'friendship') set.friendship = int(Number(value), 0, 255, 255);
          else if (label === 'evs' || label === 'ivs') {
            const values = label === 'evs' ? [0, 0, 0, 0, 0, 0] : set.ivs.slice();
            for (const part of value.split('/')) {
              const match = /^\s*(\d+)\s+(\w+)\s*$/.exec(part), stat = match ? STATS.findIndex(name => key(name) === key(match[2])) : -1;
              if (stat >= 0) values[stat] = Number(match[1]);
            }
            if (label === 'evs') set.evs = cleanEvs(values);
            else { set.ivs = cleanIvs(values); ivsGiven = true; }
          } else if (label === 'ball' || label === 'pokeball') {
            const ball = find(dex.balls, value);
            if (ball && ball.id <= BALLS) set.ball = ball.id;
          }
          // Level, Tera Type and the rest: the room sets the level, and this game has no such thing.
        }
      }
      if (hiddenType && !ivsGiven) set.ivs = hiddenPowerIvs(hiddenType) || set.ivs;
      sets.push(set);
    }
    return { sets, problems };
  }

  function formatShowdown(sets, dex, level) {
    const nameOf = (list, id) => list.find(entry => entry.id === id)?.name;
    return sets.map(set => {
      const species = nameOf(dex.species, set.species) || `#${set.species}`;
      const lines = [`${set.nickname && set.nickname !== species ? `${set.nickname} (${species})` : species}${set.gender && genders(dex.gender(set.species)).length === 2 ? ` (${set.gender})` : ''}${set.item ? ` @ ${nameOf(dex.items, set.item) || ''}` : ''}`];
      const ability = dex.abilities(set.species).find(entry => entry.slot === set.ability) || dex.abilities(set.species)[0];
      if (ability) lines.push(`Ability: ${ability.name}`);
      if (level) lines.push(`Level: ${level}`);
      if (set.shiny) lines.push('Shiny: Yes');
      if (set.friendship !== 255) lines.push(`Happiness: ${set.friendship}`);
      const spread = (values, skip) => values.map((value, i) => value === skip ? null : `${value} ${STATS[i]}`).filter(Boolean).join(' / ');
      if (set.evs.some(Boolean)) lines.push(`EVs: ${spread(set.evs, 0)}`);
      lines.push(`${NATURES[set.nature]} Nature`);
      if (set.ivs.some(iv => iv !== IV_MAX)) lines.push(`IVs: ${spread(set.ivs, IV_MAX)}`);
      for (const id of set.moves) {
        const move = dex.moves.find(entry => entry.id === id);
        if (!move) continue;
        lines.push(`- ${id === HIDDEN_POWER ? `Hidden Power [${hiddenPower(set.ivs).type}]` : SHOWDOWN_NAMES[key(move.name)] || move.name}`);
      }
      return lines.join('\n');
    }).join('\n\n');
  }

  const api = { STATS, STAT_NAMES, EV_MAX, EV_TOTAL, IV_MAX, MOVE_LAST, GENERATIONS, LATER, generationOf, lastMove, speciesGeneration, moveGeneration, itemGeneration, NATURES, NICKNAME_LENGTH, HIDDEN_POWER, HIDDEN_POWER_TYPES, TRAINER, GENDER,
    PHYSICAL_TYPES, category, validSpecies, natureEffect, natureLabel, cleanNickname, cleanEvs, defaultSet, normalizeSet, genders, genderOf, stats, hiddenPower,
    hiddenPowerIvs, personality, toWire, parseShowdown, formatShowdown };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.coloTeamSets = api;
})(typeof globalThis === 'object' ? globalThis : this);
