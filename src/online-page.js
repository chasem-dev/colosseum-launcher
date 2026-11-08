// Online: the player's parties, the room list, and making or joining a room. The rooms and the
// game itself are the main process's (src/online.js); this page shows them and asks.
(() => {
  const $ = id => document.getElementById(id);
  const PARTY_SIZE = 6, MAX_PARTIES = 32, STORY = 'story', NO_ROOMS = 'No rooms are open. Create one and wait for a challenger.';
  const REFRESH_REST = 3000; // ms before Refresh works again: the server's list is this old at best
  const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  let state = null, setup = null, rooms = null, loaded = false;
  const builder = () => window.coloTeamBuilder;

  // The sprites and names come with the team builder's Pokédex, read from the disc once.
  function loadSpecies() {
    builder().load().then(() => { loaded = Boolean(builder().data()); if (setup) renderParties(); });
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
      : !count && !story.leftOut ? 'Play and save the game, and the party you travel with shows here.'
      : count < 3 ? `${count} Pokémon can battle: you need at least 3.`
      : `${story.trainer ? `${story.trainer}'s team, ` : ''}with their moves, natures and held items, at the room's level.`;
    const detail = Object.assign(document.createElement('small'), { className: usable ? 'story-note' : '', textContent: note });
    card.append(detail);
    if (story.leftOut)
      card.append(Object.assign(document.createElement('small'), { className: 'story-note', textContent: `${story.leftOut === 1 ? 'A Shadow Pokémon stays' : `${story.leftOut} Shadow Pokémon stay`} home until purified.` }));
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
    builder().open(party, { name: name || `Party ${setup.parties.length + 1}`, level: setup.level, from, done: keepParty,
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

  const rulesText = rules => `Level ${rules.level}, ${rules.size} Pokémon each`;

  function renderRooms() {
    const busy = Boolean(state.battle) || Boolean(state.ready);
    $('online-rooms-empty').textContent = NO_ROOMS;
    $('online-rooms-empty').hidden = rooms.length > 0;
    $('online-rooms').replaceChildren(...rooms.map(room => {
      // Both games play the same battle, so a room takes the same build of the game only.
      const sameGame = room.build === state.build, waiting = room.status === 'waiting', fits = room.rules.size <= partyCount();
      const detail = !waiting ? ' · in battle' : !sameGame ? ` · needs game ${room.version}` : fits ? '' : ' · your party is too short';
      const row = Object.assign(document.createElement('div'), { className: 'online-room' });
      row.append(Object.assign(document.createElement('span'), { textContent: room.name }));
      row.append(Object.assign(document.createElement('small'), { textContent: `${rulesText(room.rules)}${detail}` }));
      const join = Object.assign(document.createElement('button'), { className: 'solid', type: 'button', textContent: 'Join' });
      join.disabled = busy || !waiting || !sameGame || !fits;
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
    const title = { connecting: 'Connecting…', waiting: `Room ${battle.code}`, battling: `Battling ${battle.opponent || 'a player'}`, ended: 'Battle over' };
    $('online-banner-title').textContent = title[battle.status] || 'Online battle';
    $('online-banner-detail').textContent = battle.peerLost ? `${battle.opponent || 'The other player'} lost their connection. Waiting for them to come back.`
      : battle.status === 'waiting' ? `Waiting for a challenger. ${rulesText(battle.rules)}.` : rulesText(battle.rules);
  }

  function showSizeNote() {
    $('online-blocked').textContent = `Your Story party has ${partyCount()} Pokémon that can battle: choose 3 each to create a room.`;
    $('online-blocked').hidden = false;
  }

  function render() {
    if (!state) return;
    setup = state.setup;
    if (document.activeElement !== $('online-trainer')) $('online-trainer').value = setup.trainer;
    $('online-level').value = String(setup.level);
    $('online-size').value = String(setup.size);
    $('online-listed').checked = setup.listed;
    renderParties();
    renderBanner();
    if (state.result) showResult(state.result.message);
    $('online-blocked').textContent = state.ready || '';
    $('online-blocked').hidden = !state.ready;
    const busy = Boolean(state.ready) || Boolean(state.battle);
    // A Story party short of six takes rooms of fewer each
    const short = setup.size > partyCount();
    $('online-size').querySelector('option[value="6"]').disabled = partyCount() < 6;
    if (short && !busy) showSizeNote();
    $('online-create').disabled = busy || short;
    $('online-code-join').disabled = busy;
  }

  $('party-new').addEventListener('click', () => openEditor(null));
  for (const [id, key, value] of [['online-level', 'level', Number], ['online-size', 'size', Number]])
    $(id).addEventListener('change', event => { setup[key] = value(event.target.value); save(); });
  $('online-listed').addEventListener('change', event => { setup.listed = event.target.checked; save(); });
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
