import type { Block } from '../../src/format.js';
import type { Mention } from '../../src/mentions.types.js';

/** format.js, for the test that holds it to what src/format.ts reads (test/formatting.test.ts). */
export function parseFormatted(text: string, mentions?: readonly Mention[]): Block[];
