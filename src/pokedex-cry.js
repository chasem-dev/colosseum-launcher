// The Pokédex's Cry button: plays the chosen Pokémon's cry, as the game plays it, decoded from the player's disc in
// the main process (pokemon-cries.js). Only the chosen Pokémon's cry is kept.
const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function createCry(button, { onError = () => {} } = {}) {
  let context = null, entry = null, kept = null, playing = null;

  function stop() {
    const source = playing;
    playing = null;
    button.classList.remove('playing');
    try { source?.stop(); } catch (_) { /* it had ended */ }
  }

  async function play() {
    const mine = entry;
    if (!mine) return;
    stop();
    try {
      context ||= new AudioContext();
      if (kept?.key !== mine.key) {
        const wav = await window.colo.pokedexCry(mine.key);
        const audio = await context.decodeAudioData(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
        if (entry !== mine) return;
        kept = { key: mine.key, audio };
      }
      if (entry !== mine) return;
      await context.resume();
      const source = context.createBufferSource();
      source.buffer = kept.audio;
      source.connect(context.destination);
      source.onended = () => { if (playing === source) stop(); };
      stop();
      playing = source;
      button.classList.add('playing');
      source.start();
    } catch (error) {
      if (entry === mine) onError(message(error));
    }
  }

  button.addEventListener('click', play);

  return {
    // The chosen Pokémon: the button shows when it has a cry.
    show(next) {
      stop();
      entry = next;
      if (kept?.key !== next?.key) kept = null;
      button.hidden = !next?.hasCry;
    },
    stop,
  };
}
