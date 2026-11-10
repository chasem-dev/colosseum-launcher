'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gblink = require('../src/gblink');

// A /sys and /dev laid out as Linux has them: /sys/class/tty/<name> links into the USB device's
// interface, whose parent directory has the device's IDs.
function linuxTree({ vendor = '2fe3', product = '000a', allowed = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gblink-'));
  const sys = path.join(root, 'sys'), dev = path.join(root, 'dev');
  const write = (file, text, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); if (mode != null) fs.chmodSync(file, mode); };
  const port = (name, usb, v, p, mode) => {
    const usbDir = path.join(sys, 'devices/pci0000:00/usb1', usb);
    write(path.join(usbDir, 'idVendor'), `${v}\n`);
    write(path.join(usbDir, 'idProduct'), `${p}\n`);
    const tty = path.join(usbDir, `${usb}:1.0/tty/${name}`);
    fs.mkdirSync(tty, { recursive: true });
    fs.symlinkSync(path.join(usbDir, `${usb}:1.0`), path.join(tty, 'device'));
    fs.mkdirSync(path.join(sys, 'class/tty'), { recursive: true });
    fs.symlinkSync(tty, path.join(sys, 'class/tty', name));
    write(path.join(dev, name), '', mode);
  };
  port('ttyACM0', '1-2', '2341', '0043', 0o600);       // an Arduino
  port('ttyACM1', '1-4', vendor, product, allowed ? 0o600 : 0o000);
  write(path.join(sys, 'class/tty/ttyS0/dev'), '4:64\n');
  return { sys, dev, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const asRoot = process.getuid?.() === 0;
// The tree has sysfs's names (pci0000:00, 1-4:1.0) and symlinks, which a Windows folder can't hold; linuxStatus runs only on Linux.
const noSysfs = process.platform === 'win32';

test('Linux: no adapter plugged in', { skip: noSysfs }, () => {
  const tree = linuxTree({ vendor: '2e8a', product: '0003' });
  try { assert.deepEqual(gblink.linuxStatus(tree), { present: false }); }
  finally { tree.done(); }
});

test('Linux: the adapter\'s port, past other USB serial devices', { skip: noSysfs }, () => {
  const tree = linuxTree({ allowed: true });
  try {
    const status = gblink.linuxStatus(tree);
    assert.equal(status.present, true);
    assert.equal(status.port, path.join(tree.dev, 'ttyACM1'));
    assert.equal(status.readable, true);
    assert.equal(status.fix, null);
  } finally { tree.done(); }
});

test('Linux: a port this user may not open needs the udev rule', { skip: asRoot || noSysfs }, () => {
  const tree = linuxTree();
  try {
    const status = gblink.linuxStatus(tree);
    assert.equal(status.readable, false);
    assert.equal(status.fix, 'udev');
  } finally { tree.done(); }
});

test('the udev rule: the adapter\'s serial port, for the logged-in user, not probed by ModemManager', () => {
  assert.match(gblink.RULES, /SUBSYSTEM=="tty", ATTRS\{idVendor\}=="2fe3", ATTRS\{idProduct\}=="000a", TAG\+="uaccess", ENV\{ID_MM_DEVICE_IGNORE\}="1"/);
  const { command, args } = gblink.allowCommand();
  assert.equal(command, 'pkexec');
  assert.equal(args[4], gblink.RULES);       // as an argument, not through the shell
  assert.equal(args[5], gblink.RULES_FILE);
  assert.match(gblink.terminalCommand(), /^sudo tee \/etc\/udev\/rules\.d\/51-gblink-colosseum\.rules/);
});

test('Windows: the COM port from the device\'s name, past its other interface', () => {
  assert.deepEqual(gblink.windowsStatus(''), { present: false });
  assert.deepEqual(gblink.windowsStatus('GBLink USB|OK\r\nUSB Serial Device (COM7)|OK\r\n'),
    { present: true, port: 'COM7', readable: true, status: 'OK', fix: null });
  const broken = gblink.windowsStatus('USB Serial Device (COM3)|Error\r\n');
  assert.equal(broken.readable, false);
  assert.equal(broken.fix, 'driver');
  assert.equal(gblink.windowsStatus('GBLink USB|OK').fix, 'driver');
});

test('macOS: the adapter in ioreg\'s USB plane', () => {
  const block = (vendor, product) => `+-o GBLink USB@01100000  <class IOUSBHostDevice>\n    "idProduct" = ${product}\n    "idVendor" = ${vendor}\n`;
  assert.deepEqual(gblink.macStatus(block(1452, 591)), { present: false });
  assert.deepEqual(gblink.macStatus(block(1452, 591) + block(0x2fe3, 0x000a)), { present: true, readable: true, fix: null });
});
