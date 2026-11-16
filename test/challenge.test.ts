import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { challengeKey, leadingZeroBits, type Challenge } from '../src/challenge/challenges.js';
import { ALPHABET, ANSWER_LENGTH, challengeText, HEIGHT, renderChallenge, WIDTH } from '../src/challenge/image.js';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { as, createTestContext, requests, TARGETS, type TestContext, type User } from './helpers.js';

/** The pixels of an 8-bit grayscale PNG. */
function decodePng(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect([png[24], png[25]]).toEqual([8, 0]);
  const idat = png.indexOf('IDAT');
  const rows = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  expect(rows.length).toBe((width + 1) * height);
  return { width, height, rows };
}

describe('challenge images', () => {
  it('draws a random answer from an alphabet without look-alikes, differently every time', () => {
    const answers = Array.from({ length: 200 }, challengeText);
    for (const a of answers) expect(a).toMatch(new RegExp(`^[${ALPHABET}]{${ANSWER_LENGTH}}$`));
    expect(new Set(answers).size).toBe(200);
    expect(ALPHABET).not.toMatch(/[0O1IQ2Z5S6B]/);

    const { width, height, rows } = decodePng(renderChallenge('ACDEFG'));
    expect([width, height]).toEqual([WIDTH, HEIGHT]);
    const pixels = [...rows].filter((_, i) => i % (width + 1) !== 0);
    expect(pixels.some((v) => v < 80)).toBe(true);
    expect(pixels.some((v) => v > 180)).toBe(true);
    expect(renderChallenge('ACDEFG').equals(renderChallenge('ACDEFG'))).toBe(false);
  });

  it('counts the leading zero bits of a hash', () => {
    expect(leadingZeroBits(Buffer.from([0x80, 0]))).toBe(0);
    expect(leadingZeroBits(Buffer.from([0, 0, 0x10, 0xff]))).toBe(19);
    expect(leadingZeroBits(Buffer.alloc(32))).toBe(256);
  });
});

for (const target of TARGETS) {
  describe(`challenges (${target.name})`, () => {
    let ctx: TestContext;
    /** The texts of posts that got as far as writing their bytes. */
    let written: string[];
    /** Writes wait for this, while set. */
    let hold: Promise<void> | null;
    beforeEach(async () => {
      written = [];
      hold = null;
      // As a server has them: a post window of a minute, and no answer accepted within 2 seconds.
      ctx = await createTestContext(target, { challenge: { postWindowSeconds: 60, minSolveMs: 2000 } });
      const putFile = ctx.content.putFile.bind(ctx.content);
      vi.spyOn(ctx.content, 'putFile').mockImplementation(async (...args) => {
        const text = await readFile(args[1], 'utf8');
        written.push(text);
        await hold;
        if (text.startsWith('fail')) throw new Error('storage unavailable');
        return putFile(...args);
      });
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await ctx.close();
    });

    const register = (payload: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/register', payload });
    const { storeText } = requests(() => ctx);
    const newChallenge = (scope: string) => ctx.app.inject({ method: 'POST', url: '/register', payload: { username: scope } }).then((r) => r.json().challenge as Challenge);
    const gone = async (c: Challenge) => (await ctx.hot.get(challengeKey(c.id))) === null;

    it('answers /register with a challenge, and registers once the same request solves it', async () => {
      const payload = { username: 'alice' };
      const first = await register(payload);
      expect(first.statusCode).toBe(428);
      const { error, challenge } = first.json() as { error: string; challenge: Challenge };
      expect(error).toBe('solve the challenge to register');
      expect(challenge).toEqual({
        id: expect.any(String),
        image: expect.stringMatching(/^data:image\/png;base64,/),
        expiresAt: new Date(ctx.clock.now + 120_000).toISOString(),
        expiresInSeconds: 120,
        step: 1,
        steps: 1,
        proofOfWork: { algorithm: 'SHA-256', prefix: `${challenge.id}:`, bits: 8 },
      });
      expect(decodePng(Buffer.from(challenge.image.split(',')[1]!, 'base64'))).toMatchObject({ width: WIDTH, height: HEIGHT });
      expect(await ctx.db.selectFrom('users').selectAll().execute()).toEqual([]);

      // People can type it in any case, with spaces.
      const solution = await ctx.solve(challenge);
      const answer = solution.challengeAnswer.toLowerCase().split('').join(' ');
      const done = await register({ ...payload, ...solution, challengeAnswer: answer });
      expect(done.statusCode, done.body).toBe(201);
      expect(done.json()).toMatchObject({ username: 'alice', apiKey: expect.stringMatching(/^tu_/) });
      expect(await gone(challenge)).toBe(true);

      const again = await register({ ...payload, username: 'alicia', ...solution });
      expect(again.statusCode).toBe(428);
      expect(again.json().error).toBe('the challenge has expired or was already used; solve the new challenge');
      expect(again.json().challenge.id).not.toBe(challenge.id);

      // A name already taken is refused before any challenge.
      const taken = await register({ username: 'alice' });
      expect(taken.statusCode).toBe(409);
      expect(taken.json()).toEqual({ error: 'username is already taken' });
    });

    it('refuses an answer that is wrong, late, too quick, without the work or for another request, with a new challenge each time', async () => {
      const attempt = async (solution: Record<string, unknown>) => {
        const res = await register({ username: 'bob', ...solution });
        expect(res.statusCode).toBe(428);
        expect(res.json().challenge.id).not.toBe(solution.challengeId);
        return res.json().error as string;
      };
      const sha = (s: string) => createHash('sha256').update(s).digest();

      let c = await newChallenge('bob');
      let s = await ctx.solve(c);
      const wrong = s.challengeAnswer.replace(/^./, (ch) => (ch === 'A' ? 'C' : 'A'));
      expect(await attempt({ ...s, challengeAnswer: wrong })).toBe('the characters are wrong; solve the new challenge');
      // Any answer uses the challenge up, so the right one now comes too late.
      expect(await gone(c)).toBe(true);
      expect(await attempt(s)).toBe('the challenge has expired or was already used; solve the new challenge');

      c = await newChallenge('bob');
      s = await ctx.solve(c);
      const lazy = [...Array(64).keys()].map(String).find((n) => leadingZeroBits(sha(`${c.id}:${n}`)) < 8)!;
      expect(await attempt({ ...s, challengeNonce: lazy })).toBe('the proof of work is wrong; solve the new challenge');

      c = await newChallenge('bob');
      s = await ctx.solve(c, 500);
      expect(await attempt(s)).toBe('the challenge was answered too quickly; solve the new challenge');

      c = await newChallenge('bob');
      s = await ctx.solve(c);
      ctx.clock.now += 120_000;
      expect(await attempt(s)).toBe('the challenge has expired; solve the new challenge');

      expect(await attempt({ ...s, challengeId: randomUUID() })).toBe('the challenge has expired or was already used; solve the new challenge');
      expect((await register({ username: 'bob', challengeId: 'nope' })).statusCode).toBe(400);

      // A challenge issued for a post doesn't register anyone.
      const alice = await ctx.register('alice');
      await storeText(alice, 'first #news');
      const postChallenge = (await storeText(alice, 'second #news')).json().challenge as Challenge;
      expect(await attempt(await ctx.solve(postChallenge))).toBe('the challenge was issued for another request; solve the new challenge');
      expect((await ctx.db.selectFrom('users').select('username').execute()).map((u) => u.username)).toEqual(['alice']);
    });

    it('has no setting that spares a registration its challenge', async () => {
      // What once turned it off, in the environment or in a config file, is no setting now, and changes nothing.
      const off = loadConfig({ challenge: { register: false } }, { EVIEVERSE_CONFIG: '/nonexistent.json' });
      expect(off.challenge).toEqual({ postWindowSeconds: 60, ttlSeconds: 120, powBits: 18, minSolveMs: 2000 });

      await ctx.close();
      ctx = await createTestContext(target, { challenge: { register: false } as object });
      expect((await register({ username: 'alice' })).statusCode).toBe(428);
      expect(await ctx.db.selectFrom('users').selectAll().execute()).toEqual([]);
    });

    it('registers a user for an admin without a challenge, and for no other user', async () => {
      const usernames = async () => (await ctx.db.selectFrom('users').select('username').execute()).map((u) => u.username).sort();
      /** A user's credentials alone, as the fields of a request. */
      const by = ({ userId, apiKey }: User) => ({ userId, apiKey });
      const root = await ctx.register('root');
      await setAdmin(ctx.db, 'root', true);

      // The admin's credentials as headers, or as fields of the request.
      const byHeaders = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'alice' }, headers: as(root) });
      expect(byHeaders.statusCode, byHeaders.body).toBe(201);
      const alice = byHeaders.json() as User;
      expect(alice).toMatchObject({ username: 'alice', apiKey: expect.stringMatching(/^tu_/) });
      expect(alice.userId).not.toBe(root.userId);
      const byFields = await register({ username: 'bob', ...by(root) });
      expect([byFields.statusCode, byFields.json().username]).toEqual([201, 'bob']);
      // The account is the new user's own, with their own key, and no admin's.
      const me = await ctx.app.inject({ method: 'GET', url: '/whoami', headers: as(alice) });
      expect(me.json()).toMatchObject({ userId: alice.userId, username: 'alice', admin: false });
      // What a registration is refused for still holds.
      expect((await register({ username: 'alice', ...by(root) })).statusCode).toBe(409);

      // A user who isn't an admin solves a challenge, as anyone does.
      const asked = await register({ username: 'carol', ...by(alice) });
      expect([asked.statusCode, asked.json().error]).toEqual([428, 'solve the challenge to register']);
      const solved = await register({ username: 'carol', ...by(alice), ...(await ctx.solve(asked.json().challenge)) });
      expect(solved.statusCode, solved.body).toBe(201);

      // A request that names a user is held to their key: a wrong one, or none, is refused, not challenged.
      const wrongKey = await register({ username: 'dave', userId: root.userId, apiKey: alice.apiKey });
      expect([wrongKey.statusCode, wrongKey.json()]).toEqual([401, { error: 'Invalid userId or apiKey' }]);
      const noKey = await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'dave' }, headers: { 'x-user-id': root.userId } });
      expect([noKey.statusCode, noKey.json()]).toEqual([401, { error: 'userId and apiKey are required' }]);
      // A key without a user names nobody, as a gateway's own Authorization header doesn't: the request is anyone's.
      for (const headers of [{ authorization: `Bearer ${root.apiKey}` }, { authorization: 'Bearer the-gateways-own-token' }]) {
        expect((await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'dave' }, headers })).statusCode).toBe(428);
      }
      // Behind such a gateway, the admin's key arrives as X-Forwarded-Authorization.
      const forwarded = { ...as(root), authorization: 'Bearer the-gateways-own-token', 'x-forwarded-authorization': `Bearer ${root.apiKey}` };
      expect((await ctx.app.inject({ method: 'POST', url: '/register', payload: { username: 'erin' }, headers: forwarded })).statusCode).toBe(201);

      // It goes by the role as it is now.
      await setAdmin(ctx.db, 'root', false);
      expect((await register({ username: 'dave', ...by(root) })).statusCode).toBe(428);
      expect(await usernames()).toEqual(['alice', 'bob', 'carol', 'erin', 'root']);
    });

    it('lets a post through at once, and answers one less than a minute later with a challenge before anything is stored', async () => {
      const alice = await ctx.register('alice');
      expect((await storeText(alice, 'first #news')).statusCode).toBe(201);
      ctx.clock.now += 30_000;
      const second = await storeText(alice, 'second #news');
      expect(second.statusCode).toBe(428);
      expect(second.json().error).toBe('you posted or were challenged less than 60 seconds ago; solve the challenge to post');
      expect(written).toEqual(['first #news']);
      expect(await ctx.db.selectFrom('content').select('id').execute()).toHaveLength(1);

      const solved = await storeText(alice, 'second #news', await ctx.solve(second.json().challenge));
      expect(solved.statusCode, solved.body).toBe(201);
      const { contentId } = solved.json();

      // The minute runs from the latest post, and updates are posts too.
      ctx.clock.now += 50_000;
      expect((await storeText(alice, 'second, edited #news', { contentId })).statusCode).toBe(428);
      // Storing the same bytes again isn't a post.
      expect((await storeText(alice, 'second #news', { contentId })).json()).toMatchObject({ unchanged: true });
      // Each challenge starts the minute again.
      ctx.clock.now += 59_000;
      expect((await storeText(alice, 'second, edited #news', { contentId })).statusCode).toBe(428);
      ctx.clock.now += 60_000;
      expect((await storeText(alice, 'second, edited #news', { contentId })).json()).toMatchObject({ contentId, preview: { kind: 'text', text: 'second, edited #news' } });

      // Each user has their own minute, and their own challenges.
      const bob = await ctx.register('bob');
      expect((await storeText(bob, 'hello #news')).statusCode).toBe(201);
      const bobs = (await storeText(bob, 'hello again #news')).json().challenge as Challenge;
      const stolen = await storeText(alice, 'third #news', await ctx.solve(bobs));
      expect(stolen.statusCode).toBe(428);
      expect(stolen.json().error).toBe('the challenge was issued for another request; solve the new challenge to post');
      expect(written).toEqual(['first #news', 'second #news', 'second, edited #news', 'hello #news']);
    });

    it('gives the minute back when a post fails, and passes only one of concurrent posts without a challenge', async () => {
      const alice = await ctx.register('alice');
      expect((await storeText(alice, 'fail #news')).statusCode).toBe(500);
      expect((await storeText(alice, 'works #news')).statusCode).toBe(201);

      ctx.clock.now += 60_000;
      let release!: () => void;
      hold = new Promise((resolve) => (release = resolve));
      let answered = 0;
      const posts = ['a', 'b', 'c'].map((t) => Promise.resolve(storeText(alice, `${t} #news`)).finally(() => answered++));
      // Two are answered while one is still being written.
      for (let i = 0; i < 400 && answered < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(answered).toBe(2);
      expect(written).toHaveLength(3);
      release();
      expect((await Promise.all(posts)).map((r) => r.statusCode).sort()).toEqual([201, 428, 428]);
    });

    /** Stores `text`, solving every challenge it's answered with, 10 seconds each; returns the last answer, and each challenge's step. */
    const storeSolving = async (user: User, text: string) => {
      const steps: string[] = [];
      let res = await storeText(user, text);
      while (res.statusCode === 428) {
        const c = res.json().challenge as Challenge;
        steps.push(`${c.step}/${c.steps}`);
        ctx.clock.now += 8_000;
        res = await storeText(user, text, await ctx.solve(c));
      }
      return { res, steps };
    };

    it('asks posts in a row for 1, 1, then never more than 2 challenges, one after another, until a minute goes by without a post or challenge', async () => {
      const alice = await ctx.register('alice');
      const steps = async (text: string) => {
        const { res, steps } = await storeSolving(alice, text);
        expect(res.statusCode, res.body).toBe(201);
        return steps;
      };
      expect(await steps('one #news')).toEqual([]);
      expect(await steps('two #news')).toEqual(['1/1']);
      expect(await steps('three #news')).toEqual(['1/1']);
      expect(await steps('four #news')).toEqual(['1/2', '2/2']);

      // Each right answer gets the next challenge; a wrong one, a new challenge at the same step.
      const first = await storeText(alice, 'five #news');
      expect(first.json()).toMatchObject({
        error: 'you posted or were challenged less than 60 seconds ago; solve 2 challenges to post',
        challenge: { step: 1, steps: 2 },
      });
      const next = await storeText(alice, 'five #news', await ctx.solve(first.json().challenge));
      expect(next.json()).toMatchObject({ error: 'solved 1 of 2; solve the next challenge', challenge: { step: 2, steps: 2 } });
      const solution = await ctx.solve(next.json().challenge);
      const wrongAnswer = solution.challengeAnswer.replace(/^./, (ch) => (ch === 'A' ? 'C' : 'A'));
      const wrong = await storeText(alice, 'five #news', { ...solution, challengeAnswer: wrongAnswer });
      expect(wrong.json()).toMatchObject({ error: 'the characters are wrong; solve the new challenge', challenge: { step: 2, steps: 2 } });
      expect((await storeText(alice, 'five #news', await ctx.solve(wrong.json().challenge))).statusCode).toBe(201);

      // Two is the most, however long the run goes on, and each challenge starts the minute again.
      for (const text of ['six #news', 'seven #news', 'eight #news', 'nine #news']) expect(await steps(text)).toEqual(['1/2', '2/2']);
      expect(written).toHaveLength(9);

      // A minute without either, and the run starts over.
      ctx.clock.now += 60_000;
      expect(await steps('ten #news')).toEqual([]);
      expect(await steps('eleven #news')).toEqual(['1/1']);
    });

    it('lets one of runs solved in parallel through, and gives a failed post its place in the run back', async () => {
      const alice = await ctx.register('alice');
      for (const text of ['one #news', 'two #news']) expect((await storeSolving(alice, text)).res.statusCode).toBe(201);

      // A post that fails after its challenge gives its place back: the next needs one again, and only the one after it two.
      const failed = await storeSolving(alice, 'fail #news');
      expect([failed.res.statusCode, failed.steps]).toEqual([500, ['1/1']]);
      expect((await storeSolving(alice, 'three #news')).steps).toEqual(['1/1']);

      // Two posts at once each get their own run of two challenges, but only one can use its run.
      const runs = await Promise.all(['four #news', 'five #news'].map((text) => storeText(alice, text)));
      const lasts = await Promise.all(
        runs.map(async (r, i) => {
          const second = await storeText(alice, ['four #news', 'five #news'][i]!, await ctx.solve(r.json().challenge));
          expect(second.json().challenge).toMatchObject({ step: 2, steps: 2 });
          return ctx.solve(second.json().challenge);
        }),
      );
      expect((await storeText(alice, 'four #news', lasts[0]!)).statusCode).toBe(201);
      const late = await storeText(alice, 'five #news', lasts[1]!);
      // The one that lost solves a new run, which is no longer than the one it lost.
      expect(late.json()).toMatchObject({ error: 'another post went through meanwhile; solve 2 new challenges to post', challenge: { step: 1, steps: 2 } });
      const five = await storeSolving(alice, 'five #news');
      expect([five.res.statusCode, five.steps]).toEqual([201, ['1/2', '2/2']]);
    });

    it('refuses a post past three in a minute outright, before any challenge, until the oldest is a minute old', async () => {
      ctx.config.postRateLimitPerMinute = 3;
      const alice = await ctx.register('alice');
      const start = ctx.clock.now;
      for (const text of ['one #news', 'two #news', 'three #news']) expect((await storeSolving(alice, text)).res.statusCode).toBe(201);

      // They went through 10 seconds apart.
      const refused = await storeText(alice, 'four #news');
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBe('40');
      expect(refused.json()).toEqual({ error: 'you can post at most 3 times a minute; try again in 40 seconds', retryAfterSeconds: 40 });
      expect(written).toEqual(['one #news', 'two #news', 'three #news']);
      ctx.clock.now = start + 59_500;
      expect((await storeText(alice, 'four #news')).json().error).toBe('you can post at most 3 times a minute; try again in 1 second');

      // A refused post isn't a post or a challenge, so the run went on, and the next needs two challenges.
      ctx.clock.now = start + 60_000;
      const four = await storeSolving(alice, 'four #news');
      expect([four.res.statusCode, four.steps]).toEqual([201, ['1/2', '2/2']]);

      ctx.config.postRateLimitPerMinute = 1;
      expect((await storeText(alice, 'five #news')).json().error).toBe('you can post at most once a minute; try again in 60 seconds');
    });

    it('counts only posts that go through, and lets only as many of concurrent posts through', async () => {
      ctx.config.postRateLimitPerMinute = 3;
      ctx.config.challenge.postWindowSeconds = 0;
      const alice = await ctx.register('alice');
      expect((await storeText(alice, 'fail #news')).statusCode).toBe(500);
      const { contentId } = (await storeText(alice, 'one #news')).json();
      expect((await storeText(alice, 'one #news', { contentId })).json()).toMatchObject({ unchanged: true });

      ctx.clock.now += 30_000;
      const posts = await Promise.all(['a', 'b', 'c', 'd'].map((t) => storeText(alice, `${t} #news`)));
      expect(posts.map((r) => r.statusCode).sort()).toEqual([201, 201, 429, 429]);
      expect(posts.find((r) => r.statusCode === 429)!.json().retryAfterSeconds).toBe(30);

      // 'one' leaves the minute.
      ctx.clock.now += 30_000;
      expect((await storeText(alice, 'e #news')).statusCode).toBe(201);
      const refused = await storeText(alice, 'f #news');
      expect([refused.statusCode, refused.json().retryAfterSeconds]).toEqual([429, 30]);
    });
  });
}
