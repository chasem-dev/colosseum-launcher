'use strict';
// Button prompts: the pictures of a controller's buttons the game shows beside each move when Quick moves
// opens them (the game's host/quickmoves.c, through the renderer's gx_prompts.cpp, as in the Super Mario
// Sunshine port and its launcher, whose src/prompts.js this follows). For each style the launcher draws one
// strip of 64x64 icons, in the order A B X Y Z L R C-stick, saved as <style>.png in the folder named by
// SMS_BUTTON_PROMPT_DIR. Each icon shows what that GameCube button is bound to (src/bindings.js), so a
// remapped key or controller button shows as the player set it; GameCube shows the GameCube's own buttons.
// After those eight come two empty cells (the renderer's save state hint in the Sunshine port) and the four
// directions, up, down, left and right, which the game's Pokémon selection screen picks with: the D-pad as a
// controller has it, or on a keyboard the key that moves that way (an arrow key when one is bound).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./bindings'));
  else root.ColoPrompts = factory(root.ColoBindings);
})(typeof self !== 'undefined' ? self : this, bindings => {
  const CELL = 64;
  const GLYPHS = ['A', 'B', 'X', 'Y', 'Z', 'L', 'R', 'CSTICK'];
  const DIRECTIONS = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
  // every cell of a strip, in order: null is an empty one
  const CELLS = [...GLYPHS, null, null, ...DIRECTIONS];
  // The choices for the setting: auto follows the device in use (keyboard, or the kind of controller);
  // the others always show that style, whatever is plugged in.
  const STYLES = [
    { id: 'auto', label: 'Automatic' }, { id: 'gamecube', label: 'GameCube' },
    { id: 'xbox', label: 'Xbox' }, { id: 'playstation', label: 'PlayStation 5' },
    { id: 'steamdeck', label: 'Steam Deck' }, { id: 'nintendo', label: 'Nintendo Switch' },
    { id: 'keyboard', label: 'PC keyboard' }
  ];
  // With auto, how a controller's prompts look: like that controller (match) or always one style.
  const PAD_STYLES = [
    { id: 'match', label: 'Match my controller' }, { id: 'xbox', label: 'Xbox' },
    { id: 'playstation', label: 'PlayStation 5' }, { id: 'steamdeck', label: 'Steam Deck' },
    { id: 'nintendo', label: 'Nintendo Switch' }, { id: 'gamecube', label: 'GameCube' }
  ];
  // The styles that have pictures (auto picks among them while playing).
  const DRAWN = ['gamecube', 'xbox', 'playstation', 'steamdeck', 'nintendo', 'keyboard'];

  function normalizeStyle(value) { return STYLES.some(style => style.id === value) ? value : 'auto'; }
  function normalizePad(value) { return PAD_STYLES.some(style => style.id === value) ? value : 'match'; }

  // How each controller button looks in each style. Face buttons are circles
  // with a letter or a PlayStation symbol, shoulders and triggers are tabs.
  // Controller buttons go by their letters (the game reads Switch controllers,
  // and others with Nintendo button layout, that way), so Nintendo's A is PAD_A.
  const FACE = {
    xbox: {
      PAD_A: { text: 'A', fill: '#107c10' }, PAD_B: { text: 'B', fill: '#d0271d' },
      PAD_X: { text: 'X', fill: '#1d66d0' }, PAD_Y: { text: 'Y', fill: '#e2a90b' }
    },
    playstation: {
      PAD_A: { symbol: 'cross', fill: '#22252b', ink: '#7ca7e8' }, PAD_B: { symbol: 'circle', fill: '#22252b', ink: '#e8707a' },
      PAD_X: { symbol: 'square', fill: '#22252b', ink: '#da8cc6' }, PAD_Y: { symbol: 'triangle', fill: '#22252b', ink: '#5fc7a6' }
    },
    steamdeck: {
      PAD_A: { text: 'A', fill: '#2b3138' }, PAD_B: { text: 'B', fill: '#2b3138' },
      PAD_X: { text: 'X', fill: '#2b3138' }, PAD_Y: { text: 'Y', fill: '#2b3138' }
    },
    nintendo: {
      PAD_A: { text: 'A', fill: '#1d1f23' }, PAD_B: { text: 'B', fill: '#1d1f23' },
      PAD_X: { text: 'X', fill: '#1d1f23' }, PAD_Y: { text: 'Y', fill: '#1d1f23' }
    }
  };
  const OTHER = {
    xbox: { PAD_LB: 'LB', PAD_RB: 'RB', PAD_LT: 'LT', PAD_RT: 'RT', PAD_BACK: 'View', PAD_START: 'Menu', PAD_LSTICK: 'LS', PAD_RSTICK: 'RS', PAD_GUIDE: 'Xbox' },
    playstation: { PAD_LB: 'L1', PAD_RB: 'R1', PAD_LT: 'L2', PAD_RT: 'R2', PAD_BACK: 'Create', PAD_START: 'Options', PAD_LSTICK: 'L3', PAD_RSTICK: 'R3', PAD_GUIDE: 'PS' },
    steamdeck: { PAD_LB: 'L1', PAD_RB: 'R1', PAD_LT: 'L2', PAD_RT: 'R2', PAD_BACK: 'View', PAD_START: 'Menu', PAD_LSTICK: 'L3', PAD_RSTICK: 'R3', PAD_GUIDE: 'Steam' },
    nintendo: { PAD_LB: 'L', PAD_RB: 'R', PAD_LT: 'ZL', PAD_RT: 'ZR', PAD_BACK: '−', PAD_START: '+', PAD_LSTICK: 'LS', PAD_RSTICK: 'RS', PAD_GUIDE: 'Home' }
  };
  // The GameCube controller's own buttons: a big green A, a red B, grey X and Y, a purple Z, grey L and R, a
  // yellow C-stick.
  const GAMECUBE = {
    A: { kind: 'face', text: 'A', fill: '#2fa14a' }, B: { kind: 'face', text: 'B', fill: '#d0352b' },
    X: { kind: 'face', text: 'X', fill: '#9aa0a8' }, Y: { kind: 'face', text: 'Y', fill: '#9aa0a8' },
    Z: { kind: 'shoulder', text: 'Z', fill: '#6b4fb8' }, L: { kind: 'trigger', text: 'L' }, R: { kind: 'trigger', text: 'R' },
    CSTICK: { kind: 'stick', text: 'C', fill: '#e8c21c' }
  };
  const DPAD = { PAD_DPUP: 'up', PAD_DPDOWN: 'down', PAD_DPLEFT: 'left', PAD_DPRIGHT: 'right' };

  // Short labels for keys whose game name is long (the rest show as named).
  const KEY_LABELS = {
    SPACE: 'Space', ENTER: 'Enter', ESCAPE: 'Esc', BACKSPACE: 'Bksp', TAB: 'Tab', LSHIFT: 'Shift', RSHIFT: 'Shift',
    LCTRL: 'Ctrl', RCTRL: 'Ctrl', LALT: 'Alt', RALT: 'Alt', UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→',
    MINUS: '-', EQUALS: '=', LBRACKET: '[', RBRACKET: ']', SEMICOLON: ';', APOSTROPHE: "'", COMMA: ',',
    PERIOD: '.', SLASH: '/', KP_DIVIDE: 'Num/', KP_MULTIPLY: 'Num*', KP_MINUS: 'Num-', KP_PLUS: 'Num+', KP_ENTER: 'NumEnt'
  };
  function keyLabel(key) { return KEY_LABELS[key] || key.replace(/^KP_/, 'Num'); }
  // A key cap, or for a mouse button (MOUSE_LEFT ...) a mouse with that button dark.
  const MOUSE = { MOUSE_LEFT: 'left', MOUSE_MIDDLE: 'middle', MOUSE_RIGHT: 'right', MOUSE_BACK: 'back', MOUSE_FORWARD: 'forward' };
  // An arrow key's arrow is drawn, not written: a font's is too thin to read at the game's size.
  const ARROWS = { UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right' };
  function keyIcon(key) {
    if (MOUSE[key]) return { kind: 'mouse', button: MOUSE[key] };
    return { kind: 'key', text: keyLabel(key), ...(ARROWS[key] ? { arrow: ARROWS[key] } : {}) };
  }

  // A controller button as that style shows it.
  function padIcon(style, pad) {
    if (FACE[style][pad]) return { kind: 'face', ...FACE[style][pad] };
    if (DPAD[pad]) return { kind: 'dpad', direction: DPAD[pad] };
    const text = OTHER[style][pad] || bindings.padLabel(pad);
    if (/^(LB|RB|L1|R1|L|R)$/.test(text)) return { kind: 'shoulder', text };
    if (/^(LT|RT|L2|R2|ZL|ZR)$/.test(text)) return { kind: 'trigger', text };
    return { kind: 'pill', text };
  }

  // What to draw for one glyph: a key cap, a mouse, a controller button, the
  // right stick, the GameCube's own button, or (nothing bound) the GameCube letter greyed out.
  function icon(style, glyph, keyBindings, padBindings, options = {}) {
    if (!glyph) return { kind: 'empty' };
    if (DIRECTIONS.includes(glyph)) {
      const direction = glyph.toLowerCase();
      if (style === 'gamecube') return { kind: 'dpad', direction };
      if (style === 'keyboard') {
        // the stick's keys pick on that screen as the D-pad's do: the arrow key says which way by itself
        const keys = [...bindings.keysFor(keyBindings, `STICK_${glyph}`), ...bindings.keysFor(keyBindings, `DPAD_${glyph}`)];
        const key = keys.includes(glyph) ? glyph : keys[0];
        return key ? keyIcon(key) : { kind: 'dpad', direction };
      }
      const pad = bindings.padsFor(padBindings, `DPAD_${glyph}`)[0];
      return pad ? padIcon(style, pad) : { kind: 'dpad', direction };
    }
    if (style === 'gamecube') return GAMECUBE[glyph];
    if (style === 'keyboard') {
      if (glyph === 'CSTICK') {
        if (options.mouseCamera) return { kind: 'mouse' };
        const keys = ['CSTICK_UP', 'CSTICK_LEFT', 'CSTICK_DOWN', 'CSTICK_RIGHT'].map(id => bindings.keysFor(keyBindings, id)[0]);
        if (keys.every(key => key && !MOUSE[key] && keyLabel(key).length === 1)) return { kind: 'key', text: keys.map(keyLabel).join('') };
        return keys[0] ? keyIcon(keys[0]) : { kind: 'none', text: 'C' };
      }
      const key = bindings.keysFor(keyBindings, glyph)[0];
      return key ? keyIcon(key) : { kind: 'none', text: glyph };
    }
    if (glyph === 'CSTICK') return { kind: 'stick', text: style === 'xbox' ? 'RS' : 'R' };
    const pad = bindings.padsFor(padBindings, glyph)[0];
    if (!pad) return { kind: 'none', text: glyph };
    return padIcon(style, pad);
  }

  function icons(style, keyBindings, padBindings, options) {
    return CELLS.map(glyph => icon(style, glyph, keyBindings, padBindings, options));
  }

  // ---- drawing (a CanvasRenderingContext2D; the browser side only)

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Text centred at (cx, cy), shrunk to fit width.
  function label(ctx, text, cx, cy, size, width, colour = '#fff') {
    let px = size;
    ctx.font = `700 ${px}px "Segoe UI", system-ui, sans-serif`;
    while (px > 9 && ctx.measureText(text).width > width) ctx.font = `700 ${--px}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = colour;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + px * 0.05);
  }

  function outlined(ctx, fill, stroke = '#0b0d10') {
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }

  function symbol(ctx, kind, cx, cy, colour) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 4.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (kind === 'cross') { ctx.moveTo(cx - 10, cy - 10); ctx.lineTo(cx + 10, cy + 10); ctx.moveTo(cx + 10, cy - 10); ctx.lineTo(cx - 10, cy + 10); }
    if (kind === 'circle') ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    if (kind === 'square') ctx.rect(cx - 10, cy - 10, 20, 20);
    if (kind === 'triangle') { ctx.moveTo(cx, cy - 12); ctx.lineTo(cx + 12, cy + 9); ctx.lineTo(cx - 12, cy + 9); ctx.closePath(); }
    ctx.stroke();
  }

  function drawIcon(ctx, item, x) {
    const cx = x + CELL / 2, cy = CELL / 2;
    ctx.save();
    switch (item.kind) {
    case 'face':
      ctx.beginPath(); ctx.arc(cx, cy, 27, 0, Math.PI * 2); outlined(ctx, item.fill);
      if (item.symbol) symbol(ctx, item.symbol, cx, cy, item.ink);
      else label(ctx, item.text, cx, cy, 34, 40);
      break;
    case 'shoulder':
      roundRect(ctx, x + 4, 14, CELL - 8, 36, 12); outlined(ctx, item.fill || '#3a4049');
      label(ctx, item.text, cx, cy, 26, CELL - 16);
      break;
    case 'trigger':
      ctx.beginPath(); ctx.moveTo(x + 8, 56); ctx.lineTo(x + 8, 20); ctx.quadraticCurveTo(x + 8, 6, cx, 6);
      ctx.quadraticCurveTo(x + CELL - 8, 6, x + CELL - 8, 20); ctx.lineTo(x + CELL - 8, 56); ctx.closePath();
      outlined(ctx, '#3a4049');
      label(ctx, item.text, cx, 34, 26, CELL - 20);
      break;
    case 'pill':
      roundRect(ctx, x + 3, 16, CELL - 6, 32, 16); outlined(ctx, '#3a4049');
      label(ctx, item.text, cx, cy, 22, CELL - 14);
      break;
    case 'stick':
      ctx.beginPath(); ctx.arc(cx, cy, 27, 0, Math.PI * 2); outlined(ctx, item.fill || '#3a4049');
      ctx.beginPath(); ctx.arc(cx, cy, 17, 0, Math.PI * 2); ctx.fillStyle = item.fill ? '#b8960f' : '#23272d'; ctx.fill();
      label(ctx, item.text, cx, cy, 22, 30);
      break;
    case 'dpad': {
      ctx.beginPath();
      ctx.moveTo(x + 24, 6); ctx.lineTo(x + 40, 6); ctx.lineTo(x + 40, 24); ctx.lineTo(x + 58, 24); ctx.lineTo(x + 58, 40);
      ctx.lineTo(x + 40, 40); ctx.lineTo(x + 40, 58); ctx.lineTo(x + 24, 58); ctx.lineTo(x + 24, 40); ctx.lineTo(x + 6, 40);
      ctx.lineTo(x + 6, 24); ctx.lineTo(x + 24, 24); ctx.closePath();
      outlined(ctx, '#3a4049');
      const at = { up: [cx, 15], down: [cx, 49], left: [x + 15, cy], right: [x + 49, cy] }[item.direction];
      ctx.beginPath(); ctx.arc(at[0], at[1], 6, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      break;
    }
    case 'key':
      roundRect(ctx, x + 4, 6, CELL - 8, CELL - 12, 9); outlined(ctx, '#f2f4f6', '#1b1f24');
      roundRect(ctx, x + 9, 10, CELL - 18, CELL - 24, 6); ctx.fillStyle = '#ffffff'; ctx.fill();
      if (item.arrow) {
        // pointing up, turned to its direction: a head and a stem
        ctx.translate(cx, 29);
        ctx.rotate({ up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[item.arrow]);
        ctx.beginPath();
        ctx.moveTo(0, -15); ctx.lineTo(13, 0); ctx.lineTo(5, 0); ctx.lineTo(5, 14); ctx.lineTo(-5, 14); ctx.lineTo(-5, 0); ctx.lineTo(-13, 0);
        ctx.closePath();
        ctx.fillStyle = '#1b1f24'; ctx.fill();
      } else label(ctx, item.text, cx, 29, item.text.length > 2 ? 22 : 30, CELL - 16, '#1b1f24');
      break;
    case 'empty':
      break;
    case 'mouse':
      // a side button sticks out of the mouse's left side: forward above back
      if (item.button === 'back' || item.button === 'forward') {
        roundRect(ctx, x + 10, item.button === 'forward' ? 28 : 42, 10, 12, 3); outlined(ctx, '#1b1f24', '#1b1f24');
      }
      roundRect(ctx, x + 16, 4, 32, 56, 16); outlined(ctx, '#f2f4f6', '#1b1f24');
      if (item.button === 'left' || item.button === 'right') {
        ctx.save(); roundRect(ctx, x + 16, 4, 32, 56, 16); ctx.clip();
        ctx.fillStyle = '#1b1f24'; ctx.fillRect(item.button === 'left' ? x + 16 : cx, 4, 16, 20);
        ctx.restore();
      }
      ctx.beginPath(); ctx.moveTo(cx, 6); ctx.lineTo(cx, 24); ctx.moveTo(x + 17, 24); ctx.lineTo(x + 47, 24);
      ctx.lineWidth = 3; ctx.strokeStyle = '#1b1f24'; ctx.stroke();
      if (item.button === 'middle') { roundRect(ctx, cx - 4, 8, 8, 13, 4); ctx.fillStyle = '#1b1f24'; ctx.fill(); }
      break;
    default:
      ctx.beginPath(); ctx.arc(cx, cy, 25, 0, Math.PI * 2); outlined(ctx, '#7b828c');
      label(ctx, item.text, cx, cy, 30, 40);
    }
    ctx.restore();
  }

  // One style's strip of icons on a new canvas (document.createElement): all of them, or the first count.
  function drawStrip(doc, style, keyBindings, padBindings, options, count = CELLS.length) {
    const canvas = doc.createElement('canvas');
    canvas.width = CELL * count;
    canvas.height = CELL;
    const ctx = canvas.getContext('2d');
    icons(style, keyBindings, padBindings, options).slice(0, count).forEach((item, index) => drawIcon(ctx, item, index * CELL));
    return canvas;
  }

  return { CELL, GLYPHS, DIRECTIONS, CELLS, STYLES, PAD_STYLES, DRAWN, normalizeStyle, normalizePad, keyLabel, icon, icons, drawStrip };
});
