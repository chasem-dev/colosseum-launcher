<p align="center">
  <a href="https://discord.gg/pkVwBrSwsZ"><img src="docs/discord-card.svg" alt="Join the Pokémon Colosseum Port Discord server"></a>
  <br>
  <a href="https://discord.gg/pkVwBrSwsZ"><img src="https://img.shields.io/badge/Discord-Join%20the%20server-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord"></a>
</p>

# Colosseum Launcher

<img width="1512" height="943" alt="image" src="https://github.com/user-attachments/assets/a513d488-33c6-4249-9792-5fb9c79a0b1b" />


Set up and play the native PC port of Pokémon Colosseum on **Windows, macOS, and Linux**. The launcher guides you through setup, downloads the tools it needs, and gives you one big **Play** button when you're ready.

**Bring your own game.** You need a disc image made from your own North American Pokémon Colosseum disc. The launcher does not include a game or disc image.

This is an unofficial fan project, not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company.

## Download

**[Download Colosseum Launcher from the latest release](https://github.com/chasem-dev/colosseum-launcher/releases/latest)**

| Your computer | Download |
| --- | --- |
| Windows | The `.exe` installer, or `Colosseum-Launcher-<version>-win-portable.exe` for the portable version |
| Mac — Intel or Apple Silicon | `Colosseum-Launcher-<version>-mac-universal.dmg` |
| Linux | The `.AppImage` |

The launcher requires a **64-bit computer** and an internet connection for setup. Required setup tools download automatically.

## Install

### Windows

Open the `.exe` installer and follow the steps, then open Colosseum Launcher.

**Portable version:** put `Colosseum-Launcher-<version>-win-portable.exe` in any folder, such as on a USB drive, and open it. Nothing is installed. The first time it runs, it creates a `Colosseum-Launcher-Portable` folder next to the `.exe` and keeps everything there: settings, setup files, build tools, the game, saves, and save backups. Portable versions don't update themselves: to update, put the new portable `.exe` in place of the old one, next to the same folder.

### Mac

1. Double-click the `.dmg`.
2. Drag **Colosseum Launcher.app** onto **Applications** in the window that opens.
3. Eject the disk image, then open Colosseum Launcher from Applications.

### Linux

Download the `.AppImage`, allow it to run as a program in your file manager's permissions settings, then open it.

## Set up your game

The launcher walks you through three steps:

1. **Download setup files.** Use the suggested location, or choose a different folder before downloading.
2. **Choose disc image.** Select a copy of your own original North American Pokémon Colosseum disc: **GC6E01, revision 0**. Supported files are `.iso` and `.gcm`. Compressed formats (CISO, RVZ, GCZ) need converting to ISO first, which Dolphin does with **Convert File**. The bonus disc is not the game.
3. **Begin setup.** The launcher downloads HD textures and builds the game on your computer. This first setup can take a while.

On Mac, setup may ask you to install Apple's Command Line Tools and, on Apple Silicon, Rosetta. Follow **Mac setup help** in the launcher. The game is an x86-64 program: its code needs memory below 4 GiB, which macOS never gives an Apple Silicon program, so Rosetta runs it there.

The progress bar shows what's happening. **View build log** opens more detail; closing that view keeps setup running. When setup finishes, press **Play**.

## Play and change settings

After setup, the main screen is just **Play** and the tabs above it.

- **Gameplay** skips the movies and chooses how the game's text is drawn.
- **Display** has the screen format, fullscreen, frame rate (30, 60 or 120 fps) and V-Sync.
- **Graphics** has presets (Low, Medium, High, Ultra and Steam Deck), the renderer (Vulkan, or OpenGL), picture sharpness up to 4×, anti-aliasing, filtering, upscaling and the HD textures.
- **Controls** sets the keys and controller buttons for each GameCube button, and the sticks, triggers and rumble.
- **Manage game** has game updates, rebuilding, the setup folder and disc file, and space cleanup.
- **Launcher** has dark mode, automatic updates, crash reports and your launcher, game and tool versions for support.

The defaults are **HD textures on**, **4×** picture sharpness, **60 fps** and a picture **as wide as the window**. Changes take effect the next time you start the game.

120 fps is optional and works on any display. It needs a faster computer, and a 120 Hz or faster display shows its full benefit. The game runs at its normal speed at every frame rate.

The launcher also works with a game controller: move with the left stick or d-pad and press **A** to select, **B** to go back and **Start** for Settings. The launcher ignores the controller while the game is running.

In the game, hold **L + R** (Q + E on the keyboard) to fast-forward at 4×, and **A** skips a movie.

### Controllers

Any controller SDL knows works: Xbox, PlayStation, Switch and more. GameCube controllers on a USB adapter in Wii U mode are read directly; **Settings → Controls** shows one when it is plugged in, and on Linux offers to add the udev rule it needs. In Battle Mode each controller is the next free player as it is plugged in.

### HD textures

HD textures are **on by default for first-time setup**: all 7,498 of the game's textures upscaled 4×, about **2 GB to download** and **2 GB installed**, with 4 GB free needed during setup. They are checked against a pinned SHA-256 before they are used, and a download that stops continues where it was. Turn them off in **Settings → Graphics**.

**Custom textures:** packs made for Dolphin's Load Custom Textures work unchanged. Put them in the folder **Open custom textures folder** opens. They win over the HD textures, and work with HD textures off.

### Updates

When a game update is ready, the main button becomes **Update & play**. Your current game stays available until the new setup succeeds. The **▾** beside it has **Update only** and **Play now**.

Launcher updates download automatically when **Update automatically** is on and install when you quit. After an update, What's new opens once to show what changed.

### Join the Beta

Beta has the newest launcher and the newest game before they are released, and it is for testing, so it may break. Open **Settings → Launcher** and set **Launcher updates** to **Beta**. To leave, set it back to **Stable**. Portable launchers don't have this setting.

### Add to Steam

On Windows and Linux, **Add to Steam** on the main screen adds the game to your Steam library as a non-Steam game, with artwork from [SteamGridDB](https://www.steamgriddb.com), so it starts from Big Picture and Game Mode. The artwork is not part of the launcher: it downloads when you choose Add to Steam and is saved only in Steam's artwork folder. Steam closes for a moment while the launcher saves its shortcut. Your other non-Steam games stay as they are, and the launcher keeps a copy of Steam's list from before.

Turn on **Skip Launcher** to have Steam start the game straight away. On a Steam Deck, the **Steam Deck** preset under **Settings → Graphics** suits its screen.

### Start the game from Steam or a shortcut

**Skip Launcher** adds `--play` to the shortcut's launch options, and you can add it to any shortcut yourself. `--play` never downloads or builds anything. If the game needs setup, an update (with **Update automatically** on) or HD textures, or if it closes with an error, the launcher opens instead so you can see why.

### Crash reports

If the game crashes, it saves a report on your computer. **Settings → Launcher → Crash reports** copies the newest one, ready to paste into a bug report, or opens the folder. The launcher never sends a report anywhere.

### Saved games and backups

The launcher keeps your save location when you update or rebuild the game, and makes dated backups before and after playing, and before game updates or cleanup. The memory card is `colo-port/card-a` in your user data folder (`%APPDATA%` on Windows, `~/.local/share` elsewhere).

The **Saves** tab backs up saves, opens the backup folder and restores a backup, backing up your current saves first. Backups are stored in **Colosseum Launcher Backups** in your home folder.

To carry on from a save you played in Dolphin, export it as a `.gci` file (North American version), then drop it on **Import a Dolphin save** in the **Saves** tab. Your current saves are backed up first, and the `.gci` file is left as it is.

### Privacy

The launcher sends nothing about you. It talks to GitHub and the port's GitLab for updates, the setup files and the HD textures. Your disc image never leaves your computer.

## Need help?

Open the activity log with **Activity log** in the status bar, choose **Copy log**, and [open an issue](https://github.com/chasem-dev/colosseum-launcher/issues/new/choose) with it. Crash reports are kept in `colo-port/crashes` in your state folder (`%LOCALAPPDATA%` on Windows, `~/.local/state` elsewhere).

## For developers

### What it builds

The game is [pokemon-colosseum](https://git.softwareauralabs.com/chase/pokemon-colosseum) (the port, on GitLab), compiled from the [pkmn-colosseum](https://github.com/chasem-dev/pkmn-colosseum) decompilation, with the renderer's sources from [sms-pc-port](https://github.com/chasem-dev/sms-pc-port). `src/game-release.json` pins all of them to exact commits; the game folder holds the port with `deps/pkmn-colosseum` and `deps/sms-pc-port` inside it. The launcher only reads those repositories: its own changes to the port, for its private toolchain and for paths with spaces, are `scripts/port-launcher.patch`, applied to the checkout. `scripts/build-colosseum.sh` runs the port's own `build.sh` there. No game data is in any of those repositories, and the build needs none: the player's disc is read when the game runs.

The launcher is built on [SMS Launcher](https://github.com/chasem-dev/sms-launcher)'s setup: the same three steps, private toolsets and release pipeline, without that game's extras.

### Run locally

```sh
npm ci
npm start
```

Node 22.12 or newer.

### Test and package

```sh
npm test
npm run dist -- --linux --x64     # or --win --x64, --mac --universal
```

`node scripts/smoke-build-tools.js` downloads the pinned tools and builds the game as a player's launcher does, from a folder with spaces in its name, then starts it far enough to ask for its disc. **Game build** (`game-build.yml`) runs it on Linux, Windows, and Intel and Apple Silicon Macs.

### Build tools

See [docs/build-tools.md](docs/build-tools.md).

**Your own MSYS2 (Windows, advanced).** Set the environment variable `COLO_MSYS2_ROOT` to an MSYS2 folder (the one containing `usr` and `mingw64`) and restart the launcher. It then uses that MSYS2 for every build and never downloads its own Windows tools. This is for setups the prepared tools cannot run on. Install the packages from MinGW64: `pacman -S --needed mingw-w64-x86_64-gcc mingw-w64-x86_64-cmake mingw-w64-x86_64-SDL2 mingw-w64-x86_64-ninja mingw-w64-x86_64-python patch git rsync curl unzip`. The game's build downloads llvm-mingw into the game folder for its clang. To use another clang 19 or newer, set `COLO_CLANG` to the command (such as `"C:/llvm/bin/clang-19.exe"`) and `COLO_CLANG_INC` to its headers (such as `C:/llvm/lib/clang/19/include`). Unset `COLO_MSYS2_ROOT` to go back to the prepared tools.

### Build caches

Every game version builds in a folder of its own, so a build keeps what it compiled for the next. The game's units go through the port's `tools/unit_cache.py`, keyed on the preprocessed source, flags, symbol tables and tool versions, and the renderer through `ccache`. Results name no path of the build, so they hold in any folder. They live in `compiler-cache` in the launcher's data folder, trimmed to about 2.5 GB, and **Free up space** clears them. A failed build through them is tried once without. **Game build** keeps the same caches between CI runs (`COLO_COMPILER_CACHE_DIR`). A pull request or Beta also skips the build on a system where the exact same inputs already built and started: the game's pins, the tools, the launcher code that builds it and the workflow. Beta's game version names the day, so Beta still builds on each system once a day. Weekly runs and releases always build.

### Versions and releases

Every push to `main` also rebuilds the Beta (`refresh-beta.yml`, `build.yml`), which checks hourly for new commits on the port's branch. A pull request becomes a preview when **Build launcher** is run by hand with its number. **Game source** under Manage game builds from another port or decomp for testing.

Each published Beta is announced in Discord when the `DISCORD_BETA_WEBHOOK` repository secret holds a channel webhook URL (in Discord: the channel's **Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL**, then `gh secret set DISCORD_BETA_WEBHOOK`). The message has the launcher and game versions, links to the release and both commits, and the notes added to Beta in `changelog.json` since the last Beta (all of them if the last Beta's notes can't be read). Without the secret, or if Discord is unreachable, Beta still publishes.

Pushing a higher `version` in `package.json` to `main` releases it: `release.yml` makes the tag and a draft, packages all three systems and attaches the tool archives while it requires the pinned game to build everywhere (`game-build.yml`), then publishes. That build is skipped when the pull request merged for the release already passed it on every system with exactly the same files, so let its checks finish before merging for a faster release.

`npm run update:game` selects the newest commit of the port's branch and the decomp and renderer commits it pins, bumps the version and drafts the changelog. See [AGENTS.md](AGENTS.md) for the changelog's rules.

### Launcher updates and Mac signing

Updates come from this repository's releases through `electron-updater`. Mac updates need every release signed with one certificate: `scripts/make-mac-cert.sh` makes a self-signed one, and the repository's `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` secrets hold it. Keep its folder: a new certificate breaks updates for every install. The app is not notarized, so macOS asks to confirm the first time it opens.
