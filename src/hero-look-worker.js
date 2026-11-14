'use strict';
// Reads the Customize page's heroes off the main thread (a hero with the HD pack's images takes a second or two to
// decode and sort into colour regions, and a motion moved over from Wes's is worked out frame by frame): hero-look.js,
// in a worker. Asked { id, rom, hero, kind, folders, key } for a model or { id, rom, hero, motion } for a motion,
// answers { id, result } or { id, error }. The disc's models stay read, and the texture folders' index while it's the same.
const { parentPort } = require('node:worker_threads');
const texturePackLookup = require('./texture-pack-lookup');
const { createReader } = require('./hero-look');

let reader = null, index = { key: null, index: null };
parentPort.on('message', ({ id, rom, hero, kind, motion, wesMoves, folders, key }) => {
  try {
    if (reader?.rom !== rom) reader = { rom, read: createReader(rom) };
    let result;
    if (motion) result = reader.read.clip(hero, motion, { wesMoves: Boolean(wesMoves) });
    else {
      if (index.key !== key) index = { key, index: texturePackLookup.indexFolders(folders) };
      result = reader.read.hero(hero, kind, index.index);
    }
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
