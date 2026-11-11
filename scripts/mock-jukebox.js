'use strict';
// A stand-in for the game in jukebox mode (src/jukebox.js describes the protocol), for developing the Jukebox
// without a game build or disc: it plays nothing, and each "song" lasts MOCK_SONG_MS (3 seconds) of silence.
// COLO_JUKEBOX_MOCK=1 npm start  makes the launcher use it.
const readline = require('node:readline');

if (!process.argv.includes('--jukebox')) {
  console.error('Not started in jukebox mode.');
  process.exit(2);
}
const songMs = Number(process.env.MOCK_SONG_MS) || 3000;
let timer = null, current = null, paused = false, remaining = 0, startedAt = 0;
const say = line => process.stdout.write(`${line}\n`);

function schedule(ms) {
  clearTimeout(timer);
  remaining = ms;
  startedAt = Date.now();
  timer = setTimeout(() => { current = null; paused = false; say('ended'); }, ms);
}

say('ready');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const [name, ...rest] = line.trim().split(/\s+/);
  const numbers = rest.map(Number);
  if (name === 'play' && numbers.length === 2 && numbers.every(Number.isInteger)) {
    current = numbers; paused = false;
    schedule(songMs);
    say(`playing ${numbers[0]} ${numbers[1]}`);
  } else if (name === 'pause' && current && !paused) {
    paused = true; clearTimeout(timer); remaining -= Date.now() - startedAt;
    say('paused');
  } else if (name === 'resume' && current && paused) {
    paused = false; schedule(remaining);
    say('resumed');
  } else if (name === 'stop') {
    clearTimeout(timer); current = null; paused = false;
    say('stopped');
  } else if (name === 'volume' && numbers.length === 1) {
    // accepted; nothing to turn down
  } else if (name === 'quit') {
    process.exit(0);
  } else {
    say(`error unknown command: ${line.trim()}`);
  }
});
process.stdin.on('end', () => process.exit(0));
