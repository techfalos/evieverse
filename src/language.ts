import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import english from '../languages/en.json' with { type: 'json' };
import type { Language, LanguageMessages, Message, MessageParams } from './language.types.js';

/**
 * What the server says: the errors it answers with, and the notes that come with some results.
 * Never what users post, and not the machine-readable values of a response (`status`, `reason`).
 *
 * Each file of the languages folder is one language, named after its code: en.json is English, and
 * pt-BR.json would be Brazilian Portuguese. A file holds the language's own name, and its messages
 * by key:
 *
 *   { "name": "English",
 *     "messages": {
 *       "follow.limit": "you can follow at most {max} users",
 *       "upload.rate_limited": { "one": "… in {count} second", "other": "… in {count} seconds" } } }
 *
 * `{name}` is replaced by the parameter of that name. A message that depends on a number is an
 * object of its forms, by the plural category of its `count` parameter in that language (zero, one,
 * two, few, many, other: what Intl.PluralRules gives), of which `other` must be there.
 *
 * The code says a message by its key (see `msg`), and the key must be one of en.json's, which the
 * compiler checks. A language that lacks a message says it in the server's default language.
 */

/** The language the code's keys are checked against, and the default one unless DEFAULT_LANGUAGE says otherwise. */
export const REFERENCE_LANGUAGE = 'en';

export type MessageKey = keyof typeof english.messages;

/** A message, or words that are said as they are: those of a trust plugin that wrote its own. */
export type Text = Message | string;

/** A message by its key, with the parameters that fill it in. It is in no language yet: `render` says it in one. */
export const msg = (key: MessageKey, params?: MessageParams): Message => ({ key, params });

/** A key where a string is wanted, such as a zod schema's own message, which the error handler then says in the request's language. */
export const messageKey = (key: MessageKey): string => key;

/** A message's words in a language file: one string, or its forms by plural category, of which `other` must be there. Any other key is refused. */
export const Template = z.union([
  z.string(),
  z.strictObject({
    zero: z.string().optional(),
    one: z.string().optional(),
    two: z.string().optional(),
    few: z.string().optional(),
    many: z.string().optional(),
    other: z.string(),
  }),
]);
export type Template = z.infer<typeof Template>;

/** What a file of the languages folder holds: the language's name, and its messages by key. `loadLanguages` reads each file with it. */
const LanguageFile = z.object({
  /** The language's name in the language itself, as a list of languages shows it. */
  name: z.string().trim().min(1).max(64),
  messages: z.record(z.string(), Template),
});

/** A language as `Languages` keeps it: its file's messages, and the plural rules of its code. */
interface Loaded extends LanguageMessages {
  /** Which form of a message a number takes in this language. */
  plurals: Intl.PluralRules;
}

/** The code as BCP 47 writes it ("pt-br" -> "pt-BR"), or undefined if it isn't a language tag. */
function canonical(code: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(code)[0];
  } catch {
    return undefined;
  }
}

export class Languages {
  /** The language of whoever asked for none, and the one a message missing from another is said in. */
  readonly default: string;
  /** By code, in lower case: clients may write a code in any case. */
  private readonly byCode = new Map<string, Loaded>();
  private readonly inOrder: Loaded[];

  /** `folder` is where the languages came from, for the error that says the default one isn't among them. */
  constructor(languages: LanguageMessages[], defaultLanguage: string, folder = 'the languages folder') {
    this.inOrder = languages
      .map((language) => ({ ...language, plurals: new Intl.PluralRules(language.code) }))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    for (const language of this.inOrder) this.byCode.set(language.code.toLowerCase(), language);
    const found = this.find(defaultLanguage);
    if (!found) {
      throw new Error(
        `the default language is "${defaultLanguage}" (DEFAULT_LANGUAGE), but ${folder} has no ${defaultLanguage}.json: it has ${
          this.inOrder.map((language) => language.code).join(', ') || 'no language'
        }`,
      );
    }
    this.default = found;
  }

  /** The server's languages, in the order of their codes. */
  list(): Language[] {
    return this.inOrder.map(({ code, name }) => ({ code, name }));
  }

  /** The server's code for a language named by its code, in any case; undefined if the server doesn't speak it. */
  find(code: string): string | undefined {
    return this.byCode.get(code.trim().toLowerCase())?.code;
  }

  /**
   * The language an Accept-Language header asks for, of those the server speaks: its most wanted
   * first, each matched as closely as can be (see `closest`). Undefined if it asks for none of them.
   */
  preferred(acceptLanguage: unknown): string | undefined {
    if (typeof acceptLanguage !== 'string') return undefined;
    for (const { tag } of acceptLanguage
      .split(',')
      // The most languages of an Accept-Language header that are looked at.
      .slice(0, 20)
      .map((part, position) => {
        const [tag = '', ...params] = part.split(';');
        const q = params.map((param) => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(param)?.[1]).find((value) => value !== undefined);
        return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), position };
      })
      // q=0 is a language that isn't wanted at all.
      .filter(({ tag, q }) => tag && q > 0)
      .sort((a, b) => b.q - a.q || a.position - b.position)) {
      const code = tag === '*' ? this.default : this.closest(tag);
      if (code) return code;
    }
    return undefined;
  }

  /**
   * The server's language closest to `tag`: itself, else the same without its last parts (es-MX is
   * answered in es), else another kind of the same language (pt in pt-BR, es-MX in es-ES).
   */
  private closest(tag: string): string | undefined {
    const parts = tag.toLowerCase().split('-');
    for (let length = parts.length; length > 0; length--) {
      const language = this.byCode.get(parts.slice(0, length).join('-'));
      if (language) return language.code;
    }
    return this.inOrder.find((language) => language.code.toLowerCase().startsWith(`${parts[0]}-`))?.code;
  }

  /** Where a message is looked for: the language asked for, then the default one, then the one the keys are checked against. */
  private sources(code: string): Loaded[] {
    return [...new Set([code, this.default, REFERENCE_LANGUAGE].map((c) => this.byCode.get(c.toLowerCase())).filter((language): language is Loaded => language !== undefined))];
  }

  /** Whether `key` is a message of the language files, which is what tells a schema's own message from zod's. */
  has(key: string): key is MessageKey {
    return this.sources(this.default).some((language) => language.messages[key] !== undefined);
  }

  /**
   * `text` in the language `code`: its message filled in with its parameters. A message the
   * language doesn't have is said in the default language; one no language has is its key, and a
   * parameter that wasn't given stays as written, so nothing here fails a response.
   */
  render(code: string, text: Text): string {
    if (typeof text === 'string') return text;
    const params = text.params ?? {};
    for (const language of this.sources(code)) {
      const template = language.messages[text.key];
      if (template === undefined) continue;
      // The form is chosen by the rules of the language the message is in, which is `code` unless it lacks the message.
      return (typeof template === 'string' ? template : (template[language.plurals.select(Number(params.count))] ?? template.other)).replace(
        /\{(\w+)\}/g,
        (placeholder, name: string) => {
          const value = params[name];
          if (value === undefined) return placeholder;
          return typeof value === 'object' ? this.render(code, value) : String(value);
        },
      );
    }
    return text.key;
  }

  /** The messages each language lacks of those the default one has, for the languages that lack any. */
  missing(): { code: string; keys: string[] }[] {
    const keys = Object.keys(this.byCode.get(this.default.toLowerCase())!.messages);
    return this.inOrder
      .map((language) => ({ code: language.code, keys: keys.filter((key) => language.messages[key] === undefined) }))
      .filter((language) => language.keys.length > 0);
  }
}

/** The languages folder at the root of the project, which is beside src and beside the built server's dist alike. */
const LANGUAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'languages');

/**
 * The server's languages: one per .json file of `dir`, whose name is the language's code. A file
 * that isn't a language is an error, as is a default language that has no file, so the server
 * doesn't start without a language it was meant to speak.
 */
export function loadLanguages(defaultLanguage: string = REFERENCE_LANGUAGE, dir: string = LANGUAGES_DIR): Languages {
  const languages: LanguageMessages[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    const path = join(dir, file);
    const code = canonical(file.slice(0, -'.json'.length));
    if (!code) throw new Error(`${path} isn't named after a language: a language file is <code>.json, such as en.json or pt-BR.json`);
    if (languages.some((language) => language.code === code)) throw new Error(`${path} is a second file for the language ${code}`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`the language file ${path} can't be read as JSON: ${(err as Error).message}`);
    }
    const parsed = LanguageFile.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `the language file ${path} must hold the language's "name" and its "messages", each a string or an object of plural forms with "other" (${
          parsed.error.issues.map((issue) => `${issue.path.join('.') || 'the file'}: ${issue.message}`).join('; ')
        })`,
      );
    }
    languages.push({ code, name: parsed.data.name, messages: parsed.data.messages });
  }
  return new Languages(languages, defaultLanguage, dir);
}
