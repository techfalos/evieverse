import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { as, BASE_ENV, createTestContext, JPEG, multipart, PNG, requests, TARGETS, type FilePart, type TestContext, type User } from './helpers.js';

/** An image the detector that stands in here finds a watermark in: any PNG. */
const made: FilePart = { name: 'holiday.png', type: 'image/png', data: PNG };
/** One it finds none in: any JPEG. */
const photo: FilePart = { name: 'photo.jpg', type: 'image/jpeg', data: JPEG };

/** What a check answers, as OpenAI's Content Provenance API writes it: each kind of mark as a result of its own. */
const found = (watermark: boolean) => ({
  object: 'content_provenance_check',
  created_at: 1778000000,
  results: [
    { type: 'c2pa', outcome: 'not_detected', validation_state: 'not_present', issuer: null, model: null, generated_at: null },
    { type: 'synthid', outcome: watermark ? 'detected' : 'not_detected', model: null, generated_at: null },
  ],
});

/**
 * What stands in for the detector: a server on this machine that finds a watermark in every PNG it
 * is sent and in nothing else, and keeps what it was asked. `says` has it answer every check
 * with that instead. The plugin is the server's own (compactor/crates/trust/src/plugins/synthid),
 * whose tests cover what it sends and how it reads an answer: here is what a server does with it.
 */
async function detector() {
  const asked: { url?: string; authorization?: string; filename?: string; type?: string }[] = [];
  const state: { says?: { status: number; body: unknown } } = {};
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const form = Buffer.concat(chunks).toString('latin1');
      const type = /\r\nContent-Type: ([^\r]+)\r\n/.exec(form)?.[1];
      asked.push({ url: req.url, authorization: req.headers.authorization, filename: /name="file"; filename="([^"]*)"/.exec(form)?.[1], type });
      const { status, body } = state.says ?? { status: 200, body: found(type === 'image/png') };
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    asked,
    state,
    /** The settings of a server that has this detector check its images. */
    settings: (synthid: Record<string, unknown> = {}, trust: Record<string, unknown> = {}) => ({
      trust: { ...trust, optionalPlugins: ['synthid'] },
      synthid: { apiKey: 'KEY', url: `http://127.0.0.1:${port}/v1/content_provenance_checks`, ...synthid },
    }),
    close: async () => {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

describe('SYNTHID_API_KEY, SYNTHID_URL, SYNTHID_ACTION and SYNTHID_UNCHECKED', () => {
  const load = (env: Record<string, string>) => loadConfig({}, { ...BASE_ENV, ...env }).synthid;

  it("are no key, OpenAI's detector, and holding for a person, unless set", () => {
    expect(load({})).toEqual({ url: 'https://api.openai.com/v1/content_provenance_checks', action: 'hold', unchecked: 'hold', allowDisclosed: false });
    expect(load({ SYNTHID_API_KEY: '' }).apiKey).toBeUndefined();
    expect(load({ SYNTHID_API_KEY: ' KEY ', SYNTHID_URL: ' https://detector.example/check ', SYNTHID_ACTION: 'refuse', SYNTHID_UNCHECKED: 'allow', SYNTHID_ALLOW_DISCLOSED: 'true' })).toEqual({
      apiKey: 'KEY',
      url: 'https://detector.example/check',
      action: 'refuse',
      unchecked: 'allow',
      allowDisclosed: true,
    });
    expect(() => load({ SYNTHID_URL: 'detector.example/check' })).toThrow(/SYNTHID_URL is an http or https URL/);
    for (const [name, value] of [['SYNTHID_ACTION', 'delete'], ['SYNTHID_ACTION', 'allow'], ['SYNTHID_UNCHECKED', 'refuse'], ['SYNTHID_UNCHECKED', 'fail']] as const) {
      expect(() => load({ [name]: value }), `${name}=${value}`).toThrow();
    }
  });

  it('are needed by a server that turns the plugin on, and turn nothing on themselves', () => {
    const plugins = (env: Record<string, string>) => loadConfig({}, { ...BASE_ENV, ...env }).trust.optionalPlugins;
    expect(plugins({ TRUST_OPTIONAL_PLUGINS: 'synthid', SYNTHID_API_KEY: 'KEY' })).toEqual(['synthid']);
    // A server that turns synthid on without a key doesn't start, rather than run it with nothing to ask the detector with.
    expect(() => plugins({ TRUST_OPTIONAL_PLUGINS: 'synthid' })).toThrow(/TRUST_OPTIONAL_PLUGINS turns on synthid, which needs SYNTHID_API_KEY/);
    expect(plugins({ SYNTHID_API_KEY: 'KEY' })).toEqual([]);
  });
});

for (const target of TARGETS) {
  describe(`images with a SynthID watermark (${target.name})`, () => {
    let ctx: TestContext;
    let server: Awaited<ReturnType<typeof detector>> | undefined;
    afterEach(async () => {
      await ctx.close();
      await server?.close();
      server = undefined;
    });

    const { storeText } = requests(() => ctx);
    const POST_MADE = { error: "an image of the post carries a watermark that says it was made with AI, so it wasn't published" };
    const answer = (res: LightMyRequestResponse) => [res.statusCode, res.json()];
    /** An image post sent as a form, with its image or images as the form's files. */
    const sendImages = (user: User, files: FilePart[], fields: Record<string, string> = {}) => {
      const form = multipart({ ...user, type: 'image', tags: 'pics', ...fields }, files);
      return ctx.app.inject({ method: 'POST', url: '/store', payload: form.payload, headers: form.headers });
    };
    /** A comment on a post, sent with an image. */
    const comment = (user: User, contentId: string, file: FilePart, fields: Record<string, string> = {}) => {
      const { payload, headers } = multipart({ text: 'Look', ...fields }, file);
      return ctx.app.inject({ method: 'POST', url: `/content/${contentId}/comments`, payload, headers: { ...headers, ...as(user) } });
    };
    const avatar = (user: User, file: FilePart) => {
      const { payload, headers } = multipart({}, file);
      return ctx.app.inject({ method: 'PUT', url: `/users/${user.userId}/avatar`, payload, headers: { ...headers, ...as(user) } });
    };
    const queued = () => ctx.db.selectFrom('moderation_queue').select(['content_id', 'trust_score']).execute();

    it('have a post or a comment wait for a person, and an avatar refused, and leave every other as it was', async () => {
      server = await detector();
      ctx = await createTestContext(target, server.settings());
      expect(ctx.trust.plugins).toEqual(['blocked_words', 'synthid']);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');

      // Just under the 75 a post is published from: it is stored, and waits in the moderation queue.
      const held = await sendImages(alice, [made]);
      expect(held.statusCode, held.body).toBe(202);
      expect(held.json()).toMatchObject({ status: 'pending_review' });
      expect(await queued()).toEqual([{ content_id: held.json().contentId, trust_score: 74 }]);
      // The image is sent with the server's key, and not under the name its sender gave it.
      expect(server.asked).toEqual([{ url: '/v1/content_provenance_checks', authorization: 'Bearer KEY', filename: 'image.png', type: 'image/png' }]);

      // An image without one is published, and one image of several with one holds them all.
      const fine = await sendImages(alice, [photo]);
      expect(fine.statusCode, fine.body).toBe(201);
      const album = await sendImages(alice, [photo, made]);
      expect(album.statusCode, album.body).toBe(202);
      expect(await queued()).toHaveLength(2);
      // What has no image is asked nothing about.
      const before = server.asked.length;
      const open = await storeText(alice, 'What do you think? #news', { comments: true });
      expect(open.statusCode, open.body).toBe(201);
      expect(server.asked).toHaveLength(before);

      // A comment's image is a post's.
      const { contentId } = open.json();
      const waits = await comment(bob, contentId, made);
      expect(waits.statusCode, waits.body).toBe(202);
      expect(await ctx.db.selectFrom('comment_queue').select(['comment_id', 'trust_score']).execute()).toEqual([{ comment_id: waits.json().commentId, trust_score: 74 }]);
      expect((await comment(bob, contentId, photo)).statusCode).toBe(201);

      // A profile has no queue to wait in: the avatar is refused, and its sender is told why.
      expect(answer(await avatar(alice, made))).toEqual([422, { error: "the image carries a watermark that says it was made with AI, so it wasn't saved" }]);
      expect((await ctx.app.inject({ method: 'GET', url: `/users/${alice.userId}` })).json().avatarUrl).toBeNull();
      const set = await avatar(alice, photo);
      expect(set.statusCode, set.body).toBe(200);
    });

    it('are refused on a server that says so, and on one that has no queue to hold them in', async () => {
      server = await detector();
      ctx = await createTestContext(target, server.settings({ action: 'refuse' }));
      const alice = await ctx.register('alice');
      expect(answer(await sendImages(alice, [made]))).toEqual([422, POST_MADE]);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toEqual([]);
      const fine = await sendImages(alice, [photo], { comments: 'true' });
      expect(fine.statusCode, fine.body).toBe(201);
      const refused = await comment(alice, fine.json().contentId, made);
      expect(answer(refused)).toEqual([422, { error: "the comment's image carries a watermark that says it was made with AI, so it wasn't published" }]);
      // An update that adds such an image is refused too, and the post stays as it was, with its one image.
      const { contentId } = fine.json();
      expect(answer(await sendImages(alice, [photo, made], { contentId }))).toEqual([422, POST_MADE]);
      expect((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}` })).json().images).toHaveLength(1);
      expect(await queued()).toEqual([]);
      await ctx.close();

      // Held, on a server whose two thresholds are the same: what isn't published is refused.
      ctx = await createTestContext(target, server.settings({}, { deleteBelow: 75 }));
      expect(answer(await sendImages(await ctx.register('alice'), [made]))).toEqual([422, POST_MADE]);
    });

    it('hold what the detector could not check too, unless the server lets it through', async () => {
      server = await detector();
      server.state.says = { status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'Too many requests' } } };
      ctx = await createTestContext(target, server.settings({ action: 'refuse' }));
      const alice = await ctx.register('alice');
      // Whatever becomes of a watermark: nobody knows that the image has one.
      const held = await sendImages(alice, [photo]);
      expect(held.statusCode, held.body).toBe(202);
      expect(await queued()).toEqual([{ content_id: held.json().contentId, trust_score: 74 }]);
      expect(answer(await avatar(alice, photo))).toEqual([422, { error: "the image couldn't be checked for a watermark that says it was made with AI, so it wasn't saved" }]);
      expect((await storeText(alice, 'No image at all. #news')).statusCode).toBe(201);
      await ctx.close();

      // Let through: an image is published while the detector is down, and checked again once it is up.
      ctx = await createTestContext(target, server.settings({ unchecked: 'allow' }));
      const bob = await ctx.register('bob');
      expect((await sendImages(bob, [made])).statusCode).toBe(201);
      server.state.says = undefined;
      expect((await sendImages(bob, [made])).statusCode).toBe(202);
    });

    it('are left as they are with what its sender declares as created with AI, on a server that says so', async () => {
      server = await detector();
      ctx = await createTestContext(target, server.settings({ allowDisclosed: true }));
      const alice = await ctx.register('alice');

      // Declared: the post is published, and so is a comment, and their images are sent nowhere.
      const declared = await sendImages(alice, [made], { aiGenerated: 'true', comments: 'true' });
      expect(declared.statusCode, declared.body).toBe(201);
      const { contentId } = declared.json();
      const said = await comment(alice, contentId, made, { aiGenerated: 'true' });
      expect(said.statusCode, said.body).toBe(201);
      expect(server.asked).toEqual([]);
      expect(await queued()).toEqual([]);

      // Not declared: checked and held, as on any server.
      const held = await sendImages(alice, [made]);
      expect(held.statusCode, held.body).toBe(202);
      expect((await comment(alice, contentId, made)).statusCode).toBe(202);
      expect(server.asked).toHaveLength(2);
      // An update that takes the declaration back is checked as a post without one is.
      const undeclared = await sendImages(alice, [made], { contentId, aiGenerated: 'false' });
      expect(undeclared.statusCode, undeclared.body).toBe(202);
      expect(server.asked).toHaveLength(3);
      // An avatar comes with no declaration to go by.
      expect(answer(await avatar(alice, made))).toEqual([422, { error: "the image carries a watermark that says it was made with AI, so it wasn't saved" }]);
      await ctx.close();

      // Unless the server says so, a watermark counts the same with the declaration.
      ctx = await createTestContext(target, server.settings());
      const again = await sendImages(await ctx.register('alice'), [made], { aiGenerated: 'true' });
      expect(again.statusCode, again.body).toBe(202);
    });

    it('are checked only on a server that turns the plugin on', async () => {
      server = await detector();
      // Off, as it is unless the server names it: the image is an image like any other, and is sent nowhere.
      ctx = await createTestContext(target, { synthid: server.settings().synthid });
      expect(ctx.trust.plugins).toEqual(['blocked_words']);
      const posted = await sendImages(await ctx.register('alice'), [made]);
      expect(posted.statusCode, posted.body).toBe(201);
      expect(server.asked).toEqual([]);
    });
  });
}
