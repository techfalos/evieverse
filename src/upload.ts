import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import { auditMultipart } from './audit.js';
import { badRequest } from './http/errors.js';
import { IMAGE_HEAD_BYTES, ImageError, imageType, stripImage, type ImageType } from './image.js';
import { resolveMimeType } from './http/mime.js';
import { msg } from './language.js';
import { LINK_MIME, mediaType, TEXT_MIME, type MediaType, type PostType } from './posts.js';
import { spoolToTemp, UploadTooLargeError, type ContentStore, type SpooledFile, type StoredBytes } from './storage/index.js';

/** Where uploads are spooled (the system's temp directory if not set), and how large one can be. */
export interface UploadLimits {
  tmpPath?: string;
  maxUploadBytes: number;
}

/**
 * A post's bytes, wherever they wait to be stored: in a temp file here, or in the content store,
 * where the client put them with a link from POST /uploads.
 */
export interface PostBytes {
  /** In bytes. Of bytes in the content store, as last seen: `place` returns what was stored. */
  size: number;
  /**
   * For an image post: which image the bytes are, read from the bytes themselves, and the bytes to
   * store, which are the image without its metadata (see stripImage). 400 if they aren't an image
   * the server takes. These bytes are then released by the ones returned.
   */
  image(): Promise<{ type: ImageType; file: PostBytes }>;
  /** Writes the bytes as the content's, over the ones it had, and returns their size as stored. */
  place(content: ContentStore, contentId: string, mimeType: string): Promise<StoredBytes>;
  /**
   * Call when the request is over. `stored`: the server now holds the post, so its upload can go.
   * Otherwise an upload in the content store is kept, for the request to be sent again (with a
   * challenge solved, say); the store expires what nobody comes back for.
   */
  release(stored?: boolean): Promise<void>;
}

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

const spooled = (file: SpooledFile, tmpPath?: string): PostBytes => ({
  size: file.size,
  async image() {
    const stripped = await strip(createReadStream(file.path), tmpPath);
    await file.cleanup();
    return { type: stripped.type, file: spooled(stripped.file, tmpPath) };
  },
  async place(content, contentId, mimeType) {
    await content.putFile(contentId, file.path, mimeType);
    return { size: file.size };
  },
  release: () => file.cleanup(),
});

/** A request's file: a multipart part spooled to a temp file, or an upload already in the content store. */
export interface Upload {
  file: PostBytes;
  filename: string | null;
  mimeType: string;
}

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
     * the post is to be stored, when it comes through this process to a temp file, without its
     * metadata, and goes to the content store from there: nothing is fetched for a request that is
     * refused or challenged, and nothing is written over the content unless the whole image is good.
     */
    async image() {
      const type = imageType(await content.uploadHead(userId, uploadId, Math.min(found.size, IMAGE_HEAD_BYTES)));
      if (!type) throw notAnImage(new ImageError(null));
      const place: PostBytes['place'] = async (_content, contentId) => {
        // It must still be a `type`: whoever holds the upload link may have replaced the upload since.
        const stripped = await strip(await content.streamUpload(userId, uploadId, maxUploadBytes), tmpPath, type);
        try {
          await content.putFile(contentId, stripped.file.path, type);
          return { size: stripped.file.size };
        } finally {
          await stripped.file.cleanup();
        }
      };
      return { type, file: { ...file, place } };
    },
    place: (_content, contentId, mimeType) => content.adoptUpload(userId, uploadId, contentId, mimeType, maxUploadBytes),
    release: async (stored) => {
      if (stored) await content.removeUpload(userId, uploadId);
    },
  };
  return { file, filename: null, mimeType: found.contentType ?? 'application/octet-stream' };
}

/** What a request says of its post, beside an uploaded file. */
export interface PostFields {
  type: PostType;
  text?: string;
  url?: string;
  /** An image's, video's or audio's file, inline. */
  content?: string;
  contentEncoding: 'utf8' | 'base64';
  contentType?: string;
  filename?: string;
}

/** A post and its bytes: an image's, video's or audio's file, a text post's text, or a link's URL. */
export type Post = { file: PostBytes; filename: string | null; mimeType: string } & (
  | { type: MediaType; text?: string }
  | { type: 'text'; text: string }
  | { type: 'link'; url: string }
);

/** 400 for a file that isn't of the type its post is: an image post takes image/* files, and so on. */
export const wrongFileType = (type: MediaType, mimeType: string) => badRequest(msg('post.wrong_file_type', { type, mimeType }));

/** A text post's text or a caption; a link has none. */
export const textOf = (post: Post) => (post.type === 'link' ? undefined : post.text);

/** A multipart request's fields, and its one file part, which must be named "content". */
export async function readMultipart(req: FastifyRequest, { tmpPath, maxUploadBytes }: UploadLimits) {
  const fields: Record<string, string> = {};
  let upload: Upload | undefined;
  let file: { filename: string | null; mimeType: string; size: number } | undefined;
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'content' || upload) {
          part.file.resume();
          throw badRequest(msg('post.one_file_part'));
        }
        upload = { file: spooled(await spoolToTemp(part.file, tmpPath, maxUploadBytes), tmpPath), filename: part.filename || null, mimeType: part.mimetype };
        file = { filename: upload.filename, mimeType: upload.mimeType, size: upload.file.size };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (err) {
    await upload?.file.release();
    throw err;
  }
  auditMultipart(req, fields, file);
  return { fields, upload };
}

/**
 * The post the request describes. An image, video or audio post needs a file of that type, from the
 * upload or inline in `content`. A text post's text and a link's URL are stored as its bytes.
 *
 * A video's or audio's type is the one it was sent as, and its bytes are stored as they came. An
 * image is checked by its bytes and stored without its metadata (see PostBytes.image).
 */
export async function readPost(fields: PostFields, upload: Upload | undefined, { tmpPath, maxUploadBytes }: UploadLimits): Promise<Post> {
  const spool = async (bytes: Buffer) => spooled(await spoolToTemp(Readable.from([bytes]), tmpPath, maxUploadBytes), tmpPath);
  const { type } = fields;
  const text = fields.text?.trim() || undefined;
  if (type !== 'link' && fields.url !== undefined) throw badRequest(msg('post.url_only_for_links'));
  if (type === 'text' || type === 'link') {
    if (upload || fields.content !== undefined) throw badRequest(msg('post.no_file', { type }));
    if (type === 'text') {
      if (!text) throw badRequest(msg('post.text_required'));
      return { type, text, file: await spool(Buffer.from(text)), filename: null, mimeType: TEXT_MIME };
    }
    if (fields.text !== undefined) throw badRequest(msg('post.link_is_its_url'));
    if (fields.url === undefined) throw badRequest(msg('post.url_required'));
    return { type, url: fields.url, file: await spool(Buffer.from(fields.url)), filename: null, mimeType: LINK_MIME };
  }

  if (!upload && fields.content === undefined) throw badRequest(msg('post.content_required', { type }));
  const filename = upload?.filename ?? fields.filename ?? null;
  const sent = upload?.mimeType ?? (fields.contentEncoding === 'base64' ? 'application/octet-stream' : 'text/plain');
  const mimeType = resolveMimeType(fields.contentType ?? sent, filename);
  if (mediaType(mimeType) !== type) throw wrongFileType(type, mimeType);
  let file = upload?.file;
  if (!file) {
    const bytes = Buffer.from(fields.content!, fields.contentEncoding === 'base64' ? 'base64' : 'utf8');
    if (bytes.length === 0) throw badRequest(msg('post.content_empty'));
    file = await spool(bytes);
  }
  if (type !== 'image') return { type, ...(text ? { text } : {}), file, filename, mimeType };
  // An image's type is the one its bytes are of, not the one it was sent as, and it is stored without its metadata.
  try {
    const image = await file.image();
    return { type, ...(text ? { text } : {}), file: image.file, filename, mimeType: image.type };
  } catch (err) {
    // The upload is released by whoever read it; the file spooled here has nobody else.
    if (!upload) await file.release();
    throw err;
  }
}
