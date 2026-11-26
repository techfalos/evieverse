import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadVoices, renderSpoken, SAMPLE_RATE, shippedVoices, Voices, type Voice } from '../src/challenge/audio.js';
import { challengeKey, Challenges, leadingZeroBits } from '../src/challenge/challenges.js';
import type { Challenge } from '../src/challenge/challenges.types.js';
import { ALPHABET, ANSWER_LENGTH, challengeText, HEIGHT, renderChallenge, WIDTH } from '../src/challenge/image.js';
import { loadConfig } from '../src/config.js';
import { setAdmin } from '../src/moderation/policy.js';
import { as, BASE_ENV, createTestContext, TARGETS, type TestContext, type User } from './helpers.js';

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

for (const target of TARGETS) {
  describe(`challenges (${target.name})`, () => {
    let ctx: TestContext;
    beforeEach(async () => {
      // As a server has it: no answer accepted within 2 seconds.
      ctx = await createTestContext(target, { challenge: { minSolveMs: 2000 } });
    });
    afterEach(() => ctx.close());

    const register = (payload: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/register', payload });
    const newChallenge = (username: string) => ctx.app.inject({ method: 'POST', url: '/register', payload: { username } }).then((r) => r.json().challenge as Challenge);
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
        proofOfWork: { algorithm: 'SHA-256', prefix: `${challenge.id}:`, bits: 8 },
      });
      expect(decodePng(Buffer.from(challenge.image.split(',')[1]!, 'base64'))).toMatchObject({ width: WIDTH, height: HEIGHT });
      expect(await ctx.db.selectFrom('users').selectAll().execute()).toEqual([]);

      // People can type it in any case, with spaces.
      const solution = await ctx.solve(challenge);
      const answer = solution.challengeAnswer.toLowerCase().split('').join(' ');
      const done = await register({ ...payload, ...solution, challengeAnswer: answer });
      expect(done.statusCode, done.body).toBe(201);
      expect(done.json()).toMatchObject({ username: 'alice', apiKey: expect.stringMatching(/^ev_/) });
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

    it('refuses an answer that is wrong, late, too quick or without the work, with a new challenge each time', async () => {
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
      expect(await ctx.db.selectFrom('users').selectAll().execute()).toEqual([]);
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
    });

    it('reads a challenge out in the voice of the language it was issued in, or of the default language where that has none', async () => {
      const english = shippedVoices().for('en');
      // A voice that says each character as the English one says the next, to tell it by.
      const other: Voice = new Map([...ALPHABET].map((character, i) => [character, english.get(ALPHABET[(i + 1) % ALPHABET.length]!)!]));
      const challenges = new Challenges({ hot: ctx.hot, config: ctx.config, now: () => ctx.clock.now, voices: new Voices([['en', english], ['pt', other]]) });
      const spokenBy = async (language: string) => {
        const c = await challenges.issue(language);
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
      const off = loadConfig({ challenge: { register: false } }, BASE_ENV);
      expect(off.challenge).toEqual({ ttlSeconds: 120, powBits: 18, minSolveMs: 2000 });

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
      expect(alice).toMatchObject({ username: 'alice', apiKey: expect.stringMatching(/^ev_/) });
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
  });
}
