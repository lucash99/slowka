(function () {
  'use strict';

  const { State, schedule, dayNumber, hash, DEFAULTS } = window.FSRS;
  const DAY_ROLLOVER = DEFAULTS.rolloverHour;
  const LEARN_AHEAD_MS = 20 * 60 * 1000;

  /* ---------- Model danych i zapis ----------
   * Każdy rekord ma updatedAt, usunięcia są oznaczane polem deleted, a identyfikatory
   * są losowe. Dzięki temu dwie kopie bazy można scalić funkcją merge(), z której
   * korzysta import pliku i synchronizacja między urządzeniami.
   */
  const KEY = 'english.db.v1';
  const DIRS = ['en-pl', 'pl-en'];
  const NOTE_ID = /^[0-9a-f]{32}$/;
  const CARD_ID = /^([0-9a-f]{32}):(en-pl|pl-en)$/;

  function emptyDb() {
    return {
      version: 1,
      notes: {},
      cards: {},
      revlog: [],
      settings: { newPerDay: 20, retention: 0.9, separateDirections: true, updatedAt: 0 },
    };
  }

  const num = (x, fallback = 0) => (typeof x === 'number' && isFinite(x) ? x : fallback);
  const text = (x) => (typeof x === 'string' ? x : '');

  function cleanNote(id, n) {
    if (!NOTE_ID.test(id) || !n || typeof n !== 'object') return null;
    if (!n.deleted && (!text(n.word).trim() || !text(n.translation).trim())) return null;
    return {
      id,
      word: text(n.word),
      translation: text(n.translation),
      pos: text(n.pos),
      definition: text(n.definition),
      example: text(n.example),
      createdAt: num(n.createdAt),
      updatedAt: num(n.updatedAt),
      deleted: !!n.deleted,
    };
  }

  function cleanCard(id, c) {
    const m = CARD_ID.exec(id);
    if (!m || !c || typeof c !== 'object') return null;
    const state = num(c.state, -1);
    if (![0, 1, 2, 3].includes(state)) return null;
    if (state !== State.NEW && !(num(c.s) > 0 && num(c.d) >= 1 && num(c.d) <= 10)) return null;
    return {
      id,
      noteId: m[1],
      dir: m[2],
      state,
      step: Math.max(0, Math.floor(num(c.step))),
      s: num(c.s),
      d: num(c.d),
      due: num(c.due),
      last: num(c.last),
      reps: Math.max(0, Math.floor(num(c.reps))),
      lapses: Math.max(0, Math.floor(num(c.lapses))),
      updatedAt: num(c.updatedAt),
      deleted: !!c.deleted,
    };
  }

  /** Scala `incoming` do `target`: dla każdego rekordu wygrywa nowsza wersja. Zwraca liczbę zmian. */
  function merge(target, incoming) {
    let changed = 0;
    const take = (store, source, clean) => {
      for (const [id, raw] of Object.entries(source || {})) {
        const rec = clean(id, raw);
        if (!rec) continue;
        const cur = Object.prototype.hasOwnProperty.call(store, id) ? store[id] : null;
        if (!cur || rec.updatedAt > cur.updatedAt) {
          store[id] = rec;
          changed++;
        }
      }
    };
    take(target.notes, incoming.notes, cleanNote);
    take(target.cards, incoming.cards, cleanCard);

    const logs = new Map(target.revlog.map((r) => [r.id, r]));
    for (const r of Array.isArray(incoming.revlog) ? incoming.revlog : []) {
      if (!r || typeof r.id !== 'string' || !num(r.ts)) continue;
      const cur = logs.get(r.id);
      const entry = {
        id: r.id,
        cardId: text(r.cardId),
        ts: r.ts,
        rating: num(r.rating),
        state: num(r.state),
        wasNew: !!r.wasNew,
        undone: !!r.undone || !!(cur && cur.undone),
      };
      if (!cur || entry.undone !== cur.undone) changed++;
      logs.set(r.id, entry);
    }
    target.revlog = [...logs.values()].sort((a, b) => a.ts - b.ts);

    const s = incoming.settings;
    if (s && typeof s === 'object' && num(s.updatedAt) > target.settings.updatedAt) {
      target.settings = {
        newPerDay: clampInt(s.newPerDay, 0, 200, 20),
        retention: clampNum(s.retention, 0.8, 0.97, 0.9),
        separateDirections: s.separateDirections !== false,
        updatedAt: s.updatedAt,
      };
      changed++;
    }
    return changed;
  }

  function clampInt(x, lo, hi, fallback) {
    const n = Math.round(Number(x));
    return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  }
  function clampNum(x, lo, hi, fallback) {
    const n = Number(x);
    return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  }

  const LocalStore = {
    load() {
      const db = emptyDb();
      let raw = null;
      try {
        raw = localStorage.getItem(KEY);
        if (raw) merge(db, JSON.parse(raw));
      } catch (e) {
        // Uszkodzonych danych nie nadpisujemy bez śladu.
        try { if (raw) localStorage.setItem(KEY + '.corrupt', raw); } catch (_) {}
      }
      return db;
    },
    save(data) {
      try {
        localStorage.setItem(KEY, JSON.stringify(data));
        return true;
      } catch (e) {
        return false;
      }
    },
  };

  let db = LocalStore.load();

  function persist() {
    if (!LocalStore.save(db)) toast('Nie udało się zapisać danych w przeglądarce. Zrób kopię zapasową.');
    scheduleSync();
  }

  function uuid() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  const now = () => Date.now();
  const today = (t = now()) => dayNumber(t, DAY_ROLLOVER);
  const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const liveNotes = () => Object.values(db.notes).filter((n) => !n.deleted);
  const sameWord = (word, exceptId) => liveNotes().filter((n) => norm(n.word) === norm(word) && n.id !== exceptId);
  const splitTranslation = (s) => s.split(',').map(norm).filter(Boolean);
  const sameTranslation = (a, b) => splitTranslation(a).sort().join('|') === splitTranslation(b).sort().join('|');

  function liveCards() {
    return Object.values(db.cards).filter((c) => !c.deleted && db.notes[c.noteId] && !db.notes[c.noteId].deleted);
  }

  function addNote(fields) {
    const t = now();
    const id = uuid();
    db.notes[id] = Object.assign({ id, createdAt: t, updatedAt: t, deleted: false }, fields);
    for (const dir of DIRS) {
      const cardId = id + ':' + dir;
      db.cards[cardId] = {
        id: cardId, noteId: id, dir, state: State.NEW, step: 0, s: 0, d: 0,
        due: t, last: 0, reps: 0, lapses: 0, updatedAt: t, deleted: false,
      };
    }
    persist();
  }

  function updateNote(id, fields) {
    db.notes[id] = Object.assign({}, db.notes[id], fields, { updatedAt: now() });
    persist();
  }

  function deleteNote(id) {
    const t = now();
    db.notes[id] = Object.assign({}, db.notes[id], { deleted: true, updatedAt: t });
    for (const dir of DIRS) {
      const c = db.cards[id + ':' + dir];
      if (c) db.cards[c.id] = Object.assign({}, c, { deleted: true, updatedAt: t });
    }
    if (session.id && session.id.startsWith(id)) resetSession();
    undoState = undoState && undoState.before.noteId === id ? null : undoState;
    persist();
  }

  /* ---------- Kolejka nauki ---------- */

  function buildQueue(t = now()) {
    const day = today(t);
    const cards = liveCards();
    const sep = db.settings.separateDirections;
    const newDone = db.revlog.filter((r) => r.wasNew && !r.undone && today(r.ts) === day).length;

    // Żeby inny kierunek lub inne znaczenie tego samego słowa nie były podpowiedzią,
    // odkładamy je na następny dzień.
    const wordOf = (c) => norm(db.notes[c.noteId].word);
    const blocked = new Set();
    if (sep) {
      for (const c of cards) {
        const learning = c.state === State.LEARNING || c.state === State.RELEARNING;
        if (learning || (c.last && today(c.last) === day)) blocked.add(wordOf(c));
      }
    }
    const pick = (list, limit) => {
      const out = [];
      for (const c of list) {
        if (out.length >= limit) break;
        if (sep && blocked.has(wordOf(c))) continue;
        if (sep) blocked.add(wordOf(c));
        out.push(c);
      }
      return out;
    };

    const learning = cards
      .filter((c) => c.state === State.LEARNING || c.state === State.RELEARNING)
      .sort((a, b) => a.due - b.due);
    const review = cards
      .filter((c) => c.state === State.REVIEW && c.due <= t)
      .sort((a, b) => a.due - b.due || hash(a.id) - hash(b.id));
    const fresh = cards
      .filter((c) => c.state === State.NEW)
      .sort((a, b) => db.notes[a.noteId].createdAt - db.notes[b.noteId].createdAt || DIRS.indexOf(a.dir) - DIRS.indexOf(b.dir));

    return {
      learnDue: learning.filter((c) => c.due <= t),
      later: learning.filter((c) => c.due > t),
      review: pick(review, Infinity),
      fresh: pick(fresh, Math.max(0, db.settings.newPerDay - newDone)),
    };
  }

  function nextCard(q, t = now()) {
    const direct = q.learnDue[0] || q.review[0] || q.fresh[0];
    if (direct) return direct;
    const soon = q.later[0];
    return soon && soon.due - t <= LEARN_AHEAD_MS ? soon : null;
  }

  /* ---------- Synchronizacja przez GitHub ----------
   * Cała baza leży w jednym pliku JSON w prywatnym repozytorium. Każda synchronizacja
   * pobiera plik, scala go z bazą lokalną i odsyła wynik, jeśli GitHubowi czegoś brakuje.
   * Token i nazwa repozytorium zostają na urządzeniu: nie trafiają do bazy ani do eksportu.
   */
  const SYNC_KEY = 'english.sync.v1';
  const SYNC_FILE = 'slowka.json';
  const SYNC_DEBOUNCE_MS = 10000;
  const SYNC_MIN_GAP_MS = 30000;
  const SYNC_ATTEMPTS = 4;

  function loadSyncConfig() {
    try {
      const c = JSON.parse(localStorage.getItem(SYNC_KEY));
      return c && c.owner && c.repo && c.token ? c : null;
    } catch (e) {
      return null;
    }
  }

  const sync = { config: loadSyncConfig(), running: false, again: false, lastAt: 0, error: '', timer: null };
  let syncStatusEl = null;

  function paintSync() {
    if (!syncStatusEl) return;
    let msg = 'Jeszcze nie synchronizowano na tym urządzeniu.';
    if (sync.running) msg = 'Synchronizuję…';
    else if (sync.error) msg = sync.error;
    else if (sync.lastAt) msg = 'Ostatnia synchronizacja: ' + new Date(sync.lastAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    syncStatusEl.textContent = msg;
    syncStatusEl.className = 'hint' + (sync.error && !sync.running ? ' bad' : '');
  }

  function syncError(code) {
    const messages = {
      401: 'GitHub odrzucił token. Sprawdź, czy jest aktualny.',
      403: 'Token nie ma prawa zapisu do tego repozytorium albo wyczerpał się limit zapytań.',
      404: 'Nie znaleziono repozytorium. Sprawdź jego nazwę i dostęp tokena.',
      format: 'Plik ' + SYNC_FILE + ' w repozytorium nie wygląda na bazę słówek, więc go nie nadpisuję.',
      conflict: 'Dane zmieniały się w trakcie synchronizacji. Spróbuję ponownie później.',
    };
    return new Error(messages[code] || 'GitHub zwrócił błąd ' + code + '.');
  }

  function gh(path, init) {
    const { owner, repo, token } = sync.config;
    const options = Object.assign({ cache: 'no-store', referrerPolicy: 'no-referrer' }, init);
    options.headers = Object.assign({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
    }, init && init.headers);
    return fetch('https://api.github.com/repos/' + owner + '/' + repo + path, options);
  }

  function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function fromBase64(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  async function pullRemote() {
    const res = await gh('/contents/' + SYNC_FILE);
    if (res.status === 404) return null;
    if (!res.ok) throw syncError(res.status);
    const meta = await res.json();
    let body;
    if (meta.encoding === 'base64' && meta.content) {
      body = fromBase64(meta.content);
    } else {
      // Pliki powyżej 1 MB API oddaje bez treści, trzeba je pobrać osobno.
      const raw = await gh('/contents/' + SYNC_FILE, { headers: { Accept: 'application/vnd.github.raw+json' } });
      if (!raw.ok) throw syncError(raw.status);
      body = await raw.text();
    }
    if (!body.trim()) return { sha: meta.sha, data: null };
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      throw syncError('format');
    }
    if (!data || typeof data.notes !== 'object' || typeof data.cards !== 'object') throw syncError('format');
    return { sha: meta.sha, data };
  }

  /** Zwraca true po zapisaniu, false gdy ktoś inny zdążył zmienić plik. */
  async function pushRemote(sha) {
    const res = await gh('/contents/' + SYNC_FILE, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(
        { message: 'Aktualizacja słówek', content: toBase64(JSON.stringify(db)) },
        sha ? { sha } : {},
      )),
    });
    if (res.status === 409 || res.status === 422) return false;
    if (!res.ok) throw syncError(res.status);
    return true;
  }

  function applyRemote(data) {
    const stamp = (id) => (id && db.cards[id] ? db.cards[id].updatedAt : 0);
    const sessionStamp = stamp(session.id);
    const undoStamp = undoState ? stamp(undoState.before.id) : 0;
    const changed = merge(db, data);
    if (!changed) return;
    // Karta, której dotyczy bieżąca fiszka lub "Cofnij", mogła zostać przerobiona gdzie indziej.
    if (session.id && stamp(session.id) !== sessionStamp) resetSession();
    if (undoState && stamp(undoState.before.id) !== undoStamp) undoState = null;
    if (!LocalStore.save(db)) toast('Nie udało się zapisać danych w przeglądarce. Zrób kopię zapasową.');
    if (view === 'study' || view === 'list') render();
  }

  function remoteIsMissingLocalChanges(remote) {
    if (!remote || !remote.data) return true;
    const copy = emptyDb();
    merge(copy, remote.data);
    return merge(copy, db) > 0;
  }

  async function runSync(manual) {
    if (!sync.config) return;
    if (sync.running) {
      sync.again = true;
      return;
    }
    clearTimeout(sync.timer);
    sync.timer = null;
    sync.running = true;
    const previousError = sync.error;
    sync.error = '';
    paintSync();
    try {
      for (let attempt = 1; ; attempt++) {
        const remote = await pullRemote();
        if (remote && remote.data) applyRemote(remote.data);
        if (!remoteIsMissingLocalChanges(remote)) break;
        if (await pushRemote(remote && remote.sha)) break;
        if (attempt >= SYNC_ATTEMPTS) throw syncError('conflict');
      }
      sync.lastAt = now();
      if (manual) toast('Zsynchronizowano');
    } catch (e) {
      sync.error = e instanceof TypeError ? 'Brak połączenia z GitHubem. Dane są bezpieczne na tym urządzeniu.' : e.message;
      if (manual || sync.error !== previousError) toast(sync.error);
    } finally {
      sync.running = false;
      paintSync();
      if (sync.again) {
        sync.again = false;
        runSync();
      }
    }
  }

  function scheduleSync() {
    if (!sync.config) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(runSync, SYNC_DEBOUNCE_MS);
  }

  /** Przyjmuje "wlasciciel/repo" albo wklejony adres repozytorium. */
  function parseRepo(value) {
    const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(value.trim());
    return m ? { owner: m[1], repo: m[2] } : null;
  }

  async function connectSync(repoValue, tokenValue) {
    const parsed = parseRepo(repoValue);
    if (!parsed) throw new Error('Podaj repozytorium w formacie właściciel/nazwa.');
    const token = tokenValue.trim();
    if (!token) throw new Error('Wklej token.');
    sync.config = Object.assign(parsed, { token });
    try {
      const res = await gh('');
      if (!res.ok) throw syncError(res.status);
      const info = await res.json();
      if (!info.private) throw new Error('To repozytorium jest publiczne. Słówka i historia nauki byłyby widoczne dla wszystkich, użyj prywatnego.');
    } catch (e) {
      sync.config = null;
      throw e instanceof TypeError ? new Error('Brak połączenia z GitHubem.') : e;
    }
    try {
      localStorage.setItem(SYNC_KEY, JSON.stringify(sync.config));
    } catch (e) {
      sync.config = null;
      throw new Error('Nie udało się zapisać ustawień w przeglądarce.');
    }
    await runSync(true);
  }

  function disconnectSync() {
    clearTimeout(sync.timer);
    sync.config = null;
    sync.error = '';
    sync.lastAt = 0;
    try { localStorage.removeItem(SYNC_KEY); } catch (e) {}
  }

  /* ---------- Stan interfejsu ---------- */

  let view = 'study';
  let editId = null;
  let search = '';
  let session = { id: null, revealed: false };
  let undoState = null;

  function resetSession() {
    session = { id: null, revealed: false };
  }

  const cfg = () => ({ retention: db.settings.retention });

  function answer(rating) {
    const card = db.cards[session.id];
    if (!card) return;
    const t = now();
    const result = schedule(card, t, cfg())[rating];
    const logId = uuid();
    db.cards[card.id] = Object.assign({}, result.card, { updatedAt: t });
    db.revlog.push({ id: logId, cardId: card.id, ts: t, rating, state: card.state, wasNew: card.state === State.NEW, undone: false });
    undoState = { before: card, logId };
    resetSession();
    persist();
    render();
  }

  function undo() {
    if (!undoState) return;
    const { before, logId } = undoState;
    db.cards[before.id] = Object.assign({}, before, { updatedAt: now() });
    const log = db.revlog.find((r) => r.id === logId);
    if (log) log.undone = true;
    undoState = null;
    session = { id: before.id, revealed: false };
    persist();
    render();
  }

  /* ---------- Pomocnicze elementy DOM ---------- */

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled') node[k] = !!v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child);
    }
    return node;
  }

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  const SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3zm12.5 3a4 4 0 0 0-2-3.5v7a4 4 0 0 0 2-3.5zm-2-8v2.1a6.5 6.5 0 0 1 0 11.8V20a8.5 8.5 0 0 0 0-16z"/></svg>';

  function speakButton(word) {
    if (!('speechSynthesis' in window)) return null;
    const b = el('button', {
      class: 'speak', type: 'button', 'aria-label': 'Wymów: ' + word,
      onclick: () => {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(word);
        u.lang = 'en-GB';
        speechSynthesis.speak(u);
      },
    });
    b.innerHTML = SPEAKER;
    return b;
  }

  function fmtNumber(x) {
    return x.toFixed(1).replace(/\.0$/, '').replace('.', ',');
  }

  function fmtDays(d) {
    if (d < 30) return d + ' d';
    if (d < 365) return fmtNumber(d / 30.44) + ' mies.';
    return fmtNumber(d / 365.25) + ' l.';
  }

  function fmtOption(o) {
    if (o.days !== null) return fmtDays(o.days);
    if (o.minutes < 60) return o.minutes + ' min';
    if (o.minutes < 1440) return fmtNumber(o.minutes / 60) + ' godz.';
    return fmtDays(Math.round(o.minutes / 1440));
  }

  /* ---------- Widok: nauka ---------- */

  const GRADES = [
    { g: 1, label: 'Znowu', color: 'var(--again)' },
    { g: 2, label: 'Trudne', color: 'var(--hard)' },
    { g: 3, label: 'Dobrze', color: 'var(--good)' },
    { g: 4, label: 'Łatwe', color: 'var(--easy)' },
  ];

  /** Zasłania słowo w zdaniu, także w odmienionej formie (come along, came along, coming along). */
  function maskWord(sentence, word) {
    const tokens = norm(word).split(' ').map((t) => t.replace(/[^a-z'-]/g, '')).filter(Boolean);
    if (!tokens.length) return null;
    const stem = tokens[0].length > 2 ? tokens[0].replace(/e$/, '') : tokens[0];
    const rest = tokens.slice(1).map((t) => '\\s+' + t).join('');
    for (const first of [stem, stem.replace(/[aeiouy]+/g, '[aeiouy]+')]) {
      const re = new RegExp('\\b' + first + '\\w*' + rest + '\\b', 'i');
      if (re.test(sentence)) return sentence.replace(re, '_____');
    }
    return null;
  }

  /** Tekst pod pytaniem, który wskazuje, o które znaczenie chodzi. Zwraca null, gdy nie jest potrzebny. */
  function cardContext(note, enFirst) {
    const others = liveNotes().filter((n) => n.id !== note.id);
    const otherMeanings = others.some((n) => norm(n.word) === norm(note.word));
    if (enFirst) {
      return otherMeanings ? (note.example || note.definition || 'Jedno z kilku znaczeń tego słowa') : null;
    }
    const mine = new Set(splitTranslation(note.translation));
    const sharedTranslation = others.some((n) => splitTranslation(n.translation).some((p) => mine.has(p)));
    if (!otherMeanings && !sharedTranslation) return null;
    // Przykładu bez zasłoniętego słowa nie pokazujemy, bo zdradzałby odpowiedź.
    const masked = note.example && maskWord(note.example, note.word);
    if (masked) return masked;
    return note.definition ? (maskWord(note.definition, note.word) || note.definition) : null;
  }

  function renderStudy() {
    const t = now();
    const q = buildQueue(t);

    const current = session.id && db.cards[session.id];
    if (!current || current.deleted) {
      const next = nextCard(q, t);
      session = { id: next ? next.id : null, revealed: false };
    }

    const counts = el('div', { class: 'counts' },
      el('div', {}, el('b', {}, String(q.fresh.length)), el('span', {}, 'Nowe')),
      el('div', {}, el('b', {}, String(q.learnDue.length + q.later.length)), el('span', {}, 'W nauce')),
      el('div', {}, el('b', {}, String(q.review.length)), el('span', {}, 'Powtórki')),
    );

    if (!liveNotes().length) {
      return [el('h1', {}, 'Nauka'), el('div', { class: 'empty' },
        el('h2', {}, 'Nie masz jeszcze słówek'),
        el('p', {}, 'Dodaj pierwsze, a pojawią się tu jako fiszki w obie strony.'),
        el('button', { class: 'primary', type: 'button', onclick: () => go('add') }, 'Dodaj słówko'),
      )];
    }

    if (!session.id) {
      const later = q.later[0];
      return [el('h1', {}, 'Nauka'), counts, el('div', { class: 'empty' },
        el('h2', {}, 'Na teraz koniec'),
        el('p', {}, later
          ? 'Kolejna karta wróci za ' + Math.max(1, Math.ceil((later.due - t) / 60000)) + ' min.'
          : 'Wszystkie zaplanowane karty są przerobione.'),
        undoState && el('button', { class: 'link', type: 'button', onclick: undo }, 'Cofnij ostatnią odpowiedź'),
      )];
    }

    const card = db.cards[session.id];
    const note = db.notes[card.noteId];
    const enFirst = card.dir === 'en-pl';

    const front = enFirst
      ? el('div', { class: 'prompt' }, el('span', { class: 'display' }, note.word), speakButton(note.word))
      : el('div', { class: 'prompt' }, el('span', { class: 'display' }, note.translation));

    const context = cardContext(note, enFirst);

    const flash = el('div', { class: 'flash' },
      el('div', { class: 'dir' }, enFirst ? 'ANGIELSKI → POLSKI' : 'POLSKI → ANGIELSKI'),
      front,
      context && el('p', { class: 'context' }, context),
      !enFirst && !session.revealed && note.pos && el('p', { class: 'meta center' }, note.pos),
      session.revealed && el('div', { class: 'answer' },
        el('div', { class: 'main' },
          el('span', {}, enFirst ? note.translation : note.word),
          !enFirst && speakButton(note.word)),
        note.pos && el('p', { class: 'meta' }, note.pos),
        note.definition && note.definition !== context && el('p', { class: 'meta' }, note.definition),
        note.example && note.example !== context && el('p', { class: 'meta example' }, note.example),
      ),
    );

    let controls;
    if (session.revealed) {
      const options = schedule(card, t, cfg());
      controls = el('div', { class: 'grades' }, GRADES.map(({ g, label, color }) =>
        el('button', { type: 'button', style: '--c:' + color, onclick: () => answer(g), 'aria-keyshortcuts': String(g) },
          label, el('small', {}, fmtOption(options[g])))));
    } else {
      controls = el('button', { class: 'primary wide', type: 'button', onclick: reveal }, 'Pokaż odpowiedź');
    }

    return [
      el('h1', { class: 'sr' }, 'Nauka'),
      counts,
      flash,
      el('div', { class: 'actions' }, controls),
      undoState && el('div', { class: 'center' }, el('button', { class: 'link', type: 'button', onclick: undo }, 'Cofnij ostatnią odpowiedź')),
    ];
  }

  function reveal() {
    session.revealed = true;
    render();
  }

  /* ---------- Wyszukiwanie tłumaczeń ---------- */

  const POS_PL = {
    noun: 'rzeczownik', verb: 'czasownik', adjective: 'przymiotnik', adverb: 'przysłówek',
    pronoun: 'zaimek', preposition: 'przyimek', conjunction: 'spójnik', interjection: 'wykrzyknik',
    determiner: 'określnik', 'proper noun': 'nazwa własna', phrase: 'wyrażenie', idiom: 'idiom',
  };

  async function fetchJson(url, signal) {
    const res = await fetch(url, { signal, referrerPolicy: 'no-referrer' });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function cleanWikitext(s) {
    return s
      .replace(/<ref[^>]*\/>/g, '')
      .replace(/<ref[\s\S]*?<\/ref>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\{[^{}]*\}\}/g, '')
      .replace(/'''[^']*'''\s*→/g, '') // wpisy typu: '''come along!''' → dalej!
      .replace(/'''/g, '')
      .replace(/''[^']*''/g, '')
      .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
      .replace(/\[\[([^\]]*)\]\]/g, '$1')
      .replace(/\([^)]*,[^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Wyciąga z wikitekstu Wikisłownika polskie znaczenia hasła angielskiego. */
  function parseWikislownik(wikitext) {
    const start = wikitext.search(/^==[^\n]*język angielski[^\n]*==\s*$/m);
    if (start < 0) return null;
    const section = wikitext.slice(start);
    const nextHeading = section.slice(2).search(/^== /m);
    const entry = nextHeading < 0 ? section : section.slice(0, nextHeading + 2);
    const at = entry.indexOf('{{znaczenia}}');
    if (at < 0) return null;
    const body = entry.slice(at + '{{znaczenia}}'.length);
    const stop = body.search(/^\{\{[^}]+\}\}/m);
    const lines = (stop < 0 ? body : body.slice(0, stop)).split('\n');

    let pos = '';
    const items = [];
    for (const line of lines) {
      if (line.startsWith("''") && !pos) {
        pos = line.replace(/\{\{([^{}|]*)[^{}]*\}\}/g, '$1').replace(/'/g, '').trim();
      } else if (/^:\s*\(\d/.test(line)) {
        const sense = cleanWikitext(line.replace(/^:\s*\([^)]*\)/, ''));
        for (const part of sense.split(/[,;]/)) {
          const value = part.trim();
          if (value && value.length <= 40 && !items.includes(value)) items.push(value);
        }
      }
    }
    return { items: items.slice(0, 12), pos };
  }

  /** Polskie znaczenia z Wikisłownika, czyli źródła słownikowego. */
  async function lookupWikislownik(word, signal) {
    const url = 'https://pl.wiktionary.org/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&redirects=1&origin=*&page=' + encodeURIComponent(norm(word));
    const data = await fetchJson(url, signal);
    if (data.error || !data.parse) return null;
    return parseWikislownik(text(data.parse.wikitext));
  }

  /** Rezerwa dla słów spoza Wikisłownika. To pamięć tłumaczeń, więc wyniki bywają przypadkowe. */
  async function lookupMyMemory(word, signal) {
    const url = 'https://api.mymemory.translated.net/get?langpair=en%7Cpl&q=' + encodeURIComponent(word);
    const data = await fetchJson(url, signal);
    if (data.quotaFinished) throw new Error('quota');
    const target = norm(word);
    const out = [];
    for (const m of Array.isArray(data.matches) ? data.matches : []) {
      if (typeof m.segment !== 'string' || norm(m.segment) !== target || typeof m.translation !== 'string') continue;
      const clean = m.translation.trim().replace(/[.,;:!?]+$/, '').toLocaleLowerCase('pl');
      if (clean && clean !== target && clean.length <= 40 && !out.includes(clean)) out.push(clean);
    }
    return out.slice(0, 6);
  }

  async function lookupTranslations(word, signal) {
    let polish = null;
    try {
      polish = await lookupWikislownik(word, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
    if (polish && polish.items.length) return { items: polish.items, pos: polish.pos, dictionary: true };
    return { items: await lookupMyMemory(word, signal), pos: '', dictionary: false };
  }

  function stripHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('ol,ul,style,script').forEach((n) => n.remove());
    return doc.body.textContent.replace(/\s+/g, ' ').trim();
  }

  /** Znaczenia z Wiktionary: część mowy, definicja i przykład każdego z nich. */
  async function lookupSenses(word, signal) {
    const title = encodeURIComponent(norm(word).replace(/ /g, '_'));
    const data = await fetchJson('https://en.wiktionary.org/api/rest_v1/page/definition/' + title, signal);
    const senses = [];
    for (const entry of Array.isArray(data.en) ? data.en : []) {
      for (const d of Array.isArray(entry.definitions) ? entry.definitions : []) {
        const definition = stripHtml(text(d.definition));
        if (!definition || /^(\w+ )*(spelling|form) of /i.test(definition)) continue;
        const example = Array.isArray(d.parsedExamples) && d.parsedExamples[0] ? stripHtml(text(d.parsedExamples[0].example)) : '';
        const pos = text(entry.partOfSpeech).toLowerCase();
        senses.push({ pos: POS_PL[pos] || pos, definition, example });
      }
    }
    return senses.slice(0, 8);
  }

  /* ---------- Widok: dodawanie i edycja ---------- */

  const cambridgeUrl = (word) => 'https://dictionary.cambridge.org/dictionary/english-polish/' + encodeURIComponent(norm(word).replace(/ /g, '-'));

  function renderForm(note) {
    const word = el('input', { type: 'text', id: 'f-word', value: note ? note.word : '', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', required: true, enterkeyhint: 'search' });
    const translation = el('input', { type: 'text', id: 'f-tr', value: note ? note.translation : '', autocomplete: 'off', required: true });
    const pos = el('input', { type: 'text', value: note ? note.pos : '', autocomplete: 'off' });
    const definition = el('textarea', { rows: '2' });
    definition.value = note ? note.definition : '';
    const example = el('textarea', { rows: '2' });
    example.value = note ? note.example : '';

    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Propozycje tłumaczeń' });
    const status = el('p', { class: 'hint', role: 'status' });
    const senses = el('div', { class: 'senses', role: 'group', 'aria-label': 'Znaczenia z Wiktionary' });
    const sensesBox = el('div', { hidden: true, style: 'margin-bottom:14px' },
      el('p', { class: 'hint', style: 'margin:0 0 6px' }, 'Wybierz definicję i przykład pasujące do tłumaczenia:'), senses);
    const savedHint = el('p', { class: 'hint', hidden: true });
    const cambridge = el('a', { target: '_blank', rel: 'noopener noreferrer' }, 'Sprawdź w Cambridge');
    const cambridgeHint = el('p', { class: 'hint' }, cambridge);

    const syncCambridge = () => {
      const w = word.value.trim();
      cambridgeHint.hidden = !w;
      if (w) cambridge.href = cambridgeUrl(w);
    };
    syncCambridge();

    const parts = () => translation.value.split(',').map((s) => s.trim()).filter(Boolean);
    const paintChips = () => {
      const chosen = parts();
      for (const b of chips.children) b.setAttribute('aria-pressed', String(chosen.includes(b.dataset.value)));
    };
    translation.addEventListener('input', paintChips);

    const setStatus = (msg, bad) => {
      status.textContent = msg;
      status.className = 'hint' + (bad ? ' bad' : '');
    };

    let lookupRun = 0;
    let controller = null;
    let foundTranslations = [];
    let foundSenses = [];
    let foundInDictionary = false;

    const savedMeanings = () => sameWord(word.value, note && note.id);
    const usedTranslations = () => new Set(savedMeanings().flatMap((n) => splitTranslation(n.translation)));

    const another = !note && el('button', {
      class: 'secondary', type: 'button', hidden: true, onclick: () => save(true),
    }, 'Dodaj i kolejne znaczenie');

    function paintSenses() {
      const current = definition.value.trim();
      for (const b of senses.children) b.setAttribute('aria-pressed', String(b.dataset.definition === current));
    }
    definition.addEventListener('input', paintSenses);

    function pickSense(sense) {
      definition.value = sense.definition;
      example.value = sense.example;
      pos.value = sense.pos;
      paintSenses();
    }

    function renderSuggestions() {
      const used = usedTranslations();
      chips.replaceChildren(...foundTranslations.map((value) => {
        const isUsed = used.has(norm(value));
        return el('button', {
          type: 'button', 'data-value': value, 'aria-pressed': 'false', disabled: isUsed,
          title: isUsed ? 'To znaczenie już masz' : null,
          onclick: () => {
            const cur = parts();
            translation.value = (cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]).join(', ');
            paintChips();
          },
        }, value);
      }));
      senses.replaceChildren(...foundSenses.map((sense) =>
        el('button', { type: 'button', 'data-definition': sense.definition, 'aria-pressed': 'false', onclick: () => pickSense(sense) },
          sense.definition, sense.example && el('small', {}, sense.example))));
      sensesBox.hidden = foundSenses.length < 2;
      if (another) another.hidden = foundTranslations.length < 2 && foundSenses.length < 2;
      paintChips();
      paintSenses();
    }

    /** Wypełnia puste pola pierwszą propozycją, której jeszcze nie ma w zapisanych znaczeniach. */
    function fillEmptyFields() {
      if (foundInDictionary && !translation.value.trim()) {
        const used = usedTranslations();
        const next = foundTranslations.find((v) => !used.has(norm(v)));
        if (next) translation.value = next;
      }
      if (!definition.value && !example.value) {
        const usedDefinitions = new Set(savedMeanings().map((n) => n.definition));
        const next = foundSenses.find((s) => !usedDefinitions.has(s.definition));
        if (next) pickSense(next);
      }
      paintChips();
    }

    function clearSuggestions() {
      foundTranslations = [];
      foundSenses = [];
      foundInDictionary = false;
      renderSuggestions();
    }

    function syncSaved() {
      const saved = word.value.trim() ? savedMeanings() : [];
      savedHint.hidden = !saved.length;
      savedHint.textContent = saved.length
        ? 'Masz już to słowo: ' + saved.map((n) => n.translation).join(' · ') + '. Możesz dodać kolejne znaczenie.'
        : '';
    }
    syncSaved();

    async function lookup() {
      const w = word.value.trim();
      if (!w) {
        word.focus();
        return;
      }
      const run = ++lookupRun;
      if (controller) controller.abort();
      const current = new AbortController();
      controller = current;
      const { signal } = current;
      const timer = setTimeout(() => current.abort(), 10000);
      setStatus('Szukam…');
      clearSuggestions();
      const [tr, def] = await Promise.allSettled([lookupTranslations(w, signal), lookupSenses(w, signal)]);
      clearTimeout(timer);
      if (run !== lookupRun) return;

      const found = tr.status === 'fulfilled' ? tr.value.items : [];
      const dictionary = tr.status === 'fulfilled' && tr.value.dictionary;
      foundTranslations = found;
      foundSenses = def.status === 'fulfilled' ? def.value : [];
      foundInDictionary = dictionary;
      renderSuggestions();
      fillEmptyFields();
      if (dictionary && tr.value.pos && !pos.value) pos.value = tr.value.pos;

      if (dictionary) setStatus('Dotknij propozycji, żeby ją dodać lub usunąć. Tłumaczenia: Wikisłownik, definicje: Wiktionary.');
      else if (found.length) setStatus('Wikisłownik nie zna tego słowa. Te propozycje z MyMemory mogą być błędne, wybierz właściwą albo wpisz własną.');
      else if (tr.status === 'rejected' && tr.reason && tr.reason.message === 'quota') setStatus('Wyczerpany dzienny limit tłumaczeń. Wpisz tłumaczenie ręcznie.', true);
      else if (tr.status === 'rejected') setStatus('Nie udało się pobrać tłumaczenia. Wpisz je ręcznie.', true);
      else setStatus('Brak propozycji dla tego słowa. Wpisz tłumaczenie ręcznie.', true);
    }

    word.addEventListener('input', () => {
      syncCambridge();
      syncSaved();
      setStatus('');
      lookupRun++;
      clearSuggestions();
    });
    word.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        lookup();
      }
    });

    function reset() {
      lookupRun++;
      word.value = translation.value = pos.value = definition.value = example.value = '';
      clearSuggestions();
      setStatus('');
      syncCambridge();
      syncSaved();
      word.focus();
    }

    function prepareNextMeaning() {
      translation.value = pos.value = definition.value = example.value = '';
      renderSuggestions();
      fillEmptyFields();
      syncSaved();
      setStatus('Dodano. Wybierz kolejne znaczenie.');
      translation.focus();
    }

    function save(keepWord) {
      const fields = {
        word: word.value.trim().replace(/\s+/g, ' '),
        translation: parts().join(', '),
        pos: pos.value.trim(),
        definition: definition.value.trim(),
        example: example.value.trim(),
      };
      if (!fields.word || !fields.translation) {
        setStatus('Podaj słowo i tłumaczenie.', true);
        return;
      }
      if (sameWord(fields.word, note && note.id).some((n) => sameTranslation(n.translation, fields.translation))) {
        setStatus('To znaczenie tego słowa już jest na liście.', true);
        return;
      }
      if (note) {
        updateNote(note.id, fields);
        toast('Zapisano: ' + fields.word);
        go('list');
      } else {
        addNote(fields);
        toast('Dodano: ' + fields.word);
        if (keepWord) prepareNextMeaning();
        else reset();
      }
    }

    function submit(e) {
      e.preventDefault();
      save(false);
    }

    let confirmDelete = false;
    const del = note && el('button', {
      class: 'danger', type: 'button',
      onclick: (e) => {
        if (!confirmDelete) {
          confirmDelete = true;
          e.currentTarget.textContent = 'Na pewno usunąć?';
          return;
        }
        deleteNote(note.id);
        toast('Usunięto: ' + note.word);
        go('list');
      },
    }, 'Usuń');

    return [
      el('h1', {}, note ? 'Edycja słówka' : 'Nowe słówko'),
      el('form', { onsubmit: submit, novalidate: true },
        el('label', { class: 'field', for: 'f-word' }, el('span', {}, 'Słowo po angielsku')),
        el('div', { class: 'row', style: 'margin-top:-10px' }, word,
          el('button', { class: 'secondary', type: 'button', onclick: lookup }, 'Znajdź')),
        cambridgeHint,
        savedHint,
        el('div', { style: 'height:14px' }),
        el('label', { class: 'field', for: 'f-tr' }, el('span', {}, 'Tłumaczenie')),
        el('div', { style: 'margin-top:-10px;margin-bottom:14px' }, translation, chips, status),
        sensesBox,
        el('label', { class: 'field' }, el('span', {}, 'Część mowy'), pos),
        el('label', { class: 'field' }, el('span', {}, 'Definicja'), definition),
        el('label', { class: 'field' }, el('span', {}, 'Przykład'), example),
        el('div', { class: 'formbtns' },
          el('button', { class: 'primary', type: 'submit' }, note ? 'Zapisz' : 'Dodaj słówko'),
          another,
          note && el('button', { class: 'secondary', type: 'button', onclick: () => go('list') }, 'Anuluj'),
          del),
      ),
    ];
  }

  /* ---------- Widok: lista ---------- */

  function cardStatus(card, t) {
    if (!card) return '–';
    if (card.state === State.NEW) return 'nowa';
    if (card.state !== State.REVIEW) return 'w nauce';
    const d = today(card.due) - today(t);
    return d <= 0 ? 'dziś' : 'za ' + fmtDays(d);
  }

  function renderList() {
    const t = now();
    const list = el('ul', { class: 'list' });
    const info = el('p', { class: 'hint' });

    const paint = () => {
      const q = norm(search);
      const notes = liveNotes()
        .filter((n) => !q || norm(n.word).includes(q) || norm(n.translation).includes(q))
        .sort((a, b) => b.createdAt - a.createdAt);
      info.textContent = 'Słówek: ' + notes.length;
      list.hidden = !notes.length;
      list.replaceChildren(...notes.map((n) => el('li', {}, el('button', {
        type: 'button',
        onclick: () => { editId = n.id; go('edit'); },
      },
        el('b', {}, n.word), el('span', { class: 'tr' }, ' – ' + n.translation),
        el('small', {}, 'EN→PL: ' + cardStatus(db.cards[n.id + ':en-pl'], t) + ' · PL→EN: ' + cardStatus(db.cards[n.id + ':pl-en'], t)),
      ))));
    };
    paint();

    return [
      el('h1', {}, 'Słówka'),
      el('input', {
        type: 'search', placeholder: 'Szukaj', 'aria-label': 'Szukaj słówka', value: search,
        oninput: (e) => { search = e.target.value; paint(); },
      }),
      info,
      list,
    ];
  }

  /* ---------- Widok: opcje ---------- */

  function changeSetting(patch) {
    db.settings = Object.assign({}, db.settings, patch, { updatedAt: now() });
    resetSession();
    persist();
  }

  function exportDb() {
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(db)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'slowka-' + stamp + '.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function importDb(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.notes !== 'object' || typeof data.cards !== 'object') throw new Error('format');
      const changed = merge(db, data);
      resetSession();
      undoState = null;
      persist();
      toast('Scalono rekordów: ' + changed);
      render();
    } catch (e) {
      toast('To nie jest poprawny plik kopii słówek.');
    }
  }

  function renderSyncBox() {
    syncStatusEl = el('p', { class: 'hint', role: 'status', style: 'margin:0 0 12px' });

    if (sync.config) {
      paintSync();
      return el('section', { class: 'box' },
        el('h2', {}, 'Synchronizacja'),
        el('p', { class: 'hint', style: 'margin:0 0 4px' }, 'Repozytorium: ' + sync.config.owner + '/' + sync.config.repo),
        syncStatusEl,
        el('div', { class: 'backup' },
          el('button', { class: 'secondary', type: 'button', onclick: () => runSync(true) }, 'Synchronizuj teraz'),
          el('button', { class: 'secondary', type: 'button', onclick: () => { disconnectSync(); render(); } }, 'Odłącz to urządzenie')),
      );
    }

    const repo = el('input', { type: 'text', placeholder: 'właściciel/nazwa', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
    const token = el('input', { type: 'password', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
    const submit = el('button', { class: 'primary wide', type: 'submit' }, 'Połącz');
    const failure = el('p', { class: 'hint bad', role: 'alert' });

    return el('section', { class: 'box' },
      el('h2', {}, 'Synchronizacja'),
      el('p', { class: 'hint', style: 'margin:0 0 12px' },
        'Słówka trafią do jednego pliku w prywatnym repozytorium. Utwórz ',
        el('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener noreferrer' }, 'token fine-grained'),
        ' z dostępem tylko do tego repozytorium i uprawnieniem Contents: Read and write. Token zostaje na tym urządzeniu.'),
      el('form', {
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          submit.disabled = true;
          failure.textContent = '';
          try {
            await connectSync(repo.value, token.value);
            render();
          } catch (err) {
            failure.textContent = err.message;
            submit.disabled = false;
          }
        },
      },
        el('label', { class: 'field' }, el('span', {}, 'Repozytorium'), repo),
        el('label', { class: 'field' }, el('span', {}, 'Token'), token),
        submit,
        failure),
    );
  }

  function renderOptions() {
    const s = db.settings;
    const retentionValue = el('b', {}, Math.round(s.retention * 100) + '%');
    const file = el('input', {
      type: 'file', accept: 'application/json,.json', class: 'sr', id: 'import-file', tabindex: '-1', 'aria-hidden': 'true',
      onchange: (e) => { if (e.target.files[0]) importDb(e.target.files[0]); e.target.value = ''; },
    });

    return [
      el('h1', {}, 'Opcje'),
      el('section', { class: 'box' },
        el('label', { class: 'field' }, el('span', {}, 'Nowe karty dziennie'),
          el('input', {
            type: 'number', min: '0', max: '200', inputmode: 'numeric', value: String(s.newPerDay),
            onchange: (e) => {
              const v = clampInt(e.target.value, 0, 200, s.newPerDay);
              e.target.value = v;
              changeSetting({ newPerDay: v });
            },
          }),
          el('p', { class: 'hint' }, 'Każde słowo to dwie karty, po jednej na kierunek.')),
        el('label', { class: 'field' }, el('span', {}, 'Docelowa skuteczność: ', retentionValue),
          el('input', {
            type: 'range', min: '0.8', max: '0.97', step: '0.01', value: String(s.retention),
            oninput: (e) => { retentionValue.textContent = Math.round(e.target.value * 100) + '%'; },
            onchange: (e) => changeSetting({ retention: clampNum(e.target.value, 0.8, 0.97, 0.9) }),
          }),
          el('p', { class: 'hint' }, 'Szansa, że w dniu powtórki pamiętasz słowo. Im wyżej, tym więcej powtórek.')),
        el('label', { class: 'check' },
          el('input', {
            type: 'checkbox', checked: s.separateDirections,
            onchange: (e) => changeSetting({ separateDirections: e.target.checked }),
          }),
          el('span', {}, 'Kierunki i znaczenia tego samego słowa w różne dni')),
      ),
      renderSyncBox(),
      el('section', { class: 'box' },
        el('h2', {}, 'Kopia zapasowa'),
        el('p', { class: 'hint', style: 'margin:0 0 12px' }, 'Import scala plik z bazą: przy każdym rekordzie zostaje nowsza wersja.'),
        el('div', { class: 'backup' },
          el('button', { class: 'secondary', type: 'button', onclick: exportDb }, 'Eksportuj'),
          el('button', { class: 'secondary', type: 'button', onclick: () => file.click() }, 'Importuj'),
          file),
      ),
    ];
  }

  /* ---------- Render i start ---------- */

  const TABS = [['study', 'Nauka'], ['add', 'Dodaj'], ['list', 'Słówka'], ['options', 'Opcje']];

  function go(v) {
    view = v;
    render();
    window.scrollTo(0, 0);
    if (v === 'add') document.getElementById('f-word').focus();
  }

  function render() {
    let content;
    if (view === 'study') content = renderStudy();
    else if (view === 'add') content = renderForm(null);
    else if (view === 'edit' && db.notes[editId] && !db.notes[editId].deleted) content = renderForm(db.notes[editId]);
    else if (view === 'options') content = renderOptions();
    else { view = 'list'; content = renderList(); }

    document.getElementById('app').replaceChildren(...content.filter(Boolean));

    const active = view === 'edit' ? 'list' : view;
    document.querySelector('#tabs div').replaceChildren(...TABS.map(([id, label]) =>
      el('button', { type: 'button', onclick: () => go(id), 'aria-current': id === active ? 'page' : null }, label)));
  }

  document.addEventListener('keydown', (e) => {
    if (view !== 'study' || !session.id || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const activation = e.key === ' ' || e.key === 'Enter';
    if (activation && tag === 'BUTTON') return;
    if (!session.revealed && activation) {
      e.preventDefault();
      reveal();
    } else if (session.revealed && ['1', '2', '3', '4'].includes(e.key)) {
      answer(Number(e.key));
    } else if (session.revealed && activation) {
      e.preventDefault();
      answer(3);
    }
  });

  // Druga karta przeglądarki zmieniła dane: wczytujemy je, zamiast nadpisać nieaktualną kopią.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    db = LocalStore.load();
    undoState = null;
    if (view === 'study' || view === 'list') render();
  });

  // Ekran końcowy ma się sam odświeżyć, gdy karta z kroków nauki znów będzie gotowa.
  setInterval(() => {
    if (view === 'study' && !session.id && nextCard(buildQueue())) render();
  }, 15000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Użytkownik wychodzi z apki: nie czekamy, aż upłynie opóźnienie zapisu.
      if (sync.timer) runSync();
    } else if (now() - sync.lastAt > SYNC_MIN_GAP_MS) {
      runSync();
    }
  });
  window.addEventListener('online', () => runSync());

  render();
  runSync();
})();
