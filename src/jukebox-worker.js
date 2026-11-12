'use strict';
// Renders the Jukebox's songs off the main thread (a song takes about a second or two): jukebox-render.js, in a worker.
// Asked { id, rom, sound }, answers { id, left, right, rate, loop } or { id, error }.
const { parentPort } = require('node:worker_threads');
const { Disc } = require('./disc');
const renderer = require('./jukebox-render');

let open = null;   // { rom, disc, renderer }: the disc is kept open while songs are asked of it
parentPort.on('message', ({ id, rom, sound }) => {
  try {
    if (open?.rom !== rom) {
      open?.disc.close();
      open = null;
      const disc = new Disc(rom);
      try { open = { rom, disc, renderer: renderer.create(disc) }; } catch (error) { disc.close(); throw error; }
    }
    const song = open.renderer.render(sound);
    // The samples are copied out of the disc-sized buffers they were mixed in, and handed over rather than copied again.
    const left = Float32Array.from(song.left), right = Float32Array.from(song.right);
    parentPort.postMessage({ id, left, right, rate: song.rate, loop: song.loop }, [left.buffer, right.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
