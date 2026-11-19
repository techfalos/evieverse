import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/apiKey.js';
import type { AuthUser } from '../auth/apiKey.types.js';
import type { Db } from '../db/index.js';
import type { ServerRulesTable } from '../db/schema.js';
import type { AppDeps } from '../deps.types.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { Credentials, Hashtag } from '../http/schemas.js';
import { msg } from '../language.js';
import type { Message } from '../language.types.js';
import { recordAction } from '../moderation/activity.js';
import { moderates } from '../moderation/policy.js';
import { RELEASE } from '../release.js';
import { iso } from '../time.js';

/** The most rules a server has, and the most a hashtag has. GET /rules and GET /tags/:tag/rules give all of them at once, to anyone, so there is an end to them. */
export const MAX_RULES = 100;
/** The longest a rule's text can be, which is what `server_rules.body` and `tag_rules.body` hold. */
export const MAX_RULE_CHARS = 2000;

/** A rule's text as a request gives it: 1 to MAX_RULE_CHARS characters once trimmed. */
const RuleText = z.string().trim().min(1).max(MAX_RULE_CHARS);
/** A rule's place in the list, counted from 1. One past the last rule's means the end of the list. */
const Position = z.coerce.number().int().min(1);
/** What POST /rules and POST /tags/:tag/rules say: the new rule's text, and with `position`, its place in the list. Left out: the end. */
const AddBody = Credentials.extend({ text: RuleText, position: Position.optional() });
/** What PATCH /rules/:ruleId and PATCH /tags/:tag/rules/:ruleId say: the rule's new text, its new place in the list, or both. The route refuses a request that says neither. */
const UpdateBody = Credentials.extend({ text: RuleText.optional(), position: Position.optional() });
/** The rule a path names (/rules/:ruleId), for the routes that change or remove it. */
const RuleParams = z.object({ ruleId: z.string().uuid() });
/** The hashtag a path names (/tags/:tag/rules), whose rules the routes read or add to. */
const TagParams = z.object({ tag: Hashtag });
/** The hashtag and the rule of its a path names (/tags/:tag/rules/:ruleId), for the routes that change or remove it. */
const TagRuleParams = z.object({ tag: Hashtag, ruleId: z.string().uuid() });

/** The columns of a rule the routes read, which `server_rules` and `tag_rules` both have. */
const COLUMNS = ['id', 'sort_order', 'body', 'created_at', 'updated_at'] as const;

type RuleRow = Pick<ServerRulesTable, 'id' | 'sort_order' | 'body' | 'created_at' | 'updated_at'>;

/**
 * A list of rules, as the routes keep one: the server's (`server_rules`), or a hashtag's (the
 * rows of `tag_rules` that name it). Each is kept the same way, and this is what differs: where
 * its rows are. `db` is the database, or a transaction of it.
 */
interface RuleList {
  /** What a request is told that would add a rule to a list of MAX_RULES. */
  full: Message;
  /** Every rule of the list, in its order. */
  inOrder(db: Db): Promise<RuleRow[]>;
  insert(trx: Db, rule: RuleRow): Promise<unknown>;
  /** Changes a rule of the list: its text and when it was changed, or its number among the others. */
  update(trx: Db, ruleId: string, change: Partial<Pick<RuleRow, 'sort_order' | 'body' | 'updated_at'>>): Promise<unknown>;
  /** Deletes a rule of the list, and says whether it was there. */
  remove(db: Db, ruleId: string): Promise<boolean>;
}

/** The server's rules. */
const serverRules: RuleList = {
  full: msg('rule.limit', { max: MAX_RULES }),
  inOrder: (db) =>
    db
      .selectFrom('server_rules')
      .select(COLUMNS)
      .orderBy('sort_order')
      // Two rows hold the same number only when two admins changed the list at once.
      .orderBy('created_at')
      .orderBy('id')
      .execute(),
  insert: (trx, rule) => trx.insertInto('server_rules').values(rule).execute(),
  update: (trx, ruleId, change) => trx.updateTable('server_rules').set(change).where('id', '=', ruleId).execute(),
  remove: async (db, ruleId) => Number((await db.deleteFrom('server_rules').where('id', '=', ruleId).executeTakeFirst()).numDeletedRows) > 0,
};

/** A rule as responses give it. `index` is its place among the rules, from 0. */
const record = (rule: RuleRow, index: number) => ({
  ruleId: rule.id,
  position: index + 1,
  text: rule.body,
  createdAt: iso(rule.created_at),
  updatedAt: iso(rule.updated_at),
});

/** The rules of the hashtag `tag`. A rule of another hashtag isn't one of the list: it is neither changed nor removed by its id here. */
const tagRules = (tag: string): RuleList => ({
  full: msg('rule.tag_limit', { max: MAX_RULES }),
  inOrder: (db) =>
    db
      .selectFrom('tag_rules')
      .select(COLUMNS)
      .where('tag', '=', tag)
      .orderBy('sort_order')
      // Two rows hold the same number only when two moderators changed the list at once.
      .orderBy('created_at')
      .orderBy('id')
      .execute(),
  insert: (trx, rule) => trx.insertInto('tag_rules').values({ ...rule, tag }).execute(),
  update: (trx, ruleId, change) => trx.updateTable('tag_rules').set(change).where('id', '=', ruleId).where('tag', '=', tag).execute(),
  remove: async (db, ruleId) => Number((await db.deleteFrom('tag_rules').where('id', '=', ruleId).where('tag', '=', tag).executeTakeFirst()).numDeletedRows) > 0,
});

/** Numbers the rules 1, 2, 3 ... in the order given, writing only the rows whose number changes. */
async function arrange(list: RuleList, trx: Db, rules: Pick<RuleRow, 'id' | 'sort_order'>[]): Promise<void> {
  for (const [index, rule] of rules.entries()) {
    if (rule.sort_order !== index + 1) await list.update(trx, rule.id, { sort_order: index + 1 });
  }
}

/**
 * Adds a rule to a list: at its end, or with `position`, at that place, which moves the rules
 * from there on down by one. A position past the end is the end. 409 for a list that already has
 * MAX_RULES.
 */
function addRule(db: Db, list: RuleList, { text, position }: { text: string; position?: number }, at: number) {
  return db.transaction().execute(async (trx) => {
    const rules = await list.inOrder(trx);
    if (rules.length >= MAX_RULES) throw conflict(list.full);
    const index = Math.min(position ?? Infinity, rules.length + 1) - 1;
    const rule: RuleRow = { id: randomUUID(), sort_order: index + 1, body: text, created_at: at, updated_at: at };
    await list.insert(trx, rule);
    await arrange(list, trx, [...rules.slice(0, index), rule, ...rules.slice(index)]);
    return record(rule, index);
  });
}

/**
 * Changes the text of a rule of a list, its place there, or both: with `position`, the rule
 * moves there, and the rules between its old place and its new one move by one to make room. A
 * position past the end is the end. A request that would leave the rule as it is writes nothing;
 * 400 for one that says neither, 404 for a rule the list doesn't have.
 */
function changeRule(db: Db, list: RuleList, ruleId: string, body: { text?: string; position?: number }, at: number) {
  if (body.text === undefined && body.position === undefined) throw badRequest(msg('rule.nothing_to_update'));
  return db.transaction().execute(async (trx) => {
    const rules = await list.inOrder(trx);
    const from = rules.findIndex((rule) => rule.id === ruleId);
    const current = rules[from];
    if (!current) throw notFound(msg('rule.not_found'));
    const to = body.position === undefined ? from : Math.min(body.position, rules.length) - 1;
    const text = body.text ?? current.body;
    if (to === from && text === current.body) return record(current, from);
    await list.update(trx, ruleId, { body: text, updated_at: at });
    rules.splice(from, 1);
    rules.splice(to, 0, current);
    await arrange(list, trx, rules);
    return record({ ...current, body: text, updated_at: at }, to);
  });
}

/**
 * The server's rules, its support address and its modification disclosure; and each hashtag's
 * rules.
 *
 * The rules are what the operator asks of the people who use the server, a list its admins keep
 * (`server_rules`): they add a rule, change its text or its place among the others, and remove
 * it. The server holds nothing to them itself: no post is checked against a rule.
 *
 * A hashtag has rules of its own (`tag_rules`), which say what its moderators ask of the posts
 * under it: a list of the same kind, kept the same way under /tags/:tag/rules, by whoever
 * moderates the hashtag (its moderators, and server moderators and admins, who moderate every
 * hashtag). No post is checked against one of these either: they are what a moderator goes by,
 * and what a publisher reads to know it.
 *
 * The modification disclosure is what the additional terms Evieverse is licensed under have a
 * modified version say, here, to anyone: that it is one (`EVIEVERSE_MODIFIED`), the release of
 * Evieverse it is based on (the version this code carries), and where its source code can be
 * obtained (`EVIEVERSE_SOURCE_URL`). A server that runs a release says that instead. It is the
 * operator's statement, set where the server is deployed: no request changes it.
 *
 * The support address is the email address people write to for support (`SUPPORT_EMAIL`), which
 * is the operator's to set too, and a placeholder until they do. The server sends it nothing.
 *
 * GET /rules gives all three to anyone, with a key or without, so a client can show them to
 * someone before they register. GET /tags/:tag/rules gives a hashtag's the same way.
 */
export function rulesRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config, now = Date.now } = deps;

  async function asAdmin(req: FastifyRequest, body: Credentials): Promise<AuthUser> {
    const user = await authenticate(db, req, body);
    if (!user.admin) throw forbidden(msg('moderation.admin_only'));
    return user;
  }

  /** For a hashtag's rules: one of its moderators, or a server moderator or an admin, who moderate every hashtag. */
  async function asModerator(req: FastifyRequest, tag: string, body: Credentials): Promise<AuthUser> {
    const user = await authenticate(db, req, body);
    if (!(await moderates(db, user, tag))) throw forbidden(msg('moderation.tag_moderator_only', { tag }));
    return user;
  }

  /** Notes that `user` changed a hashtag's rules, which is moderating it, and so part of what keeps a hashtag's moderator one (see recordAction). */
  const acted = (req: FastifyRequest, user: AuthUser, tag: string) => recordAction(deps, user.id, tag, req.log);

  /** The rules, in their order, the support address and the modification disclosure. For anyone: it needs no key, and reads none. */
  app.get('/rules', async () => ({
    modificationDisclosure: { modified: config.modified, release: RELEASE, sourceUrl: config.sourceUrl },
    supportEmail: config.supportEmail,
    rules: (await serverRules.inOrder(db)).map(record),
  }));

  /**
   * Adds a rule: at the end of the list, or with `position`, at that place, which moves the rules
   * from there on down by one. A position past the end is the end. Admins only. 409 for a server
   * that already has MAX_RULES.
   */
  app.post('/rules', async (req, reply) => {
    const body = AddBody.parse(req.body ?? {});
    await asAdmin(req, body);
    return reply.status(201).send(await addRule(db, serverRules, body, now()));
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
    return changeRule(db, serverRules, ruleId, body, now());
  });

  /** Removes a rule, which moves the ones after it up by one. Admins only. One that isn't there changes nothing. */
  app.delete('/rules/:ruleId', async (req) => {
    const { ruleId } = RuleParams.parse(req.params);
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    return { ruleId, wasThere: await serverRules.remove(db, ruleId) };
  });

  // A hashtag's rules, which its moderators keep as admins keep the server's.

  /** A hashtag's rules, in their order: none, for a hashtag whose moderators set none. For anyone: it needs no key, and reads none. */
  app.get('/tags/:tag/rules', async (req) => {
    const { tag } = TagParams.parse(req.params);
    return { tag, rules: (await tagRules(tag).inOrder(db)).map(record) };
  });

  /**
   * Adds a rule to a hashtag's, as POST /rules adds one to the server's. Its moderators, server
   * moderators and admins. 409 for a hashtag that already has MAX_RULES.
   */
  app.post('/tags/:tag/rules', async (req, reply) => {
    const { tag } = TagParams.parse(req.params);
    const body = AddBody.parse(req.body ?? {});
    const moderator = await asModerator(req, tag, body);
    const rule = await addRule(db, tagRules(tag), body, now());
    await acted(req, moderator, tag);
    return reply.status(201).send({ tag, ...rule });
  });

  /** Changes a rule of a hashtag's: its text, its place among the hashtag's others, or both, as PATCH /rules/:ruleId changes one of the server's. Its moderators, server moderators and admins. */
  app.patch('/tags/:tag/rules/:ruleId', async (req) => {
    const { tag, ruleId } = TagRuleParams.parse(req.params);
    const body = UpdateBody.parse(req.body ?? {});
    const moderator = await asModerator(req, tag, body);
    const rule = await changeRule(db, tagRules(tag), ruleId, body, now());
    await acted(req, moderator, tag);
    return { tag, ...rule };
  });

  /** Removes a rule of a hashtag's, which moves the ones after it up by one. Its moderators, server moderators and admins. One that isn't there changes nothing. */
  app.delete('/tags/:tag/rules/:ruleId', async (req) => {
    const { tag, ruleId } = TagRuleParams.parse(req.params);
    const moderator = await asModerator(req, tag, Credentials.parse(req.body ?? {}));
    const wasThere = await tagRules(tag).remove(db, ruleId);
    await acted(req, moderator, tag);
    return { tag, ruleId, wasThere };
  });
}
