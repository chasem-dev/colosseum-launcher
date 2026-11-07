// Online: the player's parties, the room list, and making or joining a room. The rooms and the
// game itself are the main process's (src/online.js); this page shows them and asks.
(() => {
  const $ = id => document.getElementById(id);
  const PARTY_SIZE = 6, POLL = 5000;
  const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const number = national => `#${String(national).padStart(3, '0')}`;

  let state = null, setup = null, species = null, loadingSpecies = null, showing = false, poll = null, editing = null;
  const byId = new Map();

  async function loadSpecies() {
    try {
      const list = await window.colo.pokedex();
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
  function renderParties() {
    $('party-empty').hidden = setup.parties.length > 0;
    $('party-list').replaceChildren(...setup.parties.map(party => {
      const card = document.createElement('div');
      card.className = 'party-card';
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(party.id === setup.selected));
      card.tabIndex = 0;
      const name = Object.assign(document.createElement('strong'), { textContent: party.name });
      const edit = Object.assign(document.createElement('button'), { className: 'party-card-edit', type: 'button', textContent: 'Edit' });
      edit.addEventListener('click', event => { event.stopPropagation(); openEditor(party); });
      const team = Object.assign(document.createElement('div'), { className: 'party-card-team' });
      team.append(...party.members.map(id => sprite(id, 36)));
      for (let i = party.members.length; i < PARTY_SIZE; i++) team.append(Object.assign(document.createElement('span'), { textContent: '–' }));
      card.append(name, edit, team);
      if (party.members.length < PARTY_SIZE)
        card.append(Object.assign(document.createElement('small'), { textContent: `${PARTY_SIZE - party.members.length} more to battle with this party` }));
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
    if (!setup.selected && party.members.length === PARTY_SIZE) setup.selected = party.id;
    $('party-editor').close();
    save();
  }

  function deleteParty() {
    setup.parties = setup.parties.filter(item => item.id !== editing.id);
    if (setup.selected === editing.id) setup.selected = null;
    $('party-editor').close();
    save();
  }

  // --- Rooms
  function showResult(text) {
    $('online-result').textContent = text || '';
    $('online-result').hidden = !text;
  }

  const rulesText = rules => `Level ${rules.level}, ${rules.size} Pokémon each`;

  function renderRooms(rooms) {
    const busy = Boolean(state.battle) || Boolean(state.ready);
    $('online-rooms-empty').hidden = rooms.length > 0;
    $('online-rooms').replaceChildren(...rooms.map(room => {
      // Both games play the same battle, so a room takes the same build of the game only.
      const sameGame = room.build === state.build, waiting = room.status === 'waiting';
      const detail = !waiting ? ' · in battle' : sameGame ? '' : ` · needs game ${room.version}`;
      const row = Object.assign(document.createElement('div'), { className: 'online-room' });
      row.append(Object.assign(document.createElement('span'), { textContent: room.name }));
      row.append(Object.assign(document.createElement('small'), { textContent: `${rulesText(room.rules)}${detail}` }));
      const join = Object.assign(document.createElement('button'), { className: 'solid', type: 'button', textContent: 'Join' });
      join.disabled = busy || !waiting || !sameGame;
      join.addEventListener('click', () => joinRoom(room.code));
      row.append(join);
      return row;
    }));
  }

  async function refreshRooms() {
    if (!state) return;
    try { renderRooms(await window.colo.onlineRooms()); }
    catch (_) { $('online-rooms-empty').textContent = 'Couldn\'t reach the room server.'; $('online-rooms-empty').hidden = false; }
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
    $('online-create').disabled = busy;
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
  $('online-code-form').addEventListener('submit', event => {
    event.preventDefault();
    if ($('online-code').value.trim()) joinRoom($('online-code').value);
  });

  window.colo.onOnline(next => {
    state = next;
    render();
    if (showing) refreshRooms();
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
    if (showing) refreshRooms();
  });

  window.coloOnline = {
    show() {
      showing = true;
      if (!species) loadingSpecies ||= loadSpecies();
      refreshRooms();
      clearInterval(poll);
      poll = setInterval(refreshRooms, POLL);
    },
    hide() {
      showing = false;
      clearInterval(poll);
    }
  };
})();
