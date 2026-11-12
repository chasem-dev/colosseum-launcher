'use strict';

// The games the launcher gets, builds and plays. One port checkout builds either (its build.sh reads COLO_GAME), each
// from its own decomp, into its own executable. Each game has its own checkout folder, disc and game source; the
// memory card (saves.js) is one folder for both, as a real memory card would be.
const path = require('node:path');

// What the launcher adds to a game beyond building and playing it. Colosseum has them all; another game lists the
// ones its port has so far. Renderer, display, picture and input settings apply to every game.
const FEATURES = ['online', 'generations', 'randomizer', 'widescreen', 'hdText', 'hdModels', 'hdTextures', 'languagePacks',
  'discordPresence', 'storyParty', 'pcBoxes', 'gbaLink', 'quickMoves', 'battleSpeed', 'fastForward', 'skipMovies', 'starters',
  'shiny', 'pokemonPacks', 'pbrAssets', 'pokedex', 'jukebox', 'teamBuilder', 'gciSaves'];

const GAMES = {
  colosseum: {
    id: 'colosseum', name: 'Pokémon Colosseum', shortName: 'Colosseum', title: 'POKÉMON COLOSSEUM',
    discId: 'GC6E01', revision: 0, regions: { GC6P01: 'European', GC6J01: 'Japanese' },
    executable: 'colosseum', decompFolder: 'pkmn-colosseum',
    // <userData>/game, as before there were two games; and the folder Change location makes
    checkoutFolder: 'game', locationFolder: 'Colosseum Game',
    release: require('./game-release.json'), buildEnv: {},
    // Colosseum's build needs main.dol from the disc only for the Windows icon (port.placeMainDol)
    needsMainDol: false,
    features: FEATURES
  },
  xd: {
    id: 'xd', name: 'Pokémon XD: Gale of Darkness', shortName: 'XD', title: 'POKÉMON XD: GALE OF DARKNESS',
    discId: 'GXXE01', revision: 0, regions: { GXXP01: 'European', GXXJ01: 'Japanese' },
    executable: 'xd', decompFolder: 'pkmn-xd',
    checkoutFolder: 'game-xd', locationFolder: 'XD Game',
    release: require('./xd-release.json'), buildEnv: { COLO_GAME: 'xd' },
    // the decomp's own build extracts XD's fonts and tables from main.dol before the port's build reads them
    needsMainDol: true,
    // fast-forward is the port's shared input code, and XD skips its own movies; the rest hook Colosseum's functions
    features: ['fastForward', 'skipMovies']
  }
};

const DEFAULT = 'colosseum';
const ids = () => Object.keys(GAMES);
const normalizeId = id => Object.hasOwn(GAMES, id) ? id : DEFAULT;
function get(id) { return GAMES[normalizeId(id)]; }
// The game a pin or a chosen game source builds: one without a game is Colosseum's, as every pin before XD was.
function ofSource(source) { return get(source?.game); }
function supports(id, feature) { return get(id).features.includes(feature); }
// Every feature, and whether this game has it: for the renderer to show or hide what the game can use.
function featureMap(id) { return Object.fromEntries(FEATURES.map(feature => [feature, supports(id, feature)])); }

// A disc ID -> the game and release it is, among the games here, or null.
function identifyDisc(discId) {
  for (const game of Object.values(GAMES)) {
    if (discId === game.discId) return { game, region: null };
    if (game.regions[discId]) return { game, region: game.regions[discId] };
  }
  return null;
}

// What the renderer shows of each game: the picker's names and which game is chosen.
function summary(id) {
  return { id: normalizeId(id), list: Object.values(GAMES).map(game => ({ id: game.id, name: game.name, shortName: game.shortName })),
    ...(({ name, shortName, title, discId }) => ({ name, shortName, title, discId }))(get(id)), features: featureMap(id) };
}

// --- Preferences: what each game keeps of its own. The game chosen has these at the top level of the launcher's
// config, as Colosseum always had; the others wait under `games`.
const FIELDS = ['repo', 'rom', 'installRoot', 'previousInstall', 'completedSetup', 'gameSource'];

function checkoutPath(userData, id) { return path.join(userData, get(id).checkoutFolder); }

// A game's saved fields, checked. `readSource` checks a chosen game source; `defaultRepo` is where the game's checkout goes.
function readFields(raw, id, { defaultRepo, readSource = () => null } = {}) {
  const saved = raw && typeof raw === 'object' ? raw : {};
  return {
    repo: typeof saved.repo === 'string' ? saved.repo : defaultRepo(id),
    rom: typeof saved.rom === 'string' ? saved.rom : '',
    installRoot: typeof saved.installRoot === 'string' ? saved.installRoot : null,
    previousInstall: saved.previousInstall && typeof saved.previousInstall === 'object' ? saved.previousInstall : null,
    completedSetup: Boolean(saved.completedSetup),
    gameSource: readSource(saved.gameSource, id)
  };
}

function pickFields(config) { return Object.fromEntries(FIELDS.map(key => [key, config[key] ?? null])); }

// Saved preferences -> the chosen game, its fields at the top level, and every game's under `games`. Preferences from
// before XD are Colosseum's, at the top level, and stay where they are: Colosseum is the chosen game.
function loadGames(saved, options) {
  const stored = saved && typeof saved === 'object' ? saved : {};
  const game = normalizeId(stored.game);
  const games = {};
  for (const id of ids()) games[id] = readFields(id === DEFAULT ? stored : stored.games?.[id], id, options);
  return { game, ...games[game], games };
}

// The config as it is saved: Colosseum's fields at the top level whichever game is chosen, so an older launcher still
// finds Colosseum's setup there; the other games' under `games`.
function storedGames(config) {
  const chosen = normalizeId(config.game);
  const all = { ...(config.games || {}), [chosen]: pickFields(config) };
  const stored = { ...config, ...(all[DEFAULT] ? pickFields(all[DEFAULT]) : {}), game: chosen, games: {} };
  for (const id of ids()) if (id !== DEFAULT && all[id]) stored.games[id] = pickFields(all[id]);
  return stored;
}

// The config with another game chosen: the chosen game's fields go back under `games`, and the next one's come up.
function switchGame(config, id, options) {
  const next = normalizeId(id);
  const chosen = normalizeId(config.game);
  const games = { ...(config.games || {}), [chosen]: pickFields(config) };
  const fields = games[next] ? pickFields(games[next]) : readFields(null, next, options);
  return { ...config, ...fields, game: next, games };
}

// Every game's fields, the chosen game's as they are now.
function allFields(config) {
  const chosen = normalizeId(config.game);
  return { ...(config.games || {}), [chosen]: pickFields(config) };
}

module.exports = { FEATURES, GAMES, DEFAULT, FIELDS, ids, normalizeId, get, ofSource, supports, featureMap, identifyDisc, summary,
  checkoutPath, readFields, pickFields, loadGames, storedGames, switchGame, allFields };
