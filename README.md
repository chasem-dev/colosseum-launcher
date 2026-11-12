<p align="center">
  <img src="build/icon.svg" width="112" height="112" alt="">
</p>

<h1 align="center">Colosseum Launcher</h1>

<p align="center">
  <a href="https://github.com/chasem-dev/colosseum-launcher/releases/latest"><img src="docs/download-button.svg" width="248" height="60" alt="Download Colosseum Launcher from the latest release"></a>&nbsp;&nbsp;<a href="https://discord.gg/pkVwBrSwsZ"><img src="docs/discord-button.svg" width="248" height="60" alt="Join the Pokémon Colosseum Port Discord server"></a>
</p>

<img width="1512" height="943" alt="image" src="https://github.com/user-attachments/assets/a513d488-33c6-4249-9792-5fb9c79a0b1b" />


Set up and play the native PC port of Pokémon Colosseum, and of Pokémon XD: Gale of Darkness, on **Windows, macOS, and Linux**. The launcher guides you through setup, downloads the tools it needs, and gives you one big **Play** button when you're ready.

**Bring your own game.** You need a disc image made from your own North American Pokémon Colosseum disc (or Pokémon XD disc, GXXE01, for XD). The launcher does not include a game or disc image.

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

For **Pokémon XD**, choose XD at the top of the Play page first. Each game has its own setup folder and disc, and both save to the same memory card. XD is early: it plays with the renderer, display, controller, widescreen, HD text, fast-forward and Skip movies settings, and Online; Colosseum's other extras stay hidden while XD is chosen.

On Mac, setup may ask you to install Apple's Command Line Tools. Follow **Mac setup help** in the launcher. The game is built for your Mac: on Apple Silicon, Beta's game is a native program that draws with Metal, with no Rosetta needed. Stable's game still runs through Rosetta, and setup asks for it.

The progress bar shows what's happening. **View build log** opens more detail; closing that view keeps setup running. When setup finishes, press **Play**.

## Play and change settings

After setup, the main screen is just **Play** and the tabs above it.

- **Gameplay** skips the movies and chooses how the game's text is drawn.
- **Display** has the screen format, fullscreen, frame rate (30 or 60 fps) and V-Sync.
- **Graphics** has presets (Low, Medium, High, Ultra and Steam Deck), the renderer (Vulkan or OpenGL, and Metal on Apple Silicon, where it is the default), picture sharpness up to 4×, anti-aliasing, filtering, upscaling, the HD textures and HD models.
- **Controls** sets the keys and controller buttons for each GameCube button, and the sticks, triggers and rumble.
- **Manage game** has game updates, rebuilding, the setup folder and disc file, and space cleanup.
- **Launcher** has dark mode, automatic updates, crash reports and your launcher, game and tool versions for support.

The defaults are **HD textures on**, **4×** picture sharpness, **60 fps** and a picture **as wide as the window**. Changes take effect the next time you start the game.

The launcher also works with a game controller: move with the left stick or d-pad and press **A** to select, **B** to go back and **Start** for Settings. The launcher ignores the controller while the game is running.

In the game, hold **L + R** (Q + E on the keyboard) to fast-forward at 4×, and **A** skips a movie. Under Settings → Gameplay, fast-forward can instead turn on with one press and off with the next, and run at 2× to 8×.

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

To carry on in Dolphin, choose **Export .gci file** in the **Saves** tab, then import the file in Dolphin's Memory Card Manager, or put it in Dolphin's GCI folder. Your save here isn't changed. A randomizer run keeps its team, but Dolphin plays the rest as the normal game, as only the port has the randomizer.

### Pokédex

The **Pokédex** tab shows every Pokémon on your disc, read from the disc itself: its 3D model, which you can turn and zoom, its motions, and any other looks it has, such as a shiny one. Each Pokémon says how you can get it. Those the game keeps out of reach carry a lock: **Battle only** for those trainers use but you can't catch, and **Hidden on disc** for those that are on the disc but never appear in the game.

### Pokémon packs

A Pokémon pack adds Pokémon of your own making to the game: new species, fakemon, or forms of the game's own, each with its own name, stats, types, abilities, moves and evolutions, and its own 3D model and sprites if you like. Press **Open Pokémon packs folder** in the Pokédex: each pack is a folder there, and each Pokémon a folder in it with a `pokemon.json`. Pack Pokémon show in the Pokédex after the ones they're based on. To play with one, pick it as a starter on a **New Game**, or let the randomizer choose it. [docs/pokemon-packs.md](docs/pokemon-packs.md) is the guide to making one.

### Later generations

Under **Settings → Gameplay**, two choices that go together or apart:

- **Battle rules**: Colosseum's (Generation 3), or Diamond and Pearl's (Generation 4), where each move is physical or special by itself rather than by its type, a sandstorm raises Rock types' Sp. Def, and the moves Diamond and Pearl changed play as they did there. An online room plays by the rules its host chose under **Rules**, whatever either player's setting.
- **Generation 4 Pokémon**: the 107 Pokémon from Turtwig to Arceus, with their stats, abilities, learnsets and evolutions, and the new moves Colosseum can play, in your game and the Pokédex. A new move plays as a move Colosseum has with the new move's own power, accuracy, PP, type and priority; moves with nothing close, such as Trick Room, are left out. Nothing in the game hands them out yet.

Their data is [Pokémon Showdown's](https://github.com/smogon/pokemon-showdown) (MIT), checked against Pokémon Battle Revolution's (`scripts/generation-data`). Until their assets are made, a Pokémon Colosseum has stands in for each one's looks and cry. **Battle Revolution assets** makes their models, icons and cries from your own Pokémon Battle Revolution disc, with no Blender: the game's `tools/pbr2pkx`, built on StarsMmd's Blender add-on for GameCube models. The cries are the disc's own, which the game plays when a Pokémon is sent out, faints or is looked at, as it plays its own Pokémon's.

### Randomizer

Under **Settings → Gameplay**, the randomizer swaps the game's Pokémon for others, chosen by a seed: your starters, Shadow Pokémon, trainers' Pokémon and gifts, each on its own switch. You can limit it to the generations you like, let it choose the Pokémon of your Pokémon packs too, keep Pokémon about as strong as the ones they replace, and leave legendaries out.

It starts with your next **New Game**, and the seed is kept inside that save. Fights stay the same when you lose and try again, and the run goes with the save through backups and imports. An existing save is never changed, and a run keeps its seed whatever the settings say later. Share a seed and the same choices to play the same run as a friend.

### Online battles

The **Online** tab is where you battle other players. Build a party first: **New party** opens the team builder, where you choose six from the Pokédex and give each its own set, as in Pokémon Showdown: four moves, a held item, its ability and nature, EVs and IVs, a nickname, gender and whether it's shiny. The moves list shows every move each Pokémon can learn in the third generation's games, as Pokémon Showdown's does (by level, TM, move tutor, egg or event, in Ruby, Sapphire, Emerald, FireRed, LeafGreen, Colosseum or XD), and how; others can still be chosen and are marked. Stats are worked out as you go, at level 50 or 100. **Import** and **Export** take a team in Showdown's text, and **Copy to a new party** on your Story party starts a party from the Pokémon in your save. A Pokémon with no moves chosen battles with the moves it learns by the room's level. You can keep as many parties as you like, and pick the one you want to battle with.

A party is of **Generation 3** or **Generation 4**, chosen at the top of the team builder. A Generation 4 party can also have the 107 Generation 4 Pokémon and their moves, and the team builder shows each move and ability as it plays under Pokémon Platinum's battle rules (Shadow Ball is special, Magnemite can have Sturdy), with every move a Pokémon can learn in Diamond, Pearl, Platinum, HeartGold or SoulSilver, or bring over from Generation 3 by Pal Park. A Generation 4 party battles only in rooms on Platinum's rules (**Rules** under Create room), and choosing one picks those rules for you; a Generation 3 party can battle under either. Both games of a Platinum room have the Generation 4 Pokémon, each looking as your own Battle Revolution models make it, or as its stand-in until you make them, which changes nothing in the battle.

**Create room** opens a room in the **Format** you choose. **Casual** is a room at level 50 or 100, with 3 or 6 Pokémon each (the first three of your party in a 3-Pokémon battle) and no rules. The competitive formats are the ones players have used for years on Pokémon Showdown and OrreLink:

- **Orre Colosseum**: the official doubles format. Level 100, bring 6 and pick 4, no box legendaries or mythical Pokémon (so no Groudon or Celebi; Articuno and Latios are fine), no Soul Dew, and the sleep, freeze, species, item and self-KO clauses.
- **Hoenn Stadium**: the official singles format, the same rules with 3 picked.
- **Gen 3 OU**: Smogon's 6-on-6 singles, with no team preview and the other player's HP as a bar only: no Ubers, species, sleep (Smogon's, where Rest doesn't count) and freeze clauses, no one-hit KO or evasion moves, and Smogon's other bans (Sand Veil, Soundproof, Quick Claw, Assist, Swagger, and its Baton Pass and trapping rules).

**Customise** changes any of a format's rules. A room with Orre Unlimited (all Pokémon, Soul Dew allowed) or Orre Limited (level 50, no legendary Pokémon) shows that name, as do the Hoenn ones; any other change shows as, say, **Orre Colosseum\* (custom)** with what changed. **Games** makes the room a best of 3 or 5: you keep the same party for the whole set, and with team preview you pick again before each game. The game itself checks the clauses that happen in battle, as the original game's Battle Mode does, and every online battle has critical hits and Soul Dew working, as link battles did; what a party may bring is checked by the launcher before you make or join a room, and by the room server. A room your party can't play says why.

Your game starts and waits in the stadium, and your room appears for everyone on the list. Untick **Show on the room list** to keep it private and give a friend the code instead. When someone joins, your game starts again and you're both in the battle: first the screen with both trainers and their Pokémon, then, with team preview, the game's own selection screen, where you each pick your Pokémon in order with the buttons shown beside them (you have 90 seconds, then the first of your party go; the other player's picks show once you've both chosen), and after the battle its results, with each Pokémon's HP and who won. A game from before these screens closes while you each pick on the Online tab instead. Players choose their moves at the same time. **Give in** from the battle menu ends the battle, and closing the game counts as leaving.

Both players need the same build of the game. A room on another version says which one it needs.

**Pokémon XD** battles online too. Its parties come from the team builder, which reads the Pokémon from your Colosseum disc, so set up Colosseum's disc as well. Tick **Colosseum and XD players can join** when you create a room, and a player of either game can take it: the two games play one battle, with XD following Colosseum's rules where they differ. Rooms for both games have no timers or Platinum's rules yet, and both games must come from the same version of the port. XD's online battles don't have the in-game pick screen yet: with team preview, you pick in the launcher.

### Game Boy Advance

The game links with a Game Boy Advance as it did through the GCN-GBA cable: register your team from Pokémon Ruby, Sapphire, Emerald, FireRed or LeafGreen for Colosseum Battle, trade Pokémon between the two games, and spend the GBA game's Poké Coupons on prizes.

Under **Settings → Game Boy Advance**, choose your save: the `.sav` (or RetroArch `.srm`) your emulator keeps. The launcher looks in the usual emulator folders and offers what it finds, shows the trainer and party, and says if the save isn't ready to link: Colosseum links only with a game saved inside a Pokémon Center, far enough along (the Pokédex in Ruby, Sapphire and Emerald, the National Pokédex in FireRed and LeafGreen), and in English. When the game asks for the GBA, it answers from the save, as the program it sends the GBA would, and writes trades and prizes back into it as the GBA game saves them. In a trade, your controller also chooses the GBA's side. A copy of the save goes to **GBA saves** in your backup folder before each session. Close your emulator first, so it doesn't save over what the game wrote.

No GBA BIOS or Game Pak is needed. Linking from the save alone has been checked with Emerald; if it doesn't work with your game, open **If linking doesn't work: run the GBA itself** under Advanced and choose a dump of the Game Pak the save belongs to. The GBA then runs inside the game with [mGBA](https://mgba.io), as Dolphin's Integrated GBA does, and the Game Pak does the linking itself, as on a console; a BIOS dump is optional. You also need this to choose moves on a GBA's screen in Colosseum Battle, or to scan e-Reader cards. Colosseum never showed a GBA game itself: on a console the GBA was a separate handheld on the cable, and here its screen sits in a corner instead. Press **G** (**Back** on a controller) to use it and again to go back, and hold it to turn the GBA on or off. The GBA turns on and off by itself when the game asks you to, unless you turn that off. With an e-Reader, drop a card's `.raw` file on the game's window to scan it. Sockets 3 and 4 are for linking three GBAs at once.

### Privacy

The launcher sends nothing personal. Every 10 minutes it checks in with the online count server: your launcher and game versions, OS, update channel, whether the game is running, and a random ID made on first run. That's what the online count in the top bar is made from. Turn off **Share anonymous usage** under Settings → Launcher and you'll still see the count, without being part of it. An online room passes your trainer name and party to the other player through that server, and no address is stored. Otherwise the launcher talks to GitHub and the port's GitLab for updates, the setup files and the HD textures. Your disc image never leaves your computer.

## Need help?

Open the activity log with **Activity log** in the status bar, choose **Copy log**, and [open an issue](https://github.com/chasem-dev/colosseum-launcher/issues/new/choose) with it. Crash reports are kept in `colo-port/crashes` in your state folder (`%LOCALAPPDATA%` on Windows, `~/.local/state` elsewhere).

## Credits

| | Who | For |
| --- | --- | --- |
| <img src="https://github.com/chasem-dev.png?size=96" width="48" height="48" alt=""> | **[Chase Myers](https://github.com/chasem-dev)** | The launcher and the PC port |
| <img src="https://github.com/snatcherLeo.png?size=96" width="48" height="48" alt=""> | **[snatcherLeo](https://github.com/snatcherLeo)** | Engine expertise |
| <img src="https://github.com/dougchansan.png?size=96" width="48" height="48" alt=""> | **[dougchansan](https://github.com/dougchansan)** | The [pkmn-colosseum](https://github.com/dougchansan/pkmn-colosseum) decompilation the game is built from |
| <img src="https://github.com/SteamGridDB.png?size=96" width="48" height="48" alt=""> | **[SteamGridDB](https://www.steamgriddb.com)** | The artwork used by **Add to Steam** |
| <img src="https://github.com/StarsMmd.png?size=96" width="48" height="48" alt=""> | **[StarsMmd](https://github.com/StarsMmd)** | Years of work on Colosseum, XD and Battle Revolution's files: the [GoD Tool](https://github.com/StarsMmd/GoD-Tool) and the [Blender add-on for GameCube models](https://github.com/StarsMmd/Blender-Addon-Gamecube-Models), which Battle Revolution Pokémon packs are made with |
| <img src="https://github.com/mgba-emu.png?size=96" width="48" height="48" alt=""> | **[mGBA](https://mgba.io)** | The Game Boy Advance in the game (Mozilla Public License 2.0) |

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

### Online battles

The rooms and the online count are [colosseum-server-api](https://github.com/chasem-dev/colosseum-server-api), a Cloudflare Worker. `COLO_TELEMETRY_URL=http://localhost:8787 npm start` points a development launcher at one running with `npm run dev` (a development launcher reports nothing without it). `src/online.js` is the launcher's side, and the game's `host/online.c` lists the lines the two exchange. `src/formats.js` holds the formats and checks parties; the room server keeps a copy (its `scripts/formats.mjs` makes it from this one), so change it here and make that again.

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

`npm run update:game` selects the newest commit of the port's branch and the decomp and renderer commits it pins, bumps the version and drafts the changelog. Stable stays on the x86_64 game until then: `"rosetta": true` in `src/game-release.json` marks a game from before the native Apple Silicon build, and on that mark the launcher keeps Rosetta and Vulkan and CI expects x86_64. Beta's build drops the mark, and so does moving the pin, which brings Apple Silicon to Stable. See [AGENTS.md](AGENTS.md) for the changelog's rules.

### Launcher updates and Mac signing

Updates come from this repository's releases through `electron-updater`. Mac updates need every release signed with one certificate: `scripts/make-mac-cert.sh` makes a self-signed one, and the repository's `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` secrets hold it. Keep its folder: a new certificate breaks updates for every install. The app is not notarized, so macOS asks to confirm the first time it opens.
