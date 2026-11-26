import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Operator } from 'opendal';
import type { Config } from '../config.js';
import { commentMediaKey } from './commentStore.js';
import type { ContentMeta, StagedBytes, StoredBytes, UploadLink } from './contentStore.types.js';
import { linkSigner } from './linkSigner.js';
import type { LinkSigner } from './linkSigner.types.js';
import { createOperator, isNotFound, readObject, streamObject } from './opendal.js';
import { UploadTooLargeError } from './spool.js';

/**
 * For how long no link is asked of a signer that has just failed (see LinkSigner): files go
 * through the app meanwhile. Long enough that a service that is down isn't asked by every request,
 * and short enough that links are back soon after it is.
 */
const SIGNER_PAUSE_MS = 30_000;

/** How many of a signer's links to read with are kept: past that, the oldest goes. */
const LINK_CACHE_SIZE = 10_000;

/**
 * Matches the key of a staged file, `staged/<writeId>`, where the id is written as a UUID is. A
 * key that a row of `pending_writes` names is held to it before anything is read, copied or
 * deleted by it.
 */
const STAGED_KEY = /^staged\/[0-9a-f-]{36}$/;

/** Matches the id of a version of a post's video, written as a UUID is: what its files are kept under. */
const MEDIA_ID = /^[0-9a-f-]{36}$/;

/**
 * Matches the name of a file of a processed video: its poster, the master playlist of its
 * stream, and for each rendition, named by its height, a playlist and numbered segments. A
 * request names one in its path, and nothing else is read by a name a request gave.
 */
export const MEDIA_FILE = /^(?:poster\.jpg|master\.m3u8|\d{3,4}p\.m3u8|\d{3,4}p_\d{5}\.ts)$/;

/** Where a post's bytes are kept: an image's, video's or audio's file, a text post's text, or a link's URL. */
const contentKey = (contentId: string) => `content/${contentId}`;
/**
 * Where an image of an image post is kept, by its place among the post's images, counted from 1.
 * The first is the post's bytes. Each one after it, of a post of several, is a file of its own
 * beside them: `content/<id>.2`, `content/<id>.3`, and so on.
 */
const imageKey = (contentId: string, image: number) => (image === 1 ? contentKey(contentId) : `${contentKey(contentId)}.${image}`);
/** Where a post's meta file is kept (see ContentMeta): beside its bytes, as JSON. */
const metaKey = (contentId: string) => `content/${contentId}.meta.json`;
/**
 * Where a client puts a file itself, with the link POST /uploads gives, before /store makes it a
 * post's. Under the user's id, so nobody stores another user's upload. The bucket should expire
 * what is left under `uploads/` after a day: uploads never stored, or stored by a request that failed.
 */
const uploadKey = (userId: string, uploadId: string) => `uploads/${userId}/${uploadId}`;

/** Where the image of an image ad is kept (src/monetization.ts): apart from posts, as an ad is no post. */
const adImageKey = (adId: string) => `ads/${adId}`;

/**
 * Where a user's avatars are kept (src/profile.ts): apart from posts, as an avatar is no post,
 * and all under the user's id, so that whatever is left of them goes with the account in one
 * deletion.
 */
const avatarPrefix = (userId: string) => `avatars/${userId}/`;
/**
 * Where one avatar of a user's is kept, by its id (`users.avatar_id`). An avatar that takes
 * another's place has another id, and so a file of its own: nothing is written over, and what a
 * reader holds of the one before is never mixed with it. Throws for an id that isn't written as
 * a UUID is.
 */
const avatarKey = (userId: string, avatarId: string) => {
  if (!MEDIA_ID.test(avatarId)) throw new Error(`"${avatarId}" is not the id of an avatar`);
  return `${avatarPrefix(userId)}${avatarId}`;
};

/**
 * Where a user's splash images are kept (src/profile.ts): apart from posts and from avatars, and
 * all under the user's id, so that whatever is left of them goes with the account in one deletion.
 */
const splashPrefix = (userId: string) => `splashes/${userId}/`;
/**
 * Where one splash image of a user's is kept, by its id (`users.splash_id`): each has a file of
 * its own, as each avatar has (see avatarKey). Throws for an id that isn't written as a UUID is.
 */
const splashKey = (userId: string, splashId: string) => {
  if (!MEDIA_ID.test(splashId)) throw new Error(`"${splashId}" is not the id of a splash image`);
  return `${splashPrefix(userId)}${splashId}`;
};

/**
 * Where what the server made of a post's videos is kept, beside the MP4 that is the post's
 * bytes: a folder for each version of its video (see mediaKey), all of them under the post's id,
 * so that they go with the post in one deletion.
 */
const mediaPrefix = (contentId: string) => `media/${contentId}/`;
/**
 * Where a file of one version of a post's video is kept (see StoredVideo.id): its poster
 * (`poster.jpg`), the master playlist of its stream (`master.m3u8`), and the playlist and the
 * segments of each rendition. The video worker writes them, once, under an id nothing else has,
 * before the write that names the id is applied; the compactor deletes them, with the version
 * or with the post. Throws for a name that is none of a video's files (see MEDIA_FILE).
 */
const mediaKey = (contentId: string, videoId: string, file: string) => {
  if (!MEDIA_ID.test(videoId) || !MEDIA_FILE.test(file)) throw new Error(`"${videoId}/${file}" is not a file of a video`);
  return `${mediaPrefix(contentId)}${videoId}/${file}`;
};

/**
 * Where the file a write came with waits for the compactor: a post's image, video or audio, or
 * a comment's image or video. The request that makes the write stores it here once, under an id
 * of the write's own, and nothing writes it again: the compactor copies it to where the post's
 * or the comment's bytes are kept, and deletes it, at once or, where the store signs links, when
 * those given to it have expired (see linkMs). The bucket should expire what is left under
 * `staged/` after a week: files of requests that died before they committed, or before they
 * could take back what they staged. A week, not a day: a file that expired before a compactor
 * that was down came back would be a write that is lost.
 */
export const stagedKey = (writeId: string) => `staged/${writeId}`;

/** A staged file's key, as a row of `pending_writes` names it: throws for anything that isn't one. */
function stagedObject(key: string): string {
  if (!STAGED_KEY.test(key)) throw new Error(`"${key}" is not a staged file`);
  return key;
}

/**
 * Whose bytes a file in the store is: a post's, named by the post's id, those of one image of
 * an image post, named by the post and the image's place among its images (see imageKey), those
 * of the image or video a comment came with, named by the comment and the post it is on, the
 * image of an ad, named by the ad, a user's avatar, named by the user and the avatar's id (see
 * avatarKey), a user's splash image, named by the user and the splash image's id (see
 * splashKey), a staged file's, named by its key (see stagedKey), or those of a file of a post's
 * processed video, named by the post, the version of the video and the file (see mediaKey).
 * They are written, read and linked to the same way; only where they are kept differs.
 */
export type BytesOwner =
  | string
  | { contentId: string; image: number }
  | { contentId: string; video: string; file: string }
  | { postId: string; commentId: string }
  | { adId: string }
  | { userId: string; avatar: string }
  | { userId: string; splash: string }
  | { staged: string };
/** Where the bytes of `of` are kept: with the posts', with what was made of a post's video, with the comments of the post it is on, with the ads' images, with its user's avatars or splash images, or where staged files wait. */
function bytesKey(of: BytesOwner): string {
  if (typeof of === 'string') return contentKey(of);
  if ('image' in of) return imageKey(of.contentId, of.image);
  if ('video' in of) return mediaKey(of.contentId, of.video, of.file);
  if ('adId' in of) return adImageKey(of.adId);
  if ('avatar' in of) return avatarKey(of.userId, of.avatar);
  if ('splash' in of) return splashKey(of.userId, of.splash);
  if ('staged' in of) return stagedObject(of.staged);
  return commentMediaKey(of.postId, of.commentId);
}

/**
 * Uploaded bytes and the meta file of each piece of content, the bytes of the images and videos
 * that comments come with, the images of ads and users' avatars and splash images, on any Apache OpenDAL backend (fs, s3, gcs,
 * azblob, sftp, webdav, gdrive, onedrive, dropbox, hdfs, ...). An image post of several images
 * has a file for each: the first is the post's bytes, and the others are beside it (see imageKey).
 *
 * Only the compactor writes or deletes a post's bytes and meta file, and a comment's image or
 * video: `putBytes`, `adopt`, `putMeta`, `remove` and `removeImage` are its own. What a request writes is a
 * staged file (`stageFile`, `stageUpload`), once, which it alone knows of until it commits.
 *
 * A video the server processes (compactor/src/video) is staged by its request like any file. The video
 * worker then reads it from there (`fetchTo`), stages the MP4 it makes in its place, and for a
 * post writes the poster and the stream beside the posts' bytes (`putFile`, to a file of the
 * video: see mediaKey), under an id that no write names until the worker's commit does. The
 * compactor deletes those with the version of the video they are of, or with the post
 * (`removeMedia`).
 *
 * Links to the bytes are signed by OpenDAL with the store's key, where it has one. A store that
 * has none and runs where it needs none has a signer instead (see linkSigner), which asks a
 * service of the cloud for each signature. So its links to read with are kept and given again for
 * half the time they are good for, and a signature that fails stops links for half a minute and
 * not for good: until then, files go through the app, as they do where no links are signed.
 */
export class ContentStore {
  private readonly op: Operator;
  private readonly signedUrlSeconds: number;
  private presignSupported = true;
  private presignWriteSupported = true;
  private readonly now: () => number;
  private readonly signer: LinkSigner | null;
  private signerPausedUntil = 0;
  /** The signer's links to read with, by the object's key, each until half the time it is good for has passed. */
  private readonly links = new Map<string, { url: Promise<string | null>; until: number }>();

  /** `signer` is the store's own (see linkSigner) unless one is given, which only tests do. */
  constructor(cfg: Config['storage']['content'], now: () => number = Date.now, signer: LinkSigner | null = linkSigner(cfg.scheme, cfg.options, now)) {
    this.op = createOperator(cfg.scheme, cfg.options);
    this.signedUrlSeconds = cfg.signedUrlSeconds;
    this.now = now;
    this.signer = signer;
  }

  async putFile(of: BytesOwner, localPath: string, mimeType: string): Promise<void> {
    const writer = await this.op.writer(bytesKey(of), { contentType: mimeType });
    await pipeline(createReadStream(localPath), writer.createWriteStream());
  }

  /** Writes bytes that are in memory as `of`'s, over the ones it had: a text post's text, a link's URL, an avatar as the server made it. */
  async putBytes(of: BytesOwner, bytes: Buffer, mimeType: string): Promise<void> {
    await this.op.write(bytesKey(of), bytes, { contentType: mimeType });
  }

  /** Stages a local file for the write `writeId` (see stagedKey), and returns the staged file's key. */
  async stageFile(writeId: string, localPath: string, mimeType: string): Promise<string> {
    const key = stagedKey(writeId);
    await this.putFile({ staged: key }, localPath, mimeType);
    return key;
  }

  /**
   * Stages an upload for the write `writeId`: a copy of it, which its client can't write to as it
   * can to the upload until its link expires. As adoptUpload makes it, with the same checks of
   * its size.
   */
  async stageUpload(userId: string, uploadId: string, writeId: string, mimeType: string, maxBytes: number): Promise<StagedBytes> {
    const key = stagedKey(writeId);
    return { key, ...(await this.adoptUpload(userId, uploadId, { staged: key }, mimeType, maxBytes)) };
  }

  /**
   * Makes a staged file `of`'s bytes, over the ones it had: copied within the backend where it
   * can, else through this process. The staged file stays, so that this can be done again;
   * `removeStaged` deletes it. Fails, with an error isNotFound knows, if there is no such file.
   */
  async adopt(staged: string, of: BytesOwner, mimeType: string): Promise<void> {
    const from = stagedObject(staged);
    const to = bytesKey(of);
    if (
      this.op.capability().copy &&
      (await this.op.copy(from, to).then(
        () => true,
        () => false,
      ))
    ) {
      return;
    }
    await pipeline(await streamObject(this.op, from), (await this.op.writer(to, { contentType: mimeType })).createWriteStream());
  }

  /** Deletes a staged file. One that isn't there is no error. */
  async removeStaged(staged: string): Promise<void> {
    this.links.delete(stagedObject(staged));
    await this.op.delete(stagedObject(staged));
  }

  /**
   * For how long a link to read a file with may be in use after it was given, in milliseconds: 0
   * where the store gives none, and files are read through the app. A signer's link is given
   * again for half the time it is good for (see signerUrl), so none outlasts the whole of it from
   * when it was last given. What the compactor keeps an applied staged file for.
   */
  linkMs(): number {
    // Whether it can sign at all, not whether it last could: a link given before a signature failed is still in use.
    const signs = this.signer !== null || this.op.capability().presignRead;
    return signs ? this.signedUrlSeconds * 1000 : 0;
  }

  async putMeta(meta: ContentMeta): Promise<void> {
    await this.op.write(metaKey(meta.contentId), JSON.stringify(meta), { contentType: 'application/json' });
  }

  async getMeta(contentId: string): Promise<ContentMeta | null> {
    const meta = await readObject(this.op, metaKey(contentId));
    return meta && (JSON.parse(meta.toString('utf8')) as ContentMeta);
  }

  /** The size of the content's bytes as the store holds them, and their content type where it keeps one (fs doesn't). */
  async stat(of: BytesOwner): Promise<{ size: number; contentType: string | null }> {
    const stat = await this.op.stat(bytesKey(of));
    return { size: Number(stat.contentLength ?? 0), contentType: stat.contentType || null };
  }

  /** As `stat`, or null if `of` has no bytes: a staged file that the compactor has made its post's, or its comment's, since its key was read. */
  async statIfThere(of: BytesOwner): Promise<{ size: number; contentType: string | null } | null> {
    try {
      return await this.stat(of);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async stream(of: BytesOwner): Promise<Readable> {
    return streamObject(this.op, bytesKey(of));
  }

  /** As `stream`, or null if `of` has no bytes (see statIfThere). */
  async streamIfThere(of: BytesOwner): Promise<Readable | null> {
    try {
      return await this.stream(of);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Deletes a post's bytes and its meta file. `images` is how many images its meta file says it
   * has (see ContentMeta.images), for an image post of several: each is deleted with them.
   */
  async remove(contentId: string, images = 1): Promise<void> {
    const keys = Array.from({ length: Math.max(1, images) }, (_, i) => imageKey(contentId, i + 1));
    for (const key of keys) this.links.delete(key);
    await Promise.all([...keys, metaKey(contentId)].map((key) => this.op.delete(key).catch(() => {})));
  }

  /**
   * Deletes one image of an image post, by its place among the post's images: one after the
   * first, which an update of the post left it without. One that isn't there is no error.
   */
  async removeImage(contentId: string, image: number): Promise<void> {
    if (image < 2) throw new Error(`image ${image} of ${contentId} is the post's bytes, which go with the post`);
    this.links.delete(imageKey(contentId, image));
    await this.op.delete(imageKey(contentId, image));
  }

  /**
   * Copies the bytes of `of` to a local file, which is made, or written over: what the video
   * worker reads a staged video with. Fails, with an error isNotFound knows, if `of` has none.
   */
  async fetchTo(of: BytesOwner, localPath: string): Promise<void> {
    await pipeline(await this.stream(of), createWriteStream(localPath));
  }

  /**
   * Deletes what the server made of a post's video beside the post's bytes: the poster and the
   * stream of one version of it (`videoId`, see StoredVideo.id), or with none, of every version
   * there is, which is what goes with the post. Nothing there is no error.
   */
  async removeMedia(contentId: string, videoId?: string): Promise<void> {
    if (videoId !== undefined && !MEDIA_ID.test(videoId)) throw new Error(`"${videoId}" is not the id of a video`);
    const prefix = videoId === undefined ? mediaPrefix(contentId) : `${mediaPrefix(contentId)}${videoId}/`;
    // The links a signer gave to its files are forgotten with them.
    for (const key of this.links.keys()) if (key.startsWith(prefix)) this.links.delete(key);
    try {
      await this.op.removeAll(prefix);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  /** Deletes the image of an ad. One that isn't there is no error: a text ad has none. */
  async removeAdImage(adId: string): Promise<void> {
    this.links.delete(adImageKey(adId));
    await this.op.delete(adImageKey(adId)).catch(() => {});
  }

  /** Deletes one avatar of a user's: the one another took the place of, or that the user took away. One that isn't there is no error. */
  async removeAvatar(userId: string, avatarId: string): Promise<void> {
    this.links.delete(avatarKey(userId, avatarId));
    await this.op.delete(avatarKey(userId, avatarId));
  }

  /**
   * Deletes every avatar the store holds of a user: the one they have, and any that a request
   * which died left behind. What goes with the account. Nothing there is no error.
   */
  async removeAvatars(userId: string): Promise<void> {
    await this.removeUnder(avatarPrefix(userId));
  }

  /** Deletes one splash image of a user's: the one another took the place of, or that the user took away. One that isn't there is no error. */
  async removeSplash(userId: string, splashId: string): Promise<void> {
    this.links.delete(splashKey(userId, splashId));
    await this.op.delete(splashKey(userId, splashId));
  }

  /**
   * Deletes every splash image the store holds of a user: the one they have, and any that a
   * request which died left behind. What goes with the account. Nothing there is no error.
   */
  async removeSplashes(userId: string): Promise<void> {
    await this.removeUnder(splashPrefix(userId));
  }

  /** Deletes every file kept under `prefix`, and forgets the links a signer gave to them. Nothing there is no error. */
  private async removeUnder(prefix: string): Promise<void> {
    for (const key of this.links.keys()) if (key.startsWith(prefix)) this.links.delete(key);
    try {
      await this.op.removeAll(prefix);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  /**
   * A short-lived link to upload a file with, or null when the backend can't presign (fs, sftp,
   * webdav, ...) or its signer has just failed. The link can't hold the client to a size or a
   * content type: adoptUpload checks the one and sets the other.
   */
  async presignUpload(userId: string, uploadId: string, mimeType: string): Promise<UploadLink | null> {
    if (this.signer) {
      const link = await this.signed((signer) => signer.upload(uploadKey(userId, uploadId), this.signedUrlSeconds));
      return link && { ...link, headers: { ...link.headers, 'content-type': mimeType } };
    }
    if (!this.presignWriteSupported) return null;
    // Tried rather than asked of capability(): azblob signs links with an account key yet says it can't.
    try {
      const { method, url, headers } = await this.op.presignWrite(uploadKey(userId, uploadId), this.signedUrlSeconds);
      // The client's HTTP library sets Host itself; browsers refuse to be told.
      return { method, url, headers: { ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'host')), 'content-type': mimeType } };
    } catch {
      this.presignWriteSupported = false;
      return null;
    }
  }

  /** An upload's size and the content type it was sent with (null where the backend keeps none), or null if there is none. */
  async statUpload(userId: string, uploadId: string): Promise<{ size: number; contentType: string | null } | null> {
    try {
      const stat = await this.op.stat(uploadKey(userId, uploadId));
      return { size: Number(stat.contentLength ?? 0), contentType: stat.contentType || null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Makes an upload `of`'s bytes, over the ones it had, and returns their size as stored: a staged
   * file's, for a post or a comment (see stageUpload). Copied within the backend where it can and the
   * upload was sent with the content's type, else through this process. Throws UploadTooLargeError
   * if the bytes are more than `maxBytes`.
   *
   * Whoever holds the upload link can replace the upload until the link expires, so its size is
   * checked again here, before anything is written, and once more on the copy, where no client can
   * write. A copy that turns out too large is deleted: only a client that swapped its upload for a
   * larger one in that moment gets there, and what it loses is the bytes of its own post.
   */
  async adoptUpload(userId: string, uploadId: string, of: BytesOwner, mimeType: string, maxBytes: number): Promise<StoredBytes> {
    const from = uploadKey(userId, uploadId);
    const to = bytesKey(of);
    const upload = await this.op.stat(from);
    if (Number(upload.contentLength ?? 0) > maxBytes) throw new UploadTooLargeError(maxBytes);
    const sent = upload.contentType || null;
    try {
      if (
        this.op.capability().copy &&
        (sent === null || sent === mimeType) &&
        (await this.op.copy(from, to).then(
          () => true,
          () => false,
        ))
      ) {
        const size = Number((await this.op.stat(to)).contentLength ?? 0);
        if (size > maxBytes) throw new UploadTooLargeError(maxBytes);
        return { size };
      }
      return await this.measure(from, maxBytes, (await this.op.writer(to, { contentType: mimeType })).createWriteStream());
    } catch (err) {
      if (err instanceof UploadTooLargeError) await this.op.delete(to).catch(() => {});
      throw err;
    }
  }

  /** The first `bytes` bytes of an upload, which must be that long. */
  async uploadHead(userId: string, uploadId: string, bytes: number): Promise<Buffer> {
    return this.op.read(uploadKey(userId, uploadId), { offset: 0n, size: BigInt(bytes) });
  }

  /**
   * An upload's bytes, for a caller that makes them a piece of content's itself (an image's are
   * stored without their metadata; see stripImage). The stream fails with UploadTooLargeError once
   * it is past `maxBytes`: whoever holds the upload link can replace the upload at any time.
   */
  async streamUpload(userId: string, uploadId: string, maxBytes: number): Promise<Readable> {
    const source = await streamObject(this.op, uploadKey(userId, uploadId));
    let size = 0;
    return Readable.from(
      (async function* () {
        try {
          for await (const chunk of source as AsyncIterable<Buffer>) {
            size += chunk.length;
            if (size > maxBytes) throw new UploadTooLargeError(maxBytes);
            yield chunk;
          }
        } finally {
          source.destroy();
        }
      })(),
    );
  }

  async removeUpload(userId: string, uploadId: string): Promise<void> {
    await this.op.delete(uploadKey(userId, uploadId)).catch(() => {});
  }

  /** Copies an object to `into`, counting its bytes on the way. */
  private async measure(key: string, maxBytes: number, into: NodeJS.WritableStream): Promise<StoredBytes> {
    let size = 0;
    await pipeline(
      await streamObject(this.op, key),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > maxBytes) return cb(new UploadTooLargeError(maxBytes));
          cb(null, chunk);
        },
      }),
      into,
    );
    return { size };
  }

  /** A short-lived direct download URL, or null when the backend can't presign (fs, sftp, webdav, ...) or its signer has just failed. */
  async signedUrl(of: BytesOwner): Promise<string | null> {
    if (this.signer) return this.signerUrl(bytesKey(of));
    if (!this.presignSupported) return null;
    if (!this.op.capability().presignRead) {
      this.presignSupported = false;
      return null;
    }
    try {
      return (await this.op.presignRead(bytesKey(of), this.signedUrlSeconds)).url;
    } catch {
      this.presignSupported = false;
      return null;
    }
  }

  /**
   * What the signer gives, or null where it fails or has just failed. The failure is logged here,
   * as it is nobody's error to answer for: the request it was for is served without the link.
   */
  private async signed<T>(sign: (signer: LinkSigner) => Promise<T>): Promise<T | null> {
    if (!this.signer || this.now() < this.signerPausedUntil) return null;
    try {
      return await sign(this.signer);
    } catch (err) {
      this.signerPausedUntil = this.now() + SIGNER_PAUSE_MS;
      console.error(JSON.stringify({ level: 'error', msg: `could not sign a link to the content store: files go through the app for the next ${SIGNER_PAUSE_MS / 1000} seconds`, err: err instanceof Error ? err.message : String(err) }));
      return null;
    }
  }

  /** The signer's link to read the object `key` with: the one given before, until half its time has passed, or a new one. */
  private async signerUrl(key: string): Promise<string | null> {
    const now = this.now();
    const kept = this.links.get(key);
    if (kept && kept.until > now) return kept.url;
    // Kept as it is asked for, so that requests for one object at one moment share one signature.
    const link = { url: this.signed((signer) => signer.download(key, this.signedUrlSeconds)), until: now + (this.signedUrlSeconds * 1000) / 2 };
    this.links.delete(key);
    if (this.links.size >= LINK_CACHE_SIZE) this.links.delete(this.links.keys().next().value!);
    this.links.set(key, link);
    if ((await link.url) === null && this.links.get(key) === link) this.links.delete(key);
    return link.url;
  }
}
