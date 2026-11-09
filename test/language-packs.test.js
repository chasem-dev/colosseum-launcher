'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const languagePacks = require('../src/language-packs');
const port = require('../src/port');

// A zip as make_language_packs.py writes one: deflated entries, a central directory at the end.
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text, stored] of entries) {
    const data = Buffer.from(text);
    const body = stored ? data : zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'colo-languages-')); }

function packFor(data, code = 'fr') {
  return { code, name: 'Français', version: '1.0.0', url: 'https://example.invalid/fr.zip', size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

function fakeFetch(data, status = 200) {
  return async () => ({ ok: status === 200, status, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) });
}

test('the catalog lists the four European languages, each a pinned download', () => {
  assert.deepEqual(languagePacks.CATALOG.packs.map(pack => pack.code), ['fr', 'de', 'es', 'it']);
  for (const pack of languagePacks.CATALOG.packs) {
    assert.match(pack.url, /^https:\/\/github\.com\/chasem-dev\/pokemon-colosseum-extras\/releases\/download\//);
    assert.match(pack.sha256, /^[0-9a-f]{64}$/);
    assert.ok(pack.size > 0);
  }
});

test('the language setting keeps a pack code and falls back to English', () => {
  assert.equal(port.normalizeSettings({}).language, 'en');
  assert.equal(port.normalizeSettings({ language: 'fr' }).language, 'fr');
  assert.equal(port.normalizeSettings({ language: 'pt-br' }).language, 'pt-br');
  assert.equal(port.normalizeSettings({ language: '../etc' }).language, 'en');
  assert.equal(port.normalizeSettings({ language: 7 }).language, 'en');
});

test('unzip reads stored and deflated entries', () => {
  const files = languagePacks.unzip(zip([['fr/text.txt', '04e25\tBonjour\n'], ['fr/pack.json', '{}', true]]));
  assert.deepEqual(files.map(file => [file.name, file.data.toString()]), [['fr/text.txt', '04e25\tBonjour\n'], ['fr/pack.json', '{}']]);
});

test('a pack may not write outside its folder', () => {
  assert.throws(() => languagePacks.packFiles([{ name: 'fr/../evil.txt', data: Buffer.alloc(0) }, { name: 'fr/text.txt', data: Buffer.alloc(0) }], 'fr'), /outside its folder/);
  assert.throws(() => languagePacks.packFiles([{ name: 'de/text.txt', data: Buffer.alloc(0) }], 'fr'), /outside its folder/);
  assert.throws(() => languagePacks.packFiles([{ name: 'fr/pack.json', data: Buffer.alloc(0) }], 'fr'), /no text/);
});

test('install checks the download, unpacks it and marks it installed', async () => {
  const dir = tempDir();
  try {
    const data = zip([['fr/pack.json', '{"code":"fr","name":"Français"}'], ['fr/text.txt', '04e25\tBonjour\n'], ['fr/files/topmenu.fsys/menu_031.gtx', 'GTX']]);
    const pack = packFor(data);
    const catalog = { packs: [pack] };
    assert.equal(languagePacks.needsInstall({ language: 'fr' }, dir, catalog), true);
    let progress = 0;
    const target = await languagePacks.install(dir, pack, { fetchImpl: fakeFetch(data), onProgress: have => { progress = have; } });
    assert.equal(progress, data.length);
    assert.equal(fs.readFileSync(path.join(target, 'text.txt'), 'utf8'), '04e25\tBonjour\n');
    assert.equal(fs.readFileSync(path.join(target, 'files', 'topmenu.fsys', 'menu_031.gtx'), 'utf8'), 'GTX');
    assert.equal(languagePacks.installed(dir, pack), true);
    assert.equal(languagePacks.needsInstall({ language: 'fr' }, dir, catalog), false);
    assert.deepEqual(languagePacks.environment({ language: 'fr' }, dir), { COLO_LANGUAGE: target });
    assert.deepEqual(languagePacks.environment({ language: 'en' }, dir), {});
    // a newer pack replaces the old copy whole
    const newer = zip([['fr/pack.json', '{}'], ['fr/text.txt', '04e25\tSalut\n']]);
    await languagePacks.install(dir, packFor(newer), { fetchImpl: fakeFetch(newer) });
    assert.equal(fs.readFileSync(path.join(target, 'text.txt'), 'utf8'), '04e25\tSalut\n');
    assert.equal(fs.existsSync(path.join(target, 'files')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a download that does not match the catalog is refused and changes nothing', async () => {
  const dir = tempDir();
  try {
    const data = zip([['fr/text.txt', 'x']]);
    const pack = { ...packFor(data), sha256: '0'.repeat(64) };
    await assert.rejects(languagePacks.install(dir, pack, { fetchImpl: fakeFetch(data) }), /incomplete or changed/);
    await assert.rejects(languagePacks.install(dir, packFor(data), { fetchImpl: fakeFetch(data, 404) }), /HTTP 404/);
    assert.equal(fs.existsSync(path.join(dir, 'fr')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a folder with a pack.json is a language too: a fan translation', () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'pl'));
    fs.writeFileSync(path.join(dir, 'pl', 'pack.json'), JSON.stringify({ code: 'pl', name: 'Polski', version: '0.1' }));
    fs.writeFileSync(path.join(dir, 'pl', 'text.txt'), '');
    fs.mkdirSync(path.join(dir, 'notes'));   // no pack.json: not a language
    const catalog = { packs: [{ code: 'fr', name: 'Français', sha256: 'a'.repeat(64) }] };
    const list = languagePacks.choices(dir, catalog);
    assert.deepEqual(list.map(item => item.code), ['en', 'fr', 'pl']);
    assert.equal(list.find(item => item.code === 'fr').installed, false);
    assert.deepEqual(list.find(item => item.code === 'pl'), { code: 'pl', name: 'Polski', version: '0.1', installed: true, local: true });
    assert.equal(languagePacks.needsInstall({ language: 'pl' }, dir, catalog), false);
    assert.deepEqual(languagePacks.environment({ language: 'pl' }, dir), { COLO_LANGUAGE: path.join(dir, 'pl') });
    // a chosen pack that is gone plays in English
    assert.deepEqual(languagePacks.environment({ language: 'sv' }, dir), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
