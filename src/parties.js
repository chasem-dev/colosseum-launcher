'use strict';

// The player's online setup: their trainer name, the parties they built from
// the Pokédex, which one they battle with, and the room options they last used.
// Saved in the launcher's config. Parties are lists of the game's species
// numbers, as the Pokédex (src/pokedex.js) reads them from the disc, with a
// set for each (src/team-sets.js): its moves, nature, EVs, IVs and the rest.
// The species stay a list of their own so a launcher from before sets still
// reads the party. The Story party (src/story-party.js) is the save's own,
// chosen as STORY. A party is of the third generation or the fourth, whose
// Pokémon and moves it may also have, and which plays only under Pokémon
// Platinum's battle rules (src/team-sets.js); a party from before is the third's.
const teamSets = require('./team-sets');
const formats = require('./formats');

const PARTY_SIZE = 6;
const MAX_PARTIES = 32;
const NAME_LENGTH = 24;
const TRAINER_LENGTH = 10;
const LEVELS = [50, 100];
const SIZES = [3, 6];
const STORY = 'story';
// The game numbers its species up to 411, with a gap between the second generation and the third.
const { validSpecies } = teamSets;
// The battle rules a party of each generation plays under: either for the third's, Platinum's for the fourth's.
const rulesFor = generation => generation >= 4 ? [4] : formats.BATTLE_RULES;

const cleanName = (value, length) => (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim().slice(0, length);

// What the game can show: its trainer names are plain letters and digits.
function trainerName(value) {
  return cleanName(value, 64).normalize('NFD').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, TRAINER_LENGTH).trim() || 'Trainer';
}

function normalizeParty(input, index = 0) {
  const raw = Array.isArray(input?.members) ? input.members : [], sets = Array.isArray(input?.sets) ? input.sets : [];
  const generation = teamSets.generationOf(input?.generation);
  // each member with its set, in order: a set for another species, or none, starts again from the species
  const kept = raw.map((species, i) => [species, sets[i]]).filter(([species]) => validSpecies(species, generation)).slice(0, PARTY_SIZE);
  return { id: typeof input?.id === 'string' && /^[a-z0-9-]{1,40}$/.test(input.id) ? input.id : `party-${index + 1}`,
    name: cleanName(input?.name, NAME_LENGTH) || `Party ${index + 1}`, generation, members: kept.map(([species]) => species),
    sets: kept.map(([species, set]) => teamSets.normalizeSet(set, species, generation)) };
}

function normalize(input) {
  const parties = [];
  for (const party of Array.isArray(input?.parties) ? input.parties.slice(0, MAX_PARTIES) : []) {
    const clean = normalizeParty(party, parties.length);
    while (parties.some(other => other.id === clean.id)) clean.id = `${clean.id}-2`.slice(-40);
    parties.push(clean);
  }
  // Always a party ready to battle with: having one is enough to open a room.
  const ready = party => party.members.length === PARTY_SIZE;
  const chosen = parties.find(party => party.id === input?.selected);
  // The Story party stays chosen while the save changes: whether it can battle is the main process's to say.
  const selected = input?.selected === STORY ? STORY : (chosen && ready(chosen) ? chosen : parties.find(ready))?.id ?? null;
  return { trainer: trainerName(input?.trainer), parties, selected,
    level: LEVELS.includes(input?.level) ? input.level : LEVELS[0],
    size: SIZES.includes(input?.size) ? input.size : SIZES[1],
    // Casual's timers, as level and size are its own: 0 for none (the competitive formats keep theirs in custom)
    ...casualTimers(input),
    listed: input?.listed !== false,
    // a room for both games' players, Colosseum's and XD's (src/online.js crossBuildId)
    crossplay: input?.crossplay === true,
    // whose battle rules the room plays by: Colosseum's (3) or Pokémon Platinum's (4), with any format
    battleRules: formats.BATTLE_RULES.includes(input?.battleRules) ? input.battleRules : formats.BATTLE_RULES[0],
    // the room's format (src/formats.js), its changes for each format the player has changed, and how many games
    format: formats.FORMAT_IDS.includes(input?.format) ? input.format : 'casual',
    custom: cleanCustom(input?.custom),
    bestOf: formats.bestOf(input?.bestOf) };
}

function casualTimers(input) {
  const rules = formats.normalize({ format: 'casual', turnTime: input?.turnTime, battleTime: input?.battleTime });
  return { turnTime: rules.turnTime, battleTime: rules.battleTime };
}

// Each competitive format's changes, kept to what the format allows: { orre: { level: 50 }, ... }.
function cleanCustom(input) {
  const out = {};
  for (const format of formats.FORMAT_IDS.filter(id => id !== 'casual')) {
    const rules = formats.normalize({ ...(input && typeof input[format] === 'object' ? input[format] : {}), format });
    const changed = Object.fromEntries(formats.changes(rules).map(key => [key, rules[key]]));
    if (Object.keys(changed).length) out[format] = changed;
  }
  return out;
}

// The rules of a room the player makes: Casual's level, size and timers, or a format with their changes to it.
// Either plays by the battle rules the player chose.
function roomRules(online) {
  const battleRules = online.battleRules;
  if (online.format === 'casual') {
    return formats.normalize({ format: 'casual', level: online.level, size: online.size, turnTime: online.turnTime, battleTime: online.battleTime, battleRules });
  }
  return formats.normalize({ ...(online.custom[online.format] || {}), format: online.format, battleRules });
}

// The chosen party of the player's own, when it is ready to battle with (not the Story party).
function selectedParty(online) {
  const party = online.parties.find(item => item.id === online.selected);
  return party?.members.length === PARTY_SIZE ? party : null;
}

// Why a party can't battle under a room's battle rules, or null when it can: a Generation 4 party needs Platinum's.
function rulesProblem(party, battleRules) {
  if (!party || rulesFor(party.generation).includes(battleRules)) return null;
  return `${party.name} is a Generation 4 party, which battles only under Pokémon Platinum's battle rules.`;
}

module.exports = { PARTY_SIZE, MAX_PARTIES, NAME_LENGTH, TRAINER_LENGTH, LEVELS, SIZES, STORY, validSpecies, trainerName, normalizeParty, normalize, selectedParty, roomRules,
  rulesFor, rulesProblem };
