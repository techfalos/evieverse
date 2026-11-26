/** A key a server signs attestations with, as it publishes it (GET /repost/keys): anyone checks a signature with it. */
export interface PublishedKey {
  /** What an attestation names its key by: the start of the SHA-256 of the public key, in hex. */
  id: string;
  /** The Ed25519 public key: its 32 bytes, in base64url. */
  publicKey: string;
}

/** A key of this server's own, which signs: the published key, and what the private key is made from. */
export interface SigningKey extends PublishedKey {
  /**
   * The 32 random bytes the key is made from, as the setting writes them (`reposts.signingKeys`).
   * A secret: it is kept where copying, sending or logging the key leaves it behind.
   */
  readonly seed: string;
}

/**
 * What every attestation says: `v` is the version of this format, `kid` the id of the key that
 * signed (see PublishedKey), `issuedAt` when, in UTC epoch milliseconds, by the clock of the
 * server that signed, and `url` the post it is of.
 */
export interface Signed {
  v: 1;
  kid: string;
  issuedAt: number;
  /**
   * The post's address on its own server: https://other.example/content/<id>, with nothing after
   * the id and nobody's credentials in it. Its id is read in lower case, so that a post has one
   * address however it was written (see `content.origin_hash`).
   */
  url: string;
}

/** What a video its server processed is, as an attestation says it: its poster and its stream are read on that server, under this id. */
export interface AttestedVideo {
  id: string;
  width: number;
  height: number;
  /** In seconds. */
  duration: number;
}

/**
 * A post's summary as an attestation gives it, as feeds show it on the post's server. An
 * image's, video's or audio's has no `url`: the bytes are read at the post's address. An image
 * post of several images says how many (`imageCount`): each after the first is read at the
 * address of the bytes and its place among them, counted from 1. One whose images are described
 * says how (`alt`): the alternative text of each, in their order, '' for one that has none.
 */
export type AttestedPreview =
  | { kind: 'text'; text: string }
  | { kind: 'image'; text?: string; imageCount?: number; alt?: string[] }
  | { kind: 'video'; text?: string; video?: AttestedVideo }
  | { kind: 'audio'; text?: string }
  | { kind: 'link'; url: string };

/** What an attestation says of a post that is there: the post, as its own server gives it. */
export interface AttestedPost extends Signed {
  /** Who published it there. The name is one line: it is kept on a line of the summary. */
  publisher: { userId: string; username: string };
  /** Its content type, in lower case. Needed of an image, video or audio; a text's and a link's are their own. */
  mimeType?: string;
  aiGenerated: boolean;
  /** Its title, where it has one: one line of plain text, MAX_TITLE_CHARS at most. */
  title?: string;
  preview: AttestedPreview;
}

/**
 * What an attestation says of an address at which the server publishes no post: `gone`, and
 * nothing of a post. It is what a server signs for a post it deleted, and for anything else that
 * isn't published there, which it doesn't tell apart for anyone.
 */
export interface AttestedGone extends Signed {
  gone: true;
}

/** What a server says of a post to attest it: all of an attestation but what signing adds. */
export type Attestable = Omit<AttestedPost, 'v' | 'kid' | 'issuedAt'>;

/** What a server says of an address it publishes no post at, to attest that. */
export type AttestableGone = Omit<AttestedGone, 'v' | 'kid' | 'issuedAt'>;

/** Something a payload says that an attestation doesn't, or doesn't say that one must: where in the payload, and what is wrong there. */
export interface AttestationIssue {
  path: string[];
  message: string;
}

/**
 * An attestation taken apart, before anything of it is believed: what it says, and what that
 * comes to. Who signed it is asked of `signedBy`.
 */
export interface ReadAttestation {
  /** The payload as JSON reads it, whatever it says. */
  payload: unknown;
  /** The attestation as it arrived, which is what its signature is checked against. */
  text: string;
  /** What it says, where it says what an attestation says: a post, or that there is none. */
  said?: AttestedPost | AttestedGone;
  /** What it says that an attestation doesn't, where `said` is not there. */
  issues?: AttestationIssue[];
}

/** What the address of a post says of where the post is. */
export interface PostAddress {
  /** The post's id, as the address writes it. */
  id: string;
  /** The server it is on: the address without what names the post. */
  server: string;
  /** Whether that server is one that is asked for its keys: over https, on the port https has. */
  asked: boolean;
}
