import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { msg } from '../src/language.js';
import { loadTrustPlugins, type TrustContext, type TrustPost } from '../src/moderation/trust.js';
import { urlhaus } from '../src/plugins/trust/urlhaus/index.js';
import { addressOf, beforeStepsBack, endings, findLinks } from '../src/plugins/trust/urlhaus/links.js';
import { urlOfLine } from '../src/plugins/trust/urlhaus/list.js';
import { as, createTestContext, requests, TARGETS, type TestContext } from './helpers.js';

/** A database dump as URLhaus writes one: comments, then a row for each URL, every field quoted. */
const CSV = [
  '################################################################',
  '# abuse.ch URLhaus Database Dump (CSV - recent URLs only)      #',
  '################################################################',
  '#',
  '# id,dateadded,url,url_status,last_online,threat,tags,urlhaus_link,reporter',
  '"3001","2026-11-06 10:00:00","http://malware.example/files/setup.exe","online","2026-11-06 10:00:00","malware_download","exe","https://urlhaus.abuse.ch/url/3001/","someone"',
  '"3002","2026-11-06 10:01:00","http://192.0.2.7:8080/bin.sh","offline","","malware_download","elf,mirai","https://urlhaus.abuse.ch/url/3002/","someone"',
  '"3003","2026-11-06 10:02:00","https://files.example/get.php?id=7","online","2026-11-06 10:02:00","malware_download","None","https://urlhaus.abuse.ch/url/3003/","someone"',
  '"3004","2026-11-06 10:03:00","http://Shared.example/a(1),b.exe","online","2026-11-06 10:03:00","malware_download","None","https://urlhaus.abuse.ch/url/3004/","someone"',
  '"3005","2026-11-06 10:04:00","http://root.example/","online","2026-11-06 10:04:00","malware_download","None","https://urlhaus.abuse.ch/url/3005/","someone"',
  '',
].join('\r\n');

const REFUSED = { set: 0, reason: msg('moderation.malware_link') };

/** What stands in for URLhaus: answers every download with `body`, or as `answer` says, and keeps the requests it got. */
function urlhausServer(body = CSV) {
  const server = {
    body,
    status: 200,
    /** Set to have the next downloads fail before they are answered. */
    down: false,
    /** Set to answer a few bytes at a time, as a download arrives, whatever they cut in two. */
    chunkBytes: 0,
    requests: [] as { url: string; authKey: string | null }[],
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      server.requests.push({ url: String(input), authKey: new Headers(init?.headers).get('auth-key') });
      if (server.down) throw new TypeError('fetch failed');
      if (!server.chunkBytes) return new Response(server.body, { status: server.status });
      const bytes = Buffer.from(server.body);
      const chunks = Array.from({ length: Math.ceil(bytes.length / server.chunkBytes) }, (_, i) => bytes.subarray(i * server.chunkBytes, (i + 1) * server.chunkBytes));
      const body = new ReadableStream<Uint8Array>({ pull: (controller) => (chunks.length ? controller.enqueue(chunks.shift()!) : controller.close()) });
      return new Response(body, { status: server.status });
    }) as typeof fetch,
  };
  return server;
}

/** The plugin with a server of its own, on a clock the test moves, as `assess` is called with it. */
function setup(settings: Record<string, unknown> = { authKey: 'KEY' }, body?: string) {
  const server = urlhausServer(body);
  const clock = { now: Date.UTC(2026, 10, 6, 12) };
  const ctx = { config: loadConfig({ urlhaus: settings }, {}), now: () => clock.now, score: 100 } as unknown as TrustContext;
  const plugin = urlhaus(server.fetcher);
  const assess = async (text: string, post: Partial<TrustPost> = {}) => plugin.assess({ userId: 'u', tags: ['news'], texts: [text], ...post }, ctx);
  return { server, clock, assess };
}

describe('the urlhaus trust plugin', () => {
  it('is optional: a plugin the server comes with, and runs only if it names it', async () => {
    expect(urlhaus().optional).toBe(true);
    expect((await loadTrustPlugins()).map((plugin) => plugin.name)).not.toContain('urlhaus');
    expect((await loadTrustPlugins(['urlhaus'])).map((plugin) => plugin.name)).toContain('urlhaus');
  });

  it("downloads URLhaus's list once, with the Auth-Key, and gives a post with a listed link no trust", async () => {
    const { server, assess } = setup();
    expect(await assess('http://malware.example/files/setup.exe')).toEqual(REFUSED);
    expect(await assess('http://192.0.2.7:8080/bin.sh')).toEqual(REFUSED);
    expect(await assess('https://files.example/get.php?id=7')).toEqual(REFUSED);
    expect(await assess('http://root.example/')).toEqual(REFUSED);
    // A comment is told so in its own words.
    expect(await assess('http://malware.example/files/setup.exe', { commentOn: 'c1' })).toEqual({ set: 0, reason: msg('comment.malware_link') });
    // A link among other texts, as a caption's is beside its filename.
    expect(await assess('holiday.jpg', { texts: ['look: http://malware.example/files/setup.exe', 'holiday.jpg'] })).toEqual(REFUSED);
    expect(server.requests).toEqual([{ url: 'https://urlhaus-api.abuse.ch/v2/files/exports/KEY/recent.csv', authKey: 'KEY' }]);
  });

  it('leaves a post whose links are not on the list as it is', async () => {
    const { assess } = setup();
    for (const text of [
      'No link at all.',
      'https://news.example/story?id=1',
      // Another file of a host that has a listed one, as a host many people put files on has.
      'http://malware.example/files/readme.txt',
      'http://malware.example/',
      'http://malware.example/files/',
      'http://malware.example/files/setup',
      'http://malware.example/Files/setup.exe',
      // Another page of a host whose front page is listed.
      'http://root.example/about',
      'http://root.example/about/',
      // Another host, however alike, and another port.
      'http://notmalware.example/files/setup.exe',
      'http://malware.example.org/files/setup.exe',
      'http://192.0.2.7:8081/bin.sh',
      'http://192.0.2.7/bin.sh',
      // A listed URL with a query is that query's: another, or none, is another URL.
      'https://files.example/get.php?id=8',
      'https://files.example/get.php',
      // What is no web address.
      'ftp://malware.example/files/setup.exe',
      'someone@malware.example',
      'version 1.2.3.4 of setup.exe',
    ]) {
      expect(await assess(text), text).toBeNull();
    }
  });

  it('knows a listed link however it is written', async () => {
    const { assess } = setup();
    for (const text of [
      // The same address: the other scheme, the host in any case or with its last dot, a port that is the scheme's own.
      'https://malware.example/files/setup.exe',
      'HTTP://MALWARE.EXAMPLE/files/setup.exe',
      'http://malware.example./files/setup.exe',
      'http://malware.example:80/files/setup.exe',
      'http://user:secret@malware.example/files/setup.exe',
      'http://malware.example/files/../files/./setup.exe',
      'http://malware.example\\files\\setup.exe',
      // The same file: a fragment, or a query added to a URL that has none.
      'http://malware.example/files/setup.exe#top',
      'http://malware.example/files/setup.exe?download=1',
      'https://files.example/get.php?id=7&again=1',
      // The same file with something after its address, which a server reads past and a text can go on with.
      'http://malware.example/files/setup.exe/',
      'http://malware.example/files/setup.exe/anything?at=all',
      'http://malware.example/files/setup.exe;x',
      'http://malware.example/files/setup.exe.sig',
      'the installer http://malware.example/files/setup.exenow',
      // What follows it can't take it back out of the address.
      'http://malware.example/files/setup.exe/../../about',
      'http://malware.example/files/setup.exe/%2E%2e/readme.txt',
      'http://malware.example/files/setup.exe\\..\\..',
      // An IP address written another way.
      'http://3221225991:8080/bin.sh',
      'http://0xc0.0.2.7:8080/bin.sh',
      // A listed URL that has what could end a link in it.
      'http://shared.example/a(1),b.exe',
      'the file (http://shared.example/a(1),b.exe).',
      // A host alone, where the list has it.
      'see http://root.example.',
      'http://root.example',
    ]) {
      expect(await assess(text), text).toEqual(REFUSED);
    }
  });

  it('finds a link anywhere in a text, in whatever surrounds it', async () => {
    const { assess } = setup();
    for (const text of [
      'Get it at http://malware.example/files/setup.exe now',
      'Get it at http://malware.example/files/setup.exe.',
      'Is it http://malware.example/files/setup.exe?!',
      'the file (http://malware.example/files/setup.exe), as promised',
      '"http://malware.example/files/setup.exe"',
      "'http://malware.example/files/setup.exe'",
      'first line\nhttp://malware.example/files/setup.exe\nlast line',
      // Markup: Markdown, with nothing between two links, emphasis, HTML, and BBCode.
      '[the installer](http://malware.example/files/setup.exe)',
      '[a](https://news.example/story)[b](http://malware.example/files/setup.exe)[c](https://news.example/other)',
      '[a](http://malware.example/files/setup.exe)[b](https://news.example/other)',
      '**http://malware.example/files/setup.exe**',
      '_http://root.example_',
      '<a href="http://malware.example/files/setup.exe">the installer</a>',
      '<http://malware.example/files/setup.exe>',
      '[url=http://malware.example/files/setup.exe]the installer[/url]',
      // What the server's own formatting ends an address at (src/format.ts), whatever follows it.
      'http://malware.example/files/setup.exe[1]',
      `http://malware.example/files/setup.exe]${')'.repeat(40)}`,
      'http://malware.example/files/setup.exe\\*',
      'http://malware.example/files/setup.exe**bold**',
      '[the *installer*](http://malware.example/files/setup.exe) and [more](https://news.example/a_(b))',
      '(see http://shared.example/a(1),b.exe)',
      // Without a scheme, as people write links and clients make them.
      'malware.example/files/setup.exe',
      'Get it at malware.example/files/setup.exe.',
      '[the installer](malware.example/files/setup.exe)',
      '192.0.2.7:8080/bin.sh',
      'root.example',
      // A listed URL another address passes on.
      'https://redirect.example/?to=http://malware.example/files/setup.exe',
      'https://web.archive.example/web/2026/http://malware.example/files/setup.exe',
      'https://redirect.example/?to=malware.example/files/setup.exe',
    ]) {
      expect(await assess(text), text).toEqual(REFUSED);
    }
  });

  it('reads a text of any size in little time', async () => {
    const { assess } = setup();
    const long = [
      'http://'.repeat(5000),
      `http://malware.example/${')'.repeat(40_000)}`,
      'http://malware.example/)'.repeat(1600),
      'a.'.repeat(20_000),
      'a'.repeat(40_000),
      `${'user:'.repeat(8000)}@malware.example`,
    ];
    const started = performance.now();
    for (const text of long) expect(await assess(text), text.slice(0, 40)).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(await assess(`${'http://news.example/a) '.repeat(1500)}http://malware.example/files/setup.exe`)).toEqual(REFUSED);
  });

  it('reads a plain list of URLs as it reads a CSV', async () => {
    const { assess } = setup({ authKey: 'KEY', listUrl: 'https://lists.example/{key}/urls.txt' }, '# URLhaus\nhttp://malware.example/files/setup.exe\nhttp://192.0.2.7:8080/bin.sh\n');
    expect(await assess('192.0.2.7:8080/bin.sh')).toEqual(REFUSED);
    expect(await assess('https://news.example/story')).toBeNull();

    // Read as it arrives: a line, or a character, that comes in two pieces is one.
    const pieces = setup({ authKey: 'KEY' }, `${CSV}"3006","2026-11-06 10:05:00","http://münchen.example/größe.exe","online","","malware_download","None","https://urlhaus.abuse.ch/url/3006/","someone"`);
    pieces.server.chunkBytes = 7;
    for (const url of ['http://malware.example/files/setup.exe', 'http://192.0.2.7:8080/bin.sh', 'https://files.example/get.php?id=7', 'http://root.example/', 'http://münchen.example/größe.exe']) {
      expect(await pieces.assess(url), url).toEqual(REFUSED);
    }
    expect(await pieces.assess('münchen.example/größe.exe')).toEqual(REFUSED);
    expect(await pieces.assess('http://xn--mnchen-3ya.example/gr%C3%B6%C3%9Fe.exe')).toEqual(REFUSED);

    expect(urlOfLine('# id,dateadded,url')).toBeNull();
    expect(urlOfLine('')).toBeNull();
    expect(urlOfLine('"1","2026-11-06 10:00:00","online"')).toBeNull();
    expect(urlOfLine('http://a.example/x,y \r')).toBe('http://a.example/x,y');
    expect(urlOfLine('"1","2026-11-06","http://a.example/x,y","online","https://urlhaus.abuse.ch/url/1/"')).toBe('http://a.example/x,y');
    expect(urlOfLine('"1","2026-11-06","http://a.example/say-""hi""","online"')).toBe('http://a.example/say-"hi"');
    expect(urlOfLine('1,2026-11-06,http://a.example/x,online')).toBe('http://a.example/x');
  });

  it('downloads the list again when it is due, without making a post wait, and keeps the one it has if that fails', async () => {
    const { server, clock, assess } = setup({ authKey: 'KEY', refreshMinutes: 10 });
    expect(await assess('http://malware.example/files/setup.exe')).toEqual(REFUSED);
    expect(await assess('http://new.example/dropper.exe')).toBeNull();

    // Not yet due: nothing is asked of URLhaus, whatever is posted.
    server.body = `${CSV}"3006","2026-11-06 12:05:00","http://new.example/dropper.exe","online","","malware_download","None","https://urlhaus.abuse.ch/url/3006/","someone"\r\n`;
    clock.now += 9 * 60_000;
    expect(await assess('http://new.example/dropper.exe')).toBeNull();
    expect(await assess('No link.')).toBeNull();
    expect(server.requests).toHaveLength(1);

    // Due: the post that finds it so is answered from the list there is, and the next ones from the new one. A post with no link does as well.
    clock.now += 60_000;
    expect(await assess('No link.')).toBeNull();
    expect(server.requests).toHaveLength(2);
    await vi.waitFor(async () => expect(await assess('http://new.example/dropper.exe')).toEqual(REFUSED));
    expect(server.requests).toHaveLength(2);

    // A download that fails leaves the list as it was, and is tried again a minute later.
    clock.now += 10 * 60_000;
    server.down = true;
    expect(await assess('http://new.example/dropper.exe')).toEqual(REFUSED);
    expect(server.requests).toHaveLength(3);
    clock.now += 59_000;
    expect(await assess('http://malware.example/files/setup.exe')).toEqual(REFUSED);
    expect(server.requests).toHaveLength(3);
    clock.now += 1000;
    // An answer that isn't the list doesn't take its place either.
    Object.assign(server, { down: false, body: '<html>Maintenance</html>' });
    expect(await assess('http://malware.example/files/setup.exe')).toEqual(REFUSED);
    expect(server.requests).toHaveLength(4);
    clock.now += 60_000;
    Object.assign(server, { body: 'http://only.example/x.exe\n' });
    expect(await assess('http://malware.example/files/setup.exe')).toEqual(REFUSED);
    await vi.waitFor(async () => expect(await assess('http://malware.example/files/setup.exe')).toBeNull());
    expect(await assess('http://only.example/x.exe')).toEqual(REFUSED);
    expect(server.requests).toHaveLength(5);
  });

  it("fails a post with a link while it has no list, and no other, and doesn't put the Auth-Key in the error", async () => {
    const { server, clock, assess } = setup({ authKey: 'SECRET-KEY' });
    server.status = 401;
    server.body = '{"status":401,"message":"Invalid auth token"}';
    const failure = await assess('https://news.example/story').catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('the urlhaus trust plugin has no list of malware URLs to check links with: URLhaus answered 401: it refused the Auth-Key (URLHAUS_AUTH_KEY)');
    expect(JSON.stringify([failure, (failure as Error).cause, (failure as Error).stack])).not.toContain('SECRET-KEY');
    // What only may be a link, and what has none, isn't failed.
    expect(await assess('holiday.jpg')).toBeNull();
    expect(await assess('news.example/story')).toBeNull();
    expect(await assess('No link.')).toBeNull();
    // Nor is URLhaus asked again for each: once a minute, until it answers.
    await expect(assess('https://news.example/story')).rejects.toThrow(/URLhaus answered 401/);
    expect(server.requests).toHaveLength(1);

    clock.now += 60_000;
    server.down = true;
    await expect(assess('https://news.example/story')).rejects.toThrow('the urlhaus trust plugin has no list of malware URLs to check links with: fetch failed');
    clock.now += 60_000;
    Object.assign(server, { down: false, status: 200, body: 'Not a list.' });
    await expect(assess('https://news.example/story')).rejects.toThrow(/has no URL in it/);
    expect(server.requests).toHaveLength(3);

    clock.now += 60_000;
    server.body = CSV;
    expect(await assess('https://news.example/story')).toBeNull();
    expect(await assess('http://malware.example/files/setup.exe')).toEqual(REFUSED);
    expect(server.requests).toHaveLength(4);
  });

  it('downloads the list once for the posts that wait for it together', async () => {
    const { server, assess } = setup();
    const answers = await Promise.all(['http://malware.example/files/setup.exe', 'https://news.example/story', 'No link.', 'root.example'].map((text) => assess(text)));
    expect(answers).toEqual([REFUSED, null, null, REFUSED]);
    expect(server.requests).toHaveLength(1);
  });

  it('compares addresses without their scheme and fragment, and tries each place a link could end', () => {
    expect(addressOf('HTTPS://Example.COM:443/a/../b?c=1#d')).toEqual({ host: 'example.com', path: 'example.com/b', full: 'example.com/b?c=1' });
    expect(addressOf('http://example.com.:8080')).toEqual({ host: 'example.com:8080', path: 'example.com:8080/', full: 'example.com:8080/' });
    expect(addressOf('http://[2001:DB8::1]/x')).toEqual({ host: '[2001:db8::1]', path: '[2001:db8::1]/x', full: '[2001:db8::1]/x' });
    expect(addressOf('mailto:someone@example.com')).toBeNull();
    expect(addressOf('not a url')).toBeNull();

    expect(findLinks('See https://a.example/x?y=1, or b.example.')).toEqual([
      { schemed: true, origins: ['https://a.example'], tail: '/x?y=1,' },
      { schemed: false, origins: ['http://b.example', 'https://b.example'], tail: '' },
    ]);
    expect(findLinks('Nothing here: a sentence. Another, with an address@mail.example and 12.5 percent.')).toEqual([]);
    expect(endings('/a).')).toEqual(['/a).', '/a)', '/a']);
    expect(endings('/a)[b](c')).toEqual(['/a)[b](c', '/a', '/a)', '/a)[b']);
    expect(endings('')).toEqual(['']);
    // However much follows a link, the places it is tried to end at are a few, and the first ones.
    expect(endings(`/a]${')'.repeat(100)}`)).toHaveLength(1 + 8 + 32);
    expect(endings(`/a]${')'.repeat(100)}`)).toContain('/a');
    expect(beforeStepsBack('/a/../b/%2e./c/..')).toEqual(['/a/../b/%2e./c/..', '/a', '/a/../b', '/a/../b/%2e./c']);
    expect(beforeStepsBack('/a/..b/.../c')).toEqual(['/a/..b/.../c']);
  });
});

describe('URLHAUS_AUTH_KEY, URLHAUS_LIST_URL and URLHAUS_REFRESH_MINUTES', () => {
  const load = (env: Record<string, string>) => loadConfig({}, env).urlhaus;

  it('are off, the URLs of the last 30 days, and 15 minutes, unless set', () => {
    expect(load({})).toEqual({ listUrl: 'https://urlhaus-api.abuse.ch/v2/files/exports/{key}/recent.csv', refreshMinutes: 15 });
    expect(load({ URLHAUS_AUTH_KEY: '' }).authKey).toBeUndefined();
    expect(load({ URLHAUS_AUTH_KEY: ' KEY ', URLHAUS_LIST_URL: 'https://lists.example/{key}/online.csv', URLHAUS_REFRESH_MINUTES: '5' })).toEqual({
      authKey: 'KEY',
      listUrl: 'https://lists.example/{key}/online.csv',
      refreshMinutes: 5,
    });
    // URLhaus asks not to be asked more often than every 5 minutes.
    expect(() => load({ URLHAUS_REFRESH_MINUTES: '4' })).toThrow();
    expect(() => load({ URLHAUS_LIST_URL: 'recent.csv' })).toThrow(/URLHAUS_LIST_URL is an http or https URL/);
  });
});

describe('TRUST_OPTIONAL_PLUGINS', () => {
  const load = (env: Record<string, string>) => loadConfig({}, env).trust.optionalPlugins;

  it('names the optional plugins the server runs: none unless set, and urlhaus only with its Auth-Key', () => {
    expect(load({})).toEqual([]);
    expect(load({ TRUST_OPTIONAL_PLUGINS: '' })).toEqual([]);
    expect(load({ TRUST_OPTIONAL_PLUGINS: 'new_accounts' })).toEqual(['new_accounts']);
    expect(load({ TRUST_OPTIONAL_PLUGINS: ' urlhaus, new_accounts  urlhaus ', URLHAUS_AUTH_KEY: 'KEY' })).toEqual(['urlhaus', 'new_accounts']);
    expect(loadConfig({ trust: { optionalPlugins: ['urlhaus'] }, urlhaus: { authKey: 'KEY' } }, {}).trust.optionalPlugins).toEqual(['urlhaus']);
    // A server that turns urlhaus on without a key doesn't start, rather than run it with nothing to check links with.
    expect(() => load({ TRUST_OPTIONAL_PLUGINS: 'urlhaus' })).toThrow(/TRUST_OPTIONAL_PLUGINS turns on urlhaus, which needs URLHAUS_AUTH_KEY/);
    // The key alone turns nothing on.
    expect(load({ URLHAUS_AUTH_KEY: 'KEY' })).toEqual([]);
  });
});

for (const target of TARGETS) {
  describe(`links that spread malware (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { store, storeText } = requests(() => ctx);
    const POST_REFUSED = { error: "the post has a link that is known to spread malware, so it wasn't published" };

    it('are refused as a link post, in a text, in a caption and in a comment, on a new post and on an update', async () => {
      const server = urlhausServer();
      ctx = await createTestContext(target, { urlhaus: { authKey: 'KEY' }, trustPlugins: [...(await loadTrustPlugins()), { name: 'urlhaus', ...urlhaus(server.fetcher) }] });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const link = (url: string, extra: Record<string, unknown> = {}) => store(alice, { type: 'link', url, tags: ['news'], ...extra });

      const bad = await link('http://malware.example/files/setup.exe');
      expect([bad.statusCode, bad.json()]).toEqual([422, POST_REFUSED]);
      const written = await storeText(alice, 'The installer is at malware.example/files/setup.exe #news');
      expect([written.statusCode, written.json()]).toEqual([422, POST_REFUSED]);
      // As the server's formatting writes a link, with the text going on right after it.
      for (const text of ['**Get** [the installer](http://malware.example/files/setup.exe) #news', '[the installer](http://malware.example/files/setup.exe)now #news', '> http://malware.example/files/setup.exe**!** #news', '[x](http://root.example)now #news', '[http://root.example](http://root.example)now #news']) {
        const formatted = await storeText(alice, text);
        expect([formatted.statusCode, formatted.json()], text).toEqual([422, POST_REFUSED]);
      }
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);

      // A link that isn't listed is published, and can't be made a listed one.
      const fine = await link('https://news.example/story');
      expect(fine.statusCode, fine.body).toBe(201);
      const { contentId } = fine.json();
      const update = await link('https://malware.example/files/setup.exe', { contentId });
      expect([update.statusCode, update.json()]).toEqual([422, POST_REFUSED]);
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}` })).json()).toMatchObject({ preview: { kind: 'link', url: 'https://news.example/story' } });

      // A comment's links are a post's.
      const open = await storeText(alice, 'What do you think? #news', { comments: true });
      expect(open.statusCode, open.body).toBe(201);
      const comment = (text: string) => ctx.app.inject({ method: 'POST', url: `/content/${open.json().contentId}/comments`, headers: as(bob), payload: { text } });
      const reply = await comment('Try [this](http://malware.example/files/setup.exe)');
      expect([reply.statusCode, reply.json()]).toEqual([422, { error: "the comment has a link that is known to spread malware, so it wasn't published" }]);
      expect((await comment('Try https://news.example/story')).statusCode).toBe(201);
      expect(server.requests).toHaveLength(1);
    });

    it('are checked only on a server that turns the plugin on, which then downloads the list itself', async () => {
      const listed = { type: 'link', url: 'http://malware.example/files/setup.exe', tags: ['news'] };
      // Off, as it is unless the server names it: a listed link is a link like any other.
      ctx = await createTestContext(target);
      expect((await store(await ctx.register('alice'), listed)).statusCode).toBe(201);
      await ctx.close();

      // On: the server's own plugin, as it loads it, asking what stands in for URLhaus here.
      const asked: string[] = [];
      const http = createServer((req, res) => {
        asked.push(`${req.url} ${req.headers['auth-key']}`);
        res.end(CSV);
      });
      await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = http.address() as AddressInfo;
        ctx = await createTestContext(target, { trust: { optionalPlugins: ['urlhaus'] }, urlhaus: { authKey: 'KEY', listUrl: `http://127.0.0.1:${port}/{key}/recent.csv` } });
        const bob = await ctx.register('bob');
        const bad = await store(bob, listed);
        expect([bad.statusCode, bad.json()]).toEqual([422, POST_REFUSED]);
        expect((await store(bob, { ...listed, url: 'https://news.example/story' })).statusCode).toBe(201);
        // The process has one copy of the list, so only its first server of this file downloads it.
        expect(asked.length).toBeLessThanOrEqual(1);
        expect(asked.every((request) => request === '/KEY/recent.csv KEY')).toBe(true);
      } finally {
        http.closeAllConnections();
        await new Promise((resolve) => http.close(resolve));
      }
    });

    it('have a post wait in the moderation queue on a server that deletes none on arrival', async () => {
      ctx = await createTestContext(target, { urlhaus: { authKey: 'KEY' }, trust: { deleteBelow: 0 }, trustPlugins: [{ name: 'urlhaus', ...urlhaus(urlhausServer().fetcher) }] });
      const alice = await ctx.register('alice');
      const held = await store(alice, { type: 'link', url: 'http://malware.example/files/setup.exe', tags: ['news'] });
      expect(held.statusCode, held.body).toBe(202);
      expect(await ctx.db.selectFrom('moderation_queue').select(['content_id', 'trust_score']).execute()).toEqual([{ content_id: held.json().contentId, trust_score: 0 }]);
    });
  });
}
