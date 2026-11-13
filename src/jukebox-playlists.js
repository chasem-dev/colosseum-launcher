'use strict';

// The Jukebox's playlists: the player's own lists of songs and sound effects, to play through instead of the whole soundtrack.
// Each game has its own (a song's id is its sound id, which means another song on the other game's disc). The main process keeps
// them in the launcher's data folder (jukebox-playlists.json: { colosseum: [...], xd: [...] }); the page changes them with these
// functions, each of which returns a new list and leaves the one it was given alone.
// A playlist: { id, name, songs: [song id, ...] }. A song can be in a playlist once.
// Favorites is a playlist every list has, first, that the star beside a song fills: it can't be renamed or deleted.
(function (root) {
  const MOST_PLAYLISTS = 200, MOST_SONGS = 2000, LONGEST_NAME = 60;
  const FAVORITES = 'favorites', FAVORITES_NAME = 'Favorites';
  const songsOf = songs => [...new Set((Array.isArray(songs) ? songs : []).filter(song => typeof song === 'string' && /^\d{1,6}$/.test(song)))].slice(0, MOST_SONGS);

  const cleanName = name => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, LONGEST_NAME);

  // A list as it was saved, made safe to use: what isn't a playlist is left out, and so is what is too much.
  function normalize(list) {
    const saved = Array.isArray(list) ? list : [];
    const out = [{ id: FAVORITES, name: FAVORITES_NAME, songs: songsOf(saved.find(each => each?.id === FAVORITES)?.songs) }], ids = new Set([FAVORITES]);
    for (const each of saved) {
      if (out.length >= MOST_PLAYLISTS) break;
      const name = cleanName(each?.name), id = typeof each?.id === 'string' && /^[\w-]{1,40}$/.test(each.id) ? each.id : null;
      if (!name || !id || ids.has(id)) continue;
      ids.add(id);
      const songs = songsOf(each.songs);
      out.push({ id, name, songs });
    }
    return out;
  }

  // The saved file, every game's lists made safe: { [game]: list }.
  function normalizeAll(saved, games) {
    const out = {};
    for (const game of games) out[game] = normalize(saved?.[game]);
    return out;
  }

  // A new playlist's id: unlike any in the list.
  function newId(list) {
    let id;
    do id = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`; while (list.some(each => each.id === id));
    return id;
  }

  // A new, empty playlist at the end; a name already taken gets a number ("Battles 2"). Returns { list, id }.
  function create(list, name) {
    let base = cleanName(name) || 'New playlist', taken = new Set(list.map(each => each.name.toLowerCase())), chosen = base;
    for (let n = 2; taken.has(chosen.toLowerCase()); n++) chosen = `${base.slice(0, LONGEST_NAME - String(n).length - 1)} ${n}`;
    if (list.length >= MOST_PLAYLISTS) return { list, id: null };
    const id = newId(list);
    return { list: [...list, { id, name: chosen, songs: [] }], id };
  }

  // an edit to one playlist; one that changes nothing gives back the list itself
  function change(list, id, edit) {
    const out = list.map(each => (each.id === id ? edit(each) : each));
    return out.every((each, i) => each === list[i]) ? list : out;
  }
  const rename = (list, id, name) => (cleanName(name) && id !== FAVORITES ? change(list, id, each => ({ ...each, name: cleanName(name) })) : list);
  const remove = (list, id) => (id === FAVORITES ? list : list.filter(each => each.id !== id));
  // Favorites: whether a song is in it, and the star's toggle
  const isFavorite = (list, song) => Boolean(list.find(each => each.id === FAVORITES)?.songs.includes(song));
  const toggleFavorite = (list, song) => (isFavorite(list, song) ? drop(list, FAVORITES, song) : add(list, FAVORITES, song));
  // a song at the end, once
  const add = (list, id, song) => change(list, id, each => (each.songs.includes(song) || each.songs.length >= MOST_SONGS ? each : { ...each, songs: [...each.songs, String(song)] }));
  const drop = (list, id, song) => change(list, id, each => ({ ...each, songs: each.songs.filter(one => one !== song) }));
  // the song at `from` moved to `to` (both places in the playlist as it is)
  function move(list, id, from, to) {
    return change(list, id, each => {
      if (from === to || from < 0 || to < 0 || from >= each.songs.length || to >= each.songs.length) return each;
      const songs = [...each.songs], [song] = songs.splice(from, 1);
      songs.splice(to, 0, song);
      return { ...each, songs };
    });
  }

  // The order to play a playlist's songs in: as listed, or shuffled (random() is Math.random, or a test's own), the ones `has`
  // doesn't know left out (a song the disc doesn't have).
  function order(playlist, has, shuffled = false, random = Math.random) {
    const songs = (playlist?.songs ?? []).filter(has);
    if (shuffled) for (let i = songs.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [songs[i], songs[j]] = [songs[j], songs[i]]; }
    return songs;
  }

  const api = { MOST_PLAYLISTS, MOST_SONGS, LONGEST_NAME, FAVORITES, normalize, normalizeAll, create, rename, remove, add, drop, move, order, isFavorite, toggleFavorite };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.coloJukeboxPlaylists = api;
})(typeof globalThis === 'object' ? globalThis : this);
