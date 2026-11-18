import type { LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { loadTrustPlugins } from '../src/moderation/trust.js';
import type { TrustPlugin, TrustPost } from '../src/moderation/trust.types.js';
import { AVATAR_SIZE, MAX_AVATAR_BYTES, MAX_BIO_CHARS, MAX_PINNED_POSTS, MAX_PROFILE_LINKS } from '../src/profile.js';
import { as, createTestContext, JPEG, multipart, PNG, requests, TARGETS, type FeedItem, type FilePart, type TestContext, type User } from './helpers.js';

const NO_USER = '00000000-0000-4000-8000-000000000000';
const BANNED = "your account is banned: you can take your bio, your links and your avatar away, and can't set them";
const NOT_TRUSTED = "this server doesn't trust this enough to show it on a profile, so it wasn't saved";
const BLOCKED_WORD = "it contains a word or phrase this server doesn't allow, so it wasn't saved";
const RED = { r: 255, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };

type Profile = { userId: string; username: string; createdAt: string; banned: boolean; bio: string | null; links: string[]; avatarUrl: string | null; pinnedContentIds: string[] };
type Posts = { userId: string; banned: boolean; pinned?: FeedItem[]; posts: FeedItem[]; nextCursor: string | null };

/** A picture twice as wide as it is high, 800 by 400: its left half red, its right half blue. */
const wide = () =>
  sharp({ create: { width: 800, height: 400, channels: 3, background: RED } }).composite([{ input: { create: { width: 400, height: 400, channels: 3, background: BLUE } }, left: 400, top: 0 }]);
/** What an image is, as a reader of it finds: its format and its size. */
const shape = async (bytes: Buffer) => {
  const { format, width, height } = await sharp(bytes).metadata();
  return [format, width, height];
};
/** Which of the two colours of `wide` an image has at a point, however an encoding shifted it. */
const colourAt = async (bytes: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return data[at]! > 200 && data[at + 2]! < 60 ? 'red' : data[at]! < 60 && data[at + 2]! > 200 ? 'blue' : `rgb(${data[at]}, ${data[at + 1]}, ${data[at + 2]})`;
};

for (const target of TARGETS) {
  describe(`profiles (${target.name})`, () => {
    let ctx: TestContext;
    afterEach(() => ctx.close());

    const { post, like } = requests(() => ctx);
    const req = (u: User | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: u ? as(u) : {}, ...(payload && { payload }) });
    const ok = (res: LightMyRequestResponse, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    const refused = async (res: Promise<LightMyRequestResponse>) => {
      const r = await res;
      return [r.statusCode, r.json().error];
    };
    const now = () => new Date(ctx.clock.now).toISOString();
    const profile = async (userId: string): Promise<Profile> => ok(await req(null, 'GET', `/users/${userId}`));
    const update = (u: User, payload: Record<string, unknown>, userId = u.userId) => req(u, 'PATCH', `/users/${userId}`, payload);
    /** PUT /users/:userId/avatar as `u`, with the image as a file part. */
    const upload = (u: User | null, file: Partial<FilePart> = {}, userId = u?.userId ?? NO_USER) => {
      const body = multipart({}, { name: 'me.png', type: 'image/png', data: PNG, ...file });
      return ctx.app.inject({ method: 'PUT', url: `/users/${userId}/avatar`, payload: body.payload, headers: { ...body.headers, ...(u && as(u)) } });
    };
    /** What a profile's `avatarUrl` answers, read as anyone reads it. */
    const avatar = (url: string) => ctx.app.inject({ method: 'GET', url });
    const avatarId = (url: string | null) => new URL(url!, 'http://server.example').searchParams.get('v')!;
    const stored = async (userId: string, id: string) => (await ctx.content.statIfThere({ userId, avatar: id })) !== null;
    const posts = async (userId: string, query = ''): Promise<Posts> => ok(await req(null, 'GET', `/users/${userId}/posts${query}`));
    const ids = (page: Posts) => page.posts.map((p) => p.contentId);
    const pin = (u: User | null, contentId: string, userId = u?.userId ?? NO_USER) => req(u, 'PUT', `/users/${userId}/pinned/${contentId}`);
    const unpin = (u: User | null, contentId: string, userId = u?.userId ?? NO_USER) => req(u, 'DELETE', `/users/${userId}/pinned/${contentId}`);
    /** Whom a post read by its id is credited to. */
    const creditOf = async (contentId: string) => ok(await req(null, 'GET', `/content/${contentId}`)).publisher;
    const admin = async (name = 'root') => {
      const u = await ctx.register(name);
      await setAdmin(ctx.db, name, true);
      return u;
    };

    it('has a creation date, and a bio and links that only the user sets, changes and takes away', async () => {
      ctx = await createTestContext(target);
      const registeredAt = now();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      ctx.clock.now += 60_000;

      // A new account says nothing of itself, but when it was created.
      expect(await profile(alice.userId)).toMatchObject({ createdAt: registeredAt, banned: false, bio: null, links: [], avatarUrl: null, pinnedContentIds: [] });

      // Both at once. The bio is stored as it was written, without the spaces around it; each link as a URL is written, in the order given, once.
      const set = ok(await update(alice, { bio: '  Reporter in **Mumbai**.\nOpinions my own.  ', links: ['https://Example.com/alice', 'http://social.example/@alice', 'https://example.com/alice'] }));
      expect(set).toEqual({
        userId: alice.userId,
        username: 'alice',
        language: 'en',
        messages: true,
        showFollowing: false,
        showFollowers: false,
        bio: 'Reporter in **Mumbai**.\nOpinions my own.',
        links: ['https://example.com/alice', 'http://social.example/@alice'],
        avatarUrl: null,
      });
      // Anyone reads them, with the rest of the profile, and the creation date is as it was.
      expect(await profile(alice.userId)).toMatchObject({ createdAt: registeredAt, bio: 'Reporter in **Mumbai**.\nOpinions my own.', links: ['https://example.com/alice', 'http://social.example/@alice'] });
      expect(await profile(bob.userId)).toMatchObject({ bio: null, links: [] });

      // Each alone leaves the other as it is, and so does a change of something else. The links sent are all of them.
      expect(ok(await update(alice, { links: ['https://blog.example/'] }))).toMatchObject({ bio: 'Reporter in **Mumbai**.\nOpinions my own.', links: ['https://blog.example/'] });
      expect(ok(await update(alice, { bio: 'Editor.' }))).toMatchObject({ bio: 'Editor.', links: ['https://blog.example/'] });
      expect(ok(await update(alice, { messages: false }))).toMatchObject({ messages: false, bio: 'Editor.', links: ['https://blog.example/'] });
      // Nothing of a profile is part of the user's credit, so nothing tells the compactor to write that again.
      expect(Number((await ctx.db.selectFrom('users').select('updated_at').where('id', '=', alice.userId).executeTakeFirstOrThrow()).updated_at)).toBe(Date.parse(registeredAt));

      // Taken away: by null, by an empty string, by an empty list.
      expect(ok(await update(alice, { bio: '' }))).toMatchObject({ bio: null, links: ['https://blog.example/'] });
      expect(ok(await update(alice, { bio: 'Back.', links: [] }))).toMatchObject({ bio: 'Back.', links: [] });
      expect(ok(await update(alice, { bio: null, links: null }))).toMatchObject({ bio: null, links: [] });
      expect(await profile(alice.userId)).toMatchObject({ bio: null, links: [] });

      // Only the user's own, and only what a bio and links can be.
      expect((await update(bob, { bio: 'Not me' }, alice.userId)).statusCode).toBe(403);
      expect((await req(null, 'PATCH', `/users/${alice.userId}`, { bio: 'Nobody' })).statusCode).toBe(401);
      expect((await update(alice, { bio: 'x'.repeat(MAX_BIO_CHARS + 1) })).statusCode).toBe(400);
      expect(ok(await update(alice, { bio: 'x'.repeat(MAX_BIO_CHARS) })).bio).toHaveLength(MAX_BIO_CHARS);
      for (const links of [['not a link'], ['ftp://files.example/alice'], ['javascript:alert(1)'], 'https://example.com/', Array.from({ length: MAX_PROFILE_LINKS + 1 }, (_, i) => `https://example.com/${i}`)]) {
        expect((await update(alice, { links })).statusCode, JSON.stringify(links)).toBe(400);
      }
      expect(ok(await update(alice, { links: Array.from({ length: MAX_PROFILE_LINKS }, (_, i) => `https://example.com/${i}`) })).links).toHaveLength(MAX_PROFILE_LINKS);
      // A request that is refused changes nothing, whatever else it named.
      expect((await update(alice, { username: 'alicia', links: ['nope'] })).statusCode).toBe(400);
      expect(await profile(alice.userId)).toMatchObject({ username: 'alice', bio: 'x'.repeat(MAX_BIO_CHARS) });
    });

    it('sends a bio, links and an avatar through the trust plugins, and saves only what they trust', async () => {
      const seen: TrustPost[] = [];
      const watching: TrustPlugin = { name: 'watching', assess: (sent) => void seen.push(sent) };
      /** Takes off 30, which leaves a post waiting in the moderation queue. */
      const wary: TrustPlugin = { name: 'wary', assess: ({ texts }) => (texts.some((text) => text.includes('FREE')) ? { reduce: 30 } : null) };
      ctx = await createTestContext(target, { trustPlugins: [...(await loadTrustPlugins()), wary, watching] });
      const root = await admin();
      const alice = await ctx.register('alice');
      ok(await req(root, 'POST', '/moderation/blocked-words', { words: ['spam'] }));

      // What a plugin is told: that it is a profile, and what there is of it to read, the bio as its readers read it.
      ok(await update(alice, { bio: 'Read [my blog](https://blog.example/me) daily', links: ['https://social.example/alice'] }));
      expect(seen).toEqual([{ userId: alice.userId, profile: true, tags: [], texts: ['Read my blog https://blog.example/me daily', 'https://social.example/alice'] }]);
      // Only what is set is sent to them: nothing, for what is taken away or isn't a profile's.
      seen.length = 0;
      ok(await update(alice, { bio: null, links: [] }));
      ok(await update(alice, { messages: false }));
      expect(seen).toEqual([]);

      // A blocked word of the server's, in the bio or in a link, is refused, and nothing of the request is saved.
      expect(await refused(update(alice, { bio: 'Buy my spam', username: 'alicia' }))).toEqual([422, BLOCKED_WORD]);
      expect(await refused(update(alice, { links: ['https://spam.example/'] }))).toEqual([422, BLOCKED_WORD]);
      // A profile has no queue to wait in: what a post would wait for is refused too.
      expect(await refused(update(alice, { bio: 'FREE things' }))).toEqual([422, NOT_TRUSTED]);
      expect(await profile(alice.userId)).toMatchObject({ username: 'alice', bio: null, links: [] });

      // An avatar is given to them as a post's image is, with its name: the image as it was sent, not the avatar made of it.
      seen.length = 0;
      ok(await upload(alice, { name: 'me.png' }));
      expect(seen).toEqual([{ userId: alice.userId, profile: true, tags: [], texts: ['me.png'], images: [expect.objectContaining({ mimeType: 'image/png', filename: 'me.png' })] }]);
      const before = (await profile(alice.userId)).avatarUrl;
      expect(await refused(upload(alice, { name: 'spam.png' }))).toEqual([422, BLOCKED_WORD]);
      expect(await refused(upload(alice, { name: 'FREE.png' }))).toEqual([422, NOT_TRUSTED]);
      // The avatar she had is the one she has, and the only one the store holds of hers.
      expect((await profile(alice.userId)).avatarUrl).toBe(before);
      expect(await stored(alice.userId, avatarId(before))).toBe(true);
    });

    it('shows nothing of the profile of a banned user, who sets nothing on it and can take theirs away', async () => {
      ctx = await createTestContext(target);
      const root = await admin();
      const alice = await ctx.register('alice');
      ok(await update(alice, { bio: 'Hello', links: ['https://example.com/alice'] }));
      const { avatarUrl } = ok(await upload(alice));
      const first = await post(alice, 'First #news');
      ctx.clock.now += 1000;
      const second = await post(alice, 'Second #news');
      ok(await pin(alice, first), 201);
      await ctx.compact();
      const shown = { banned: false, bio: 'Hello', links: ['https://example.com/alice'], avatarUrl, pinnedContentIds: [first] };
      expect(await profile(alice.userId)).toMatchObject(shown);
      expect(await creditOf(first)).toEqual({ userId: alice.userId, username: 'alice', avatarUrl });
      const { nextCursor } = await posts(alice.userId, '?limit=1');
      expect(nextCursor).not.toBeNull();

      ok(await req(root, 'PUT', `/banned/${alice.userId}`), 201);
      // The profile says she is banned, and nothing she put on it: not to anyone, with or without a key.
      const hidden = { userId: alice.userId, username: 'alice', banned: true, bio: null, links: [], avatarUrl: null, pinnedContentIds: [] };
      expect(await profile(alice.userId)).toMatchObject(hidden);
      expect(ok(await req(alice, 'GET', `/users/${alice.userId}`))).toMatchObject(hidden);
      expect(ok(await req(root, 'GET', `/users/${alice.userId}`))).toMatchObject(hidden);
      // Nor her avatar, by either of its addresses, and it isn't on her post's credit.
      expect(await refused(avatar(avatarUrl))).toEqual([404, "this user is banned, so their avatar isn't shown"]);
      expect(await refused(avatar(`/users/${alice.userId}/avatar`))).toEqual([404, "this user is banned, so their avatar isn't shown"]);
      expect(await creditOf(first)).toEqual({ userId: alice.userId, username: 'alice' });
      // Her profile lists none of her posts, pinned or not, on any page. The post itself is where it was.
      expect(await posts(alice.userId)).toEqual({ userId: alice.userId, banned: true, pinned: [], posts: [], nextCursor: null });
      expect(await posts(alice.userId, `?limit=1&cursor=${nextCursor}`)).toEqual({ userId: alice.userId, banned: true, posts: [], nextCursor: null });
      expect(ok(await req(null, 'GET', `/content/${first}`))).toMatchObject({ contentId: first, text: 'First #news' });

      // She sets nothing on it.
      expect(await refused(update(alice, { bio: 'Still here' }))).toEqual([403, BANNED]);
      expect(await refused(update(alice, { links: ['https://example.com/other'] }))).toEqual([403, BANNED]);
      expect(await refused(upload(alice))).toEqual([403, BANNED]);
      // The rest of her account is hers to change, and she is given her own profile as it is.
      expect(ok(await update(alice, { messages: false }))).toMatchObject({ messages: false, bio: 'Hello', links: ['https://example.com/alice'], avatarUrl });

      // It is all still hers, and is shown again once the ban ends.
      expect(ok(await req(root, 'DELETE', `/banned/${alice.userId}`))).toEqual({ userId: alice.userId, wasBanned: true });
      expect(await profile(alice.userId)).toMatchObject(shown);
      expect((await avatar(avatarUrl)).statusCode).toBe(200);
      expect(await creditOf(first)).toEqual({ userId: alice.userId, username: 'alice', avatarUrl });
      expect(await posts(alice.userId)).toMatchObject({ banned: false, pinned: [{ contentId: first }], posts: [{ contentId: second }, { contentId: first }] });

      // Banned again, she can take away what she put there.
      ok(await req(root, 'PUT', `/banned/${alice.userId}`), 201);
      expect(ok(await update(alice, { bio: null, links: null }))).toMatchObject({ bio: null, links: [] });
      expect(ok(await req(alice, 'DELETE', `/users/${alice.userId}/avatar`))).toEqual({ userId: alice.userId, avatarUrl: null, hadAvatar: true });
      expect(ok(await unpin(alice, first))).toEqual({ userId: alice.userId, contentId: first, wasPinned: true });
      ok(await req(root, 'DELETE', `/banned/${alice.userId}`));
      expect(await profile(alice.userId)).toMatchObject({ banned: false, bio: null, links: [], avatarUrl: null, pinnedContentIds: [] });
    });

    it('takes an avatar as a file or inline, shows it to anyone, and deletes the one another replaces', async () => {
      ctx = await createTestContext(target, { publicBaseUrl: 'https://api.example.com' });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const path = (url: string) => url.replace('https://api.example.com', '');

      expect(await refused(avatar(`/users/${alice.userId}/avatar`))).toEqual([404, 'this user has no avatar']);
      expect(await refused(avatar(`/users/${NO_USER}/avatar`))).toEqual([404, 'user not found']);

      // As a file part, whatever type it says it is: its bytes say which image it is.
      const set = ok(await upload(alice, { name: 'me.bin', type: 'application/octet-stream' }));
      expect(set).toEqual({ userId: alice.userId, avatarUrl: expect.stringMatching(new RegExp(`^https://api\\.example\\.com/users/${alice.userId}/avatar\\?v=[0-9a-f-]{36}$`)) });
      expect((await profile(alice.userId)).avatarUrl).toBe(set.avatarUrl);
      expect(ok(await update(alice, { bio: 'Hi' })).avatarUrl).toBe(set.avatarUrl);
      const first = avatarId(set.avatarUrl);

      // Anyone reads it, with no credentials, as something to show and nothing more; the address the profile gave may be kept.
      const one = await avatar(path(set.avatarUrl));
      expect(one.statusCode).toBe(200);
      expect(one.headers['content-type']).toBe('image/webp');
      expect(one.headers['x-content-type-options']).toBe('nosniff');
      expect(one.headers['cache-control']).toBe('public, max-age=86400');
      // With no `v`, it is whatever avatar she has, and is asked for again soon.
      const latest = await avatar(`/users/${alice.userId}/avatar`);
      expect([latest.statusCode, latest.headers['cache-control'], latest.rawPayload.equals(one.rawPayload)]).toEqual([200, 'public, max-age=300', true]);

      // Inline, in base64: another image, under another address, and the file of the first is gone.
      const replaced = ok(await req(alice, 'PUT', `/users/${alice.userId}/avatar`, { content: JPEG.toString('base64'), contentEncoding: 'base64' }));
      expect(replaced.avatarUrl).not.toBe(set.avatarUrl);
      const two = await avatar(path(replaced.avatarUrl));
      expect([two.statusCode, two.headers['content-type'], two.headers['cache-control'], two.rawPayload.equals(one.rawPayload)]).toEqual([200, 'image/webp', 'public, max-age=86400', false]);
      expect(await stored(alice.userId, first)).toBe(false);
      expect(await stored(alice.userId, avatarId(replaced.avatarUrl))).toBe(true);
      // The address of the one before answers with the one she has now, and isn't kept as long.
      const stale = await avatar(path(set.avatarUrl));
      expect([stale.headers['cache-control'], stale.rawPayload.equals(two.rawPayload)]).toEqual(['public, max-age=300', true]);

      // One image, and an image at that, of a size an avatar can be made of, whose pixels can be read.
      expect(await refused(req(alice, 'PUT', `/users/${alice.userId}/avatar`))).toEqual([400, 'content is required: the image of the avatar']);
      expect(await refused(upload(alice, { data: Buffer.from('<svg/>') }))).toEqual([400, 'avatars are JPEG, PNG, GIF and WebP images, and the file is none of them']);
      expect(await refused(req(alice, 'PUT', `/users/${alice.userId}/avatar`, { content: Buffer.from('just some text').toString('base64') }))).toEqual([
        400,
        'avatars are JPEG, PNG, GIF and WebP images, and the file is none of them',
      ]);
      expect((await upload(alice, { data: PNG.subarray(0, 40) })).statusCode).toBe(400);
      expect((await upload(alice, { data: Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)]) })).statusCode).toBe(413);
      // Laid out as a PNG is, with pixels that aren't what it says they are.
      const damaged = Buffer.from(PNG);
      const at = damaged.indexOf('IDAT') + 6;
      damaged[at] = damaged[at]! ^ 0xff;
      expect(await refused(upload(alice, { data: damaged }))).toEqual([400, "the image couldn't be read, so no avatar was made of it"]);
      // Only the user's own.
      expect(await refused(upload(bob, {}, alice.userId))).toEqual([403, 'you can only change your own avatar']);
      expect((await upload(null, {}, alice.userId)).statusCode).toBe(401);
      expect(await refused(req(bob, 'DELETE', `/users/${alice.userId}/avatar`))).toEqual([403, 'you can only change your own avatar']);
      // None of which changed the one she has, or left a file beside it.
      expect((await profile(alice.userId)).avatarUrl).toBe(replaced.avatarUrl);

      // Taken away, with its file; taking it away again changes nothing.
      expect(ok(await req(alice, 'DELETE', `/users/${alice.userId}/avatar`))).toEqual({ userId: alice.userId, avatarUrl: null, hadAvatar: true });
      expect((await profile(alice.userId)).avatarUrl).toBeNull();
      expect(await stored(alice.userId, avatarId(replaced.avatarUrl))).toBe(false);
      expect(await refused(avatar(path(replaced.avatarUrl)))).toEqual([404, 'this user has no avatar']);
      expect(ok(await req(alice, 'DELETE', `/users/${alice.userId}/avatar`))).toEqual({ userId: alice.userId, avatarUrl: null, hadAvatar: false });
    });

    it('makes every avatar the same size and type, whatever image it is made of', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      /** The avatar the server makes of an image, as anyone reads it. */
      const made = async (file: Partial<FilePart>) => {
        const read = await avatar(ok(await upload(alice, file)).avatarUrl);
        expect([read.statusCode, read.headers['content-type'], read.headers['content-length']]).toEqual([200, 'image/webp', String(read.rawPayload.length)]);
        return read.rawPayload;
      };
      const standard = ['webp', AVATAR_SIZE, AVATAR_SIZE];
      const [left, right, top, bottom] = [AVATAR_SIZE / 4, (3 * AVATAR_SIZE) / 4, AVATAR_SIZE / 4, (3 * AVATAR_SIZE) / 4];

      // A small image is brought up to the size, and a large one down to it. What was transparent stays so.
      const dot = await made({ data: PNG });
      expect(await shape(dot)).toEqual(standard);
      expect((await sharp(dot).metadata()).hasAlpha).toBe(true);
      const large = await made({ data: await sharp({ create: { width: 3000, height: 3000, channels: 3, background: RED } }).jpeg().toBuffer(), name: 'large.jpg', type: 'image/jpeg' });
      expect(await shape(large)).toEqual(standard);
      expect(large.length).toBeLessThan(20_000);

      // One that isn't square is cut to the square about its middle: half of each colour, side by side.
      const cut = await made({ data: await wide().png().toBuffer() });
      expect(await shape(cut)).toEqual(standard);
      expect([await colourAt(cut, left, top), await colourAt(cut, left, bottom), await colourAt(cut, right, top), await colourAt(cut, right, bottom)]).toEqual(['red', 'red', 'blue', 'blue']);

      // One a camera held on its side is turned the way it shows first: the red half is then on top.
      const turned = await made({ data: await wide().withMetadata({ orientation: 6 }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer(), name: 'turned.jpg', type: 'image/jpeg' });
      expect(await shape(turned)).toEqual(standard);
      expect([await colourAt(turned, left, top), await colourAt(turned, right, top), await colourAt(turned, left, bottom), await colourAt(turned, right, bottom)]).toEqual(['red', 'red', 'blue', 'blue']);
      // And says nothing of how it was held, or anything else of where it came from.
      expect(await sharp(turned).metadata()).not.toHaveProperty('exif');

      // Of an animation, the first frame.
      const frames = await sharp(Buffer.concat([Buffer.alloc(64 * 64 * 3, 0), Buffer.alloc(64 * 64 * 3, 255)]), { raw: { width: 64, height: 128, channels: 3, pageHeight: 64 } }).gif().toBuffer();
      expect((await sharp(frames, { pages: -1 }).metadata()).pages).toBe(2);
      const still = await made({ data: frames, name: 'moving.gif', type: 'image/gif' });
      expect([await shape(still), (await sharp(still, { pages: -1 }).metadata()).pages ?? 1]).toEqual([standard, 1]);
    });

    it("credits a user's posts with their avatar where a post is read from the database, and not in feeds", async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const hers = await post(alice, 'Hers #news');
      const his = await post(bob, 'His #news');
      await ctx.compact();
      const plain = { userId: alice.userId, username: 'alice' };
      const fed = async () => (ok(await req(null, 'GET', '/feed?tags=news')).tags.news as FeedItem[]).find((item) => item.contentId === hers)!.publisher;

      // A user with no avatar is credited by their name alone, as before.
      expect(await creditOf(hers)).toEqual(plain);
      expect((await posts(alice.userId)).posts[0]!.publisher).toEqual(plain);

      // With one, a post read by its id says where it is read, and so does each post of the profile's list.
      const { avatarUrl } = ok(await upload(alice));
      expect(await creditOf(hers)).toEqual({ ...plain, avatarUrl });
      ok(await pin(alice, hers), 201);
      const listed = await posts(alice.userId);
      expect([listed.posts[0]!.publisher, listed.pinned![0]!.publisher]).toEqual([{ ...plain, avatarUrl }, { ...plain, avatarUrl }]);
      // Nobody else's post says it, and a feed's credit is the name alone.
      expect(await creditOf(his)).toEqual({ userId: bob.userId, username: 'bob' });
      expect(await fed()).toEqual(plain);

      // Another avatar is another address, and none is none.
      const next = ok(await upload(alice, { data: JPEG, name: 'me.jpg', type: 'image/jpeg' })).avatarUrl;
      expect(next).not.toBe(avatarUrl);
      expect(await creditOf(hers)).toEqual({ ...plain, avatarUrl: next });
      ok(await req(alice, 'DELETE', `/users/${alice.userId}/avatar`));
      expect(await creditOf(hers)).toEqual(plain);
      expect((await posts(alice.userId)).posts[0]!.publisher).toEqual(plain);
    });

    it("lists all of a user's posts, newest first, a page at a time, and only what anyone can read", async () => {
      /** Takes off 30, which leaves a post waiting in the moderation queue. */
      const wary: TrustPlugin = { name: 'wary', assess: ({ texts }) => (texts.some((text) => text.includes('FREE')) ? { reduce: 30 } : null) };
      ctx = await createTestContext(target, { trustPlugins: [wary] });
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const written: string[] = [];
      for (let i = 1; i <= 5; i++) {
        written.push(await post(alice, `Post ${i} #news`));
        ctx.clock.now += 1000;
      }
      const bobs = await post(bob, 'Bob here #news');
      const held = ok(await req(alice, 'POST', '/store', { type: 'text', text: 'FREE things #news', tags: ['news'] }), 202).contentId;
      ok(await like(bob, written[4]!), 201);
      await ctx.compact();
      const newestFirst = [...written].reverse();

      // All of hers, as a feed gives them, and none of anyone else's; not the one that waits in the moderation queue.
      const all = await posts(alice.userId);
      expect(ids(all)).toEqual(newestFirst);
      expect(all).toMatchObject({ userId: alice.userId, banned: false, pinned: [], nextCursor: null });
      expect(all.posts[0]).toMatchObject({ contentId: written[4], publisher: { userId: alice.userId, username: 'alice' }, preview: { kind: 'text', text: 'Post 5 #news' }, tags: ['news'], likes: 1 });
      expect(ids(await posts(bob.userId))).toEqual([bobs]);
      expect(ids(all)).not.toContain(held);

      // A page at a time, each taken up where the one before ended. Only the first says what is pinned.
      const one = await posts(alice.userId, '?limit=2');
      expect([ids(one), one.pinned]).toEqual([newestFirst.slice(0, 2), []]);
      const two = await posts(alice.userId, `?limit=2&cursor=${one.nextCursor}`);
      expect(ids(two)).toEqual(newestFirst.slice(2, 4));
      expect(two).not.toHaveProperty('pinned');
      const three = await posts(alice.userId, `?limit=2&cursor=${two.nextCursor}`);
      expect([ids(three), three.nextCursor]).toEqual([newestFirst.slice(4), null]);

      // A post older than summaries are kept is shown with what its meta file says.
      const oldest = await ctx.db.selectFrom('content').select(['id', 'created_at']).where('id', '=', written[0]!).executeTakeFirstOrThrow();
      const summary = [{ contentId: oldest.id, createdAt: Number(oldest.created_at) }];
      await ctx.summaries.remove(summary);
      expect(await ctx.summaries.getMany(summary)).toEqual([null]);
      expect((await posts(alice.userId)).posts.at(-1)).toEqual(all.posts.at(-1));

      // A post set for deletion is gone from it at once.
      ok(await req(alice, 'DELETE', `/content/${written[2]}`), 202);
      expect(ids(await posts(alice.userId))).toEqual(newestFirst.filter((id) => id !== written[2]));

      // What a page can be asked for with.
      expect((await req(null, 'GET', `/users/${alice.userId}/posts?limit=0`)).statusCode).toBe(400);
      expect((await req(null, 'GET', `/users/${alice.userId}/posts?limit=51`)).statusCode).toBe(400);
      expect(await refused(req(null, 'GET', `/users/${alice.userId}/posts?cursor=nonsense`))).toEqual([400, 'invalid cursor']);
      expect(await refused(req(null, 'GET', `/users/${NO_USER}/posts`))).toEqual([404, 'user not found']);
      expect((await req(null, 'GET', '/users/alice/posts')).statusCode).toBe(400);
      // A user with no posts has a list with none.
      const carol = await ctx.register('carol');
      expect(await posts(carol.userId)).toEqual({ userId: carol.userId, banned: false, pinned: [], posts: [], nextCursor: null });
    });

    it('limits the lists of posts and the avatars one address reads in a minute, each on a count of its own', async () => {
      ctx = await createTestContext(target, { profilePostsRateLimitPerMinute: 2, avatarRateLimitPerMinute: 3 });
      const alice = await ctx.register('alice');
      const { avatarUrl } = ok(await upload(alice));
      const read = () => req(null, 'GET', `/users/${alice.userId}/posts`);
      expect([(await read()).statusCode, (await read()).statusCode, (await read()).statusCode]).toEqual([200, 200, 429]);
      // An avatar is counted by whichever of its addresses it is read, and whether or not it is there.
      const shown = [await avatar(avatarUrl), await avatar(`/users/${alice.userId}/avatar`), await avatar(`/users/${NO_USER}/avatar`), await avatar(avatarUrl)];
      expect(shown.map((res) => res.statusCode)).toEqual([200, 200, 404, 429]);
      // The profile itself is counted apart.
      expect((await req(null, 'GET', `/users/${alice.userId}`)).statusCode).toBe(200);

      // The setting is the server's own unless it is given another.
      expect(loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json' }).avatarRateLimitPerMinute).toBe(300);
      expect(loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json', AVATAR_RATE_LIMIT_PER_MINUTE: '7' }).avatarRateLimitPerMinute).toBe(7);
    });

    it('pins a few of the user’s own posts to their profile, which names them and lists them first', async () => {
      ctx = await createTestContext(target);
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      const written: string[] = [];
      for (let i = 1; i <= MAX_PINNED_POSTS + 2; i++) {
        written.push(await post(alice, `Post ${i} #news`));
        ctx.clock.now += 1000;
      }
      const [first, second, third, ...rest] = written as [string, string, string, ...string[]];
      const bobs = await post(bob, 'Bob here #news');
      await ctx.compact();
      const pinnedIds = async () => (await profile(alice.userId)).pinnedContentIds;

      const pinnedAt = now();
      expect(ok(await pin(alice, first), 201)).toEqual({ userId: alice.userId, contentId: first, pinnedAt, alreadyPinned: false });
      expect(await pinnedIds()).toEqual([first]);
      // The list gives it ahead of the others, as a record like theirs, and it keeps its place among them.
      const listed = await posts(alice.userId);
      expect(listed.pinned).toEqual([listed.posts.at(-1)]);
      expect(listed.pinned![0]).toMatchObject({ contentId: first, preview: { kind: 'text', text: 'Post 1 #news' } });
      expect(ids(listed)).toEqual([...written].reverse());
      expect((await profile(bob.userId)).pinnedContentIds).toEqual([]);

      // Pinning it again changes nothing; pinning another adds to it, the one pinned last first.
      ctx.clock.now += 5000;
      expect(ok(await pin(alice, first), 200)).toEqual({ userId: alice.userId, contentId: first, pinnedAt, alreadyPinned: true });
      expect(ok(await pin(alice, third), 201)).toEqual({ userId: alice.userId, contentId: third, pinnedAt: now(), alreadyPinned: false });
      expect(await pinnedIds()).toEqual([third, first]);
      expect((await posts(alice.userId)).pinned!.map((p) => p.contentId)).toEqual([third, first]);
      // Only the first page says what is pinned.
      const page = await posts(alice.userId, '?limit=1');
      expect(await posts(alice.userId, `?limit=1&cursor=${page.nextCursor}`)).not.toHaveProperty('pinned');

      // Only their own posts, to their own profile.
      expect(await refused(pin(alice, bobs))).toEqual([403, 'you can only pin your own posts']);
      expect(await refused(pin(alice, NO_USER))).toEqual([404, 'content not found']);
      expect(await refused(pin(bob, third, alice.userId))).toEqual([403, 'you can only pin posts to your own profile']);
      expect(await refused(unpin(bob, third, alice.userId))).toEqual([403, 'you can only pin posts to your own profile']);
      expect((await pin(null, third, alice.userId)).statusCode).toBe(401);
      expect(await pinnedIds()).toEqual([third, first]);

      // Unpinning a post that isn't pinned changes nothing; unpinning one that is leaves the others.
      expect(ok(await unpin(alice, second))).toEqual({ userId: alice.userId, contentId: second, wasPinned: false });
      expect(await pinnedIds()).toEqual([third, first]);
      expect(ok(await unpin(alice, first))).toEqual({ userId: alice.userId, contentId: first, wasPinned: true });
      expect(await pinnedIds()).toEqual([third]);
      expect(ok(await unpin(alice, first))).toEqual({ userId: alice.userId, contentId: first, wasPinned: false });

      // A profile has so many pinned posts and no more: one more is refused until another is unpinned.
      const more = [first, second, ...rest].slice(0, MAX_PINNED_POSTS - 1);
      for (const contentId of more) {
        ctx.clock.now += 1000;
        ok(await pin(alice, contentId), 201);
      }
      const full = [...more].reverse().concat(third);
      expect(await pinnedIds()).toEqual(full);
      const [spare] = written.filter((contentId) => !full.includes(contentId));
      expect(await refused(pin(alice, spare!))).toEqual([409, `a profile has at most ${MAX_PINNED_POSTS} pinned posts: unpin one before you pin another`]);
      // One that is pinned already is still answered as it was.
      expect(ok(await pin(alice, third), 200)).toMatchObject({ alreadyPinned: true });
      expect(await pinnedIds()).toEqual(full);
      expect((await posts(alice.userId)).pinned!.map((p) => p.contentId)).toEqual(full);

      // A pinned post that is deleted is pinned no more: gone from the profile at once, and its place is free for another.
      ok(await req(alice, 'DELETE', `/content/${third}`), 202);
      expect(await pinnedIds()).toEqual(full.slice(0, -1));
      expect((await posts(alice.userId)).pinned!.map((p) => p.contentId)).toEqual(full.slice(0, -1));
      expect(await refused(pin(alice, third))).toEqual([404, 'content not found']);
      ctx.clock.now += 1000;
      ok(await pin(alice, spare!), 201);
      expect(await pinnedIds()).toEqual([spare, ...full.slice(0, -1)]);
      // Its pin goes with the post.
      await ctx.compact();
      expect((await ctx.db.selectFrom('pinned_posts').select('content_id').where('user_id', '=', alice.userId).execute()).map((row) => row.content_id).sort()).toEqual([spare, ...full.slice(0, -1)].sort());
    });

    it("gives a user's profile in their export, and deletes it, avatar and all, with their account", async () => {
      ctx = await createTestContext(target);
      // An export is given once the index of users' comments holds everything, which the compactor's process sees to as it starts.
      await ctx.comments.indexAuthors();
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      ok(await update(alice, { bio: 'Hello', links: ['https://example.com/alice'] }));
      const { avatarUrl } = ok(await upload(alice));
      const pinned = await post(alice, 'Pinned #news');
      ctx.clock.now += 1000;
      const also = await post(alice, 'Pinned too #news');
      ok(await pin(alice, pinned), 201);
      ctx.clock.now += 1000;
      ok(await pin(alice, also), 201);
      ok(await upload(bob));
      const bobsAvatar = avatarId((await profile(bob.userId)).avatarUrl);

      const exported = ok(await req(alice, 'GET', `/users/${alice.userId}/export`)).records as Record<string, unknown>[];
      expect(exported.filter((r) => r.type === 'account')).toMatchObject([{ bio: 'Hello', links: ['https://example.com/alice'], avatarUrl, pinnedContentIds: [also, pinned] }]);

      // The account is closed: nothing of the profile is read, and the avatar's file is gone at once.
      ok(await req(alice, 'DELETE', `/users/${alice.userId}`), 202);
      expect((await req(null, 'GET', `/users/${alice.userId}`)).statusCode).toBe(404);
      expect(await refused(avatar(avatarUrl))).toEqual([404, 'user not found']);
      expect(await refused(req(null, 'GET', `/users/${alice.userId}/posts`))).toEqual([404, 'user not found']);
      expect(await stored(alice.userId, avatarId(avatarUrl))).toBe(false);
      // The row waits for her posts, and goes with them, and her pins with both.
      await ctx.compact();
      expect(await ctx.db.selectFrom('users').select('id').where('id', '=', alice.userId).execute()).toEqual([]);
      expect(await ctx.db.selectFrom('pinned_posts').select('content_id').execute()).toEqual([]);
      // Nobody else's went with it.
      expect(await stored(bob.userId, bobsAvatar)).toBe(true);

      // An account with no posts is gone at once, with its avatar.
      expect(ok(await req(bob, 'DELETE', `/users/${bob.userId}`))).toEqual({ userId: bob.userId, status: 'deleted' });
      expect(await stored(bob.userId, bobsAvatar)).toBe(false);
    });
  });
}
