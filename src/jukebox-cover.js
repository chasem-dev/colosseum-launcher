'use strict';

// A cover for each song of the Jukebox, drawn as a GameCube-style disc: a silver rim, the cover's art, and a hub with a hole in it
// (the page behind shows through), to be shown small beside a song in the list and larger in the player, where it spins while the
// music plays. There is no artwork for the songs, so the art is made from the song: its colours come from its name, and its emblem
// and warmth from what kind of song it is (a tune, a battle, or a jingle). A song with artwork of its own can be given it in COVERS.
(function (root) {
  // Artwork a song has been given: its name -> the markup of a picture drawn in a 100 x 100 box, for the disc's face. (None yet.)
  const COVERS = Object.freeze({});

  // 32-bit FNV-1a: the same name always gives the same number, so a song keeps its colours.
  function hash(text) {
    let h = 0x811c9dc5;
    for (const unit of String(text ?? '')) { h ^= unit.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }

  // What a song is, for its look: 'battle', 'jingle' (a short track), 'unused' (the game has no use for it), 'silence' or 'tune'.
  function kind(track) {
    const name = String(track?.name ?? '');
    if (/silence/i.test(name)) return 'silence';
    if (/\(unused\)/i.test(name)) return 'unused';
    if (/battle|vs\. mode|admin|peon|final fight/i.test(name) && !track?.short) return 'battle';
    if (track?.short) return 'jingle';
    return 'tune';
  }

  // The disc's colours: a light, a mid and a dark of one hue, chosen by the song's kind and name.
  function palette(track) {
    const h = hash(track?.name), kindOf = kind(track);
    let hue, sat, light;
    if (kindOf === 'battle') { hue = (350 + h % 45) % 360; sat = 72; light = 56; }   // reds and oranges
    else if (kindOf === 'jingle') { hue = 185 + h % 85; sat = 62; light = 62; }      // cool blues and violets
    else if (kindOf === 'tune') { hue = 28 + h % 290; sat = 58; light = 55; }        // anything but battle's red
    else { hue = 250; sat = 6; light = 55; }                                         // grey: nothing to hear
    return { hue, light: `hsl(${hue} ${sat}% ${Math.min(80, light + 14)}%)`, mid: `hsl(${hue} ${sat}% ${light}%)`, dark: `hsl(${(hue + 28) % 360} ${sat}% ${Math.max(14, light - 30)}%)` };
  }

  const EMBLEMS = {
    tune: '<path d="M-4 6V-8l9-2v14" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="-6.5" cy="6.5" r="3.3" fill="#fff"/><circle cx="2.5" cy="4.5" r="3.3" fill="#fff"/>',
    battle: '<path d="M3 -11L-6 2H-0.5L-3.5 11L6.5 -3H1z" fill="#fff"/>',
    jingle: '<path d="M0 -9.5L2.7 -3 9.5 -3 4 1.4 6.2 8.5 0 4.4-6.2 8.5-4 1.4-9.5-3-2.7-3z" fill="#fff"/>',
    unused: '<path d="M-7 0H7" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>',
    silence: ''
  };

  let counter = 0;

  // The disc as an <svg>, in a 100 x 100 box. Its pieces carry their own ids (so that several on a page do not share them),
  // and the part that turns is the group of class "disc-spin". Nothing of the song's text goes into it.
  function disc(track) {
    const id = `jc${++counter}`, p = palette(track), kindOf = kind(track);
    const custom = Object.hasOwn(COVERS, track?.name) ? COVERS[track.name] : null;
    // like the game's own disc: a silver face, a dark printed band across its top half (here in the song's colour), and a silver hub
    const face = custom ?? `<circle cx="50" cy="50" r="47" fill="#e4e1ea"/>`
      + `<path d="M3 50A47 47 0 0 1 97 50Z" fill="#1c1a22"/><path d="M3 50A47 47 0 0 1 97 50Z" fill="url(#${id}-face)" opacity=".9"/>`
      + `<path d="M3 50H97" stroke="${p.mid}" stroke-width="2.2"/>`
      + '<circle cx="50" cy="50" r="38" fill="none" stroke="#000" stroke-opacity=".08" stroke-width="1.1"/>'
      + '<circle cx="50" cy="50" r="29" fill="none" stroke="#000" stroke-opacity=".06" stroke-width="1.1"/>'
      + '<circle cx="50" cy="50" r="21" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="1.1"/>'
      + (EMBLEMS[kindOf] ? `<g transform="translate(50 27)" opacity=".92">${EMBLEMS[kindOf]}</g>` : '');
    return `<svg class="jukebox-disc-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false" data-kind="${kindOf}">`
      + `<defs><radialGradient id="${id}-face" cx="38%" cy="32%" r="80%"><stop offset="0" stop-color="${p.light}"/><stop offset=".55" stop-color="${p.mid}"/><stop offset="1" stop-color="${p.dark}"/></radialGradient>`
      + `<linearGradient id="${id}-rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f2f8"/><stop offset=".5" stop-color="#c9c3d6"/><stop offset="1" stop-color="#eeeaf4"/></linearGradient>`
      + `<mask id="${id}-hole"><rect width="100" height="100" fill="#fff"/><circle cx="50" cy="50" r="5.2" fill="#000"/></mask></defs>`
      + `<g class="disc-spin" mask="url(#${id}-hole)"><circle cx="50" cy="50" r="49.5" fill="url(#${id}-rim)"/>${face}`
      + '<circle cx="50" cy="50" r="15.5" fill="#ebe8f1"/><circle cx="50" cy="50" r="15.5" fill="none" stroke="#b9b2c8" stroke-width="1"/>'
      + '<circle cx="50" cy="50" r="10.5" fill="none" stroke="#c9c3d6" stroke-width="1.4"/></g>'
      // the light on it stays where it is while the disc turns under it
      + '<path d="M50 50 L84 14 A49 49 0 0 1 96 38 Z" fill="#fff" opacity=".13"/><path d="M50 50 L16 86 A49 49 0 0 1 4 62 Z" fill="#fff" opacity=".07"/>'
      + '</svg>';
  }

  const api = { COVERS, hash, kind, palette, disc };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.coloJukeboxCover = api;
})(typeof globalThis === 'object' ? globalThis : this);
