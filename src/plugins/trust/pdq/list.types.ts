/**
 * The list of PDQ hashes of known child sexual abuse material, as this process holds it: in
 * memory, about 100 bytes a hash, with an index that finds the hashes near another without
 * comparing it with each (see nearest in list.ts). It is read whole from `pdq.hashList`, and
 * again every `pdq.refreshMinutes`.
 */
export interface HashList {
  /** How many hashes it has. */
  size: number;
  /** Their words, 16 to a hash (see PdqHash), one hash after another. */
  words: Uint16Array;
  /**
   * Where in `ids` each table of the index starts. There is a table for each value each of a
   * hash's 16 words can have: that of word `w` with the value `v` is at `w * 65536 + v`, and ends
   * where the next starts.
   */
  starts: Uint32Array;
  /** The tables, one after another: the hashes (by their place in `words`) that have that value in that word. */
  ids: Uint32Array;
}

/** The listed hash nearest an image's, where one is near enough to be of the same picture. */
export interface Match {
  /** The listed hash, as it is written: 64 hex digits. */
  listed: string;
  /** How many of the 256 bits it differs from the image's hash in. */
  distance: number;
}
