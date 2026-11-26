/**
 * What an engaged feed keeps of the engagement it was given (see `engagementWeights`): the
 * hashtags and the users its reader has liked and viewed most, each with its share of what the
 * reader liked and viewed of all that are kept, out of WEIGHT_SCALE. Those liked and viewed most
 * come first. A session's cursor carries it from page to page, so every page goes by what the
 * first one was given.
 */
export interface EngagementWeights {
  tags: [tag: string, weight: number][];
  users: [userId: string, weight: number][];
}
