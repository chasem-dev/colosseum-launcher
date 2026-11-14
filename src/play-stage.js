'use strict';
// Where the Play page puts each game's logo (renderer.js layoutPlayStage), worked out here from the window's measures.
// The art is split by a diagonal (style.css #game-art): the chosen game's side takes 70% of the width where the line
// crosses the middle, and the line leans 7% of the width either way from top to bottom. A logo is fitted beside that
// line, so its size depends on the window's shape, which CSS alone can't divide by.
//
// x is across the window (the shell) and y down the Play page from its top, both in pixels; `pageTop` is how far the
// page's top is below the window's. Each game gets the centre and size of its logo, and the headline goes under the
// chosen one when it is ready to play.
//  - The other game's logo is centred in its strip, as large as fits between the line and the window's edge.
//  - The chosen game's, ready to play (no panel over the art), is centred in its side above Play, with the headline
//    under it; with a panel (the setup steps), it sits small at the top of its side so the panel has room.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ColoPlayStage = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const SPLIT = { colosseum: 70, xd: 30 }, SLANT = 7;
  // Room kept from the line and from the window's sides, and the button's room under a logo (the Switch pill, or the
  // chosen game's gold bar), with the gap above it.
  const EDGE = 18, SIDE = 20, STATE = 30, LINE_GAP = 10, TOP = 6, PLAY_GAP = 14;
  // How large logos grow: the other game's, the chosen one's share of its side, and its most; at the top during setup.
  const STRIP_MAX = 440, CHOSEN_SHARE = 0.64, CHOSEN_MAX = 660, BAND_SHARE = 0.45, BAND_MAX = 470;
  // Where the chosen side's middle is taken to be, in hundredths of the width (as the setup steps in style.css).
  const MIDDLE = { colosseum: (70 + SLANT * 0.6) / 2, xd: (100 + 30 + SLANT * 0.6) / 2 };

  const other = id => id === 'xd' ? 'colosseum' : 'xd';
  // Colosseum's side is left of the line and XD's right of it, whichever is chosen.
  const sideOf = id => id === 'colosseum' ? 'left' : 'right';
  // How far the line leans for each pixel down
  const lean = g => 0.14 * g.W / g.H;
  // Where the line is across the window at page height y
  function edge(g, y) { return g.W * (SPLIT[g.active] + SLANT) / 100 - lean(g) * (g.pageTop + y); }
  // The span of the window a box of height h centred at cy can use beside the line: right of the line the box's top
  // corner comes nearest it, left of it the bottom corner.
  function span(g, side, cy, h) {
    return side === 'right' ? [edge(g, cy - h / 2) + EDGE, g.W - SIDE] : [SIDE, edge(g, cy + h / 2) - EDGE];
  }
  // The widest box of aspect a (width / height) centred at cy that fits on its side of the line.
  function widest(g, side, cy, a) {
    const near = edge(g, cy), room = side === 'right' ? g.W - SIDE - EDGE - near : near - EDGE - SIDE;
    return Math.max(0, room / (1 + lean(g) / (2 * a)));
  }
  const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
  function place(g, side, cy, w, a, preferred) {
    const h = w / a, [low, high] = span(g, side, cy, h);
    return { cx: clamp(preferred ?? (low + high) / 2, low + w / 2, high - w / 2), cy, w, h };
  }

  // Over a box across the window (left, right) at page height y: whether it reaches into a game's side of the line.
  function reaches(g, id, box, y) {
    return sideOf(id) === 'right' ? box.right > edge(g, y) - EDGE : box.left < edge(g, y) + EDGE;
  }
  // The heights a game's logo and what goes under it can use: from the page's top (or under a banner on its side) to
  // above Play where Play reaches into its side, or else to the window's foot.
  function room(g, id) {
    const foot = g.visibleBottom ?? g.play.top;
    let top = 0, bottom = Math.min(foot, g.play.top - PLAY_GAP);
    if (!reaches(g, id, g.play, g.play.top)) bottom = foot;
    if (g.banner && reaches(g, id, g.banner, g.banner.bottom)) top = g.banner.bottom + PLAY_GAP;
    return [top, Math.max(top, bottom)];
  }

  // g: { W, H, pageTop, active ('colosseum' or 'xd'), panel (whether a panel is over the art), aspect: { colosseum, xd }
  //      (each logo's width / height, or 0 for its name), play: { left, right, top } (the Play panel), visibleBottom (the
  //      window's foot), banner: { left, right, top, bottom } or null, band (the logo's room at the top while setting up),
  //      headlineHeight }
  function layout(g) {
    const out = {}, chosen = g.active === 'xd' ? 'xd' : 'colosseum', waiting = other(chosen);
    const aspect = id => g.aspect?.[id] > 0 ? g.aspect[id] : 2.4;
    g = { ...g, active: chosen };
    [g.stripTop, g.stripBottom] = room(g, waiting);
    [g.top, g.bottom] = room(g, chosen);
    // the other game: centred in its strip with its Switch pill under it
    {
      const a = aspect(waiting), side = sideOf(waiting), cy = (g.stripTop + g.stripBottom - STATE) / 2;
      const w = Math.min(widest(g, side, cy, a), a * Math.max(0, g.stripBottom - g.stripTop - STATE), STRIP_MAX);
      out[waiting] = place(g, side, cy, w, a);
    }
    const a = aspect(chosen), side = sideOf(chosen), middle = g.W * MIDDLE[chosen] / 100;
    if (g.panel) {
      // setting up: small at the top of its side, as the steps need the room
      const h = Math.max(0, g.band - TOP - STATE - 4), cy = TOP + h / 2;
      const w = Math.min(widest(g, side, cy, a) * BAND_SHARE, BAND_MAX, a * h);
      out[chosen] = place(g, side, TOP + w / a / 2, w, a, middle);
      // the headline, beside the chosen game's banner at the window's edge: centred in the room between it and the line
      if (g.banner && reaches(g, chosen, g.banner, g.banner.bottom)) {
        const hh = g.headlineHeight || 0, top = g.banner.top ?? g.banner.bottom - hh;
        let [low, high] = span(g, side, top + hh / 2, hh);
        if (side === 'left') low = Math.max(low, g.banner.right + PLAY_GAP);
        else high = Math.min(high, g.banner.left - PLAY_GAP);
        out.headline = { cx: (low + high) / 2, top, maxWidth: Math.max(0, high - low) };
      }
    } else {
      // ready: centred above Play with the headline under it, the whole of it in the middle of the space
      const below = STATE + LINE_GAP + (g.headlineHeight || 0), cy = (g.top + g.bottom - below) / 2;
      const w = Math.min(widest(g, side, cy, a) * CHOSEN_SHARE, CHOSEN_MAX, a * Math.max(0, g.bottom - g.top - below));
      out[chosen] = place(g, side, cy, w, a, middle);
      const logo = out[chosen], top = logo.cy + logo.h / 2 + STATE + LINE_GAP;
      // the headline as wide as fits beside the line, under the logo
      const [low, high] = span(g, side, top + (g.headlineHeight || 0) / 2, g.headlineHeight || 0);
      out.headline = { cx: logo.cx, top, maxWidth: Math.max(0, Math.min(2 * (logo.cx - low), 2 * (high - logo.cx), g.W * 0.6)) };
    }
    return out;
  }

  return { layout, edge, span, room, SPLIT, SLANT, EDGE, SIDE, STATE, LINE_GAP, PLAY_GAP };
});
