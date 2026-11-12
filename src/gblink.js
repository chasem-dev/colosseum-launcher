'use strict';

// A GB-Link USB adapter (https://github.com/GB-Link): the player's own Game Boy
// Advance and Game Pak on the GBA socket, through the adapter and a GBC link
// cable. The game opens the adapter's serial port itself (the port's
// host/gba_gblink.c) and switches it to its GameCube mode, so this only finds a
// plugged-in adapter for Settings → Game Boy Advance and says whether the game
// may open it. On Linux the serial port is the dialout group's, so a udev rule
// lets the logged-in user open it, as GB-Link's own setup script does, and
// keeps ModemManager from probing it.
const fs = require('node:fs');
const path = require('node:path');

// The firmware's USB IDs: pid.codes' 1209:b011 from firmware 3.0.0, Zephyr's
// vendor ID and GB-Link's product before; players have adapters with either.
const IDS = [{ vendor: 0x1209, product: 0xb011 }, { vendor: 0x2fe3, product: 0x000a }];
const isAdapter = (vendor, product) => IDS.some(id => id.vendor === vendor && id.product === product);
const hex4 = n => n.toString(16).padStart(4, '0');
const RULES_FILE = '/etc/udev/rules.d/51-gblink-colosseum.rules';
const RULES = [
  '# GB-Link USB adapters (1209:b011, and 2fe3:000a before firmware 3.0.0), for Colosseum Launcher: the game opens their serial port',
  ...IDS.map(id => `SUBSYSTEM=="tty", ATTRS{idVendor}=="${hex4(id.vendor)}", ATTRS{idProduct}=="${hex4(id.product)}", TAG+="uaccess", ENV{ID_MM_DEVICE_IGNORE}="1"`),
  ''
].join('\n');

const read = (fsys, file) => { try { return fsys.readFileSync(file, 'utf8').trim(); } catch { return null; } };
const list = (fsys, dir) => { try { return fsys.readdirSync(dir); } catch { return []; } };
const hex = text => text == null ? NaN : parseInt(text, 16);
const usable = (fsys, file) => { try { fsys.accessSync(file, fs.constants.R_OK | fs.constants.W_OK); return true; } catch { return false; } };

// Linux, from sysfs: the adapter's serial port (/dev/ttyACM*), and whether this
// user may open it.
function linuxStatus({ fsys = fs, sys = '/sys', dev = '/dev' } = {}) {
  for (const name of list(fsys, path.join(sys, 'class/tty')).filter(name => name.startsWith('ttyACM')).sort()) {
    // `device` is a link to the USB interface; the device with the IDs is the directory above it (resolved,
    // as path.join would only drop the link's name)
    let usb;
    try { usb = path.dirname(fsys.realpathSync(path.join(sys, 'class/tty', name, 'device'))); } catch { continue; }
    if (!isAdapter(hex(read(fsys, path.join(usb, 'idVendor'))), hex(read(fsys, path.join(usb, 'idProduct'))))) continue;
    const port = path.join(dev, name);
    const readable = usable(fsys, port);
    return { present: true, port, readable, fix: readable ? null : 'udev' };
  }
  return { present: false };
}

// Windows: the adapter's serial port from `Get-CimInstance Win32_PnPEntity`
// (WINDOWS_QUERY): its name ends with the port, "USB Serial Device (COM5)".
// Windows' own driver opens it, so it is ready when it is working.
const WINDOWS_QUERY = "Get-CimInstance Win32_PnPEntity -Filter \"" +
  IDS.map(id => `DeviceID LIKE 'USB\\\\VID_${hex4(id.vendor).toUpperCase()}&PID_${hex4(id.product).toUpperCase()}%'`).join(' OR ') + "\" | " +
  "ForEach-Object { \"$($_.Name)|$($_.Status)\" }";

function windowsStatus(output) {
  const lines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const [name = '', status = ''] = line.split('|');
    const port = /\((COM\d+)\)\s*$/i.exec(name);
    if (!port) continue;   // the adapter's other interface (its WebUSB one)
    const ok = !status || /^ok$/i.test(status);
    return { present: true, port: port[1].toUpperCase(), readable: ok, status, fix: ok ? null : 'driver' };
  }
  return lines.length ? { present: true, readable: false, fix: 'driver' } : { present: false };
}

// macOS: the adapter in `ioreg -p IOUSB -l -w0` output. Its serial port needs no
// driver or permission there.
function macStatus(ioreg) {
  const present = String(ioreg || '').split(/\+-o /).some(block => IDS.some(id =>
    new RegExp(`"idVendor" = ${id.vendor}\\b`).test(block) && new RegExp(`"idProduct" = ${id.product}\\b`).test(block)));
  return present ? { present: true, readable: true, fix: null } : { present: false };
}

// The command that installs the udev rule as root through pkexec (which asks
// for the password) and applies it to the adapter already plugged in. The rule
// text goes in as an argument, not through the shell.
function allowCommand() {
  const script = 'printf "%s" "$1" > "$2" && udevadm control --reload-rules && udevadm trigger --action=change --subsystem-match=tty';
  return { command: 'pkexec', args: ['/bin/sh', '-c', script, 'sh', RULES, RULES_FILE] };
}

// The same, to paste into a terminal.
function terminalCommand() {
  return `sudo tee ${RULES_FILE} > /dev/null <<'EOF'\n${RULES}EOF\n` +
    'sudo udevadm control --reload-rules && sudo udevadm trigger --action=change --subsystem-match=tty';
}

module.exports = { IDS, RULES, RULES_FILE, WINDOWS_QUERY, linuxStatus, windowsStatus, macStatus, allowCommand, terminalCommand };
