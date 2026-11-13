# Discord activity art

While the game runs, Discord shows what the player is doing (Settings → Launcher → Show on Discord). The game
prints a `[presence]` line whenever that changes (the port's `host/presence.c`, with `COLO_PRESENCE=1`), and
`src/presence.js` turns it into the activity that `src/discord.js` sends to the Discord app.

The pictures are art assets of the Discord application whose ID is in `src/discord.js`, under Rich Presence →
Art Assets in the Discord Developer Portal. Each is uploaded under its key below, 1024 × 1024. A key the
activity names that isn't uploaded shows no picture, so add the asset before a release uses it.

| Key | Shown for |
| --- | --- |
| `logo` | the title screen, menus, movies, and a game that prints no `[presence]` lines |
| `launcher` | the small picture in the corner, always |
| `outskirt_stand` | Outskirt Stand |
| `phenac_city` | Phenac City, the Mayor's House, Pre Gym, Phenac Stadium (and Battle Now there) |
| `pyrite_town` | Pyrite Town, Pyrite Building, Pyrite Cave, Miror B.'s Hideout, Pyrite Colosseum |
| `agate_village` | Agate Village, Relic Cave |
| `the_under` | The Under, its subway, Under Colosseum, Deep Colosseum |
| `shadow_lab` | the Shadow Pokémon Lab and outside it |
| `mt_battle` | Mt. Battle and its Colosseum |
| `realgam_tower` | Realgam Tower, its Dome, Lobby and Colosseum |
| `snagem_hideout` | Snagem Hideout |
| `orre_colosseum` | Orre Colosseum and online battles |

`PLACE_IMAGES` in `src/presence.js` maps the game's place names to these keys, and `AREA_IMAGES` the floor
table's areas for any other place. A battle's floor is named after the place it belongs to, so a battle
shows that place's picture.

The pictures are frames of the port itself at 4x with the HD texture pack and 16:9 widescreen, cropped
square. The towns are the game's own camera sweep on a first visit: start the game with
`COLO_BOOT_FLOOR=<floor>@700`, no buttons pressed, and dump frames 800 to 1200 (`SMS_GX_DUMP_*`).
`COLO_PRESENCE_FLOORS=1` lists every floor with its area and place.

## Pokémon XD

XD has a Discord application of its own once its ID is in `src/games.js` (`discordAppId` in the `xd` entry); until
then XD's activity goes through Colosseum's application, with Colosseum's pictures for the places both games share
and XD's title for the rest. Upload these to XD's application, 1024 × 1024. Like Colosseum's, they are frames of the
port at 4x with XD's HD texture pack and 16:9 widescreen, cropped square; `logo` is XD's title screen.

| Key | Shown for |
| --- | --- |
| `logo` | XD's title screen, menus, movies |
| `launcher` | the small picture in the corner, always |
| `outskirt_stand` | Outskirt Stand |
| `phenac_city` | Phenac City |
| `pyrite_town` | Pyrite Town |
| `agate_village` | Agate Village |
| `mt_battle` | Mt. Battle |
| `realgam_tower` | Realgam Tower |
| `snagem_hideout` | Snagem Hideout |
| `orre_colosseum` | Orre Colosseum and online battles |
| `gateon_port` | Gateon Port |
| `hq_lab` | the Pokémon HQ Lab |
| `cipher_lab` | the Cipher Lab |
| `cipher_key_lair` | Cipher Key Lair |
| `citadark_isle` | Citadark Isle |
| `ss_libra` | the S.S. Libra |
| `kaminkos_house` | Kaminko's House |
| `poke_spot` | the Rock, Oasis and Cave Poké Spots |

`XD_PLACE_IMAGES` in `src/presence.js` maps XD's place names to these keys. XD's floor table numbers its areas its
own way, so only a place's name picks a picture.
