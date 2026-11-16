import type { ContentMeta } from '../storage/index.js';

/** What applying the pending writes did (see applyPending). */
export interface Applied {
  /** The meta files it wrote, by content: what the rest of the run reads of those posts. */
  metas: Map<string, ContentMeta>;
  /**
   * The posts whose newest write couldn't be applied: their meta files are the ones before it, so
   * the run leaves their rows in the feed queue alone, for the run that does apply it.
   */
  failed: Set<string>;
}
