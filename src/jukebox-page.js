// The Jukebox: the game's songs, listed to pick from. The game plays them itself (src/jukebox.js, in the main process),
// started when a song is first played and closed when the page is left; this page shows the list and asks.
(() => {
  const $ = id => document.getElementById(id);
  const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  let tracks = null, loading = null, current = null, state = { running: false, ready: false, playing: null, paused: false, volume: 100, error: null };
  // Set when the player ended a song (Stop, or another song) so that it doesn't count as one that finished.
  let ending = false, busy = false, notice = '';
  const index = () => tracks.findIndex(each => each.id === current);

  function render() {
    const list = $('jukebox-list');
    if (tracks && list.dataset.rendered !== String(tracks.length)) {
      list.replaceChildren(...tracks.map(track => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jukebox-track';
        button.dataset.id = track.id;
        button.textContent = track.name;
        button.addEventListener('click', () => play(track.id));
        return button;
      }));
      list.dataset.rendered = String(tracks.length);
    }
    for (const button of list.children) {
      button.classList.toggle('selected', button.dataset.id === current);
      button.classList.toggle('playing', button.dataset.id === state.playing && !state.paused);
      if (button.dataset.id === current) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
    }
    $('jukebox-empty').hidden = tracks === null || tracks.length > 0;
    const track = tracks?.find(each => each.id === current);
    $('jukebox-now').textContent = track ? track.name : 'Nothing playing';
    $('jukebox-status').textContent = notice || state.error || (busy ? 'Starting the game’s music…'
      : state.playing ? (state.paused ? 'Paused' : 'Playing') : state.running ? 'Ready' : '');
    const playing = Boolean(state.playing) && !state.paused;
    $('jukebox-toggle').textContent = playing ? 'Pause' : state.paused ? 'Resume' : 'Play';
    $('jukebox-toggle').setAttribute('aria-label', $('jukebox-toggle').textContent);
    const none = !tracks?.length;
    $('jukebox-toggle').disabled = none || busy;
    $('jukebox-previous').disabled = $('jukebox-next').disabled = none || busy;
    $('jukebox-stop').disabled = !state.playing;
    $('jukebox-volume').value = state.volume;
  }

  async function control(action, value) {
    try { state = await window.colo.jukeboxControl(action, value); notice = ''; }
    catch (error) { notice = message(error); }
    render();
  }

  async function play(id) {
    current = id;
    notice = '';
    busy = true;
    ending = Boolean(state.playing);  // a song cut off by this one is not one that ended
    render();
    try { state = await window.colo.jukeboxPlay(id); }
    catch (error) { ending = false; notice = message(error); }
    busy = false;
    render();
  }

  function step(offset) {
    if (!tracks?.length) return;
    const at = index();
    const next = tracks[(at < 0 ? (offset > 0 ? 0 : tracks.length - 1) : (at + offset + tracks.length) % tracks.length)];
    return play(next.id);
  }

  // A song that finished on its own: the same one again when looping, else the next, and the list's end stops.
  function finished() {
    if ($('jukebox-loop').checked) return play(current);
    const at = index();
    if (at >= 0 && at < tracks.length - 1) return play(tracks[at + 1].id);
  }

  function onState(next) {
    const previous = state;
    state = next;
    const ended = previous.playing && !next.playing && next.running && !ending;
    if (!next.playing) ending = false;
    render();
    if (ended) finished();
  }

  function load() {
    loading ||= window.colo.jukeboxTracks().then(list => { tracks = list; render(); })
      .catch(error => { loading = null; notice = message(error); render(); });
    return loading;
  }

  $('jukebox-toggle').addEventListener('click', () => {
    if (state.playing) return control(state.paused ? 'resume' : 'pause');
    if (current || tracks?.length) return play(current || tracks[0].id);
  });
  $('jukebox-stop').addEventListener('click', () => { ending = true; control('stop'); });
  $('jukebox-previous').addEventListener('click', () => step(-1));
  $('jukebox-next').addEventListener('click', () => step(1));
  $('jukebox-volume').addEventListener('change', event => control('volume', event.target.value));
  window.colo.onJukebox(onState);

  window.coloJukebox = {
    show() { load(); render(); },
    // Leaving the page ends the game's music: the game is not left running behind the other tabs.
    hide() { ending = true; control('close'); },
  };
})();
