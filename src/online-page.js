// Online: the player's parties, the room list, and making or joining a room. The rooms and the
// game itself are the main process's (src/online.js); this page shows them and asks.
(() => {
  const $ = id => document.getElementById(id);
  const PARTY_SIZE = 6, STORY = 'story', NO_ROOMS = 'No rooms are open. Create one and wait for a challenger.';
  const REFRESH_REST = 3000; // ms before Refresh works again: the server's list is this old at best
  const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const number = national => `#${String(national).padStart(3, '0')}`;

  let state = null, setup = null, species = null, loadingSpecies = null, rooms = null, editing = null;
  const byId = new Map();

  async function loadSpecies() {
    try {
      // The disc's Pokémon only: online battles have no Pokémon packs.
      const list = (await window.colo.pokedex()).species;
      species = list;
      for (const entry of list) byId.set(entry.id, entry);
      $('party-dex-note').hidden = true;
    } catch (error) {
      $('party-dex-note').textContent = message(error);
      $('party-dex-note').hidden = false;
    }
    loadingSpecies = null;
    renderParties();
    if ($('party-editor').open) { renderDex(); renderSlots(); }
  }

  function sprite(id, size) {
    const entry = byId.get(id);
    if (!entry?.sprite) return Object.assign(document.createElement('span'), { textContent: entry ? '' : '?' });
    const image = document.createElement('img');
    image.src = entry.sprite;
    image.alt = entry.name;
    image.title = entry.name;
    image.width = image.height = size;
    image.loading = 'lazy';
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
      const species = byId.get(member.species)?.name;
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
    if (!usable) return card;
    const choose = () => { setup.selected = STORY; save(); };
    card.addEventListener('click', choose);
    card.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); choose(); } });
    return card;
  }

  function renderParties() {
    $('party-empty').hidden = setup.parties.length > 0;
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
      team.append(...party.members.map(id => sprite(id, 36)));
      for (let i = party.members.length; i < PARTY_SIZE; i++) team.append(Object.assign(document.createElement('span'), { textContent: '–' }));
      card.append(name, edit, team);
      if (missing) {
        card.append(Object.assign(document.createElement('small'), { textContent: `${missing} more to battle with this party` }));
        return card;
      }
      const choose = () => { setup.selected = party.id; save(); };
      card.addEventListener('click', choose);
      card.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); choose(); } });
      return card;
    }));
  }

  function openEditor(party) {
    editing = party ? { ...party, members: party.members.slice() } : { id: null, name: `Party ${setup.parties.length + 1}`, members: [] };
    $('party-name').value = editing.name;
    $('party-search').value = '';
    $('party-delete').hidden = !party;
    if (!species) loadingSpecies ||= loadSpecies();
    renderDex();
    renderSlots();
    $('party-editor').showModal();
  }

  function renderSlots() {
    const slots = [];
    for (let i = 0; i < PARTY_SIZE; i++) {
      const id = editing.members[i];
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = `party-slot${id ? ' filled' : ''}`;
      if (id) {
        slot.title = 'Remove from the party';
        slot.append(sprite(id, 44), Object.assign(document.createElement('span'), { textContent: byId.get(id)?.name || `#${id}` }));
        slot.addEventListener('click', () => { editing.members.splice(i, 1); renderSlots(); });
      } else {
        slot.disabled = true;
        slot.append(Object.assign(document.createElement('span'), { textContent: `Slot ${i + 1}` }));
      }
      slots.push(slot);
    }
    $('party-slots').replaceChildren(...slots);
    $('party-save').disabled = !editing.members.length;
  }

  function renderDex() {
    if (!species) { $('party-dex').replaceChildren(); return; }
    const query = $('party-search').value.trim().toLowerCase();
    const matches = species.filter(entry => !query || entry.name.toLowerCase().includes(query) || String(entry.national) === query.replace(/^#?0*/, ''));
    $('party-dex').replaceChildren(...matches.map(entry => {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = entry.types.join(' / ');
      const label = document.createElement('span');
      label.append(entry.name, Object.assign(document.createElement('small'), { textContent: `${number(entry.national)} ${entry.types.join('/')}` }));
      button.append(sprite(entry.id, 36), label);
      button.addEventListener('click', () => {
        if (editing.members.length >= PARTY_SIZE) return;
        editing.members.push(entry.id);
        renderSlots();
      });
      return button;
    }));
  }

  function saveEditor() {
    const party = { id: editing.id || `party-${Date.now().toString(36)}`, name: $('party-name').value, members: editing.members };
    const at = setup.parties.findIndex(item => item.id === party.id);
    if (at >= 0) setup.parties[at] = party;
    else setup.parties.push(party);
    $('party-editor').close();
    save();
  }

  function deleteParty() {
    setup.parties = setup.parties.filter(item => item.id !== editing.id);
    $('party-editor').close();
    save();
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
  $('party-editor-close').addEventListener('click', () => $('party-editor').close());
  $('party-save').addEventListener('click', saveEditor);
  $('party-delete').addEventListener('click', deleteParty);
  $('party-search').addEventListener('input', renderDex);
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
      if (!species) loadingSpecies ||= loadSpecies();
      // the save may have changed since: the Story party is read again
      window.colo.state().then(data => { state = data.online; render(); if (rooms) renderRooms(); }).catch(() => {});
      poll.start();
    },
    hide() { poll.stop(); }
  };
})();
