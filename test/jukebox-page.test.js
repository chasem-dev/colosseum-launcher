'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'jukebox-page.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

test('every element the Jukebox page script looks up is in the page', () => {
  const ids = [...new Set([...script.matchAll(/\$\('([a-z-]+)'\)/g)].map(match => match[1]))];
  assert.ok(ids.length > 10);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `index.html has no #${id}`);
});

test('the player sits under every page, not inside the Jukebox page, and starts hidden', () => {
  const page = html.slice(html.indexOf('<section id="page-jukebox"'), html.indexOf('</section>', html.indexOf('<section id="page-jukebox"')));
  for (const id of ['jukebox-dock', 'jukebox-toggle', 'jukebox-close', 'jukebox-volume']) assert.ok(!page.includes(`id="${id}"`), `${id} is inside the Jukebox page`);
  assert.match(html, /<section id="jukebox-dock"[^>]* hidden>/);
  assert.ok(html.indexOf('</main>') < html.indexOf('id="jukebox-dock"') && html.indexOf('id="jukebox-dock"') < html.indexOf('id="activity-log"'));
});

test('the music is stopped when the game starts, and leaving the page does not stop it', () => {
  assert.match(preload, /onJukeboxStop/);
  assert.match(main, /async function play\([^)]*\) \{\s*broadcast\('jukebox-stop'\)/);
  assert.match(script, /onJukeboxStop\(close\)/);
  assert.match(script, /hide\(\) \{\}/);
});

test('a long song name wraps in its button instead of being cut off', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'style.css'), 'utf8');
  const rule = css.match(/\.jukebox-track \{[^}]*\}/)[0];
  assert.match(rule, /white-space: normal/);          // buttons are nowrap by default
  assert.match(script, /button\.title = track\.name/);
});

test('every button in the player does something when pressed', () => {
  const dock = html.slice(html.indexOf('id="jukebox-dock"'), html.indexOf('</section>', html.indexOf('id="jukebox-dock"')));
  const buttons = [...dock.matchAll(/<button id="([^"]+)"/g)].map(match => match[1]);
  assert.ok(buttons.includes('jukebox-star'));
  for (const id of buttons) assert.match(script, new RegExp(`\\$\\('${id}'\\)\\.addEventListener\\('click'`), `${id} has no click handler`);
});
