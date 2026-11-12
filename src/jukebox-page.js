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

  let tracks = null, loading = null, current = null, busy = false, notice = '';
  let state = { playing: null, paused: false, volume: 100 };
  let context = null, gain = null, active = null, token = 0;
  const songs = new Map();   // id -> { buffer, loop }, oldest first
  const index = () => tracks.findIndex(each => each.id === current);

  function render() {
    const list = $('jukebox-list');
    if (tracks && list.dataset.rendered !== String(tracks.length)) {
      const items = [];
      for (const track of tracks) {
        // the short tracks and jingles follow the tunes, under a heading of their own
        if (track.short && !items.some(item => item.tagName === 'H2')) {
          const heading = document.createElement('h2');
          heading.className = 'jukebox-group';
          heading.textContent = 'Short tracks and jingles';
          items.push(heading);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jukebox-track';
        button.dataset.id = track.id;
        const name = document.createElement('span');
        name.className = 'jukebox-track-name';
        name.textContent = track.name;
        button.append(name);
        if (typeof track.seconds === 'number') {
          const length = document.createElement('span');
          length.className = 'jukebox-track-length';
          length.textContent = lengthText(track.seconds);
          button.append(length);
        }
        button.title = track.name;   // the whole name, for a long one in a narrow window
        button.addEventListener('click', () => play(track.id));
        items.push(button);
      }
      list.replaceChildren(...items);
      list.dataset.rendered = String(tracks.length);
    }
    for (const button of list.children) {
      button.classList.toggle('selected', button.dataset.id === current);
      button.classList.toggle('playing', button.dataset.id === state.playing && !state.paused);
      if (button.dataset.id === current) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
    }
    $('jukebox-dock').hidden = !current;
    $('jukebox-empty').hidden = tracks === null || tracks.length > 0;
    const track = tracks?.find(each => each.id === current);
    $('jukebox-now').textContent = track ? track.name : 'Nothing playing';
    $('jukebox-status').textContent = notice || (busy ? 'Preparing the song…' : state.playing ? (state.paused ? 'Paused' : 'Playing') : current ? 'Ready' : '');
    const playing = Boolean(state.playing) && !state.paused;
    $('jukebox-toggle').textContent = playing ? 'Pause' : state.paused ? 'Resume' : 'Play';
    $('jukebox-toggle').setAttribute('aria-label', $('jukebox-toggle').textContent);
    const none = !tracks?.length;
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
    if (loop) { source.loopStart = loop.start; source.loopEnd = loop.end; source.loop = $('jukebox-loop').checked; }
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
    if (found.loop && $('jukebox-loop').checked && at >= found.loop.end) at = found.loop.start;
    old.onended = null;
    try { old.stop(); } catch (_) { /* already over */ }
    old.disconnect();
    active = null;   // so that the old sound's end is not taken for a song that finished
    await start(id, found, at, paused);
    render();
  }

  async function play(id) {
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
    const at = index();
    const next = tracks[(at < 0 ? (offset > 0 ? 0 : tracks.length - 1) : (at + offset + tracks.length) % tracks.length)];
    return play(next.id);
  }

  // A song that played through on its own: the same one again when looping, else the next, and the list's end stops.
  function finished() {
    if ($('jukebox-loop').checked) return play(current);
    const at = index();
    if (at >= 0 && at < tracks.length - 1) return play(tracks[at + 1].id);
  }

  function load() {
    loading ||= window.colo.jukeboxTracks().then(list => { tracks = list; render(); })
      .catch(error => { loading = null; notice = message(error); render(); });
    return loading;
  }

  $('jukebox-toggle').addEventListener('click', () => {
    if (state.playing) return state.paused ? resume() : pause();
    if (current || tracks?.length) return play(current || tracks[0].id);
  });
  $('jukebox-stop').addEventListener('click', stop);
  $('jukebox-previous').addEventListener('click', () => step(-1));
  $('jukebox-next').addEventListener('click', () => step(1));
  $('jukebox-volume').addEventListener('input', event => volume(event.target.value));
  // A song with a loop point of its own repeats it only while Loop is on: turned off, it goes on to its end.
  // (Its place is worked out first, since where the sound is depends on whether it was wrapping.)
  $('jukebox-loop').addEventListener('change', event => {
    if (!active?.loop) return;
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

  // Ends the music and puts the player away: lets go of the sound device and of the disc.
  function close() {
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
      $('jukebox-list').dataset.rendered = '';
      $('jukebox-list').replaceChildren();
      render();
    },
    // Leaving the page doesn't end the music: the player stays under whatever page is open.
    hide() {},
  };
})();
