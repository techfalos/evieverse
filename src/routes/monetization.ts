import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type AuthUser } from '../auth/apiKey.js';
import type { MonetizationTable } from '../db/schema.js';
import type { RouteDeps } from '../deps.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../http/errors.js';
import { listPage, listQuery } from '../http/listCursor.js';
import { Credentials } from '../http/schemas.js';
import { msg } from '../language.js';
import { AD_KINDS, adImageUrl, adStatus, adTags, MAX_AD_IMAGE_BYTES, MAX_AD_TAGS, MAX_AD_TEXT_CHARS, MAX_OPEN_ADS } from '../monetization.js';
import { LinkUrl } from '../posts.js';
import { parseTagList } from '../tags.js';
import { iso } from '../time.js';
import { readMultipart, readPost, type PostBytes, type Upload } from '../upload.js';
import { rawHeaders } from './content.js';

const Params = z.object({ adId: z.string().uuid() });

/** A field an update can clear: null does, and so does an empty string, which is all a form field can send. */
const clearable = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? null : value), schema.nullable()).optional();

/** An instant, as ISO 8601 with its offset from UTC ("2026-12-01T00:00:00Z"), in UTC epoch ms. */
const Instant = z.iso.datetime({ offset: true }).transform((at) => Date.parse(at));

/** What a request says of an ad. Creating one, each field left out is the ad's default; updating one, it is left as it is. */
const Fields = Credentials.extend({
  /** What the ad is: its text, or an image with an optional caption in `text`. An ad keeps its kind. */
  kind: z.enum(AD_KINDS).optional(),
  /** A text ad's text, or an image ad's caption. */
  text: clearable(z.string().trim().max(MAX_AD_TEXT_CHARS)),
  /** Where the ad leads when it is followed. */
  url: clearable(LinkUrl),
  /** The hashtags the ad is targeted at: a list, or one string of them separated by commas or spaces. None: it appears all the time. */
  tags: clearable(z.union([z.array(z.string().max(100)).max(50), z.string().max(5000)])),
  /** When the ad starts being shown. Creating one: now. */
  startsAt: Instant.optional(),
  /** When it stops. None: it has no end. */
  endsAt: clearable(Instant),
  /** An image ad's image, inline for JSON requests, in base64. A multipart request sends it as its file part. */
  content: z.string().optional(),
  contentEncoding: z.literal('base64').optional(),
});
type Fields = z.infer<typeof Fields>;
const NewFields = Fields.extend({ kind: z.enum(AD_KINDS) });

/** A request with an image in it is the size of the image, in base64 where it is inline. */
const BODY_LIMIT = 16 * 1024 * 1024;

const adNotFound = () => notFound(msg('ad.not_found'));

/**
 * Monetization: the server's ads (src/monetization.ts), which its admins keep here and nobody
 * else does. An ad is text or an image, has a schedule, and appears all the time or only under
 * the hashtags it is targeted at. Ads are kept whether or not the server shows any
 * (MONETIZATION_FEED_ADS, MONETIZATION_POST_ADS).
 *
 * Nothing here is shown from the table: the compactor publishes the ads to Redis on its next run,
 * which is when an ad that was created, changed or deleted here shows as it now is.
 *
 * The image of an ad is read by anyone who has the ad, with no credentials: it is what feeds and
 * posts tell their readers to show.
 */
export function monetizationRoutes(app: FastifyInstance, { db, config, content, now = Date.now }: RouteDeps) {
  /** An ad's image is held to what an image post's is (see readPost), and to a size of its own. */
  const limits = { tmpPath: config.storage.tmpPath, maxUploadBytes: Math.min(config.storage.maxUploadBytes, MAX_AD_IMAGE_BYTES) };

  async function asAdmin(req: FastifyRequest, body: Credentials): Promise<AuthUser> {
    const user = await authenticate(db, req, body);
    if (!user.admin) throw forbidden(msg('moderation.admin_only'));
    return user;
  }

  /** A request's fields and its file, if it sends one as a multipart part. */
  async function readRequest(req: FastifyRequest): Promise<{ raw: Record<string, unknown>; upload?: Upload }> {
    if (!req.isMultipart()) return { raw: (req.body as Record<string, unknown>) ?? {} };
    const { fields, upload } = await readMultipart(req, limits);
    return { raw: fields, upload };
  }

  /**
   * The image a request sends, from the upload or inline in `content`, checked by its bytes and
   * without its metadata, as an image post's is; undefined for a request that sends none.
   */
  async function readImage(fields: Fields, upload: Upload | undefined): Promise<{ file: PostBytes; type: string } | undefined> {
    if (!upload && fields.content === undefined) return undefined;
    if (upload && fields.content !== undefined) throw badRequest(msg('post.file_or_field'));
    try {
      // Whatever type the file was sent as, its bytes say which image it is.
      const post = await readPost({ type: 'image', content: fields.content, contentEncoding: 'base64', contentType: 'image/*' }, upload, limits);
      return { file: post.file, type: post.mimeType };
    } catch (err) {
      if (err instanceof HttpError && err.message === 'post.image_unsupported') throw badRequest(msg('ad.image_unsupported'));
      throw err;
    }
  }

  /** The hashtags a request targets the ad at, as the table keeps them; null for an ad that appears all the time. */
  function targeted(tags: NonNullable<Fields['tags']>): string | null {
    const parsed = parseTagList(tags, MAX_AD_TAGS);
    if ('error' in parsed) throw badRequest(parsed.error);
    return parsed.tags.length ? parsed.tags.join(' ') : null;
  }

  const ended = (endsAt: number | null, at: number) => endsAt !== null && endsAt <= at;

  /**
   * 409 if the server holds as many ads that haven't ended as it can. The count and the write that
   * follows are two statements, so admins racing each other can go a few over, which harms nothing.
   */
  async function requireRoom(at: number): Promise<void> {
    const { open } = await db
      .selectFrom('monetization')
      .select((eb) => eb.fn.countAll().as('open'))
      .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', at)]))
      .executeTakeFirstOrThrow();
    if (Number(open) >= MAX_OPEN_ADS) throw conflict(msg('ad.limit', { max: MAX_OPEN_ADS }));
  }

  /** An ad as its admins read it: what it is, its schedule, and where that has it now. */
  const record = (row: MonetizationTable, at: number) => ({
    adId: row.id,
    kind: row.kind,
    ...(row.kind === 'image' && { imageUrl: adImageUrl(config.publicBaseUrl, row.id) }),
    ...(row.text !== null && { text: row.text }),
    ...(row.url !== null && { url: row.url }),
    tags: adTags(row.tags),
    startsAt: iso(row.starts_at),
    endsAt: row.ends_at === null ? null : iso(row.ends_at),
    status: adStatus({ startsAt: row.starts_at, endsAt: row.ends_at }, at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });

  /**
   * Creates an ad. Admins only. JSON, or multipart with the image as its file part, as /store takes
   * a file. A text ad needs `text`; an image ad needs its image, and can have a caption in `text`.
   */
  app.post('/monetization/ads', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const { raw, upload } = await readRequest(req);
    let image: Awaited<ReturnType<typeof readImage>>;
    try {
      const fields = NewFields.parse(raw);
      const admin = await asAdmin(req, fields);
      const t = now();

      const { kind } = fields;
      const text = fields.text || null;
      const sendsImage = upload !== undefined || fields.content !== undefined;
      if (kind === 'text' && sendsImage) throw badRequest(msg('ad.no_image'));
      if (kind === 'text' && !text) throw badRequest(msg('ad.text_required'));
      if (kind === 'image' && !sendsImage) throw badRequest(msg('ad.image_required'));
      const startsAt = fields.startsAt ?? t;
      const endsAt = fields.endsAt ?? null;
      if (endsAt !== null && endsAt <= startsAt) throw badRequest(msg('ad.ends_before_start'));
      const tags = fields.tags == null ? null : targeted(fields.tags);
      if (!ended(endsAt, t)) await requireRoom(t);

      image = await readImage(fields, upload);
      const row: MonetizationTable = {
        id: randomUUID(),
        kind,
        text,
        url: fields.url ?? null,
        image_type: image?.type ?? null,
        tags,
        starts_at: startsAt,
        ends_at: endsAt,
        created_by: admin.id,
        created_at: t,
        updated_at: t,
      };
      // The image first: an ad is never there without the image it shows.
      if (image) await image.file.place(content, { adId: row.id }, image.type);
      try {
        await db.insertInto('monetization').values(row).execute();
      } catch (err) {
        if (image) await content.removeAdImage(row.id);
        throw err;
      }
      return reply.status(201).send(record(row, t));
    } finally {
      // Before the response goes out: a function may be frozen straight after it.
      await upload?.file.release();
      await image?.file.release();
    }
  });

  /** The server's ads, newest first, whatever their schedule has them at. Admins only. */
  app.get('/monetization/ads', async (req) => {
    const page = listQuery(req.query);
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    const { rows, nextCursor } = await listPage(db.selectFrom('monetization').selectAll(), { createdAt: 'created_at', userId: 'id' }, page);
    const t = now();
    return { ads: rows.map((row) => record(row, t)), nextCursor };
  });

  /** One ad. Admins only. */
  app.get('/monetization/ads/:adId', async (req) => {
    const { adId } = Params.parse(req.params);
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    const row = await db.selectFrom('monetization').selectAll().where('id', '=', adId).executeTakeFirst();
    if (!row) throw adNotFound();
    return record(row, now());
  });

  /**
   * Changes an ad: what the request names, and nothing else of it. Admins only. `text` (an image
   * ad's caption only: a text ad is its text), `url`, `tags` and `endsAt` are cleared by null or
   * an empty string. An image ad's image is replaced by the one sent. An ad keeps its kind.
   */
  app.patch('/monetization/ads/:adId', { bodyLimit: BODY_LIMIT }, async (req) => {
    const { adId } = Params.parse(req.params);
    const { raw, upload } = await readRequest(req);
    let image: Awaited<ReturnType<typeof readImage>>;
    try {
      const fields = Fields.parse(raw);
      await asAdmin(req, fields);
      const row = await db.selectFrom('monetization').selectAll().where('id', '=', adId).executeTakeFirst();
      if (!row) throw adNotFound();
      const t = now();

      if (fields.kind !== undefined && fields.kind !== row.kind) throw badRequest(msg('ad.kind_fixed', { kind: row.kind }));
      const sendsImage = upload !== undefined || fields.content !== undefined;
      if (row.kind === 'text' && sendsImage) throw badRequest(msg('ad.no_image'));
      const named = [fields.text, fields.url, fields.tags, fields.startsAt, fields.endsAt].some((field) => field !== undefined);
      if (!named && !sendsImage) throw badRequest(msg('ad.nothing_to_update'));

      const text = fields.text === undefined ? row.text : fields.text || null;
      if (row.kind === 'text' && !text) throw badRequest(msg('ad.text_required'));
      const startsAt = fields.startsAt ?? row.starts_at;
      const endsAt = fields.endsAt === undefined ? row.ends_at : fields.endsAt;
      if (endsAt !== null && endsAt <= startsAt) throw badRequest(msg('ad.ends_before_start'));
      const tags = fields.tags === undefined ? row.tags : fields.tags === null ? null : targeted(fields.tags);
      // An ad that had ended and now hasn't is one more of those the server holds.
      if (ended(row.ends_at, t) && !ended(endsAt, t)) await requireRoom(t);

      image = await readImage(fields, upload);
      const next: MonetizationTable = {
        ...row,
        text,
        url: fields.url === undefined ? row.url : fields.url,
        image_type: image?.type ?? row.image_type,
        tags,
        starts_at: startsAt,
        ends_at: endsAt,
        updated_at: t,
      };
      // Written over the one it had, which is where the ad's image is read.
      if (image) await image.file.place(content, { adId }, image.type);
      const { id: _id, ...changed } = next;
      const res = await db.updateTable('monetization').set(changed).where('id', '=', adId).executeTakeFirst();
      // Deleted meanwhile, and its image with it: the one just written goes too.
      if (Number(res.numUpdatedRows) === 0) {
        if (image) await content.removeAdImage(adId);
        throw adNotFound();
      }
      return record(next, t);
    } finally {
      await upload?.file.release();
      await image?.file.release();
    }
  });

  /** Deletes an ad, and its image. Admins only. It is shown until the compactor's next run. */
  app.delete('/monetization/ads/:adId', async (req) => {
    const { adId } = Params.parse(req.params);
    await asAdmin(req, Credentials.parse(req.body ?? {}));
    const res = await db.deleteFrom('monetization').where('id', '=', adId).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) throw adNotFound();
    await content.removeAdImage(adId);
    return { adId, status: 'deleted' };
  });

  /**
   * An image ad's image, for anyone: it is what `imageUrl` names wherever an ad is shown. A
   * redirect to the store where it can sign links; else streamed from here, as a post's bytes are
   * (see rawHeaders). The image of any ad the server holds, whatever its schedule.
   */
  app.get('/monetization/ads/:adId/image', async (req, reply) => {
    const { adId } = Params.parse(req.params);
    const row = await db.selectFrom('monetization').select(['kind', 'image_type']).where('id', '=', adId).executeTakeFirst();
    if (!row || row.kind !== 'image') throw adNotFound();

    const bytes = { adId };
    const signed = await content.signedUrl(bytes);
    if (signed) return reply.redirect(signed, 302);
    const { size, contentType } = await content.stat(bytes);
    const type = contentType ?? row.image_type ?? 'application/octet-stream';
    reply.headers(rawHeaders(type));
    reply.header('content-type', type);
    reply.header('content-length', String(size));
    return reply.send(await content.stream(bytes));
  });
}
