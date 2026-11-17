import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLanguages, msg } from '../src/language.js';
import { setAdmin } from '../src/moderation/policy.js';
import { as, createTestContext, TARGETS, type TestContext, type User } from './helpers.js';

const ENGLISH = fileURLToPath(new URL('../languages/en.json', import.meta.url));

/** A language that has some of the server's messages, and says the others in the default language. */
const SPANISH = {
  name: 'Español',
  messages: {
    'auth.required': 'se requieren userId y apiKey',
    'challenge.register': 'resuelve el desafío para registrarte',
    'challenge.used': 'el desafío ha caducado o ya se usó',
    'challenge.solve_new': '{reason}; resuelve el nuevo desafío',
    'language.unknown': '"{language}" no es uno de los idiomas de este servidor: {available}',
    'user.api_key_note': 'Guarda esta apiKey ahora; no se puede recuperar después.',
    'user.username_taken': 'el nombre de usuario ya está en uso',
    'user.update_own_only': 'solo puedes actualizar tu propio perfil',
    'follow.limit': 'puedes seguir como máximo a {max} usuarios',
  },
};

/** One whose numbers take more forms than English ones do. */
const POLISH = {
  name: 'Polski',
  messages: {
    'upload.rate_limited': {
      one: 'za dużo plików; spróbuj ponownie za {count} sekundę',
      few: 'za dużo plików; spróbuj ponownie za {count} sekundy',
      many: 'za dużo plików; spróbuj ponownie za {count} sekund',
      other: 'za dużo plików; spróbuj ponownie za {count} sekundy',
    },
  },
};

/** A languages folder of the test's own: the server's English, and `files` beside it. */
async function languagesDir(files: Record<string, unknown> = { 'es.json': SPANISH }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'evieverse-languages-'));
  await copyFile(ENGLISH, join(dir, 'en.json'));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return dir;
}

describe('language files', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads the languages the server comes with from the languages folder, English among them', () => {
    const languages = loadLanguages();
    expect(languages.default).toBe('en');
    expect(languages.list()).toContainEqual({ code: 'en', name: 'English' });
    expect(languages.find('EN')).toBe('en');
    expect(languages.find('tlh')).toBeUndefined();
    expect(languages.render('en', msg('user.username_taken'))).toBe('username is already taken');
  });

  it('reads one language per file of the folder, named after the file, and the default one among them', async () => {
    dir = await languagesDir({ 'es.json': SPANISH, 'pt-br.json': { name: 'Português (Brasil)', messages: {} }, 'README.md': 'not a language' });
    const languages = loadLanguages('en', dir);
    expect(languages.list()).toEqual([
      { code: 'en', name: 'English' },
      { code: 'es', name: 'Español' },
      { code: 'pt-BR', name: 'Português (Brasil)' },
    ]);
    expect(languages.find('PT-br')).toBe('pt-BR');
    expect(loadLanguages('ES', dir).default).toBe('es');
    // What a language lacks of the default one's messages, which the server says as it starts.
    expect(languages.missing().map((l) => l.code)).toEqual(['es', 'pt-BR']);
    expect(languages.missing()[0]!.keys).toContain('user.not_found');
    expect(languages.missing()[0]!.keys).not.toContain('user.username_taken');
  });

  it('refuses a folder without the default language, and a file that is not a language', async () => {
    dir = await languagesDir();
    expect(() => loadLanguages('fr', dir)).toThrow(/default language is "fr".*has no fr\.json: it has en, es/);
    for (const [name, contents, error] of [
      ['not a language!.json', SPANISH, /isn't named after a language/],
      ['fr.json', '{ "name": "Français", ', /can't be read as JSON/],
      ['fr.json', { messages: {} }, /must hold the language's "name"/],
      ['fr.json', { name: 'Français', messages: { 'user.not_found': 7 } }, /must hold the language's "name"/],
      ['fr.json', { name: 'Français', messages: { 'upload.rate_limited': { one: 'une seconde' } } }, /must hold the language's "name"/],
    ] as const) {
      await rm(dir, { recursive: true, force: true });
      dir = await languagesDir({ [name]: contents });
      expect(() => loadLanguages('en', dir), name).toThrow(error);
    }
  });

  it('fills in a message’s parameters, the form its number takes in the language, and the messages within it', async () => {
    dir = await languagesDir({ 'es.json': SPANISH, 'pl.json': POLISH });
    const languages = loadLanguages('en', dir);
    expect(languages.render('en', msg('follow.limit', { max: 1000 }))).toBe('you can follow at most 1000 users');
    expect(languages.render('es', msg('follow.limit', { max: 1000 }))).toBe('puedes seguir como máximo a 1000 usuarios');

    const wait = (code: string, count: number) => languages.render(code, msg('upload.rate_limited', { count }));
    expect([wait('en', 1), wait('en', 2)]).toEqual(['too many uploads; try again in 1 second', 'too many uploads; try again in 2 seconds']);
    expect([1, 2, 5, 22].map((count) => wait('pl', count))).toEqual([
      'za dużo plików; spróbuj ponownie za 1 sekundę',
      'za dużo plików; spróbuj ponownie za 2 sekundy',
      'za dużo plików; spróbuj ponownie za 5 sekund',
      'za dużo plików; spróbuj ponownie za 22 sekundy',
    ]);

    const limited = (limit: number, seconds: number) => msg('post.rate_limited', { rate: msg('post.rate', { count: limit }), count: seconds });
    expect(languages.render('en', limited(1, 60))).toBe('you can post at most once a minute; try again in 60 seconds');
    expect(languages.render('en', limited(3, 1))).toBe('you can post at most 3 times a minute; try again in 1 second');
    // A message within a message is said in the same language, where the language has it.
    expect(languages.render('es', msg('challenge.solve_new', { reason: msg('challenge.used') }))).toBe('el desafío ha caducado o ya se usó; resuelve el nuevo desafío');
    expect(languages.render('es', msg('challenge.solve_new', { reason: msg('challenge.expired') }))).toBe('the challenge has expired; resuelve el nuevo desafío');
  });

  it('says a message a language lacks in the default language, and never fails over one', async () => {
    dir = await languagesDir({ 'es.json': SPANISH, 'pl.json': POLISH });
    const languages = loadLanguages('en', dir);
    expect(languages.render('es', msg('user.not_found'))).toBe('user not found');
    // By the default language's rules for numbers, as the words are its own.
    expect(languages.render('es', msg('upload.rate_limited', { count: 1 }))).toBe('too many uploads; try again in 1 second');
    expect(loadLanguages('es', dir).render('pl', msg('user.username_taken'))).toBe('el nombre de usuario ya está en uso');
    // A language the server doesn't speak is answered in the default one.
    expect(languages.render('fr', msg('user.not_found'))).toBe('user not found');
    // Words that aren't a message are said as they are; a parameter that wasn't given stays as written.
    expect(languages.render('es', 'the post shouts too much')).toBe('the post shouts too much');
    expect(languages.render('en', msg('follow.limit'))).toBe('you can follow at most {max} users');
    // What a parameter holds is never read as a parameter itself.
    expect(languages.render('en', msg('tags.unusable', { word: '{max}' }))).toBe('"{max}" is not a usable hashtag: hashtags are letters, digits and underscores');
  });

  it('picks the language an Accept-Language header asks for, as closely as the server speaks it', async () => {
    dir = await languagesDir({ 'es.json': SPANISH, 'pt-BR.json': { name: 'Português (Brasil)', messages: {} } });
    const languages = loadLanguages('en', dir);
    expect(languages.preferred('es')).toBe('es');
    expect(languages.preferred('ES-mx')).toBe('es');
    expect(languages.preferred('pt')).toBe('pt-BR');
    expect(languages.preferred('pt-PT')).toBe('pt-BR');
    expect(languages.preferred('fr-CA, es;q=0.8, en;q=0.9')).toBe('en');
    expect(languages.preferred('fr, es;q=0.5, en;q=0.5')).toBe('es');
    expect(languages.preferred('es;q=0, *;q=0.1')).toBe('en');
    expect(languages.preferred('es;q=0')).toBeUndefined();
    expect(languages.preferred('fr, de')).toBeUndefined();
    expect(languages.preferred('')).toBeUndefined();
    expect(languages.preferred(undefined)).toBeUndefined();
    expect(languages.preferred(['es'])).toBeUndefined();
  });
});

for (const target of TARGETS) {
  describe(`languages (${target.name})`, () => {
    let ctx: TestContext;
    let dir: string;
    const start = async (opts: Parameters<typeof createTestContext>[1] = {}, defaultLanguage = 'en') => {
      dir = await languagesDir();
      ctx = await createTestContext(target, { ...opts, languages: loadLanguages(defaultLanguage, dir) });
    };
    beforeEach(() => start());
    afterEach(async () => {
      await ctx.close();
      await rm(dir, { recursive: true, force: true });
    });

    const SPANISH_FIRST = { 'accept-language': 'fr-CA, es-MX;q=0.9, en;q=0.5' };

    /** Registers, solving the challenge the first request is answered with: both responses. */
    async function register(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
      const asked = await ctx.app.inject({ method: 'POST', url: '/register', payload, headers });
      if (asked.statusCode !== 428) return { asked, done: asked };
      const solved = { ...payload, ...(await ctx.solve(asked.json().challenge)) };
      return { asked, done: await ctx.app.inject({ method: 'POST', url: '/register', payload: solved, headers }) };
    }
    const whoami = async (user: User) => (await ctx.app.inject({ method: 'GET', url: '/whoami', headers: as(user) })).json();
    const patch = (user: User, userId: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
      ctx.app.inject({ method: 'PATCH', url: `/users/${userId}`, payload: { ...user, ...payload }, headers });
    const stored = (userId: string) => ctx.db.selectFrom('users').select(['language', 'updated_at']).where('id', '=', userId).executeTakeFirstOrThrow();

    it('lists the languages of its folder, and which of them is the default', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/languages' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        default: 'en',
        languages: [
          { code: 'en', name: 'English' },
          { code: 'es', name: 'Español' },
        ],
      });

      await ctx.close();
      await rm(dir, { recursive: true, force: true });
      await start({}, 'es');
      expect((await ctx.app.inject({ method: 'GET', url: '/languages' })).json()).toMatchObject({ default: 'es' });
      // The default language is the one of a request that asks for none, and of one that asks for none the server speaks.
      for (const headers of [{}, { 'accept-language': 'fr' }]) {
        expect((await ctx.app.inject({ method: 'GET', url: '/whoami', headers })).json()).toEqual({ error: 'se requieren userId y apiKey' });
      }
      expect((await register({ username: 'ana' })).done.json()).toMatchObject({ language: 'es' });
    });

    it('registers a user in any of its languages, and answers them in it from then on', async () => {
      const { asked, done } = await register({ username: 'ana', language: 'ES' });
      expect([asked.statusCode, asked.json().error]).toEqual([428, 'resuelve el desafío para registrarte']);
      expect(done.statusCode, done.body).toBe(201);
      expect(done.json()).toEqual({
        userId: expect.any(String),
        username: 'ana',
        language: 'es',
        apiKey: expect.stringMatching(/^ev_/),
        note: 'Guarda esta apiKey ahora; no se puede recuperar después.',
      });
      const ana: User = done.json();
      expect(await stored(ana.userId)).toMatchObject({ language: 'es' });
      expect(await whoami(ana)).toMatchObject({ username: 'ana', language: 'es' });
      // Others don't see it: it is no part of the profile.
      expect((await ctx.app.inject({ method: 'GET', url: `/users/${ana.userId}` })).json()).not.toHaveProperty('language');

      // A registration is answered in its language all the way through: a challenge that wasn't solved, a name that is taken.
      const again = { challengeId: asked.json().challenge.id, challengeAnswer: 'ABCDEF', challengeNonce: '0' };
      const unsolved = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'eva', language: 'es', ...again } });
      expect([unsolved.statusCode, unsolved.json().error]).toEqual([428, 'el desafío ha caducado o ya se usó; resuelve el nuevo desafío']);
      expect((await register({ username: 'ana', language: 'es' })).asked.json()).toEqual({ error: 'el nombre de usuario ya está en uso' });
      expect((await register({ username: 'ana' })).asked.json()).toEqual({ error: 'username is already taken' });

      // Her requests are answered in her language, whatever language they ask for...
      const bob: User = (await register({ username: 'bob' })).done.json();
      expect(await whoami(bob)).toMatchObject({ language: 'en' });
      const refused = await patch(ana, bob.userId, { username: 'roberto' }, { 'accept-language': 'en' });
      expect([refused.statusCode, refused.json().error]).toEqual([403, 'solo puedes actualizar tu propio perfil']);
      // ...in the default language where hers lacks the words...
      const own = await ctx.app.inject({ method: 'PUT', url: `/users/${ana.userId}/following/${ana.userId}`, headers: as(ana) });
      expect([own.statusCode, own.json().error]).toEqual([400, "you can't follow yourself"]);
      // ...and bob's in his.
      expect((await patch(bob, ana.userId, { username: 'anna' }, SPANISH_FIRST)).json()).toEqual({ error: 'you can only update your own profile' });
    });

    it('registers a user who names no language in the one the request asks for, and refuses a language it does not speak', async () => {
      const luz = await register({ username: 'luz' }, SPANISH_FIRST);
      expect(luz.asked.json().error).toBe('resuelve el desafío para registrarte');
      expect(luz.done.json()).toMatchObject({ language: 'es' });
      expect((await register({ username: 'bob' })).done.json()).toMatchObject({ language: 'en' });
      expect((await register({ username: 'kim' }, { 'accept-language': 'ko' })).done.json()).toMatchObject({ language: 'en' });
      // The language named wins over the one asked for.
      expect((await register({ username: 'amy', language: 'en' }, SPANISH_FIRST)).done.json()).toMatchObject({ language: 'en' });

      const unknown = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'guy', language: 'fr' } });
      expect([unknown.statusCode, unknown.json()]).toEqual([400, { error: '"fr" is not one of this server\'s languages: en, es' }]);
      const asked = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'guy', language: 'fr' }, headers: SPANISH_FIRST });
      expect(asked.json()).toEqual({ error: '"fr" no es uno de los idiomas de este servidor: en, es' });
      expect(await ctx.db.selectFrom('users').select('id').where('username', '=', 'guy').execute()).toEqual([]);
    });

    it('registers a user an admin creates in the language named, or else in the admin\'s', async () => {
      const root: User = (await register({ username: 'root', language: 'es' })).done.json();
      await setAdmin(ctx.db, 'root', true);
      // The admin's request is answered in the admin's language, whatever it asks for, and so that is the user's.
      const luz = await register({ username: 'luz' }, { ...as(root), 'accept-language': 'en' });
      expect([luz.asked.statusCode, luz.asked.json()]).toEqual([201, expect.objectContaining({ language: 'es', note: 'Guarda esta apiKey ahora; no se puede recuperar después.' })]);
      const bob = await register({ username: 'bob', language: 'en' }, as(root));
      expect([bob.asked.statusCode, bob.asked.json()]).toEqual([201, expect.objectContaining({ language: 'en', note: expect.stringMatching(/^Store this apiKey/) })]);
      expect(await whoami(bob.asked.json())).toMatchObject({ username: 'bob', language: 'en' });
      // What is wrong with the request is said in the admin's language too.
      expect((await register({ username: 'guy', language: 'fr' }, { ...as(root), 'accept-language': 'en' })).asked.json()).toEqual({
        error: '"fr" no es uno de los idiomas de este servidor: en, es',
      });
    });

    it('lets a user change their language, and only them', async () => {
      const ana: User = (await register({ username: 'ana', language: 'es' })).done.json();
      const bob: User = (await register({ username: 'bob' })).done.json();
      const before = await stored(ana.userId);

      const changed = await patch(ana, ana.userId, { language: 'EN' });
      expect([changed.statusCode, changed.json()]).toEqual([200, { userId: ana.userId, username: 'ana', language: 'en', messages: true, showFollowing: false, showFollowers: false }]);
      // The language is no part of her credit, so nothing tells the compactor to write that again.
      expect(await stored(ana.userId)).toEqual({ language: 'en', updated_at: before.updated_at });
      expect(await whoami(ana)).toMatchObject({ language: 'en' });
      expect((await patch(ana, bob.userId, { username: 'roberto' }, SPANISH_FIRST)).json()).toEqual({ error: 'you can only update your own profile' });

      // A language the server doesn't speak changes nothing, the name sent with it included.
      const unknown = await patch(ana, ana.userId, { username: 'anna', language: 'fr' });
      expect([unknown.statusCode, unknown.json()]).toEqual([400, { error: '"fr" is not one of this server\'s languages: en, es' }]);
      expect(await whoami(ana)).toMatchObject({ username: 'ana', language: 'en' });
      // Nor does a name that is taken change the language sent with it.
      expect((await patch(ana, ana.userId, { username: 'bob', language: 'es' })).statusCode).toBe(409);
      expect(await whoami(ana)).toMatchObject({ username: 'ana', language: 'en' });

      // Both at once, and each alone leaves the other as it is.
      expect((await patch(ana, ana.userId, { username: 'anna', language: 'es' })).json()).toEqual({ userId: ana.userId, username: 'anna', language: 'es', messages: true, showFollowing: false, showFollowers: false });
      expect((await patch(ana, ana.userId, { username: 'ana' })).json()).toEqual({ userId: ana.userId, username: 'ana', language: 'es', messages: true, showFollowing: false, showFollowers: false });
      expect(await whoami(ana)).toMatchObject({ username: 'ana', language: 'es' });

      // Nobody else can, and the refusal is in the language of whoever tried.
      const other = await patch(bob, ana.userId, { language: 'en' });
      expect([other.statusCode, other.json().error]).toEqual([403, 'you can only update your own profile']);
      expect((await patch({ userId: ana.userId, apiKey: bob.apiKey }, ana.userId, { language: 'en' })).statusCode).toBe(401);
      expect(await whoami(ana)).toMatchObject({ language: 'es' });
    });

    it('answers a request no user is behind in the language it asks for, or the default one', async () => {
      const unsigned = (headers: Record<string, string>) => ctx.app.inject({ method: 'GET', url: '/whoami', headers });
      expect((await unsigned({})).json()).toEqual({ error: 'userId and apiKey are required' });
      expect((await unsigned({ 'accept-language': 'es-AR' })).json()).toEqual({ error: 'se requieren userId y apiKey' });
      expect((await unsigned({ 'accept-language': 'de, fr;q=0.9' })).json()).toEqual({ error: 'userId and apiKey are required' });
      // What a schema says of a field is zod's own wording; what the request as a whole gets is the server's.
      const invalid = await ctx.app.inject({ method: 'GET', url: '/feed?tags=news&hours=5', headers: { 'accept-language': 'es' } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: 'Invalid request', details: [{ path: ['hours'], message: expect.stringMatching(/^hours must be one of 1, 2, /) }] });
      expect(invalid.json().details[0]).not.toHaveProperty('params');
    });

    it('answers a user whose language it no longer speaks in the default one', async () => {
      const ana: User = (await register({ username: 'ana', language: 'es' })).done.json();
      await ctx.db.updateTable('users').set({ language: 'tlh' }).where('id', '=', ana.userId).execute();
      expect(await whoami(ana)).toMatchObject({ language: 'en' });
      const own = await ctx.app.inject({ method: 'PUT', url: `/users/${ana.userId}/following/${ana.userId}`, headers: { ...as(ana), ...SPANISH_FIRST } });
      expect(own.json()).toEqual({ error: "you can't follow yourself" });
    });

    it('says how long a registration past the limit has to wait', async () => {
      await ctx.close();
      await rm(dir, { recursive: true, force: true });
      // As many requests as one registration takes: the one answered with a challenge, and the one that solves it.
      await start({ registerRateLimitPerHour: 2 });
      expect((await register({ username: 'ana' })).done.statusCode).toBe(201);
      const refused = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'bob' } });
      expect([refused.statusCode, refused.json()]).toEqual([429, { error: 'Rate limit exceeded, retry in 60 minutes' }]);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(3500);
    });
  });
}
