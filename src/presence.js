'use strict';

// What Discord shows while the game runs. With COLO_PRESENCE=1 the game prints a `[presence] {...}`
// line whenever what the player is doing changes (the port's host/presence.c); this turns the latest
// one into a Discord activity. Image keys are art assets uploaded to the Discord application
// (Rich Presence > Art Assets), one for each area of Orre.
const LAUNCHER_URL = 'https://github.com/chasem-dev/colosseum-launcher/releases/latest';
const DISCORD_URL = 'https://discord.gg/pkVwBrSwsZ';
const PREFIX = '[presence] ';
const GAME = 'Pokémon Colosseum';
const MODES = ['boot', 'movie', 'field', 'scene', 'battle', 'menu'];

// The game's place names (as the save screen shows them) -> their area's image.
const PLACE_IMAGES = {
  'OUTSKIRT STAND': 'outskirt_stand',
  'PHENAC CITY': 'phenac_city', "MAYOR'S HOUSE": 'phenac_city', 'PRE GYM': 'phenac_city', 'PHENAC STADIUM': 'phenac_city',
  'PYRITE TOWN': 'pyrite_town', 'PYRITE BLDG': 'pyrite_town', 'PYRITE CAVE': 'pyrite_town', "MIROR'S HIDEOUT": 'pyrite_town',
  'PYRITE COLOSSEUM': 'pyrite_town',
  'AGATE VILLAGE': 'agate_village', 'RELIC CAVE': 'agate_village',
  'THE UNDER': 'the_under', 'THE UNDER SUBWAY': 'the_under', 'UNDER COLOSSEUM': 'the_under', 'DEEP COLOSSEUM': 'the_under',
  'FRONT OF LAB': 'shadow_lab', 'LABORATORY': 'shadow_lab',
  'MT. BATTLE': 'mt_battle', 'MT.BTL COLOSSEUM': 'mt_battle',
  'REALGAM TOWER': 'realgam_tower', 'REALGAM TOWER 2F': 'realgam_tower', 'REALGAMTWR DOME': 'realgam_tower',
  'REALGAMTWR LOBBY': 'realgam_tower', 'TOWER COLOSSEUM': 'realgam_tower',
  'SNAGEM HIDEOUT': 'snagem_hideout',
  'ORRE COLOSSEUM': 'orre_colosseum'
};
// The floor table's areas, for a place not named above.
const AREA_IMAGES = { 1: 'outskirt_stand', 2: 'phenac_city', 3: 'pyrite_town', 4: 'agate_village', 5: 'the_under',
  6: 'shadow_lab', 7: 'mt_battle', 8: 'realgam_tower', 10: 'snagem_hideout' };
// Place names the game shortens to fit its save screen.
const PLACE_NAMES = {
  'PYRITE BLDG': 'Pyrite Building', "MIROR'S HIDEOUT": "Miror B.'s Hideout", 'FRONT OF LAB': 'Outside the Lab',
  'REALGAMTWR DOME': 'Realgam Tower Dome', 'REALGAMTWR LOBBY': 'Realgam Tower Lobby', 'MT.BTL COLOSSEUM': 'Mt. Battle Colosseum'
};

// A game output line -> its presence, or null for any other line.
function parseLine(line) {
  if (typeof line !== 'string' || !line.startsWith(PREFIX)) return null;
  try {
    const data = JSON.parse(line.slice(PREFIX.length));
    return data && typeof data === 'object' && MODES.includes(data.mode) ? data : null;
  } catch (_) { return null; }
}

function isPresenceLine(line) { return typeof line === 'string' && line.startsWith(PREFIX); }

// The game's capitals as a name is written: "RIDER WILLIE" -> "Rider Willie", "HO-OH" -> "Ho-Oh",
// "MAYOR'S HOUSE" -> "Mayor's House".
function titleCase(text) {
  return String(text || '').toLowerCase().replace(/(^|[\s\-.])(\p{L})/gu, (_, before, letter) => before + letter.toUpperCase()).trim();
}

function placeName(place) { return PLACE_NAMES[place] || titleCase(place); }

// XD's areas are numbered its own way: only a place's own name picks its picture there (several are in both games)
function placeImage(game, areas = true) { return PLACE_IMAGES[game?.place] || (areas ? AREA_IMAGES[game?.area] : null) || null; }

// Discord rejects texts shorter than 2 or longer than 128 characters.
function fit(text) {
  if (!text) return undefined;
  const value = String(text).slice(0, 128);
  return value.length >= 2 ? value : undefined;
}

// The latest game presence and the session -> a Discord activity. `online` is an online battle's
// opponent, as the room names them: the launcher knows that one better than the game (or `watching`, the two players'
// names, for a battle watched). `gameName` is the game being
// played (Colosseum's unless given), `areaImages` whether the floor table's area numbers are Colosseum's.
function activity(game, { startedAt, online = null, gameName = GAME, areaImages = true } = {}) {
  const result = {
    details: undefined,
    state: undefined,
    timestamps: startedAt ? { start: startedAt } : undefined,
    assets: { large_image: 'logo', large_text: gameName, small_image: 'launcher', small_text: 'Played with Colosseum Launcher' },
    buttons: [{ label: 'Play it on PC', url: LAUNCHER_URL }, { label: 'Join the Discord', url: DISCORD_URL }]
  };
  if (online) {
    result.details = 'Online battle';
    result.state = online.watching ? (online.watching.length === 2 ? `Watching ${online.watching[0]} vs ${online.watching[1]}` : 'Watching a battle')
      : online.opponent ? `Battling ${online.opponent}` : 'Waiting for a challenger';
    result.assets.large_image = 'orre_colosseum';
    return clean(result);
  }
  // A game without host/presence.c never says more than this.
  if (!game) return clean(result);
  const place = game.place ? placeName(game.place) : '';
  const image = placeImage(game, areaImages);
  const lead = game.story && game.lead && game.level ? `Lead: ${titleCase(game.lead)}, Lv. ${game.level}` : '';
  const opponent = game.opponent ? `Battling ${titleCase(game.opponent)}` : 'In a battle';
  if (game.mode === 'battle') {
    result.details = game.story ? place || 'In a battle' : 'Battle Mode';
    result.state = opponent;
    if (lead) result.assets.large_text = lead;
  } else if (game.mode === 'field' && place) {
    result.details = place;
    result.state = lead || undefined;
  } else if (game.mode === 'scene' && place) {
    result.details = place;
    result.state = 'Watching a cutscene';
  } else if (game.mode === 'movie') result.details = 'Watching a cutscene';
  else if (game.mode === 'menu') result.details = 'In the menus';
  else result.details = 'Starting up';
  // Menus and movies keep the title's picture; a place, its area's.
  if (image && ['battle', 'field', 'scene'].includes(game.mode)) {
    result.assets.large_image = image;
    if (result.assets.large_text === gameName && place) result.assets.large_text = place;
  }
  return clean(result);
}

function clean(result) {
  for (const key of ['details', 'state']) result[key] = fit(result[key]);
  result.assets.large_text = fit(result.assets.large_text);
  return JSON.parse(JSON.stringify(result));
}

module.exports = { LAUNCHER_URL, DISCORD_URL, PREFIX, PLACE_IMAGES, AREA_IMAGES, parseLine, isPresenceLine, titleCase, activity };
