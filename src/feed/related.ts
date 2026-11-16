/**
 * The hashtags a feed adds to the ones it was asked for (`addRelated`), in the order they take
 * turns after them. `relatedOf` holds each requested hashtag's related ones, most related first.
 * Every requested hashtag gets its most related one in before any gets its second, hashtags already
 * asked for or already added are passed over, and the feed reads at most `max` hashtags in all.
 */
export function relatedTo(tags: string[], relatedOf: string[][], max: number): string[] {
  const taken = new Set(tags);
  const added: string[] = [];
  const deepest = Math.max(0, ...relatedOf.map((related) => related.length));
  for (let rank = 0; rank < deepest; rank++) {
    for (const related of relatedOf) {
      const tag = related[rank];
      if (tag === undefined || taken.has(tag)) continue;
      if (taken.size >= max) return added;
      taken.add(tag);
      added.push(tag);
    }
  }
  return added;
}
