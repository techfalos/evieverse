/** The PDQ hash of an image, and how far it is to be relied on. */
export interface PdqHash {
  /**
   * Its 256 bits as 16 words of 16: bit k, which is the frequency at row k >> 4 and column k & 15
   * of the 16 by 16, is bit k & 15 of word k >> 4. Written as hex, the last word comes first (see toHex).
   */
  words: Uint16Array;
  /** From 0 to 100: how much there is in the image to tell it by. A hash of low quality matches images it has nothing to do with. */
  quality: number;
}
