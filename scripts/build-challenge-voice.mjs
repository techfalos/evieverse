// Records the voice a language's audio challenges are spoken in: one clip for each character a
// challenge can have, as src/challenge/voices/<language>/<character>.wav (see src/challenge/audio.ts).
//
//   node scripts/build-challenge-voice.mjs <language> [<espeak-ng voice>]
//   node scripts/build-challenge-voice.mjs en en-us
//   node scripts/build-challenge-voice.mjs pt-BR
//
// The speech is eSpeak NG's (https://github.com/espeak-ng/espeak-ng), which has to be installed
// (`apt install espeak-ng`, `brew install espeak-ng`) and speaks over a hundred languages:
// `espeak-ng --voices` lists them. Its voice is the language's code unless one is named. What it
// says for each character is printed in its phonemes, to check that they are the characters' names.
//
// Not part of `npm run build`: the clips are kept in the repository, and recorded again only when
// the alphabet changes or a language is added. Any recording will do in their place, a person's
// among them, as long as each file is 16-bit mono PCM at the rate below.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** SAMPLE_RATE of src/challenge/audio.ts, which refuses clips at any other. */
const RATE = 16_000;
/** Words a minute: slower than eSpeak NG's 175, so that no character is clipped short. */
const SPEED = 140;
/** The loudest sample of each clip, of 1: the same for all, so none is told by how loud it is. */
const PEAK = 0.9;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [language, voice = language?.toLowerCase()] = process.argv.slice(2);
if (!language) {
  console.error('usage: node scripts/build-challenge-voice.mjs <language> [<espeak-ng voice>]');
  process.exit(2);
}

const alphabet = /ALPHABET = '([^']+)'/.exec(readFileSync(join(root, 'src/challenge/image.ts'), 'utf8'))?.[1];
if (!alphabet) throw new Error("src/challenge/image.ts doesn't say what ALPHABET is");

function espeak(args) {
  const res = spawnSync('espeak-ng', ['-v', voice, '-s', String(SPEED), ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (res.error?.code === 'ENOENT') throw new Error('espeak-ng is not installed: apt install espeak-ng, or brew install espeak-ng');
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`espeak-ng -v ${voice} failed: ${res.stderr.toString().trim()}`);
  return res.stdout;
}

/** The samples of a 16-bit mono WAV as eSpeak NG writes one to a pipe: its sizes aren't filled in, so the data runs to the end. */
function decode(wav) {
  if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') throw new Error('espeak-ng wrote no WAV');
  const fmt = wav.indexOf('fmt ');
  const data = wav.indexOf('data');
  if (wav.readUInt16LE(fmt + 8) !== 1 || wav.readUInt16LE(fmt + 10) !== 1 || wav.readUInt16LE(fmt + 22) !== 16) throw new Error('espeak-ng wrote a WAV that is not 16-bit mono PCM');
  const samples = new Float64Array(Math.floor((wav.length - data - 8) / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = wav.readInt16LE(data + 8 + i * 2) / 32768;
  return { rate: wav.readUInt32LE(fmt + 12), samples };
}

/** The samples at another rate: a windowed sinc, which takes out what the new rate can't hold before it would fold back. */
function resample(x, from, to) {
  if (from === to) return x;
  const step = from / to;
  const cutoff = Math.min(1, to / from);
  const lobes = 16;
  const reach = lobes / cutoff;
  const y = new Float64Array(Math.floor(x.length / step));
  for (let i = 0; i < y.length; i++) {
    const t = i * step;
    let sum = 0;
    let weight = 0;
    for (let j = Math.max(0, Math.ceil(t - reach)); j <= Math.min(x.length - 1, Math.floor(t + reach)); j++) {
      const d = (j - t) * cutoff;
      const w = (d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d)) * (0.5 + 0.5 * Math.cos((Math.PI * d) / lobes));
      sum += x[j] * w;
      weight += w;
    }
    y[i] = sum / weight;
  }
  return y;
}

/** The clip without the silence around it, but for a moment of it either side, faded in and out, and as loud as the others. */
function tidy(x) {
  const peak = x.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
  if (peak === 0) throw new Error('espeak-ng said nothing');
  const heard = (v) => Math.abs(v) > peak * 0.02;
  const first = x.findIndex(heard);
  const last = x.findLastIndex(heard);
  const clip = x.slice(Math.max(0, first - Math.round(RATE * 0.015)), Math.min(x.length, last + Math.round(RATE * 0.04)));
  const fade = Math.round(RATE * 0.005);
  return clip.map((v, i) => ((v * PEAK) / peak) * Math.min(1, i / fade, (clip.length - 1 - i) / fade));
}

function encode(samples) {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF', 0, 'latin1');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8, 'latin1');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'latin1');
  wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return wav;
}

const dir = join(root, 'src/challenge/voices', language);
mkdirSync(dir, { recursive: true });
for (const character of alphabet) {
  const { rate, samples } = decode(espeak(['--stdout', character]));
  const clip = tidy(resample(samples, rate, RATE));
  writeFileSync(join(dir, `${character}.wav`), encode(clip));
  const phonemes = espeak(['-q', '-x', character]).toString().trim();
  console.log(`${character}  ${phonemes.padEnd(12)} ${(clip.length / RATE).toFixed(2)} s`);
}
console.log(`${alphabet.length} clips in ${dir}, spoken by espeak-ng -v ${voice}`);
