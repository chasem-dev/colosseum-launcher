'use strict';
// Names for the songs of Pokémon Colosseum (GC6E01), by the name each has in bgm_archive.fsys (without "_song"). The game has no
// titles for them: these are the fan names of the KHInsider rip of the game (downloads.khinsider.com/game-soundtracks/album/pokemon-colosseum),
// matched to the disc's songs by length and by the internal names. A song with no entry is shown by its file name ("Battle2").
//
// How a name was matched: in that rip, a song that loops is its intro, two passes of its loop and about 9.5 seconds of fade, and a song
// that doesn't runs 2 to 3.7 seconds past its length; each song's length comes from its own data (musyx-music.js songSeconds). A name
// is here when a length fits (within about a second) and the song's name doesn't contradict it, or when the file name says what it is
// (me_fue is the Time Flute, agb_shinka the evolution music). The ones marked "order" are sets whose members match as a set: the rip's
// order for them could not be checked, so they are numbered by the disc's own order. These are fan names, not Nintendo's titles.
const NAMES = {
  null_bgm: 'Silence',
  title: 'Title Screen',
  gs_logo: 'Genius Sonority Logo',
  demo_roll: 'Game Demo',
  open_roll: 'Wes Steals the Snatching Machine',
  end_roll_b: 'Staff Roll (JP)',
  end_roll_c: 'Staff Roll (US/EU)',
  end_ev_1: 'Ending A',
  end_ev_2: 'Ending B',
  watercity: 'Phenac City',
  windycity: 'Agate Village',
  stand: 'Outskirt Stand',
  darkunder: 'The Under',
  wind_atmos_loop: 'Wind (SFX)',
  tool_music: 'Battle Mode Menu',
  mt_battle: 'Mt. Battle',
  battle7: 'Cipher Peon Battle (Colosseum Round 2)',   // (also the Colosseum's second fighter of each set)
  battle6: 'Final Battle',
  // the battle songs, from the game's own tables (which battle, floor or trainer kind plays each): battle5 is the Colosseum's first
  // fighter of every set and the Team Snagem, hunter and rider trainer kinds; battle7 the second and the Cipher Peons; battle2 the third;
  // battle9 the fourth; battle9plus the Cipher Admin; battle6 the Cipher Head and the Mt. Battle master; battle8 the ordinary trainers
  // (rich boy, lady, athlete, teacher and the like), which is the rip's "Normal Battle"
  battle8: 'Normal Battle',
  battle5: 'Team Snagem Battle (Colosseum Round 1)',
  battle2: 'Colosseum Round 3 Battle',
  battle9: '4th Colosseum Battle',
  battle9plus: 'Cipher Admin Battle',
  // area songs, less sure: by length, the order the game's own sound test lists them in (which follows the rip's) and their names
  darkside: 'Pyrite Town',
  dungeon: 'Pyrite Building',
  saint: 'Relic Forest',
  darkside4: 'Mt. Battle Rest Room',
  country: 'Realgam Tower',
  worldmap2: 'World Map',
  ev_shadow: "Cipher Syndicate's Theme",
  jyakira: "Nascour's Theme",
  hyper_shiccho: 'Evice Theme',
  ev_shiccho: 'Es Cade Theme',
  ev_snatch: 'Snagem Hideout',
  pokecen: 'Pokémon Center',
  mirrorbo: "Miror B.'s Retro Groove",
  miraclebo: "Mirakle B.'s Imitation Groove",
  shinpi: 'Fadeen the Fortuneteller',
  ev_kinpaku: 'Relic Forest in Danger',
  tretre: 'Trainers School',
  virtual: 'Virtual (unused)',
  me_winwin: 'winwin (unused)',
  me_ex_tre: 'ex tre (unused)',
  agb_shinka: 'Pokémon is Evolving',
  agb_me_shinka: 'Evolution Jingle',
  level_up: 'Level Up',
  me_win: 'Win Battle',
  me_snatch: 'Snatch Shadow Pokémon',
  me_relive: 'Shadow Pokémon is Purified',
  me_fue: 'Time Flute',
  siren_atmos: 'Shadow Pokémon Lab Alarm',
  me_news: 'News 1',
  me_undertime: 'News 2',
  me_chukei: 'News 3',
  tool_battle1: 'Vs. Mode Battle #1',
  tool_battle2: 'Vs. Mode Battle #2',
  tool_battle3: 'Vs. Mode Battle #3',
  // order: the ten PDA mail ringtones (chakumelo is "ringtone" in Japanese), and the four introductions of the Colosseum's rounds
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`chakumelo${String(i).padStart(2, '0')}`, `PDA Mail Ringtone ${i + 1}`])),
  ...Object.fromEntries(['fanfare00', 'fanfare01', 'fanfare02', 'fanfare03'].map((file, i) => [file, `Colosseum Round Intro ${i + 1}`]))
};

module.exports = { NAMES };
