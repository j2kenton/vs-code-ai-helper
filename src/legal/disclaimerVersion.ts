/**
 * Canonical disclaimer version number.
 *
 * This value must match the `Version: N` line in DISCLAIMER.md.
 * The AI consent gate stores `aiHelper.consent.v<N>` in workspaceState so
 * bumping the version here automatically re-prompts existing users.
 *
 * A unit test in src/test/disclaimerVersion.test.ts asserts that this
 * value matches the Version line in DISCLAIMER.md.
 */
export const DISCLAIMER_VERSION = 2;
