'use strict';
// Reads the Customize page's heroes off the main thread (a hero with the HD pack's images takes a second or two to
// decode and sort into colour regions): hero-look.js readHero, in a worker. Asked { id, rom, hero, folders, key },
// answers { id, hero } or { id, error }. The last hero read is kept, and the texture folders' index while they stay.
const { parentPort } = require('node:worker_threads');
const texturePackLookup = require('./texture-pack-lookup');
const { readHero } = require('./hero-look');

let index = { key: null, index: null }, kept = null;
parentPort.on('message', ({ id, rom, hero, folders, key }) => {
  try {
    if (index.key !== key) index = { key, index: texturePackLookup.indexFolders(folders) };
    if (kept?.rom !== rom || kept.hero !== hero || kept.key !== key) kept = { rom, hero, key, read: readHero(rom, hero, index.index) };
    parentPort.postMessage({ id, hero: kept.read });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
