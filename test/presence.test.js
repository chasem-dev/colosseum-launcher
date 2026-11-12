'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const presence = require('../src/presence');

// Lines as the game prints them (host/presence.c), from runs to Rider Willie and Battle Now.
const line = fields => `[presence] ${JSON.stringify({ mode: 'field', story: 1, floor: 1, area: 1, place: 'OUTSKIRT STAND',
  opponent: '', lead: 'UMBREON', level: 26, ...fields })}`;

test('only the game\'s presence lines are read', () => {
  assert.equal(presence.parseLine('boot: floorRequestChange(0x1) at retrace 700'), null);
  assert.equal(presence.parseLine('[presence] {broken'), null);
  assert.equal(presence.parseLine('[presence] {"mode":"dancing"}'), null);
  assert.equal(presence.parseLine(line()).place, 'OUTSKIRT STAND');
  assert.ok(presence.isPresenceLine(line()));
});

test('the game\'s capitals are written as names', () => {
  assert.equal(presence.titleCase('RIDER WILLIE'), 'Rider Willie');
  assert.equal(presence.titleCase("MAYOR'S HOUSE"), "Mayor's House");
  assert.equal(presence.titleCase('HO-OH'), 'Ho-Oh');
  assert.equal(presence.titleCase('MT. BATTLE'), 'Mt. Battle');
  assert.equal(presence.titleCase('MIROR B.'), 'Miror B.');
});

test('in the field: the place, its area\'s picture and the lead Pokémon', () => {
  const activity = presence.activity(presence.parseLine(line()), { startedAt: 1000 });
  assert.equal(activity.details, 'Outskirt Stand');
  assert.equal(activity.state, 'Lead: Umbreon, Lv. 26');
  assert.equal(activity.assets.large_image, 'outskirt_stand');
  assert.equal(activity.assets.large_text, 'Outskirt Stand');
  assert.deepEqual(activity.timestamps, { start: 1000 });
  assert.equal(activity.assets.small_image, 'launcher');
});

test('a short place name is written out, and a place inside an area gets the area\'s picture', () => {
  const activity = presence.activity(presence.parseLine(line({ place: 'REALGAMTWR DOME', area: 8 })));
  assert.equal(activity.details, 'Realgam Tower Dome');
  assert.equal(activity.assets.large_image, 'realgam_tower');
  assert.equal(presence.activity(presence.parseLine(line({ place: 'NEW PLACE', area: 4 }))).assets.large_image, 'agate_village');
});

test('a story battle says who it is against; Battle Mode hides the story\'s party', () => {
  const story = presence.activity(presence.parseLine(line({ mode: 'battle', floor: 200, area: 0, opponent: 'RIDER WILLIE' })));
  assert.equal(story.details, 'Outskirt Stand');
  assert.equal(story.state, 'Battling Rider Willie');
  assert.equal(story.assets.large_image, 'outskirt_stand');
  assert.equal(story.assets.large_text, 'Lead: Umbreon, Lv. 26');
  const battleMode = presence.activity(presence.parseLine(line({ mode: 'battle', story: 0, floor: 14, area: 2,
    place: 'PHENAC STADIUM', opponent: 'FUN OLD LADY DESOR' })));
  assert.equal(battleMode.details, 'Battle Mode');
  assert.equal(battleMode.state, 'Battling Fun Old Lady Desor');
  assert.equal(battleMode.assets.large_image, 'phenac_city');
  assert.ok(!JSON.stringify(battleMode).includes('Umbreon'));
  assert.equal(presence.activity(presence.parseLine(line({ mode: 'battle', opponent: '' }))).state, 'In a battle');
});

test('menus, movies and cutscenes', () => {
  const menu = presence.activity(presence.parseLine(line({ mode: 'menu', story: 0, floor: 900, area: 9, place: '' })));
  assert.equal(menu.details, 'In the menus');
  assert.equal(menu.state, undefined);
  assert.equal(menu.assets.large_image, 'logo');
  assert.equal(presence.activity(presence.parseLine(line({ mode: 'movie' }))).details, 'Watching a cutscene');
  const scene = presence.activity(presence.parseLine(line({ mode: 'scene', place: 'SNAGEM HIDEOUT', area: 10 })));
  assert.deepEqual([scene.details, scene.state, scene.assets.large_image], ['Snagem Hideout', 'Watching a cutscene', 'snagem_hideout']);
  assert.equal(presence.activity(presence.parseLine(line({ mode: 'boot', place: '', floor: 0 }))).details, 'Starting up');
});

test('a game that prints nothing still shows the game, and an online battle shows the opponent', () => {
  const quiet = presence.activity(null, { startedAt: 5 });
  assert.equal(quiet.details, undefined);
  assert.equal(quiet.assets.large_image, 'logo');
  assert.equal(quiet.buttons.length, 2);
  const online = presence.activity(presence.parseLine(line({ mode: 'battle', story: 0 })), { online: { opponent: 'Ash' } });
  assert.deepEqual([online.details, online.state, online.assets.large_image], ['Online battle', 'Battling Ash', 'orre_colosseum']);
  assert.equal(presence.activity(null, { online: { opponent: null } }).state, 'Waiting for a challenger');
});

test('texts fit what Discord accepts', () => {
  const activity = presence.activity(presence.parseLine(line({ mode: 'battle', opponent: 'X'.repeat(300) })));
  assert.ok(activity.state.length <= 128);
  assert.equal(presence.activity(presence.parseLine(line({ mode: 'field', place: 'A' }))).details, undefined);
});

test('every image the activity names is one of the art assets', () => {
  const art = new Set([...Object.values(presence.PLACE_IMAGES), ...Object.values(presence.AREA_IMAGES), 'logo', 'launcher', 'orre_colosseum']);
  const listed = fs.readFileSync(path.join(__dirname, '..', 'docs', 'discord-art.md'), 'utf8');
  for (const key of art) assert.ok(listed.includes(`\`${key}\``), `${key} is not in docs/discord-art.md`);
});

test('XD\'s activity names XD, and only a place\'s own name picks its picture (its areas are numbered its own way)', () => {
  const xd = { gameName: 'Pokémon XD: Gale of Darkness', areaImages: false };
  const field = presence.activity({ mode: 'field', story: 1, floor: 100, area: 2, place: 'PHENAC CITY', lead: 'EEVEE', level: 10 }, xd);
  assert.equal(field.details, 'Phenac City');
  assert.equal(field.assets.large_image, presence.PLACE_IMAGES['PHENAC CITY'] || 'logo');
  const lab = presence.activity({ mode: 'field', story: 1, floor: 141, area: 5, place: 'POKéMON HQ LAB' }, xd);
  assert.equal(lab.assets.large_image, presence.PLACE_IMAGES['POKéMON HQ LAB'] || 'logo', 'no Colosseum area art for an XD area number');
  const menu = presence.activity({ mode: 'menu', floor: 921, area: 14, place: '' }, xd);
  assert.equal(menu.assets.large_text, 'Pokémon XD: Gale of Darkness');
});
