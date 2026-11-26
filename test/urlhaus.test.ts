import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { as, BASE_ENV, createTestContext, requests, TARGETS, type TestContext } from './helpers.js';

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

/**
 * What stands in for URLhaus: a server on this machine that answers every download with `body` and keeps the requests it got.
 * The plugin is the server's own (compactor/crates/trust/src/plugins/urlhaus), whose tests cover how it reads a list and a text.
 */
async function urlhausServer(body = CSV) {
  const requests: string[] = [];
  const http = createServer((req, res) => {
    requests.push(`${req.url} ${req.headers['auth-key']}`);
    res.end(body);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    requests,
    /** The settings of a server that checks links with this list. */
    settings: (trust: Record<string, unknown> = {}) => ({ trust: { ...trust, optionalPlugins: ['urlhaus'] }, urlhaus: { authKey: 'KEY', listUrl: `http://127.0.0.1:${port}/{key}/recent.csv` } }),
    close: async () => {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

describe('URLHAUS_AUTH_KEY, URLHAUS_LIST_URL and URLHAUS_REFRESH_MINUTES', () => {
  const load = (env: Record<string, string>) => loadConfig({}, { ...BASE_ENV, ...env }).urlhaus;

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
  const load = (env: Record<string, string>) => loadConfig({}, { ...BASE_ENV, ...env }).trust.optionalPlugins;

  it('names the optional plugins the server runs: none unless set, and urlhaus only with its Auth-Key', () => {
    expect(load({})).toEqual([]);
    expect(load({ TRUST_OPTIONAL_PLUGINS: '' })).toEqual([]);
    expect(load({ TRUST_OPTIONAL_PLUGINS: 'new_accounts' })).toEqual(['new_accounts']);
    expect(load({ TRUST_OPTIONAL_PLUGINS: ' urlhaus, new_accounts  urlhaus ', URLHAUS_AUTH_KEY: 'KEY' })).toEqual(['urlhaus', 'new_accounts']);
    expect(loadConfig({ trust: { optionalPlugins: ['urlhaus'] }, urlhaus: { authKey: 'KEY' } }, BASE_ENV).trust.optionalPlugins).toEqual(['urlhaus']);
    // A server that turns urlhaus on without a key doesn't start, rather than run it with nothing to check links with.
    expect(() => load({ TRUST_OPTIONAL_PLUGINS: 'urlhaus' })).toThrow(/TRUST_OPTIONAL_PLUGINS turns on urlhaus, which needs URLHAUS_AUTH_KEY/);
    // The key alone turns nothing on.
    expect(load({ URLHAUS_AUTH_KEY: 'KEY' })).toEqual([]);
  });
});

for (const target of TARGETS) {
  describe(`links that spread malware (${target.name})`, () => {
    let ctx: TestContext;
    let server: Awaited<ReturnType<typeof urlhausServer>> | undefined;
    afterEach(async () => {
      await ctx.close();
      await server?.close();
      server = undefined;
    });

    const { store, storeText } = requests(() => ctx);
    const POST_REFUSED = { error: "the post has a link that is known to spread malware, so it wasn't published" };

    it('are refused as a link post, in a text, in a caption and in a comment, on a new post and on an update', async () => {
      server = await urlhausServer();
      ctx = await createTestContext(target, server.settings());
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
      expect(server.requests).toEqual(['/KEY/recent.csv KEY']);
    });

    it('are checked only on a server that turns the plugin on, which then downloads the list itself', async () => {
      const listed = { type: 'link', url: 'http://malware.example/files/setup.exe', tags: ['news'] };
      // Off, as it is unless the server names it: a listed link is a link like any other.
      ctx = await createTestContext(target);
      expect((await store(await ctx.register('alice'), listed)).statusCode).toBe(201);
      await ctx.close();

      // On: it downloads the list when the first post asks for it, and once for the posts after.
      server = await urlhausServer();
      ctx = await createTestContext(target, server.settings());
      expect(ctx.trust.plugins).toContain('urlhaus');
      const bob = await ctx.register('bob');
      expect(server.requests).toEqual([]);
      const bad = await store(bob, listed);
      expect([bad.statusCode, bad.json()]).toEqual([422, POST_REFUSED]);
      expect((await store(bob, { ...listed, url: 'https://news.example/story' })).statusCode).toBe(201);
      expect(server.requests).toEqual(['/KEY/recent.csv KEY']);
    });

    it('fail a post with a link while the server has no list, and no other', async () => {
      server = await urlhausServer('<html>Maintenance</html>');
      ctx = await createTestContext(target, server.settings());
      const alice = await ctx.register('alice');
      const failed = await store(alice, { type: 'link', url: 'https://news.example/story', tags: ['news'] });
      expect(failed.statusCode, failed.body).toBe(500);
      expect(failed.body).not.toContain('KEY');
      const plain = await storeText(alice, 'No link at all. #news');
      expect(plain.statusCode, plain.body).toBe(201);
    });

    it('have a post wait in the moderation queue on a server that deletes none on arrival', async () => {
      server = await urlhausServer();
      ctx = await createTestContext(target, server.settings({ deleteBelow: 0 }));
      const alice = await ctx.register('alice');
      const held = await store(alice, { type: 'link', url: 'http://malware.example/files/setup.exe', tags: ['news'] });
      expect(held.statusCode, held.body).toBe(202);
      expect(await ctx.db.selectFrom('moderation_queue').select(['content_id', 'trust_score']).execute()).toEqual([{ content_id: held.json().contentId, trust_score: 0 }]);
    });
  });
}
