import type { MessageKey, Template } from './language.js';

/** A parameter of a message: a value, or another message, said in the same language. */
export type MessageParams = Record<string, string | number | Message>;

/** A message of the language files, not yet in any language: which one, and what to put in it. */
export interface Message {
  key: MessageKey;
  params?: MessageParams;
}

/** A language the server speaks, as GET /languages lists it. */
export interface Language {
  /** Its file's name: a BCP 47 tag such as en or pt-BR. */
  code: string;
  name: string;
}

/** A language and its messages, as its file holds them. */
export interface LanguageMessages extends Language {
  messages: Record<string, Template>;
}
