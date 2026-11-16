// theuniverse testbed: reads /feed in two modes and exercises /store, /like, DELETE /content and /register.
// Everything goes through /api, which nginx proxies to the app on this page's origin.

const API = '/api';
const LATEST_TAG_COUNT = 12;

const TABS = {
  user: {
    mode: 'balanced',
    hours: 72,
    blurb:
      "What a reader consumes: mode=balanced splits each day's posts into the most liked, middle and least liked thirds, " +
      "which take turns. The hashtags default to the acting user's interests.",
  },
  latest: {
    mode: 'popular',
    hours: 24,
    blurb:
      "The latest and greatest: mode=popular puts each day's most liked posts first. In the newest slice, each tag's 2nd pick " +
      'and every 4th after it is a fresh post with no likes yet. The hashtags default to the most recently active ones.',
  },
};

const state = {
  tab: 'user',
  users: [],
  /** Identifies the current seed run, from users.json. */
  seededAt: null,
  actor: null,
  /** Hashtags typed per tab; null means the tab's defaults. */
  tags: { user: null, latest: null },
  hours: { user: TABS.user.hours, latest: TABS.latest.hours },
  /** The aiGenerated filter per tab: '' (all), 'true' or 'false'. */
  ai: { user: '', latest: '' },
  recentTags: [],
  pages: [],
  cursor: null,
  query: null,
  highlight: null,
};

const $ = (sel) => document.querySelector(sel);
const store = {
  get: (k, d) => JSON.parse(localStorage.getItem(`tb.${k}`) ?? 'null') ?? d,
  set: (k, v) => localStorage.setItem(`tb.${k}`, JSON.stringify(v)),
};

/** Builds an element; strings become text nodes, so nothing posted is ever parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const normalizeTag = (t) => t.trim().replace(/^#+/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
const parseTags = (s) => [...new Set(s.split(/[\s,]+/).map(normalizeTag).filter(Boolean))];

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url ?? '';
  }
};

function toast(msg, ms = 4000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

function logCall(method, path, status, ms) {
  const time = new Date().toLocaleTimeString(undefined, { hour12: false });
  const short = path.length > 70 ? `${path.slice(0, 70)}…` : path;
  $('#log').prepend(h('li', { class: status >= 400 ? 'bad' : '' }, `${time} ${method} ${short} → ${status} · ${Math.round(ms)} ms`));
  while ($('#log').children.length > 40) $('#log').lastChild.remove();
}

/** Calls the API as the acting user; throws with the server's error message on failure. */
async function api(method, path, body, { auth = true } = {}) {
  const headers = {};
  if (auth && state.actor) {
    headers.authorization = `Bearer ${state.actor.apiKey}`;
    headers['x-user-id'] = state.actor.userId;
  }
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const t0 = performance.now();
  const res = await fetch(API + path, { method, headers, body: payload });
  const text = await res.text();
  logCall(method, path, res.status, performance.now() - t0);
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `${res.status} ${res.statusText}`), { status: res.status, data, text });
  return { data, text, ms: performance.now() - t0, bytes: text.length };
}

// ---- challenges --------------------------------------------------------------------------------

const leadingZeroBits = (bytes) => {
  let bits = 0;
  for (const b of bytes) {
    if (b) return bits + Math.clz32(b) - 24;
    bits += 8;
  }
  return bits;
};

/** Finds a nonce that makes the SHA-256 of prefix + nonce start with `bits` zero bits, a batch of hashes at a time. */
async function proofOfWork({ prefix, bits }, signal, onProgress) {
  const enc = new TextEncoder();
  for (let start = 0; ; start += 1024) {
    if (signal.aborted) throw new Error('cancelled');
    const hashes = await Promise.all(
      Array.from({ length: 1024 }, (_, i) => crypto.subtle.digest('SHA-256', enc.encode(prefix + (start + i)))),
    );
    const hit = hashes.findIndex((h) => leadingZeroBits(new Uint8Array(h)) >= bits);
    if (hit >= 0) return String(start + hit);
    onProgress(start + 1024);
  }
}

/**
 * Shows a challenge until the user types the characters, while the proof of work runs; resolves with
 * the fields to send the request again with, or rejects if the user cancels.
 */
function solveChallenge(challenge, reason) {
  const dialog = $('#challenge');
  const form = $('#challenge-form');
  const status = $('#challenge-status');
  $('#challenge-title').textContent = challenge.steps > 1 ? `Solve challenge ${challenge.step} of ${challenge.steps}` : 'Solve the challenge';
  $('#challenge-reason').textContent = `The server says: ${reason}.`;
  $('#challenge-img').src = challenge.image;
  $('#challenge-answer').value = '';
  const ctrl = new AbortController();
  const started = performance.now();
  let pow = 'working on the proof of work…';
  let nonce;
  const work = proofOfWork(challenge.proofOfWork, ctrl.signal, (n) => (pow = `proof of work: ${n.toLocaleString()} hashes tried…`)).then((n) => {
    nonce = n;
    pow = `proof of work done in ${((performance.now() - started) / 1000).toFixed(1)} s`;
    return n;
  });
  const deadline = Date.now() + challenge.expiresInSeconds * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    status.textContent = `${left ? `${left} s left` : 'expired: send to get a new one'} · ${pow}`;
  };
  tick();
  const timer = setInterval(tick, 250);
  dialog.showModal();

  return new Promise((resolve, reject) => {
    const done = () => {
      clearInterval(timer);
      form.onsubmit = null;
      $('#challenge-cancel').onclick = null;
      dialog.oncancel = null;
      if (dialog.open) dialog.close();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const answer = $('#challenge-answer').value;
      if (nonce === undefined) status.textContent = 'finishing the proof of work…';
      try {
        const challengeNonce = await work;
        done();
        resolve({ challengeId: challenge.id, challengeAnswer: answer, challengeNonce });
      } catch (err) {
        done();
        reject(err);
      }
    };
    const cancel = (e) => {
      e?.preventDefault();
      ctrl.abort();
      done();
      reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    };
    $('#challenge-cancel').onclick = cancel;
    dialog.oncancel = cancel;
  });
}

/**
 * Makes a request with `send(solution)`. While the server answers 428 with a challenge, shows it and
 * sends the request again with the solution; a wrong answer comes back with a new challenge.
 */
async function withChallenges(send) {
  let solution = {};
  for (;;) {
    try {
      return await send(solution);
    } catch (err) {
      if (err.status !== 428 || !err.data?.challenge) throw err;
      solution = await solveChallenge(err.data.challenge, err.message);
    }
  }
}

// ---- users -------------------------------------------------------------------------------------

async function loadUsers() {
  let seeded = [];
  try {
    const res = await fetch('/seed/users.json', { cache: 'no-store' });
    if (res.ok) ({ users: seeded, seededAt: state.seededAt } = await res.json());
  } catch {}
  // Users registered against an earlier seed (before a `down -v`) no longer exist in the database.
  const registered = store.get('registered', []).filter((u) => u.seededAt === state.seededAt);
  store.set('registered', registered);
  state.users = [...registered.map((u) => ({ ...u, role: 'registered' })), ...seeded];
}

function renderActorSelect() {
  const groups = [
    ['registered', 'Registered here'],
    ['reader', 'Readers'],
    ['publisher', 'Publishers'],
  ];
  const sel = $('#actor');
  sel.replaceChildren(
    ...groups
      .map(([role, label]) => {
        const users = state.users.filter((u) => u.role === role);
        return users.length ? h('optgroup', { label }, users.map((u) => h('option', { value: u.userId }, u.username))) : null;
      })
      .filter(Boolean),
  );
  if (state.actor) sel.value = state.actor.userId;
}

function setActor(userId, { reload = true } = {}) {
  state.actor = state.users.find((u) => u.userId === userId) ?? state.users.find((u) => u.role === 'reader') ?? state.users[0] ?? null;
  if (!state.actor) {
    $('#actor-info').textContent = 'No users yet: register one below.';
    return;
  }
  store.set('actor', state.actor.userId);
  $('#actor').value = state.actor.userId;
  const a = state.actor;
  $('#actor-info').replaceChildren(
    h('div', {}, `${a.role} · `, h('a', { href: `${API}/users/${a.userId}`, target: '_blank' }, a.userId)),
    h('div', {}, 'publisher URL: ', a.publisherUrl ?? '(none: needed to post)'),
    h('div', { class: 'chips' }, (a.interests ?? []).length ? a.interests.map((t) => h('span', { class: 'chip' }, `#${t}`)) : 'no interests'),
  );
  if (isSample($('#content').value)) fillSample();
  if (reload && state.tab === 'user' && state.tags.user === null) loadFeed();
}

// ---- feed --------------------------------------------------------------------------------------

function defaultTags(tab) {
  if (tab === 'user' && state.actor?.interests?.length) return state.actor.interests;
  return state.recentTags.slice(0, tab === 'user' ? 5 : LATEST_TAG_COUNT);
}

const currentTags = () => state.tags[state.tab] ?? defaultTags(state.tab);

function feedUrl(tags, hours, mode, ai, cursor) {
  const params = new URLSearchParams({ tags: tags.join(','), hours: String(hours), mode });
  if (ai) params.set('aiGenerated', ai);
  if (cursor) params.set('cursor', cursor);
  return `${API}/feed?${params}`.replace(/%2C/g, ',');
}

function syncControls() {
  document.querySelectorAll('.tabs [data-tab]').forEach((a) => a.setAttribute('aria-selected', String(a.dataset.tab === state.tab)));
  $('#blurb').textContent = TABS[state.tab].blurb;
  $('#tags').value = currentTags().join(', ');
  $('#hours').value = String(state.hours[state.tab]);
  $('#ai').value = state.ai[state.tab];
  const active = new Set(currentTags());
  $('#suggest').replaceChildren(
    ...state.recentTags.slice(0, 24).map((t) =>
      h('button', { type: 'button', class: `chip${active.has(t) ? ' on' : ''}`, onclick: () => toggleTag(t) }, `#${t}`),
    ),
  );
}

function toggleTag(tag) {
  const tags = currentTags();
  state.tags[state.tab] = tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag].slice(0, 20);
  loadFeed();
}

async function loadFeed({ more = false } = {}) {
  syncControls();
  const tags = currentTags();
  const { mode } = TABS[state.tab];
  const hours = state.hours[state.tab];
  const ai = state.ai[state.tab];
  if (!tags.length) {
    $('#feed').replaceChildren(h('p', { class: 'empty' }, 'Pick at least one hashtag.'));
    return;
  }
  const url = feedUrl(tags, hours, mode, ai, more ? state.cursor : null);
  const firstPage = feedUrl(tags, hours, mode, ai);
  $('#api-url').href = url;
  $('#api-url').textContent = location.origin + (more ? url : firstPage);
  const key = `${state.tab}|${firstPage}`;
  $('#more').hidden = true;
  if (!more) {
    state.query = key;
    $('#feed').replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
  }
  let res;
  try {
    res = await api('GET', url.slice(API.length), undefined, { auth: false });
  } catch (err) {
    if (state.query !== key) return;
    const msg = err.status === 410 ? 'The cursor expired: load the feed again.' : `Feed failed: ${err.message}`;
    if (!more) $('#feed').replaceChildren();
    $('#feed').append(h('p', { class: 'error' }, msg));
    return;
  }
  if (state.query !== key) return;
  if (!more) {
    state.pages = [];
    $('#feed').replaceChildren();
  }
  state.pages.push({ ...res, tags });
  state.cursor = res.data.nextCursor;
  renderStats();
  renderPage(res.data, tags, state.pages.length);
  $('#raw pre').textContent = JSON.stringify(res.data, null, 2);
  $('#more').hidden = !state.cursor;
  revealHighlight();
}

function renderStats() {
  const records = state.pages.reduce((n, p) => n + countRecords(p.data), 0);
  const tokens = state.pages.reduce((n, p) => n + p.data.estimatedTokens, 0);
  const last = state.pages.at(-1);
  $('#stats').replaceChildren(
    h('span', {}, `${records} records`),
    h('span', {}, `~${tokens.toLocaleString()} tokens`),
    h('span', {}, `${state.pages.length} page${state.pages.length > 1 ? 's' : ''}`),
    h('span', {}, `truncated: ${last.data.truncated ? 'yes' : 'no'}`),
    h('span', {}, `last page ${Math.round(last.ms)} ms, ${(last.bytes / 1024).toFixed(0)} KB`),
  );
}

const countRecords = (data) => data.days.reduce((n, d) => n + Object.values(d.tags).reduce((m, l) => m + l.length, 0), 0);

function renderPage(data, tags, page) {
  const frag = document.createDocumentFragment();
  if (page > 1) frag.append(h('div', { class: 'page-break' }, `page ${page}`));
  if (!countRecords(data)) {
    const which = { true: ' created with AI', false: ' not created with AI' }[state.ai[state.tab]] ?? '';
    frag.append(h('p', { class: 'empty' }, `No posts${which} for these hashtags in this window.`));
  }
  data.days.forEach((day, i) => {
    const lists = tags.map((t) => day.tags[t] ?? []);
    const n = lists.reduce((s, l) => s + l.length, 0);
    if (!n) return;
    // The planner gives tags equal turns within a slice; interleaving shows that order.
    const picks = [];
    for (let k = 0; k < Math.max(...lists.map((l) => l.length)); k++) {
      lists.forEach((l, j) => l[k] && picks.push({ rec: l[k], via: tags[j] }));
    }
    frag.append(
      h(
        'section',
        { class: `slice${day.extended ? ' extended' : ''}` },
        h(
          'header',
          {},
          h('strong', {}, `Slice ${i + 1}${day.extended ? ' (extended)' : ''}`),
          h('span', {}, `${when(day.from)} → ${when(day.to)}`),
          h('span', {}, `${day.usedTokens.toLocaleString()} / ${day.allocatedTokens.toLocaleString()} tokens`),
          h('span', { class: 'chips' }, tags.map((t, j) => (lists[j].length ? h('span', { class: 'chip' }, `#${t} ${lists[j].length}`) : null))),
        ),
        picks.map(({ rec, via }) => card(rec, via)),
      ),
    );
  });
  $('#feed').append(frag);
}

function preview(rec) {
  const p = rec.preview;
  if (p.kind === 'text') return h('p', { class: 'preview' }, p.text);
  if (rec.mimeType.startsWith('image/')) return h('a', { href: p.url, target: '_blank' }, h('img', { class: 'media', src: p.url, loading: 'lazy', alt: '' }));
  if (rec.mimeType.startsWith('video/')) return h('video', { class: 'media', src: p.url, controls: true, preload: 'none' });
  if (rec.mimeType.startsWith('audio/')) return h('audio', { src: p.url, controls: true, preload: 'none' });
  return h('a', { href: p.url, target: '_blank' }, `Open ${rec.mimeType} file`);
}

function card(rec, via) {
  const mine = state.actor && rec.publisher.userId === state.actor.userId;
  const likes = h('span', { class: 'likes' }, `♥ ${rec.likes}`);
  return h(
    'article',
    { class: `card${mine ? ' mine' : ''}`, 'data-id': rec.contentId },
    h(
      'div',
      { class: 'meta' },
      h('strong', {}, rec.publisher.username || '(unknown)'),
      rec.publisher.publisherUrl ? h('a', { href: rec.publisher.publisherUrl, target: '_blank', class: 'muted' }, hostOf(rec.publisher.publisherUrl)) : null,
      h('span', { class: 'muted', title: rec.createdAt }, ago(rec.createdAt)),
      rec.version > 1 ? h('span', { class: 'badge', title: `updated ${rec.updatedAt}` }, `v${rec.version}`) : null,
      rec.aiGenerated ? h('span', { class: 'badge ai', title: 'The publisher says this was created with AI.' }, 'created with AI') : null,
      rec.likes === 0 ? h('span', { class: 'badge fresh' }, 'no likes yet') : null,
      h('span', { class: 'via' }, `via #${via}`),
    ),
    preview(rec),
    h('div', { class: 'chips' }, rec.tags.map((t) => h('button', { type: 'button', class: 'chip', onclick: () => toggleTag(t) }, `#${t}`))),
    h(
      'div',
      { class: 'actions' },
      likes,
      h('button', { type: 'button', onclick: (e) => like(rec, e.currentTarget, likes) }, 'Like'),
      h('a', { href: `${API}/content/${rec.contentId}`, target: '_blank' }, 'JSON'),
      h('a', { href: `${API}/content/${rec.contentId}/raw`, target: '_blank' }, 'raw'),
      mine ? h('button', { type: 'button', onclick: () => edit(rec) }, 'Edit') : null,
      mine ? h('button', { type: 'button', class: 'danger', onclick: () => remove(rec) }, 'Delete') : null,
      h('code', { class: 'muted', title: rec.contentId }, rec.contentId.slice(0, 8)),
    ),
  );
}

function revealHighlight() {
  if (!state.highlight) return;
  const el = document.querySelector(`.card[data-id="${state.highlight.contentId}"]`);
  if (el) {
    el.classList.add('flash');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    state.highlight = null;
  } else if (!state.cursor) {
    const tags = state.highlight.tags;
    toast(`Your post isn't on this feed. Its hashtags: ${tags.map((t) => `#${t}`).join(' ')}`, 6000);
    state.highlight = null;
  }
}

// ---- actions -----------------------------------------------------------------------------------

async function like(rec, btn, likesEl) {
  if (!state.actor) return toast('Pick a user to act as first.');
  btn.disabled = true;
  try {
    const { data } = await api('POST', '/like', { contentId: rec.contentId });
    likesEl.textContent = `♥ ${rec.likes} → ${data.likes} in the database`;
    likesEl.title = 'Feeds show the new count after the next compactor run.';
    toast(data.alreadyLiked ? 'Already liked: likes are once per user.' : 'Liked. Feeds show the new count after the next compactor run.');
  } catch (err) {
    toast(`Like failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function remove(rec) {
  if (!confirm(`Delete this post (${rec.contentId})?`)) return;
  try {
    const { data } = await api('DELETE', `/content/${rec.contentId}`);
    toast(`${data.status}: hidden from feeds now, removed by the next compactor run.`);
    loadFeed();
  } catch (err) {
    toast(`Delete failed: ${err.message}`);
  }
}

async function edit(rec) {
  $('#content-id').value = rec.contentId;
  $('#post-tags').value = rec.tags.join(', ');
  $('#ai-generated').checked = rec.aiGenerated;
  const textual = rec.preview.kind === 'text';
  setKind(textual ? 'text' : 'file');
  if (textual) {
    try {
      const res = await fetch(`${API}/content/${rec.contentId}/raw`);
      $('#content').value = await res.text();
      const type = [...$('#content-type').options].find((o) => o.value === rec.mimeType);
      if (type) $('#content-type').value = rec.mimeType;
    } catch {
      $('#content').value = rec.preview.text;
    }
  } else {
    toast(`Choose a new ${rec.mimeType} file: a new version must keep the content type.`);
  }
  $('#post-panel').scrollIntoView({ behavior: 'smooth' });
}

const kind = () => document.querySelector('input[name="kind"]:checked').value;
function setKind(k) {
  document.querySelector(`input[name="kind"][value="${k}"]`).checked = true;
  $('#text-fields').hidden = k !== 'text';
  $('#file-fields').hidden = k !== 'file';
}

const SAMPLE_MARK = 'Testbed post from';
const isSample = (s) => !s.trim() || s.startsWith(SAMPLE_MARK);
let sampleTags = '';
/** A sample post, tagged with the actor's interests unless other hashtags were typed in. */
function fillSample() {
  const a = state.actor;
  const tags = (a?.interests?.length ? a.interests : defaultTags('latest')).slice(0, 2).join(', ');
  $('#content').value =
    `${SAMPLE_MARK} ${a?.username ?? 'someone'} at ${new Date().toLocaleTimeString()}.\n\n` +
    'Its hashtags are below, so it shows up in those feeds straight away. ' +
    'Edit the text, change the hashtags, or switch to a file upload to try images, PDFs or video.';
  if (!$('#post-tags').value.trim() || $('#post-tags').value === sampleTags) $('#post-tags').value = tags;
  sampleTags = tags;
}

async function post(e) {
  e.preventDefault();
  if (!state.actor) return toast('Pick or register a user first.');
  const contentId = $('#content-id').value.trim() || undefined;
  const tags = $('#post-tags').value.trim() || undefined;
  const aiGenerated = $('#ai-generated').checked;
  const text = $('#content').value;
  const contentType = $('#content-type').value;
  const file = $('#file').files[0];
  if (kind() === 'text' && !text.trim()) return toast('Write something first.');
  if (kind() === 'file' && !file) return toast('Choose a file first.');
  /** The request body, with a challenge's solution when the server asked for one. */
  const body = (solution) => {
    if (kind() === 'text') return { content: text, contentType, tags, contentId, aiGenerated, ...solution };
    const form = new FormData();
    if (tags) form.append('tags', tags);
    if (contentId) form.append('contentId', contentId);
    form.append('aiGenerated', String(aiGenerated));
    for (const [k, v] of Object.entries(solution)) form.append(k, v);
    form.append('content', file, file.name);
    return form;
  };
  const btn = $('#post-btn');
  btn.disabled = true;
  btn.textContent = 'Posting…';
  const out = $('#post-result');
  try {
    const { data, ms } = await withChallenges((solution) => api('POST', '/store', body(solution)));
    out.className = 'result';
    out.textContent = `${Math.round(ms)} ms\n${JSON.stringify(data, null, 2)}`;
    if (data.unchanged) toast('Unchanged: same bytes as the current version (and the same hashtags, where the server uses yours).');
    else {
      state.highlight = { contentId: data.contentId, tags: data.tags };
      $('#content-id').value = '';
      if (isSample($('#content').value)) fillSample();
      loadFeed();
    }
  } catch (err) {
    out.className = 'result bad';
    out.textContent = err.cancelled
      ? 'Cancelled the challenge: nothing was posted.'
      : `${err.status ?? ''} ${err.message}\n${err.data && typeof err.data === 'object' ? JSON.stringify(err.data, null, 2) : ''}`;
  } finally {
    out.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Post';
  }
}

async function register(e) {
  e.preventDefault();
  const fields = { username: $('#reg-username').value.trim(), publisherUrl: $('#reg-url').value.trim() };
  try {
    const { data } = await withChallenges((solution) => api('POST', '/register', { ...fields, ...solution }, { auth: false }));
    const user = {
      userId: data.userId,
      apiKey: data.apiKey,
      username: data.username,
      publisherUrl: data.publisherUrl,
      interests: parseTags($('#reg-interests').value),
      seededAt: state.seededAt,
    };
    store.set('registered', [user, ...store.get('registered', [])]);
    await loadUsers();
    renderActorSelect();
    setActor(user.userId);
    e.target.reset();
    toast(`Registered ${user.username}; its API key is kept in this browser.`);
  } catch (err) {
    toast(err.cancelled ? 'Cancelled the challenge: nobody was registered.' : `Register failed: ${err.message}`);
  }
}

// ---- routing -----------------------------------------------------------------------------------

/** #user or #latest, optionally with ?tags=a,b&hours=48&ai=true|false&as=<username or userId>. */
function readHash() {
  const [tab, query = ''] = location.hash.slice(1).split('?');
  state.tab = tab in TABS ? tab : 'user';
  const params = new URLSearchParams(query);
  if (params.get('tags')) state.tags[state.tab] = parseTags(params.get('tags'));
  const hours = Number(params.get('hours'));
  if (hours >= 1 && hours <= 168) state.hours[state.tab] = hours;
  const ai = params.get('ai');
  if (ai === 'true' || ai === 'false') state.ai[state.tab] = ai;
  const as = params.get('as');
  return as ? state.users.find((u) => u.userId === as || u.username === as)?.userId : undefined;
}

async function init() {
  $('#s3-console').href = `${location.protocol}//${location.hostname}:19001`;
  api('GET', '/health', undefined, { auth: false })
    .then(() => ($('#status').textContent = 'API up'))
    .catch(() => ($('#status').textContent = 'API down'));

  await loadUsers();
  try {
    const { data } = await api('GET', '/tags?limit=200', undefined, { auth: false });
    state.recentTags = data.tags.map((t) => t.tag);
    $('#tag-list').replaceChildren(...state.recentTags.map((t) => h('option', { value: t })));
  } catch {}

  renderActorSelect();
  const fromHash = readHash();
  setActor(fromHash ?? store.get('actor'), { reload: false });
  if (!$('#content').value) fillSample();

  $('#actor').addEventListener('change', (e) => setActor(e.target.value));
  $('#feed-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const tags = parseTags($('#tags').value);
    state.tags[state.tab] = tags.join() === defaultTags(state.tab).join() ? null : tags;
    state.hours[state.tab] = Number($('#hours').value);
    state.ai[state.tab] = $('#ai').value;
    loadFeed();
  });
  $('#hours').addEventListener('change', () => $('#feed-form').requestSubmit());
  $('#ai').addEventListener('change', () => $('#feed-form').requestSubmit());
  $('#reset-tags').addEventListener('click', () => {
    state.tags[state.tab] = null;
    state.hours[state.tab] = TABS[state.tab].hours;
    state.ai[state.tab] = '';
    loadFeed();
  });
  $('#more').addEventListener('click', () => loadFeed({ more: true }));
  $('#post-form').addEventListener('submit', post);
  $('#sample').addEventListener('click', fillSample);
  document.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', () => setKind(kind())));
  $('#register-form').addEventListener('submit', register);
  window.addEventListener('hashchange', () => {
    const as = readHash();
    if (as) setActor(as, { reload: false });
    loadFeed();
  });

  loadFeed();
}

init();
