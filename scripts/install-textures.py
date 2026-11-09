#!/usr/bin/env python3
"""Download the HD texture pack, check it and unpack it.

Usage: install-textures.py TEXTURES_FOLDER URL SHA256 SIZE PACK_FOLDER

A download that stops continues from where it was the next time. The pack goes to
TEXTURES_FOLDER/PACK_FOLDER, which is complete once its .release marker exists: an unpack that
stops leaves the marker out, and the launcher sets the pack up again.
"""
import hashlib, json, os, shutil, sys, time, urllib.error, urllib.request, zipfile

CHUNK = 1 << 20


def say(text):
    print(text, flush=True)


def download(url, part, size):
    for attempt in range(1, 6):
        have = os.path.getsize(part) if os.path.exists(part) else 0
        if have >= size: return
        request = urllib.request.Request(url, headers={'User-Agent': 'colosseum-launcher', 'Range': 'bytes=%d-' % have})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                if have and response.status != 206: have = 0   # the server sent the whole file
                with open(part, 'ab' if have else 'wb') as out:
                    last = 0
                    while True:
                        data = response.read(CHUNK)
                        if not data: break
                        out.write(data)
                        have += len(data)
                        if time.monotonic() - last > 0.5:
                            last = time.monotonic()
                            say('Texture download: %d/%d bytes' % (have, size))
            say('Texture download: %d/%d bytes' % (have, size))
            if have >= size: return
        except urllib.error.HTTPError as error:
            if error.code == 416: os.remove(part)   # what is there is not the start of this file
            elif error.code < 500: raise SystemExit('The HD texture download returned HTTP %d.' % error.code)
        except OSError as error:
            say('The HD texture download stopped (%s). Trying again.' % error)
        time.sleep(attempt * 3)
    raise SystemExit('The HD texture download kept stopping. Check your connection and try again: it continues where it stopped.')


def main():
    textures, url, sha256, size, folder = sys.argv[1:6]
    size = int(size)
    os.makedirs(textures, exist_ok=True)
    part = os.path.join(textures, 'pack-%s.zip.part' % sha256[:12])
    # A stopped download of an earlier pack is never finished once the launcher pins a newer one.
    for name in os.listdir(textures):
        if name.startswith('pack-') and name.endswith('.zip.part') and name != os.path.basename(part):
            os.remove(os.path.join(textures, name))
    target = os.path.join(textures, folder)
    prefix = 'mods/textures/%s/' % folder
    say('Checking HD texture download')
    download(url, part, size)
    say('Checking the HD textures')
    digest = hashlib.sha256()
    with open(part, 'rb') as data:
        for block in iter(lambda: data.read(CHUNK), b''): digest.update(block)
    if digest.hexdigest() != sha256:
        os.remove(part)
        raise SystemExit('The HD texture download failed its SHA-256 check. Try again.')
    shutil.rmtree(target, ignore_errors=True)
    os.makedirs(target)
    with zipfile.ZipFile(part) as pack:
        names = [item for item in pack.infolist() if item.filename.startswith(prefix) and not item.is_dir()]
        if not names: raise SystemExit('The HD texture pack holds no textures.')
        for count, item in enumerate(names, 1):
            name = os.path.basename(item.filename)   # the pack is flat: no path leaves the folder
            with pack.open(item) as source, open(os.path.join(target, name), 'wb') as out:
                shutil.copyfileobj(source, out, CHUNK)
            if count % 100 == 0 or count == len(names):
                say('Installing HD textures: %d/%d' % (count, len(names)))
    with open(os.path.join(target, '.release'), 'w') as marker:
        json.dump({'sha256': sha256}, marker)
    os.remove(part)
    say('Installed %d textures' % len(names))


main()
