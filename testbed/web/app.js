// Evieverse testbed: reads /feed with either algorithm and exercises /store, /like (and DELETE /like), /repost, DELETE /content and /register.
// Everything goes through /api, which nginx proxies to the app on this page's origin.

import { parseFormatted } from './format.js';

const API = '/api';
const LATEST_TAG_COUNT = 12;

/** The windows a feed can be asked for, in hours, as index.html offers them. */
const HOURS = [1, 2, 4, 8, 12, 24, 48, 72, 168, 336, 504, 720, 1440, 2160];

const ALGORITHMS = {
  popular:
    "algorithm=popular puts the window's most liked posts first, giving each hashtag a share of the page. " +
    "Each tag's 2nd pick and every 4th after it is a fresh post with no likes yet.",
  chronological: "algorithm=chronological puts the window's newest posts first, whatever their likes or their hashtag.",
};

const TABS = {
  user: {
    algorithm: 'popular',
    hours: 72,
    blurb: "What a reader consumes. The hashtags default to the acting user's interests.",
  },
  latest: {
    algorithm: 'chronological',
    hours: 24,
    blurb: 'The latest posts. The hashtags default to the most recently active ones.',
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
  algorithm: { user: TABS.user.algorithm, latest: TABS.latest.algorithm },
  /** Whether the feed adds the hashtags related to the ones asked for (addRelated), per tab. */
  related: { user: false, latest: false },
  /** The aiGenerated filter per tab: '' (all), 'true' or 'false'. */
  ai: { user: '', latest: '' },
  recentTags: [],
  /** The hashtags a post can have (GET /tagging): the server's in server tagging mode, null where any will do. */
  allowedTags: null,
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

const MARK_TAGS = { bold: 'strong', italic: 'em', strike: 's' };

/**
 * What is within a block of a formatted text, as nodes. A link's address is http or https: the parser makes a link of
 * nothing else. A mention links to the profile of the user it names, by their id: the name is what the text has.
 */
const inlineNodes = (nodes) =>
  nodes.map((n) => {
    if (n.type === 'text') return n.text;
    if (n.type === 'code') return h('code', {}, n.text);
    if (n.type === 'break') return h('br');
    if (n.type === 'mention') return h('a', { class: 'mention', href: `${API}/users/${encodeURIComponent(n.userId)}`, target: '_blank' }, `@${n.username}`);
    if (n.type === 'link') return h('a', { href: n.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, inlineNodes(n.children));
    return h(MARK_TAGS[n.type], {}, inlineNodes(n.children));
  });

/**
 * A post's text or caption as elements, with its formatting (format.js): bold, italic, struck through, code, links,
 * quotes and lists, and the users it mentions, which the server gives beside the text as `mentions`: without them an
 * `@name` is the text it is. The elements are this page's own, built from what the parser read, so a tag someone
 * posted is still the text it was written with.
 */
const formatted = (text, mentions = []) =>
  parseFormatted(text, mentions).map((b) => {
    if (b.type === 'list') return h(b.ordered ? 'ol' : 'ul', b.ordered ? { start: b.start } : {}, b.items.map((item) => h('li', {}, inlineNodes(item))));
    return h(b.type === 'quote' ? 'blockquote' : 'p', {}, inlineNodes(b.children));
  });

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
  $('#challenge-reason').textContent = `The server says: ${reason}.`;
  $('#challenge-img').src = challenge.image;
  // The same characters, read out: fetched only if it's played.
  const audio = $('#challenge-audio');
  audio.src = challenge.audio;
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
      audio.pause();
      audio.removeAttribute('src');
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
 * Makes a request with `send(solution)`, which is how a user is registered. While the server answers
 * 428 with a challenge, shows it and sends the request again with the solution; a wrong answer comes
 * back with a new challenge.
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

function feedUrl(tags, hours, algorithm, related, ai, cursor) {
  const params = new URLSearchParams({ tags: tags.join(','), hours: String(hours), algorithm });
  if (related) params.set('addRelated', 'true');
  if (ai) params.set('aiGenerated', ai);
  if (cursor) params.set('cursor', cursor);
  return `${API}/feed?${params}`.replace(/%2C/g, ',');
}

function syncControls() {
  document.querySelectorAll('.tabs [data-tab]').forEach((a) => a.setAttribute('aria-selected', String(a.dataset.tab === state.tab)));
  $('#blurb').textContent = `${TABS[state.tab].blurb} ${ALGORITHMS[state.algorithm[state.tab]]}`;
  $('#tags').value = currentTags().join(', ');
  $('#hours').value = String(state.hours[state.tab]);
  $('#algorithm').value = state.algorithm[state.tab];
  $('#related').checked = state.related[state.tab];
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
  const algorithm = state.algorithm[state.tab];
  const related = state.related[state.tab];
  const hours = state.hours[state.tab];
  const ai = state.ai[state.tab];
  if (!tags.length) {
    $('#feed').replaceChildren(h('p', { class: 'empty' }, 'Pick at least one hashtag.'));
    return;
  }
  const url = feedUrl(tags, hours, algorithm, related, ai, more ? state.cursor : null);
  const firstPage = feedUrl(tags, hours, algorithm, related, ai);
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
  renderPage(res.data, tags, state.pages.length, algorithm);
  $('#raw pre').textContent = JSON.stringify(res.data, null, 2);
  $('#more').hidden = !state.cursor;
  revealHighlight();
}

function renderStats() {
  const records = state.pages.reduce((n, p) => n + p.data.count, 0);
  const last = state.pages.at(-1);
  $('#stats').replaceChildren(
    h('span', {}, `${records} records`),
    h('span', {}, `${state.pages.length} page${state.pages.length > 1 ? 's' : ''}`),
    h('span', {}, `truncated: ${last.data.truncated ? 'yes' : 'no'}`),
    last.data.related ? h('span', {}, `related: ${last.data.related.map((t) => `#${t}`).join(' ') || 'none yet'}`) : null,
    h('span', {}, `last page ${Math.round(last.ms)} ms, ${(last.bytes / 1024).toFixed(0)} KB`),
  );
}

function renderPage(data, asked, page, algorithm) {
  const frag = document.createDocumentFragment();
  if (page > 1) frag.append(h('div', { class: 'page-break' }, `page ${page}`));
  if (!data.count) {
    const which = { true: ' created with AI', false: ' not created with AI' }[state.ai[state.tab]] ?? '';
    frag.append(h('p', { class: 'empty' }, `No posts${which} for these hashtags in this window.`));
  }
  // With addRelated, the feed is also of the hashtags related to the ones asked for.
  const related = new Set(data.related ?? []);
  const tags = [...asked, ...related];
  const label = (t) => `#${t}${related.has(t) ? ' (related)' : ''}`;
  const lists = tags.map((t) => data.tags[t] ?? []);
  let picks = [];
  if (algorithm === 'chronological') {
    // Each tag's list is newest first; merged by the time each post was placed there, they are the feed's order.
    picks = lists.flatMap((l, j) => l.map((rec) => ({ rec, via: tags[j] }))).sort((a, b) => Date.parse(placedAt(b.rec)) - Date.parse(placedAt(a.rec)));
  } else {
    // Each tag's list is its most liked first, and the planner gives tags equal turns; interleaving shows that order.
    for (let k = 0; k < Math.max(...lists.map((l) => l.length)); k++) {
      lists.forEach((l, j) => l[k] && picks.push({ rec: l[k], via: tags[j] }));
    }
  }
  if (picks.length) {
    frag.append(
      h(
        'section',
        { class: 'page' },
        h(
          'header',
          {},
          h('strong', {}, `${data.count} post${data.count === 1 ? '' : 's'}`),
          h('span', {}, `window ${when(data.window.from)} → ${when(data.window.to)}`),
          h('span', { class: 'chips' }, tags.map((t, j) => (lists[j].length ? h('span', { class: 'chip' }, `${label(t)} ${lists[j].length}`) : null))),
        ),
        picks.map(({ rec, via }) => card(rec, label(via))),
      ),
    );
  }
  $('#feed').append(frag);
}

function preview(rec) {
  const p = rec.preview;
  const caption = p.text ? h('div', { class: 'preview' }, formatted(p.text, rec.mentions)) : null;
  switch (p.kind) {
    case 'text':
      return caption;
    case 'image': {
      // An album says how many images it has. The first is at the preview's URL, and each of the others at its place after it: <url>/2, <url>/3 ...
      const urls = Array.from({ length: p.imageCount ?? 1 }, (_, i) => (i === 0 ? p.url : `${p.url}/${i + 1}`));
      // What describes each image, where its publisher said: `alt` has one for each, '' for one that has none, which is then shown as an image nobody described.
      const image = (src, i) =>
        h('a', { href: src, target: '_blank', title: urls.length > 1 && `${i + 1} of ${urls.length}` }, h('img', { class: 'media', src, loading: 'lazy', alt: p.alt?.[i] ?? '' }));
      if (urls.length === 1) return [image(urls[0], 0), caption];
      return [h('div', { class: 'album' }, urls.map(image)), h('div', { class: 'album-count muted' }, `${urls.length} images: scroll sideways`), caption];
    }
    case 'video': {
      // A video stored as it was sent (a server that processes none) is its one file.
      if (!p.video) return [h('video', { class: 'media', src: p.url, controls: true, preload: 'none' }), caption];
      // One the server processed has a poster to show before it plays, and two sources. The adaptive stream first, which
      // Safari plays by itself (any other browser needs a script such as hls.js for it), and then the MP4, which every browser plays.
      const { poster, hls } = p.video;
      return [
        h(
          'video',
          { class: 'media', controls: true, preload: 'none', poster, playsinline: true },
          h('source', { src: hls, type: 'application/vnd.apple.mpegurl' }),
          h('source', { src: p.url, type: 'video/mp4' }),
        ),
        caption,
      ];
    }
    case 'audio':
      return [h('audio', { class: 'media', src: p.url, controls: true, preload: 'none' }), caption];
    default:
      return h('a', { class: 'link-post', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, h('strong', {}, hostOf(p.url)), h('span', { class: 'muted' }, p.url));
  }
}

/** When a record was placed where the feed read it, which is where the feed orders it: when it was reposted there, or else posted. */
const placedAt = (rec) => rec.repost?.at ?? rec.createdAt;

/** The original of a repost of a post on another server: where it is, and who published it there. */
const originLine = (origin) =>
  h(
    'div',
    { class: 'origin' },
    'A link to a post on another server: ',
    h('a', { href: origin.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, hostOf(origin.url)),
    `, by ${origin.publisher.username}`,
  );

function card(rec, via) {
  const mine = state.actor && rec.publisher.userId === state.actor.userId;
  const likes = h('span', { class: 'likes' }, `♥ ${rec.likes}`);
  // A repost put the post under this hashtag as a new post: at the repost's time, with the likes since.
  const reposted = rec.repost
    ? h(
        'span',
        { class: 'badge repost', title: `Reposted here ${rec.repost.at}. Its likes are counted from then; GET /content has them all.` },
        `reposted ${ago(rec.repost.at)}${rec.repost.by ? ` by ${rec.repost.by.username}` : ''}`,
      )
    : null;
  return h(
    'article',
    { class: `card${mine ? ' mine' : ''}`, 'data-id': rec.contentId },
    h(
      'div',
      { class: 'meta' },
      h('strong', {}, rec.publisher.username || '(unknown)'),
      h('span', { class: 'muted', title: rec.createdAt }, ago(rec.createdAt)),
      reposted,
      rec.updatedAt !== rec.createdAt && !rec.repost ? h('span', { class: 'badge', title: `updated ${rec.updatedAt}` }, 'edited') : null,
      rec.aiGenerated ? h('span', { class: 'badge ai', title: 'The publisher says this was created with AI.' }, 'created with AI') : null,
      rec.likes === 0 ? h('span', { class: 'badge fresh' }, rec.repost ? 'no likes since' : 'no likes yet') : null,
      h('span', { class: 'via' }, `via ${via}`),
    ),
    rec.origin ? originLine(rec.origin) : null,
    preview(rec),
    h('div', { class: 'chips' }, rec.tags.map((t) => h('button', { type: 'button', class: 'chip', onclick: () => toggleTag(t) }, `#${t}`))),
    h(
      'div',
      { class: 'actions' },
      likes,
      h('button', { type: 'button', onclick: (e) => like(rec, e.currentTarget, likes) }, 'Like'),
      // A feed doesn't say whose likes a post has, so both are offered: taking back a like that isn't there changes nothing.
      h('button', { type: 'button', title: 'Take your like back', onclick: (e) => like(rec, e.currentTarget, likes, false) }, 'Unlike'),
      // A post is its publisher's to give other hashtags with an update; anyone else reposts it.
      mine ? null : h('button', { type: 'button', onclick: (e) => repost(rec, e.currentTarget) }, 'Repost'),
      h('a', { href: `${API}/content/${rec.contentId}`, target: '_blank' }, 'JSON'),
      h('a', { href: `${API}/content/${rec.contentId}/raw`, target: '_blank' }, 'raw'),
      // A repost of a post on another server is a link to it, with nothing here to edit.
      mine && !rec.origin ? h('button', { type: 'button', onclick: () => edit(rec) }, 'Edit') : null,
      mine ? h('button', { type: 'button', class: 'danger', onclick: () => remove(rec) }, 'Delete') : null,
      h('code', { class: 'muted', title: rec.contentId }, rec.contentId.slice(0, 8)),
    ),
  );
}

/**
 * Feeds have a new post, and lose a deleted one, after the compactor's next run (COMPACT_INTERVAL_SECONDS,
 * 5 unless the testbed was started with another). So the feed is read again every RETRY_MS until the post
 * just stored is on it, up to HIGHLIGHT_TRIES times.
 */
const RETRY_MS = 2000;
const HIGHLIGHT_TRIES = 8;
let reloadTimer;
/** Reads the feed again in a moment, unless the reader has paged on or changed feeds by then. */
function reloadSoon(ms = RETRY_MS) {
  const query = state.query;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => state.query === query && state.pages.length <= 1 && loadFeed(), ms);
}

function revealHighlight() {
  const wanted = state.highlight;
  if (!wanted) return;
  const el = document.querySelector(`.card[data-id="${wanted.contentId}"]`);
  if (el) {
    el.classList.add('flash');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    state.highlight = null;
  } else if (wanted.tries < HIGHLIGHT_TRIES && state.pages.length <= 1) {
    wanted.tries++;
    reloadSoon();
  } else if (!state.cursor) {
    toast(`Your post isn't on this feed. Its hashtags: ${wanted.tags.map((t) => `#${t}`).join(' ')}`, 6000);
    state.highlight = null;
  }
}

// ---- actions -----------------------------------------------------------------------------------

/** Likes a post (POST /like), or with `liked` false, takes the like back (DELETE /like, which names the post in its query). */
async function like(rec, btn, likesEl, liked = true) {
  if (!state.actor) return toast('Pick a user to act as first.');
  btn.disabled = true;
  try {
    const { data } = liked
      ? await api('POST', '/like', { contentId: rec.contentId })
      : await api('DELETE', `/like?contentId=${encodeURIComponent(rec.contentId)}`);
    const after = 'Feeds show the new count after the next compactor run.';
    likesEl.textContent = `♥ ${rec.likes} → ${data.likes} in the database`;
    likesEl.title = after;
    if (liked) toast(data.alreadyLiked ? 'Already liked: a like is once per user, until it is taken back.' : `Liked. ${after}`);
    else toast(data.wasLiked ? `Like taken back. ${after}` : "You hadn't liked this: nothing to take back.");
  } catch (err) {
    toast(`${liked ? 'Like' : 'Unlike'} failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

/** Reposts a post under hashtags it doesn't have: POST /repost, which is a post as far as the limit on posts a minute goes. */
async function repost(rec, btn) {
  if (!state.actor) return toast('Pick a user to act as first.');
  const asked = prompt(`Repost under which hashtags? The post has ${rec.tags.map((t) => `#${t}`).join(' ') || 'none'}; a repost gives it others.`);
  const tags = parseTags(asked ?? '');
  if (!tags.length) return;
  btn.disabled = true;
  try {
    const { data } = await api('POST', '/repost', { contentId: rec.contentId, tags });
    const not = (data.removedTags ?? []).map((r) => `#${r.tag} (${r.reason})`).join(', ');
    toast(
      `Reposted under ${data.tags.map((t) => `#${t}`).join(' ')}${not ? `; not ${not}` : ''}. ` +
        'It shows there as a new post, and to those who follow you, after the next compactor run.',
      7000,
    );
    state.tags[state.tab] = [...new Set([...currentTags(), ...data.tags])].slice(0, 20);
    state.highlight = { contentId: data.contentId, tags: data.tags, tries: 0 };
    loadFeed();
  } catch (err) {
    toast(`Repost failed: ${err.message}`, 6000);
  } finally {
    btn.disabled = false;
  }
}

async function remove(rec) {
  if (!confirm(`Delete this post (${rec.contentId})?`)) return;
  try {
    const { data } = await api('DELETE', `/content/${rec.contentId}`);
    toast(`${data.status}: it can't be read any more, and the next compactor run takes it out of feeds.`);
    document.querySelectorAll(`.card[data-id="${rec.contentId}"]`).forEach((el) => el.classList.add('gone'));
    reloadSoon(3 * RETRY_MS);
  } catch (err) {
    toast(`Delete failed: ${err.message}`);
  }
}

async function edit(rec) {
  const p = rec.preview;
  $('#content-id').value = rec.contentId;
  $('#post-tags').value = rec.tags.join(', ');
  $('#ai-generated').checked = rec.aiGenerated;
  setKind(p.kind);
  if (p.kind === 'link') $('#url').value = p.url;
  else {
    // The preview holds only the first words; the content has the whole text or caption.
    try {
      const { data } = await api('GET', `/content/${rec.contentId}`, undefined, { auth: false });
      $('#content').value = data.text ?? p.text ?? '';
      // An update says the post's alt texts again, as it says all of the post: one line for each image.
      $('#alt').value = (data.preview.alt ?? []).join('\n');
    } catch {
      $('#content').value = p.text ?? '';
    }
  }
  if (p.kind === 'image' && p.imageCount > 1) {
    toast(`Choose the post's ${p.imageCount} images again, in their order: an update sends all of them, and the first must keep its content type (${rec.mimeType}).`, 6000);
  } else if (isMedia(p.kind)) toast(`Choose the ${rec.mimeType} file again: an update sends its file, and must keep its content type.`);
  $('#post-panel').scrollIntoView({ behavior: 'smooth' });
}

const kind = () => document.querySelector('input[name="kind"]:checked').value;
const isMedia = (k) => k === 'image' || k === 'video' || k === 'audio';
function setKind(k) {
  document.querySelector(`input[name="kind"][value="${k}"]`).checked = true;
  $('#text-fields').hidden = k === 'link';
  $('#file-fields').hidden = !isMedia(k);
  // Only an image is described by an alt text.
  $('#alt-fields').hidden = k !== 'image';
  $('#url-fields').hidden = k !== 'link';
  $('#file').accept = isMedia(k) ? `${k}/*` : '';
  // An image post takes several images, an album, in the order they are chosen; a video or audio post takes one file.
  $('#file').multiple = k === 'image';
  $('#content').placeholder = k === 'text' ? '' : 'Caption (optional)';
  // The sample text is a text post's; a caption starts empty.
  if (k !== 'text' && isSample($('#content').value)) $('#content').value = '';
  if (k === 'text' && !$('#content').value.trim()) fillSample();
}

const SAMPLE_MARK = 'Testbed post from';
const isSample = (s) => !s.trim() || s.startsWith(SAMPLE_MARK);
let sampleTags = '';
/** A sample post, tagged with the actor's interests (of the hashtags the server allows) unless other hashtags were typed in. */
function fillSample() {
  const a = state.actor;
  const wanted = a?.interests?.length ? a.interests : defaultTags('latest');
  const allowed = state.allowedTags;
  // Where the server lists the hashtags a post can have, the ones wanted that are on it, or else its first.
  const usable = allowed ? wanted.filter((t) => allowed.includes(t)) : wanted;
  const tags = (usable.length ? usable : (allowed ?? [])).slice(0, 2).join(', ');
  $('#content').value =
    `${SAMPLE_MARK} ${a?.username ?? 'someone'} at ${new Date().toLocaleTimeString()}.\n\n` +
    'Its hashtags are below, so it shows up in those feeds after the next compactor run, a few seconds from now. ' +
    'Edit the text, change the hashtags, or switch to an image, video, audio or link post.\n\n' +
    'Text can be **bold**, *italic*, ~~struck through~~ or `code`, and can [link](https://example.com) somewhere.';
  if (!$('#post-tags').value.trim() || $('#post-tags').value === sampleTags) $('#post-tags').value = tags;
  sampleTags = tags;
}

async function post(e) {
  e.preventDefault();
  if (!state.actor) return toast('Pick or register a user first.');
  const contentId = $('#content-id').value.trim() || undefined;
  const tags = $('#post-tags').value.trim() || undefined;
  const aiGenerated = $('#ai-generated').checked;
  const type = kind();
  const text = $('#content').value;
  const url = $('#url').value.trim();
  // An image post's images, in the order the browser lists them; any other post's one file.
  const files = [...$('#file').files].slice(0, type === 'image' ? undefined : 1);
  if (type === 'text' && !text.trim()) return toast('Write something first.');
  if (type === 'link' && !url) return toast('Paste a link first.');
  if (isMedia(type) && !files.length) return toast(type === 'image' ? 'Choose an image first, or several for an album.' : `Choose ${type === 'audio' ? 'an audio' : 'a video'} file first.`);
  /** The request body. */
  const body = () => {
    if (type === 'text') return { type, text, tags, contentId, aiGenerated };
    if (type === 'link') return { type, url, tags, contentId, aiGenerated };
    const form = new FormData();
    form.append('type', type);
    if (text.trim()) form.append('text', text);
    if (tags) form.append('tags', tags);
    if (contentId) form.append('contentId', contentId);
    form.append('aiGenerated', String(aiGenerated));
    // One part named "content" for each file: several are an album, shown in this order.
    for (const file of files) form.append('content', file, file.name);
    if (type === 'image') {
      // What describes each image: a line for each, in their order. An album sends an `alt` field for each of its
      // images, empty for one that has none, so that each stays with its image; one image sends its own, if it has one.
      const alts = $('#alt').value.split('\n').map((line) => line.trim());
      if (files.length > 1) for (const [i] of files.entries()) form.append('alt', alts[i] ?? '');
      else if (alts.join(' ').trim()) form.append('alt', alts.filter(Boolean).join(' '));
    }
    return form;
  };
  const btn = $('#post-btn');
  btn.disabled = true;
  btn.textContent = 'Posting…';
  const out = $('#post-result');
  try {
    const { data, ms } = await api('POST', '/store', body());
    out.className = 'result';
    out.textContent = `${Math.round(ms)} ms\n${JSON.stringify(data, null, 2)}`;
    if (data.unchanged) toast('Unchanged: the same post as the one stored, with the same hashtags.');
    else if (data.status === 'pending_review') {
      toast('Stored, and held in the moderation queue: it is in no feed until it is accepted.', 6000);
      $('#content-id').value = '';
      loadFeed();
    } else {
      // A video is published once the server has processed it: how long that takes goes by its length.
      if (data.processing) toast('Stored. Its video is being processed: feeds have it, with a video that plays, once that is done.', 7000);
      // An update shows where the post already is at once; a new post, or a new hashtag, after the next compactor run.
      else if (!contentId) toast('Stored. Feeds have it after the next compactor run, a few seconds from now.');
      state.highlight = { contentId: data.contentId, tags: data.tags, tries: 0 };
      $('#content-id').value = '';
      if (isSample($('#content').value)) fillSample();
      loadFeed();
    }
  } catch (err) {
    out.className = 'result bad';
    out.textContent = `${err.status ?? ''} ${err.message}\n${err.data && typeof err.data === 'object' ? JSON.stringify(err.data, null, 2) : ''}`;
  } finally {
    out.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Post';
  }
}

async function register(e) {
  e.preventDefault();
  const fields = { username: $('#reg-username').value.trim() };
  try {
    const { data } = await withChallenges((solution) => api('POST', '/register', { ...fields, ...solution }, { auth: false }));
    const user = {
      userId: data.userId,
      apiKey: data.apiKey,
      username: data.username,
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

/** #user or #latest, optionally with ?tags=a,b&hours=48&algorithm=popular|chronological&related=true|false&ai=true|false&as=<username or userId>. */
function readHash() {
  const [tab, query = ''] = location.hash.slice(1).split('?');
  state.tab = tab in TABS ? tab : 'user';
  const params = new URLSearchParams(query);
  if (params.get('tags')) state.tags[state.tab] = parseTags(params.get('tags'));
  const hours = Number(params.get('hours'));
  if (HOURS.includes(hours)) state.hours[state.tab] = hours;
  const algorithm = params.get('algorithm');
  if (algorithm in ALGORITHMS) state.algorithm[state.tab] = algorithm;
  const related = params.get('related');
  if (related === 'true' || related === 'false') state.related[state.tab] = related === 'true';
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
  // Which hashtags a post can have: any, or in server tagging mode only the ones the server lists.
  try {
    const { data } = await api('GET', '/tagging', undefined, { auth: false });
    state.allowedTags = data.allowedTags;
    $('#tagging-hint').textContent = data.allowedTags
      ? `This server takes only its own hashtags (TAGGING_MODE=server), up to ${data.maxTags} a post: ${data.allowedTags.map((t) => `#${t}`).join(' ')}.`
      : `Any hashtags will do (TAGGING_MODE=user), up to ${data.maxTags} a post.`;
    if (data.allowedTags) $('#post-tags').placeholder = data.allowedTags.slice(0, 2).join(', ');
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
    state.algorithm[state.tab] = $('#algorithm').value;
    state.related[state.tab] = $('#related').checked;
    state.ai[state.tab] = $('#ai').value;
    loadFeed();
  });
  for (const control of ['#hours', '#algorithm', '#related', '#ai']) {
    $(control).addEventListener('change', () => $('#feed-form').requestSubmit());
  }
  $('#reset-tags').addEventListener('click', () => {
    state.tags[state.tab] = null;
    state.hours[state.tab] = TABS[state.tab].hours;
    state.algorithm[state.tab] = TABS[state.tab].algorithm;
    state.related[state.tab] = false;
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
