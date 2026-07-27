/**
 * Negative fixture for the path-consumer extractor: no filesystem or process
 * signal of any kind. The self-test asserts this file produces zero signals,
 * so the extractor cannot silently over-match (e.g. on unrelated `.fs`
 * property names or non-filesystem imports).
 */
import * as path from "node:path";

export const cleanFixture = {
  fs: "just a property name, not the module",
  join: (a: string, b: string): string => path.join(a, b),
};
