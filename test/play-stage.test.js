'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const stage = require('../src/play-stage');

// A Play page as the launcher lays it out (style.css): the title bar and tabs above it, Play near its foot, centred in
// the window when ready and on the chosen game's side while setting up.
function geometry(W, H, active, panel, extra = {}) {
  const pad = H > 800 ? 24 : 16, pageTop = 105 + pad, foot = H - 36 - 12 - pageTop;
  const playHeight = panel ? 89 : 96, playWidth = Math.min(panel ? 620 : 580, W - 56);
  const middle = active === 'xd' ? W * 0.671 : W * 0.371;
  const left = panel ? Math.max(28, Math.min(middle - playWidth / 2, W * 0.63 - 18 - playWidth)) : (W - playWidth) / 2;
  return {
    W, H, pageTop, active, panel, aspect: { colosseum: 540 / 224, xd: 545 / 221 },
    play: { left: panel && active === 'xd' ? W - 28 - playWidth : left, right: (panel && active === 'xd' ? W - 28 : left + playWidth), top: foot - playHeight },
    visibleBottom: foot, banner: null, band: Math.min(Math.max(66, H * 0.14), 160), headlineHeight: 24, ...extra
  };
}
const SIZES = [[900, 600], [1080, 760], [1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440], [900, 1000], [2560, 900]];

// Every corner of a box is on its game's side of the line, by at least the gap kept from it.
function clearOfLine(g, id, box) {
  const corners = [[box.left, box.top], [box.right, box.top], [box.left, box.bottom], [box.right, box.bottom]];
  return corners.every(([x, y]) => id === 'colosseum' ? x <= stage.edge(g, y) - stage.EDGE + 0.01 : x >= stage.edge(g, y) + stage.EDGE - 0.01);
}
const boxOf = place => ({ left: place.cx - place.w / 2, right: place.cx + place.w / 2, top: place.cy - place.h / 2, bottom: place.cy + place.h / 2 });
// the logo with the button's room under it (the Switch pill or gold bar)
const withState = place => ({ ...boxOf(place), left: place.cx - Math.min(place.w, 90) / 2, right: place.cx + Math.min(place.w, 90) / 2,
  top: place.cy + place.h / 2, bottom: place.cy + place.h / 2 + stage.STATE });
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test('at every window size, no logo crosses the line, the window\'s sides, the tabs above or Play below', () => {
  for (const [W, H] of SIZES) for (const active of ['colosseum', 'xd']) for (const panel of [false, true]) {
    const g = geometry(W, H, active, panel), places = stage.layout(g), label = `${W}x${H} ${active}${panel ? ' setting up' : ''}`;
    const play = { left: g.play.left, right: g.play.right, top: g.play.top, bottom: g.play.top + 200 };
    for (const id of ['colosseum', 'xd']) {
      const logo = boxOf(places[id]);
      assert.ok(places[id].w > 0, `${label}: ${id} has a logo`);
      assert.ok(clearOfLine(g, id, logo), `${label}: ${id}'s logo crosses the line`);
      assert.ok(clearOfLine(g, id, withState(places[id])), `${label}: ${id}'s Switch crosses the line`);
      assert.ok(logo.left >= stage.SIDE - 0.01 && logo.right <= W - stage.SIDE + 0.01, `${label}: ${id} leaves the window`);
      assert.ok(logo.top >= 0, `${label}: ${id} reaches the tabs`);
      assert.ok(!overlaps(logo, play) && !overlaps(withState(places[id]), play), `${label}: ${id} is over Play`);
      assert.ok(withState(places[id]).bottom <= g.visibleBottom + 0.01, `${label}: ${id} is below the window's foot`);
    }
    assert.ok(!overlaps(boxOf(places.colosseum), boxOf(places.xd)), `${label}: the logos overlap`);
    if (!panel) {
      const headline = places.headline, chosen = boxOf(places[active]);
      assert.equal(headline.cx, places[active].cx, `${label}: the headline is under the chosen logo`);
      assert.ok(headline.top >= chosen.bottom + stage.STATE, `${label}: the headline is under the logo`);
      assert.ok(headline.top + g.headlineHeight <= g.play.top - stage.PLAY_GAP + 0.01, `${label}: the headline is over Play`);
      const half = headline.maxWidth / 2;
      assert.ok(clearOfLine(g, active, { left: headline.cx - half, right: headline.cx + half, top: headline.top, bottom: headline.top + g.headlineHeight }),
        `${label}: the headline may cross the line`);
    } else assert.equal(places.headline, undefined);
  }
});

test('ready to play, both logos are centred in their space above Play, and much bigger than at the top', () => {
  for (const [W, H] of SIZES) for (const active of ['colosseum', 'xd']) {
    const g = geometry(W, H, active, false), places = stage.layout(g), waiting = active === 'xd' ? 'colosseum' : 'xd';
    const [top, bottom] = stage.room(g, waiting);
    // the other game's logo and its Switch, in the middle of its strip
    assert.ok(Math.abs(places[waiting].cy - places[waiting].h / 2 - top - (bottom - places[waiting].cy - places[waiting].h / 2 - stage.STATE)) < 1, `${W}x${H}: ${waiting} centred`);
    // the chosen one, its bar and the headline under it, in the middle above Play
    const chosen = places[active], [low, high] = stage.room(g, active);
    const above = chosen.cy - chosen.h / 2 - low, below = high - (places.headline.top + g.headlineHeight);
    assert.ok(Math.abs(above - below) < 1, `${W}x${H}: ${active} centred (${above} above, ${below} below)`);
    const setup = stage.layout(geometry(W, H, active, true));
    assert.ok(chosen.w > setup[active].w * 1.5, `${W}x${H}: ${active} grows when ready (${chosen.w} vs ${setup[active].w})`);
    assert.ok(chosen.w > places[waiting].w, `${W}x${H}: the chosen logo is the larger`);
  }
  // the window the launcher opens at: the other game's logo is far larger than its old 140 or so pixels
  const usual = stage.layout(geometry(1080, 760, 'colosseum', false));
  assert.ok(usual.xd.w > 240, `XD's logo is ${usual.xd.w} wide`);
  assert.ok(usual.colosseum.w > 400, `Colosseum's logo is ${usual.colosseum.w} wide`);
});

test('setting up, the chosen logo stays at the top for the panel, and the other stays centred in its strip', () => {
  const g = geometry(1080, 760, 'colosseum', true), places = stage.layout(g);
  assert.ok(places.colosseum.cy - places.colosseum.h / 2 < 10, 'the chosen logo is at the top');
  assert.ok(places.colosseum.h + stage.STATE <= g.band, 'and fits the room kept for it');
  // Play is on Colosseum's side, so XD's strip runs to the window's foot
  const [top, bottom] = stage.room(g, 'xd');
  assert.equal(bottom, g.visibleBottom);
  assert.ok(Math.abs(places.xd.cy - (top + bottom - stage.STATE) / 2) < 0.01);
});

test('a banner on the other game\'s side keeps its logo below it, and a logo of any shape fits', () => {
  const g = geometry(1080, 760, 'colosseum', false, { banner: { left: 760, right: 1052, bottom: 70 } }), places = stage.layout(g);
  assert.ok(places.xd.cy - places.xd.h / 2 >= 70 + stage.PLAY_GAP - 0.01);
  // a game shown by its name (no logo read), or a tall logo
  for (const aspect of [{}, { colosseum: 1, xd: 0.8 }]) {
    const tall = geometry(1080, 760, 'xd', false, { aspect }), placed = stage.layout(tall);
    for (const id of ['colosseum', 'xd']) assert.ok(clearOfLine(tall, id, boxOf(placed[id])), `${id} fits at aspect ${JSON.stringify(aspect)}`);
  }
});
