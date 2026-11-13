'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lists = require('../src/jukebox-playlists');

test('a saved file is made safe: no junk, no repeats, each game its own', () => {
  const saved = { colosseum: [{ id: 'a', name: '  Battles  ', songs: ['23', '23', 24, 'x', '981'] }, { id: 'a', name: 'Again', songs: [] }, { name: 'No id' }, 'junk'], xd: 'junk' };
  const fav = songs => ({ id: 'favorites', name: 'Favorites', songs });
  assert.deepEqual(lists.normalizeAll(saved, ['colosseum', 'xd']), { colosseum: [fav([]), { id: 'a', name: 'Battles', songs: ['23', '981'] }], xd: [fav([])] });
  assert.deepEqual(lists.normalize(null), [fav([])]);
});

test('a new playlist gets a name of its own, and the lists given are left as they were', () => {
  const start = [];
  const one = lists.create(start, 'Battles');
  assert.equal(lists.create(lists.normalize([]), 'favorites').list[1].name, 'favorites 2');
  const two = lists.create(one.list, 'battles');
  const three = lists.create(two.list, '   ');
  assert.deepEqual(start, []);
  assert.deepEqual(three.list.map(each => each.name), ['Battles', 'battles 2', 'New playlist']);
  assert.equal(new Set(three.list.map(each => each.id)).size, 3);
});

test('songs are added once, removed, and moved', () => {
  let { list, id } = lists.create([], 'Mix');
  for (const song of ['1', '2', '3', '2']) list = lists.add(list, id, song);
  assert.deepEqual(list[0].songs, ['1', '2', '3']);
  list = lists.move(list, id, 0, 2);
  assert.deepEqual(list[0].songs, ['2', '3', '1']);
  assert.equal(lists.move(list, id, 0, 9), list);   // nowhere to go: unchanged
  list = lists.drop(list, id, '3');
  assert.deepEqual(list[0].songs, ['2', '1']);
  list = lists.rename(list, id, '  Best  of ');
  assert.equal(list[0].name, 'Best of');
  assert.equal(lists.rename(list, id, '  '), list);
  assert.deepEqual(lists.remove(list, id), []);
});

test('the order played leaves out what the disc does not have, and a shuffle keeps every song', () => {
  const playlist = { id: 'p', name: 'P', songs: ['1', '2', '3', '4', '5'] };
  const has = id => id !== '3';
  assert.deepEqual(lists.order(playlist, has), ['1', '2', '4', '5']);
  let n = 0;
  const shuffled = lists.order(playlist, has, true, () => [0.1, 0.7, 0.3][n++ % 3]);
  assert.deepEqual([...shuffled].sort(), ['1', '2', '4', '5']);
  assert.notDeepEqual(shuffled, ['1', '2', '4', '5']);
});

test('Favorites is always first, keeps its name, and the star adds and removes a song', () => {
  let list = lists.normalize([{ id: 'x', name: 'Mine', songs: ['5'] }, { id: 'favorites', name: 'Renamed', songs: ['7', '7', 'bad'] }]);
  assert.deepEqual(list.map(each => [each.id, each.name]), [['favorites', 'Favorites'], ['x', 'Mine']]);
  assert.deepEqual(list[0].songs, ['7']);
  assert.equal(lists.rename(list, 'favorites', 'Other'), list);
  assert.equal(lists.remove(list, 'favorites'), list);
  list = lists.toggleFavorite(list, '9');
  assert.ok(lists.isFavorite(list, '9'));
  list = lists.toggleFavorite(list, '9');
  assert.ok(!lists.isFavorite(list, '9'));
  assert.ok(!lists.isFavorite(list, '5'));
});
