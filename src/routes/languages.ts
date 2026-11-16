import type { FastifyInstance } from 'fastify';

/**
 * The languages the server speaks, for anyone to read: what a client offers people to register in
 * (POST /register) and to change to (PATCH /users/:userId). They are the files of the languages folder,
 * which the app read as it started (see loadLanguages), each with its code and its own name.
 * `default` is the code of the one the server answers in when a request asks for no other.
 */
export function languageRoutes(app: FastifyInstance) {
  const { languages } = app;
  app.get('/languages', async () => ({ default: languages.default, languages: languages.list() }));
}
