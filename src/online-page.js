// Online: the player's parties, the room list, and making or joining a room. The rooms and the
// game itself are the main process's (src/online.js); this page shows them and asks.
(() => {
  const $ = id => document.getElementById(id);
  const PARTY_SIZE = 6, MAX_PARTIES = 32, STORY = 'story', NO_ROOMS = 'No rooms are open. Create one and wait for a challenger.';
  const REFRESH_REST = 3000; // ms before Refresh works again: the server's list is this old at best
  const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  let state = null, setup = null, rooms = null, loaded = false, customOpen = false, picking = [], pickTimer = null;
  const builder = () => window.coloTeamBuilder;
  const F = window.coloFormats;

  // The sprites and names come with the team builder's Pokédex, read from the disc once.
  function loadSpecies() {
    builder().load().then(() => { loaded = Boolean(builder().data()); if (setup) render(); if (rooms) renderRooms(); });
  }

  function sprite(id, size) {
    const image = builder().sprite(id, size);
    image.title = builder().speciesName(id);
    return image;
  }

  function save() {
    window.colo.onlineSave(setup).then(next => { state = next; render(); }).catch(error => showResult(message(error)));
  }

  // --- Parties
  // How many each the chosen party can take: a Story party can be short of six.
  function partyCount() {
    return setup.selected === STORY ? state.story.members.length : PARTY_SIZE;
  }

  // The save's own party, first and set apart: chosen like the others, never edited here.
  function storyCard() {
    const story = state.story;
    const count = story.members.length;
    const card = Object.assign(document.createElement('div'), { className: 'party-card story-card' });
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(setup.selected === STORY));
    const usable = story.supported && !story.error && count >= 3;
    card.setAttribute('aria-disabled', String(!usable));
    card.tabIndex = usable ? 0 : -1;
    const name = Object.assign(document.createElement('strong'), { textContent: 'Story party' });
    const badge = Object.assign(document.createElement('span'), { className: 'story-badge', textContent: 'From your save' });
    const team = Object.assign(document.createElement('div'), { className: 'party-card-team story-team' });
    team.append(...story.members.map(member => {
      const slot = Object.assign(document.createElement('span'), { className: `story-member${member.shiny ? ' shiny' : ''}` });
      const species = builder().speciesName(member.species);
      slot.title = `${member.nickname || species || 'Pokémon'}${species && member.nickname !== species.toUpperCase() ? ` (${species})` : ''}, Lv ${member.level} in your save${member.shiny ? ', shiny' : ''}`;
      slot.append(sprite(member.species, 36), Object.assign(document.createElement('small'), { textContent: `Lv${member.level}` }));
      return slot;
    }));
    for (let i = count; i < PARTY_SIZE; i++) team.append(Object.assign(document.createElement('span'), { textContent: '–' }));
    card.append(name, badge, team);
    const note = !story.supported ? 'Update the game from the Play page to battle with your Story party.'
      : story.error ? `Your save can't be read: ${story.error}`
      : !count && !story.leftOut && !story.packsLeftOut ? 'Play and save the game, and the party you travel with shows here.'
      : count < 3 ? `${count} Pokémon can battle: you need at least 3.`
      : `${story.trainer ? `${story.trainer}'s team, ` : ''}with their moves, natures and held items, at the room's level.`;
    const detail = Object.assign(document.createElement('small'), { className: usable ? 'story-note' : '', textContent: note });
    card.append(detail);
    if (story.leftOut)
      card.append(Object.assign(document.createElement('small'), { className: 'story-note', textContent: `${story.leftOut === 1 ? 'A Shadow Pokémon stays' : `${story.leftOut} Shadow Pokémon stay`} home until purified.` }));
    if (story.packsLeftOut)
      card.append(Object.assign(document.createElement('small'), { className: 'story-note', textContent: `${story.packsLeftOut === 1 ? 'A Pokémon from a Pokémon pack stays' : `${story.packsLeftOut} Pokémon from Pokémon packs stay`} home: the other player's game doesn't have them.` }));
    if (count && setup.parties.length < MAX_PARTIES) {
      const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button story-copy', textContent: 'Copy to a new party' });
      copy.title = 'Start a party of your own from these Pokémon, to change their moves, items and spreads';
      copy.addEventListener('click', event => { event.stopPropagation(); copyStory(); });
      card.append(copy);
    }
    if (!usable) return card;
    const choose = () => { setup.selected = STORY; save(); };
    card.addEventListener('click', choose);
    card.addEventListener('keydown', event => { if (event.target === card && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); choose(); } });
    return card;
  }

  // A party's line under its Pokémon: what they hold, or how far from ready it is.
  function partySummary(party) {
    const missing = PARTY_SIZE - party.members.length;
    if (missing) return { text: `${missing} more to battle with this party`, warn: true };
    const custom = party.sets.filter(set => set.moves.length || set.item || set.evs.some(Boolean)).length;
    return { text: custom ? `${custom === PARTY_SIZE ? 'All six' : `${custom} of 6`} with sets of their own` : 'Level-up moves, no items', warn: false };
  }

  function setTitle(set) {
    const data = builder().data(), name = set.nickname || builder().speciesName(set.species);
    if (!data) return name;
    const item = data.items.find(each => each.id === set.item)?.name, moves = set.moves.map(id => data.moves.find(move => move.id === id)?.name).filter(Boolean);
    return `${name}${item ? ` @ ${item}` : ''}\n${moves.length ? moves.join(' · ') : 'Level-up moves'}`;
  }

  function renderParties() {
    $('party-empty').hidden = setup.parties.length > 0;
    $('party-new').disabled = setup.parties.length >= MAX_PARTIES;
    $('party-list').replaceChildren(storyCard(), ...setup.parties.map(party => {
      const missing = PARTY_SIZE - party.members.length;
      const card = document.createElement('div');
      card.className = 'party-card';
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(party.id === setup.selected));
      card.setAttribute('aria-disabled', String(missing > 0));
      card.tabIndex = missing ? -1 : 0;
      const name = Object.assign(document.createElement('strong'), { textContent: party.name });
      const edit = Object.assign(document.createElement('button'), { className: 'party-card-edit', type: 'button', textContent: 'Edit' });
      edit.addEventListener('click', event => { event.stopPropagation(); openEditor(party); });
      const team = Object.assign(document.createElement('div'), { className: 'party-card-team' });
      team.append(...party.sets.map(set => {
        const image = sprite(set.species, 36);
        image.title = setTitle(set);
        return image;
      }));
      for (let i = party.members.length; i < PARTY_SIZE; i++) team.append(Object.assign(document.createElement('span'), { textContent: '–' }));
      const summary = partySummary(party);
      card.append(name, edit, team, Object.assign(document.createElement('small'), { className: summary.warn ? '' : 'party-summary', textContent: summary.text }));
      if (missing) return card;
      const choose = () => { setup.selected = party.id; save(); };
      card.addEventListener('click', choose);
      card.addEventListener('keydown', event => { if (event.target === card && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); choose(); } });
      return card;
    }));
  }

  function keepParty(party) {
    const saved = { id: party.id || `party-${Date.now().toString(36)}`, name: party.name, members: party.members, sets: party.sets };
    const at = setup.parties.findIndex(item => item.id === saved.id);
    if (at >= 0) setup.parties[at] = saved;
    else setup.parties.push(saved);
    // a first party ready to battle with is the one chosen
    if (!setup.selected && saved.members.length === PARTY_SIZE) setup.selected = saved.id;
    save();
  }

  function openEditor(party, from = null, name = null) {
    builder().open(party, { name: name || `Party ${setup.parties.length + 1}`, level: setup.level, battleRules: setup.battleRules, from, done: keepParty,
      remove: () => { setup.parties = setup.parties.filter(item => item.id !== party.id); save(); } });
  }

  // The Story party's Pokémon as sets of the player's own, to change as they like.
  async function copyStory() {
    await builder().load();
    const data = builder().data(), T = window.coloTeamSets;
    const sets = state.story.members.slice(0, PARTY_SIZE).map(({ set }) => {
      const ratio = data?.species[set.species]?.gender ?? T.GENDER.none, name = builder().speciesName(set.species);
      const nickname = set.nickname && set.nickname.toLowerCase() !== name.toLowerCase() ? set.nickname : '';
      const gender = T.genders(ratio).length === 2 ? (set.genderByte < ratio ? 'F' : 'M') : '';
      return T.normalizeSet({ ...set, nickname, gender }, set.species);
    });
    openEditor(null, sets, state.story.trainer ? `${state.story.trainer}'s team` : 'Story team');
  }

  // --- Rooms
  function showResult(text) {
    $('online-result').textContent = text || '';
    $('online-result').hidden = !text;
  }

  // A room's rules as one line: Casual's level and size, a format's name, or what a host changed of it.
  const rulesText = rules => F.describe(rules || {}).summary;
  const gamesText = bestOf => bestOf > 1 ? ` · Best of ${bestOf}` : '';

  // --- What the party can play
  // The chosen party as the rules look at it: its species, and each member's item, ability and moves.
  function chosenParty() {
    if (setup.selected === STORY) {
      const members = state.story.members.slice(0, PARTY_SIZE);
      return { party: members.map(member => member.species),
        members: members.map(({ set }) => [set.species, 0, 0, 0, set.ability, set.item, 0, ...[0, 1, 2, 3].flatMap(i => [set.moves[i] || 0, 0])]) };
    }
    const party = setup.parties.find(item => item.id === setup.selected);
    if (!party) return { party: [], members: [] };
    return { party: party.members, members: party.sets.map(set => [set.species, 0, 0, 0, set.ability, set.item, 0, ...[0, 1, 2, 3].flatMap(i => [set.moves[i] || 0, 0])]) };
  }

  function names() {
    const data = builder().data();
    return { species: id => builder().speciesName(id) || undefined, item: id => data?.items.find(item => item.id === id)?.name,
      move: id => data?.moves.find(move => move.id === id)?.name };
  }

  // Why the chosen party can't play by these rules: [text].
  function partyProblems(rules) {
    const { party, members } = chosenParty();
    return F.problems(rules, party, members, names());
  }

  // --- Formats: a room's format, and a host's changes to it. A game from before timers plays without them, as the
  // main process makes its room.
  const chosenRules = () => setup.format === 'casual'
    ? F.normalize({ format: 'casual', level: setup.level, size: setup.size, turnTime: setup.turnTime, battleTime: setup.battleTime, battleRules: setup.battleRules })
    : F.normalize({ ...(setup.custom[setup.format] || {}), format: setup.format, battleRules: setup.battleRules });
  const currentRules = () => state.timersSupported ? chosenRules() : F.withoutTimers(chosenRules());

  // A change to the chosen format: what differs from its own settings is kept.
  function changeRule(key, value) {
    const rules = F.normalize({ ...chosenRules(), [key]: value });
    setup.custom[setup.format] = Object.fromEntries(F.changes(rules).map(name => [name, rules[name]]));
    save();
  }

  const CUSTOM_SELECTS = [
    ['level', 'Level', () => [[50, 'Level 50'], [100, 'Level 100']]],
    ['battle', 'Battle', () => [['single', 'Single battles'], ['double', 'Double battles']]],
    ['size', 'Pokémon each', rules => F.SIZES[rules.battle].map(size => [size, rules.preview ? `Bring 6, pick ${size}` : `${size} each`])],
    ['pool', 'Pokémon', () => [['restricted', 'No box legendaries or mythical'], ['legends', 'No legendaries or mythical'], ['ou', 'No Ubers (Smogon)'], ['any', 'All Pokémon']]],
    ['sleep', 'Sleep clause', () => [['stadium', 'On (Rest counts)'], ['smogon', 'Smogon\'s (Rest doesn\'t count)'], ['off', 'Off']]]
  ];
  const CUSTOM_CHECKS = [
    ['preview', 'Team preview', 'See both parties and pick before each game'],
    ['speciesClause', 'Species clause', 'One of each Pokémon'],
    ['itemClause', 'Item clause', 'One of each held item'],
    ['soulDew', 'Soul Dew allowed', ''],
    ['freeze', 'Freeze clause', 'Only one of a side frozen at once'],
    ['selfKO', 'Self-KO clause', 'Selfdestruct or Explosion loses a tie'],
    ['lastMon', 'No Perish Song or Destiny Bond from a last Pokémon', ''],
    ['hideHp', 'Opponent\'s HP as a bar only', 'No exact HP for the other player\'s Pokémon'],
    ['ohko', 'No one-hit KO moves', 'Fissure, Guillotine, Horn Drill, Sheer Cold'],
    ['evasion', 'No evasion moves or items', 'Double Team, Minimize, BrightPowder, Lax Incense'],
    ['smogonBans', 'Smogon\'s other OU bans', 'Sand Veil, Soundproof, Quick Claw, Assist, Swagger, and Baton Pass and trapping rules']
  ];

  function renderCustom(rules) {
    const box = $('online-custom');
    const rows = CUSTOM_SELECTS.map(([key, label, options]) => {
      const field = Object.assign(document.createElement('label'), { className: 'online-field' });
      const select = document.createElement('select');
      for (const [value, text] of options(rules)) select.append(Object.assign(document.createElement('option'), { value: String(value), textContent: text }));
      select.value = String(rules[key]);
      select.addEventListener('change', () => changeRule(key, typeof rules[key] === 'number' ? Number(select.value) : select.value));
      field.append(Object.assign(document.createElement('span'), { textContent: label }), select);
      return field;
    });
    const checks = CUSTOM_CHECKS.map(([key, label, hint]) => {
      const row = Object.assign(document.createElement('label'), { className: 'online-check', title: hint });
      const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(rules[key]) });
      input.addEventListener('change', () => changeRule(key, input.checked));
      row.append(input, Object.assign(document.createElement('span'), { textContent: label }));
      return row;
    });
    const reset = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button', textContent: `Back to ${F.FORMATS[rules.format].name}` });
    reset.disabled = !F.changes(rules).length;
    reset.addEventListener('click', () => { delete setup.custom[setup.format]; save(); });
    box.replaceChildren(...rows, Object.assign(document.createElement('div'), { className: 'online-custom-checks' }), reset);
    box.querySelector('.online-custom-checks').append(...checks);
  }

  // The timers, for any format: Casual's are its own, as its level and size are; a format's are a change to it.
  const TIMER_FIELDS = [['online-turn-time', 'turnTime', F.TURN_TIMES, value => `${value} seconds`],
    ['online-battle-time', 'battleTime', F.BATTLE_TIMES, value => `${value} minutes`]];
  function renderTimers(rules) {
    for (const [id, key, values, text] of TIMER_FIELDS) {
      const select = $(id);
      // a value set some other way (a saved one from the room list's choices) shows too
      const choices = [...new Set([...values, rules[key]])].sort((a, b) => a - b);
      select.replaceChildren(...choices.map(value => Object.assign(document.createElement('option'), { value: String(value), textContent: value ? text(value) : 'Off' })));
      select.value = String(rules[key]);
      select.disabled = !state.timersSupported;
      select.closest('.online-field').title = state.timersSupported ? '' : 'Update the game from the Play page for turn and battle timers.';
    }
  }
  function changeTimer(key, value) {
    if (setup.format === 'casual') { setup[key] = value; save(); }
    else changeRule(key, value);
  }

  function renderFormat() {
    const rules = currentRules(), casual = rules.format === 'casual';
    renderTimers(rules);
    $('online-format').value = setup.format;
    $('online-best-of').value = String(setup.bestOf);
    for (const option of $('online-format').options) option.disabled = option.value !== 'casual' && !state.rulesSupported;
    $('online-format').title = state.rulesSupported ? '' : 'Update the game from the Play page for Orre Colosseum, Hoenn Stadium and Gen 3 OU.';
    for (const field of document.querySelectorAll('.online-casual')) field.hidden = !casual;
    $('online-format-summary').hidden = casual;
    $('online-custom').hidden = casual || !customOpen;
    $('online-customise').setAttribute('aria-expanded', String(customOpen));
    $('online-customise').textContent = customOpen ? 'Done' : 'Customise';
    if (casual) return;
    const described = F.describe(rules);
    $('online-format-name').textContent = described.custom ? `${described.name} (custom)` : described.name;
    $('online-format-rules').textContent = described.custom ? `Changed: ${described.changes.join(', ')}.` : `${F.rulesText(rules).join(', ')}.`;
    if (customOpen) renderCustom(rules);
  }

  function renderRooms() {
    const busy = Boolean(state.battle) || Boolean(state.ready);
    $('online-rooms-empty').textContent = NO_ROOMS;
    $('online-rooms-empty').hidden = rooms.length > 0;
    $('online-rooms').replaceChildren(...rooms.map(room => {
      // Both games play the same battle, so a room takes the same build of the game only.
      const rules = F.normalize(room.rules || {}), sameGame = room.build === state.build, waiting = room.status === 'waiting';
      const needsGame = rules.format !== 'casual' && !state.rulesSupported;
      const problems = waiting && sameGame && !needsGame ? partyProblems(rules) : [];
      const detail = !waiting ? ' · in battle' : !sameGame ? ` · needs game ${room.version}` : needsGame ? ' · update the game to join'
        : problems.length ? ` · ${rules.size > partyCount() ? 'your party is too short' : 'your party can\'t play this'}` : '';
      const row = Object.assign(document.createElement('div'), { className: 'online-room' });
      row.append(Object.assign(document.createElement('span'), { textContent: room.name }));
      row.append(Object.assign(document.createElement('small'), { textContent: `${rulesText(rules)}${gamesText(room.bestOf || 1)}${detail}` }));
      row.title = [F.rulesText(rules).join(', '), ...problems].join('\n');
      const join = Object.assign(document.createElement('button'), { className: 'solid', type: 'button', textContent: 'Join' });
      join.disabled = busy || !waiting || !sameGame || needsGame || problems.length > 0;
      join.addEventListener('click', () => joinRoom(room.code));
      row.append(join);
      return row;
    }));
  }

  // What the poll compares. Not the whole list: a room's minutes change by themselves.
  async function loadRooms() {
    try {
      rooms = await window.colo.onlineRooms();
      renderRooms();
      return rooms.map(room => `${room.code} ${room.status}`).join();
    } catch (error) {
      $('online-rooms-empty').textContent = 'Couldn\'t reach the room server.';
      $('online-rooms-empty').hidden = false;
      throw error;
    }
  }

  const poll = window.coloRoomPoll.createRoomPoll({ load: loadRooms,
    paused: () => !state || Boolean(state.battle) || document.hidden });

  async function refreshNow() {
    if (!state) return;
    $('online-refresh').disabled = true;
    window.colo.usageRefresh();
    await Promise.all([poll.refresh(), new Promise(resolve => setTimeout(resolve, REFRESH_REST))]);
    $('online-refresh').disabled = false;
  }

  async function createRoom() {
    showResult('');
    $('online-create').disabled = true;
    try { await window.colo.onlineCreate(); }
    catch (error) { showResult(message(error)); render(); }
  }

  async function joinRoom(code) {
    showResult('');
    try { await window.colo.onlineJoin(code); }
    catch (error) { showResult(message(error)); render(); }
  }

  function renderBanner() {
    const battle = state.battle;
    $('online-banner').hidden = !battle;
    if (!battle) return;
    const set = battle.bestOf > 1, game = set && battle.game ? ` · game ${battle.game} of ${battle.bestOf}` : '';
    const title = { connecting: 'Connecting…', waiting: `Room ${battle.code}`, picking: `Choosing for ${battle.opponent || 'a player'}${game}`,
      battling: `Battling ${battle.opponent || 'a player'}${game}`, between: `Game ${battle.game} over`, ended: set ? 'Set over' : 'Battle over' };
    $('online-banner-title').textContent = title[battle.status] || 'Online battle';
    const score = set && battle.side !== null && battle.game ? ` You ${battle.wins[battle.side]}, ${battle.opponent || 'them'} ${battle.wins[1 - battle.side]}.` : '';
    $('online-banner-detail').textContent = battle.peerLost ? `${battle.opponent || 'The other player'} lost their connection. Waiting for them to come back.`
      : battle.status === 'waiting' ? `Waiting for a challenger. ${rulesText(battle.rules)}${gamesText(battle.bestOf)}.` : `${rulesText(battle.rules)}.${score}`;
    renderPick();
  }

  // --- Team preview: both parties, and this player's picks in order
  function renderPick() {
    const preview = state.battle?.status === 'picking' ? state.battle.preview : null;
    $('online-pick').hidden = !preview;
    clearInterval(pickTimer);
    if (!preview) { picking = []; return; }
    const side = state.battle.side, mine = preview.players[side], theirs = preview.players[1 - side];
    if (preview.picked) picking = preview.picked.slice();
    picking = picking.filter(slot => mine.party[slot]);
    $('online-pick-title').textContent = state.battle.bestOf > 1 ? `Game ${state.battle.game}: choose ${preview.size}` : `Choose ${preview.size} to battle with`;
    $('online-pick-help').textContent = preview.picked ? `Waiting for ${theirs.name} to choose…`
      : `Pick them in order: the first ${state.battle.rules?.battle === 'double' ? 'two lead' : 'leads'}. ${theirs.name} sees your party too, but not your picks.`;
    $('online-pick-mine').replaceChildren(...mine.party.map((species, slot) => {
      const button = Object.assign(document.createElement('button'), { type: 'button', className: 'online-pick-slot' });
      if (!species) { button.disabled = true; return button; }
      const at = picking.indexOf(slot);
      button.setAttribute('aria-pressed', String(at >= 0));
      button.title = builder().speciesName(species);
      button.append(sprite(species, 40));
      if (at >= 0) button.append(Object.assign(document.createElement('b'), { textContent: String(at + 1) }));
      button.disabled = Boolean(preview.picked) || (at < 0 && picking.length >= preview.size);
      button.addEventListener('click', () => {
        picking = at >= 0 ? picking.filter(each => each !== slot) : [...picking, slot];
        renderPick();
      });
      return button;
    }));
    $('online-pick-theirs-label').textContent = `${theirs.name}'s party`;
    $('online-pick-theirs').replaceChildren(...theirs.party.filter(Boolean).map(species => sprite(species, 36)));
    $('online-pick-go').disabled = Boolean(preview.picked) || picking.length !== preview.size;
    $('online-pick-clear').disabled = Boolean(preview.picked) || !picking.length;
    const tick = () => {
      const left = Math.max(0, Math.ceil((preview.deadline - Date.now()) / 1000));
      $('online-pick-time').textContent = preview.picked ? '' : `${left} s`;
      // out of time: the picks so far, then the party's first
      if (!left && !preview.picked) {
        clearInterval(pickTimer);
        const order = [...picking, ...mine.party.map((species, slot) => slot).filter(slot => mine.party[slot] && !picking.includes(slot))].slice(0, preview.size);
        sendPick(order);
      }
    };
    tick();
    if (!preview.picked) pickTimer = setInterval(tick, 500);
  }

  function sendPick(order) {
    window.colo.onlinePick(order).then(next => { state = next; render(); }).catch(error => showResult(message(error)));
  }

  function showSizeNote(size) {
    $('online-blocked').textContent = setup.format === 'casual'
      ? `Your Story party has ${partyCount()} Pokémon that can battle: choose 3 each to create a room.`
      : `This format plays ${size} Pokémon each, and your Story party has ${partyCount()} that can battle.`;
    $('online-blocked').hidden = false;
  }

  function render() {
    if (!state) return;
    setup = state.setup;
    if (document.activeElement !== $('online-trainer')) $('online-trainer').value = setup.trainer;
    $('online-level').value = String(setup.level);
    $('online-size').value = String(setup.size);
    $('online-rules').value = String(setup.battleRules || 3);
    $('online-listed').checked = setup.listed;
    renderParties();
    renderFormat();
    renderBanner();
    if (state.result) showResult(state.result.message);
    $('online-blocked').textContent = state.ready || '';
    $('online-blocked').hidden = !state.ready;
    const busy = Boolean(state.ready) || Boolean(state.battle);
    const rules = currentRules();
    // A Story party short of six takes rooms of fewer each
    const short = rules.size > partyCount();
    $('online-size').querySelector('option[value="6"]').disabled = partyCount() < 6;
    const problems = !busy && !short && loaded ? partyProblems(rules) : [];
    if (short && !busy) showSizeNote(rules.size);
    else if (problems.length) {
      $('online-blocked').textContent = `Your party can't play ${F.describe(rules).name}: ${problems.join(' ')}`;
      $('online-blocked').hidden = false;
    }
    $('online-create').disabled = busy || short || problems.length > 0 || (rules.format !== 'casual' && !state.rulesSupported);
    $('online-code-join').disabled = busy;
  }

  $('party-new').addEventListener('click', () => openEditor(null));
  for (const [id, key, value] of [['online-level', 'level', Number], ['online-size', 'size', Number], ['online-rules', 'battleRules', Number]])
    $(id).addEventListener('change', event => { setup[key] = value(event.target.value); save(); });
  $('online-listed').addEventListener('change', event => { setup.listed = event.target.checked; save(); });
  for (const [id, key] of TIMER_FIELDS) $(id).addEventListener('change', event => changeTimer(key, Number(event.target.value)));
  $('online-format').addEventListener('change', event => { setup.format = event.target.value; customOpen = false; save(); });
  $('online-best-of').addEventListener('change', event => { setup.bestOf = Number(event.target.value); save(); });
  $('online-customise').addEventListener('click', () => { customOpen = !customOpen; renderFormat(); });
  $('online-pick-clear').addEventListener('click', () => { picking = []; renderPick(); });
  $('online-pick-go').addEventListener('click', () => sendPick(picking));
  $('online-trainer').addEventListener('change', event => { setup.trainer = event.target.value; save(); });
  $('online-create').addEventListener('click', createRoom);
  $('online-leave').addEventListener('click', () => window.colo.onlineLeave());
  $('online-refresh').addEventListener('click', refreshNow);
  document.addEventListener('visibilitychange', () => poll.wake());
  $('online-code-form').addEventListener('submit', event => {
    event.preventDefault();
    if ($('online-code').value.trim()) joinRoom($('online-code').value);
  });

  window.colo.onOnline(next => {
    state = next;
    render();
    if (rooms) renderRooms();
    poll.wake();
  });
  function renderCount(count) {
    if (!count) return;
    $('online-count-text').textContent = `${count.online.toLocaleString()} online`;
    $('online-count').hidden = false;
  }
  window.colo.onUsage(renderCount);
  window.colo.state().then(data => {
    state = data.online;
    renderCount(data.usage);
    render();
    poll.wake();
  });

  window.coloOnline = {
    show() {
      if (!loaded) loadSpecies();
      // the save may have changed since: the Story party is read again
      window.colo.state().then(data => { state = data.online; render(); if (rooms) renderRooms(); }).catch(() => {});
      poll.start();
    },
    hide() { poll.stop(); }
  };
})();
