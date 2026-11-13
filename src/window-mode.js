'use strict';

// How the launcher's window was left, so the next start opens the same way:
// full screen (F11), maximized, or a normal window.
const MODES = ['normal', 'maximized', 'fullscreen'];

function normalize(value) {
  return MODES.includes(value) ? value : 'normal';
}

// Full screen wins: a maximized window put in full screen reports both.
function modeOf(target) {
  if (!target) return 'normal';
  if (target.isFullScreen()) return 'fullscreen';
  return target.isMaximized() ? 'maximized' : 'normal';
}

module.exports = { MODES, normalize, modeOf };
