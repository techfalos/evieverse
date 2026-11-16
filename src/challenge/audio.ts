import { createCipheriv } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFERENCE_LANGUAGE } from '../language.js';
import { ALPHABET } from './image.js';

/**
 * A challenge read out, for people who can't read its image: the same characters, spoken one after
 * another. It is put together from a voice's clips, one for each character of the alphabet, which
 * scripts/build-challenge-voice.mjs records.
 *
 * Each folder of src/challenge/voices is one language's voice, named after the language's code as
 * its file in the languages folder is: voices/en/A.wav is "A" in English. A clip is 16-bit mono PCM at
 * SAMPLE_RATE. A language without a voice is spoken in another's (see Voices.for).
 */

/** The rate of the clips, and of the audio made from them: enough for the consonants that tell one letter's name from another's. */
export const SAMPLE_RATE = 16_000;

/** A language's voice: each character of the alphabet, as samples between -1 and 1. */
export type Voice = ReadonlyMap<string, Float32Array>;

export class Voices {
  /** By the language's code, in lower case. */
  private readonly byCode = new Map<string, Voice>();

  /** `folder` is where the voices came from, for the error that says English's isn't among them. */
  constructor(voices: Iterable<[code: string, voice: Voice]>, folder = 'the voices folder') {
    for (const [code, voice] of voices) this.byCode.set(code.toLowerCase(), voice);
    if (!this.byCode.has(REFERENCE_LANGUAGE)) throw new Error(`${folder} has no ${REFERENCE_LANGUAGE} voice, which the languages without one are spoken in`);
  }

  /** The codes of the languages that have a voice, in lower case. */
  list(): string[] {
    return [...this.byCode.keys()].sort();
  }

  /**
   * The voice of the first of `languages` that has one, each matched as a language of a request is
   * (see Languages.closest): itself, else the same without its last parts (pt-BR is spoken in pt),
   * else another kind of the same language. English's if none of them has one.
   */
  for(...languages: string[]): Voice {
    for (const language of languages) {
      const parts = language.toLowerCase().split('-');
      for (let length = parts.length; length > 0; length--) {
        const voice = this.byCode.get(parts.slice(0, length).join('-'));
        if (voice) return voice;
      }
      const kind = this.list().find((code) => code.startsWith(`${parts[0]}-`));
      if (kind) return this.byCode.get(kind)!;
    }
    return this.byCode.get(REFERENCE_LANGUAGE)!;
  }
}

/** The samples of a clip. Throws unless the file is a WAV of 16-bit mono PCM at SAMPLE_RATE. */
function readClip(path: string): Float32Array {
  const wav = readFileSync(path);
  const not = (what: string) => new Error(`the voice clip ${path} must be a WAV of 16-bit mono PCM at ${SAMPLE_RATE} Hz: ${what}`);
  if (wav.length < 12 || wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') throw not('it is no WAV');
  let format: { pcm: boolean; channels: number; rate: number; bits: number } | undefined;
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString('latin1', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const body = wav.subarray(at + 8, at + 8 + size);
    if (id === 'fmt ' && body.length >= 16) {
      format = { pcm: body.readUInt16LE(0) === 1, channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') {
      if (!format) throw not('its format comes after its samples');
      if (!format.pcm || format.channels !== 1 || format.bits !== 16) throw not(`it is ${format.pcm ? '' : 'not PCM, '}${format.bits}-bit with ${format.channels} channels`);
      if (format.rate !== SAMPLE_RATE) throw not(`it is at ${format.rate} Hz`);
      const samples = new Float32Array(body.length >> 1);
      for (let i = 0; i < samples.length; i++) samples[i] = body.readInt16LE(i * 2) / 32768;
      if (samples.length === 0) throw not('it has no samples');
      return samples;
    }
    // A chunk of odd size is followed by a byte of padding.
    at += 8 + size + (size & 1);
  }
  throw not('it has no samples');
}

/** src/challenge/voices, or dist/challenge/voices beside the built server. */
const VOICES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'voices');

/**
 * The voices of `dir`: one per folder, whose name is the language's code. A voice that lacks a
 * character, or has a clip that can't be read, is an error, so the server doesn't start with a
 * challenge it couldn't read out.
 */
export function loadVoices(dir: string = VOICES_DIR): Voices {
  const voices: [string, Voice][] = [];
  for (const code of readdirSync(dir).sort()) {
    const folder = join(dir, code);
    if (!statSync(folder).isDirectory()) continue;
    const have = new Set(readdirSync(folder));
    const missing = [...ALPHABET].filter((character) => !have.has(`${character}.wav`));
    if (missing.length > 0) {
      throw new Error(`the voice ${folder} lacks ${missing.map((character) => `${character}.wav`).join(', ')}: scripts/build-challenge-voice.mjs records a voice`);
    }
    voices.push([code, new Map([...ALPHABET].map((character) => [character, readClip(join(folder, `${character}.wav`))]))]);
  }
  return new Voices(voices, dir);
}

let shipped: Voices | undefined;
/** The voices the server ships, read once per process. */
export const shippedVoices = (): Voices => (shipped ??= loadVoices());

/** Random bytes that `seed` alone decides: AES in counter mode, so they can't be told from the ones before them. */
function keystream(seed: Buffer): (bytes: number) => Buffer {
  const cipher = createCipheriv('aes-128-ctr', seed, Buffer.alloc(16));
  return (bytes) => cipher.update(Buffer.alloc(bytes));
}

/** A clip played `rate` times as fast, and so as much higher. */
function atRate(clip: Float32Array, rate: number): Float32Array {
  const out = new Float32Array(Math.floor((clip.length - 1) / rate));
  for (let i = 0; i < out.length; i++) {
    const t = i * rate;
    const at = Math.floor(t);
    out[i] = clip[at]! + (clip[at + 1]! - clip[at]!) * (t - at);
  }
  return out;
}

/** A 16-bit mono WAV of `samples`, which are between -1 and 1. */
function encodeWav(samples: Float32Array): Buffer {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF', 0, 'latin1');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8, 'latin1');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'latin1');
  wav.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  return wav;
}

/**
 * `text` spoken in `voice`, a character at a time, as a WAV. `seed` (16 bytes) decides everything
 * about it that the text doesn't, so the same challenge sounds the same however often it is asked
 * for: a client can ask for parts of it (Range), and asking again gives no second take to compare.
 *
 * Each character is played a little faster or slower than it was recorded, and so higher or lower,
 * and louder or quieter, with pauses of uneven length between them and a hiss under it all. That
 * keeps two challenges from holding the same bytes for the same character, and no more: it is
 * kept light, because the audio is for people to make out, and what a person can make out here a
 * speech recogniser can too. The image keeps robots out better than this does. What they have in
 * common is the rest of a challenge: its single use, its proof of work and the limits around it.
 */
export function renderSpoken(text: string, voice: Voice, seed: Buffer): Buffer {
  const draw = keystream(seed);
  const next = () => draw(4).readUInt32LE() / 2 ** 32;
  const range = (lo: number, hi: number) => lo + (hi - lo) * next();
  const seconds = (s: number) => Math.round(s * SAMPLE_RATE);

  const lead = seconds(range(0.25, 0.45));
  const spoken = [...text].map((character) => {
    const clip = voice.get(character);
    if (!clip) throw new Error(`the voice has no clip for "${character}"`);
    return { samples: atRate(clip, range(0.9, 1.1)), gain: range(0.7, 1), pause: seconds(range(0.3, 0.6)) };
  });
  const out = new Float32Array(spoken.reduce((length, { samples, pause }) => length + samples.length + pause, lead));
  let at = lead;
  for (const { samples, gain, pause } of spoken) {
    for (let i = 0; i < samples.length; i++) out[at + i] = samples[i]! * gain;
    at += samples.length + pause;
  }

  // White noise through a one-pole low-pass, brought back to `level` (the filter leaves (1 - a) / (1 + a)
  // of the power of noise that is uniform in [-1, 1), which is 1/3), swelling and fading slowly.
  const level = range(0.012, 0.025);
  const a = range(0.3, 0.8);
  const scale = level / Math.sqrt((1 - a) / (1 + a) / 3);
  const swell = (2 * Math.PI * range(0.3, 1)) / SAMPLE_RATE;
  const phase = range(0, 2 * Math.PI);
  const noise = draw(out.length * 2);
  let low = 0;
  for (let i = 0; i < out.length; i++) {
    low = a * low + (1 - a) * (noise.readInt16LE(i * 2) / 32768);
    out[i] = out[i]! + low * scale * (1 + 0.4 * Math.sin(i * swell + phase));
  }
  return encodeWav(out);
}
