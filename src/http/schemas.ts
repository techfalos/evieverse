import { z } from 'zod';
import { messageKey } from '../language.js';
import { normalizeTag } from '../tags.js';

/** Who's asking, in the body or form fields; the headers can hold them instead (see authenticate). */
export const Credentials = z.object({ userId: z.string().optional(), apiKey: z.string().optional() });
export type Credentials = z.infer<typeof Credentials>;

/** A hashtag as a request names it: letters, digits and _, with or without #, in any case. */
export const HASHTAG = /^#?[A-Za-z0-9_]{1,64}$/;

/** A hashtag in a path, as /feed takes them, read as the server keeps it: "#News" is "news". */
export const Hashtag = z
  .string()
  .regex(HASHTAG, messageKey('tags.invalid'))
  .transform((t) => normalizeTag(t)!);

/** A yes or no, as JSON sends it or as a form field does ("true", "false", "1", "0", ...). */
export const Flag = z.union([z.boolean(), z.stringbool()]);

/** A page of a list of users (see listPage). */
export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  cursor: z.string().optional(),
});
