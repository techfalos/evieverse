import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import { auditMultipart } from './audit.js';
import { badRequest } from './http/errors.js';
import { IMAGE_HEAD_BYTES, ImageError, imageType, stripImage } from './image.js';
import { resolveMimeType } from './http/mime.js';
import { msg } from './language.js';
import type { TrustImage } from './moderation/trust.types.js';
import { LINK_MIME, MAX_ALT_CHARS, MAX_POST_IMAGES, mediaType, takenPostTypes, TEXT_MIME, type MediaType, type PostType } from './posts.js';
import { hashFile, spoolToTemp, UploadTooLargeError, type ContentStore, type SpooledFile } from './storage/index.js';
import type { CommentFile, PostBytes, PostFields, PostFile, SentFile, Upload, UploadLimits } from './upload.types.js';
import { allDone } from './util.js';

/** 400 for a file that can't be an image post: it is no image the server takes, or not a whole one. */
const notAnImage = ({ type }: ImageError) => badRequest(type ? msg('post.image_malformed', { mimeType: type }) : msg('post.image_unsupported'));

/** stripImage, whose refusals are 400s. */
async function strip(...args: Parameters<typeof stripImage>) {
  try {
    return await stripImage(...args);
  } catch (err) {
    throw err instanceof ImageError ? notAnImage(err) : err;
  }
}

/**
 * A post's bytes that wait in a temp file here: a multipart request's file, or bytes that were in
 * memory (see spoolBytes): inline content, a text post's text, a link's URL. As an image they are
 * stripped of their metadata into a second temp file, and the first is deleted. The hash is
 * worked out once. `release` deletes the temp file, whether the post was stored or not.
 */
const spooled = (file: SpooledFile, tmpPath?: string): PostBytes => {
  let sha256: Promise<string> | undefined;
  return {
    size: file.size,
    async image() {
      const stripped = await strip(createReadStream(file.path), tmpPath);
      await file.cleanup();
      return { type: stripped.type, file: spooled(stripped.file, tmpPath) };
    },
    hash: () => (sha256 ??= hashFile(file.path)),
    local: async () => file.path,
    async place(content, of, mimeType) {
      await content.putFile(of, file.path, mimeType);
      return { size: file.size };
    },
    stage: async (content, writeId, mimeType) => ({ key: await content.stageFile(writeId, file.path, mimeType), size: file.size }),
    release: () => file.cleanup(),
  };
};

/** Bytes the server has in memory, to store as a piece of content's: a text post's text, a link's URL, a file sent inline in `content`, the address of a repost's original. */
export const spoolBytes = async (bytes: Buffer, { tmpPath, maxUploadBytes }: UploadLimits): Promise<PostBytes> =>
  spooled(await spoolToTemp(Readable.from([bytes]), tmpPath, maxUploadBytes), tmpPath);

/**
 * The file a user put in the content store with the link POST /uploads gave them. Refused if it
 * isn't there, is empty, or is larger than uploads may be (and then deleted).
 */
export async function readUploaded(content: ContentStore, userId: string, uploadId: string, { tmpPath, maxUploadBytes }: UploadLimits): Promise<Upload> {
  const found = await content.statUpload(userId, uploadId);
  if (!found) throw badRequest(msg('post.upload_not_found'));
  if (found.size === 0) throw badRequest(msg('post.content_empty'));
  if (found.size > maxUploadBytes) {
    await content.removeUpload(userId, uploadId);
    throw new UploadTooLargeError(maxUploadBytes);
  }
  const file: PostBytes = {
    size: found.size,
    /**
     * Only the upload's first bytes are read now, to say which image it is. The rest is read once
     * the post is to be stored, or once all that is left to tell an update from the content it has
     * is the image, when it comes through this process to a temp file, without its metadata. It is
     * hashed there, and is staged from there: nothing is fetched for a request that is refused
     * before then, and nothing is staged for the content unless the whole image is
     * good. The temp file is read from the upload once, and is what is stored: whoever holds the
     * upload link can replace the upload meanwhile, and the hash is of what the content gets.
     */
    async image() {
      const type = imageType(await content.uploadHead(userId, uploadId, Math.min(found.size, IMAGE_HEAD_BYTES)));
      if (!type) throw notAnImage(new ImageError(null));
      let fetched: Promise<SpooledFile> | undefined;
      let sha256: Promise<string> | undefined;
      // It must still be a `type`: whoever holds the upload link may have replaced the upload since.
      const stripped = () =>
        (fetched ??= content.streamUpload(userId, uploadId, maxUploadBytes).then(async (upload) => (await strip(upload, tmpPath, type)).file));
      return {
        type,
        file: {
          ...file,
          hash: () => (sha256 ??= stripped().then(({ path }) => hashFile(path))),
          local: () => stripped().then(({ path }) => path),
          async place(_content, of) {
            const { path, size } = await stripped();
            await content.putFile(of, path, type);
            return { size };
          },
          async stage(_content, writeId) {
            const { path, size } = await stripped();
            return { key: await content.stageFile(writeId, path, type), size };
          },
          async release(stored) {
            await fetched?.then(
              ({ cleanup }) => cleanup(),
              () => {},
            );
            await file.release(stored);
          },
        },
      };
    },
    hash: async () => null,
    local: async () => null,
    place: (_content, of, mimeType) => content.adoptUpload(userId, uploadId, of, mimeType, maxUploadBytes),
    // Copied now, not by the compactor: whoever holds the upload link can replace the upload until the link expires.
    stage: (_content, writeId, mimeType) => content.stageUpload(userId, uploadId, writeId, mimeType, maxUploadBytes),
    release: async (stored) => {
      if (stored) await content.removeUpload(userId, uploadId);
    },
  };
  return { file, filename: null, mimeType: found.contentType ?? 'application/octet-stream' };
}

/**
 * A post and its bytes: an image's, video's or audio's file, a text post's text, or a link's URL.
 * An image post of several images is its first image, with the ones after it in `more`, in
 * their order (see filesOf).
 */
export type Post = PostFile &
  (
    | { type: 'image'; text?: string; more: PostFile[] }
    | { type: Exclude<MediaType, 'image'>; text?: string }
    | { type: 'text'; text: string }
    | { type: 'link'; url: string }
  );

/** A post's files: its one file, or for an image post, its images in their order. A text post's text and a link's URL are one too. */
export const filesOf = (post: Post): PostFile[] => (post.type === 'image' ? [post, ...post.more] : [post]);

/**
 * An image of a post, or the one a comment comes with, as the trust plugins are given it (see
 * TrustImage): `file` is one that `readPost` or `readCommentFile` read as an image. Nothing of
 * it is read here, or at all unless a plugin asks.
 */
export const trustImage = ({ file, filename, mimeType }: PostFile): TrustImage => ({
  mimeType,
  filename,
  async file() {
    const path = await file.local();
    if (path === null) throw new Error("the image's bytes aren't in a file here: only an image read as one (PostBytes.image) is given to the trust plugins");
    return path;
  },
  async sha256() {
    const hash = await file.hash();
    if (hash === null) throw new Error("the image has no hash: only an image read as one (PostBytes.image) is given to the trust plugins");
    return hash;
  },
});

/**
 * 400 for a post of a type the server has turned off (`postTypes` of the configuration), new or an
 * update, which names the types it takes. Checked before anything of the post is read or sent.
 */
export function requirePostType(postTypes: Record<PostType, boolean>, type: PostType) {
  if (postTypes[type]) return;
  throw badRequest(msg('post.type_off', { type, types: takenPostTypes(postTypes).join(', ') }));
}

/** 400 for a file that isn't of the type its post is: an image post takes image/* files, and so on. */
export const wrongFileType = (type: MediaType, mimeType: string) => badRequest(msg('post.wrong_file_type', { type, mimeType }));

/** A text post's text or a caption; a link has none. */
export const textOf = (post: Post) => (post.type === 'link' ? undefined : post.text);

/**
 * A multipart request's fields, and its file parts in the order they were sent, each of which
 * must be named "content". There is one at most, but where a request takes more (`files`): the
 * images of an image post (see readPost).
 *
 * A field sent more than once has the value it was last sent with, but for `alt`, which a
 * request with several images sends once for each: `alts` is every value of it, in the order
 * they were sent, which is the order of the images they describe.
 */
export async function readMultipart(req: FastifyRequest, { tmpPath, maxUploadBytes }: UploadLimits, files = 1) {
  const fields: Record<string, string> = {};
  const alts: string[] = [];
  const uploads: Upload[] = [];
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'content' || uploads.length >= files) {
          part.file.resume();
          throw badRequest(files === 1 ? msg('post.one_file_part') : part.fieldname !== 'content' ? msg('post.file_part_name') : msg('post.too_many_images', { max: files }));
        }
        uploads.push({ file: spooled(await spoolToTemp(part.file, tmpPath, maxUploadBytes), tmpPath), filename: part.filename || null, mimeType: part.mimetype });
      } else {
        fields[part.fieldname] = String(part.value);
        if (part.fieldname === 'alt') alts.push(String(part.value));
      }
    }
  } catch (err) {
    await allDone(uploads.map(({ file }) => file.release()));
    throw err;
  }
  auditMultipart(
    req,
    fields,
    uploads.map(({ file, filename, mimeType }) => ({ filename, mimeType, size: file.size })),
  );
  return { fields, alts, uploads };
}

/** What a request says of a file it sends, beside the file. */
type FileFields = Omit<SentFile, 'upload'>;

/**
 * The one file a request sends, as readPost takes a post's files: its upload, or the file inline
 * in `content`, with what the request says of it. None for a request that sends neither.
 */
export const oneFile = ({ content, contentEncoding, contentType, filename, alt }: FileFields, upload: Upload | undefined): SentFile[] =>
  upload || content !== undefined ? [{ upload, content, contentEncoding, contentType, filename, ...(alt !== undefined && { alt }) }] : [];

/**
 * The alternative text a request sends with an image, as it is kept: without the spaces around
 * it. Undefined for none, and for one that is only spaces. 400 for one sent with a file that is
 * no image, which has nothing to describe that way, and for one longer than MAX_ALT_CHARS.
 */
function altOf(type: MediaType, sent: SentFile): string | undefined {
  const alt = sent.alt?.trim();
  if (!alt) return undefined;
  if (type !== 'image') throw badRequest(msg('post.alt_only_for_images'));
  if (alt.length > MAX_ALT_CHARS) throw badRequest(msg('post.alt_too_long', { max: MAX_ALT_CHARS }));
  return alt;
}

/** The name a file was sent with, and its content type: the one it was sent as, or the one its name says. */
function sentAs({ upload, ...fields }: SentFile): { filename: string | null; mimeType: string } {
  const filename = upload?.filename ?? fields.filename ?? null;
  return {
    filename,
    mimeType: resolveMimeType(fields.contentType ?? upload?.mimeType ?? (fields.contentEncoding === 'base64' ? 'application/octet-stream' : 'text/plain'), filename),
  };
}

/**
 * The image or video a request sends with a comment, from the upload or inline in `content`, as a
 * post's file is sent; undefined for a request that sends none. It is held to what an image or a
 * video post's file is (see readPost): an image is checked by its bytes and stored without its
 * metadata, and a video's type is the one it was sent as. Any other file is refused, audio too,
 * and so is an image or a video where the server takes no posts of that type (`postTypes`).
 */
export async function readCommentFile(
  fields: FileFields,
  upload: Upload | undefined,
  limits: UploadLimits,
  postTypes: Record<CommentFile['kind'], boolean>,
): Promise<CommentFile | undefined> {
  const [sent] = oneFile(fields, upload);
  if (!sent) {
    // An alternative text describes an image, and there is none.
    if (fields.alt?.trim()) throw badRequest(msg('post.alt_only_for_images'));
    return undefined;
  }
  const { mimeType } = sentAs(sent);
  const kind = mediaType(mimeType);
  if (kind !== 'image' && kind !== 'video') throw badRequest(msg('comment.wrong_file_type', { mimeType }));
  if (!postTypes[kind]) throw badRequest(msg('comment.file_type_off', { type: kind }));
  return { kind, ...(await readFile(kind, sent, limits)) };
}

/**
 * One file of an image, video or audio post, as a request stores it. A video's or audio's type
 * is the one it was sent as, and its bytes are staged as they came: a video's are then
 * processed before they are the post's, where the server processes videos (compactor/src/video). An image
 * is checked by its bytes and stored without its metadata (see PostBytes.image): its type is the
 * one its bytes are of, and it keeps the alternative text it was sent with (see altOf).
 */
async function readFile(type: MediaType, sent: SentFile, limits: UploadLimits): Promise<PostFile> {
  const { filename, mimeType } = sentAs(sent);
  const alt = altOf(type, sent);
  let file = sent.upload?.file;
  if (!file) {
    const bytes = Buffer.from(sent.content!, sent.contentEncoding === 'base64' ? 'base64' : 'utf8');
    if (bytes.length === 0) throw badRequest(msg('post.content_empty'));
    file = await spoolBytes(bytes, limits);
  }
  if (type !== 'image') return { file, filename, mimeType };
  try {
    const image = await file.image();
    return { file: image.file, filename, mimeType: image.type, ...(alt !== undefined && { alt }) };
  } catch (err) {
    // The upload is released by whoever read it; the file spooled here has nobody else.
    if (!sent.upload) await file.release();
    throw err;
  }
}

/**
 * The post the request describes. An image, video or audio post needs a file of that type
 * (`sent`): an upload, or the file inline in `content`. An image post takes several, up to
 * MAX_POST_IMAGES, and is then of those images in the order they were sent; any other takes
 * one. A text post's text and a link's URL are stored as its bytes.
 *
 * A video's or audio's type is the one it was sent as, and its bytes are stored as they came. An
 * image is checked by its bytes and stored without its metadata (see PostBytes.image). If one
 * of several is refused, so is the post, and what was read of the ones before it is released.
 */
export async function readPost(fields: PostFields, sent: SentFile[], limits: UploadLimits): Promise<Post> {
  const spool = (bytes: Buffer) => spoolBytes(bytes, limits);
  const { type } = fields;
  const text = fields.text?.trim() || undefined;
  if (type !== 'link' && fields.url !== undefined) throw badRequest(msg('post.url_only_for_links'));
  // Said of an image, and of nothing else: before anything is read.
  if (type !== 'image' && (fields.alt?.trim() || sent.some((file) => file.alt?.trim()))) throw badRequest(msg('post.alt_only_for_images'));
  if (type === 'text' || type === 'link') {
    if (sent.length) throw badRequest(msg('post.no_file', { type }));
    if (type === 'text') {
      if (!text) throw badRequest(msg('post.text_required'));
      return { type, text, file: await spool(Buffer.from(text)), filename: null, mimeType: TEXT_MIME };
    }
    if (fields.text !== undefined) throw badRequest(msg('post.link_is_its_url'));
    if (fields.url === undefined) throw badRequest(msg('post.url_required'));
    return { type, url: fields.url, file: await spool(Buffer.from(fields.url)), filename: null, mimeType: LINK_MIME };
  }

  if (!sent.length) throw badRequest(msg('post.content_required', { type }));
  if (type !== 'image' && sent.length > 1) throw badRequest(msg('post.one_file', { type }));
  if (sent.length > MAX_POST_IMAGES) throw badRequest(msg('post.too_many_images', { max: MAX_POST_IMAGES }));
  // What each was sent as, before any is read: a post with a file that isn't its type's is refused for nothing.
  for (const file of sent) {
    const { mimeType } = sentAs(file);
    if (mediaType(mimeType) !== type) throw wrongFileType(type, mimeType);
  }
  // One after another: an image is stripped of its metadata as it is read, which is work for one at a time.
  const files: PostFile[] = [];
  try {
    for (const file of sent) files.push(await readFile(type, file, limits));
  } catch (err) {
    await allDone(files.map(({ file }) => file.release()));
    throw err;
  }
  const [first, ...more] = files;
  return type === 'image' ? { type, ...(text ? { text } : {}), ...first!, more } : { type, ...(text ? { text } : {}), ...first! };
}
