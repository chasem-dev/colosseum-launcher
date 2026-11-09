'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const python = ['python3', 'python'].find(name => spawnSync(name, ['--version']).status === 0);
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'install-textures.py');

// A pack laid out as the release is: mods/textures/<folder>/tex1_*.png and a read-me beside them.
function pack(directory) {
  const file = path.join(directory, 'pack.zip');
  const code = `import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('README-texture-pack.txt', 'read me')
    z.writestr('mods/', '')
    z.writestr('mods/textures/colo-upscale-4x/tex1_8x8_a_1.png', 'first' * 4000)
    z.writestr('mods/textures/colo-upscale-4x/tex1_8x8_b_1.png', 'second' * 4000)
`;
  assert.equal(spawnSync(python, ['-c', code, file]).status, 0);
  return fs.readFileSync(file);
}

function serve(t, handler) {
  const server = http.createServer(handler);
  t.after(() => server.close());
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/pack.zip`)));
}

function install(textures, url, bytes, sha256 = crypto.createHash('sha256').update(bytes).digest('hex')) {
  return new Promise(resolve => {
    const child = spawn(python, ['-I', SCRIPT, textures, url, sha256, String(bytes.length), 'colo-upscale-4x']);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('close', code => resolve({ code, output }));
  });
}

const options = { skip: !python && 'Python is not installed.' };

test('the pack is downloaded, checked and unpacked, with its marker written last', options, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'colo textures-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = pack(directory);
  const url = await serve(t, (_request, response) => { response.setHeader('Content-Length', bytes.length); response.end(bytes); });
  const textures = path.join(directory, 'mods', 'textures');
  const { code, output } = await install(textures, url, bytes);
  assert.equal(code, 0, output);
  assert.match(output, /Installed 2 textures/);
  const folder = path.join(textures, 'colo-upscale-4x');
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.release', 'tex1_8x8_a_1.png', 'tex1_8x8_b_1.png']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, '.release'), 'utf8')).sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(fs.readdirSync(textures), ['colo-upscale-4x'], 'the download is gone');
});

test('a dropped download continues from where it stopped', options, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'colo textures-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = pack(directory);
  const ranges = [];
  const url = await serve(t, (request, response) => {
    const start = Number(request.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
    ranges.push(start);
    response.writeHead(start ? 206 : 200, { 'Content-Length': bytes.length - start });
    if (ranges.length === 1) { response.write(bytes.subarray(0, 1000)); setTimeout(() => response.destroy(), 50); }
    else response.end(bytes.subarray(start));
  });
  const { code, output } = await install(path.join(directory, 'textures'), url, bytes);
  assert.equal(code, 0, output);
  assert.equal(ranges[1], 1000);
  assert.match(output, /Installed 2 textures/);
});

test('a pack that fails its checksum installs nothing', options, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'colo textures-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = pack(directory);
  const url = await serve(t, (_request, response) => { response.setHeader('Content-Length', bytes.length); response.end(bytes); });
  const textures = path.join(directory, 'textures');
  const { code, output } = await install(textures, url, bytes, 'a'.repeat(64));
  assert.notEqual(code, 0);
  assert.match(output, /SHA-256/);
  assert.deepEqual(fs.readdirSync(textures), []);
});

test("a stopped download of an earlier pack is deleted, and this pack's own is kept", options, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'colo textures-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = pack(directory);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const ranges = [];
  const url = await serve(t, (request, response) => {
    const start = Number(request.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
    ranges.push(start);
    response.writeHead(start ? 206 : 200, { 'Content-Length': bytes.length - start });
    response.end(bytes.subarray(start));
  });
  const textures = path.join(directory, 'textures');
  fs.mkdirSync(textures);
  fs.writeFileSync(path.join(textures, 'pack-0ed26c9bd525.zip.part'), 'an earlier pack, stopped');
  fs.writeFileSync(path.join(textures, `pack-${sha256.slice(0, 12)}.zip.part`), bytes.subarray(0, 1000));
  fs.writeFileSync(path.join(textures, 'notes.txt'), 'the player\'s');
  const { code, output } = await install(textures, url, bytes, sha256);
  assert.equal(code, 0, output);
  assert.deepEqual(ranges, [1000], 'this pack continued from its own part');
  assert.deepEqual(fs.readdirSync(textures).sort(), ['colo-upscale-4x', 'notes.txt']);
});
