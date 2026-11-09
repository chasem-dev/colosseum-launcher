'use strict';

// Language packs: the game's text, fonts and menu pictures in another language, made from the European disc
// (pokemon-colosseum-extras, tools/languages). The launcher keeps them in a folder of its own, so every game
// version uses them, and names the chosen one to the game in COLO_LANGUAGE.
//
// The packs this launcher offers are in language-packs.json. Any other folder in the languages folder with a
// pack.json is a pack too (a fan translation, say), and is offered as it is.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CATALOG = require('./language-packs.json');
const MARKER = '.release';
const CODE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

function folder(userData) { return path.join(userData, 'languages'); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function catalogPack(code, catalog = CATALOG) { return catalog.packs.find(pack => pack.code === code) || null; }

// A catalog pack is installed when its marker names the download it came from.
function installed(dir, pack) {
  const marker = readJson(path.join(dir, pack.code, MARKER));
  return Boolean(marker && marker.sha256 === pack.sha256);
}

// The folders in the languages folder that hold a pack.json: [{ code, name, version }]
function localPacks(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const packs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !CODE.test(entry.name)) continue;
    const info = readJson(path.join(dir, entry.name, 'pack.json'));
    if (!info) continue;
    packs.push({ code: entry.name, name: typeof info.name === 'string' && info.name.trim() ? info.name.trim() : entry.name,
      version: typeof info.version === 'string' ? info.version : '' });
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name));
}

// What Settings offers: English, the catalog's packs, then the others found in the folder.
function choices(dir, catalog = CATALOG) {
  const list = [{ code: 'en', name: 'English', builtIn: true }];
  for (const pack of catalog.packs) list.push({ code: pack.code, name: pack.name, installed: installed(dir, pack) });
  for (const pack of localPacks(dir))
    if (!catalog.packs.some(known => known.code === pack.code)) list.push({ ...pack, installed: true, local: true });
  return list;
}

function normalizeLanguage(value) { return typeof value === 'string' && CODE.test(value) ? value : 'en'; }

// The pack to play with (a folder), or null for English.
function chosenFolder(settings, dir) {
  const code = normalizeLanguage(settings.language);
  if (code === 'en') return null;
  const target = path.join(dir, code);
  return fs.existsSync(path.join(target, 'pack.json')) || fs.existsSync(path.join(target, 'text.txt')) ? target : null;
}

function environment(settings, dir) {
  const target = chosenFolder(settings, dir);
  return target ? { COLO_LANGUAGE: target } : {};
}

// Whether the chosen language still has to be downloaded before playing.
function needsInstall(settings, dir, catalog = CATALOG) {
  const pack = catalogPack(normalizeLanguage(settings.language), catalog);
  return Boolean(pack && !installed(dir, pack));
}

// ---- zip files (stored or deflated entries; what make_language_packs.py writes)
function unzip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('The language pack download is not a zip file.');
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const files = [];
  for (let k = 0; k < count; k++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('The language pack zip is damaged.');
    const method = buffer.readUInt16LE(at + 10), packed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('The language pack zip is damaged.');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + packed);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data || data.length !== size) throw new Error(`The language pack zip has an entry the launcher can't read (${name}).`);
    files.push({ name, data });
  }
  return files;
}

// A pack's files from its zip, without the zip's top folder (the pack's code); null for a path that leaves it.
function packFiles(files, code) {
  const out = [];
  for (const file of files) {
    const parts = file.name.split('/');
    if (parts[0] !== code || parts.length < 2 || parts.some(part => part === '..' || part === '' || part.includes('\\') || part.includes(':')))
      throw new Error(`The language pack has a file outside its folder (${file.name}).`);
    out.push({ name: parts.slice(1).join('/'), data: file.data });
  }
  if (!out.some(file => file.name === 'text.txt')) throw new Error('The language pack has no text.');
  return out;
}

async function download(url, size, { fetchImpl = fetch, onProgress = () => {} } = {}) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'colosseum-launcher' } });
  if (!response.ok) throw new Error(`The language pack download returned HTTP ${response.status}.`);
  const chunks = [];
  let have = 0;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      have += value.length;
      onProgress(have, size);
    }
  } else {
    const data = Buffer.from(await response.arrayBuffer());
    chunks.push(data);
    onProgress(data.length, size);
  }
  return Buffer.concat(chunks);
}

// Download a catalog pack, check it, and put it in place of any earlier copy.
async function install(dir, pack, options = {}) {
  const data = await download(pack.url, pack.size, options);
  if (data.length !== pack.size || crypto.createHash('sha256').update(data).digest('hex') !== pack.sha256)
    throw new Error(`The ${pack.name} language pack download was incomplete or changed. Try again.`);
  const files = packFiles(unzip(data), pack.code);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, pack.code), staging = path.join(dir, `.${pack.code}-new`);
  fs.rmSync(staging, { recursive: true, force: true });
  for (const file of files) {
    const out = path.join(staging, ...file.name.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.data);
  }
  fs.writeFileSync(path.join(staging, MARKER), JSON.stringify({ version: pack.version, sha256: pack.sha256 }) + '\n');
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  return target;
}

module.exports = { CATALOG, folder, catalogPack, installed, localPacks, choices, normalizeLanguage, chosenFolder, environment,
  needsInstall, unzip, packFiles, install };
