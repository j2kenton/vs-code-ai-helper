/**
 * Minimal ambient typings for Node's built-in `node:sqlite` module.
 *
 * The repo pins @types/node 20, which predates the module (shipped unflagged
 * in Node 22.13/23.4; this workspace runs Node 24). Only the surface
 * `sqliteStoreV1.ts` actually uses is declared here; when @types/node moves
 * to a version that bundles `sqlite.d.ts`, this file can simply be deleted.
 */
declare module "node:sqlite" {
  type SqliteInputValueV1 = string | number | bigint | null | Uint8Array;

  interface SqliteRunResultV1 {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
  }

  class StatementSync {
    run(...params: SqliteInputValueV1[]): SqliteRunResultV1;
    get(...params: SqliteInputValueV1[]): unknown;
    all(...params: SqliteInputValueV1[]): unknown[];
  }

  class DatabaseSync {
    constructor(path: string);
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
