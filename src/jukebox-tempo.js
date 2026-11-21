'use strict';

// Finds the beat of a song from its sound, ahead of time: the Jukebox has the whole of a song rendered before it plays, so the tempo and
// where the beats fall can be worked out from it, and the Purification Chamber's dancers can land on them exactly (a live listener can only
// guess, a moment after the fact). analyze() gives { period, offset, bar, confidence }: a beat every `period` seconds, one of them at
// `offset` seconds into the song, and `bar` which of four beats in a row is the strongest (the first of a bar, as far as drums say).
(function (root) {
  // An in-place FFT of `re` and `im` (power-of-two long).
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, angle = -2 * Math.PI / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = Math.cos(angle * k), wi = Math.sin(angle * k), a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // A tempo as a beat spacing a dancer can keep time to (the same as jukebox-beat.js's): a very fast one is danced at half speed, a very slow one at double.
  function normalizePeriod(seconds, low = 0.3, high = 0.76) {
    let p = Number(seconds);
    if (!(p > 0)) return 0.5;
    while (p < low) p *= 2;
    while (p > high) p /= 2;
    return p;
  }

  const WINDOW = 256;   // samples of the (decimated) sound in each look at it: about 32 ms

  // How much the sound's low and middle end rises at each step (10 ms) through the song: a drum is a spike. `hop` is the step in seconds and
  // `start` the time of the first step's middle.
  function onsets(left, right, rate, seconds) {
    const n = Math.min(left.length, Math.floor(rate * seconds)), decimate = Math.max(1, Math.floor(rate / 8000)), sr = rate / decimate;
    const length = Math.floor(n / decimate), x = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let k = 0; k < decimate; k++) sum += left[i * decimate + k] + right[i * decimate + k];
      x[i] = sum / (2 * decimate);
    }
    const hop = Math.max(1, Math.round(sr * 0.01)), frames = Math.floor((length - WINDOW) / hop);
    if (frames < 200) return null;
    const re = new Float64Array(WINDOW), im = new Float64Array(WINDOW), window = new Float64Array(WINDOW);
    for (let i = 0; i < WINDOW; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WINDOW - 1));
    const bins = Math.min(WINDOW / 2, Math.floor(2400 / (sr / WINDOW))), previous = new Float64Array(bins), flux = new Float64Array(frames);
    for (let t = 0; t < frames; t++) {
      for (let i = 0; i < WINDOW; i++) { re[i] = x[t * hop + i] * window[i]; im[i] = 0; }
      fft(re, im);
      let rise = 0;
      for (let b = 1; b < bins; b++) {
        const level = Math.log1p(1000 * Math.hypot(re[b], im[b]) / WINDOW);
        if (t && level > previous[b]) rise += level - previous[b];
        previous[b] = level;
      }
      flux[t] = rise;
    }
    // what stands out from the last second or so
    const prefix = new Float64Array(frames + 1), span = 50, strength = new Float64Array(frames);
    for (let t = 0; t < frames; t++) prefix[t + 1] = prefix[t] + flux[t];
    for (let t = 0; t < frames; t++) {
      const from = Math.max(0, t - span), to = Math.min(frames, t + span + 1);
      strength[t] = Math.max(0, flux[t] - (prefix[to] - prefix[from]) / (to - from));
    }
    return { strength, hop: hop / sr, start: (WINDOW / 2) / sr };
  }

  // The strength at a time (seconds), between two steps.
  function at(o, seconds) {
    const f = (seconds - o.start) / o.hop;
    if (f < 0 || f >= o.strength.length - 1) return 0;
    const i = Math.floor(f), part = f - i;
    return o.strength[i] * (1 - part) + o.strength[i + 1] * part;
  }

  function analyze(left, right, rate, { seconds = 300, slowest = 60, fastest = 190 } = {}) {
    const o = onsets(left, right, rate, seconds);
    if (!o) return null;
    const { strength, hop } = o, frames = strength.length;
    // the tempo from how well the song repeats itself at each beat spacing, leaning toward the middle of the range music keeps to
    const correlation = lag => { let sum = 0; for (let t = 0; t + lag < frames; t++) sum += strength[t] * strength[t + lag]; return sum / (frames - lag); };
    let best = 0, bestScore = -1;
    for (let bpm = slowest; bpm <= fastest; bpm += 0.5) {
      const lag = Math.round(60 / bpm / hop), prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.8, 2));
      const score = (correlation(lag) + 0.5 * correlation(lag * 2)) * prior;
      if (score > bestScore) { bestScore = score; best = bpm; }
    }
    if (bestScore <= 0) return null;
    // then the spacing and place that put the most of the song's hits on the beats: first a little either side of that tempo, then finer, since
    // a spacing a fraction of a percent out is half a beat out by the song's end
    const end = Math.min(seconds, frames * hop), base = 60 / best;
    const best3 = (period, from, to, step) => {
      let top = null;
      for (let phase = from; phase < to; phase += step) {
        let score = 0;
        for (let time = phase; time < end; time += period) score += at(o, time);
        if (!top || score > top.score) top = { period, offset: phase, score };
      }
      return top;
    };
    let found = null, total = 0, tried = 0;
    for (let scale = 0.97; scale <= 1.03; scale += 0.0025) {
      const period = base * scale;
      for (let phase = 0; phase < period; phase += hop / 2) {
        let score = 0;
        for (let time = phase; time < end; time += period) score += at(o, time);
        total += score; tried++;
        if (!found || score > found.score) found = { period, offset: phase, score };
      }
    }
    if (!found) return null;
    const rough = found.period;
    for (let scale = 0.996; scale <= 1.004; scale += 0.0002) {
      const period = rough * scale, top = best3(period, Math.max(0, found.offset - hop * 1.5), found.offset + hop * 1.5, hop / 8);
      if (top.score > found.score) found = top;
    }
    // game songs keep to a whole number of beats a minute: take that if it fits about as well
    const whole = Math.round(60 / found.period);
    if (Math.abs(60 / found.period - whole) / whole < 0.003) {
      const snapped = best3(60 / whole, Math.max(0, found.offset - hop * 2), found.offset + hop * 2, hop / 8);
      if (snapped.score >= found.score * 0.97) found = snapped;
    }
    const confidence = found.score / (total / tried || 1);
    // which of four beats in a row hits hardest: the drum's first
    const sums = [0, 0, 0, 0];
    for (let k = 0, time = found.offset; time < end; k++, time += found.period) sums[k % 4] += at(o, time);
    const bar = sums.indexOf(Math.max(...sums));
    return { period: found.period, offset: found.offset, bar, confidence, bpm: 60 / found.period };
  }


  // How light or dark the song sounds at `seconds` into it, 0 (dark) to 1 (light); 0.5 where there is no profile.
  function toneAt(profile, seconds) {
    const values = profile?.tone;
    if (!values?.length) return 0.5;
    const f = Math.max(0, Math.min(values.length - 1, seconds / profile.step)), i = Math.floor(f), j = Math.min(values.length - 1, i + 1);
    return values[i] * (1 - (f - i)) + values[j] * (f - i);
  }

  // The key at `seconds` into the song: { tonic (0 is C, 1 is C sharp...), mode (-1 minor to 1 major) }; null where there is no profile.
  function keyAt(profile, seconds) {
    if (!profile?.key?.length) return null;
    const i = Math.max(0, Math.min(profile.key.length - 1, Math.round(seconds / profile.step)));
    return { tonic: profile.key[i], mode: profile.mode[i] };
  }

  // Where a song is really heard: when it first gets loud enough to hear (a second's silence before the music is not worth waiting out) and when it
  // last is (its end is often a fade-out, or a reverb tail, that the next song should not wait for). Loud enough is a fifth of the song's usual level.
  function audible(left, right, rate) {
    const step = Math.max(1, Math.round(rate * 0.05)), windows = Math.floor(left.length / step);
    if (windows < 40) return { lead: 0, end: left.length / rate };
    const level = new Float32Array(windows);
    for (let w = 0; w < windows; w++) {
      let sum = 0;
      for (let i = w * step; i < (w + 1) * step; i++) { const x = (left[i] + right[i]) / 2; sum += x * x; }
      level[w] = Math.sqrt(sum / step);
    }
    const usual = Float32Array.from(level).sort()[Math.floor(windows * 0.6)], floor = usual * 0.2;
    let first = 0, last = windows - 1;
    while (first < windows - 1 && level[first] < floor) first++;
    while (last > first && level[last] < floor) last--;
    return { lead: Math.min(1.5, first * 0.05), end: Math.min(left.length / rate, (last + 1) * 0.05) };
  }

  // Everything the page wants to know about a song, in one go (this is what the analysis worker runs): where it is heard (always), and, when `visual`, its
  // beat grid, its intensity, tone and key and its drops, breaks and changes put on the beat.
  // A song's beat grid for the dancers when its own sequence gives the beats (a Colosseum song's tempo track): the beats' times as they fall, with
  // the tempo it spends longest in. `bar` is which of four beats opens a bar (a sequence starts with one).
  function gridFromBeats(beats) {
    const times = beats?.times;
    if (!times || times.length < 8 || !(beats.period > 0)) return null;
    return { period: beats.period, offset: times[0], bar: 0, confidence: Infinity, beats: times };
  }

  // Where a grid's beats fall, in the beats a dancer keeps (the grid's tempo folded into the dancing range, as normalizePeriod does for the whole
  // song at once, so that the count never jumps): { beatAt(seconds), timeAt(beat), periodAt(seconds), folded }. A grid of one steady beat is a
  // line; a grid with its own `beats` (seconds, one a beat) follows them, tempo changes and all, and goes on at the first or last beat's pace past its ends.
  const maps = new WeakMap();
  function gridMap(grid) {
    if (maps.has(grid)) return maps.get(grid);
    const period = normalizePeriod(grid.period), scale = period / grid.period, beats = grid.beats;
    let map;
    if (!beats || beats.length < 2) {
      map = { beatAt: t => (t - grid.offset) / period, timeAt: b => grid.offset + b * period, periodAt: () => period, folded: scale !== 1 };
    } else {
      const last = beats.length - 1, gapAt = i => beats[Math.min(last, i + 1)] - beats[Math.max(0, Math.min(last - 1, i))] || grid.period;
      // the beat (a number, with the part of a beat past it) that a time falls in
      const rawAt = t => {
        if (t <= beats[0]) return (t - beats[0]) / gapAt(0);
        if (t >= beats[last]) return last + (t - beats[last]) / gapAt(last - 1);
        let low = 0, high = last;
        while (high - low > 1) { const mid = (low + high) >> 1; if (beats[mid] <= t) low = mid; else high = mid; }
        return low + (t - beats[low]) / (beats[low + 1] - beats[low]);
      };
      const rawTime = r => {
        if (r <= 0) return beats[0] + r * gapAt(0);
        if (r >= last) return beats[last] + (r - last) * gapAt(last - 1);
        const i = Math.floor(r);
        return beats[i] + (r - i) * (beats[i + 1] - beats[i]);
      };
      map = {
        beatAt: t => rawAt(t) / scale,
        timeAt: b => rawTime(b * scale),
        periodAt: t => gapAt(Math.max(0, Math.min(last - 1, Math.floor(rawAt(t))))) * scale,
        folded: scale !== 1
      };
    }
    maps.set(grid, map);
    return map;
  }

  // `beats`: the song's own beats ({ times, period }) when its sequence gives them, and then the grid is those; else it is worked out from the sound.
  function study(left, right, rate, visual = true, beats = null) {
    const result = { heard: audible(left, right, rate), grid: null, intensity: null };
    if (!visual) return result;
    const exact = gridFromBeats(beats), found = exact || analyze(left, right, rate);
    if (found && (exact || found.confidence >= CONFIDENT)) result.grid = found;
    result.intensity = intensity(left, right, rate);
    if (result.intensity && result.grid) result.intensity.events = refineEvents(result.intensity.events, result.grid, left, right, rate);
    return result;
  }

  // What an event needs: the loudness cue (the 0..1 change in intensity between the last two seconds and the next two) and the texture cue (the
  // novelty, 0 to 1) are each measured against a typical clear one; an event's score is the larger, with a little more for both, and must reach EVENT_SCORE.
  const EVENT_SOUND = 0.45, EVENT_TEXTURE = 0.22, EVENT_SCORE = 0.9, EVENT_APART = 10;


  // How much each moment of a song stops sounding like the ones before it and starts sounding like the ones after: its texture (which notes and
  // instruments, not how loud) at every quarter second is compared with every other, and a moment where the two sides on either of it are alike
  // within and unlike each other is a change (Foote's novelty, with a kernel of 2 and of 4 seconds). `size` is the samples in a step.
  function textureNovelty(left, right, rate, count, size) {
    const decimate = Math.max(1, Math.floor(rate / 8000)), sr = rate / decimate, length = Math.floor(left.length / decimate), mono = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let k = 0; k < decimate; k++) sum += left[i * decimate + k] + right[i * decimate + k];
      mono[i] = sum / (2 * decimate);
    }
    const N = 1024, bands = 40, re = new Float64Array(N), im = new Float64Array(N), window = new Float64Array(N);
    for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const edges = Array.from({ length: bands + 1 }, (_, b) => Math.round(80 * Math.pow(3800 / 80, b / bands) / (sr / N)));
    const feature = Array.from({ length: count }, () => new Float64Array(bands)), centroid = new Float64Array(count), bass = new Float64Array(count);
    // each band's middle, in hertz, for where the sound's weight is (its centroid) and how much of it is low
    const middle = Array.from({ length: bands }, (_, b) => 80 * Math.pow(3800 / 80, (b + 0.5) / bands));
    for (let c = 0; c < count; c++) {
      const start = Math.max(0, Math.min(length - N, Math.round((c + 0.5) * size / decimate - N / 2)));
      for (let i = 0; i < N; i++) { re[i] = (mono[start + i] || 0) * window[i]; im[i] = 0; }
      fft(re, im);
      let total = 0, weighted = 0, low = 0;
      for (let b = 0; b < bands; b++) {
        let sum = 0, n = 0;
        for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) { sum += Math.hypot(re[k], im[k]); n++; }
        const level = sum / n;
        feature[c][b] = Math.log1p(50 * level);
        total += level; weighted += level * middle[b];
        if (middle[b] < 260) low += level;
      }
      centroid[c] = total > 1e-9 ? weighted / total : 0;
      bass[c] = total > 1e-9 ? low / total : 0;
    }
    // the shape of each moment: each band less its average over the song, then the moment less its own average, as a unit vector
    const mean = new Float64Array(bands);
    for (const f of feature) for (let b = 0; b < bands; b++) mean[b] += f[b] / count;
    for (const f of feature) {
      let level = 0;
      for (let b = 0; b < bands; b++) { f[b] -= mean[b]; level += f[b] / bands; }
      let norm = 0;
      for (let b = 0; b < bands; b++) { f[b] -= level; norm += f[b] * f[b]; }
      norm = Math.sqrt(norm) || 1;
      for (let b = 0; b < bands; b++) f[b] /= norm;
    }
    const alike = new Float32Array(count * count);
    for (let i = 0; i < count; i++) for (let j = i; j < count; j++) {
      let dot = 0;
      for (let b = 0; b < bands; b++) dot += feature[i][b] * feature[j][b];
      alike[i * count + j] = alike[j * count + i] = dot;
    }
    const novelty = new Float32Array(count);
    for (const half of [8, 16]) {
      const taper = Float64Array.from({ length: 2 * half }, (_, a) => { const i = a - half + 0.5; return Math.sign(i) * Math.exp(-0.5 * Math.pow(i / (half * 0.55), 2)); });
      let weight = 0;
      for (const u of taper) weight += Math.abs(u);
      weight *= weight;
      for (let t = 0; t < count; t++) {
        let sum = 0;
        for (let a = 0; a < 2 * half; a++) {
          const row = Math.max(0, Math.min(count - 1, t + a - half)) * count;
          let inner = 0;
          for (let c = 0; c < 2 * half; c++) inner += taper[c] * alike[row + Math.max(0, Math.min(count - 1, t + c - half))];
          sum += taper[a] * inner;
        }
        novelty[t] += Math.max(0, sum / weight) / 2;
      }
    }
    return { novelty, centroid, bass };
  }


  // The notes of each moment: which of the twelve pitch classes (C, C sharp, D...) are sounding, how high the music sits, and, from the notes of the last and
  // next few seconds, the key it is in and whether that key is major or minor (the Krumhansl-Schmuckler method: the notes heard are compared with how
  // often each note of a major or minor key is used, in each of the twelve keys). `size` is the samples in a step.
  const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function correlation(a, b) {
    let ma = 0, mb = 0;
    for (let i = 0; i < 12; i++) { ma += a[i] / 12; mb += b[i] / 12; }
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < 12; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  }
  function pitchTrack(left, right, rate, count, size, reach = 24) {
    const decimate = Math.max(1, Math.floor(rate / 8000)), sr = rate / decimate, length = Math.floor(left.length / decimate), mono = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let k = 0; k < decimate; k++) sum += left[i * decimate + k] + right[i * decimate + k];
      mono[i] = sum / (2 * decimate);
    }
    const N = 4096, re = new Float64Array(N), im = new Float64Array(N), window = new Float64Array(N);
    for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    // the bins that sit on a note (within a third of a semitone of one) between about C2 and G6, and the pitch class and pitch of each
    const bins = [];
    for (let k = 1; k < N / 2; k++) {
      const hz = k * sr / N;
      if (hz < 65 || hz > 1600) continue;
      const midi = 69 + 12 * Math.log2(hz / 440), near = Math.round(midi);
      if (Math.abs(midi - near) <= 0.34) bins.push({ k, pc: ((near % 12) + 12) % 12, midi });
    }
    const chroma = Array.from({ length: count }, () => new Float64Array(12)), register = new Float64Array(count);
    for (let c = 0; c < count; c++) {
      const start = Math.max(0, Math.min(length - N, Math.round((c + 0.5) * size / decimate - N / 2)));
      for (let i = 0; i < N; i++) { re[i] = (mono[start + i] || 0) * window[i]; im[i] = 0; }
      fft(re, im);
      let heard = 0, high = 0, total = 0;
      for (const { k, pc, midi } of bins) {
        const mag = Math.hypot(re[k], im[k]);
        chroma[c][pc] += Math.sqrt(mag);
        heard += mag; high += mag * midi;
      }
      for (let i = 0; i < 12; i++) total += chroma[c][i];
      if (total > 1e-9) for (let i = 0; i < 12; i++) chroma[c][i] /= total; else chroma[c].fill(1 / 12);
      // how high the music sits: the loudness-weighted middle pitch, from about E2 (40) to C7 (96) as 0 to 1
      register[c] = heard > 1e-9 ? Math.max(0, Math.min(1, (high / heard - 40) / 56)) : 0.5;
    }
    // the key at each step, from the notes of `reach` steps either side
    const mode = new Float64Array(count), key = new Uint8Array(count), strength = new Float64Array(count);
    const prefix = Array.from({ length: 12 }, () => new Float64Array(count + 1));
    for (let c = 0; c < count; c++) for (let i = 0; i < 12; i++) prefix[i][c + 1] = prefix[i][c] + chroma[c][i];
    const rotated = (profile, k) => Array.from({ length: 12 }, (_, i) => profile[(i - k + 12) % 12]);
    const majors = Array.from({ length: 12 }, (_, k) => rotated(KS_MAJOR, k)), minors = Array.from({ length: 12 }, (_, k) => rotated(KS_MINOR, k));
    const heardNotes = new Float64Array(12);
    for (let c = 0; c < count; c++) {
      const from = Math.max(0, c - reach), to = Math.min(count, c + reach + 1);
      for (let i = 0; i < 12; i++) heardNotes[i] = (prefix[i][to] - prefix[i][from]) / (to - from);
      let bestMajor = -2, majorKey = 0, bestMinor = -2, minorKey = 0;
      for (let k = 0; k < 12; k++) {
        const major = correlation(heardNotes, majors[k]), minor = correlation(heardNotes, minors[k]);
        if (major > bestMajor) { bestMajor = major; majorKey = k; }
        if (minor > bestMinor) { bestMinor = minor; minorKey = k; }
      }
      // major or minor: how much better the best major key fits than the best minor one, and the key of the better. A minor key fits a major one nearly
      // as well (its relative major has the same notes), so plain minor music still leans a little to major: that lean is taken off first
      mode[c] = Math.max(-1, Math.min(1, (bestMajor - bestMinor - 0.05) / 0.12));
      key[c] = bestMajor >= bestMinor ? majorKey : minorKey;
      strength[c] = Math.max(bestMajor, bestMinor);
    }
    return { register, mode, key, strength };
  }

  // How intense each moment of a song is, 0 (calm) to 1 (the song at its most), by quarter second: its loudness and how bright and busy it
  // sounds, each ranked among the song's own moments (so every song has calm and intense parts of its own, however loud it is) and smoothed over
  // a second or two. Null for a song too short to have a shape.
  function intensity(left, right, rate, { seconds = 600, step = 0.25 } = {}) {
    const n = Math.min(left.length, Math.floor(rate * seconds)), size = Math.max(1, Math.round(rate * step)), count = Math.floor(n / size);
    if (count < 8) return null;
    const loud = new Float64Array(count), busy = new Float64Array(count);
    for (let c = 0; c < count; c++) {
      let power = 0, change = 0, last = 0;
      for (let i = c * size; i < (c + 1) * size; i++) {
        const x = (left[i] + right[i]) / 2;
        power += x * x;
        change += Math.abs(x - last);
        last = x;
      }
      loud[c] = Math.sqrt(power / size);
      busy[c] = change / size;
    }
    const smooth = (a, radius) => a.map((_, i) => {
      let sum = 0, k = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(a.length - 1, i + radius); j++) { sum += a[j]; k++; }
      return sum / k;
    });
    const rank = a => {
      const order = Array.from(a, (v, i) => i).sort((x, y) => a[x] - a[y]), out = new Float64Array(a.length);
      order.forEach((index, position) => { out[index] = position / (a.length - 1); });
      return out;
    };
    const l = rank(smooth(loud, 1)), b = rank(smooth(busy, 1)), mixed = Float64Array.from(l, (v, i) => 0.6 * v + 0.4 * b[i]);
    // The moments that change a song, from two cues: how much the song's loudness and brightness change (a drop: the next couple of seconds are much more
    // intense than the last couple; a break: much less), and how much its texture changes (a new section, instruments or notes, even at the same volume).
    // Either is enough, and both together make an event surer. Each event is a time in seconds, a few seconds from the next.
    const shape = rank(smooth(mixed, 1)), span = Math.round(2 / step), sound = new Float64Array(count), swing = new Float64Array(count);
    const real = (a, i) => {
      let before = 0, after = 0;
      for (let k = 1; k <= span; k++) { before += a[i - k]; after += a[i + k - 1]; }
      return Math.abs(after - before) / (Math.max(before, after) || 1);
    };
    for (let i = span; i + span <= count; i++) {
      let before = 0, after = 0;
      for (let k = 1; k <= span; k++) { before += shape[i - k]; after += shape[i + k - 1]; }
      swing[i] = (after - before) / span;
      // (a change in rank alone could be nothing but a flat stretch's noise, so the sound itself must also be a fifth louder or brighter, or less)
      sound[i] = Math.abs(swing[i]) * Math.min(1, Math.max(real(loud, i), real(busy, i)) / 0.2);
    }
    const tex = textureNovelty(left, right, rate, count, size), texture = tex.novelty;
    const score = Float64Array.from(sound, (v, i) => {
      const a = v / EVENT_SOUND, b = texture[i] / EVENT_TEXTURE;
      return Math.max(a, b) + 0.25 * Math.min(1, Math.min(a, b));
    });
    const found = [];
    for (let i = span; i + span <= count; i++) {
      let top = true;
      for (let k = Math.max(0, i - 4); k <= Math.min(count - 1, i + 4); k++) if (score[k] > score[i]) top = false;
      if (top && score[i] >= EVENT_SCORE) found.push({ i, score: score[i] });
    }
    const events = [];
    for (const candidate of found.sort((a, b) => b.score - a.score))
      if (events.every(each => Math.abs(each.i - candidate.i) * step >= EVENT_APART)) events.push(candidate);
    events.sort((a, b) => a.i - b.i);
    // How light or dark each moment sounds, 0 (dark) to 1 (light), from three things: how bright the sound is (where its weight is, and how much of it is
    // bass), how high the music sits, and whether it is in a major key (light) or a minor one (dark). Half of that is the song's own measure and half
    // is against the rest of the song (so a dark song is dark all through, and its brightest part still stands out), smoothed over a second or so.
    const notes = pitchTrack(left, right, rate, count, size);
    const lightness = Float64Array.from(tex.centroid, (hz, i) => {
      const bright = Math.max(0, Math.min(1, Math.log2(Math.max(hz, 180) / 180) / Math.log2(1500 / 180)));
      const timbre = 0.75 * bright + 0.25 * (1 - Math.min(1, tex.bass[i] * 1.6));
      return 0.4 * timbre + 0.25 * notes.register[i] + 0.35 * (notes.mode[i] + 1) / 2;
    });
    const own = smooth(lightness, 2), against = rank(own), tone = Float32Array.from(smooth(own.map((v, i) => 0.5 * v + 0.5 * against[i]), 1));
    // `values` is smoothed over a second or two (for deciding what to do); `fast` follows each quarter second (for what is shown)
    return { step, tone, mode: Float32Array.from(notes.mode), key: Uint8Array.from(notes.key), register: Float32Array.from(notes.register), values: Float32Array.from(rank(smooth(mixed, 3))), fast: Float32Array.from(rank(smooth(mixed, 0))),
      events: events.map(each => ({ time: each.i * step, kind: swing[each.i] >= 0.12 ? 'drop' : swing[each.i] <= -0.12 ? 'break' : 'change', strength: each.score })) };
  }

  // The intensity at `seconds` into the song (0.5 where there is no profile): the smoothed one, or with `fast` the one that follows every beat.
  function intensityAt(profile, seconds, fast = false) {
    const values = fast ? profile?.fast : profile?.values;
    if (!values?.length) return 0.5;
    const f = Math.max(0, Math.min(values.length - 1, seconds / profile.step)), i = Math.floor(f), j = Math.min(values.length - 1, i + 1);
    return values[i] * (1 - (f - i)) + values[j] * (f - i);
  }


  // Puts each event on the beat of the song's grid where the change really is. The events are found a quarter second at a time, which is about
  // half a beat, so each is moved to whichever beat within a beat of it has the most different sound on its two sides (the two beats
  // before it against the two after, loudness and make-up both). Events and grid as analyze() and intensity() made them; returns new events,
  // each with its `time` on the grid and `beat`, the grid's beat number.
  const REACH = 1;   // beats either way that an event may be moved (a wider reach moved some to another change altogether)
  function refineEvents(events, grid, left, right, rate) {
    if (!events?.length || !grid) return events || [];
    const map = gridMap(grid), decimate = Math.max(1, Math.floor(rate / 8000)), sr = rate / decimate, N = 1024, bands = 32;
    const length = Math.floor(left.length / decimate), mono = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let k = 0; k < decimate; k++) sum += left[i * decimate + k] + right[i * decimate + k];
      mono[i] = sum / (2 * decimate);
    }
    const re = new Float64Array(N), im = new Float64Array(N), window = new Float64Array(N);
    for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const edges = Array.from({ length: bands + 1 }, (_, b) => Math.round(80 * Math.pow(3800 / 80, b / bands) / (sr / N)));
    // the make-up of the sound around a time (in seconds): the log of each band's level, not centred, so that loudness counts
    const look = seconds => {
      const start = Math.max(0, Math.min(length - N, Math.round(seconds * sr - N / 2))), out = new Float64Array(bands);
      for (let i = 0; i < N; i++) { re[i] = (mono[start + i] || 0) * window[i]; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b < bands; b++) {
        let sum = 0, n = 0;
        for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) { sum += Math.hypot(re[k], im[k]); n++; }
        out[b] = Math.log1p(50 * sum / n);
      }
      return out;
    };
    return events.map(event => {
      const centre = Math.round(map.beatAt(event.time));
      // four looks to a beat, over the two beats either side of each candidate beat
      const cache = new Map(), at = quarter => { if (!cache.has(quarter)) cache.set(quarter, look(map.timeAt(quarter / 4))); return cache.get(quarter); };
      const side = (from, to) => {
        const mean = new Float64Array(bands);
        for (let q = from; q < to; q++) { const f = at(q); for (let b = 0; b < bands; b++) mean[b] += f[b] / (to - from); }
        return mean;
      };
      let best = centre, top = -1;
      for (let k = centre - REACH; k <= centre + REACH; k++) {
        const before = side(k * 4 - 8, k * 4), after = side(k * 4, k * 4 + 8);
        let distance = 0;
        for (let b = 0; b < bands; b++) distance += Math.pow(after[b] - before[b], 2);
        // (a half step from the quarter-second reading counts for less, so that a change that was already on a beat stays there)
        distance *= 1 - 0.04 * Math.abs(k - map.beatAt(event.time));
        if (distance > top) { top = distance; best = k; }
      }
      return { ...event, time: map.timeAt(best), beat: best, found: event.time };
    }).filter(each => each.time > 0 && each.time < left.length / rate);
  }

  // What a result's confidence must beat to be trusted: songs with a beat score from about 5 up, and noise about 1.6.
  const CONFIDENT = 3;

  const api = { fft, onsets, analyze, audible, study, intensity, intensityAt, toneAt, keyAt, pitchTrack, refineEvents, normalizePeriod, gridFromBeats, gridMap, CONFIDENT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.coloJukeboxTempo = api;
})(typeof globalThis === 'object' ? globalThis : this);
