// The team builder: a party's six Pokémon, each with its moves, item, ability, nature, EVs and IVs, as Pokémon
// Showdown builds them, and Showdown's text to bring a team in or take it out. What it offers is read from the
// player's disc (src/battle-data.js); the sets themselves are src/team-sets.js's. The Online page opens it.
(() => {
  const $ = id => document.getElementById(id);
  const T = window.coloTeamSets;
  const PARTY_SIZE = 6;
  const LIST_LIMIT = 400;
  const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const number = national => `#${String(national).padStart(3, '0')}`;
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  };
  const typeChip = type => {
    const chip = el('span', { className: 'pokedex-type', textContent: type });
    chip.dataset.type = type.toLowerCase().replace(/\W/g, '');
    return chip;
  };
  const key = text => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // What's read from the disc, once.
  let species = null, byId = new Map(), data = null, loading = null, loadError = null;
  let moveById = new Map(), itemById = new Map();
  // The party open in the editor, the slot shown, and what the editor's showing: a set or the Pokédex.
  let editing = null, current = 0, view = 'set', replacing = null, level = 50, onDone = null, dragFrom = null;
  // The list under a move or item field while it's chosen from.
  let list = null;

  // The Pokédex and the battle data apart: the sprites still show when the other can't be read.
  function load() {
    loading ||= (async () => {
      const [dex, battle] = await Promise.allSettled([species ? Promise.resolve(species) : window.colo.pokedex(), window.colo.battleData()]);
      if (dex.status === 'fulfilled') {
        species = dex.value;
        byId = new Map(species.map(entry => [entry.id, entry]));
      }
      if (battle.status === 'fulfilled') {
        data = battle.value;
        moveById = new Map(data.moves.map(move => [move.id, move]));
        itemById = new Map(data.items.map(item => [item.id, item]));
      }
      const failed = [dex, battle].find(result => result.status === 'rejected');
      loadError = failed ? message(failed.reason) : null;
      if (failed) loading = null;   // asked again next time
    })();
    return loading;
  }

  // What team-sets.js's Showdown text needs to know about this disc.
  const dex = () => ({ species, moves: data.moves, items: data.items, balls: data.balls,
    abilities: id => data.species[id]?.abilities || [], gender: id => data.species[id]?.gender ?? T.GENDER.none });

  function sprite(id, size, className = '') {
    const entry = byId.get(id);
    if (!entry?.sprite) return el('span', { className: `tb-no-sprite ${className}`, textContent: entry ? '' : '?' });
    const image = el('img', { src: entry.sprite, alt: '', width: size, height: size, className });
    image.loading = 'lazy';
    return image;
  }

  const speciesName = id => byId.get(id)?.name || `#${id}`;
  const displayName = set => set.nickname || speciesName(set.species);
  const learnset = id => new Map(data?.species[id]?.learnset || []);
  // Moves its species can't learn in this game: allowed, as Showdown's custom games allow them, and shown.
  const unlearnable = set => set.moves.filter(move => !learnset(set.species).has(move));

  function setStatus(text) { $('party-editor-status').textContent = text || ''; }

  // --- The team, down the side
  function renderTeam() {
    const slots = [];
    for (let i = 0; i < PARTY_SIZE; i++) {
      const set = editing.sets[i];
      const item = el('li', { className: 'tb-slot-wrap' });
      const button = el('button', { type: 'button', className: `tb-slot${set ? ' filled' : ''}${set && i === current && view === 'set' ? ' selected' : ''}` });
      if (set) {
        const odd = unlearnable(set).length;
        button.title = `${displayName(set)}: edit its set`;
        button.setAttribute('aria-current', String(i === current && view === 'set'));
        button.append(...[sprite(set.species, 44),
          el('span', { className: 'tb-slot-text' },
            el('strong', { textContent: displayName(set) }),
            el('small', { textContent: set.item ? itemById.get(set.item)?.name || 'Item' : set.moves.length ? `${set.moves.length} move${set.moves.length === 1 ? '' : 's'}` : 'Level-up moves' })),
          odd ? el('i', { className: 'tb-slot-warn', title: `${odd} move${odd === 1 ? '' : 's'} it can't learn in this game`, textContent: '!' }) : null].filter(Boolean));
        button.addEventListener('click', () => select(i));
        button.draggable = true;
        button.addEventListener('dragstart', event => { dragFrom = i; event.dataTransfer.effectAllowed = 'move'; button.classList.add('dragging'); });
        button.addEventListener('dragend', () => { dragFrom = null; renderTeam(); });
        button.addEventListener('dragover', event => { if (dragFrom !== null) { event.preventDefault(); button.classList.add('drop'); } });
        button.addEventListener('dragleave', () => button.classList.remove('drop'));
        button.addEventListener('drop', event => { event.preventDefault(); move(dragFrom, i); });
        button.addEventListener('keydown', event => {
          if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const to = i + (event.key === 'ArrowUp' ? -1 : 1);
          if (to >= 0 && to < editing.sets.length) { move(i, to); $('party-slots').children[to]?.querySelector('button')?.focus(); }
        });
      } else {
        const next = i === editing.sets.length;
        button.disabled = !next;
        button.classList.toggle('selected', next && view === 'picker' && replacing === null);
        button.append(el('span', { className: 'tb-slot-add', textContent: '+' }), el('span', { className: 'tb-slot-text' }, el('strong', { textContent: next ? 'Add Pokémon' : `Slot ${i + 1}` })));
        if (next) button.addEventListener('click', () => openPicker(null));
      }
      item.append(button);
      slots.push(item);
    }
    $('party-slots').replaceChildren(...slots);
    const count = editing.sets.length;
    $('party-save').textContent = count ? 'Done' : 'Close';
    setStatus(count === PARTY_SIZE ? 'Ready to battle' : `${PARTY_SIZE - count} more to battle with this party`);
  }

  function move(from, to) {
    if (from === null || from === to || from >= editing.sets.length || to >= editing.sets.length) return renderTeam();
    const [set] = editing.sets.splice(from, 1);
    editing.sets.splice(to, 0, set);
    current = to;
    dragFrom = null;
    render();
  }

  function select(i) {
    current = i;
    view = 'set';
    closeList();
    render();
  }

  // --- The Pokédex, to add a Pokémon or change one's species
  function openPicker(slot) {
    replacing = slot;
    view = 'picker';
    closeList();
    $('party-search').value = '';
    render();
    $('party-search').focus();
  }

  function renderPicker() {
    $('tb-picker-cancel').hidden = !editing.sets.length;
    if (!species) { $('party-dex').replaceChildren(); return; }
    const query = $('party-search').value.trim().toLowerCase(), digits = query.replace(/^#?0*/, '');
    const matches = species.filter(entry => !query || entry.name.toLowerCase().includes(query) || String(entry.national) === digits
      || entry.types.some(type => type.toLowerCase() === query) || entry.abilities.some(ability => ability.toLowerCase().includes(query)));
    const taken = new Set(editing.sets.map(set => set.species));
    $('party-dex').replaceChildren(...matches.map(entry => {
      const row = el('button', { type: 'button', className: 'tb-dex-row' });
      row.setAttribute('role', 'option');
      const total = entry.stats.reduce((sum, stat) => sum + stat, 0);
      row.append(sprite(entry.id, 36),
        el('span', { className: 'tb-dex-name' }, el('strong', { textContent: entry.name }), el('small', { textContent: number(entry.national) })),
        el('span', { className: 'tb-dex-types' }, ...entry.types.map(typeChip)),
        el('span', { className: 'tb-dex-abilities', textContent: entry.abilities.join(' / ') }),
        ...entry.stats.map(stat => el('span', { className: 'tb-dex-stat', textContent: stat })),
        el('span', { className: 'tb-dex-stat tb-dex-total', textContent: total }));
      if (taken.has(entry.id) && replacing === null) row.classList.add('taken');
      row.addEventListener('click', () => pickSpecies(entry.id));
      return row;
    }));
    if (!matches.length) $('party-dex').append(el('p', { className: 'helper tb-empty', textContent: 'No Pokémon match that.' }));
  }

  function pickSpecies(id) {
    const fresh = T.defaultSet(id);
    if (replacing !== null && editing.sets[replacing]) {
      // a new species keeps what still fits it: its item, nature, spread, and the moves it can learn
      const old = editing.sets[replacing], moves = learnset(id);
      editing.sets[replacing] = { ...fresh, item: old.item, nature: old.nature, evs: old.evs, ivs: old.ivs, friendship: old.friendship, ball: old.ball,
        moves: old.moves.filter(move => moves.has(move)) };
      current = replacing;
    } else {
      if (editing.sets.length >= PARTY_SIZE) return;
      editing.sets.push(fresh);
      current = editing.sets.length - 1;
    }
    view = 'set';
    render();
    $('tb-set').querySelector('.tb-move input')?.focus();
  }

  // --- One Pokémon's set
  function field(label, control, extra = null, className = '') {
    return el('label', { className: `tb-field ${className}` }, el('span', { textContent: label }), control, extra);
  }

  function renderSet() {
    const set = editing.sets[current];
    if (!set) { $('tb-set').replaceChildren(); return; }
    const entry = byId.get(set.species), info = data.species[set.species] || { abilities: [], gender: T.GENDER.none };
    const update = () => { refresh(); renderTeam(); };

    // Who it is
    const nickname = el('input', { className: 'online-input', type: 'text', maxLength: T.NICKNAME_LENGTH, value: set.nickname, placeholder: entry?.name || '', spellcheck: false, autocomplete: 'off' });
    nickname.addEventListener('input', () => { set.nickname = T.cleanNickname(nickname.value); update(); });
    nickname.addEventListener('change', () => { nickname.value = set.nickname; });

    const genderOptions = T.genders(info.gender);
    const gender = el('select');
    if (genderOptions.length === 2) gender.append(el('option', { value: '', textContent: 'Random' }));
    for (const option of genderOptions) gender.append(el('option', { value: option, textContent: option === 'M' ? 'Male ♂' : 'Female ♀' }));
    if (!genderOptions.length) gender.append(el('option', { value: '', textContent: 'Genderless' }));
    gender.value = genderOptions.length === 1 ? genderOptions[0] : set.gender;
    gender.disabled = genderOptions.length < 2;
    gender.addEventListener('change', () => { set.gender = gender.value; update(); });

    const shiny = el('input', { type: 'checkbox', checked: set.shiny });
    shiny.addEventListener('change', () => { set.shiny = shiny.checked; update(); });

    const ball = el('select');
    for (const each of data.balls) ball.append(el('option', { value: each.id, textContent: each.name }));
    ball.value = String(set.ball);
    ball.addEventListener('change', () => { set.ball = Number(ball.value); });

    const friendship = el('input', { className: 'online-input', type: 'number', min: 0, max: 255, value: set.friendship });
    friendship.addEventListener('change', () => { set.friendship = Math.max(0, Math.min(255, Math.round(Number(friendship.value)) || 0)); friendship.value = set.friendship; refresh(); });

    const identity = el('div', { className: 'tb-identity' },
      el('div', { className: 'tb-portrait' }, sprite(set.species, 96), set.shiny ? el('span', { className: 'tb-shiny-mark', title: 'Shiny', textContent: '★' }) : null),
      el('div', { className: 'tb-identity-main' },
        el('div', { className: 'tb-species' },
          el('h2', { textContent: entry?.name || speciesName(set.species) }),
          el('span', { className: 'pokedex-number', textContent: entry ? number(entry.national) : '' }),
          el('span', { className: 'pokedex-types' }, ...(entry?.types || []).map(typeChip)),
          el('span', { className: 'nav-spacer' }),
          Object.assign(el('button', { type: 'button', className: 'subtle tb-small', textContent: 'Change Pokémon' }), { onclick: () => openPicker(current) }),
          Object.assign(el('button', { type: 'button', className: 'subtle tb-small tb-remove', textContent: 'Remove' }), { onclick: removeCurrent })),
        el('div', { className: 'tb-row tb-row-identity' },
          field('Nickname', nickname),
          field('Gender', gender),
          field('Poké Ball', ball),
          field('Friendship', friendship, null, 'tb-narrow'),
          el('label', { className: 'tb-check' }, shiny, el('span', { textContent: 'Shiny' })))));

    // What it holds and can do
    const item = el('input', { className: 'online-input tb-picker-input', type: 'text', value: itemById.get(set.item)?.name || '', placeholder: 'No item', spellcheck: false, autocomplete: 'off' });
    item.addEventListener('focus', () => { item.select(); openItems(item, set, ''); });
    item.addEventListener('input', () => openItems(item, set, item.value));
    item.addEventListener('keydown', event => listKeys(event));
    item.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== item) item.value = itemById.get(set.item)?.name || ''; }, 150));
    const itemDoc = el('small', { className: 'tb-doc', textContent: itemById.get(set.item)?.doc || 'Choose an item for it to hold in battle.' });

    const ability = el('select');
    for (const each of info.abilities) ability.append(el('option', { value: each.slot, textContent: each.name }));
    ability.value = String(info.abilities.some(each => each.slot === set.ability) ? set.ability : info.abilities[0]?.slot ?? 0);
    ability.disabled = info.abilities.length < 2;
    const abilityDoc = el('small', { className: 'tb-doc' });
    const showAbility = () => { abilityDoc.textContent = info.abilities.find(each => each.slot === Number(ability.value))?.doc || ''; };
    ability.addEventListener('change', () => { set.ability = Number(ability.value); showAbility(); });
    showAbility();

    const traits = el('div', { className: 'tb-row tb-row-traits' }, field('Held item', item, itemDoc, 'tb-wide'), field('Ability', ability, abilityDoc, 'tb-wide'));

    // Moves
    const moves = el('div', { className: 'tb-moves' });
    for (let slot = 0; slot < 4; slot++) moves.append(moveField(set, slot));
    const movesNote = el('p', { className: 'helper tb-moves-note' });

    // Stats
    const stats = statsPanel(set);

    identity.querySelector('.tb-identity-main').append(traits);
    $('tb-set').replaceChildren(identity, el('div', { className: 'tb-columns' },
      el('section', { className: 'tb-card tb-card-moves' }, el('h3', { textContent: 'Moves' }), moves, movesNote),
      el('section', { className: 'tb-card tb-card-stats' }, stats)));
    refresh();
  }

  function moveField(set, slot) {
    const learned = learnset(set.species);
    const wrap = el('div', { className: 'tb-move' });
    const input = el('input', { className: 'online-input tb-picker-input', type: 'text', placeholder: `Move ${slot + 1}`, spellcheck: false, autocomplete: 'off' });
    input.setAttribute('aria-label', `Move ${slot + 1}`);
    const facts = el('div', { className: 'tb-move-facts' });
    const show = () => {
      const move = moveById.get(set.moves[slot]);
      input.value = move?.name || '';
      wrap.classList.toggle('filled', Boolean(move));
      wrap.classList.toggle('odd', Boolean(move) && !learned.has(move.id));
      if (!move) { facts.replaceChildren(); return; }
      const hidden = move.id === T.HIDDEN_POWER ? T.hiddenPower(set.ivs) : null;
      const category = hidden ? T.category(hidden.type) : move.category;
      facts.replaceChildren(typeChip(hidden?.type || move.type), el('span', { className: `tb-category ${category.toLowerCase()}`, textContent: category }),
        el('span', { textContent: `${hidden ? hidden.power : move.power > 1 ? move.power : '—'} pow` }),
        el('span', { textContent: `${move.accuracy ? `${move.accuracy}%` : '—'} acc` }),
        el('span', { textContent: `${move.pp} PP` }),
        learned.has(move.id) ? el('span', { className: 'tb-how', textContent: learned.get(move.id) }) : el('span', { className: 'tb-how odd', textContent: 'Not learnable here' }));
    };
    input.addEventListener('focus', () => { input.select(); openMoves(input, set, slot, show, ''); });
    input.addEventListener('input', () => openMoves(input, set, slot, show, input.value));
    input.addEventListener('keydown', event => {
      if (listKeys(event)) return;
      if ((event.key === 'Backspace' || event.key === 'Delete') && !input.value && set.moves[slot]) { setMove(set, slot, 0); show(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) show(); }, 150));
    const clear = el('button', { type: 'button', className: 'tb-clear', title: 'Clear this move', textContent: '×' });
    clear.setAttribute('aria-label', `Clear move ${slot + 1}`);
    clear.addEventListener('click', () => { setMove(set, slot, 0); show(); });
    wrap.append(el('div', { className: 'tb-move-line' }, input, clear), facts);
    wrap.refresh = show;
    show();
    return wrap;
  }

  // Moves stay in order with no gaps, as the game keeps them.
  function setMove(set, slot, id) {
    const moves = set.moves.slice();
    if (id && moves.includes(id)) moves.splice(moves.indexOf(id), 1);
    if (id) moves[Math.min(slot, moves.length)] = id; else moves.splice(slot, 1);
    set.moves = moves.filter(Boolean).slice(0, 4);
    for (const each of $('tb-set').querySelectorAll('.tb-move')) each.refresh?.();
    refresh();
    renderTeam();
  }

  function statsPanel(set) {
    const entry = byId.get(set.species);
    const nature = el('select');
    T.NATURES.forEach((_, i) => nature.append(el('option', { value: i, textContent: T.natureLabel(i) })));
    nature.value = String(set.nature);
    nature.addEventListener('change', () => { set.nature = Number(nature.value); refresh(); renderTeam(); });

    const levels = el('div', { className: 'tb-levels', role: 'group' });
    levels.setAttribute('aria-label', 'Show stats at');
    for (const each of [50, 100]) {
      const button = el('button', { type: 'button', className: 'tb-level', textContent: `Lv ${each}` });
      button.setAttribute('aria-pressed', String(level === each));
      button.addEventListener('click', () => { level = each; for (const other of levels.children) other.setAttribute('aria-pressed', String(other === button)); refresh(); });
      levels.append(button);
    }

    const rows = T.STATS.map((stat, i) => {
      const base = entry?.stats[i] || 0;
      const range = el('input', { type: 'range', min: 0, max: T.EV_MAX, step: 4, value: set.evs[i], className: 'tb-ev-range' });
      range.setAttribute('aria-label', `${T.STAT_NAMES[i]} EVs`);
      const ev = el('input', { type: 'number', min: 0, max: T.EV_MAX, value: set.evs[i], className: 'online-input tb-number' });
      ev.setAttribute('aria-label', `${T.STAT_NAMES[i]} EVs`);
      const iv = el('input', { type: 'number', min: 0, max: T.IV_MAX, value: set.ivs[i], className: 'online-input tb-number' });
      iv.setAttribute('aria-label', `${T.STAT_NAMES[i]} IVs`);
      const setEv = value => {
        const others = set.evs.reduce((sum, each, j) => j === i ? sum : sum + each, 0);
        set.evs[i] = Math.max(0, Math.min(T.EV_MAX, T.EV_TOTAL - others, Math.round(Number(value)) || 0));
        range.value = ev.value = set.evs[i];
        refresh();
      };
      range.addEventListener('input', () => setEv(range.value));
      ev.addEventListener('change', () => setEv(ev.value));
      iv.addEventListener('change', () => { set.ivs[i] = Math.max(0, Math.min(T.IV_MAX, Math.round(Number(iv.value)) || 0)); iv.value = set.ivs[i]; refresh(); });
      const bar = el('i', { className: 'tb-bar' });
      bar.style.setProperty('--stat', `${Math.min(100, base / 2.55)}%`);
      bar.style.setProperty('--hue', String(Math.min(150, base * 0.9)));
      const total = el('output', { className: 'tb-total' });
      const name = el('span', { className: 'tb-stat-name', textContent: T.STAT_NAMES[i] });
      return { row: el('div', { className: 'tb-stat-row' }, name, el('span', { className: 'tb-base' }, el('b', { textContent: base }), bar), range, ev, iv, total),
        name, total, ev, iv, range };
    });

    const remaining = el('output', { className: 'tb-remaining' });
    const hidden = el('select', { className: 'tb-hidden-power' });
    hidden.append(el('option', { value: '', textContent: 'Set IVs for Hidden Power…' }));
    for (const type of T.HIDDEN_POWER_TYPES) hidden.append(el('option', { value: type, textContent: `Hidden Power ${type}` }));
    hidden.addEventListener('change', () => {
      const ivs = T.hiddenPowerIvs(hidden.value);
      hidden.value = '';
      if (!ivs) return;
      set.ivs = ivs;
      rows.forEach((row, i) => { row.iv.value = ivs[i]; });
      refresh();
      for (const each of $('tb-set').querySelectorAll('.tb-move')) each.refresh?.();
    });
    const reset = el('button', { type: 'button', className: 'text-button', textContent: 'Clear EVs' });
    reset.addEventListener('click', () => { set.evs = [0, 0, 0, 0, 0, 0]; rows.forEach(row => { row.ev.value = row.range.value = 0; }); refresh(); });
    const maxIvs = el('button', { type: 'button', className: 'text-button', textContent: 'All IVs 31' });
    maxIvs.addEventListener('click', () => { set.ivs = [31, 31, 31, 31, 31, 31]; rows.forEach(row => { row.iv.value = 31; }); refresh(); for (const each of $('tb-set').querySelectorAll('.tb-move')) each.refresh?.(); });

    statsPanel.rows = rows;
    statsPanel.remaining = remaining;
    return el('div', { className: 'tb-stats' },
      el('div', { className: 'tb-stats-head' }, el('h3', { textContent: 'Stats' }), levels),
      field('Nature', nature, null, 'tb-wide'),
      el('div', { className: 'tb-stat-row tb-stat-labels' }, el('span'), el('span', { textContent: 'Base' }), el('span', { textContent: 'EVs' }), el('span', { textContent: 'IVs' }), el('span', { className: 'tb-level-label', textContent: `Lv ${level}` })),
      ...rows.map(row => row.row),
      el('div', { className: 'tb-stats-foot' }, remaining, el('span', { className: 'nav-spacer' }), reset, maxIvs),
      hidden);
  }

  // What follows from the set: its stats, EVs left, and notes on its moves.
  function refresh() {
    const set = editing.sets[current], panel = statsPanel;
    if (!set || !panel.rows) return;
    const base = byId.get(set.species)?.stats || [0, 0, 0, 0, 0, 0], totals = T.stats(base, set, level), effect = T.natureEffect(set.nature);
    panel.rows.forEach((row, i) => {
      row.total.textContent = totals[i];
      row.name.classList.toggle('up', effect?.up === i);
      row.name.classList.toggle('down', effect?.down === i);
      row.name.title = effect?.up === i ? 'Raised by its nature' : effect?.down === i ? 'Lowered by its nature' : '';
    });
    const used = set.evs.reduce((sum, ev) => sum + ev, 0), left = T.EV_TOTAL - used;
    panel.remaining.textContent = `${left} EVs left of ${T.EV_TOTAL}`;
    const label = $('tb-set').querySelector('.tb-level-label');
    if (label) label.textContent = `Lv ${level}`;
    panel.remaining.classList.toggle('done', left < 4);
    const note = $('tb-set').querySelector('.tb-moves-note');
    if (note) {
      const odd = unlearnable(set).map(id => moveById.get(id)?.name).filter(Boolean);
      note.textContent = !set.moves.length ? `With no moves chosen, ${displayName(set)} battles with the moves it learns by the room's level.`
        : odd.length ? `${speciesName(set.species)} can't learn ${odd.join(' or ')} in this game. It still battles with ${odd.length === 1 ? 'it' : 'them'}.`
        : set.moves.includes(T.HIDDEN_POWER) ? `Hidden Power is ${T.hiddenPower(set.ivs).type}, ${T.hiddenPower(set.ivs).power} power, from its IVs.` : '';
      note.classList.toggle('warn', odd.length > 0);
    }
  }

  function removeCurrent() {
    editing.sets.splice(current, 1);
    current = Math.max(0, Math.min(current, editing.sets.length - 1));
    if (!editing.sets.length) { openPicker(null); return; }
    render();
  }

  // --- The list under a move or item field
  function openList(input, rows, onPick, header, kind) {
    const box = $('tb-list'), main = $('tb-main');
    box.className = `tb-list ${kind}`;
    list = { input, rows, onPick, active: rows.findIndex(row => row.value !== undefined) };
    box.replaceChildren(...(header ? [header] : []), ...rows.map((row, i) => {
      if (row.value === undefined) return el('div', { className: 'tb-list-group', textContent: row.label });
      const option = el('div', { className: 'tb-list-row', id: `tb-option-${i}`, title: row.title || '' }, ...row.cells);
      option.setAttribute('role', 'option');
      option.addEventListener('mousedown', event => { event.preventDefault(); pick(i); });
      option.addEventListener('mousemove', () => highlight(i, false));
      return option;
    }));
    if (!rows.length) box.append(el('p', { className: 'helper tb-empty', textContent: 'Nothing matches that.' }));
    box.hidden = false;
    // under the field, or over it when there's more room above
    const field = input.getBoundingClientRect(), area = main.getBoundingClientRect();
    const below = area.bottom - field.bottom - 10, above = field.top - area.top - 10, under = below >= 240 || below >= above;
    box.style.left = `${Math.max(8, Math.min(field.left - area.left, area.width - box.offsetWidth - 8))}px`;
    box.style.maxHeight = `${Math.max(150, Math.min(360, under ? below : above))}px`;
    box.style.top = `${(under ? field.bottom - area.top + 4 : field.top - area.top - 4 - box.offsetHeight) + main.scrollTop}px`;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'tb-list');
    highlight(list.active, true);
  }

  function closeList() {
    if (list) list.input.setAttribute('aria-expanded', 'false');
    list = null;
    $('tb-list').hidden = true;
  }

  function highlight(i, scroll) {
    if (!list) return;
    list.active = i;
    for (const row of $('tb-list').querySelectorAll('.tb-list-row')) row.classList.toggle('active', row.id === `tb-option-${i}`);
    const row = $(`tb-option-${i}`);
    if (row) list.input.setAttribute('aria-activedescendant', row.id);
    if (scroll) row?.scrollIntoView({ block: 'nearest' });
  }

  function pick(i) {
    const row = list?.rows[i];
    if (!row || row.value === undefined) return;
    const { onPick, input } = list;
    closeList();
    onPick(row.value);
    input.blur();
  }

  // Up, down, Enter and Escape while a list is open. True when the key was the list's.
  function listKeys(event) {
    if (!list) return false;
    const options = list.rows.map((row, i) => row.value === undefined ? -1 : i).filter(i => i >= 0);
    const at = options.indexOf(list.active);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = options[Math.max(0, Math.min(options.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next !== undefined) highlight(next, true);
      return true;
    }
    if (event.key === 'Enter') { event.preventDefault(); pick(list.active); return true; }
    if (event.key === 'Escape') { event.preventDefault(); closeList(); return true; }
    if (event.key === 'Tab') closeList();
    return false;
  }

  function moveRow(move, how, hidden) {
    const category = hidden ? T.category(hidden.type) : move.category;
    return { value: move.id, title: move.doc, cells: [el('span', { className: 'tb-list-name', textContent: move.name }), typeChip(hidden?.type || move.type),
      el('span', { className: `tb-category ${category.toLowerCase()}`, textContent: category }),
      el('span', { className: 'tb-list-num', textContent: hidden ? hidden.power : move.power > 1 ? move.power : '—' }),
      el('span', { className: 'tb-list-num', textContent: move.accuracy ? `${move.accuracy}%` : '—' }),
      el('span', { className: 'tb-list-num', textContent: move.pp }),
      el('span', { className: `tb-how${how ? '' : ' odd'}`, textContent: how || '—' }),
      el('span', { className: 'tb-list-doc', textContent: move.doc })] };
  }

  function openMoves(input, set, slot, show, text) {
    const query = key(text);
    const learned = learnset(set.species), hidden = T.hiddenPower(set.ivs);
    const matches = move => !query || key(move.name).includes(query) || key(move.type) === query || key(move.category) === query;
    const taken = new Set(set.moves.filter((_, i) => i !== slot));
    const own = [...learned].map(([id, how]) => [moveById.get(id), how]).filter(([move]) => move && matches(move) && !taken.has(move.id));
    own.sort((a, b) => a[0].name.localeCompare(b[0].name));
    const rows = own.map(([move, how]) => moveRow(move, how, move.id === T.HIDDEN_POWER ? hidden : null));
    if (query) {
      const others = data.moves.filter(move => !learned.has(move.id) && matches(move) && !taken.has(move.id)).slice(0, LIST_LIMIT);
      if (others.length) rows.push({ label: `Moves ${speciesName(set.species)} can't learn in this game` }, ...others.map(move => moveRow(move, null, move.id === T.HIDDEN_POWER ? hidden : null)));
    }
    const header = el('div', { className: 'tb-list-row tb-list-head' }, ...['Move', 'Type', 'Category', 'Pow', 'Acc', 'PP', 'Learned', ''].map(text => el('span', { textContent: text })));
    openList(input, rows, id => { setMove(set, slot, id); show(); }, header, 'moves');
  }

  function openItems(input, set, text) {
    const query = key(text);
    const rows = query ? [] : [{ value: 0, cells: [el('span', { className: 'tb-list-name', textContent: 'No item' }), el('span', { className: 'tb-list-doc', textContent: 'It holds nothing.' })] }];
    for (const item of data.items) {
      if (query && !key(item.name).includes(query) && !key(item.doc).includes(query)) continue;
      rows.push({ value: item.id, title: item.doc, cells: [el('span', { className: 'tb-list-name', textContent: item.name }), el('span', { className: 'tb-list-doc', textContent: item.doc })] });
    }
    openList(input, rows, id => { set.item = id; input.value = itemById.get(id)?.name || ''; renderSet(); renderTeam(); }, null, 'items');
  }

  // --- Showdown's text
  function openText(mode) {
    closeList();
    const exporting = mode === 'export';
    $('party-text-title').textContent = exporting ? 'Export this team' : 'Import a team';
    $('party-text-intro').textContent = exporting ? 'Copy it into Pokémon Showdown or keep it to share.'
      : 'Paste a team from Pokémon Showdown or another team builder. It takes this party\'s place.';
    $('party-text-box').value = exporting ? T.formatShowdown(editing.sets, dex(), level) : '';
    $('party-text-box').readOnly = exporting;
    $('party-text-copy').hidden = !exporting;
    $('party-text-import').hidden = exporting;
    $('party-text-problems').hidden = true;
    $('party-text-result').textContent = '';
    $('party-text').showModal();
    $('party-text-box').focus();
    if (exporting) $('party-text-box').select();
  }

  function importText() {
    const { sets, problems } = T.parseShowdown($('party-text-box').value, dex());
    $('party-text-problems').replaceChildren(...problems.map(text => el('li', { textContent: text })));
    $('party-text-problems').hidden = !problems.length;
    if (!sets.length) { $('party-text-result').textContent = 'No Pokémon in that text could be brought in.'; return; }
    editing.sets = sets;
    current = 0;
    view = 'set';
    render();
    $('party-text-result').textContent = `Brought in ${sets.length} Pokémon.`;
    if (!problems.length) $('party-text').close();
  }

  // --- The editor as a whole
  function render() {
    const note = loadError || (data && !data.gameTakesSets ? 'Your game is from before sets: it battles with these Pokémon\'s level-up moves until you update it from the Play page.' : '');
    $('party-dex-note').textContent = note;
    $('party-dex-note').hidden = !note;
    if (!data) { renderTeam(); return; }
    if (view === 'set' && !editing.sets[current]) view = 'picker';
    $('tb-picker').hidden = view !== 'picker';
    $('tb-set').hidden = view !== 'set';
    $('party-export').disabled = !editing.sets.length;
    renderTeam();
    if (view === 'picker') renderPicker(); else renderSet();
  }

  function finish() {
    closeList();
    if (!editing) return;
    const done = onDone, party = { ...editing, name: $('party-name').value, members: editing.sets.map(set => set.species) };
    editing = null;
    if (party.sets.length) done?.(party);
  }

  // party: { id, name, members, sets } or null for a new one. done(party) is called once it closes with Pokémon in it.
  async function open(party, { name, level: roomLevel = 50, done, remove, from = null }) {
    const sets = from || (party ? party.sets.map(set => JSON.parse(JSON.stringify(set))) : []);
    editing = { id: party?.id || null, name: party?.name || name, sets };
    onDone = done;
    level = roomLevel;
    current = 0;
    view = sets.length ? 'set' : 'picker';
    replacing = null;
    $('party-name').value = editing.name;
    $('party-search').value = '';
    $('party-delete').hidden = !party;
    $('party-delete').onclick = () => { editing = null; $('party-editor').close(); remove?.(); };
    $('party-dex-note').hidden = true;
    $('tb-set').replaceChildren();
    $('party-dex').replaceChildren(el('p', { className: 'helper tb-empty', textContent: 'Reading the Pokédex from your disc…' }));
    $('tb-picker').hidden = view !== 'picker';
    renderTeam();
    if (!$('party-editor').open) $('party-editor').showModal();
    $('party-slots').querySelector('button:not(:disabled)')?.focus();
    await load();
    if (editing) render();
    if (view === 'picker') $('party-search').focus();
    else $('party-slots').querySelector('.tb-slot.selected')?.focus();
  }

  $('party-editor').addEventListener('close', finish);
  // Escape closes a list before the editor
  $('party-editor').addEventListener('cancel', event => { if (list) { event.preventDefault(); closeList(); } });
  $('party-editor-close').addEventListener('click', () => $('party-editor').close());
  $('party-save').addEventListener('click', () => $('party-editor').close());
  $('party-search').addEventListener('input', renderPicker);
  $('party-search').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); $('party-dex').querySelector('.tb-dex-row')?.click(); }
  });
  $('tb-picker-cancel').addEventListener('click', () => { view = 'set'; replacing = null; render(); });
  $('party-import').addEventListener('click', () => openText('import'));
  $('party-export').addEventListener('click', () => openText('export'));
  $('party-text-import').addEventListener('click', importText);
  $('party-text-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('party-text-box').value); $('party-text-result').textContent = 'Copied.'; }
    catch (_) { $('party-text-box').select(); document.execCommand('copy'); $('party-text-result').textContent = 'Copied.'; }
  });
  $('tb-main').addEventListener('scroll', () => { if (list && !list.input.matches(':focus')) closeList(); });
  document.addEventListener('mousedown', event => {
    if (list && !$('tb-list').contains(event.target) && event.target !== list.input) closeList();
  });

  window.coloTeamBuilder = { open, load, sprite: (id, size) => sprite(id, size), speciesName, data: () => data };
})();
