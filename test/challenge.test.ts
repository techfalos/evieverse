import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadVoices, renderSpoken, SAMPLE_RATE, shippedVoices, Voices, type Voice } from '../src/challenge/audio.js';
import { challengeKey, Challenges, leadingZeroBits } from '../src/challenge/challenges.js';
import type { Challenge } from '../src/challenge/challenges.types.js';
import { ALPHABET, ANSWER_LENGTH, challengeText, HEIGHT, renderChallenge, WIDTH } from '../src/challenge/image.js';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { payloadOf } from '../src/pending.js';
import type { CommentPutPayload, PostPayload } from '../src/pending.types.js';
import { as, createTestContext, multipart, requests, TARGETS, type TestContext, type User } from './helpers.js';

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

/** The samples of a 16-bit mono WAV at the rate challenges are read out at, between -1 and 1. */
function decodeWav(wav: Buffer) {
  expect([wav.toString('latin1', 0, 4), wav.toString('latin1', 8, 16), wav.toString('latin1', 36, 40)]).toEqual(['RIFF', 'WAVEfmt ', 'data']);
  expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  // PCM, one channel, the rate, the bytes a second, the bytes a sample, the bits a sample.
  expect([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt32LE(28), wav.readUInt16LE(32), wav.readUInt16LE(34)]).toEqual([1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16]);
  expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
  return Float32Array.from({ length: (wav.length - 44) / 2 }, (_, i) => wav.readInt16LE(44 + i * 2) / 32768);
}

/**
 * How long each stretch of speech lasts, in seconds, in the order they are heard: the stretches
 * louder than the hiss, taking a break of less than a fifth of a second (the stop of a "k", a "t")
 * to be within one.
 */
function utterances(samples: Float32Array): number[] {
  const window = SAMPLE_RATE / 50;
  const loud = Array.from({ length: Math.floor(samples.length / window) }, (_, w) => {
    const part = samples.subarray(w * window, (w + 1) * window);
    return Math.sqrt(part.reduce((sum, v) => sum + v * v, 0) / window) > 0.06;
  });
  const stretches: { from: number; to: number }[] = [];
  loud.forEach((is, w) => {
    if (!is) return;
    const last = stretches.at(-1);
    if (last && w - last.to <= 10) last.to = w + 1;
    else stretches.push({ from: w, to: w + 1 });
  });
  return stretches.map(({ from, to }) => (to - from) / 50);
}

describe('challenge audio', () => {
  const english = shippedVoices().for('en');
  const seed = (n: number) => createHash('sha256').update(`seed ${n}`).digest().subarray(0, 16);

  it('ships an English voice with a clip of its own for every character of the alphabet', () => {
    expect(shippedVoices().list()).toContain('en');
    expect([...english.keys()].join('')).toBe(ALPHABET);
    for (const [character, clip] of english) {
      expect(clip.length / SAMPLE_RATE, character).toBeGreaterThan(0.25);
      expect(clip.length / SAMPLE_RATE, character).toBeLessThan(0.8);
      // Each as loud as the others, so none is told by how loud it is.
      expect(clip.reduce((max, v) => Math.max(max, Math.abs(v)), 0), character).toBeCloseTo(0.9, 2);
    }
    expect(new Set([...english.values()].map((clip) => createHash('sha256').update(Buffer.from(clip.buffer)).digest('hex'))).size).toBe(ALPHABET.length);
  });

  it('reads the characters out one after another, in their order, as a WAV that is the same every time for the same seed', () => {
    // "W" takes about twice as long to say as "E".
    const wav = renderSpoken('WEEWEW', english, seed(1));
    const said = utterances(decodeWav(wav));
    expect(said).toHaveLength(6);
    expect(said.map((seconds) => (seconds > 0.43 ? 'W' : 'E')).join('')).toBe('WEEWEW');

    expect(renderSpoken('WEEWEW', english, seed(1)).equals(wav)).toBe(true);
    expect(renderSpoken('WEEWEW', english, seed(2)).equals(wav)).toBe(false);
    expect(renderSpoken('WEEWEA', english, seed(1)).equals(wav)).toBe(false);
    // Another seed says the same characters at other speeds, with other pauses.
    expect(wav.length).not.toBe(renderSpoken('WEEWEW', english, seed(2)).length);

    // Every character is heard over the hiss, whatever the seed, in a few seconds that take a couple of hundred kilobytes at most.
    for (let n = 0; n < 40; n++) {
      const text = Array.from({ length: ANSWER_LENGTH }, (_, i) => ALPHABET[(n * ANSWER_LENGTH + i) % ALPHABET.length]).join('');
      const samples = decodeWav(renderSpoken(text, english, seed(n)));
      expect(utterances(samples), text).toHaveLength(ANSWER_LENGTH);
      expect(samples.length / SAMPLE_RATE).toBeGreaterThan(3.5);
      expect(samples.length / SAMPLE_RATE).toBeLessThan(8);
    }
    expect(() => renderSpoken('A0', english, seed(1))).toThrow('the voice has no clip for "0"');
  });

  it("speaks a language in its own voice, else in the closest one's, else in English", () => {
    const voice = (): Voice => new Map(english);
    const [en, pt, esMX] = [voice(), voice(), voice()];
    const voices = new Voices([['en', en], ['pt', pt], ['es-MX', esMX]]);
    expect(voices.list()).toEqual(['en', 'es-mx', 'pt']);
    expect(voices.for('pt')).toBe(pt);
    expect(voices.for('PT-br')).toBe(pt);
    expect(voices.for('es')).toBe(esMX);
    expect(voices.for('es-ES')).toBe(esMX);
    expect(voices.for('de')).toBe(en);
    // The server's default language comes before English.
    expect(voices.for('de', 'pt-BR')).toBe(pt);
    expect(voices.for('es-AR', 'pt-BR')).toBe(esMX);
    expect(() => new Voices([['pt', pt]], '/voices')).toThrow('/voices has no en voice');
  });

  it("doesn't load a voice that lacks a character, or a clip that isn't 16-bit mono PCM at the rate", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evieverse-voices-'));
    try {
      const shipped = join(import.meta.dirname, '../src/challenge/voices/en');
      await cp(shipped, join(dir, 'en'), { recursive: true });
      await cp(shipped, join(dir, 'pt-BR'), { recursive: true });
      // A file beside the folders is no voice.
      await writeFile(join(dir, 'notes.txt'), 'voices');
      const loaded = loadVoices(dir);
      expect(loaded.list()).toEqual(['en', 'pt-br']);
      expect(renderSpoken('ACDEFG', loaded.for('pt-BR'), seed(1)).equals(renderSpoken('ACDEFG', english, seed(1)))).toBe(true);

      await rm(join(dir, 'pt-BR/W.wav'));
      await rm(join(dir, 'pt-BR/7.wav'));
      expect(() => loadVoices(dir)).toThrow(/pt-BR lacks W\.wav, 7\.wav: scripts\/build-challenge-voice\.mjs records a voice/);
      await rm(join(dir, 'pt-BR'), { recursive: true });

      const clip = await readFile(join(shipped, 'A.wav'));
      const at8k = Buffer.from(clip);
      at8k.writeUInt32LE(8000, 24);
      await writeFile(join(dir, 'en/A.wav'), at8k);
      expect(() => loadVoices(dir)).toThrow(/en\/A\.wav must be a WAV of 16-bit mono PCM at 16000 Hz: it is at 8000 Hz/);
      const stereo = Buffer.from(clip);
      stereo.writeUInt16LE(2, 22);
      await writeFile(join(dir, 'en/A.wav'), stereo);
      expect(() => loadVoices(dir)).toThrow(/it is 16-bit with 2 channels/);
      await writeFile(join(dir, 'en/A.wav'), 'not a recording');
      expect(() => loadVoices(dir)).toThrow(/it is no WAV/);

      await rm(join(dir, 'en'), { recursive: true });
      expect(() => loadVoices(dir)).toThrow(/has no en voice/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('CHALLENGE_COMMENTS_PER_MINUTE', () => {
  it('is 3 unless set, beside the 10 comments a minute that are the most, and 0 comments a minute challenges none', () => {
    const load = (env: Record<string, string> = {}) => loadConfig({}, { EVIEVERSE_CONFIG: '/nonexistent.json', ...env });
    expect([load().challenge.commentsPerMinute, load().comments.perMinute]).toEqual([3, 10]);
    expect(load({ CHALLENGE_COMMENTS_PER_MINUTE: '5', COMMENTS_PER_MINUTE: '20' })).toMatchObject({ challenge: { commentsPerMinute: 5 }, comments: { perMinute: 20 } });
    expect(load({ CHALLENGE_COMMENTS_PER_MINUTE: '0' }).challenge.commentsPerMinute).toBe(0);
    expect(() => load({ CHALLENGE_COMMENTS_PER_MINUTE: '-1' })).toThrow();
  });
});

for (const target of TARGETS) {
  describe(`challenges (${target.name})`, () => {
    let ctx: TestContext;
    /** The texts of the posts and comments that got as far as their commit, which is all of a request's write. */
    let written: string[];
    /** Writes wait for this before they commit, while set. */
    let hold: Promise<void> | null;
    beforeEach(async () => {
      written = [];
      hold = null;
      // As a server has them: a post window of a minute, and no answer accepted within 2 seconds.
      ctx = await createTestContext(target, { challenge: { postWindowSeconds: 60, minSolveMs: 2000 } });
      // A write whose text starts with "fail" fails as its commit would: nothing of it is kept.
      const transaction = ctx.db.transaction.bind(ctx.db);
      const seen = new Set<string>();
      vi.spyOn(ctx.db, 'transaction').mockImplementation(
        () =>
          ({
            execute: async (fn: (trx: Parameters<Parameters<ReturnType<typeof transaction>['execute']>[0]>[0]) => Promise<unknown>) => {
              await hold;
              return transaction().execute(async (trx) => {
                const out = await fn(trx);
                for (const row of await trx.selectFrom('pending_writes').select(['content_id', 'seq', 'kind', 'payload']).where('kind', 'in', ['post', 'comment_put']).execute()) {
                  const key = `${row.content_id}:${row.seq}`;
                  if (seen.has(key)) continue;
                  const text = row.kind === 'post' ? payloadOf<PostPayload>(row.payload).meta.text! : payloadOf<CommentPutPayload>(row.payload).comment.text;
                  written.push(text);
                  if (text.startsWith('fail')) throw new Error('storage unavailable');
                  seen.add(key);
                }
                return out;
              });
            },
          }) as never,
      );
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await ctx.close();
    });

    const register = (payload: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/register', payload });
    const { storeText, post } = requests(() => ctx);
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
        audio: `/challenges/${challenge.id}/audio`,
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

    it('reads a challenge out to whoever has it, as often as they ask and in the parts they ask for, until it is answered or too old', async () => {
      /** What the server keeps of a challenge. */
      const kept = async (c: Challenge) => JSON.parse((await ctx.hot.get(challengeKey(c.id)))!.toString('utf8')) as { answer: string; seed: string; language: string };
      const listen = (c: Challenge, headers: Record<string, string> = {}) => ctx.app.inject({ method: 'GET', url: c.audio, headers });

      ctx.config.publicBaseUrl = 'https://social.example';
      const c = await newChallenge('alice');
      expect(c.audio).toBe(`https://social.example/challenges/${c.id}/audio`);
      ctx.config.publicBaseUrl = '';
      const url = `/challenges/${c.id}/audio`;

      // The characters of the image, spoken in the language the challenge came in, by nobody's credentials.
      const { answer, seed, language } = await kept(c);
      expect(language).toBe('en');
      const spoken = renderSpoken(answer, shippedVoices().for('en'), Buffer.from(seed, 'base64'));
      const heard = await ctx.app.inject({ method: 'GET', url, headers: { 'accept-encoding': 'gzip, br' } });
      expect(heard.statusCode, heard.body).toBe(200);
      expect(heard.headers).toMatchObject({ 'content-type': 'audio/wav', 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'content-length': String(spoken.length) });
      expect(heard.headers['content-encoding']).toBeUndefined();
      expect(heard.rawPayload.equals(spoken)).toBe(true);
      expect(utterances(decodeWav(heard.rawPayload))).toHaveLength(ANSWER_LENGTH);
      // The same again, so the parts of it a browser asks for are parts of one recording.
      expect((await ctx.app.inject({ method: 'GET', url })).rawPayload.equals(spoken)).toBe(true);
      const head = await ctx.app.inject({ method: 'HEAD', url });
      expect([head.statusCode, head.headers['content-length'], head.rawPayload.length]).toEqual([200, String(spoken.length), 0]);

      /** The status and Content-Range a Range header is answered with, and whether the bytes are `bytes`. */
      const part = async (range: string, bytes: Buffer) => {
        const res = await ctx.app.inject({ method: 'GET', url, headers: { range } });
        return [res.statusCode, res.headers['content-range'], res.rawPayload.equals(bytes)];
      };
      const size = spoken.length;
      expect(await part('bytes=0-1', spoken.subarray(0, 2))).toEqual([206, `bytes 0-1/${size}`, true]);
      expect(await part('bytes=44-1043', spoken.subarray(44, 1044))).toEqual([206, `bytes 44-1043/${size}`, true]);
      expect(await part(`bytes=${size - 100}-`, spoken.subarray(size - 100))).toEqual([206, `bytes ${size - 100}-${size - 1}/${size}`, true]);
      expect(await part('bytes=-10', spoken.subarray(size - 10))).toEqual([206, `bytes ${size - 10}-${size - 1}/${size}`, true]);
      expect(await part(`bytes=0-${size + 5000}`, spoken)).toEqual([206, `bytes 0-${size - 1}/${size}`, true]);
      expect(await part(`bytes=${size}-`, Buffer.alloc(0))).toEqual([416, `bytes */${size}`, true]);
      // What isn't one range of bytes is answered whole.
      for (const range of ['bytes=0-1, 4-5', 'samples=0-1', 'bytes=-']) expect(await part(range, spoken)).toEqual([200, undefined, true]);

      // Listening used nothing up: the challenge is answered once, and is then no longer read out.
      ctx.clock.now += 5000;
      const done = await register({ username: 'alice', ...(await ctx.solve(c)) });
      expect(done.statusCode, done.body).toBe(201);
      const after = await listen(c);
      expect([after.statusCode, after.json()]).toEqual([404, { error: 'the challenge has expired or was already used' }]);
      expect((await ctx.app.inject({ method: 'GET', url: `/challenges/${randomUUID()}/audio` })).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'GET', url: '/challenges/nope/audio' })).statusCode).toBe(400);

      // One too old to be answered isn't read out either.
      const late = await newChallenge('bob');
      expect((await listen(late)).statusCode).toBe(200);
      ctx.clock.now += 120_001;
      const tooLate = await listen(late);
      expect([tooLate.statusCode, tooLate.json()]).toEqual([404, { error: 'the challenge has expired' }]);

      // A challenge to post is read out as one to register is.
      const alice = done.json() as User;
      await storeText(alice, 'first #news');
      const toPost = (await storeText(alice, 'second #news')).json().challenge as Challenge;
      const posted = await listen(toPost);
      expect([posted.statusCode, posted.headers['content-type']]).toEqual([200, 'audio/wav']);
      expect(posted.rawPayload.equals(renderSpoken((await kept(toPost)).answer, shippedVoices().for('en'), Buffer.from((await kept(toPost)).seed, 'base64')))).toBe(true);
      expect((await storeText(alice, 'second #news', await ctx.solve(toPost))).statusCode).toBe(201);
    });

    it('reads a challenge out in the voice of the language it was issued in, or of the default language where that has none', async () => {
      const english = shippedVoices().for('en');
      // A voice that says each character as the English one says the next, to tell it by.
      const other: Voice = new Map([...ALPHABET].map((character, i) => [character, english.get(ALPHABET[(i + 1) % ALPHABET.length]!)!]));
      const challenges = new Challenges({ hot: ctx.hot, config: ctx.config, now: () => ctx.clock.now, voices: new Voices([['en', english], ['pt', other]]) });
      const spokenBy = async (language: string) => {
        const c = await challenges.issue('register', language);
        const { answer, seed } = JSON.parse((await ctx.hot.get(challengeKey(c.id)))!.toString('utf8')) as { answer: string; seed: string };
        const wav = await challenges.audio(c.id);
        return [english, other].map((voice) => wav.equals(renderSpoken(answer, voice, Buffer.from(seed, 'base64'))));
      };
      expect(await spokenBy('en')).toEqual([true, false]);
      expect(await spokenBy('pt-BR')).toEqual([false, true]);
      expect(await spokenBy('de')).toEqual([true, false]);
      ctx.config.defaultLanguage = 'pt';
      expect(await spokenBy('de')).toEqual([false, true]);
    });

    it('has no setting that spares a registration its challenge', async () => {
      // What once turned it off, in the environment or in a config file, is no setting now, and changes nothing.
      const off = loadConfig({ challenge: { register: false } }, { EVIEVERSE_CONFIG: '/nonexistent.json' });
      expect(off.challenge).toEqual({ postWindowSeconds: 60, commentsPerMinute: 3, ttlSeconds: 120, powBits: 18, minSolveMs: 2000 });

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
      expect(written).toHaveLength(2);
      release();
      expect((await Promise.all(posts)).map((r) => r.statusCode).sort()).toEqual([201, 428, 428]);
      expect(written).toHaveLength(3);
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

    /** A post of alice's that takes comments, and bob to comment on it, on a server that limits comments as one does: 3 a minute with no challenge, 10 at most. */
    const commented = async () => {
      ctx.config.challenge.commentsPerMinute = 3;
      ctx.config.comments.perMinute = 10;
      const alice = await ctx.register('alice');
      const bob = await ctx.register('bob');
      return { alice, bob, contentId: await post(alice, 'Talk to me #news', { comments: true }) };
    };
    const comment = (user: User, contentId: string, text: string, extra: Record<string, unknown> = {}) =>
      ctx.app.inject({ method: 'POST', url: `/content/${contentId}/comments`, payload: { ...user, text, ...extra } });
    const edit = (user: User, contentId: string, commentId: string, text: string, extra: Record<string, unknown> = {}) =>
      ctx.app.inject({ method: 'PATCH', url: `/content/${contentId}/comments/${commentId}`, payload: { ...user, text, ...extra } });
    const commentTexts = async (contentId: string) =>
      ((await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/comments` })).json().comments as { text: string }[]).map((c) => c.text);
    /** Sends a request, solving every challenge it's answered with, `thinkMs` each; returns the last answer, and each challenge's step. */
    const solving = async (send: (solution?: Record<string, unknown>) => ReturnType<typeof comment>, thinkMs = 10_000) => {
      const steps: string[] = [];
      let res = await send();
      while (res.statusCode === 428) {
        const c = res.json().challenge as Challenge;
        steps.push(`${c.step}/${c.steps}`);
        res = await send(await ctx.solve(c, thinkMs));
      }
      return { res, steps };
    };
    /** The challenges a comment took to be stored. */
    const commentSteps = async (user: User, contentId: string, text: string, thinkMs?: number) => {
      const { res, steps } = await solving((solution) => comment(user, contentId, text, solution), thinkMs);
      expect(res.statusCode, res.body).toBe(201);
      return steps;
    };

    it('lets three comments a minute through at once, and asks each one past them for 1, 1, then 2 challenges, before anything is stored', async () => {
      const { bob, contentId } = await commented();
      for (const text of ['one', 'two', 'three']) expect((await comment(bob, contentId, text)).statusCode).toBe(201);

      const fourth = await comment(bob, contentId, 'four');
      expect(fourth.statusCode).toBe(428);
      expect(fourth.json()).toMatchObject({ error: 'you commented 3 times in the last minute; solve the challenge to comment', challenge: { step: 1, steps: 1 } });
      expect(await commentTexts(contentId)).toEqual(['one', 'two', 'three']);
      expect((await comment(bob, contentId, 'four', await ctx.solve(fourth.json().challenge))).statusCode).toBe(201);

      // Posts and comments are limited apart: a post needs no challenge for the comments before it,
      // a challenge to post lets no comment through, and one to comment lets no post through.
      expect((await storeText(bob, 'hello #news')).statusCode).toBe(201);
      const toPost = (await storeText(bob, 'hello again #news')).json().challenge as Challenge;
      const fifth = await comment(bob, contentId, 'five', await ctx.solve(toPost));
      expect(fifth.statusCode).toBe(428);
      expect(fifth.json()).toMatchObject({ error: 'the challenge was issued for another request; solve the new challenge to comment', challenge: { step: 1, steps: 1 } });
      const posted = await storeText(bob, 'hello again #news', await ctx.solve(fifth.json().challenge));
      expect([posted.statusCode, posted.json().error]).toEqual([428, 'the challenge was issued for another request; solve the new challenge to post']);
      expect(await commentSteps(bob, contentId, 'five', 2000)).toEqual(['1/1']);

      // From the third challenged comment in a row, two challenges, one after another, and never more.
      const sixth = await comment(bob, contentId, 'six');
      expect(sixth.json()).toMatchObject({ error: 'you commented 5 times in the last minute; solve 2 challenges to comment', challenge: { step: 1, steps: 2 } });
      const next = await comment(bob, contentId, 'six', await ctx.solve(sixth.json().challenge));
      expect(next.json()).toMatchObject({ error: 'solved 1 of 2; solve the next challenge', challenge: { step: 2, steps: 2 } });
      const solution = await ctx.solve(next.json().challenge);
      const wrongAnswer = solution.challengeAnswer.replace(/^./, (ch) => (ch === 'A' ? 'C' : 'A'));
      const wrong = await comment(bob, contentId, 'six', { ...solution, challengeAnswer: wrongAnswer });
      expect(wrong.json()).toMatchObject({ error: 'the characters are wrong; solve the new challenge', challenge: { step: 2, steps: 2 } });
      expect((await comment(bob, contentId, 'six', await ctx.solve(wrong.json().challenge))).statusCode).toBe(201);
      expect(await commentSteps(bob, contentId, 'seven', 2000)).toEqual(['1/2', '2/2']);
      expect(await commentTexts(contentId)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven']);

      // A form's fields answer a challenge as a JSON body's do.
      const asked = await comment(bob, contentId, 'eight');
      const form = multipart({ text: 'eight', ...(await ctx.solve(asked.json().challenge)) });
      const second = await ctx.app.inject({ method: 'POST', url: `/content/${contentId}/comments`, payload: form.payload, headers: { ...form.headers, ...as(bob) } });
      expect(second.json().challenge).toMatchObject({ step: 2, steps: 2 });
    });

    it('challenges a comment by the comments of the last minute, and starts the run over after a minute without a challenged comment or a challenge', async () => {
      const { bob, contentId } = await commented();
      const start = ctx.clock.now;
      const steps = (text: string) => commentSteps(bob, contentId, text);
      // Three at once, then one every 10 or 20 seconds: a challenge takes 10 seconds to solve.
      for (const text of ['one', 'two', 'three']) expect(await steps(text)).toEqual([]);
      expect(await steps('four')).toEqual(['1/1']);
      expect(await steps('five')).toEqual(['1/1']);
      expect(ctx.clock.now).toBe(start + 20_000);

      // The first three are a minute old: the two since leave room for one comment with no challenge, and no more.
      ctx.clock.now = start + 60_000;
      expect(await steps('six')).toEqual([]);
      // The run went on meanwhile, since its last challenge was less than a minute ago: this is its third.
      expect(await commentSteps(bob, contentId, 'seven', 2000)).toEqual(['1/2', '2/2']);

      // A user's own comments alone count, on whichever posts.
      const carol = await ctx.register('carol');
      for (const text of ['hers', 'hers too', 'and this']) expect(await commentSteps(carol, contentId, text)).toEqual([]);

      // A minute after the run's last challenge, with no comment since: the run is over, and so is the minute.
      ctx.clock.now += 60_000;
      for (const text of ['eight', 'nine', 'ten']) expect(await steps(text)).toEqual([]);
      const eleventh = await comment(bob, contentId, 'eleven');
      expect(eleventh.json()).toMatchObject({ error: 'you commented 3 times in the last minute; solve the challenge to comment', challenge: { step: 1, steps: 1 } });
      // A challenge that isn't solved holds nothing up: the comment needs none once the three are a minute old.
      ctx.clock.now += 59_000;
      expect((await comment(bob, contentId, 'eleven')).statusCode).toBe(428);
      ctx.clock.now += 1000;
      expect((await comment(bob, contentId, 'eleven')).statusCode).toBe(201);
    });

    it('limits an edit of a comment as a comment, and counts it as one', async () => {
      const { bob, contentId } = await commented();
      const { commentId } = (await comment(bob, contentId, 'one')).json();
      expect((await edit(bob, contentId, commentId, 'one, edited')).statusCode).toBe(200);
      expect((await comment(bob, contentId, 'two')).statusCode).toBe(201);
      // The text it has isn't an edit: it needs no challenge, and counts for nothing.
      expect((await edit(bob, contentId, commentId, 'one, edited')).json()).toMatchObject({ unchanged: true });

      const asked = await edit(bob, contentId, commentId, 'one, edited again');
      expect(asked.statusCode).toBe(428);
      expect(asked.json()).toMatchObject({ error: 'you commented 3 times in the last minute; solve the challenge to comment', challenge: { step: 1, steps: 1 } });
      expect(await commentTexts(contentId)).toEqual(['one, edited', 'two']);
      const { res, steps } = await solving((solution) => edit(bob, contentId, commentId, 'one, edited again', solution));
      expect([res.statusCode, steps]).toEqual([200, ['1/1']]);
      expect(await commentTexts(contentId)).toEqual(['one, edited again', 'two']);
      // The edit was a challenged comment, so the next is the second in a row, and the one after it the third.
      expect(await commentSteps(bob, contentId, 'three')).toEqual(['1/1']);
      expect((await solving((solution) => edit(bob, contentId, commentId, 'one, at last', solution))).steps).toEqual(['1/2', '2/2']);
    });

    it('refuses a comment past ten in a minute outright, before any challenge, until the oldest is a minute old', async () => {
      const { bob, contentId } = await commented();
      // Ten in 50 seconds, which takes solving each challenge in 4.
      const start = ctx.clock.now;
      const taken: string[][] = [];
      for (let i = 1; i <= 10; i++) taken.push(await commentSteps(bob, contentId, `comment ${i}`, 4000));
      expect(taken).toEqual([[], [], [], ['1/1'], ['1/1'], ...Array.from({ length: 5 }, () => ['1/2', '2/2'])]);
      expect(ctx.clock.now).toBe(start + 48_000);

      const refused = await comment(bob, contentId, 'comment 11');
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBe('12');
      expect(refused.json()).toEqual({ error: 'too many comments; try again in 12 seconds', retryAfterSeconds: 12 });
      // An edit is one comment too many as well.
      const { commentId } = (await ctx.app.inject({ method: 'GET', url: `/content/${contentId}/comments` })).json().comments[0];
      expect((await edit(bob, contentId, commentId, 'comment 1, edited')).statusCode).toBe(429);
      expect(await commentTexts(contentId)).toHaveLength(10);

      // The first three leave the minute together. A refused comment isn't a comment or a challenge, so the run went on.
      ctx.clock.now = start + 60_000;
      expect(await commentSteps(bob, contentId, 'comment 11', 2000)).toEqual(['1/2', '2/2']);

      // The limit alone, where comments are never challenged.
      ctx.config.challenge.commentsPerMinute = 0;
      ctx.config.comments.perMinute = 2;
      const carol = await ctx.register('carol');
      const answers = await Promise.all(['a', 'b', 'c', 'd'].map((text) => comment(carol, contentId, text)));
      expect(answers.map((r) => r.statusCode).sort()).toEqual([201, 201, 429, 429]);
      expect(answers.find((r) => r.statusCode === 429)!.json().error).toBe('too many comments; try again in 60 seconds');
    });

    it('counts only comments that are stored, and passes only three of concurrent comments without a challenge', async () => {
      const { bob, contentId } = await commented();

      // One that fails gives its place in the minute back, and one that is refused never took one.
      for (const text of ['fail', 'fail again', 'fail once more']) expect((await comment(bob, contentId, text)).statusCode).toBe(500);
      expect((await comment(bob, contentId, 'lost', { parentId: randomUUID() })).statusCode).toBe(404);
      const answers = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((text) => comment(bob, contentId, text)));
      expect(answers.map((r) => r.statusCode).sort()).toEqual([201, 201, 201, 428, 428]);
      const passed = ['a', 'b', 'c', 'd', 'e'].filter((_, i) => answers[i]!.statusCode === 201);

      // The two that were challenged each solve theirs, but only one of them can use it: the run has one place at each point.
      const [first, second] = answers.filter((r) => r.statusCode === 428).map((r) => r.json().challenge as Challenge);
      const solutions = [await ctx.solve(first!), await ctx.solve(second!)];
      expect((await comment(bob, contentId, 'x', solutions[0])).statusCode).toBe(201);
      const late = await comment(bob, contentId, 'y', solutions[1]);
      expect(late.json()).toMatchObject({ error: 'another comment went through meanwhile; solve the new challenge to comment', challenge: { step: 1, steps: 1 } });

      // One that fails after its challenge gives its place in the run back: the next needs one again, and only the one after it two.
      const failed = await solving((solution) => comment(bob, contentId, 'fail', solution));
      expect([failed.res.statusCode, failed.steps]).toEqual([500, ['1/1']]);
      expect(await commentSteps(bob, contentId, 'y')).toEqual(['1/1']);
      expect(await commentSteps(bob, contentId, 'z')).toEqual(['1/2', '2/2']);
      expect((await commentTexts(contentId)).sort()).toEqual([...passed, 'x', 'y', 'z']);
    });
  });
}
