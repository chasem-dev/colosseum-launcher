'use strict';
// Studies a Jukebox song off the page's thread: where it is heard, and, when the visualizer is on, its beat grid, intensity, tone, key and the
// drops, breaks and changes in it (jukebox-tempo.js). The page hands over the song's sound and carries on playing it: nothing here is waited
// for, and the page has no stutter while it runs (it takes a few tenths of a second, a little more for a long song).
// Asked { id, left, right, rate, visual, beats } (beats: the song's own, when its sequence gives them), answers { id, result } or { id, error }.
importScripts('jukebox-tempo.js');

self.onmessage = ({ data: { id, left, right, rate, visual, beats } }) => {
  try {
    self.postMessage({ id, result: self.coloJukeboxTempo.study(left, right, rate, visual, beats) });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
};
