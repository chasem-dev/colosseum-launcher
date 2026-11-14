'use strict';

// The games the launcher gets, builds and plays. One port checkout builds either (its build.sh reads COLO_GAME), each
// from its own decomp, into its own executable. Each game has its own checkout folder, disc, game source and memory
// card (saves.js): their saves don't fit on one 59-block card.
const path = require('node:path');

// What the launcher adds to a game beyond building and playing it. Colosseum has them all; another game lists the
// ones its port has so far. Renderer, display, picture and input settings apply to every game.
const FEATURES = ['online', 'generations', 'randomizer', 'widescreen', 'hdText', 'hdModels', 'hdTextures', 'languagePacks',
  'discordPresence', 'storyParty', 'pcBoxes', 'gbaLink', 'quickMoves', 'battleSpeed', 'fastForward', 'skipMovies', 'starters',
  'shiny', 'shinyStarters', 'pokemonPacks', 'pbrAssets', 'pokedex', 'jukebox', 'teamBuilder', 'gciSaves', 'tmNames', 'customize'];

const GAMES = {
  colosseum: {
    id: 'colosseum', name: 'Pokémon Colosseum', shortName: 'Colosseum', title: 'POKÉMON COLOSSEUM',
    discId: 'GC6E01', revision: 0, regions: { GC6P01: 'European', GC6J01: 'Japanese' },
    executable: 'colosseum', decompFolder: 'pkmn-colosseum',
    // <userData>/game, as before there were two games; and the folder Change location makes
    checkoutFolder: 'game', locationFolder: 'Colosseum Game',
    release: require('./game-release.json'), buildEnv: {},
    // the HD texture pack the launcher downloads (port.js)
    texturePack: require('./texture-pack.json'),
    // Colosseum's build needs main.dol from the disc only for the Windows icon (port.placeMainDol)
    needsMainDol: false,
    // The Discord application its activity shows as (discord.js): Discord shows the application's name as the game
    // being played, and its Rich Presence art assets are the image keys in presence.js
    discordAppId: '1568804288413835405',
    features: FEATURES
  },
  xd: {
    id: 'xd', name: 'Pokémon XD: Gale of Darkness', shortName: 'XD', title: 'POKÉMON XD: GALE OF DARKNESS',
    discId: 'GXXE01', revision: 0, regions: { GXXP01: 'European', GXXJ01: 'Japanese' },
    executable: 'xd', decompFolder: 'pkmn-xd',
    checkoutFolder: 'game-xd', locationFolder: 'XD Game',
    release: require('./xd-release.json'), buildEnv: { COLO_GAME: 'xd' },
    // XD's disc textures 4x, made as Colosseum's are (the port's tools/colo-texall); in two zips (parts), as one
    // release file holds under 2 GiB
    texturePack: require('./xd-texture-pack.json'),
    // XD's port builds without the game's files too (its extracted data is only ever read from the disc's DOL)
    needsMainDol: false,
    // XD's own Discord application, once it is made: paste its Application ID here as a string. Until then XD's
    // activity goes through Colosseum's application (discordAppId below), so Discord says "Playing Pokémon Colosseum"
    discordAppId: null,
    // fast-forward is the port's shared input code, XD skips its own movies, and its cameras widen with the frame (its
    // 2D stays 4:3, centred); its save goes to and from Dolphin as a .gci (gci-save.js); it prints its [presence] lines
    // (host/xd/presence.c); its text goes through HD text (host/hdtext.c); its online battles (host/xd/online.c) speak
    // Colosseum's lines, with parties from the team builder, which reads Colosseum's disc (main.js teamDisc); later
    // generations' rules, Pokémon and moves come in Colosseum's file, made from Colosseum's disc (main.js
    // prepareGenerations), which host/xd/packs.c turns into XD's rows, its Pokémon looking as the ones standing in for
    // them; the rest hook Colosseum's functions
    // battle speed, quick moves and status, shiny Shadow Pokémon and choosing the starter are the port's shared host code;
    // Pokémon packs and later generations with Battle Revolution assets come in the same file as Colosseum's, made from
    // Colosseum's disc (main.js packsDisc) and turned into XD's rows by the game (host/xd/packs.c)
    // (host/battlespeed.c, quickmoves.c, shiny.c, starters.c with XD's parts); XD's Eevee can already be shiny, so it
    // has no shinyStarters. The randomizer is the port's shared host/randomizer.c, its stamp read from XD's save
    // (xd-save.js), as is the Story party (story-party.js), which XD's online battles take whole. The Pokédex and the
    // Jukebox read XD's own disc (xd-disc.js: its species, models, streamed cries and streamed music). TMs listed by their
    // moves' names are host/tmnames.c's, with XD's own bag and shop calls
    features: ['online', 'teamBuilder', 'generations', 'widescreen', 'hdText', 'hdTextures', 'fastForward', 'skipMovies', 'gciSaves', 'discordPresence',
      'battleSpeed', 'quickMoves', 'shiny', 'starters', 'pokemonPacks', 'pbrAssets', 'gbaLink', 'randomizer', 'storyParty', 'pokedex', 'jukebox', 'tmNames']
  }
};

const DEFAULT = 'colosseum';
const ids = () => Object.keys(GAMES);
const normalizeId = id => Object.hasOwn(GAMES, id) ? id : DEFAULT;
function get(id) { return GAMES[normalizeId(id)]; }
// The game a pin or a chosen game source builds: one without a game is Colosseum's, as every pin before XD was.
function ofSource(source) { return get(source?.game); }
function supports(id, feature) { return get(id).features.includes(feature); }
// The Discord application a game's activity goes through: its own, or Colosseum's while it has none.
function discordAppId(id) { return get(id).discordAppId || GAMES[DEFAULT].discordAppId; }
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
// config, as Colosseum always had; the others wait under `games`. Each game has its own Steam shortcut, so Play's
// one-time Add to Steam offer (steamOffered) and the offer to fix a shortcut (steamFixOffered) are each game's too.
const FIELDS = ['repo', 'rom', 'installRoot', 'previousInstall', 'completedSetup', 'gameSource', 'steamOffered', 'steamFixOffered'];

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
    gameSource: readSource(saved.gameSource, id),
    steamOffered: Boolean(saved.steamOffered),
    steamFixOffered: Boolean(saved.steamFixOffered)
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

module.exports = { FEATURES, GAMES, DEFAULT, FIELDS, ids, normalizeId, get, ofSource, supports, discordAppId, featureMap, identifyDisc, summary,
  checkoutPath, readFields, pickFields, loadGames, storedGames, switchGame, allFields };
