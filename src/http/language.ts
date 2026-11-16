import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Languages, Text } from '../language.js';

declare module 'fastify' {
  /** Fastify's own, with what `registerLanguages` adds to the app. */
  interface FastifyInstance {
    /** The languages the server speaks (src/language.ts). */
    languages: Languages;
  }
  /** Fastify's own, with what `registerLanguages` adds to every request. */
  interface FastifyRequest {
    /**
     * The code of the language this request is answered in: the user's own once the request is
     * authenticated (see authenticate), until then the one its Accept-Language header asks for,
     * and the server's default if it asks for none the server speaks.
     */
    language: string;
  }
}

/**
 * Gives the app its languages, and every request the one it is answered in. Call it before
 * anything that can refuse a request is added, as hooks run in the order they were added in.
 */
export function registerLanguages(app: FastifyInstance, languages: Languages): void {
  app.decorate('languages', languages);
  app.decorateRequest('language', languages.default);
  app.addHook('onRequest', async (req) => {
    req.language = languages.preferred(req.headers['accept-language']) ?? languages.default;
  });
}

/** `text` in the language the request is answered in. */
export const say = (req: FastifyRequest, text: Text): string => req.server.languages.render(req.language, text);
