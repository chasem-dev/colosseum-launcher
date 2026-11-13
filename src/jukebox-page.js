// The Jukebox: the game's songs, listed to pick from. A song is rendered from the player's disc in the main process (src/jukebox-render.js,
// in a worker, about a second or two) and played here with Web Audio; no game runs. A song with a loop point of its own repeats that
// part while Loop is on, and otherwise plays through to its end and goes on to the next song.
// The player (the bar under every page) shows once a song is picked and goes with you to the other pages, so the music can play
// while you build a team; its X ends the music and puts it away, and so does starting the game.
(() => {
  const $ = id => document.getElementById(id);
  const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const KEEP = 3;   // rendered songs kept, for playing one again
  // A time as a clock shows it: 1:41.
  const clock = seconds => {
    const whole = seconds >= 0 ? Math.round(seconds) : 0;
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  };
  // A song's length in the list: the clock's, except that a jingle over in a moment shows tenths of a second ("0.4 s").
  const lengthText = seconds => (seconds > 0 && seconds < 9.95 ? `${seconds.toFixed(1)} s` : clock(seconds));

  let tracks = null, loading = null, current = null, busy = false, notice = '', tab = 'music', query = '', filter = 'all';
  let state = { playing: null, paused: false, volume: 100 };
  // The player's playlists (jukebox-playlists.js), the one open in the Playlists tab, and the one playing: { id, name, order (song
  // ids), at, shuffled } while songs play from a playlist, when previous, next and a song's end go through it alone.
  const lists = window.coloJukeboxPlaylists;
  let playlists = [], chosen = null, queue = null;
  let context = null, gain = null, active = null, token = 0;
  const songs = new Map();   // id -> { buffer, loop }, oldest first
  // Music or a sound effect: each has its tab, and the previous and next buttons stay among those of the same kind.
  const kindOf = track => (track?.kind === 'sfx' ? 'sfx' : 'music');
  const TABS = ['music', 'sfx', 'playlists'];
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
    const onPlaylists = tab === 'playlists';
    $('jukebox-tools').hidden = $('jukebox-list').hidden = onPlaylists;
    $('jukebox-playlists').hidden = !onPlaylists;
    if (onPlaylists) { $('jukebox-nomatch').hidden = true; renderPlaylists(); }
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
    if (tracks && !onPlaylists && list.dataset.rendered !== shown) {
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
    $('jukebox-add').disabled = !current;
    const dockStar = $('jukebox-star');
    dockStar.disabled = !current;
    dockStar.dataset.id = current ?? '';
    dockStar.setAttribute('aria-pressed', String(Boolean(current) && lists.isFavorite(playlists, current)));
    const playing = Boolean(state.playing) && !state.paused;
    $('jukebox-toggle').textContent = playing ? 'Pause' : state.paused ? 'Resume' : 'Play';
    $('jukebox-toggle').setAttribute('aria-label', $('jukebox-toggle').textContent);
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
    }
    return context;
  }

  // Ends what is playing, quietly: its end does not count as a song that finished.
  function silence() {
    const source = active?.source;
    active = null;
    if (source) { source.onended = null; try { source.stop(); } catch (_) { /* never started */ } source.disconnect(); }
    state = { ...state, playing: null, paused: false };
  }

  async function song(id) {
    if (songs.has(id)) return songs.get(id);
    const rendered = await window.colo.jukeboxRender(id);
    const ctx = output();
    const buffer = ctx.createBuffer(2, rendered.left.length, rendered.rate);
    buffer.copyToChannel(rendered.left, 0);
    buffer.copyToChannel(rendered.right, 1);
    songs.set(id, { buffer, loop: rendered.loop });
    while (songs.size > KEEP) songs.delete(songs.keys().next().value);
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

  // offset: where in the song to begin; keepPaused: seeking while paused leaves it paused, at the new place.
  async function start(id, { buffer, loop }, offset = 0, keepPaused = false) {
    const ctx = output();
    if (!keepPaused) await ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // in a playlist a song plays through once, and Loop starts the playlist again after its last
    if (loop) { source.loopStart = loop.start; source.loopEnd = loop.end; source.loop = $('jukebox-loop').checked && !queue; }
    source.connect(gain);
    source.onended = () => { if (active?.source === source) { active = null; state = { ...state, playing: null, paused: false }; render(); finished(); } };
    // the length shown is the list's (the song played once), not the buffer's: that has the seconds the sound takes to die away after it
    const known = tracks?.find(each => each.id === id)?.seconds;
    const shown = known > 0 ? Math.min(known, buffer.duration) : buffer.duration;
    active = { id, source, loop: Boolean(loop), region: loop, duration: buffer.duration, shown, offset, startedAt: ctx.currentTime };
    state = { ...state, playing: id, paused: keepPaused };
    source.start(0, offset);
    tick();
  }

  // Begin again from `seconds` into the song. A repeating song asked for a place after its loop starts again at the loop's start.
  async function seek(seconds) {
    if (!active) return;
    const id = active.id, found = songs.get(id);
    if (!found) return;
    const paused = state.paused, old = active.source;
    let at = Math.max(0, Math.min(active.duration - 0.05, seconds));
    if (found.loop && $('jukebox-loop').checked && !queue && at >= found.loop.end) at = found.loop.start;
    old.onended = null;
    try { old.stop(); } catch (_) { /* already over */ }
    old.disconnect();
    active = null;   // so that the old sound's end is not taken for a song that finished
    await start(id, found, at, paused);
    render();
  }

  // fromQueue: the song is the playlist's next; a song picked from a list ends playing from the playlist
  async function play(id, fromQueue = false) {
    if (!fromQueue) queue = null;
    const mine = ++token;
    current = id;
    notice = '';
    busy = true;
    silence();
    render();
    try {
      const found = await song(id);
      if (mine !== token) return;
      await start(id, found);
    } catch (error) {
      if (mine === token) notice = message(error);
    }
    if (mine === token) { busy = false; render(); }
  }

  async function pause() {
    if (!active) return;
    await context.suspend();
    state = { ...state, paused: true };
    render();
  }

  async function resume() {
    if (!active) return;
    await context.resume();
    state = { ...state, paused: false };
    render();
  }

  function stop() {
    token++;
    busy = false;
    silence();
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

  // A song that played through on its own: the same one again when looping, else the next, and the list's end stops.
  function finished() {
    if (queue) {
      if (queue.at < queue.order.length - 1) { queue.at++; return play(queue.order[queue.at], true); }
      if (!$('jukebox-loop').checked) return;
      const playlist = playlists.find(each => each.id === queue.id);
      const again = playlist ? lists.order(playlist, has, queue.shuffled) : queue.order;
      if (!again.length) return;
      queue = { ...queue, order: again, at: 0 };
      return play(again[0], true);
    }
    if ($('jukebox-loop').checked) return play(current);
    // a sound effect is played once, and again only when Loop is on; it does not go on to the next
    const list = pool(), at = index();
    if (at >= 0 && at < list.length - 1 && kindOf(tracks.find(each => each.id === current)) === 'music') return play(list[at + 1].id);
  }

  function load() {
    loading ||= Promise.all([window.colo.jukeboxTracks(), window.colo.jukeboxPlaylists().catch(() => [])])
      .then(([list, saved]) => { tracks = list; playlists = saved; if (!playlists.some(each => each.id === chosen)) chosen = playlists[0]?.id ?? null; render(); })
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
  for (const kind of TABS) $(`jukebox-tab-${kind}`).addEventListener('click', () => { tab = kind; filter = 'all'; closeMenu(); render(); });
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
    if (!playlists.some(each => each.id === chosen)) chosen = playlists[0]?.id ?? null;
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

  function newPlaylist(name, song = null) {
    const made = lists.create(playlists, name);
    if (!made.id) return null;
    savePlaylists(song ? lists.add(made.list, made.id, song) : made.list);
    return made.id;
  }
  // Play a playlist from one of its songs (its place in the order played), or shuffled.
  function playPlaylist(id, shuffled = false, from = null) {
    const playlist = playlists.find(each => each.id === id);
    const order = playlist ? lists.order(playlist, has, shuffled) : [];
    if (!order.length) return;
    const at = from === null ? 0 : Math.max(0, order.indexOf(from));
    queue = { id, name: playlist.name, order, at, shuffled };
    return play(order[at], true);
  }

  let confirmDelete = 0;   // when Delete was first pressed: a second press within a few seconds deletes
  function renderPlaylists() {
    const side = $('jukebox-pl-list');
    side.replaceChildren(...playlists.map(each => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'jukebox-pl-item';
      if (each.id === chosen) button.setAttribute('aria-current', 'true');
      const name = document.createElement('span');
      name.textContent = each.name;
      if (each.id === lists.FAVORITES) button.classList.add('favorites');
      const count = document.createElement('span');
      count.className = 'jukebox-track-length';
      count.textContent = String(each.songs.length);
      button.append(name, count);
      if (queue?.id === each.id) button.classList.add('playing');
      button.addEventListener('click', () => { chosen = each.id; confirmDelete = 0; render(); });
      return button;
    }));
    const playlist = playlists.find(each => each.id === chosen);
    $('jukebox-pl-none').hidden = playlists.length > 0;
    $('jukebox-pl-main').hidden = !playlist;
    if (!playlist) return;
    const title = $('jukebox-pl-title'), favorites = playlist.id === lists.FAVORITES;
    if (document.activeElement !== title) title.value = playlist.name;
    title.readOnly = favorites;   // Favorites keeps its name, and stays
    $('jukebox-pl-delete').hidden = favorites;
    const playable = playlist.songs.filter(has);
    $('jukebox-pl-count').textContent = playable.length === playlist.songs.length ? `${playlist.songs.length}` : `${playable.length} of ${playlist.songs.length} on this disc`;
    $('jukebox-pl-play').disabled = $('jukebox-pl-shuffle').disabled = !playable.length;
    $('jukebox-pl-delete').textContent = confirmDelete && Date.now() - confirmDelete < 4000 ? 'Delete it?' : 'Delete';
    $('jukebox-pl-empty').hidden = playlist.songs.length > 0;
    $('jukebox-pl-empty').textContent = favorites
      ? 'No favorites yet. Press the star beside a song, in Music or Sound effects or in the player, to add it here.'
      : 'This playlist is empty. Right-click a song in Music or Sound effects, or use the player\'s Add to playlist button, to add it here.';
    const songs = $('jukebox-pl-songs');
    songs.replaceChildren(...playlist.songs.map((id, index) => {
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
      name.addEventListener('click', () => playPlaylist(playlist.id, false, id));
      const type = document.createElement('span');
      type.className = 'jukebox-track-type';
      type.textContent = track ? typeOf(track) : '';
      const length = document.createElement('span');
      length.className = 'jukebox-track-length';
      length.textContent = typeof track?.seconds === 'number' ? lengthText(track.seconds) : '';
      const tools = document.createElement('span');
      tools.className = 'jukebox-pl-tools';
      for (const [label, glyph, act, off] of [
        ['Move up', '\u2191', () => savePlaylists(lists.move(playlists, playlist.id, index, index - 1)), index === 0],
        ['Move down', '\u2193', () => savePlaylists(lists.move(playlists, playlist.id, index, index + 1)), index === playlist.songs.length - 1],
        ['Remove from the playlist', '\u00d7', () => savePlaylists(lists.drop(playlists, playlist.id, id)), false]]) {
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
        if (Number.isInteger(from)) savePlaylists(lists.move(playlists, playlist.id, from, index));
      });
      return row;
    }));
  }

  $('jukebox-pl-new').addEventListener('submit', event => {
    event.preventDefault();
    const field = $('jukebox-pl-name'), id = newPlaylist(field.value);
    if (id) { chosen = id; field.value = ''; render(); }
  });
  $('jukebox-pl-title').addEventListener('change', event => savePlaylists(lists.rename(playlists, chosen, event.target.value)));
  $('jukebox-pl-title').addEventListener('keydown', event => { if (event.key === 'Enter') event.target.blur(); });
  $('jukebox-pl-play').addEventListener('click', () => playPlaylist(chosen));
  $('jukebox-pl-shuffle').addEventListener('click', () => playPlaylist(chosen, true));
  $('jukebox-pl-delete').addEventListener('click', () => {
    if (confirmDelete && Date.now() - confirmDelete < 4000) { confirmDelete = 0; savePlaylists(lists.remove(playlists, chosen)); return; }
    confirmDelete = Date.now();
    render();
    setTimeout(render, 4100);
  });

  // The Add to playlist menu: a song's playlists to tick, and a new one to make with it. Opened by right-clicking a song, or by
  // the player's button for the song it has.
  const menu = $('jukebox-menu');
  let menuFor = null, menuOpener = null;
  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    menuFor = null;
    menuOpener?.focus?.();
    menuOpener = null;
  }
  function fillMenu() {
    const items = [];
    const heading = document.createElement('div');
    heading.className = 'jukebox-menu-title';
    heading.textContent = trackOf(menuFor)?.name ?? '';
    items.push(heading);
    for (const each of playlists) {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitemcheckbox');
      const inIt = each.songs.includes(menuFor);
      item.setAttribute('aria-checked', String(inIt));
      item.textContent = each.name;
      item.addEventListener('click', () => { savePlaylists(inIt ? lists.drop(playlists, each.id, menuFor) : lists.add(playlists, each.id, menuFor)); fillMenu(); });
      items.push(item);
    }
    const form = document.createElement('form');
    form.className = 'jukebox-menu-new';
    const field = document.createElement('input');
    field.type = 'text';
    field.maxLength = lists.LONGEST_NAME;
    field.placeholder = 'New playlist';
    field.setAttribute('aria-label', 'New playlist with this song');
    const add = document.createElement('button');
    add.type = 'submit';
    add.className = 'subtle';
    add.textContent = 'Create';
    form.append(field, add);
    form.addEventListener('submit', event => { event.preventDefault(); if (newPlaylist(field.value, menuFor)) { fillMenu(); } });
    items.push(form);
    menu.replaceChildren(...items);
  }
  // x, y: where it opens (it is moved to stay in the window); above: it opens upward from y, as from the player
  function openMenu(id, x, y, opener, above = false) {
    if (!trackOf(id)) return;
    menuFor = id;
    menuOpener = opener;
    fillMenu();
    menu.hidden = false;
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(above ? y - box.height - 6 : y, innerHeight - box.height - 8))}px`;
    (menu.querySelector('[role=menuitemcheckbox]') ?? menu.querySelector('input'))?.focus();
  }
  $('jukebox-list').addEventListener('contextmenu', event => {
    const button = event.target.closest('.jukebox-track');
    if (!button) return;
    event.preventDefault();
    const box = button.getBoundingClientRect();
    // from the keyboard (the context menu key) there is no pointer: the menu opens at the song
    const x = event.clientX || box.left + 12, y = event.clientY || box.bottom;
    openMenu(button.dataset.id, x, y, button);
  });
  $('jukebox-star').addEventListener('click', event => toggleStar(event.currentTarget.dataset.id));
  $('jukebox-add').addEventListener('click', event => {
    if (!menu.hidden) return closeMenu();
    const box = event.currentTarget.getBoundingClientRect();
    openMenu(current, box.left, box.top, event.currentTarget, true);
  });
  document.addEventListener('mousedown', event => { if (!menu.hidden && !menu.contains(event.target) && event.target.closest('#jukebox-add') === null) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); closeMenu(); } });

  // Ends the music and puts the player away: lets go of the sound device and of the disc.
  function close() {
    queue = null;
    closeMenu();
    token++;
    busy = false;
    silence();
    songs.clear();
    context?.close().catch(() => {});
    context = gain = null;
    current = null;
    notice = '';
    window.colo.jukeboxClose().catch(() => {});
    render();
  }

  $('jukebox-close').addEventListener('click', close);
  window.colo.onJukeboxStop(close);

  window.coloJukebox = {
    show() { load(); render(); },
    // Another game was chosen: its disc has other songs, so the music ends and the list is read again from it.
    reset() {
      close();
      tracks = null;
      loading = null;
      tab = 'music';
      playlists = [];
      chosen = queue = null;
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
    hide() {},
  };
})();
