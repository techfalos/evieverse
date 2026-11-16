/**
 * URLhaus's list of the URLs that spread malware (https://urlhaus.abuse.ch), as this process holds
 * it: in memory, so that checking a link is a lookup, and nothing is asked of URLhaus while a post
 * waits. It is downloaded whole, and again every `urlhaus.refreshMinutes`.
 */
export interface Listed {
  /** The hosts that have a URL on the list, which is what most links are told apart by, each with the length of its longest. */
  hosts: Map<string, number>;
  /** The URLs, each as `addressOf` writes it in full. */
  urls: Set<string>;
}
