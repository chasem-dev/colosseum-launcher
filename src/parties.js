'use strict';

// The player's online setup: their trainer name, the parties they built from
// the Pokédex, which one they battle with, and the room options they last used.
// Saved in the launcher's config. Parties are lists of the game's species
// numbers, as the Pokédex (src/pokedex.js) reads them from the disc.

const PARTY_SIZE = 6;
const MAX_PARTIES = 32;
const NAME_LENGTH = 24;
const TRAINER_LENGTH = 10;
const LEVELS = [50, 100];
const SIZES = [3, 6];
// The game numbers its species up to 411, with a gap between the second generation and the third.
const validSpecies = id => Number.isInteger(id) && ((id >= 1 && id <= 251) || (id >= 277 && id <= 411));

const cleanName = (value, length) => (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim().slice(0, length);

// What the game can show: its trainer names are plain letters and digits.
function trainerName(value) {
  return cleanName(value, 64).normalize('NFD').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, TRAINER_LENGTH).trim() || 'Trainer';
}

function normalizeMembers(members) {
  return (Array.isArray(members) ? members : []).filter(validSpecies).slice(0, PARTY_SIZE);
}

function normalizeParty(input, index = 0) {
  return { id: typeof input?.id === 'string' && /^[a-z0-9-]{1,40}$/.test(input.id) ? input.id : `party-${index + 1}`,
    name: cleanName(input?.name, NAME_LENGTH) || `Party ${index + 1}`, members: normalizeMembers(input?.members) };
}

function normalize(input) {
  const parties = [];
  for (const party of Array.isArray(input?.parties) ? input.parties.slice(0, MAX_PARTIES) : []) {
    const clean = normalizeParty(party, parties.length);
    while (parties.some(other => other.id === clean.id)) clean.id = `${clean.id}-2`.slice(-40);
    parties.push(clean);
  }
  const selected = parties.some(party => party.id === input?.selected) ? input.selected : null;
  return { trainer: trainerName(input?.trainer), parties, selected,
    level: LEVELS.includes(input?.level) ? input.level : LEVELS[0],
    size: SIZES.includes(input?.size) ? input.size : SIZES[1],
    listed: input?.listed !== false };
}

// The chosen party, when it is ready to battle with.
function selectedParty(online) {
  const party = online.parties.find(item => item.id === online.selected);
  return party?.members.length === PARTY_SIZE ? party : null;
}

module.exports = { PARTY_SIZE, MAX_PARTIES, NAME_LENGTH, TRAINER_LENGTH, LEVELS, SIZES, validSpecies, trainerName, normalizeParty, normalize, selectedParty };
