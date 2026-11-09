'use strict';

// A Game Boy Advance on a controller socket, linked to the game by its GCN-GBA cable (the game's host/gba.c):
// the player's Gen 3 save, which a virtual GBA answers the game from (registering, trades, prizes), and
// optionally the Game Pak and a BIOS, which run the GBA itself in the game (mGBA, as Dolphin has it).
// Each is checked when it is chosen, and the game is told where they are.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const gen3 = require('./gen3-save');

const BIOS_SIZE = 16384;
// The console's BIOS, as No-Intro lists it. Optional: without one the game uses mGBA's own, which takes the link too.
const KNOWN_BIOS_SHA1 = '300c20df6731a33952ded8c436f7f186d25d3492';
// The sockets a GBA can be on: socket 1 is the player's controller.
const SOCKETS = ['2', '3', '4'];
// Pokémon games that link with Pokémon Colosseum, by their header's game code (without the region letter).
const POKEMON = { AXV: 'Pokémon Ruby', AXP: 'Pokémon Sapphire', BPE: 'Pokémon Emerald', BPR: 'Pokémon FireRed', BPG: 'Pokémon LeafGreen' };
const EREADER = { PSAE: 'e-Reader', PSAJ: 'Card e-Reader+', PEAJ: 'Card e-Reader' };
const REGIONS = { E: 'English', J: 'Japanese', D: 'German', F: 'French', I: 'Italian', S: 'Spanish', P: 'European' };

// The GBA BIOS at `file`: { name } or { error }. mGBA's own check (seven ARM branches, the exception
// vectors), and its size; a dump other than the console's known one may not start the link.
function checkBios(file) {
  let data;
  try { data = fs.readFileSync(file); } catch (error) { return { error: `Can't read ${path.basename(file)}: ${error.code || error.message}.` }; }
  if (data.length !== BIOS_SIZE) return { error: `${path.basename(file)} isn't a GBA BIOS: a BIOS is 16 KB.` };
  for (let i = 0; i < 7; i++) {
    if (data[i * 4 + 3] !== 0xEA || data[i * 4 + 2] !== 0) return { error: `${path.basename(file)} isn't a GBA BIOS.` };
  }
  const sha1 = crypto.createHash('sha1').update(data).digest('hex');
  return sha1 === KNOWN_BIOS_SHA1 ? { name: 'Game Boy Advance BIOS' }
    : { name: 'GBA BIOS', warning: "This isn't the BIOS dump we know. If the game can't connect to the GBA, use a dump of a Game Boy Advance's own BIOS." };
}

// A Game Pak's header: { title, code, name, ereader, warning } or { error }.
function checkGamePak(file) {
  let data;
  try {
    const fd = fs.openSync(file, 'r');
    try { data = Buffer.alloc(0xC0); fs.readSync(fd, data, 0, 0xC0, 0); } finally { fs.closeSync(fd); }
  } catch (error) { return { error: `Can't read ${path.basename(file)}: ${error.code || error.message}.` }; }
  if (data[0xB2] !== 0x96) return { error: `${path.basename(file)} isn't a GBA game.` };
  const text = (from, to) => data.toString('latin1', from, to).replace(/\0.*$/, '').trim();
  const title = text(0xA0, 0xAC), code = text(0xAC, 0xB0);
  const region = code[3] || '';
  if (EREADER[code]) return { title, code, name: EREADER[code], ereader: true };
  const pokemon = POKEMON[code.slice(0, 3)];
  if (!pokemon) return { title, code, name: title || code, warning: "This isn't a Pokémon game that links with Colosseum: Ruby, Sapphire, Emerald, FireRed or LeafGreen." };
  const language = REGIONS[region] || region;
  return { title, code, name: `${pokemon}${language ? ` (${language})` : ''}`,
    ...(region === 'E' ? {} : { warning: 'This copy of Colosseum is the English one: it links with the English GBA games.' }) };
}

// Where a Game Pak's save is by default: beside it, with .sav, as mGBA and other emulators keep it.
function defaultSave(rom) {
  const parsed = path.parse(rom);
  return path.join(parsed.dir, `${parsed.name}.sav`);
}

// The saved GBA files, kept to what can be used: { bios, sockets: { '2': { save, rom } } }. A socket needs its
// save; the Game Pak is optional (with it the GBA runs in the game; without, a virtual GBA answers from the save).
function normalize(input) {
  const gba = { bios: '', sockets: {} };
  if (!input || typeof input !== 'object') return gba;
  if (typeof input.bios === 'string') gba.bios = input.bios;
  for (const socket of SOCKETS) {
    const entry = input.sockets?.[socket];
    if (!entry || typeof entry !== 'object') continue;
    const rom = typeof entry.rom === 'string' ? entry.rom : '';
    // older settings had only the Game Pak, its save beside it
    const save = typeof entry.save === 'string' && entry.save ? entry.save : rom ? defaultSave(rom) : '';
    if (save) gba.sockets[socket] = { save, rom };
  }
  return gba;
}

// What Settings shows: each file checked now (it may have moved since it was chosen).
function status(gba) {
  const config = normalize(gba);
  const bios = config.bios ? { path: config.bios, ...checkBios(config.bios) } : null;
  const sockets = {};
  for (const [socket, entry] of Object.entries(config.sockets)) {
    let save;
    try {
      const info = gen3.read(entry.save);
      save = { ...info, path: entry.save, problem: gen3.linkProblem(info) };
    } catch (error) {
      save = { path: entry.save, error: fs.existsSync(entry.save) ? error.message : `${path.basename(entry.save)} isn't there any more.` };
    }
    sockets[socket] = { save, rom: entry.rom ? { path: entry.rom, ...checkGamePak(entry.rom) } : null };
  }
  const ready = Object.values(sockets).some(socket => !socket.save.error && !(socket.rom && socket.rom.error));
  return { bios, sockets, ready };
}

// The game's environment for its GBAs (host/gba.c): each socket's save (a virtual GBA answers from it),
// and its Game Pak when one is chosen (then the GBA runs in the game), with the BIOS if there is one.
function environment(gba, settings, backupFolder) {
  const config = normalize(gba);
  const env = {};
  for (const [socket, entry] of Object.entries(config.sockets)) {
    if (!fs.existsSync(entry.save) && !entry.rom) continue;
    env[`COLO_GBA${socket}_SAVE`] = entry.save;
    if (entry.rom && !checkGamePak(entry.rom).error) env[`COLO_GBA${socket}`] = entry.rom;
  }
  if (!Object.keys(env).length) return {};
  if (config.bios && !checkBios(config.bios).error) env.COLO_GBA_BIOS = config.bios;
  env.COLO_GBA_POWER = settings.gbaAutoPower === false ? 'manual' : 'auto';
  env.COLO_GBA_VOLUME = String(settings.gbaVolume ?? 100);
  if (backupFolder) env.COLO_GBA_BACKUPS = backupFolder;
  return env;
}

// Saves to offer: Gen 3 saves found where emulators keep them, newest first, with the one the player chose.
function suggestions(extraFolders = []) {
  return gen3.findSaves([...extraFolders, ...gen3.searchFolders()]).slice(0, 20)
    .map(info => ({ path: info.path, gameName: info.gameName, trainer: info.trainer, playTime: info.playTime,
      party: info.party.length, problem: gen3.linkProblem(info) }));
}

module.exports = { BIOS_SIZE, KNOWN_BIOS_SHA1, SOCKETS, checkBios, checkGamePak, defaultSave, normalize, status, environment, suggestions };
