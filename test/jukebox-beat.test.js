'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const beat = require('../src/jukebox-beat');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

test('bass energy is the low end\'s loudness, 0 to 1', () => {
  const bins = new Uint8Array(512);
  assert.equal(beat.bassEnergy(bins, 44100), 0);
  bins.fill(255, 0, 8);   // 8 bins of 43 Hz is the first 344 Hz
  assert.equal(beat.bassEnergy(bins, 44100, 160), 1);
  assert.equal(beat.bassEnergy(null, 44100), 0);
  assert.equal(beat.bassEnergy(bins, 0), 0);
});

test('a drum over a steady background is a beat, and the background is not', () => {
  const tracker = beat.createBeatTracker();
  let beats = 0, t = 0;
  for (let i = 0; i < 300; i++, t += 1 / 60) {
    const drum = i % 30 === 0;   // every half second
    if (tracker.push(drum ? 0.9 : 0.25, t).beat) beats++;
  }
  assert.ok(beats >= 9 && beats <= 11, `${beats} beats in 5 seconds of a 120 BPM drum`);
});

test('a steady loud sound never beats, and silence never does', () => {
  const loud = beat.createBeatTracker(), quiet = beat.createBeatTracker();
  let seen = 0;
  for (let i = 0; i < 120; i++) {
    const { beat: struck } = loud.push(0.8, i / 60);
    if (i > 10 && struck) seen++;   // the first reading after silence is a beat; a steady sound after that is not
    if (quiet.push(0, i / 60).beat) seen++;
  }
  assert.equal(seen, 0);
});

test('the beat\'s tempo is the spacing the beats show, and the pulse dies away', () => {
  const tracker = beat.createBeatTracker();
  let last, t = 0;
  for (let i = 0; i < 240; i++, t += 1 / 60) last = tracker.push(i % 30 === 0 ? 0.9 : 0.2, t);
  assert.ok(Math.abs(last.tempo - 0.5) < 0.05, `tempo ${last.tempo}`);
  assert.ok(last.pulse < 1);
  const after = tracker.push(0.2, t + 0.5);
  assert.equal(after.pulse, 0);
});

test('the dancers stand evenly round the ring, each facing the middle', () => {
  const places = beat.ring(5, 4);
  assert.equal(places.length, 5);
  for (const { x, z, yaw } of places) {
    assert.ok(Math.abs(Math.hypot(x, z) - 4) < 1e-9);
    // a model facing +z, turned by yaw, looks along (sin yaw, cos yaw): at the middle from where it stands
    assert.ok(Math.abs(Math.sin(yaw) * 4 + x) < 1e-9 && Math.abs(Math.cos(yaw) * 4 + z) < 1e-9);
  }
  assert.ok(Math.abs(places[0].x) < 1e-9 && places[0].z > 0, 'the first is at the front');
});

test('a dancer hops on the beat, harder on a strong one, and never goes below the floor', () => {
  for (let s = 0; s < 4; s += 0.05) {
    const calm = beat.move({ seconds: s, pulse: 0, tempo: 0.5 }), strong = beat.move({ seconds: s, pulse: 1, tempo: 0.5 });
    assert.ok(calm.y >= 0 && strong.y >= 0);
    assert.ok(strong.y >= calm.y - 1e-9);
    assert.ok(calm.squash <= 1 && calm.squash > 0.9);
  }
  assert.notEqual(beat.move({ seconds: 1, dancer: 0 }).y, beat.move({ seconds: 1, dancer: 0.4 }).y);
});

test('dancers take up a move on alternate bars, and a model with none always idles', () => {
  assert.equal(beat.pickMove({ beats: 5, moves: 0 }), -1);
  const picks = Array.from({ length: 32 }, (_, beats) => beat.pickMove({ beats, moves: 3 }));
  assert.ok(picks.includes(-1) && picks.some(pick => pick >= 0));
  assert.ok(picks.every(pick => pick >= -1 && pick < 3));
  assert.notDeepEqual(picks, Array.from({ length: 32 }, (_, beats) => beat.pickMove({ beats, moves: 3, dancer: 1 })));
});

test('the chamber\'s page and script agree: every element it looks up exists, and the Jukebox hands it the sound', () => {
  const html = read('index.html'), chamber = read('jukebox-chamber.js'), page = read('jukebox-page.js');
  for (const id of new Set([...chamber.matchAll(/\$\('([a-z-]+)'\)/g)].map(match => match[1]))) assert.ok(html.includes(`id="${id}"`), `index.html has no #${id}`);
  assert.ok(html.indexOf('jukebox-beat.js') < html.indexOf('jukebox-chamber.js') || html.includes('type="module" src="jukebox-chamber.js"'));
  assert.match(html, /<div id="jukebox-chamber" class="jukebox-chamber" hidden>/);
  assert.match(page, /createAnalyser\(\)/);
  assert.match(page, /fader\.connect\(analyser\)/);
  assert.match(page, /listen\(\) \{/);
  assert.match(page, /hide\(\) \{ window\.coloJukeboxChamber\?\.hide\(\); \}/);
  assert.match(chamber, /NATIONAL_LUDICOLO = 272/);
});

test('Miror B. dances in the middle: the page asks for his model, which each game\'s disc has under its own name', () => {
  const chamber = read('jukebox-chamber.js'), main = read('main.js'), preload = read('preload.js');
  assert.match(chamber, /jukeboxMirorModel\(\)/);
  assert.match(chamber, /setStar\(model, idleClip, stepClips\)/);
  assert.match(preload, /jukeboxMirorModel: \(\) => ipcRenderer\.invoke\('jukebox-miror-model'\)/);
  assert.match(preload, /jukeboxMirorClip: index => ipcRenderer\.invoke\('jukebox-miror-clip', index\)/);
  assert.match(main, /ipcMain\.handle\(`jukebox-\$\{name\}-model`/);
  // XD's Miror B. is the mirrabo model, and Colosseum's boss555
  assert.match(main, /miror: \(\) => \(config\.game === 'xd' \? 'pkx_mirrabo_0101\.fsys' : 'pkx_boss555_a1\.fsys'\)/);
  assert.match(main, /pkx_mirrabo_0101\.fsys/);
});

test('a turned ring leaves nobody straight in front, and neighbours lean opposite ways while all hop together', () => {
  const places = beat.ring(6, 4, Math.PI / 6);
  // dead ahead or dead behind is on the line x = 0 (the camera looks along z)
  assert.ok(places.every(({ x }) => Math.abs(x) > 0.5), 'no dancer is on the line through the middle, front or back');
  const left = beat.move({ seconds: 0.3, pulse: 0.5, tempo: 0.5, side: 1 }), right = beat.move({ seconds: 0.3, pulse: 0.5, tempo: 0.5, side: -1 });
  assert.equal(left.y, right.y);
  assert.ok(Math.abs(left.roll + right.roll) < 1e-12 && left.roll !== 0);
});

test('the chamber draws the sound as ribbons and a starburst, from the analyser\'s waveform and spectrum', () => {
  const chamber = read('jukebox-chamber.js');
  assert.match(chamber, /function buildVisualizer\(scene\)/);
  assert.match(chamber, /getByteTimeDomainData\(wave\)/);
  assert.match(chamber, /visualizer\.update\(wave, bins, pulse, seconds, playing, energyS, palette, buildupS\)/);
  assert.match(chamber, /visualizer\.dispose\(\)/);
});

test('angles turn the short way round, and easing starts and ends soft', () => {
  assert.ok(Math.abs(beat.angleLerp(0.1, 2 * Math.PI - 0.1, 0.5)) < 1e-9, 'from 0.1 to -0.1 goes through 0, not the long way');
  assert.equal(beat.angleLerp(1, 3, 0), 1);
  assert.ok(Math.abs(beat.angleLerp(1, 3, 1) - 3) < 1e-9);
  assert.equal(beat.ease(0), 0);
  assert.equal(beat.ease(1), 1);
  assert.equal(beat.ease(2), 1);
  assert.ok(beat.ease(0.25) < 0.25 && beat.ease(0.75) > 0.75);
});

test('a jump is the stretch of a motion with the body well above where it began, and a motion that stays low has none', () => {
  const heights = [4.3, 4.3, 4.4, 4.5, 9, 14.5, 16.2, 15.6, 10.2, 4.5, 4.5, 4.4];
  assert.deepEqual(beat.airborne(heights), { take: 4, land: 8 });
  assert.equal(beat.airborne([4.3, 4.4, 4.3, 4.6]), null);
  assert.equal(beat.airborne([]), null);
});

test('the ring hops together and the middle dancer stays on his platform', () => {
  const chamber = read('jukebox-chamber.js');
  assert.match(chamber, /function stay\(dancer\)/);       // each body is held over its own spot
  assert.match(chamber, /stay\(dancer\);/);
  assert.match(chamber, /function stepHop\(/);
  assert.match(chamber, /\['dance', 'turn', 'jump', 'back'\]|state = 'jump'/);
  assert.match(chamber, /chamber\.setDancers\(model, idleClip, moveClips, hopClip\)/);
});

test('a very fast tempo is danced at half speed and a very slow one at double', () => {
  assert.equal(beat.normalizePeriod(0.5), 0.5);
  assert.equal(beat.normalizePeriod(60 / 181), 60 / 181, 'a fast song keeps its beat');
  assert.equal(beat.normalizePeriod(0.2), 0.4);
  assert.equal(beat.normalizePeriod(0.1), 0.4);
  assert.equal(beat.normalizePeriod(1.4), 0.7);
  assert.equal(beat.normalizePeriod(0), 0.5);
});

test('the beat clock keeps time between the beats and puts each beat heard on a whole number', () => {
  const clock = beat.createBeatClock();
  clock.at(9.7);
  clock.onset(10);
  clock.setTempo(0.5, 10);
  for (let k = 1; k <= 20; k++) {
    // a drum every half second, a little early or late, and a hit between the beats that the clock ignores
    const t = 10 + k * 0.5 + (k % 2 ? 0.012 : -0.012);
    clock.onset(t);
    if (k % 3 === 0) clock.onset(t + 0.25);
  }
  const b = clock.at(10 + 20 * 0.5);
  assert.ok(Math.abs(b - 21) < 0.08, `20 beats after the first (beat 1) is at ${b}`);
  assert.ok(Math.abs(clock.at(10 + 20.5 * 0.5) - 21.5) < 0.1, 'and runs on by itself between beats');
  clock.reset();
  assert.equal(clock.synced, false);
});

test('the clock follows a change of tempo without jumping', () => {
  const clock = beat.createBeatClock();
  clock.onset(0);
  const before = clock.at(2);
  clock.setTempo(0.4, 2);
  assert.ok(Math.abs(clock.at(2) - before) < 1e-9, 'its place does not move when the tempo changes');
  assert.ok(clock.period < 0.5 && clock.period > 0.4);
});

test('a motion\'s landings are the low points of its hops, and each lands on a beat when the motion is warped to the beat', () => {
  const lows = [0, 14, 30, 44], n = 59, near = i => Math.min(...lows.map(l => Math.min(Math.abs(i - l), n - Math.abs(i - l))));
  const heights = Array.from({ length: n }, (_, i) => -4.3 + 0.17 * near(i));
  assert.deepEqual(beat.landings(heights), lows);
  assert.deepEqual(beat.landings([1, 1.1, 1, 1.05, 1, 1.1]), [], 'a motion that barely moves has none');
  for (let beatNumber = 0; beatNumber < 12; beatNumber++) {
    const frame = beat.warp(lows, n, beatNumber);
    assert.ok(Math.abs(frame - lows[beatNumber % 4]) < 1e-9, `beat ${beatNumber} is on landing ${beatNumber % 4}`);
  }
  // half way between two beats it is half way between the two landings
  assert.ok(Math.abs(beat.warp(lows, n, 0.5) - 7) < 1e-9);
  // the last landing runs on to the first of the next time round
  assert.ok(Math.abs(beat.warp(lows, n, 3.5) - 51.5) < 1e-9);
  // two beats to a hop: the landings are on every second beat
  assert.equal(beat.warp(lows, n, 2, 2), 14);
});

test('the hop lands on the beat in the dancer\'s body too: its bounce is zero on each beat and higher on the first of a bar', () => {
  for (let k = 0; k < 8; k++) assert.ok(beat.move({ seconds: 99, beat: k, pulse: 0 }).y < 1e-9);
  assert.ok(beat.move({ seconds: 0, beat: 0.5, accent: 1.5 }).y > beat.move({ seconds: 0, beat: 0.5, accent: 1 }).y);
});

test('the dancers keep to the song\'s own beat grid when it has one, and to the live clock when it has not', () => {
  const chamber = read('jukebox-chamber.js'), page = read('jukebox-page.js'), html = read('index.html');
  // the song is studied off the page's thread (jukebox-analysis-worker.js runs study() from jukebox-tempo.js)
  const tempoSource = read('jukebox-tempo.js'), worker = read('jukebox-analysis-worker.js');
  assert.match(tempoSource, /refineEvents\(result\.intensity\.events, result\.grid,/);
  assert.match(worker, /importScripts\('jukebox-tempo\.js'\)/);
  assert.match(worker, /coloJukeboxTempo\.study\(left, right, rate, visual, beats\)/);
  assert.match(page, /new Worker\('jukebox-analysis-worker\.js'\)/);
  assert.match(page, /grid: \(\) => \(active \? songs\.get\(active\.id\)\?\.grid \?\? null : null\)/);
  assert.match(chamber, /function beatNow\(seconds\)/);
  assert.match(chamber, /const map = tempoOf\(\)\.gridMap\(grid\), heard = source\.position\(\) - source\.latency\(\)/);
  assert.match(chamber, /raw = map\.beatAt\(heard\)/);
  assert.match(chamber, /beatOf\(\)\.warp\(marks, clip\.frames, b, perHop\)/);
  assert.ok(html.indexOf('jukebox-tempo.js') > 0 && html.indexOf('jukebox-tempo.js') < html.indexOf('jukebox-page.js'));
});

test('Miror B. strikes in the intense parts of a song, moves a little in the rest, and flips with the Ludicolo\'s leap', () => {
  const chamber = read('jukebox-chamber.js'), page = read('jukebox-page.js');
  assert.match(page, /intensity: \(\) => \(active \? songs\.get\(active\.id\)\?\.intensity \?\? null : null\)/);
  assert.match(chamber, /function sortSteps\(kept, jointCount\)/);
  assert.match(chamber, /level >= INTENSE && strikes\.length/);
  assert.match(chamber, /else if \(level >= EASY\)/);
  assert.match(chamber, /Miror B\. flips as the Ludicolo leap/);
  assert.match(chamber, /T\.intensityAt\(profile, at \+ 0\.4\)/);
  assert.match(chamber, /T\.intensityAt\(profile, at \+ 0\.1, true\)/);
});

test('Miror B. has many ways to dance his few motions, and the ring\'s dancing gets more varied as the song grows intense', () => {
  const chamber = read('jukebox-chamber.js'), html = read('index.html');
  for (const variant of ['normal', 'double', 'spin', 'slide', 'reverse', 'first', 'second', 'sway', 'twist', 'step', 'dip', 'turn', 'wave', 'move']) assert.ok(chamber.includes(`'${variant}'`), variant);
  assert.match(chamber, /function chooseStep\(dancer, level, slot, period\)/);
  assert.match(chamber, /function chooseRing\(dancer, level, slot\)/);
  assert.match(chamber, /function danceRing\(dancer, b, period, dancing, level, spot\)/);
  // all six always dance their idle on the beat: nothing rests, freezes, or comes and goes
  for (const gone of ['resting', 'retarget', 'ORDER', 'presence', 'dancer.hold']) assert.ok(!chamber.includes(gone), `${gone} is gone`);
  assert.match(chamber, /dancer\.frame = idleFrame\(dancer, b, period\);/);
  // a group of dancers chooses alike; more groups the more intense the song
  assert.match(chamber, /level < 0\.5 \? 0 : level < 0\.75 \? dancer\.index % 2 : dancer\.index % 3/);
  assert.match(chamber, /dancer\.blend = \{ from: Float32Array\.from\(dancer\.last\), t: 0 \}/);
  assert.match(chamber, /meter\.style\.setProperty\('--level'/);
  assert.match(html, /id="jukebox-chamber-meter"/);
});

test('the chamber is the Jukebox page\'s backdrop, with the songs in front of it, and Watch clears them away', () => {
  const html = read('index.html'), css = read('style.css'), chamber = read('jukebox-chamber.js');
  const page = html.slice(html.indexOf('<section id="page-jukebox"'), html.indexOf('</section>', html.indexOf('<section id="page-jukebox"')));
  // the chamber comes first in the page, before the header, so that everything else sits over it
  assert.ok(page.indexOf('id="jukebox-chamber"') > 0 && page.indexOf('id="jukebox-chamber"') < page.indexOf('class="modal-head"'));
  for (const id of ['jukebox-chamber-watch', 'jukebox-chamber-back', 'jukebox-chamber-meter']) assert.ok(page.includes(`id="${id}"`), id);
  assert.match(css, /\.jukebox-chamber \{ position: absolute; inset: 0; z-index: 0;/);
  assert.match(css, /\.jukebox-page > :not\(\.jukebox-chamber\) \{ position: relative; z-index: 1; \}/);
  assert.match(css, /\.jukebox-page\[data-watch\] > :not\(\.jukebox-chamber\) \{ opacity: 0; pointer-events: none; \}/);
  assert.match(chamber, /page\.classList\.toggle\('has-chamber', show\)/);
  assert.match(chamber, /chamber\?\.frame\(on \? 'watch' : 'backdrop'\)/);
  // the hall is framed toward the top right while the songs are in front, and centred while you watch
  assert.match(chamber, /backdrop: \{ x: -0\.13, y: 0\.19 \}, watch: \{ x: 0, y: 0\.02 \}/);
});

test('the visualizer has a labelled switch in the page header, and a Hide overlay button that shows only while it is on, with Esc to come back', () => {
  const html = read('index.html'), chamber = read('jukebox-chamber.js'), css = read('style.css');
  const head = html.slice(html.indexOf('<div class="modal-head"><div><h1 id="jukebox-title">'), html.indexOf('id="jukebox-chamber"') > 0 ? html.indexOf('<div id="jukebox-tabs"') : undefined);
  assert.match(head, /<label class="jukebox-viz-switch"[^>]*><input id="jukebox-chamber-toggle" type="checkbox" role="switch" checked>[^]*<span>Visualizer<\/span><\/label>/);
  assert.match(head, /id="jukebox-chamber-watch"[^>]*>[^]*<span>Hide overlay<\/span>/);
  assert.match(html, /id="jukebox-chamber-back"[^>]*hidden[^>]*>[^]*<span>Show overlay<\/span><kbd>Esc<\/kbd>/);
  // the old buttons in the tools row are gone
  const tools = html.slice(html.indexOf('<div id="jukebox-tools"'), html.indexOf('<div class="jukebox-body">'));
  assert.ok(!tools.includes('jukebox-chamber-toggle') && !tools.includes('jukebox-chamber-watch'));
  assert.match(chamber, /\$\('jukebox-chamber-toggle'\)\.addEventListener\('change'/);
  assert.match(chamber, /\$\('jukebox-chamber-watch'\)\.hidden = !show/);
  assert.match(chamber, /event\.key === 'Escape' && \$\('page-jukebox'\)\.hasAttribute\('data-watch'\)/);
  // the glass over the backdrop is light enough to see the visualizer through
  assert.match(css, /\.jukebox-page\.has-chamber \.jukebox-track \{ background: #1f0c1b66;/);
});

test('songs give way to each other with fades: the next is made ahead, crosses in over the end of the one playing, and nothing starts or stops with a click', () => {
  const page = read('jukebox-page.js'), chamber = read('jukebox-chamber.js');
  // every song has a fader of its own, so that two can overlap and fade separately
  assert.match(page, /source\.connect\(fader\);\s*fader\.connect\(gain\);/);
  assert.match(page, /function retire\(song, seconds\)/);
  assert.match(page, /song\.source\.stop\(context\.currentTime \+ Math\.max\(0, seconds\) \+ 0\.05\)/);
  assert.match(page, /const CROSS = 2\.5, MANUAL = 0\.7, QUICK = 0\.12;/);
  // the next song is made while this one plays, and a song asked for twice is made once
  assert.match(page, /function prefetchSoon\(\)/);
  assert.match(page, /const inFlight = new Map\(\)/);
  // it crosses in before the end, from the old song's last audible moment, starting where the new one is first heard
  assert.match(page, /function watchEnd\(\)/);
  assert.match(page, /setInterval\(watchEnd, 100\)/);
  assert.match(page, /found\.heard\?\.lead \?\? 0, false, \{ fade: /);
  assert.match(read('jukebox-tempo.js'), /function audible\(left, right, rate\)/);
  // picking, Next and Previous leave the song playing until the new one is ready, then crossfade; Stop and closing fade out
  assert.match(page, /await start\(id, found, 0, false, \{ fade: active \? MANUAL : QUICK \}\)/);
  assert.match(page, /silence\(0\.4\)/);
  // the chamber starts a new song's beat clock when one crosses into the next while the sound never stops
  assert.match(page, /id: \(\) => active\?\.id \?\? null,/);
  assert.match(chamber, /songId !== lastSongId/);
});

test('the visualizer takes its colours from the music\'s tone: dark tones indigo and violet, light tones pale aqua and gold', () => {
  const chamber = read('jukebox-chamber.js'), page = read('jukebox-page.js');
  assert.match(chamber, /function tint\(tone, keyShift = 0\)/);
  assert.match(chamber, /palette\.hue = \(258 - 86 \* t \+ keyShift\) \/ 360/);                      // indigo at the dark end, aqua at the light
  assert.match(chamber, /function toneNow\(\)/);
  assert.match(chamber, /toneAt\(profile, source\.position\(\) \+ 0\.15\)/);
  assert.match(chamber, /line\.material\.color\.setHSL\(colours\.hue - i \* 0\.012/);   // the ribbons
  assert.match(chamber, /room\.moteMaterial\.color\.copy\(palette\.glow\)/);
  assert.match(chamber, /toneS \+= \(\(playing && !still \? toneNow\(\) : 0\.4\) - toneS\)/);  // eased, so that the colours drift
  // the dancers' own lighting is left alone
  assert.ok(!/lighting\.(ambientLight|lightColor)[^;]*palette/.test(chamber));
});

test('when one song crosses into the next the dancers drop what they had planned in the old song\'s beats and groove into the new one', () => {
  const chamber = read('jukebox-chamber.js'), page = read('jukebox-page.js');
  assert.match(page, /fade: \(\) => active\?\.fadeSeconds \?\? 0,/);
  assert.match(page, /fadeSeconds: seconds,/);
  assert.match(chamber, /function resetDancing\(\)/);
  assert.match(chamber, /const crossed = playing && lastSongId !== null && songId !== null;/);
  assert.match(chamber, /groovePending = crossed \? source\.fade\?\.\(\) \?\? 0 : 0;/);
  assert.match(chamber, /grooving = gt >= 0 && Boolean\(star \? flip : dancer\.clips\.hop\)/);
  // a wave round the ring: each dancer begins a little after the one before
  assert.match(chamber, /dancer\.index \* 0\.09/);
  assert.match(chamber, /&& !grooving/);
});

test('the key tints the visualizer a little: each key has its place on the circle of fifths', () => {
  const chamber = read('jukebox-chamber.js');
  assert.match(chamber, /function keyShiftNow\(\)/);
  assert.match(chamber, /\(key\.tonic \* 7\) % 12 \/ 11 - 0\.5\) \* 36/);
  assert.match(chamber, /tint\(toneS, keyShiftS\)/);
  assert.match(chamber, /function tint\(tone, keyShift = 0\)/);
});

test('the chamber has a stage: ripples from the dancers\' feet on the beat, lamps that sweep and snap, a camera that moves with the music, and the song\'s moments', () => {
  const chamber = read('jukebox-chamber.js'), html = read('index.html'), css = read('style.css');
  // ripples and lamps
  assert.match(chamber, /function buildStage\(scene, spots\)/);
  assert.match(chamber, /ripple\(x, z, strength, size = 4, warm = false\)/);
  assert.match(chamber, /coneGeometry\.rotateX\(-Math\.PI \/ 2\)/);
  assert.match(chamber, /beam\.cone\.lookAt\(beam\.target\)/);
  assert.match(chamber, /const pattern = energy < 0\.35 \? \(bar % 2 \? 3 : 0\) : hash\(bar\) % 5/);   // a quiet song sweeps; a lively one changes what it aims at each bar
  // one ripple a beat, round the ring, and from the middle on the first beat of a bar
  assert.match(chamber, /whole === lastBeat \+ 1/);
  assert.match(chamber, /slot = \(\(whole % DANCERS\) \+ DANCERS\) % DANCERS/);
  assert.match(chamber, /if \(inBar === 0\) stage\.ripple\(0, 0,/);
  // the camera
  assert.match(chamber, /const orbit = Math\.sin\(seconds \* 0\.11\) \* 0\.28/);
  assert.match(chamber, /- 0\.12 \* dolly - 0\.05 \* buildupS/);
  // a drop flashes and pushes in, a break dims and gathers the lamps, and a build-up draws the ribbons in
  assert.match(chamber, /if \(kind === 'drop'\) \{\s*flash = 1; dolly = 1;/);
  assert.match(chamber, /else if \(kind === 'break'\) \{\s*dimmer = 1; solo = 1;/);
  assert.match(chamber, /moment = \{ kind: h\.kind \|\| 'change' \}/);
  assert.match(chamber, /function buildupNow\(\)/);
  assert.match(chamber, /\* \(1 - 0\.2 \* buildup\) \+ sample/);
  assert.match(chamber, /aim\(solo > 0\.5 \? 1 : pattern, i, seconds, beam\.goal\)/);
  // the flash and the dimming are layers of the chamber, behind the page's songs
  assert.match(html, /id="jukebox-chamber-flash"[^>]*><\/div><div id="jukebox-chamber-dim"/);
  assert.match(css, /\.jukebox-chamber-flash, \.jukebox-chamber-dim \{ position: absolute; inset: 0; opacity: 0; pointer-events: none; \}/);
  // the lamps and ripples add less on light songs, or the hall would wash out
  assert.match(chamber, /\(1 - 0\.4 \* palette\.tone\)/);
});

test('the chamber asks less of a weak machine: tiers, a governor that steps down on slow frames, and a glow pass that is hand-written', () => {
  const chamber = read('jukebox-chamber.js'), post = read('jukebox-post.js');
  // four tiers, the top one the default, saved so the next open starts where this one settled
  assert.match(chamber, /export const TIERS = \[/);
  assert.match(chamber, /name: 'minimal'[^\n]*fps: 30/);
  assert.match(chamber, /savedTier\(\) \?\? TIERS\.length - 1/);
  assert.match(chamber, /prefers-reduced-motion: reduce/);
  assert.match(chamber, /if \(judged\.reduce\(\(a, b\) => a \+ b, 0\) \/ judged\.length > SLOW_MS\) stepDown\(\)|> SLOW_MS\) stepDown\(\)/);
  assert.match(chamber, /const slower = tier => Math\.max\(0, tier - 1\)/);
  // the lower tiers draw nothing extra, and the lowest draws every other frame
  assert.match(chamber, /const glowing = post && quality\(\)\.glow && !still/);
  assert.match(chamber, /lamps: quality\(\)\.lamps/);
  // the glow: drawn again small on black, fed back into itself for trails, blurred for bloom, and added over the picture (no three examples in the package)
  assert.doesNotMatch(post, /examples\/jsm|EffectComposer|UnrealBloomPass/);
  assert.match(post, /prepare\(scene, camera, mode,/);
  assert.match(post, /composite\(trailGain, bloomGain\)/);
  assert.match(post, /colorspace_fragment/);
  assert.match(chamber, /post\?\.wipe\(\)/);
});

test('the Jukebox can be taken into a window of its own: the same page, with only the Jukebox showing, and the music playing from there', () => {
  const main = read('main.js'), preload = read('preload.js'), page = read('jukebox-page.js'), html = read('index.html'), css = read('style.css'), flag = read('jukebox-window.js');
  assert.match(main, /opened\.loadFile\(path\.join\(__dirname, 'index\.html'\), \{ query: \{ window: 'jukebox' \} \}\)/);
  assert.match(main, /ipcMain\.handle\('jukebox-window-open'/);
  assert.match(main, /ipcMain\.handle\('jukebox-window-close'/);
  assert.match(main, /window\.on\('closed', closeJukeboxWindow\)/);
  // starting the game ends the music in either window
  assert.match(main, /if \(jukeboxWindowOpen\(\)\) jukeboxWindow\.webContents\.send\('jukebox-stop'\)/);
  assert.match(preload, /jukeboxWindowOpen: snapshot => ipcRenderer\.invoke\('jukebox-window-open', snapshot\)/);
  assert.match(preload, /onJukeboxWindow: callback =>/);
  // (the tests' stand-in for ipcMain only has handle, so everything goes through it)
  assert.doesNotMatch(main, /ipcMain\.on\(/);
  // the window is marked before anything is drawn, and the launcher's frame is hidden by it
  assert.match(html, /<script src="jukebox-window\.js"><\/script>/);
  assert.match(flag, /classList\.add\('jukebox-window'\)/);
  assert.match(css, /\.jukebox-window \.topbar, \.jukebox-window \.nav-bar, \.jukebox-window \.statusbar/);
  // the launcher's own page stops its music while the window is out, says so, and can bring it back
  assert.match(page, /if \(open\) \{ close\(\); window\.coloJukeboxChamber\?\.hide\(\); return; \}/);
  // the song goes across with its place, and comes back the same way
  assert.match(page, /function snapshot\(\)/);
  assert.match(page, /async function restore\(handoff\)/);
  assert.match(page, /jukeboxWindowOpen\(snapshot\(\)\)/);
  assert.match(page, /jukeboxWindowTake\(\)\.then\(restore\)/);
  assert.match(main, /const aged = report =>/);
  assert.match(main, /broadcast\('jukebox-window', \{ open: false, handoff: aged\(jukeboxReport\) \}\)/);
  assert.match(preload, /jukeboxWindowTake: \(\) => ipcRenderer\.invoke\('jukebox-window-take'\)/);
  // another game's disc: the old songs are not brought back
  assert.match(page, /discard = popped;/);
  assert.match(page, /show\(\) \{ if \(popped\) return;/);
  assert.match(html, /id="jukebox-popout"/);
  assert.match(html, /id="jukebox-bring-back"/);
});

test('a song picked from the list grooves in as slowly as one that follows on: the dancers never take less than GROOVE_MIN over it', () => {
  const chamber = read('jukebox-chamber.js');
  assert.match(chamber, /const GROOVE_MIN = 2\.6;/);
  assert.match(chamber, /duration: Math\.max\(GROOVE_MIN, Math\.min\(3\.2, groovePending\)\)/);
});

test('closing the player leaves nothing behind for the chamber to trip on: no analyser, and a latency that copes without a context', () => {
  const page = read('jukebox-page.js');
  assert.match(page, /context = gain = analyser = null;/);
  assert.match(page, /latency: \(\) => context\?\.outputLatency \|\| context\?\.baseLatency \|\| 0/);
});

test('Colosseum has a hall of its own: Miror B.\'s eight-sided gold platforms on a star floor, in amber', () => {
  const chamber = read('jukebox-chamber.js'), main = read('main.js'), preload = read('preload.js');
  assert.match(chamber, /export function createChamber\(canvas, which = 'xd'\)/);
  assert.match(chamber, /hall = which === 'colosseum' \? 'colosseum' : 'xd'/);
  assert.match(chamber, /function tintColosseum\(tone, keyShift\)/);
  assert.match(chamber, /const gold = hall === 'colosseum', sides = gold \? 8 : 96/);
  assert.match(chamber, /createChamber\(canvas, hallGame\)/);
  assert.match(chamber, /if \(!\$\('page-jukebox'\)\.hidden\) sync\(\);/);
  assert.match(main, /ipcMain\.handle\('jukebox-game', \(\) => config\.game\)/);
  assert.match(preload, /jukeboxGame: \(\) => ipcRenderer\.invoke\('jukebox-game'\)/);
  assert.doesNotMatch(main, /DEBUG_MIROR/);
});

test('a song picked never waits behind the next one being made ahead: they are rendered by workers of their own', () => {
  const main = read('main.js'), preload = read('preload.js'), page = read('jukebox-page.js');
  assert.match(main, /const jukeboxWorkers = \{ now: null, ahead: null, head: null \};/);
  assert.match(main, /ipcMain\.handle\('jukebox-render', \(_event, id, lane, most\) => jukeboxRender\(String\(id\), String\(lane\)/);
  assert.match(preload, /jukeboxRender: \(id, lane = 'now', most = 0\) => ipcRenderer\.invoke\('jukebox-render', id, lane, most\)/);
  assert.match(page, /song\(next\.id, 'ahead'\)/);
  assert.match(page, /jukeboxRender\(id, lane\)/);
});

test('a long song starts from its first seconds, made on their own, and the whole song takes over in the same place', () => {
  const main = read('main.js'), worker = read('jukebox-worker.js'), page = read('jukebox-page.js');
  assert.match(worker, /render\(sound, most > 0 \? \{ most \} : undefined\)/);
  assert.match(main, /worker\.postMessage\(\{ id: request, rom, sound: track\.sound, most \}\)/);
  assert.match(page, /const HEAD = 15, HEAD_MIN = 45, HANDOVER = 0\.06;/);
  assert.match(page, /jukeboxRender\(id, 'head', HEAD\)/);
  assert.match(page, /Promise\.race\(\[whole\.then\(found => \(\{ found \}\)\), headOf\(id\)/);
  assert.match(page, /await start\(id, first\.head, 0, false, \{ fade: active \? MANUAL : QUICK, partial: true \}\)/);
  assert.match(page, /await handOver\(id, found, first\.head\.buffer\.duration\)/);
  // the first seconds running out is not a song finishing, and they never take part in the crossing into the next song
  assert.match(page, /if \(!partial\) finished\(\);/);
  assert.match(page, /if \(!active \|\| active\.partial \|\| state\.paused/);
});

test('the first seconds of a song are the song\'s own: the same sound as the whole render, to the last sample, until their end nears', () => {
  const { Disc } = require('../src/disc');
  const rom = process.env.COLOSSEUM_ROM;
  if (!rom) return;   // (needs the player's disc)
  const render = require('../src/jukebox-render').create(new Disc(rom));
  const head = render.render(2, { most: 6 }), whole = render.render(2);
  const until = head.left.length - head.rate * 2;
  for (let n = 0; n < until; n += 7) assert.equal(head.left[n], whole.left[n]);
});

test('the whole song is asked for with no limit: only a number of seconds above nothing cuts a song short', () => {
  const { asked } = require('../src/jukebox-songs');
  assert.equal(asked(0), 0);
  assert.equal(asked(undefined), 0);
  assert.equal(asked(null), 0);
  assert.equal(asked(NaN), 0);
  assert.equal(asked('15'), 0);
  assert.equal(asked(-3), 0);
  assert.equal(asked(15), 15);
  assert.equal(asked(0.2), 1);
  assert.equal(asked(5000), 120);
  assert.match(read('main.js'), /jukeboxSongs\.asked\(most\)/);
});

test('a Colosseum song gives the dancers its own beats, from its sequence, and the page hands them to the study', () => {
  const render = read('jukebox-render.js'), worker = read('jukebox-worker.js'), page = read('jukebox-page.js');
  assert.match(render, /beats: music\.beatTimes\(song, length\)/);
  assert.match(worker, /beats: song\.beats/);
  assert.match(page, /beats: rendered\.beats \|\| null/);
  assert.match(page, /visual, beats: entry\.beats/);
});
