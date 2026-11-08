'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { activityFromLine, cleanOutputLine, crashReason, createActivityReader, createLineReader, failureReason } = require('../src/progress');

test('shows real percentages for build and source downloads', () => {
  assert.deepEqual(activityFromLine('[ 42%] Building C object'), { detail: 'Building your game', percent: 42 });
  assert.deepEqual(activityFromLine('Receiving objects:  76% (123/160)'), { detail: 'Downloading files', percent: 76 });
  assert.deepEqual(activityFromLine('-- Configuring done'), { detail: 'Getting your game ready', percent: null });
});

test('uses Ninja completed steps on Windows and private Mac tools, including small incremental builds', () => {
  assert.deepEqual(activityFromLine('[735/2475] Building CXX object decomp/src/Camera/Camera.cpp.obj'),
    { detail: 'Building your game · 735 of 2,475 steps', percent: 29 });
  assert.deepEqual(activityFromLine('\x1b[2K\x1b[32m[2/3] Linking CXX executable sms.exe\x1b[0m'),
    { detail: 'Finishing the game build · 2 of 3 steps', percent: 66 });
  assert.deepEqual(activityFromLine('[3/3] Linking CXX executable sms'),
    { detail: 'Finishing the game build · 3 of 3 steps', percent: 100 });
  for (const invalid of ['[1/0] Building', '[4/3] Building', '[9007199254740992/9007199254740992] Building'])
    assert.equal(activityFromLine(invalid), null);
});

test('reads pipe chunks, carriage-return progress, split Unicode, and the final error line without loss', () => {
  const output = Buffer.from('\x1b[2K[1/3] Building CXX object Mario.cpp.obj\r\n[2/3] Building CXX object Café.cpp.obj\r[3/3] Linking sms.exe\nerror: setup failed');
  const lines = [];
  const reader = createLineReader(line => lines.push(line));
  for (const byte of output) reader.write(Buffer.from([byte]));
  reader.end();
  assert.deepEqual(lines, ['[1/3] Building CXX object Mario.cpp.obj', '[2/3] Building CXX object Café.cpp.obj',
    '[3/3] Linking sms.exe', 'error: setup failed']);
  assert.equal(activityFromLine(lines[1]).percent, 66);
  assert.equal(cleanOutputLine('\x1b]8;;https://example.com\x1b\\Camera.cpp\x1b]8;;\x1b\\'), 'Camera.cpp');
});

test('reports the texture installer\'s phases', () => {
  assert.deepEqual(activityFromLine('Checking the HD textures'), { detail: 'Checking HD textures', percent: null });
  assert.deepEqual(activityFromLine('Installing HD textures: 1500/7498'), { detail: 'Installing HD textures · 1,500 of 7,498', percent: 20 });
  assert.equal(activityFromLine('Installing HD textures: 9/3'), null);
  assert.deepEqual(activityFromLine('Installed 7498 textures'), { detail: 'HD textures installed', percent: 100 });
});

test('reports the Battle Revolution models\' phases', () => {
  assert.deepEqual(activityFromLine('Downloading the model tools: https://github.com/encounter/nod/releases/download/v2/nodtool'),
    { detail: 'Downloading the model tools', percent: null });
  assert.deepEqual(activityFromLine("Preparing the model tools: StarsMmd's Blender-Addon-Gamecube-Models"),
    { detail: 'Preparing the model tools', percent: null });
  assert.deepEqual(activityFromLine('Reading your Battle Revolution disc'), { detail: 'Reading your Battle Revolution disc', percent: null });
  assert.deepEqual(activityFromLine('Making models for 107 Pokémon'), { detail: 'Making Battle Revolution models', percent: 0 });
  assert.deepEqual(activityFromLine('Made 40 of 107 Pokémon'), { detail: 'Making Battle Revolution models · 40 of 107 Pokémon', percent: 37 });
  assert.deepEqual(activityFromLine('Made 107 of 107 Pokémon'), { detail: 'Making Battle Revolution models · 107 of 107 Pokémon', percent: 100 });
  assert.equal(activityFromLine('Made 9 of 3 Pokémon'), null);
  assert.equal(activityFromLine('#387 TURTWIG: base Treecko, 11 level-up moves (1 newer than Colosseum left out), 33 TM moves'), null);
});

test('the end of the port\'s build is its own phase', () => {
  assert.deepEqual(activityFromLine('game objs 1632 data syms 3335 stubs 28 fntab 7980'), { detail: 'Finishing setup', percent: null });
  assert.deepEqual(activityFromLine('linked /games/colosseum/build/colosseum'), { detail: 'Finishing setup', percent: null });
  assert.deepEqual(activityFromLine("Preparing the decomp's build"), { detail: "Preparing the game's source", percent: null });
  assert.deepEqual(activityFromLine('[1632/3264] IR /games/colosseum/build/mirror/src/game/fight.c'),
    { detail: 'Building your game · 1,632 of 3,264 steps', percent: 50 });
});

test('reports texture download bytes, handles unknown file sizes, and separates checksum checking', () => {
  assert.deepEqual(activityFromLine('Texture download: 500000000/1000000000 bytes'),
    { detail: 'Downloading HD textures · 500 MB of 1,000 MB', percent: 50 });
  assert.deepEqual(activityFromLine('Texture download: 1000000000/1000000000 bytes'),
    { detail: 'Downloading HD textures · 1,000 MB of 1,000 MB', percent: 100 });
  assert.deepEqual(activityFromLine('Texture download: 500000000/0 bytes'),
    { detail: 'Downloading HD textures · 500 MB downloaded', percent: null });
  assert.deepEqual(activityFromLine('Checking HD texture download'),
    { detail: 'Checking HD textures', percent: null });
  for (const invalid of ['Texture download: 4/3 bytes', 'Texture download: 9007199254740992/0 bytes'])
    assert.equal(activityFromLine(invalid), null);
});


test('failed tasks report the line that explains them', () => {
  assert.equal(failureReason([
    '-- SMS port: building -m64',
    'CMake Error at cmake/eclipse.cmake:17 (message):',
    "  SMS_ECLIPSE needs clang/clang++ (Eclipse's sources are written for clang)",
    'Call Stack (most recent call first):',
    '  CMakeLists.txt:410 (include)',
    '-- Configuring incomplete, errors occurred!'
  ]), "SMS_ECLIPSE needs clang/clang++ (Eclipse's sources are written for clang)");
  assert.equal(failureReason([
    '[12/900] Building CXX object a.obj',
    'FAILED: b.obj',
    "b.cpp:3:1: error: unknown type name 'foo'",
    '1 error generated.',
    'ninja: build stopped: subcommand failed.'
  ]), "b.cpp:3:1: error: unknown type name 'foo'");
  assert.equal(failureReason([
    '[3/900] Extracting sms.exe icon',
    'FAILED: [code=1] sms.ico C:/SMS/build/windows-64/sms.ico',
    'C:\\WINDOWS\\system32\\cmd.exe /C "python.exe tools/extract_icon.py --disc game.iso --ico sms.ico"',
    'disc image is truncated (read 0x56a98600+0x1fcaa)',
    'ninja: build stopped: subcommand failed.'
  ]), 'disc image is truncated (read 0x56a98600+0x1fcaa)');
  assert.equal(failureReason(['[1/2] Linking sms', 'FAILED: sms', 'c++ -o sms a.o', 'ninja: build stopped: subcommand failed.']),
    'FAILED: sms');
  assert.equal(failureReason(['Eclipse needs clang and clang++. Update the launcher, then try again.']),
    'Eclipse needs clang and clang++. Update the launcher, then try again');
  assert.equal(failureReason([]), '');
});

test('a crash is reported as a crash, not as the last warning the game printed', () => {
  // Windows: MSYS bash's report of a native crash, or the exception status itself.
  assert.equal(crashReason(2816, null, 'win32'), 'crashed with a memory access error');
  assert.equal(crashReason(2560, null, 'win32'), 'crashed with a memory access error');
  assert.equal(crashReason(0xC0000005, null, 'win32'), 'crashed with a memory access error');
  assert.equal(crashReason(-1073741819, null, 'win32'), 'crashed with a memory access error');
  // Linux: the re-raised signal. macOS: the game's 128 + signal exit.
  assert.equal(crashReason(null, 'SIGSEGV', 'linux'), 'crashed with a memory access error');
  assert.equal(crashReason(null, 'SIGABRT', 'linux'), 'crashed with an internal error');
  assert.equal(crashReason(139, null, 'darwin'), 'crashed with a memory access error');
  assert.equal(crashReason(138, null, 'darwin'), 'crashed with a memory access error');
  assert.equal(crashReason(135, null, 'linux'), 'crashed with a memory access error');
  for (const [code, signal, platform] of [[1, null, 'win32'], [2, null, 'linux'], [256, null, 'win32'], [139, null, 'win32'],
    [null, 'SIGTERM', 'linux'], [0, null, 'darwin'], [130, null, 'darwin']])
    assert.equal(crashReason(code, signal, platform), null);
});


test('the port\'s three ninja runs share one bar that only moves forward', () => {
  const read = require('../src/progress').createActivityReader();
  const percent = line => read(line)?.percent;
  assert.equal(percent('[1632/3264] IR a.c'), 30);
  assert.equal(percent('[3264/3264] OBJ b.o'), 60);
  assert.equal(percent('[207/3173] IR a.c'), 61);
  assert.equal(percent('[3173/3173] OBJ b.o'), 90);
  assert.equal(percent('[1/87] Building CXX object x.o'), 90);
  assert.equal(percent('[87/87] Linking CXX static library libsms_gx.a'), 100);
  assert.deepEqual(read('[10/87] Building CXX object y.o'), { detail: 'Building your game', percent: 100 });
  // what isn't ninja's goes through as it was
  assert.deepEqual(read('Texture download: 500000000/1000000000 bytes'), { detail: 'Downloading HD textures · 500 MB of 1,000 MB', percent: 50 });
});
