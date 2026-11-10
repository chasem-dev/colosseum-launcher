# Pokémon packs

A Pokémon pack adds Pokémon of your own making to the game: new species, fakemon, or new forms of the game's Pokémon. Each
one has its own name, stats, types, abilities and moves, and can have its own 3D model and sprites. Pack Pokémon show in the
launcher's Pokédex as well.

Packs only add Pokémon. Nothing in the game hands them out yet, apart from evolving one pack Pokémon into another.

## Where packs go

Open the **Pokédex** and press **Open Pokémon packs folder**. Each pack is a folder there, and each Pokémon in it has a folder
of its own:

```
mods/pokemon/
  moon-pack/
    pack.json            optional: the pack's name and author
    moonfang/
      pokemon.json       what the Pokémon is
      model.pkx          optional: its 3D model
      model-shiny.pkx    optional: its shiny model
      body.png           optional: its body sprite
      body-shiny.png     optional: its shiny body sprite
      face.png           optional: its face icon
      face-shiny.png     optional: its shiny face icon
    eclipse/
      pokemon.json
```

Folder names may use letters, numbers, `-` and `_`. Press **Reload** in the Pokédex after you change a pack: it shows each Pokémon
it could load, and says what's wrong with any it couldn't. The launcher reads the packs again each time you play.

`pack.json`:

```json
{ "name": "Moon Pack", "author": "You", "credits": "Model base by a friend; cry from another pack." }
```

`credits` names whoever else the pack owes thanks to, and the Pokédex shows it with each of the pack's Pokémon.

## pokemon.json

Every Pokémon starts as a copy of the one it's based on (`base`), and only changes what its `pokemon.json` says. A Pokémon
without a model, a cry or sprites of its own looks and sounds like its base.

```json
{
  "base": "Umbreon",
  "name": "Moonfang",
  "description": "Hunts by the light of a new moon.",
  "types": ["Dark", "Ghost"],
  "abilities": ["Levitate", "Inner Focus"],
  "stats": { "hp": 95, "attack": 85, "defense": 110, "spAttack": 60, "spDefense": 120, "speed": 95 },
  "evYield": { "spDefense": 2 },
  "catchRate": 45,
  "baseExp": 184,
  "baseFriendship": 35,
  "growthRate": "mediumFast",
  "gender": 12.5,
  "height": 1.1,
  "weight": 30.5,
  "cry": "Mightyena",
  "moves": [[1, "Tackle"], [1, "Bite"], [16, "Faint Attack"], [30, "Shadow Ball"]],
  "tms": ["TM06", "TM30", "HM05"],
  "evolutions": [{ "into": "eclipse", "level": 40 }]
}
```

| Field | What it is |
| --- | --- |
| `base` | Required. The Pokémon this one starts from, by name (`"Umbreon"`) or National Pokédex number (`197`). |
| `name` | Required, except for a form. Up to 10 letters, numbers, spaces and `. ' - ♂ ♀ é`. The game shows it in capitals. |
| `form` | Makes it a form of its base, such as `"Storm"`. Without a `name` it keeps its base's. The Pokédex lists it under its base. |
| `description` | Shown in the launcher's Pokédex. |
| `types` | One or two of the game's types. |
| `abilities` | One or two abilities, by name or by number. |
| `stats` | Base stats, 1 to 255: `hp`, `attack`, `defense`, `spAttack`, `spDefense`, `speed`. Leave one out to keep its base's. |
| `evYield` | Effort values it gives when defeated, 0 to 3, with the same names. |
| `catchRate`, `baseExp`, `baseFriendship` | Numbers, as in the main series. |
| `growthRate` | `mediumFast`, `erratic`, `fluctuating`, `mediumSlow`, `fast` or `slow`. |
| `gender` | How many in 100 are female (0 to 100), or `"genderless"`. |
| `height`, `weight` | In metres and kilograms. |
| `cry` | Another Pokémon whose cry it uses. |
| `moves` | The moves it learns by level, up to 20, as `[level, "Move"]`, the move by name or number. Replaces its base's list. |
| `tms` | The TMs and HMs it can learn, such as `"TM06"` or `"HM01"`. Replaces its base's. |
| `tmMoves` | Moves it can learn from a TM or HM in any game, by name or number: it can learn those this game's TMs and HMs teach, and the rest are let go. Replaces its base's, unless `tms` is there too. |
| `evolutions` | Up to 5, replacing its base's. Each has `into`, and one of these: `"level": 30`, with `"gender": "male"` or `"female"` for one gender only; `"item": "Moon Stone"`; `"friendship": true` (`"day"` and `"night"` never happen, as the game keeps no time of day); `"trade": true`, or the item it holds while traded; `"knowsMove": "Ancient Power"`, levelling up while knowing that move; `"withPokemon": "Remoraid"`, levelling up with that Pokémon in the party. |

Moves and abilities are numbered alike in every game from Ruby and Sapphire on, so a number from another game's data
works as long as this game has the move or ability.

`into` names another Pokémon of the same pack by its folder (`"eclipse"`), one of another pack as `"pack/folder"`, or one of the
game's by name or number.

Evolution items are the Sun, Moon, Fire, Thunder, Water and Leaf Stones, King's Rock, Deep Sea Tooth, Deep Sea Scale, Metal
Coat, Dragon Scale and Up-Grade.

## Models

`model.pkx` is a model in the game's own format: a Pokémon's `.pkx` file from the game's archives, the kind `pkx_*.fsys`
files hold, with its animations. The launcher's Pokédex draws it, so you can check a model there before you play. A shiny Pokémon
uses `model-shiny.pkx` if there is one. Without one, the game tints the normal model, as it does for most of its own shiny
Pokémon.

## Sprites

PNG images. Any size works, and each is scaled to the game's size:

- `body.png`: the 64×64 picture the PC shows.
- `face.png`: the 42×42 face icon the party and battle screens show.

Transparent pixels stay transparent. A shiny Pokémon uses `body-shiny.png` and `face-shiny.png`, or the normal ones when there
aren't any.

## Saves

Pack Pokémon go in the 25 rows the game leaves empty first, then in rows of their own past the game's (from 1100: the
rows between are kept for later generations' Pokémon), so there's room for thousands. Each Pokémon gets a place the first time you play with it, and keeps it from then on, even after you remove its pack. The places are recorded in `pokemon-packs.json` beside your saves, and save
backups include it. Keep it with your saves: a Pokémon in a save is stored by its place.

Pokémon of a pack you've removed stay in your save but don't appear in the game until the pack is back, and while they're
hidden the game may write over them. The original game, and other copies of it, don't have your pack's Pokémon either: a save
carried there hides them the same way.

Online battles play without packs, as the other player's game wouldn't have your Pokémon. Pack Pokémon in your Story party
stay home.

The randomizer only chooses among the game's own Pokémon.
