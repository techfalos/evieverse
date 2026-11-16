import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type AuthUser } from '../auth/apiKey.js';
import type { Db } from '../db/index.js';
import type { ServerRulesTable } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { Credentials } from '../http/schemas.js';
import { msg } from '../language.js';
import { RELEASE } from '../release.js';
import { iso } from '../time.js';

/** The most rules a server has. GET /rules gives all of them at once, to anyone, so there is an end to them. */
export const MAX_RULES = 100;
/** The longest a rule's text can be, which is what `server_rules.body` holds. */
export const MAX_RULE_CHARS = 2000;

const RuleText = z.string().trim().min(1).max(MAX_RULE_CHARS);
/** A rule's place in the list, counted from 1. One past the last rule's means the end of the list. */
const Position = z.coerce.number().int().min(1);
const AddBody = Credentials.extend({ text: RuleText, position: Position.optional() });
const UpdateBody = Credentials.extend({ text: RuleText.optional(), position: Position.optional() });
const RuleParams = z.object({ ruleId: z.string().uuid() });

type RuleRow = Pick<ServerRulesTable, 'id' | 'sort_order' | 'body' | 'created_at' | 'updated_at'>;

/** A rule as responses give it. `index` is its place among the rules, from 0. */
const record = (rule: RuleRow, index: number) => ({
  ruleId: rule.id,
  position: index + 1,
  text: rule.body,
  createdAt: iso(rule.created_at),
  updatedAt: iso(rule.updated_at),
});

/** Every rule, in the list's order. `db` is the database, or a transaction of it. */
const inOrder = (db: Db): Promise<RuleRow[]> =>
  db
    .selectFrom('server_rules')
    .select(['id', 'sort_order', 'body', 'created_at', 'updated_at'])
    .orderBy('sort_order')
    // Two rows hold the same number only when two admins changed the list at once.
    .orderBy('created_at')
    .orderBy('id')
    .execute();

/** Numbers the rules 1, 2, 3 ... in the order given, writing only the rows whose number changes. */
async function arrange(trx: Db, rules: Pick<RuleRow, 'id' | 'sort_order'>[]): Promise<void> {
  for (const [index, rule] of rules.entries()) {
    if (rule.sort_order !== index + 1) await trx.updateTable('server_rules').set({ sort_order: index + 1 }).where('id', '=', rule.id).execute();
  }
}

/**
 * The server's rules, and its modification disclosure.
 *
 * The rules are what the operator asks of the people who use the server, a list its admins keep
 * (`server_rules`): they add a rule, change its text or its place among the others, and remove
 * it. The server holds nothing to them itself: no post is checked against a rule.
 *
 * The modification disclosure is what the additional terms Evieverse is licensed under have a
 * modified version say, here, to anyone: that it is one (`EVIEVERSE_MODIFIED`), the release of
 * Evieverse it is based on (the version this code carries), and where its source code can be
 * obtained (`EVIEVERSE_SOURCE_URL`). A server that runs a release says that instead. It is the
 * operator's statement, set where the server is deployed: no request changes it.
 *
 * GET /rules gives both to anyone, with a key or without, so a client can show them to someone
 * before they register.
 */
export function rulesRoutes(app: FastifyInstance, { db, config, now = Date.now }: AppDeps) {
  async function asAdmin(req: FastifyRequest, body: Credentials): Promise<AuthUser> {
    const user = await authenticate(db, req, body);
    if (!user.admin) throw forbidden(msg('moderation.admin_only'));
    return user;
  }

  /** The rules, in their order, and the modification disclosure. For anyone: it needs no key, and reads none. */
  app.get('/rules', async () => ({
    modificationDisclosure: { modified: config.modified, release: RELEASE, sourceUrl: config.sourceUrl },
    rules: (await inOrder(db)).map(record),
  }));

  /**
   * Adds a rule: at the end of the list, or with `position`, at that place, which moves the rules
   * from there on down by one. A position past the end is the end. Admins only. 409 for a server
   * that already has MAX_RULES.
   */
  app.post('/rules', async (req, reply) => {
    const body = AddBody.parse(req.body ?? {});
    await asAdmin(req, body);
    const at = now();
    const added = await db.transaction().execute(async (trx) => {
      const rules = await inOrder(trx);
      if (rules.length >= MAX_RULES) throw conflict(msg('rule.limit', { max: MAX_RULES }));
      const index = Math.min(body.position ?? Infinity, rules.length + 1) - 1;
      const rule: RuleRow = { id: randomUUID(), sort_order: index + 1, body: body.text, created_at: at, updated_at: at };
      await trx.insertInto('server_rules').values(rule).execute();
      await arrange(trx, [...rules.slice(0, index), rule, ...rules.slice(index)]);
      return record(rule, index);
    });
    return reply.status(201).send(added);
  });

  /**
   * Changes a rule's text, its place in the list, or both: with `position`, the rule moves there,
   * and the rules between its old place and its new one move by one to make room. A position past
   * the end is the end. Admins only. A request that would leave the rule as it is writes nothing.
   */
  app.patch('/rules/:ruleId', async (req) => {
    const { ruleId } = RuleParams.parse(req.params);
    const body = UpdateBody.parse(req.body ?? {});
    await asAdmin(req, body);
    if (body.text === undefined && body.position === undefined) throw badRequest(msg('rule.nothing_to_update'));
    const at = now();
    return db.transaction().execute(async (trx) => {
      const rules = await inOrder(trx);
      const from = rules.findIndex((rule) => rule.id === ruleId);
      const current = rules[from];
      if (!current) throw notFound(msg('rule.not_found'));
      const to = body.position === undefined ? from : Math.min(body.position, rules.length) - 1;
      const text = body.text ?? current.body;
      if (to === from && text === current.body) return record(current, from);
      const updated: RuleRow = { ...current, body: text, updated_at: at };
      await trx.updateTable('server_rules').set({ body: text, updated_at: at }).where('id', '=', ruleId).execute();
      rules.splice(from, 1);
      rules.splice(to, 0, current);
      await arrange(trx, rules);
      return record(updated, to);
    });
  });

  /** Removes a rule, which moves the ones after it up by one. Admins only. One that isn't there changes nothing. */
  app.delete('/rules/:ruleId', async (req) => {
    const { ruleId } = RuleParams.parse(req.params);
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    const res = await db.deleteFrom('server_rules').where('id', '=', ruleId).executeTakeFirst();
    return { ruleId, wasThere: Number(res.numDeletedRows) > 0 };
  });
}
