// The Jukebox: the game's songs, listed to pick from. A song is rendered from the player's disc in the main process (src/jukebox-render.js,
// in a worker, about a second or two) and played here with Web Audio; no game runs. A song with a loop point of its own repeats that
// part while Loop is on, and otherwise plays through to its end and goes on to the next song.
// The player (the bar under every page) shows once a song is picked and goes with you to the other pages, so the music can play
// while you build a team; its X ends the music and puts it away, and so does starting the game.
(() => {
  const $ = id => document.getElementById(id);
  const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const KEEP = 4;   // rendered songs kept: the one playing, the one before it, the one coming, and one more
  // How songs give way to each other, in seconds: a song that plays through is overlapped with the next for CROSS; a song picked, or Next and Previous,
  // are crossfaded over MANUAL; and every start, seek and stop has at least a QUICK fade, so that there is never a click.
  const CROSS = 2.5, MANUAL = 0.7, QUICK = 0.12;
  // A time as a clock shows it: 1:41.
  const clock = seconds => {
    const whole = seconds >= 0 ? Math.round(seconds) : 0;
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  };
  // A song's length in the list: the clock's, except that a jingle over in a moment shows tenths of a second ("0.4 s").
  const lengthText = seconds => (seconds > 0 && seconds < 9.95 ? `${seconds.toFixed(1)} s` : clock(seconds));

  let tracks = null, loading = null, current = null, busy = false, notice = '', tab = 'music', query = '', filter = 'all';
  let state = { playing: null, paused: false, volume: 100 };
  // The player's playlists (jukebox-playlists.js): for now only Favorites, the songs starred, is shown (its own tab); any others
  // saved are kept as they are. And the one playing: { id, name, order (song ids), at, shuffled } while songs play from it, when
  // previous, next and a song's end go through it alone.
  const lists = window.coloJukeboxPlaylists;
  let playlists = [], queue = null;
  let context = null, gain = null, analyser = null, active = null, token = 0, crossing = false, prefetching = null;
  const songs = new Map();   // id -> { buffer, loop }, oldest first
  // Music or a sound effect: each has its tab, and the previous and next buttons stay among those of the same kind.
  const kindOf = track => (track?.kind === 'sfx' ? 'sfx' : 'music');
  const TABS = ['music', 'sfx', 'favorites'];
  const pool = () => {
    if (!tracks) return [];
    const kind = current ? kindOf(tracks.find(each => each.id === current)) : tab;
    return tracks.filter(each => kindOf(each) === kind);
  };
  const index = () => pool().findIndex(each => each.id === current);

  // Search and filters: what the list shows. A search ignores case and accents ("pokemon" finds "Pokémon").
  const plain = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const FILTERS = {
    music: [['all', 'All'], ['tunes', 'Tunes'], ['battles', 'Battles'], ['jingles', 'Jingles']],
    sfx: [['all', 'All']]
  };
  const matches = track => {
    if (query && !plain(track.name).includes(plain(query))) return false;
    if (filter === 'all') return true;
    if (kindOf(track) === 'sfx') return track.group === filter;
    const battle = window.coloJukeboxCover.kind(track) === 'battle';
    return filter === 'jingles' ? Boolean(track.short) : filter === 'battles' ? battle : !track.short && !battle;
  };
  // the effects' filters are their groups, as the disc has them
  // How the list is shown, and in what order. The view is kept for each tab, and the order for both, in this browser's storage
  // (a convenience: without it, the grid in the game's order).
  const VIEWS = ['grid', 'list', 'compact'], SORTS = ['game', 'name', 'name-desc', 'type', 'length', 'length-desc'];
  const stored = (key, allowed, fallback) => { try { const value = localStorage.getItem(key); return allowed.includes(value) ? value : fallback; } catch (_) { return fallback; } };
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch (_) { /* not kept */ } };
  const views = { music: stored('jukebox-view-music', VIEWS, 'grid'), sfx: stored('jukebox-view-sfx', VIEWS, 'grid') };
  let sort = stored('jukebox-sort', SORTS, 'game');
  // what a song is, in the list's Type column: a tune, a battle or a jingle; an effect's group
  const typeOf = track => (kindOf(track) === 'sfx' ? track.group : track.short ? 'Jingle' : window.coloJukeboxCover.kind(track) === 'battle' ? 'Battle' : 'Tune');
  const COMPARE = {
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    type: (a, b) => typeOf(a).localeCompare(typeOf(b)),
    length: (a, b) => (a.seconds ?? 0) - (b.seconds ?? 0)
  };
  const ordered = list => {
    if (sort === 'game') return list;
    const [field, way] = sort.split('-'), out = [...list].sort(COMPARE[field]);   // (a stable sort: ties keep the game's order)
    return way === 'desc' ? out.reverse() : out;
  };
  const setSort = value => { sort = SORTS.includes(value) ? value : 'game'; store('jukebox-sort', sort); render(); };
  // a column's heading: sorts by it, and again the other way
  const COLUMNS = [['name', 'Name'], ['type', 'Type'], ['length', 'Length']];
  function columns(view) {
    const row = document.createElement('div');
    row.className = 'jukebox-columns';
    row.setAttribute('aria-hidden', 'true');   // the Sort menu says the same to a screen reader
    if (view === 'list') row.append(document.createElement('span'));
    for (const [field, label] of COLUMNS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.dataset.sort = field;
      const on = sort === field || sort === `${field}-desc`;
      button.textContent = on ? `${label} ${sort.endsWith('-desc') ? '\u2193' : '\u2191'}` : label;
      if (on) button.classList.add('on');
      button.addEventListener('click', () => setSort(sort === field && field !== 'type' ? `${field}-desc` : field));
      row.append(button);
    }
    return row;
  }

  const filtersFor = () => (tab === 'sfx'
    ? [['all', 'All'], ...[...new Set((tracks ?? []).filter(each => kindOf(each) === 'sfx').map(each => each.group))].map(group => [group, group])]
    : FILTERS.music);

  function render() {
    const list = $('jukebox-list');
    const hasEffects = Boolean(tracks?.some(each => kindOf(each) === 'sfx'));
    if (!hasEffects && tab === 'sfx') tab = 'music';
    $('jukebox-tabs').hidden = !tracks;
    $('jukebox-tab-sfx').hidden = !hasEffects;
    for (const kind of TABS) $(`jukebox-tab-${kind}`).setAttribute('aria-selected', String(tab === kind));
    const onFavorites = tab === 'favorites';
    $('jukebox-tools').hidden = $('jukebox-list').hidden = onFavorites;
    $('jukebox-favorites').hidden = !onFavorites;
    if (onFavorites) { $('jukebox-nomatch').hidden = true; renderFavorites(); }
    if (!filtersFor().some(([id]) => id === filter)) filter = 'all';
    const options = filtersFor();
    const bar = $('jukebox-filters');
    if (bar.dataset.rendered !== `${tab}:${options.length}`) {
      bar.replaceChildren(...options.map(([id, label]) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'jukebox-filter';
        chip.dataset.filter = id;
        chip.textContent = label;
        chip.addEventListener('click', () => { filter = id; render(); });
        return chip;
      }));
      bar.dataset.rendered = `${tab}:${options.length}`;
    }
    bar.hidden = options.length < 2;
    for (const chip of bar.children) chip.setAttribute('aria-pressed', String(chip.dataset.filter === filter));
    const view = views[tab] ?? 'grid';
    for (const button of $('jukebox-views').children) button.setAttribute('aria-pressed', String(button.dataset.view === view));
    $('jukebox-sort').value = sort;
    const shown = `${tab}:${filter}:${query}:${sort}:${view}:${tracks?.length}`;
    if (tracks && !onFavorites && list.dataset.rendered !== shown) {
      const items = view === 'grid' ? [] : [columns(view)];
      let group = null;
      const visible = ordered(tracks.filter(each => kindOf(each) === tab && matches(each)));
      for (const track of visible) {
        // the sound effects are in groups, each under its heading (in the game's order: sorted, the groups are mixed)
        if (sort === 'game' && track.group && track.group !== group) {
          group = track.group;
          const heading = document.createElement('h2');
          heading.className = 'jukebox-group';
          heading.textContent = `${group} effects`;
          items.push(heading);
        }
        // the short tracks and jingles follow the tunes, under a heading of their own
        if (sort === 'game' && track.short && !items.some(item => item.tagName === 'H2')) {
          const heading = document.createElement('h2');
          heading.className = 'jukebox-group';
          heading.textContent = 'Short tracks and jingles';
          items.push(heading);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jukebox-track';
        button.dataset.id = track.id;
        const chip = document.createElement('span');
        chip.className = 'jukebox-chip';
        chip.setAttribute('aria-hidden', 'true');
        chip.innerHTML = window.coloJukeboxCover.disc(track);
        button.append(chip);
        const name = document.createElement('span');
        name.className = 'jukebox-track-name';
        name.textContent = track.name;
        button.append(name);
        const type = document.createElement('span');
        type.className = 'jukebox-track-type';
        type.textContent = typeOf(track);
        button.append(type);
        if (typeof track.seconds === 'number') {
          const length = document.createElement('span');
          length.className = 'jukebox-track-length';
          length.textContent = lengthText(track.seconds);
          button.append(length);
        }
        button.title = track.name;   // the whole name, for a long one in a narrow window
        button.addEventListener('click', () => play(track.id));
        // the song and its star, side by side (a button can't hold another)
        const item = document.createElement('div');
        item.className = 'jukebox-item';
        item.dataset.id = track.id;
        item.append(button, star(track));
        items.push(item);
      }
      list.replaceChildren(...items);
      list.dataset.rendered = shown;
      list.dataset.view = view;
      const all = tracks.filter(each => kindOf(each) === tab).length;
      $('jukebox-count').textContent = visible.length === all ? `${all}` : `${visible.length} of ${all}`;
      $('jukebox-nomatch').hidden = visible.length > 0;
    }
    for (const starred of document.querySelectorAll('.jukebox-star[data-id]')) {
      const on = lists.isFavorite(playlists, starred.dataset.id);
      starred.setAttribute('aria-pressed', String(on));
    }
    for (const button of list.querySelectorAll('.jukebox-track')) {
      button.classList.toggle('selected', button.dataset.id === current);
      button.classList.toggle('playing', button.dataset.id === state.playing && !state.paused);
      if (button.dataset.id === current) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
    }
    $('jukebox-dock').hidden = !current;
    $('jukebox-empty').hidden = tracks === null || tracks.length > 0;
    const track = tracks?.find(each => each.id === current);
    $('jukebox-now').textContent = track ? track.name : 'Nothing playing';
    // the player's disc is drawn again only for another song, so that its turning is not started over by every update
    const disc = $('jukebox-disc');
    if (disc.dataset.id !== (track?.id ?? '')) { disc.innerHTML = track ? window.coloJukeboxCover.disc(track) : ''; disc.dataset.id = track?.id ?? ''; }
    disc.classList.toggle('spinning', Boolean(state.playing) && !state.paused);
    const where = queue ? ` · ${queue.name}, ${queue.at + 1} of ${queue.order.length}${queue.shuffled ? ', shuffled' : ''}` : '';
    $('jukebox-status').textContent = notice || ((busy ? 'Preparing the song…' : state.playing ? (state.paused ? 'Paused' : 'Playing') : current ? 'Ready' : '') + where);
    const dockStar = $('jukebox-star');
    dockStar.disabled = !current;
    dockStar.dataset.id = current ?? '';
    dockStar.setAttribute('aria-pressed', String(Boolean(current) && lists.isFavorite(playlists, current)));
    const playing = Boolean(state.playing) && !state.paused;
    // Play and pause are icons, to keep the player one thin row; what the button does is its label
    const toggle = $('jukebox-toggle'), action = playing ? 'Pause' : state.paused ? 'Resume' : 'Play';
    if (toggle.dataset.action !== action) {
      toggle.innerHTML = playing ? '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="4" width="3.5" height="12" rx="1"/><rect x="11.5" y="4" width="3.5" height="12" rx="1"/></svg>'
        : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z"/></svg>';
      toggle.dataset.action = action;
      toggle.setAttribute('aria-label', action);
      toggle.title = action;
    }
    const none = !pool().length;
    $('jukebox-toggle').disabled = none || busy;
    $('jukebox-previous').disabled = $('jukebox-next').disabled = none || busy;
    $('jukebox-stop').disabled = !state.playing;
    $('jukebox-volume').value = state.volume;
    tick();
  }

  // The sound out of the page: made when a song is first played, and let go of when the page is left.
  function output() {
    if (!context) {
      context = new AudioContext({ latencyHint: 'playback' });
      gain = context.createGain();
      gain.gain.value = state.volume / 100;
      gain.connect(context.destination);
      // listened to by the Purification Chamber, before the volume so that a quiet player dances as much as a loud one
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
    }
    return context;
  }

  // A fade as it sounds right: out follows the cosine and in the sine, so that two songs crossing keep the same loudness through the middle.
  const curve = (fadeIn, points = 48) => Float32Array.from({ length: points }, (_, i) => Math.sin((fadeIn ? i : points - 1 - i) / (points - 1) * Math.PI / 2));
  function fade(param, fadeIn, seconds) {
    const at = context.currentTime;
    param.cancelScheduledValues(at);
    if (!(seconds > 0)) { param.setValueAtTime(fadeIn ? 1 : 0, at); return; }
    param.setValueCurveAtTime(curve(fadeIn), at, seconds);
  }

  // Lets a song go: it fades out over `seconds` and is stopped when it has, on the sound's own clock (so a pause in the middle waits too).
  function retire(song, seconds) {
    if (!song) return;
    song.source.onended = null;
    try {
      fade(song.fader.gain, false, seconds);
      song.source.stop(context.currentTime + Math.max(0, seconds) + 0.05);
    } catch (_) { /* never started */ }
    song.source.addEventListener('ended', () => { try { song.fader.disconnect(); song.source.disconnect(); } catch (_) { /* already */ } }, { once: true });
  }

  // Ends what is playing, quietly: it fades out, and its end does not count as a song that finished.
  function silence(seconds = 0.3) {
    const song = active;
    active = null;
    retire(song, seconds);
    state = { ...state, playing: null, paused: false };
  }

  // --- What is worked out about a song, off the page's thread. The sound is copied to a worker (jukebox-analysis-worker.js), which studies it while the song
  // plays: where it is heard (for the crossfades) and, when the visualizer is on, its beat, intensity, tone and key. The song does not wait for any of it, and
  // nothing is worked out for the visualizer if the visualizer is off.
  const visualizerOn = () => { try { return localStorage.getItem('colo.jukebox.chamber') !== 'off'; } catch (_) { return true; } };
  let analyst = null;
  const studies = new Map();   // request -> { id, visual }
  let studyCount = 0;
  function study(id, visual) {
    const entry = songs.get(id);
    if (!entry || entry.studying || entry.studied === 'visual' || (entry.studied && !visual)) return;
    entry.studying = true;
    const left = entry.buffer.getChannelData(0).slice(), right = entry.buffer.getChannelData(entry.buffer.numberOfChannels > 1 ? 1 : 0).slice();
    try {
      analyst ||= new Worker('jukebox-analysis-worker.js');
      analyst.onmessage = ({ data }) => {
        const job = studies.get(data.id);
        studies.delete(data.id);
        const found = job && songs.get(job.id);
        if (!found) return;
        found.studying = false;
        if (data.error) return;
        Object.assign(found, { heard: data.result.heard, grid: data.result.grid, intensity: data.result.intensity, studied: job.visual ? 'visual' : 'heard' });
        if (active?.id === job.id) active.heardEnd = found.heard.end;
      };
      analyst.onerror = () => { for (const { id: each } of studies.values()) { const found = songs.get(each); if (found) found.studying = false; } studies.clear(); };
      const request = ++studyCount;
      studies.set(request, { id, visual });
      analyst.postMessage({ id: request, left, right, rate: entry.buffer.sampleRate, visual }, [left.buffer, right.buffer]);
    } catch (_) { entry.studying = false; /* the dancers keep their own time, and the songs cross at their ends */ }
  }

  const inFlight = new Map();   // id -> the render under way, so that a song asked for twice (ahead of time, then for real) is made once
  function song(id, ahead = false) {
    if (songs.has(id)) { const found = songs.get(id); songs.delete(id); songs.set(id, found); return Promise.resolve(found); }   // (the most recently used goes last)
    if (!inFlight.has(id)) inFlight.set(id, makeSong(id, ahead).finally(() => inFlight.delete(id)));
    return inFlight.get(id);
  }

  // The song rendered from the disc (in the main process), as the page keeps it: its sound, loop, beat grid and intensity.
  async function makeSong(id, ahead) {
    const rendered = await window.colo.jukeboxRender(id, ahead);   // (ahead: made for later, by a worker of its own, so that a song picked meanwhile is not kept waiting)
    const ctx = output();
    const buffer = ctx.createBuffer(2, rendered.left.length, rendered.rate);
    buffer.copyToChannel(rendered.left, 0);
    buffer.copyToChannel(rendered.right, 1);
    // the song is kept as it is, to be played now; what is worked out about it (where it is heard, and for the visualizer its beat, intensity, tone and key)
    // comes a little later, from a worker, and is put on it then
    songs.set(id, { buffer, loop: rendered.loop, grid: null, intensity: null, heard: null, studied: null });
    while (songs.size > KEEP) songs.delete(songs.keys().next().value);
    study(id, visualizerOn());
    return songs.get(id);
  }

  // Where the sound is in the song, in seconds: the time it began from, plus the time that has passed (the sound card's clock stops
  // while it is paused), wrapped inside the loop while it repeats.
  function position() {
    if (!active) return 0;
    let at = active.offset + (context.currentTime - active.startedAt);
    const region = active.region;
    if (region && active.source.loop && at >= region.end) at = region.start + (at - region.start) % (region.end - region.start);
    return Math.min(at, active.shown);
  }

  let dragging = false;
  // The bar and the times in it: what is playing, or nothing.
  function tick() {
    const bar = $('jukebox-seek');
    bar.disabled = !active;
    if (!active) { $('jukebox-time').textContent = clock(0); $('jukebox-length').textContent = clock(0); bar.value = 0; return; }
    $('jukebox-length').textContent = clock(active.shown);
    if (dragging) return;
    const at = position();
    bar.value = Math.round(at / active.shown * 1000);
    $('jukebox-time').textContent = clock(at);
  }
  setInterval(tick, 250);

  // offset: where in the song to begin; keepPaused: seeking while paused leaves it paused, at the new place; fade: seconds over which it comes in as the
  // song that was playing, if any, goes out (a song starting from nothing comes in over QUICK).
  async function start(id, { buffer, loop }, offset = 0, keepPaused = false, { fade: seconds = QUICK } = {}) {
    const ctx = output();
    if (!keepPaused) await ctx.resume();
    const source = ctx.createBufferSource(), fader = ctx.createGain();
    source.buffer = buffer;
    // in a playlist a song plays through once, and Loop starts the playlist again after its last
    if (loop) { source.loopStart = loop.start; source.loopEnd = loop.end; source.loop = $('jukebox-loop').checked && !queue; }
    fader.gain.value = 0;
    source.connect(fader);
    fader.connect(gain);
    fader.connect(analyser);
    source.onended = () => { if (active?.source === source) { active = null; state = { ...state, playing: null, paused: false }; render(); finished(); } };
    // the length shown is the list's (the song played once), not the buffer's: that has the seconds the sound takes to die away after it
    const known = tracks?.find(each => each.id === id)?.seconds;
    const shown = known > 0 ? Math.min(known, buffer.duration) : buffer.duration;
    const going = active;
    active = { id, source, fader, loop: Boolean(loop), region: loop, duration: buffer.duration, shown, offset, startedAt: ctx.currentTime, fadeSeconds: seconds, heardEnd: songs.get(id)?.heard?.end ?? buffer.duration };
    state = { ...state, playing: id, paused: keepPaused };
    source.start(0, offset);
    fade(fader.gain, true, seconds);
    retire(going, seconds);
    window.coloJukeboxChamber?.wake();
    tick();
    prefetchSoon();
  }

  // Begin again from `seconds` into the song. A repeating song asked for a place after its loop starts again at the loop's start.
  async function seek(seconds) {
    if (!active) return;
    const id = active.id, found = songs.get(id);
    if (!found) return;
    const paused = state.paused;
    let at = Math.max(0, Math.min(active.duration - 0.05, seconds));
    if (found.loop && $('jukebox-loop').checked && !queue && at >= found.loop.end) at = found.loop.start;
    // the old place gives way to the new over a few hundredths of a second (start() retires it, so that its end is not taken for a song that finished)
    await start(id, found, at, paused, { fade: 0.05 });
    render();
  }

  // fromQueue: the song is the playlist's next; a song picked from a list ends playing from the playlist
  async function play(id, fromQueue = false) {
    if (!fromQueue) queue = null;
    const mine = ++token;
    current = id;
    notice = '';
    busy = true;
    // what is playing goes on while the song is made (and is not cut off for the wait), then gives way to it
    render();
    try {
      const found = await song(id);
      if (mine !== token) return;
      await start(id, found, 0, false, { fade: active ? MANUAL : QUICK });
    } catch (error) {
      if (mine === token) notice = message(error);
    }
    if (mine === token) { busy = false; render(); }
  }

  async function pause() {
    if (!active) return;
    // the sound is ramped down before the device is stopped, and back up after it is started
    fade(active.fader.gain, false, 0.08);
    await new Promise(done => setTimeout(done, 100));
    await context.suspend();
    state = { ...state, paused: true };
    render();
  }

  async function resume() {
    if (!active) return;
    await context.resume();
    if (active) fade(active.fader.gain, true, 0.1);
    window.coloJukeboxChamber?.wake();
    state = { ...state, paused: false };
    render();
  }

  function stop() {
    token++;
    busy = false;
    crossing = false;
    silence(0.4);
    render();
  }

  function volume(value) {
    state = { ...state, volume: Math.max(0, Math.min(100, Number(value) || 0)) };
    if (gain) gain.gain.value = state.volume / 100;
    render();
  }

  function step(offset) {
    if (!tracks?.length) return;
    if (queue) {
      queue.at = (queue.at + offset + queue.order.length) % queue.order.length;
      return play(queue.order[queue.at], true);
    }
    const list = pool(), at = index();
    if (!list.length) return;
    return play(list[(at < 0 ? (offset > 0 ? 0 : list.length - 1) : (at + offset + list.length) % list.length)].id);
  }

  // What comes after the song playing, when it plays through on its own: { id, fromQueue, advance() (moves the playlist on), same } or null for nothing.
  // The same one again when looping, else the next of the playlist or list; a list's end stops, and a sound effect is played once (and again only
  // when Loop is on); it does not go on to the next.
  function upcoming() {
    if (queue) {
      if (queue.at < queue.order.length - 1) return { id: queue.order[queue.at + 1], fromQueue: true, advance: () => { queue.at++; } };
      if (!$('jukebox-loop').checked) return null;
      const playlist = playlists.find(each => each.id === queue.id);
      const again = playlist ? lists.order(playlist, has, queue.shuffled) : queue.order;
      if (!again.length) return null;
      return { id: again[0], fromQueue: true, advance: () => { queue = { ...queue, order: again, at: 0 }; } };
    }
    if ($('jukebox-loop').checked) return { id: current, fromQueue: false, advance() {}, same: true };
    const list = pool(), at = index();
    if (at >= 0 && at < list.length - 1 && kindOf(tracks.find(each => each.id === current)) === 'music') return { id: list[at + 1].id, fromQueue: false, advance() {} };
    return null;
  }

  // A song that played through on its own, with nothing already crossing into the next.
  function finished() {
    const next = upcoming();
    if (!next) return;
    next.advance();
    return play(next.id, next.fromQueue);
  }

  // The song to come is made while this one plays (a while after it begins, so that making it does not stutter the start), so that it is there to
  // cross into the moment this one is nearly over: no wait in silence between the two.
  let prefetchTimer = null;
  function prefetchSoon() {
    clearTimeout(prefetchTimer);
    const mine = token;
    prefetchTimer = setTimeout(() => {
      if (mine !== token || !active) return;
      const next = upcoming();
      if (next && !next.same && !songs.has(next.id)) song(next.id, true).catch(() => {});
    }, 3000);
  }

  // Near the end of a song that is to play through, the next one comes in over it: CROSS seconds before the old song's last audible moment, so that it is
  // still loud as the new one begins, and the new one starts where it first is heard.
  function watchEnd() {
    if (!active || state.paused || busy || crossing || active.source.loop || !context) return;
    const elapsed = active.offset + (context.currentTime - active.startedAt), left = Math.min(active.heardEnd, active.duration) - elapsed;
    if (left > CROSS) return;
    const next = upcoming();
    // (a song that begins again, or one not yet made, goes by the song's own end)
    if (!next || next.same || !songs.has(next.id)) return;
    crossing = true;
    next.advance();
    if (!next.fromQueue) queue = null;
    current = next.id;
    const mine = ++token, found = songs.get(next.id);
    start(next.id, found, found.heard?.lead ?? 0, false, { fade: Math.max(0.6, Math.min(CROSS, left + 0.4)) })
      .catch(error => { if (mine === token) notice = message(error); })
      .finally(() => { crossing = false; render(); });
  }
  setInterval(watchEnd, 100);

  function load() {
    loading ||= Promise.all([window.colo.jukeboxTracks(), window.colo.jukeboxPlaylists().catch(() => [])])
      .then(([list, saved]) => { tracks = list; playlists = saved; render(); })
      .catch(error => { loading = null; notice = message(error); render(); });
    return loading;
  }

  $('jukebox-toggle').addEventListener('click', () => {
    if (state.playing) return state.paused ? resume() : pause();
    if (current || pool().length) return play(current || pool()[0].id);
  });
  $('jukebox-stop').addEventListener('click', stop);
  $('jukebox-sort').addEventListener('change', event => setSort(event.target.value));
  for (const button of $('jukebox-views').children) button.addEventListener('click', () => { views[tab] = button.dataset.view; store(`jukebox-view-${tab}`, views[tab]); render(); });
  $('jukebox-search').addEventListener('input', event => { query = event.target.value.trim(); render(); });
  for (const kind of TABS) $(`jukebox-tab-${kind}`).addEventListener('click', () => { tab = kind; filter = 'all'; render(); });
  $('jukebox-previous').addEventListener('click', () => step(-1));
  $('jukebox-next').addEventListener('click', () => step(1));
  $('jukebox-volume').addEventListener('input', event => volume(event.target.value));
  // A song with a loop point of its own repeats it only while Loop is on: turned off, it goes on to its end.
  // (Its place is worked out first, since where the sound is depends on whether it was wrapping.)
  $('jukebox-loop').addEventListener('change', event => {
    if (!active?.loop || queue) return;
    active.offset = position();
    active.startedAt = context.currentTime;
    active.source.loop = event.target.checked;
  });
  $('jukebox-seek').addEventListener('input', event => {
    dragging = true;
    if (active) $('jukebox-time').textContent = clock(event.target.value / 1000 * active.shown);
  });
  $('jukebox-seek').addEventListener('change', event => {
    dragging = false;
    if (active) seek(event.target.value / 1000 * active.shown);
  });

  // --- Playlists ------------------------------------------------------------------------------------------------------------

  const has = id => Boolean(tracks?.some(each => each.id === id));
  const trackOf = id => tracks?.find(each => each.id === id);
  // A change to the playlists: shown at once, then saved; what the launcher kept is what stays.
  function savePlaylists(next) {
    playlists = next;
    render();
    window.colo.jukeboxSavePlaylists(next).then(kept => { playlists = kept; render(); })
      .catch(error => { notice = `The playlists could not be saved: ${message(error)}`; render(); });
  }
  // A song's star: filled while the song is in Favorites; pressing it adds the song or takes it out.
  const STAR = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.6l2.3 4.9 5.3.6-3.9 3.6 1.1 5.3L10 14.3 5.2 17l1.1-5.3-3.9-3.6 5.3-.6z"/></svg>';
  function star(track) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jukebox-star';
    button.dataset.id = track.id;
    button.innerHTML = STAR;
    button.setAttribute('aria-label', `Favorite: ${track.name}`);
    button.title = 'Favorite';
    button.setAttribute('aria-pressed', String(lists.isFavorite(playlists, track.id)));
    button.addEventListener('click', () => toggleStar(track.id));
    return button;
  }
  function toggleStar(id) { if (id) savePlaylists(lists.toggleFavorite(playlists, id)); }

  // Play a playlist from one of its songs (its place in the order played), or shuffled.
  function playPlaylist(id, shuffled = false, from = null) {
    const playlist = playlists.find(each => each.id === id);
    const order = playlist ? lists.order(playlist, has, shuffled) : [];
    if (!order.length) return;
    const at = from === null ? 0 : Math.max(0, order.indexOf(from));
    queue = { id, name: playlist.name, order, at, shuffled };
    return play(order[at], true);
  }

  // The Favorites tab: the starred songs, in the order the player gave them, to play through, reorder or take out.
  function renderFavorites() {
    const favorites = playlists.find(each => each.id === lists.FAVORITES) ?? { id: lists.FAVORITES, songs: [] };
    const playable = favorites.songs.filter(has);
    $('jukebox-pl-count').textContent = playable.length === favorites.songs.length ? `${favorites.songs.length}` : `${playable.length} of ${favorites.songs.length} on this disc`;
    $('jukebox-pl-play').disabled = $('jukebox-pl-shuffle').disabled = !playable.length;
    $('jukebox-pl-empty').hidden = favorites.songs.length > 0;
    const songs = $('jukebox-pl-songs');
    songs.replaceChildren(...favorites.songs.map((id, index) => {
      const track = trackOf(id), row = document.createElement('li');
      row.className = 'jukebox-pl-song';
      row.draggable = true;
      row.dataset.index = String(index);
      if (!track) row.classList.add('missing');
      if (id === current) row.classList.add('selected');
      if (id === state.playing && !state.paused) row.classList.add('playing');
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'jukebox-pl-name';
      if (track) {
        const chip = document.createElement('span');
        chip.className = 'jukebox-chip';
        chip.setAttribute('aria-hidden', 'true');
        chip.innerHTML = window.coloJukeboxCover.disc(track);
        name.append(chip);
      }
      const text = document.createElement('span');
      text.className = 'jukebox-track-name';
      text.textContent = track ? track.name : 'A song this disc does not have';
      name.append(text);
      name.disabled = !track;
      name.addEventListener('click', () => playPlaylist(lists.FAVORITES, false, id));
      const type = document.createElement('span');
      type.className = 'jukebox-track-type';
      type.textContent = track ? typeOf(track) : '';
      const length = document.createElement('span');
      length.className = 'jukebox-track-length';
      length.textContent = typeof track?.seconds === 'number' ? lengthText(track.seconds) : '';
      const tools = document.createElement('span');
      tools.className = 'jukebox-pl-tools';
      for (const [label, glyph, act, off] of [
        ['Move up', '\u2191', () => savePlaylists(lists.move(playlists, lists.FAVORITES, index, index - 1)), index === 0],
        ['Move down', '\u2193', () => savePlaylists(lists.move(playlists, lists.FAVORITES, index, index + 1)), index === favorites.songs.length - 1],
        ['Remove from Favorites', '\u00d7', () => savePlaylists(lists.drop(playlists, lists.FAVORITES, id)), false]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'subtle';
        button.textContent = glyph;
        button.title = label;
        button.setAttribute('aria-label', `${label}: ${track?.name ?? 'missing song'}`);
        button.disabled = off;
        button.addEventListener('click', act);
        tools.append(button);
      }
      row.append(name, type, length, tools);
      // dragging a row to another place
      row.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', String(index)); event.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
      row.addEventListener('drop', event => {
        event.preventDefault();
        const from = Number(event.dataTransfer.getData('text/plain'));
        if (Number.isInteger(from)) savePlaylists(lists.move(playlists, lists.FAVORITES, from, index));
      });
      return row;
    }));
  }
  $('jukebox-pl-play').addEventListener('click', () => playPlaylist(lists.FAVORITES));
  $('jukebox-pl-shuffle').addEventListener('click', () => playPlaylist(lists.FAVORITES, true));
  // the player's star, for the song it has
  $('jukebox-star').addEventListener('click', event => toggleStar(event.currentTarget.dataset.id));

  // Ends the music and puts the player away: lets go of the sound device and of the disc.
  function close() {
    queue = null;
    token++;
    busy = false;
    crossing = false;
    clearTimeout(prefetchTimer);
    silence(0.2);
    songs.clear();
    analyst?.terminate();
    analyst = null;
    studies.clear();
    // the sound device is let go of once the fade is over
    const old = context;
    if (old) setTimeout(() => old.close().catch(() => {}), 350);
    context = gain = analyser = null;   // (the chamber is told there is nothing to hear: it was reading the old one's latency)
    current = null;
    notice = '';
    window.colo.jukeboxClose().catch(() => {});
    render();
  }

  $('jukebox-close').addEventListener('click', close);
  window.colo.onJukeboxStop(close);

  // The Jukebox can be taken out into a window of its own. That window is this page again (jukebox-window.js), with only the Jukebox showing; the music
  // plays from there while it is open, so the launcher's own page hands its song over and says where it went. A song goes across with its place, whether
  // paused, the volume and the playlist it was playing from, and comes back the same way when the window is closed.
  const alone = document.documentElement.classList.contains('jukebox-window');
  let popped = false, discard = false;
  function snapshot() {
    if (!active) return null;
    return { id: active.id, position: position(), paused: state.paused, volume: state.volume, loop: $('jukebox-loop').checked, queue: queue ? { ...queue } : null };
  }
  // Carries on with a song handed over by the other window, from where it was.
  async function restore(handoff) {
    if (!handoff?.id) return;
    state = { ...state, volume: Number.isFinite(handoff.volume) ? handoff.volume : state.volume };
    $('jukebox-loop').checked = Boolean(handoff.loop);
    queue = handoff.queue || null;
    load();
    const mine = ++token;
    current = handoff.id;
    notice = '';
    busy = true;
    render();
    try {
      const found = await song(handoff.id);
      if (mine !== token) return;
      const ctx = output();
      gain.gain.value = state.volume / 100;
      if (handoff.paused) await ctx.suspend();   // (so that it begins silent, and Play starts it)
      await start(handoff.id, found, Math.max(0, Math.min(found.buffer.duration - 0.05, Number(handoff.position) || 0)), Boolean(handoff.paused), { fade: 0.4 });
    } catch (error) {
      if (mine === token) notice = message(error);
    }
    if (mine === token) { busy = false; render(); }
  }
  const setPopped = (open, handoff = null) => {
    if (alone || open === popped) return;
    popped = open;
    document.documentElement.classList.toggle('jukebox-popped', open);
    $('jukebox-popped').hidden = !open;
    if (open) { close(); window.coloJukeboxChamber?.hide(); return; }
    const skip = discard;
    discard = false;
    if (!$('page-jukebox').hidden) { load(); window.coloJukeboxChamber?.show(); }
    if (!skip) restore(handoff);
  };
  $('jukebox-popout').addEventListener('click', () => { window.colo.jukeboxWindowOpen(snapshot()).catch(() => {}); });
  $('jukebox-bring-back').addEventListener('click', () => { window.colo.jukeboxWindowClose().catch(() => {}); });
  if (!alone) {
    window.colo.onJukeboxWindow(setPopped);
    window.colo.jukeboxWindowState().then(setPopped).catch(() => {});
  } else {
    // the window opens on the Jukebox, and the launcher's other pages stay out of it
    const open = () => (typeof showPage === 'function' ? showPage('jukebox') : $('nav-jukebox').click());
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', open); else open();
    setTimeout(open, 300);
    // the song that was playing in the launcher carries on here, and where it is goes back to the main process for when this window is closed
    window.colo.jukeboxWindowTake().then(restore).catch(() => {});
    setInterval(() => window.colo.jukeboxWindowReport(snapshot()).catch(() => {}), 500);
  }

  window.coloJukebox = {
    show() { if (popped) return; load(); render(); window.coloJukeboxChamber?.show(); },
    // The visualizer was turned on with a song already playing, which was studied only for where it is heard: now it is studied for its beat too.
    study() { if (active) study(active.id, true); },
    // What the Purification Chamber dances to: the player's analyser, and whether a song is sounding.
    listen() {
      return analyser ? { analyser, playing: () => Boolean(active) && !state.paused, position: () => (active ? position() : 0),
        id: () => active?.id ?? null, fade: () => active?.fadeSeconds ?? 0, grid: () => (active ? songs.get(active.id)?.grid ?? null : null), intensity: () => (active ? songs.get(active.id)?.intensity ?? null : null), latency: () => context?.outputLatency || context?.baseLatency || 0 } : null;
    },
    // Another game was chosen: its disc has other songs, so the music ends and the list is read again from it.
    reset() {
      if (!alone) { discard = popped; window.colo.jukeboxWindowClose().catch(() => {}); }   // another game's disc: the window out of the launcher has the old one's songs, which don't come back
      close();
      window.coloJukeboxChamber?.reset();
      tracks = null;
      loading = null;
      tab = 'music';
      playlists = [];
      queue = null;
      query = '';
      filter = 'all';
      $('jukebox-search').value = '';
      $('jukebox-list').dataset.rendered = '';
      $('jukebox-list').replaceChildren();
      $('jukebox-count').textContent = '';
      $('jukebox-nomatch').hidden = true;
      render();
      // the page is open while the game is changed: its list is read again from the other disc
      if (!$('page-jukebox').hidden) load();
    },
    // Leaving the page doesn't end the music: the player stays under whatever page is open.
    hide() { window.coloJukeboxChamber?.hide(); },
  };
})();
