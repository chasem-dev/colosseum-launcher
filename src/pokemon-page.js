// The Pokémon page: the party and PC boxes of the chosen game's save, from the card, or live from the game while it
// runs (main.js pokemonPage). A Shadow Pokémon can go to Shadowtrade from here: it leaves the save and another
// player's Shadow Pokémon comes back (src/shadowtrade.js). Online Trade (src/online-trades.js): a trade code made or
// joined from the card beside the grid, then the trade window takes the page over until the room closes.

const $ = id => document.getElementById(id);
const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let data = null, tab = 'party', box = 0, selected = null, visible = false, loading = null, dex = null, dexFor = null, waitingGame = false;
let tradeView = null, names = null, tradeHistorySeen = null;
let localView = null, localSide = null, localSeen = null, localBusy = false, localError = null;   // trades between your games
const NATURES = ['Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax', 'Timid', 'Hasty', 'Serious',
  'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash', 'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky'];
const TRADE_STAGE = {
  taking: 'Your Pokémon is leaving your save…', taken: 'Sent: waiting for the other player\'s Pokémon',
  received: 'Arrived: going into your save', giving: 'Going into your save…', given: 'In your save', evolving: 'Evolving…'
};
const STAGE = {
  taking: 'Leaving your save…', taken: 'Not sent: coming back to your save', waiting: 'In the pool: a Shadow Pokémon comes back when another player trades one your save can take',
  received: 'Received: going into your save', giving: 'Going into your save…', given: 'In your save'
};

// The Pokédex's names and sprites, by the game's species number, read once for each game (null: none, the page shows numbers).
async function species(game) {
  if (dexFor === game) return dex;
  dexFor = game;
  try {
    const list = await window.colo.pokedex();
    dex = new Map(list.species.map(entry => [entry.id, entry]));
  } catch (_) { dex = null; }
  return dex;
}

const speciesName = pokemon => dex?.get(pokemon.species)?.name || `Pokémon #${pokemon.species}`;
const shown = pokemon => (pokemon.nickname && pokemon.nickname !== speciesName(pokemon).toUpperCase() ? pokemon.nickname : speciesName(pokemon));

function sprite(pokemon, size) {
  const entry = dex?.get(pokemon.species);
  if (entry?.sprite) return Object.assign(document.createElement('img'), { src: entry.sprite, alt: '', width: size, height: size, loading: 'lazy' });
  return Object.assign(document.createElement('span'), { className: 'pokedex-no-sprite', textContent: '?' });
}

function slots() {
  if (!data?.model) return [];
  return tab === 'party' ? data.model.party : data.model.boxes[box]?.pokemon || [];
}

function renderGrid() {
  const grid = $('pokemon-grid');
  grid.replaceChildren();
  grid.classList.toggle('party', tab === 'party');
  const list = slots();
  list.forEach((pokemon, slot) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pokemon-slot';
    button.setAttribute('role', 'option');
    if (!pokemon) {
      button.classList.add('empty');
      button.disabled = true;
      button.setAttribute('aria-label', 'Empty');
      grid.append(button);
      return;
    }
    const isSelected = selected && selected.area === pokemon.area && selected.box === pokemon.box && selected.slot === pokemon.slot;
    button.classList.toggle('selected', Boolean(isSelected));
    button.classList.toggle('shadow', pokemon.shadow);
    button.setAttribute('aria-selected', String(Boolean(isSelected)));
    button.title = `${shown(pokemon)}, level ${pokemon.level}${pokemon.shadow ? ', Shadow Pokémon' : ''}${pokemon.traded ? ', from Shadowtrade' : ''}`;
    button.append(sprite(pokemon, tab === 'party' ? 56 : 44));
    const label = document.createElement('span');
    label.className = 'pokemon-slot-label';
    label.append(Object.assign(document.createElement('strong'), { textContent: shown(pokemon) }),
      Object.assign(document.createElement('small'), { textContent: pokemon.egg ? 'Egg' : `Lv. ${pokemon.level}` }));
    button.append(label);
    if (pokemon.shadow) button.append(Object.assign(document.createElement('span'), { className: 'pokemon-shadow-mark', textContent: 'Shadow' }));
    if (pokemon.shiny) button.append(Object.assign(document.createElement('span'), { className: 'pokemon-shiny-mark', textContent: '★', title: 'Shiny' }));
    button.addEventListener('click', () => { selected = { area: pokemon.area, box: pokemon.box, slot: pokemon.slot }; renderGrid(); renderDetail(); });
    grid.append(button);
  });
  const count = list.filter(Boolean).length;
  $('pokemon-empty').hidden = Boolean(count) || !data?.model;
  $('pokemon-empty').textContent = tab === 'party' ? 'Your party is empty.' : 'This box is empty.';
}

function current() {
  if (!selected || !data?.model) return null;
  const list = selected.area === 'party' ? data.model.party : data.model.boxes[selected.box]?.pokemon;
  return list?.[selected.slot] || null;
}

function renderDetail() {
  const pokemon = current();
  $('pokemon-detail').hidden = !pokemon;
  if (!pokemon) return;
  $('pokemon-detail-sprite').replaceChildren(sprite(pokemon, 96));
  $('pokemon-detail-name').textContent = shown(pokemon);
  const where = pokemon.area === 'party' ? `Party, slot ${pokemon.slot + 1}` : `${data.model.boxes[pokemon.box].name}, slot ${pokemon.slot + 1}`;
  $('pokemon-detail-meta').textContent = `${speciesName(pokemon)} · Lv. ${pokemon.level} · ${where}`;
  const badges = $('pokemon-detail-badges');
  badges.replaceChildren();
  if (pokemon.shadow) badges.append(Object.assign(document.createElement('span'), { className: 'badge shadow-badge', textContent: 'Shadow Pokémon' }));
  if (pokemon.shiny) badges.append(Object.assign(document.createElement('span'), { className: 'badge warn', textContent: 'Shiny' }));
  if (pokemon.traded) badges.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: 'From Shadowtrade', title: 'It has a Shadow of its own in your save, apart from the story\'s' }));
  if (pokemon.egg) badges.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: 'Egg' }));
  if (!pokemon.egg) badges.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: `HP ${pokemon.hp}/${pokemon.maxHp}` }));
  const heart = $('pokemon-heart');
  heart.hidden = !pokemon.shadow || pokemon.heartPercent === undefined;
  if (!heart.hidden) {
    $('pokemon-heart-fill').style.width = `${pokemon.heartPercent}%`;
    $('pokemon-heart-text').textContent = pokemon.heartPercent ? `Heart gauge ${pokemon.heartPercent}% closed` : 'Its heart is open: ready to purify';
  }
  const problem = pokemon.tradeProblem || (!data.canTrade ? data.notice || 'Trading isn\'t possible right now.' : null);
  $('pokemon-trade').hidden = !pokemon.shadow;
  $('pokemon-trade').disabled = Boolean(problem) || Boolean(data.trades?.busy);
  $('pokemon-trade-note').textContent = pokemon.shadow ? (problem || 'It leaves your save, and a Shadow Pokémon another player sent comes back.') : 'Only Shadow Pokémon can go to Shadowtrade.';
}

function describeTrade(trade) {
  const row = document.createElement('div');
  row.className = 'shadowtrade-row';
  const text = document.createElement('div');
  const sent = `${trade.sent.nickname || `#${trade.sent.species}`} (Lv. ${trade.sent.level})`;
  text.append(Object.assign(document.createElement('strong'), { textContent: trade.received?.returned || trade.stage === 'taken' ? `${sent} is coming back` : `Sent ${sent}` }));
  let line = STAGE[trade.stage] || trade.stage;
  if (trade.received && !trade.received.returned) line = `${STAGE[trade.stage]}: ${trade.received.nickname || `#${trade.received.species}`} from ${trade.received.from || 'another player'}`;
  if (trade.message) line = trade.message;
  if (waitingGame && ['taking', 'giving'].includes(trade.stage)) line = 'Waiting for the game: walk around in the field, outside menus and battles.';
  text.append(Object.assign(document.createElement('small'), { textContent: line }));
  row.append(text);
  if (['taken', 'waiting'].includes(trade.stage)) {
    const cancel = Object.assign(document.createElement('button'), { className: 'subtle', type: 'button', textContent: 'Cancel', title: 'Take it back out of the pool, if no one has it yet' });
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try { await window.colo.shadowtradeCancel(trade.tradeId); setStatus(''); } catch (error) { setStatus(message(error)); }
      refresh();
    });
    row.append(cancel);
  }
  return row;
}

function renderTrades() {
  const view = data?.trades || { trades: [], history: [] };
  const list = $('shadowtrade-trades');
  list.replaceChildren(...view.trades.filter(trade => trade.game === data.game).map(describeTrade));
  $('shadowtrade-none').hidden = view.trades.some(trade => trade.game === data.game);
  const history = $('shadowtrade-history');
  const mine = view.history.filter(item => item.game === data.game).slice(0, 8);
  history.replaceChildren(...mine.map(item => {
    const li = document.createElement('li');
    li.textContent = item.returned ? `${item.sent.nickname} came back to you` : `${item.sent.nickname} for ${item.received.nickname} (Lv. ${item.received.level}) from ${item.from || 'another player'}`;
    return li;
  }));
  $('shadowtrade-history-title').hidden = !mine.length;
}

function renderBoxes() {
  const select = $('pokemon-box');
  const boxes = data?.model?.boxes || [];
  if (box >= boxes.length) box = 0;
  select.replaceChildren(...boxes.map((each, i) => Object.assign(document.createElement('option'), { value: String(i),
    textContent: `${each.name} (${each.pokemon.filter(Boolean).length}/${each.pokemon.length})` })));
  select.value = String(box);
  $('pokemon-box-bar').hidden = tab !== 'boxes' || !boxes.length;
}

function setStatus(text) {
  $('pokemon-status').textContent = text;
  $('pokemon-status').hidden = !text;
}

function render() {
  const model = data?.model;
  const gameName = data?.game === 'xd' ? 'XD' : 'Colosseum';
  $('pokemon-summary').textContent = model ? `${model.trainer || 'Your'}'s party and PC boxes, in your ${gameName} save.` : `No ${gameName} save yet: play and save, and your Pokémon show here.`;
  $('pokemon-source').hidden = !data?.source;
  $('pokemon-source').textContent = data?.source === 'live' ? 'Live from the game' : 'From your save';
  $('pokemon-source').classList.toggle('good', data?.source === 'live');
  $('pokemon-notice').hidden = !data?.notice;
  $('pokemon-notice').textContent = data?.notice || '';
  for (const name of ['party', 'boxes']) $(`pokemon-tab-${name}`).setAttribute('aria-selected', String(tab === name));
  renderBoxes();
  if (selected && !current()) selected = null;
  renderGrid();
  renderDetail();
  renderTrades();
  if (tradeView) renderTradePanel();
}

async function refresh() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const next = await window.colo.pokemonPage();
      await species(next.game);
      if (next.game !== data?.game) { selected = null; box = 0; }
      data = next;
      render();
    } catch (error) { setStatus(message(error)); } finally { loading = null; }
  })();
  return loading;
}

async function trade() {
  const pokemon = current();
  if (!pokemon) return;
  $('shadowtrade-confirm-name').textContent = shown(pokemon);
  $('shadowtrade-confirm-sprite').replaceChildren(sprite(pokemon, 72));
  $('shadowtrade-confirm-live').hidden = data.source !== 'live';
  $('shadowtrade-confirm').showModal();
}

async function confirmTrade() {
  const pokemon = current();
  $('shadowtrade-confirm').close();
  if (!pokemon) return;
  $('pokemon-trade').disabled = true;
  setStatus(data.source === 'live' ? `Sending ${shown(pokemon)}: the game saves once it's out of your save…` : `Sending ${shown(pokemon)}…`);
  try {
    const view = await window.colo.shadowtradeOffer({ area: pokemon.area, box: pokemon.box, slot: pokemon.slot });
    const done = view.history.find(item => item.sent.nickname === pokemon.nickname && Date.now() - item.at < 60000);
    setStatus(done ? `Traded! ${done.received.nickname} from ${done.from || 'another player'} is in your save.` : `${shown(pokemon)} is in the Shadowtrade pool. A Shadow Pokémon comes back when another player trades.`);
    selected = null;
  } catch (error) { setStatus(message(error)); }
  waitingGame = false;
  await refresh();
}

// ---- Online Trade: the trade window ----

// Move and item names (the team builder's), read once; numbers when the game data isn't there.
async function tradeNames() {
  if (names) return names;
  names = { moves: new Map(), items: new Map(), moveData: new Map(), itemData: new Map(), species: {} };
  try {
    const battle = await window.colo.battleData();
    for (const move of battle.moves || []) { names.moves.set(move.id, move.name); names.moveData.set(move.id, move); }
    for (const item of battle.items || []) { names.items.set(item.id, item.name); names.itemData.set(item.id, item); }
    for (const each of Object.values(battle.generations || {})) {
      for (const item of each.items || []) if (!names.items.has(item.id)) { names.items.set(item.id, item.name); names.itemData.set(item.id, item); }
      for (const move of each.moves || []) if (!names.moves.has(move.id)) { names.moves.set(move.id, move.name); names.moveData.set(move.id, move); }
      Object.assign(names.species, Object.fromEntries(Object.entries(each.species || {}).filter(([id]) => !battle.species?.[id])));
    }
    Object.assign(names.species, battle.species || {});
  } catch (_) { /* numbers */ }
  return names;
}

// ---- every stat: the two offers side by side (the trade window's Compare every stat) ----
const TS = () => window.coloTeamSets;
const BALLS = ['', 'Master Ball', 'Ultra Ball', 'Great Ball', 'Poké Ball', 'Safari Ball', 'Net Ball', 'Dive Ball', 'Nest Ball', 'Repeat Ball', 'Timer Ball', 'Luxury Ball', 'Premier Ball'];
const RIBBONS = ['Champion', 'Winning', 'Victory', 'Artist', 'Effort', 'Marine', 'Land', 'Sky', 'Country', 'National', 'Earth', 'World'];
const CONTEST = ['Cool', 'Beauty', 'Cute', 'Smart', 'Tough'];
const RANKS = ['', 'Normal', 'Super', 'Hyper', 'Master'];
const ORIGINS = { 1: 'FireRed', 2: 'LeafGreen', 8: 'Sapphire', 9: 'Ruby', 10: 'Emerald', 11: 'Colosseum or XD' };
const LANGUAGES = { 1: 'Japanese', 2: 'English', 3: 'German', 4: 'French', 5: 'Italian', 6: 'Spanish' };

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

function statSheet(summary, heading, { problems = [], evolvesInto = 0 } = {}) {
  const sheet = el('section', { className: 'trade-sheet' }, el('h2', { textContent: heading }));
  if (!summary) { sheet.append(el('p', { className: 'helper', textContent: 'No Pokémon offered yet.' })); return sheet; }
  const ts = TS(), species = names?.species?.[summary.species] || null, entry = dex?.get(summary.species);
  const gender = ts && species ? ts.genderOf(summary.personality >>> 0, species.gender) : '';
  const abilities = species?.abilities || [];
  const ability = abilities.find(a => a.slot === summary.abilitySlot) || abilities[0] || null;
  const effect = ts?.natureEffect(summary.nature);
  const head = el('div', { className: 'trade-sheet-head' }, sprite(summary, 72),
    el('div', {}, el('strong', { textContent: `${shown(summary)}${gender === 'M' ? ' ♂' : gender === 'F' ? ' ♀' : ''}${summary.shiny ? ' ★' : ''}` }),
      el('small', { textContent: `${speciesName(summary)} · Lv. ${summary.level}${entry?.types?.length ? ` · ${entry.types.join('/')}` : ''}` }),
      el('small', { textContent: `From ${summary.game === 'xd' ? 'XD' : 'Colosseum'}${summary.shiny ? ' · Shiny' : ''}` })));
  sheet.append(head);
  // the six stats: value, base, IV, EV, and the nature's tenth up or down
  const base = entry?.stats || [];
  const table = el('table', { className: 'trade-sheet-stats' });
  table.append(el('thead', {}, el('tr', {}, ...['Stat', 'Value', 'Base', 'IV', 'EV'].map(text => el('th', { textContent: text })))));
  const body = el('tbody');
  (ts?.STAT_NAMES || ['HP', 'Attack', 'Defense', 'Sp. Atk', 'Sp. Def', 'Speed']).forEach((statName, i) => {
    const mark = effect?.up === i ? ' ↑' : effect?.down === i ? ' ↓' : '';
    body.append(el('tr', { className: effect?.up === i ? 'up' : effect?.down === i ? 'down' : '' },
      el('th', { textContent: statName + mark }), el('td', { textContent: i === 0 ? `${summary.hp}/${summary.stats[0]}` : String(summary.stats[i]) }),
      el('td', { textContent: base[i] ?? '?' }), el('td', { textContent: String(summary.ivs[i]) }), el('td', { textContent: String(summary.evs[i]) })));
  });
  const sum = list => list.reduce((a, v) => a + (Number(v) || 0), 0);
  body.append(el('tr', { className: 'total' }, el('th', { textContent: 'Total' }), el('td', { textContent: String(sum(summary.stats)) }),
    el('td', { textContent: base.length ? String(sum(base)) : '?' }), el('td', { textContent: `${sum(summary.ivs)}/186` }), el('td', { textContent: `${sum(summary.evs)}/510` })));
  table.append(body);
  sheet.append(table);
  // moves
  const moves = el('table', { className: 'trade-sheet-moves' });
  moves.append(el('thead', {}, el('tr', {}, ...['Move', 'Type', 'Kind', 'Power', 'Acc.', 'PP', 'PP Ups'].map(text => el('th', { textContent: text })))));
  const moveBody = el('tbody');
  for (const move of summary.moves) {
    const data = names?.moveData.get(move.id);
    const most = data?.pp ? Math.floor(data.pp * (5 + move.ppUps) / 5) : null;
    moveBody.append(el('tr', {}, el('th', { textContent: data?.name || `Move #${move.id}` }), el('td', { textContent: data?.type || '?' }),
      el('td', { textContent: data?.category || '' }), el('td', { textContent: data?.power ? String(data.power) : '—' }),
      el('td', { textContent: data?.accuracy ? String(data.accuracy) : '—' }), el('td', { textContent: most !== null ? `${move.pp}/${most}` : String(move.pp) }),
      el('td', { textContent: String(move.ppUps) })));
  }
  moves.append(moveBody);
  sheet.append(moves);
  // everything else it has
  const hidden = ts?.hiddenPower(summary.ivs);
  const item = summary.heldKeyItem ? 'A key item (it can\'t travel)' : summary.item ? (names?.items.get(summary.item) || `Item #${summary.item}`) : 'Nothing';
  const pokerus = !summary.pokerus ? 'Never had it' : summary.pokerus & 0xf ? 'Has Pokérus' : 'Cured of Pokérus';
  const marks = ['●', '■', '▲', '♥'].filter((_, i) => summary.markings & (1 << i)).join(' ') || 'None';
  const facts = [
    ['Nature', ts ? ts.natureLabel(summary.nature) : String(summary.nature)],
    ['Ability', ability ? ability.name : '?', ability?.doc],
    ['Held item', item, summary.item ? names?.itemData.get(summary.item)?.doc : null],
    ['Hidden Power', hidden ? `${hidden.type}, power ${hidden.power}` : '?'],
    ['Friendship', `${summary.friendship}/255`],
    ['Experience', `${summary.exp.toLocaleString()} points`],
    ['Pokérus', pokerus],
    ['Ball', BALLS[summary.ball] || `Ball #${summary.ball}`],
    ['Met', `at level ${summary.metLevel || '?'}`],
    ['Original trainer', `${summary.otName || '?'}${summary.otGender === 1 ? ' ♀' : summary.otGender === 0 ? ' ♂' : ''}, ID ${String(summary.otId).padStart(5, '0')}`],
    ['From game', `${ORIGINS[summary.origin] || `#${summary.origin}`}${LANGUAGES[summary.language] ? `, ${LANGUAGES[summary.language]}` : ''}`],
    ['Markings', marks]
  ];
  const list = el('dl', { className: 'trade-sheet-facts' });
  for (const [term, value, doc] of facts) list.append(el('dt', { textContent: term }), el('dd', {}, value, doc ? el('small', { textContent: doc }) : null));
  sheet.append(list);
  // contest and ribbons
  const contest = el('dl', { className: 'trade-sheet-facts' });
  CONTEST.forEach((stat, i) => contest.append(el('dt', { textContent: stat }), el('dd', { textContent: `${summary.contest[i]}${summary.contestRanks[i] ? ` · ${RANKS[summary.contestRanks[i]]} rank ribbon` : ''}` })));
  contest.append(el('dt', { textContent: 'Sheen' }), el('dd', { textContent: `${summary.sheen}/255` }));
  sheet.append(el('h3', { textContent: 'Contest' }), contest);
  const earned = RIBBONS.filter((_, i) => summary.ribbons[i]);
  sheet.append(el('h3', { textContent: 'Ribbons' }), el('p', { className: 'trade-sheet-ribbons', textContent: earned.length ? earned.map(name => `${name} Ribbon`).join(', ') : 'None' }));
  if (evolvesInto) sheet.append(el('p', { className: 'trade-evolves', textContent: `Evolves into ${dex?.get(evolvesInto)?.name || `#${evolvesInto}`} when it arrives.` }));
  for (const problem of problems) sheet.append(el('p', { className: 'trade-problem', textContent: problem.text || problem }));
  return sheet;
}

function renderStats() {
  if (isLocal()) {
    const view = localView, sheet = game => statSheet(view.picks[game]?.summary, `From your ${gameLabel(game)} save`,
      { problems: view.picks[game]?.problems || [], evolvesInto: view.picks[game]?.evolvesInto || 0 });
    $('trade-stats-sheets').replaceChildren(sheet(view.viewer), sheet(view.other));
    return;
  }
  const room = tradeView?.room;
  if (!room) { if ($('trade-stats').open) $('trade-stats').close(); return; }
  const theirs = room.peer?.offer;
  $('trade-stats-sheets').replaceChildren(statSheet(room.you?.offer?.summary, 'You offer'),
    statSheet(theirs?.summary, `${room.peer?.name || 'They'} offer${room.peer?.name ? 's' : ''}`, { problems: theirs?.problems || [], evolvesInto: theirs?.evolvesInto || 0 }));
}

function openStats() {
  renderStats();
  if (!$('trade-stats').open) $('trade-stats').showModal();
}

// ---- the trade window: while a room is open it takes the page over ----
// Left: your party and boxes to pick from. Middle: your offer and theirs facing each other, every stat that matters at
// a glance (the full sheet behind Compare every stat). Below: what's happening and Ready. Over the offers while a trade
// runs: both Pokémon swapping places and the steps; once it's done, what came.
let twTab = 'party', twBox = 0, twNote = null, dismissed = null, tradeCache = null, copiedAt = 0;
const STAT_COLORS = [['#3fb984', '#7ed9a8'], ['#e2663a', '#f4a06c'], ['#d9a51c', '#f2cb5c'], ['#4b7fe0', '#86aaf2'], ['#3aa6a0', '#76cdc6'], ['#d8508a', '#f08bb6']];
const SHORT = ['HP', 'Atk', 'Def', 'SpA', 'SpD', 'Spe'];
const gameLabel = game => (game === 'xd' ? 'XD' : 'Colosseum');
const samePlace = (a, b) => Boolean(a && b && a.area === b.area && a.box === b.box && a.slot === b.slot);
const pokeName = id => dex?.get(id)?.name || `#${id}`;

function ball(extra = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', `tw-ball ${extra}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" stroke-width="4"/><path d="M4 32h19M41 32h19" stroke="currentColor" stroke-width="4"/><circle cx="32" cy="32" r="8" fill="none" stroke="currentColor" stroke-width="4"/>';
  return svg;
}

function stage(summary, size = 96) {
  const box = el('div', { className: 'tw-stage' }, sprite(summary, size));
  if (summary.shiny) box.append(el('span', { className: 'tw-shiny', textContent: '★', title: 'Shiny' }));
  return box;
}

function genderMark(summary) {
  const ts = TS(), species = names?.species?.[summary.species];
  const gender = ts && species ? ts.genderOf(summary.personality >>> 0, species.gender) : '';
  return gender === 'M' ? el('span', { className: 'm', textContent: ' ♂' }) : gender === 'F' ? el('span', { className: 'f', textContent: ' ♀' }) : null;
}

function copyCode(button) {
  navigator.clipboard?.writeText(tradeView?.room?.code || '').catch(() => {});
  copiedAt = Date.now();
  for (const each of [$('trade-copy'), button].filter(Boolean)) {
    each.textContent = 'Copied!';
    setTimeout(() => { each.textContent = 'Copy'; }, 1500);
  }
}

// One side's offer: the Pokémon, or what that side is waiting on.
let offerScale = 1;   // the bars' full length: the larger of the two offers' highest stat
function offerSide(side, room) {
  const mine = side === 'mine', peer = room.peer, you = room.you;
  const offer = mine ? you?.offer : peer?.offer, summary = offer?.summary || null;
  const ready = mine ? Boolean(you?.ready) : Boolean(peer?.ready);
  const problems = mine ? (you?.refusedBecause ? [`${peer?.name || 'Their'}'s game can't take it: ${you.refusedBecause}`] : [])
    : (offer?.problems || []).map(problem => problem.text || problem);
  const node = $(mine ? 'tw-mine' : 'tw-theirs');
  node.className = `tw-offer ${side}${ready && summary ? ' ready' : ''}${problems.length ? ' refused' : ''}`;
  // who
  const dot = mine ? 'here' : !peer?.here ? '' : peer.present ? 'here' : 'away';
  const who = el('div', { className: 'tw-who' }, el('i', { className: `tw-dot ${dot}` }),
    el('span', { textContent: mine ? `You${you?.name ? ` · ${you.name}` : ''}` : peer?.here ? peer.name || 'The other player' : 'Waiting for a player' }));
  const game = mine ? data?.game : peer?.here ? peer.game : null;
  if (game) who.append(el('small', { className: 'tw-game', textContent: gameLabel(game) }));
  const state = summary ? el('span', { className: `tw-state${ready ? ' ready' : ''}`, textContent: ready ? 'Ready ✓' : 'Not ready' }) : null;
  const more = summary ? el('button', { className: 'tw-more', type: 'button', textContent: 'Every stat ›' }) : null;
  more?.addEventListener('click', openStats);
  const children = [el('header', { className: 'tw-offer-head' }, who, el('span', { className: 'tw-offer-tools' }, more, state))];
  if (!summary) {
    const empty = el('div', { className: 'tw-empty' });
    if (mine) empty.append(ball(), el('strong', { textContent: 'Pick a Pokémon to offer' }),
      el('p', { textContent: 'Choose one from your party or boxes on the left. You can change it until you both ready up.' }));
    else if (!peer?.here) {
      const copy = el('button', { className: 'subtle', type: 'button', textContent: 'Copy' });
      copy.addEventListener('click', () => copyCode(copy));
      empty.append(ball('wait'), el('strong', { textContent: 'Waiting for someone to join' }), el('div', { className: 'tw-share' }, el('strong', { textContent: room.code || '…' }), copy),
        el('p', { textContent: 'Send this code to the player you\'re trading with. It works from Colosseum or XD.' }));
    } else if (!peer.present) empty.append(ball('wait'), el('strong', { textContent: `${peer.name || 'They'} lost their connection` }), el('p', { textContent: 'Waiting for them to come back…' }));
    else empty.append(ball('wait'), el('strong', { textContent: `${peer.name || 'They'} ${peer.name ? 'is' : 'are'} choosing…` }), el('p', { textContent: 'Their Pokémon shows here as soon as they pick it.' }));
    children.push(empty);
    node.replaceChildren(...children);
    return;
  }
  const evolves = !mine && offer.evolvesInto ? evolvePill(offer.evolvesInto, `Evolves into ${pokeName(offer.evolvesInto)} on arrival`) : null;
  children.push(...offerBody(summary, problems, evolves));
  node.replaceChildren(...children);
}

const evolvePill = (into, text) => el('span', { className: 'tw-evolve-pill', title: 'A trade evolution: it evolves as it arrives in the game' }, sprite({ species: into }, 24), text);

// An offer's Pokémon at a glance: who it is, its facts, stats and moves (problems: what keeps it from the other game).
function offerBody(summary, problems, evolves) {
  const children = [];
  const ts = TS(), species = names?.species?.[summary.species], entry = dex?.get(summary.species);
  const scale = offerScale;
  // the Pokémon
  const title = el('strong', {}, shown(summary), genderMark(summary));
  const types = el('div', { className: 'tw-types' }, ...(entry?.types || []).map(type => el('span', { className: 'pokedex-type', textContent: type })));
  for (const pill of types.children) pill.dataset.type = pill.textContent.toLowerCase();
  const from = summary.game ? ` · from ${gameLabel(summary.game)}` : '';
  children.push(el('div', { className: 'tw-hero' }, stage(summary, 96),
    el('div', { className: 'tw-name' }, title, el('small', { textContent: `${speciesName(summary)} · Lv. ${summary.level}${from}` }), types, evolves)));
  for (const problem of problems) children.push(el('div', { className: 'tw-banner problem', textContent: problem }));
  // facts
  const effect = ts?.natureEffect(summary.nature);
  const nature = el('dd', {}, NATURES[summary.nature] || '?');
  if (effect && effect.up !== effect.down && effect.up !== undefined && effect.up !== null) {
    nature.append(' ', el('span', { className: 'up', textContent: `+${SHORT[effect.up]}` }), ' ', el('span', { className: 'down', textContent: `−${SHORT[effect.down]}` }));
  }
  const abilities = species?.abilities || [], ability = abilities.find(a => a.slot === summary.abilitySlot) || abilities[0];
  const itemName = summary.heldKeyItem ? 'A key item' : summary.item ? (names?.items.get(summary.item) || `Item #${summary.item}`) : 'Nothing';
  const hidden = ts?.hiddenPower(summary.ivs);
  const fact = (term, value, title = '') => el('div', { title: [typeof value === 'string' ? value : value.textContent, title].filter(Boolean).join('\n') }, el('dt', { textContent: term }), typeof value === 'string' ? el('dd', { textContent: value }) : value);
  children.push(el('dl', { className: 'tw-facts' },
    fact('Nature', nature, ts ? ts.natureLabel(summary.nature) : ''),
    fact('Ability', ability?.name || '?', ability?.doc || ''),
    fact('Held item', itemName, summary.item ? names?.itemData.get(summary.item)?.doc || '' : ''),
    fact('Hidden Power', hidden ? `${hidden.type} ${hidden.power}` : '?'),
    fact('Trainer', `${summary.otName || '?'}${summary.otGender === 1 ? ' ♀' : summary.otGender === 0 ? ' ♂' : ''} · ${String(summary.otId).padStart(5, '0')}`),
    fact('Ball', BALLS[summary.ball] || 'Poké Ball')));
  // stats
  const stats = el('div', { className: 'tw-stats' }, el('div', { className: 'tw-stats-head' }, el('span', { textContent: 'Stat' }), el('span', { textContent: '' }), el('span', { textContent: '' }), el('span', { textContent: 'IV' }), el('span', { textContent: 'EV' })));
  SHORT.forEach((name, i) => {
    const bar = el('i');
    bar.style.width = `${Math.max(3, Math.min(100, (summary.stats[i] / scale) * 100))}%`;
    bar.style.setProperty('--c1', STAT_COLORS[i][0]); bar.style.setProperty('--c2', STAT_COLORS[i][1]);
    stats.append(el('div', { className: 'tw-stat' }, el('b', { className: effect?.up === i && effect.up !== effect.down ? 'up' : effect?.down === i && effect.up !== effect.down ? 'down' : '', textContent: name }),
      el('span', { className: 'value', textContent: i === 0 ? `${summary.hp}/${summary.stats[0]}` : String(summary.stats[i]) }),
      el('span', { className: 'tw-bar-track' }, bar),
      el('span', { className: `iv${summary.ivs[i] === 31 ? ' max' : ''}`, textContent: String(summary.ivs[i]) }), el('span', { className: 'ev', textContent: String(summary.evs[i]) })));
  });
  const total = list => list.reduce((a, v) => a + (Number(v) || 0), 0);
  stats.append(el('div', { className: 'tw-stats-foot' }, el('span', { textContent: `Total ${total(summary.stats)}${entry?.stats ? ` · base ${total(entry.stats)}` : ''}` }),
    el('span', { textContent: `IVs ${total(summary.ivs)}/186 · EVs ${total(summary.evs)}/510` })));
  children.push(stats);
  // moves
  const moves = el('div', { className: 'tw-moves' });
  for (let i = 0; i < 4; i++) {
    const move = summary.moves[i];
    if (!move) { moves.append(el('div', { className: 'tw-move none' }, el('strong', { textContent: '—' }), el('small', { textContent: ' ' }))); continue; }
    const info = names?.moveData.get(move.id);
    const most = info?.pp ? Math.floor(info.pp * (5 + move.ppUps) / 5) : null;
    const tile = el('div', { className: 'tw-move', title: info?.doc || '' }, el('strong', { textContent: info?.name || `Move #${move.id}` }),
      el('small', {}, el('span', { textContent: `${info?.type || '?'}${info?.power ? ` · ${info.power}` : ''}` }), el('span', { textContent: `PP ${most !== null ? `${move.pp}/${most}` : move.pp}` })));
    if (info?.type) tile.dataset.type = info.type.toLowerCase();
    moves.append(tile);
  }
  children.push(moves);
  return children;
}

function offerProblem(pokemon) {
  if (pokemon.egg) return 'Eggs can\'t be traded.';
  if (pokemon.shadow) return 'Purify it first: Shadow Pokémon go to Shadowtrade instead.';
  if (pokemon.area === 'party' && !data.model.party.some(each => each && each.key !== pokemon.key && !each.egg && each.hp > 0))
    return 'You can\'t trade your last Pokémon that can battle.';
  return null;
}

function renderPicker(room) {
  $('tw-game-switch').hidden = true;
  $('tw-picker-title').textContent = 'Your Pokémon';
  const busy = Boolean(room.trade);
  if (busy) twNote = null;
  renderPickerGrid({ model: data?.model, offered: busy ? null : room.you?.offer?.place, busy, problemOf: offerProblem,
    pick: pokemon => { if (room.last) dismissed = room.last.tradeId; tradeAction('offer', { area: pokemon.area, box: pokemon.box, slot: pokemon.slot }); } });
  renderPickNote(room);
}

// The party or a box of a save to pick from: model (its party and boxes), offered (the place picked), problemOf(pokemon)
function renderPickerGrid({ model, offered, busy, problemOf, pick }) {
  const boxes = model?.boxes || [];
  if (twBox >= boxes.length) twBox = 0;
  $('tw-tab-party').setAttribute('aria-selected', String(twTab === 'party'));
  $('tw-tab-boxes').setAttribute('aria-selected', String(twTab === 'boxes'));
  $('tw-box-bar').hidden = twTab !== 'boxes' || !boxes.length;
  if (boxes[twBox]) $('tw-box-name').textContent = `${boxes[twBox].name} · ${boxes[twBox].pokemon.filter(Boolean).length}/${boxes[twBox].pokemon.length}`;
  const grid = $('tw-grid');
  grid.classList.toggle('boxes', twTab === 'boxes');
  const list = !model ? [] : twTab === 'party' ? model.party : boxes[twBox]?.pokemon || [];
  grid.replaceChildren(...list.map(pokemon => {
    const button = el('button', { type: 'button', className: 'tw-pick' });
    button.setAttribute('role', 'option');
    if (!pokemon) { button.classList.add('empty'); button.disabled = true; button.setAttribute('aria-label', 'Empty'); return button; }
    const problem = problemOf(pokemon), isOffered = samePlace(offered, pokemon);
    button.classList.toggle('blocked', Boolean(problem));
    button.classList.toggle('offered', isOffered);
    button.classList.toggle('shadow', Boolean(pokemon.shadow));
    button.setAttribute('aria-selected', String(isOffered));
    button.disabled = busy;
    button.title = `${shown(pokemon)}, Lv. ${pokemon.level}${problem ? ` — ${problem}` : isOffered ? ' — your offer' : ''}`;
    button.append(sprite(pokemon, twTab === 'party' ? 44 : 40));
    if (twTab === 'party') button.append(el('span', {}, el('strong', { textContent: shown(pokemon) }), el('small', { textContent: pokemon.egg ? 'Egg' : `Lv. ${pokemon.level}` })));
    button.addEventListener('click', () => {
      if (problem) { twNote = { text: `${shown(pokemon)}: ${problem}`, problem: true }; renderTradePanel(); return; }
      if (isOffered) return;
      twNote = null;
      pick(pokemon);
    });
    return button;
  }));
}

function renderPickNote(room) {
  const note = $('tw-pick-note');
  const text = room.trade ? 'A trade is under way: your Pokémon stay put until it\'s done.'
    : twNote?.text || (room.you?.offer ? 'Click another to offer it instead.' : 'Click a Pokémon to offer it.');
  note.textContent = text;
  note.classList.toggle('problem', Boolean(!room.trade && twNote?.problem));
}

function renderSteps(room, showing) {
  const both = Boolean(room.you?.offer && room.peer?.offer);
  const at = showing === 'done' ? 3 : room.trade ? 2 : both ? 1 : 0;
  for (const [i, li] of [...$('trade-steps').children].entries()) {
    li.classList.toggle('done', i < at || (showing === 'done' && i === 3));
    li.classList.toggle('now', i === at && showing !== 'done');
  }
}

function tradeProgress(room) {
  const trade = room.trade;
  if (trade.message) return trade.message;
  if (trade.mine && TRADE_STAGE[trade.mine]) return TRADE_STAGE[trade.mine] + (data?.source === 'live' && ['taking', 'giving', 'evolving'].includes(trade.mine) ? ' The game does it at a quiet moment in the field and saves.' : '');
  if (trade.stage === 'returned' || trade.stage === 'aborted') return 'The trade was called off: your Pokémon is coming back to you.';
  return 'Both ready: trading…';
}

// What's over the offers: the swap while a trade runs, and how it went once it's done (null: nothing).
function renderOverlay(room, view) {
  const overlay = $('tw-overlay');
  const trade = room.trade;
  if (trade) {
    const entry = view.journal.find(each => each.tradeId === trade.tradeId);
    if (!tradeCache || tradeCache.tradeId !== (trade.tradeId || tradeCache.tradeId)) tradeCache = { tradeId: trade.tradeId };
    tradeCache.mine = room.you?.offer?.summary || entry?.sent || tradeCache.mine;
    tradeCache.theirs = room.peer?.offer?.summary || entry?.received || tradeCache.theirs;
    tradeCache.evolvesInto = room.peer?.offer?.evolvesInto || entry?.evolvesInto || tradeCache.evolvesInto || 0;
    const steps = ['Sending yours', 'Receiving theirs', 'Saving', ...(tradeCache.evolvesInto ? ['Evolving'] : [])];
    const at = { taking: 0, taken: 1, received: 2, giving: 2, given: tradeCache.evolvesInto ? 3 : 4, evolving: 3 }[trade.mine] ?? 0;
    const pair = el('div', { className: 'tw-swapping moving' });
    if (tradeCache.mine) pair.append(el('div', { className: 'a' }, stage(tradeCache.mine, 84)));
    pair.append(el('div', { className: 'tw-link' }));
    if (tradeCache.theirs) pair.append(el('div', { className: 'b' }, stage(tradeCache.theirs, 84)));
    const called = trade.stage === 'returned' || trade.stage === 'aborted';
    overlay.replaceChildren(el('div', { className: 'tw-moment' }, el('h3', { textContent: called ? 'Calling the trade off…' : `Trading with ${room.peer?.name || 'the other player'}…` }), pair,
      called ? null : el('ol', { className: 'tw-track' }, ...steps.map((text, i) => el('li', { className: i < at ? 'done' : i === at ? 'now' : '', textContent: text }))),
      el('p', { textContent: tradeProgress(room) })));
    overlay.hidden = false;
    return 'trade';
  }
  const last = room.last;
  if (!last || last.tradeId === dismissed) { overlay.hidden = true; return null; }
  const button = el('button', { className: 'tw-ready', type: 'button', textContent: last.outcome === 'traded' ? 'Trade again' : 'OK' });
  button.addEventListener('click', () => { dismissed = last.tradeId; renderTradePanel(); });
  if (last.outcome !== 'traded') {
    const why = last.reason && last.reason !== 'cancelled' ? ` (${last.reason === 'timeout' ? 'a game took too long' : last.reason})` : '';
    overlay.replaceChildren(el('div', { className: 'tw-moment' }, el('h3', { textContent: 'Trade called off' }), el('p', { textContent: `The trade didn't happen${why}. Your Pokémon stays yours.` }), button));
    overlay.hidden = false;
    return 'off';
  }
  const pending = view.journal.find(each => each.tradeId === last.tradeId), done = view.history.find(each => each.tradeId === last.tradeId);
  const got = pending?.received || done?.received || tradeCache?.theirs || null;
  const sent = pending?.sent || done?.sent || tradeCache?.mine || null;
  const into = done?.evolvedInto || pending?.evolvesInto || 0;
  const from = pending?.from || done?.from || room.peer?.name || 'the other player';
  const picture = el('div', { className: 'tw-got' });
  let text;
  const waitsToEvolve = Boolean(into) && (pending?.stage === 'evolving' || (done && done.evolved === false));
  if (got && into && done && !waitsToEvolve) {
    picture.append(el('div', { className: 'tw-stage small' }, sprite(got, 60)), el('span', { className: 'tw-arrow', textContent: '›' }), stage({ ...got, species: into }, 112));
    text = `${shown(got)} from ${from} evolved into ${pokeName(into)}! It's in your save.`;
  } else if (got) {
    picture.append(stage(got, 112));
    if (waitsToEvolve) picture.append(el('span', { className: 'tw-arrow', textContent: '›' }), el('div', { className: 'tw-stage small later', title: `${pokeName(into)}, once it evolves` }, sprite({ species: into }, 60)));
    text = waitsToEvolve
      ? (data?.source === 'live' ? `${shown(got)} from ${from} is in your save. Watch your game: it evolves into ${pokeName(into)} there.` : `${shown(got)} from ${from} is in your save. It evolves into ${pokeName(into)} the next time you play from the launcher.`)
      : pending ? `${shown(got)} from ${from} is on its way into your save…` : `${shown(got)} from ${from} is in your save.`;
  } else text = 'The trade is done.';
  overlay.replaceChildren(el('div', { className: 'tw-moment' }, el('h3', { textContent: 'Trade complete!' }), picture,
    el('p', { textContent: text }), sent ? el('p', { textContent: `${shown(sent)} went to ${from}.` }) : null, button));
  overlay.hidden = false;
  return 'done';
}

function footStatus(room) {
  const you = room.you, peer = room.peer, theirs = peer?.offer, name = peer?.name || 'the other player';
  if (room.connection === 'reconnecting') return ['Reconnecting to the trade room…'];
  if (room.trade) return [tradeProgress(room)];
  if (!peer?.here) return [room.last ? 'The other player has left. Share the code to trade with someone else, or leave the room.' : 'Share the trade code. Everything fills in once they join.'];
  if (!peer.present) return [`${peer.name || 'The other player'} lost their connection. Their place is kept for a minute.`];
  if (!you?.offer) return [theirs ? `${peer.name || 'They'} offered ${shown(theirs.summary)}. Pick yours on the left.` : 'Pick a Pokémon on the left to offer it.'];
  if (you.refusedBecause) return [`${peer.name || 'Their'}'s game can't take ${shown(you.offer.summary)}: ${you.refusedBecause}. Pick another.`, true];
  if (!theirs) return [`Waiting for ${name} to pick.`];
  if (theirs.problems?.length) return [`Your game can't take ${shown(theirs.summary)}: ${theirs.problems[0].text || theirs.problems[0]}`, true];
  if (you.accepted === null) return [`Waiting for ${name}'s launcher to check your offer…`];
  if (you.ready && !peer.ready) return [`You're ready. Waiting for ${name} to ready up…`];
  if (peer.ready && !you.ready) return [`${peer.name || 'They'} ${peer.name ? 'is' : 'are'} ready! Look it over and ready up to trade.`];
  return ['Look both over, then ready up. Changing either offer takes both of you out of ready.'];
}

function renderTradeWindow(view) {
  const room = view.room;
  $('trade-code').textContent = room.code || '…';
  const offers = [room.you?.offer?.summary, room.peer?.offer?.summary].filter(Boolean);
  const scale = Math.max(1, ...offers.flatMap(summary => summary.stats));
  offerScale = scale;
  offerSide('mine', room);
  offerSide('theirs', room);
  renderPicker(room);
  const showing = renderOverlay(room, view);
  renderSteps(room, showing);
  const [status, problem] = footStatus(room);
  $('trade-progress').textContent = status;
  $('trade-progress').classList.toggle('problem', Boolean(problem));
  const you = room.you, peer = room.peer;
  const ready = $('trade-ready');
  ready.textContent = room.trade ? 'Trading…' : you?.ready ? 'Ready ✓  Undo' : peer?.ready && room.canReady ? 'Ready — let\'s trade!' : 'Ready to trade';
  ready.title = you?.ready ? 'Take your ready back' : '';
  ready.disabled = Boolean(room.trade) || (!you?.ready && !room.canReady);
  ready.classList.toggle('pressed', Boolean(you?.ready) && !room.trade);
  $('trade-withdraw').hidden = !you?.offer || Boolean(room.trade);
  $('trade-compare').hidden = !offers.length;
  $('trade-leave').disabled = Boolean(room.trade);
  $('trade-leave').title = room.trade ? 'You can leave once the trade is done' : '';
}

function renderTradeStart(view) {
  $('trade-notice').hidden = !view?.notice;
  $('trade-notice').textContent = view?.notice || '';
  // trades still on their way (from a room that has closed, or the game closed)
  const pending = (view?.journal || []).filter(entry => entry.game === data?.game);
  $('trade-journal').replaceChildren(...pending.map(entry => el('div', { className: 'shadowtrade-row trade-pending' }, sprite(entry.received && !entry.returned ? entry.received : entry.sent, 30),
    el('div', {}, el('strong', { textContent: entry.received && !entry.returned ? `${shown(entry.received)} from ${entry.from || 'another player'}` : `Trading ${shown(entry.sent)}` }),
      el('small', { textContent: entry.message || TRADE_STAGE[entry.stage] || entry.stage })))));
  const history = (view?.history || []).filter(item => item.game === data?.game).slice(0, 6);
  $('trade-history').replaceChildren(...history.map(item => {
    if (item.returned || !item.received) return el('li', {}, sprite(item.sent, 30), el('span', {}, el('b', { textContent: shown(item.sent) }), ' came back (the trade was called off)'));
    const evolved = item.evolvedInto && item.evolved !== false;
    const got = evolved ? { ...item.received, species: item.evolvedInto } : item.received;
    return el('li', { title: item.at ? new Date(item.at).toLocaleString() : '' }, sprite(item.sent, 30), el('span', { className: 'arrow', textContent: '⇄' }), sprite(got, 30),
      el('span', {}, el('b', { textContent: shown(item.sent) }), ' for ', el('b', { textContent: shown(item.received) }), ` from ${item.from || 'another player'}${evolved ? `, now ${pokeName(item.evolvedInto)}` : item.evolvedInto ? `, evolves when you next play` : ''}`));
  }));
  $('trade-history-title').hidden = !history.length;
}


// ---- Trades between your games: the trade window with your Colosseum save on one side and your XD save on the other ----
// (src/local-trades.js). The picker shows one save at a time (the switch above it); each side's card is the Pokémon
// picked from that save, every stat, and what it becomes in the other game. Trade swaps them; each game shows its new one.
const isLocal = () => Boolean(localView?.open && !tradeView?.room);
const localModel = () => (isLocal() ? localView.saves[localSide]?.model : data?.model);
const otherOf = game => (game === 'xd' ? 'colosseum' : 'xd');

function localCard(game, view) {
  const viewer = view.viewer, node = $(game === viewer ? 'tw-mine' : 'tw-theirs');
  const save = view.saves[game], pick = view.picks[game], summary = pick?.summary || null, trade = view.trade;
  node.className = `tw-offer ${game === viewer ? 'mine' : 'theirs'}${pick?.problems.length ? ' refused' : ''}${localSide === game && !trade ? ' choosing' : ''}`;
  const who = el('div', { className: 'tw-who' }, el('i', { className: `tw-dot ${save.source === 'live' ? 'here' : save.ready ? 'away' : ''}` }),
    el('span', { textContent: `${gameLabel(game)}${save.trainer ? ` · ${save.trainer}` : ''}`, title: `Your ${gameLabel(game)} save` }),
    el('small', { className: 'tw-game', textContent: save.source === 'live' ? 'Running' : 'Save' }));
  const tools = el('span', { className: 'tw-offer-tools' });
  if (summary) {
    const more = el('button', { className: 'tw-more', type: 'button', textContent: 'Every stat ›' });
    more.addEventListener('click', openStats);
    tools.append(more);
  }
  if (summary && !trade) {
    const change = el('button', { className: 'tw-change', type: 'button', textContent: 'Change' });
    change.addEventListener('click', () => { localSide = game; renderTradePanel(); });
    tools.append(change);
  }
  const children = [el('header', { className: 'tw-offer-head' }, who, tools)];
  if (!summary) {
    const empty = el('div', { className: 'tw-empty' }, ball(save.ready ? '' : 'wait'),
      el('strong', { textContent: save.ready ? `Pick from your ${gameLabel(game)} save` : `Your ${gameLabel(game)} save can't trade now` }),
      el('p', { textContent: save.ready ? `Its party and boxes are on the left${localSide === game ? '' : ' once you switch to it'}. It goes to your ${gameLabel(otherOf(game))} save.` : save.notice }));
    if (save.ready && localSide !== game) {
      const show = el('button', { className: 'subtle', type: 'button', textContent: `Show ${gameLabel(game)}'s Pokémon` });
      show.addEventListener('click', () => { localSide = game; renderTradePanel(); });
      empty.append(show);
    }
    children.push(empty);
    node.replaceChildren(...children);
    return;
  }
  const into = pick.evolvesInto;
  const evolves = into ? evolvePill(into, `Evolves into ${pokeName(into)} in ${gameLabel(otherOf(game))}`) : null;
  children.push(...offerBody(summary, pick.problems.map(text => `${gameLabel(otherOf(game))} can't take it: ${text}`), evolves));
  node.replaceChildren(...children);
}

function renderLocalPicker(view) {
  const games = [view.viewer, view.other];
  if (!localSide || !view.saves[localSide]?.ready) localSide = games.find(game => view.saves[game].ready && !view.picks[game]) || games.find(game => view.saves[game].ready) || view.viewer;
  $('tw-game-switch').hidden = false;
  // the chosen game's save first
  const switcher = $('tw-game-switch');
  for (const game of games) {
    const button = $(`tw-game-${game}`);
    switcher.append(button);
    button.setAttribute('aria-selected', String(localSide === game));
    button.classList.toggle('picked', Boolean(view.picks[game]));
    button.disabled = !view.saves[game].ready;
  }
  const save = view.saves[localSide];
  $('tw-picker-title').textContent = `${save.trainer ? `${save.trainer}'s` : 'Your'} ${gameLabel(localSide)} Pokémon`;
  const busy = Boolean(view.trade);
  if (busy) twNote = null;
  const game = localSide;
  renderPickerGrid({ model: save.model, offered: view.picks[game]?.place, busy, problemOf: pokemon => pokemon.tradeProblem,
    pick: async pokemon => {
      await localAction('pick', { game, place: { area: pokemon.area, box: pokemon.box, slot: pokemon.slot } });
      // then the other save, if nothing's picked there yet
      const next = otherOf(game);
      if (localView?.picks[game] && !localView.picks[next] && localView.saves[next]?.ready) { localSide = next; twTab = 'party'; twBox = 0; renderTradePanel(); }
    } });
  const note = $('tw-pick-note');
  note.textContent = busy ? 'A trade is under way: your Pokémon stay put until it\'s done.'
    : twNote?.text || (view.picks[game] ? 'Click another to pick it instead.' : `Click a Pokémon to send it to your ${gameLabel(otherOf(game))} save.`);
  note.classList.toggle('problem', Boolean(!busy && twNote?.problem));
}

// what's over the two cards: the swap while it runs, how it went once it's done
function renderLocalOverlay(view) {
  const overlay = $('tw-overlay'), trade = view.trade;
  if (trade) {
    const [a, b] = trade.sides;
    const at = a.given && b.given ? 3 : a.taken && b.taken ? 2 : a.taken || b.taken ? 1 : 0;
    const steps = trade.sides.map(side => `Out of ${gameLabel(side.game)}`).concat(['Into both saves']);
    const pair = el('div', { className: 'tw-swapping moving' }, el('div', { className: 'a' }, stage(a.sent, 84)), el('div', { className: 'tw-link' }), el('div', { className: 'b' }, stage(b.sent, 84)));
    const live = trade.sides.find(side => side.live);
    const text = trade.message || (live && (!live.taken || !live.given) ? `${gameLabel(live.game)} does its part at a quiet moment in the field, and saves.` : 'Trading…');
    overlay.replaceChildren(el('div', { className: 'tw-moment' }, el('h3', { textContent: trade.stage === 'returning' ? 'Putting them back…' : 'Trading between your games…' }), pair,
      trade.stage === 'returning' ? null : el('ol', { className: 'tw-track' }, ...steps.map((step, i) => el('li', { className: i < at ? 'done' : i === at ? 'now' : '', textContent: step }))),
      el('p', { textContent: text })));
    overlay.hidden = false;
    return 'trade';
  }
  const last = view.last;
  if (!last || last.tradeId === dismissed) { overlay.hidden = true; return null; }
  const again = el('button', { className: 'tw-ready', type: 'button', textContent: last.returned ? 'OK' : 'Trade again' });
  again.addEventListener('click', () => { dismissed = last.tradeId; renderTradePanel(); });
  if (last.returned) {
    overlay.replaceChildren(el('div', { className: 'tw-moment' }, el('h3', { textContent: 'Trade called off' }),
      el('p', { textContent: `${last.reason || 'The trade didn\'t happen.'} Both Pokémon are where they were.` }), again));
    overlay.hidden = false;
    return 'off';
  }
  // each save, and what it got: the chosen game's first
  const sides = [...last.sides].sort((x, y) => (x.game === view.viewer ? -1 : 0) - (y.game === view.viewer ? -1 : 0));
  const pair = el('div', { className: 'tw-got-pair' }, ...sides.map(side => {
    const got = side.received, into = side.evolvesInto, evolved = into && side.evolved;
    const picture = el('div', { className: 'tw-got' });
    if (evolved) picture.append(el('div', { className: 'tw-stage small' }, sprite(got, 52)), el('span', { className: 'tw-arrow', textContent: '›' }), stage({ ...got, species: into }, 96));
    else {
      picture.append(stage(got, 96));
      if (into) picture.append(el('span', { className: 'tw-arrow', textContent: '›' }), el('div', { className: 'tw-stage small later', title: `${pokeName(into)}, once it evolves` }, sprite({ species: into }, 52)));
    }
    const game = gameLabel(side.game);
    // a Pokémon called by its species' name takes the new one when it evolves, as in the game
    const name = evolved && shown(got) === speciesName(got) ? pokeName(into) : shown(got);
    const line = evolved ? `It evolved from ${speciesName(got)}!`
      : into ? (side.live ? `Watch ${game}: it evolves into ${pokeName(into)} there.` : `It evolves into ${pokeName(into)} the next time you play ${game}.`)
        : side.live ? `${game} shows it now.` : `${game} shows it the next time you play.`;
    return el('div', { className: 'tw-got-side' }, picture, el('strong', { textContent: `${name} is in your ${game} save` }), el('small', { textContent: line }));
  }));
  overlay.replaceChildren(el('div', { className: 'tw-moment' }, el('h3', { textContent: 'Trade complete!' }), pair, again));
  overlay.hidden = false;
  return 'done';
}

function localFoot(view) {
  if (localError) return [localError, true];
  if (view.trade) return [view.trade.message || 'Trading…'];
  const [a, b] = [view.viewer, view.other], pa = view.picks[a], pb = view.picks[b];
  for (const game of [a, b]) if (!view.saves[game].ready) return [view.saves[game].notice, true];
  for (const game of [a, b]) if (view.picks[game]?.problems.length) return [`${gameLabel(otherOf(game))} can't take ${shown(view.picks[game].summary)}: ${view.picks[game].problems[0]}`, true];
  if (!pa && !pb) return ['Pick a Pokémon from each save. Each goes to the other game.'];
  if (!pa || !pb) return [`Now pick one from your ${gameLabel(pa ? b : a)} save.`];
  return [`Look both over, then trade: ${shown(pa.summary)} goes to ${gameLabel(b)}, ${shown(pb.summary)} comes to ${gameLabel(a)}.`];
}

function renderLocalWindow(view) {
  $('tw-code').hidden = true;
  $('tw-local-title').hidden = false;
  $('tw-local-games').textContent = `${gameLabel(view.viewer)} ⇄ ${gameLabel(view.other)}`;
  $('trade-steps').children[1].lastChild.textContent = 'Look over';
  const offers = [view.picks[view.viewer]?.summary, view.picks[view.other]?.summary].filter(Boolean);
  offerScale = Math.max(1, ...offers.flatMap(summary => summary.stats));
  localCard(view.viewer, view);
  localCard(view.other, view);
  renderLocalPicker(view);
  const showing = renderLocalOverlay(view);
  const both = Boolean(view.picks[view.viewer] && view.picks[view.other]);
  const at = showing === 'done' ? 3 : view.trade || localBusy ? 2 : both ? 1 : 0;
  for (const [i, li] of [...$('trade-steps').children].entries()) {
    li.classList.toggle('done', i < at || (showing === 'done' && i === 3));
    li.classList.toggle('now', i === at && showing !== 'done');
  }
  const [status, problem] = localFoot(view);
  $('trade-progress').textContent = status;
  $('trade-progress').classList.toggle('problem', Boolean(problem));
  const ready = $('trade-ready'), pa = view.picks[view.viewer], pb = view.picks[view.other];
  ready.textContent = view.trade || localBusy ? 'Trading…' : pa && pb ? `Trade ${shown(pa.summary)} for ${shown(pb.summary)}` : 'Trade';
  ready.title = '';
  ready.disabled = Boolean(view.trade) || localBusy || !view.canTrade;
  ready.classList.remove('pressed');
  $('trade-withdraw').hidden = !view.picks[localSide] || Boolean(view.trade);
  $('trade-withdraw').textContent = 'Put back';
  $('trade-compare').hidden = !offers.length;
  $('trade-leave').textContent = 'Close';
  $('trade-leave').disabled = Boolean(view.trade) || localBusy;
  $('trade-leave').title = view.trade ? 'You can close it once the trade is done' : '';
}

// the online room's own labels, back from the local window's
function onlineLabels() {
  $('tw-code').hidden = false;
  $('tw-local-title').hidden = true;
  $('trade-steps').children[1].lastChild.textContent = 'Ready';
  $('trade-withdraw').textContent = 'Take back';
  $('trade-leave').textContent = 'Leave room';
}

async function localAction(action, value) {
  localError = null;
  if (action === 'trade') { localBusy = true; renderTradePanel(); }
  try { localView = await window.colo.localTrade(action, value); setStatus(''); } catch (error) {
    if (action === 'open') setStatus(message(error));
    else localError = message(error);
  } finally { if (action === 'trade') localBusy = false; }
  renderTradePanel();
}

function renderLocalStart(view) {
  const button = $('trade-local-open'), other = view?.other || (data?.game === 'xd' ? 'colosseum' : 'xd');
  $('trade-local-label').textContent = `Trade with your ${gameLabel(other)} save`;
  const blocked = view ? [view.viewer, view.other].map(game => view.saves[game]).find(save => !save.ready) : null;
  button.disabled = !view || Boolean(blocked);
  $('trade-local-note').textContent = blocked ? blocked.notice : `Swap a Pokémon between your ${gameLabel(view?.viewer || data?.game)} and ${gameLabel(other)} saves, no one else needed. Trade evolutions happen in the game it goes to.`;
}

function renderTradePanel() {
  const view = tradeView, room = view?.room, local = isLocal();
  const page = $('page-pokemon');
  page.classList.toggle('trading', Boolean(room) || local);
  $('trade-window').hidden = !room && !local;
  renderTradeStart(view);
  renderLocalStart(localView);
  if (room) { onlineLabels(); renderTradeWindow(view); }
  else if (local) renderLocalWindow(localView);
  else { tradeCache = null; if ($('trade-stats').open) $('trade-stats').close(); }
  if ($('trade-stats').open) renderStats();
}

async function tradeAction(action, value) {
  try {
    tradeView = await window.colo.onlineTrade(action, value);
    setStatus('');
  } catch (error) { setStatus(message(error)); }
  renderTradePanel();
}

function show() {
  visible = true;
  refresh();
  window.colo.shadowtradeSync().then(refresh).catch(() => {});
  tradeNames().then(() => Promise.all([window.colo.onlineTrade('view'), window.colo.localTrade('view')]))
    .then(([view, local]) => { tradeView = view; localView = local; renderTradePanel(); }).catch(() => {});
}
function hide() { visible = false; }

$('pokemon-tab-party').addEventListener('click', () => { tab = 'party'; render(); });
$('pokemon-tab-boxes').addEventListener('click', () => { tab = 'boxes'; render(); });
$('pokemon-box').addEventListener('change', event => { box = Number(event.target.value); render(); });
$('pokemon-box-prev').addEventListener('click', () => { const n = data?.model?.boxes.length || 1; box = (box + n - 1) % n; render(); });
$('pokemon-box-next').addEventListener('click', () => { const n = data?.model?.boxes.length || 1; box = (box + 1) % n; render(); });
$('pokemon-refresh').addEventListener('click', () => { setStatus(''); refresh(); window.colo.shadowtradeSync().then(refresh).catch(error => setStatus(message(error))); });
$('pokemon-trade').addEventListener('click', trade);
$('shadowtrade-confirm-send').addEventListener('click', confirmTrade);
window.colo.onPokemonChanged(() => {
  if (!visible) return;
  refresh();
  // the trade window's saves too (the running game's changes as it's played)
  if (localView?.open) window.colo.localTrade('view').then(view => { localView = view; renderTradePanel(); }).catch(() => {});
});
window.colo.onShadowtrade(view => { if (data) { data.trades = view; if (visible) { renderTrades(); renderDetail(); } } });
window.colo.onShadowtradeWaiting(() => { waitingGame = true; if (visible) renderTrades(); });
$('trade-host').addEventListener('click', () => tradeAction('open'));
$('trade-join-form').addEventListener('submit', event => { event.preventDefault(); tradeAction('open', $('trade-join-code').value); });
$('trade-copy').addEventListener('click', () => copyCode(null));
$('trade-ready').addEventListener('click', () => (isLocal() ? localAction('trade') : tradeAction(tradeView?.room?.you?.ready ? 'unready' : 'ready')));
$('trade-withdraw').addEventListener('click', () => { twNote = null; if (isLocal()) localAction('pick', { game: localSide, place: null }); else tradeAction('offer', null); });
$('trade-leave').addEventListener('click', () => { if (isLocal()) { localSide = null; dismissed = null; localAction('close'); } else tradeAction('leave'); });
$('trade-local-open').addEventListener('click', () => { localSide = null; twTab = 'party'; twBox = 0; twNote = null; localAction('open'); });
for (const game of ['colosseum', 'xd']) $(`tw-game-${game}`).addEventListener('click', () => { localSide = game; twTab = 'party'; twBox = 0; twNote = null; renderTradePanel(); });
$('trade-compare').addEventListener('click', openStats);
$('tw-tab-party').addEventListener('click', () => { twTab = 'party'; twNote = null; renderTradePanel(); });
$('tw-tab-boxes').addEventListener('click', () => { twTab = 'boxes'; twNote = null; renderTradePanel(); });
$('tw-box-prev').addEventListener('click', () => { const n = localModel()?.boxes.length || 1; twBox = (twBox + n - 1) % n; renderTradePanel(); });
$('tw-box-next').addEventListener('click', () => { const n = localModel()?.boxes.length || 1; twBox = (twBox + 1) % n; renderTradePanel(); });
window.colo.onLocalTrades(view => {
  localView = view;
  // a trade moved on: the chosen game's save changed
  const progress = JSON.stringify([view.trade ? view.trade.sides.map(side => `${side.taken}${side.given}`) : null, view.history[0]?.tradeId || null]);
  if (localSeen !== null && progress !== localSeen && visible) refresh();
  localSeen = progress;
  if (visible) renderTradePanel();
});
window.colo.onOnlineTrades(view => {
  tradeView = view;
  // a trade moved on (a Pokémon left the save, or came into it): the save changed
  const progress = JSON.stringify([view.journal.map(entry => `${entry.tradeId}:${entry.stage}`), view.history[0]?.tradeId || null]);
  if (tradeHistorySeen !== null && progress !== tradeHistorySeen && visible) refresh();
  tradeHistorySeen = progress;
  if (visible) renderTradePanel();
});

window.coloPokemon = { show, hide, refresh };
