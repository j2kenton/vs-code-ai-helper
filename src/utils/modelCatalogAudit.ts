/**
 * Pure helpers for the model-catalog audit (see
 * test-fixtures/model-catalog/audit-2026-09.md for the availability policy).
 *
 * The audit manifest (`audit-2026-09.json`) records, per provider block, what
 * was checked against the provider's own catalog and what was decided. These
 * helpers validate that manifest, correlate it with the seeded catalog, and
 * compare seed vs. live discovery output. The module is shared by the unit
 * tests and `scripts/checkModelCatalogDrift.mjs`, so it deliberately imports
 * neither `vscode` nor `runners/providers.ts`: it must load under plain node.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** `ProviderId` values, mirrored here so the module needs no providers.ts import (a test pins the two lists together). */
export const AUDIT_PROVIDER_IDS = [
  "copilot",
  "claude-cli",
  "codex-cli",
  "gemini-cli",
  "antigravity-cli",
  "kiro-cli",
  "opencode-cli",
  "cline-cli",
  "kimi-cli",
  "devpass-cli",
] as const;
export type AuditProviderId = (typeof AUDIT_PROVIDER_IDS)[number];

export const AUDIT_SEEDED_STATUSES = [
  "verified",
  "added",
  "relabelled",
  "verified-conditional",
  "unverified",
] as const;
export const AUDIT_UNSEEDED_STATUSES = ["removed", "not-added"] as const;
export const AUDIT_ENTRY_STATUSES = [
  ...AUDIT_SEEDED_STATUSES,
  ...AUDIT_UNSEEDED_STATUSES,
] as const;
export type AuditEntryStatus = (typeof AUDIT_ENTRY_STATUSES)[number];

export const AUDIT_COVERAGE_MODES = ["entries", "snapshot"] as const;
export type AuditCoverageMode = (typeof AUDIT_COVERAGE_MODES)[number];

export const AUDIT_REMOVAL_KINDS = [
  "documented-retirement",
  "universal-catalog",
  "all-path-classes",
] as const;
export type AuditRemovalKind = (typeof AUDIT_REMOVAL_KINDS)[number];

export const AUDIT_CATALOG_AUTHORITIES = [
  "entitlement-independent",
  "context-only",
] as const;
export type AuditCatalogAuthority = (typeof AUDIT_CATALOG_AUTHORITIES)[number];

export const AUDIT_SAVED_SELECTION_OUTCOMES = ["alias", "preserve"] as const;
export type AuditSavedSelectionOutcome =
  (typeof AUDIT_SAVED_SELECTION_OUTCOMES)[number];

/** Manifest path relative to the repository root, kept as one constant so every consumer resolves the same file. */
export const AUDIT_MANIFEST_RELATIVE_TAIL = [
  "test-fixtures",
  "model-catalog",
  "audit-2026-09.json",
] as const;

export interface AuditRemovalEvidence {
  kind: AuditRemovalKind;
  source: string;
  date: string;
  /** `universal-catalog`: why the source does not depend on the account's entitlements. */
  citation?: string;
  /** `all-path-classes`: one capture per supported path class. */
  captures?: { pathClass: string; capturedAt: string; authContext: string }[];
}

export interface AuditSavedSelection {
  outcome: AuditSavedSelectionOutcome;
  /** `alias`: the replacement id, and the provider document that names it. */
  target?: string;
  source?: string;
}

export interface AuditFreeEvidence {
  /** Where the dated $0 evidence comes from (pricing page URL, verbose cost fields, ...). */
  source: string;
  /** ISO date the $0 status was confirmed. */
  date: string;
}

export interface AuditEntry {
  /** Provider-local base id: no provider prefix, no `@effort`, no `+fast`. */
  id: string;
  status: AuditEntryStatus;
  checkedAt?: string;
  source?: string;
  note?: string;
  reason?: string;
  /** `verified-conditional`: the label qualifier shown to users, e.g. `(API key only)`. */
  qualifier?: string;
  free?: AuditFreeEvidence;
  /** Provider-local id of the sibling that must ship with this entry (Fable 5 -> Fable 5.1). */
  requiresCompanion?: string;
  removalEvidence?: AuditRemovalEvidence;
  savedSelection?: AuditSavedSelection;
}

export interface AuditSnapshot {
  /** The exact capture command, e.g. `opencode models --verbose`. */
  command: string;
  cliVersion: string;
  /** ISO date of the capture. */
  capturedAt: string;
  authContext: string;
  catalogAuthority: AuditCatalogAuthority;
  /** Required when `catalogAuthority` is `entitlement-independent`: why the source does not depend on the account. */
  citation?: string;
}

/** The context a picker record's conclusions apply to. */
export interface AuditRecordEvidence {
  /** Sign-in mode, tier and client version the conclusions apply to. */
  authContext: string;
  cliVersion: string;
  /** The exact command, or the official URL, the evidence came from. */
  source: string;
  /** ISO date the evidence was gathered. */
  date: string;
}

export interface AuditProviderRecord {
  provider: AuditProviderId;
  /**
   * The resolved block name. In the JSON it is required only for providers
   * with more than one row in `AUDIT_BLOCKS` and omitted otherwise; after
   * validation a single-block provider's record carries `"default"`.
   */
  block: string;
  scope: AuditBlockScope;
  /** Picker records only. */
  defaultAuthPath?: string;
  /** Picker records only: every class of authentication path Ensemble can drive. */
  supportedPathClasses?: string[];
  /** Picker records only. */
  evidence?: AuditRecordEvidence;
  /** Non-picker records only: why the block is outside the audit. */
  reason?: string;
  coverage?: AuditCoverageMode;
  snapshot?: AuditSnapshot;
  freeLabelsAudited?: boolean;
  entries?: AuditEntry[];
  notes?: string;
}

export interface AuditProviderContext {
  defaultAuthPath: string;
  supportedPathClasses: string[];
}

export interface AuditWaiver {
  id: string;
  reason: string;
  decision: string;
}

export interface AuditManifest {
  version: number;
  auditDate: string;
  policy: string;
  providerContext: Partial<Record<AuditProviderId, AuditProviderContext>>;
  humanScopeWaivers: AuditWaiver[];
  records: AuditProviderRecord[];
  notes?: string;
}

/** Fields every entry of a given status must carry (besides `id` and `status`). */
export const AUDIT_REQUIRED_ENTRY_FIELDS: Readonly<
  Record<AuditEntryStatus, readonly (keyof AuditEntry)[]>
> = {
  verified: ["checkedAt", "source"],
  added: ["checkedAt", "source"],
  relabelled: ["checkedAt", "source", "note"],
  "verified-conditional": ["checkedAt", "source", "qualifier"],
  unverified: ["reason"],
  removed: ["checkedAt", "source", "removalEvidence", "savedSelection"],
  "not-added": ["reason"],
};

export const AUDIT_REQUIRED_RECORD_FIELDS = ["provider", "scope"] as const;
export const AUDIT_REQUIRED_PICKER_FIELDS = [
  "defaultAuthPath",
  "supportedPathClasses",
  "evidence",
  "coverage",
  "freeLabelsAudited",
  "entries",
] as const;
export const AUDIT_REQUIRED_MANIFEST_FIELDS = [
  "version",
  "auditDate",
  "policy",
  "providerContext",
  "humanScopeWaivers",
  "records",
] as const;
export const AUDIT_REQUIRED_EVIDENCE_FIELDS = ["authContext", "cliVersion", "source", "date"] as const;
export const AUDIT_REQUIRED_SNAPSHOT_FIELDS = [
  "command",
  "cliVersion",
  "capturedAt",
  "authContext",
  "catalogAuthority",
] as const;

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export type AuditBlockScope = "picker" | "non-picker";

export interface AuditBlockDef {
  block: string;
  scope: AuditBlockScope;
  /** Base-id prefix that selects this block; absent means "everything else". */
  prefix?: string;
}

const DEFAULT_BLOCK: readonly AuditBlockDef[] = [{ block: "default", scope: "picker" }];

/**
 * The independently-audited slices of each provider's seed. OpenCode is three
 * blocks because its one CLI fronts three account tiers (see
 * providerAccountIdForModelId); order matters, the catch-all comes last.
 */
export const AUDIT_BLOCKS: Readonly<Record<AuditProviderId, readonly AuditBlockDef[]>> = {
  copilot: DEFAULT_BLOCK,
  "claude-cli": DEFAULT_BLOCK,
  "codex-cli": DEFAULT_BLOCK,
  "gemini-cli": DEFAULT_BLOCK,
  "antigravity-cli": DEFAULT_BLOCK,
  "kiro-cli": DEFAULT_BLOCK,
  "opencode-cli": [
    { block: "opencode-go", scope: "picker", prefix: "opencode-go/" },
    { block: "opencode", scope: "picker", prefix: "opencode/" },
    { block: "external", scope: "non-picker" },
  ],
  "cline-cli": DEFAULT_BLOCK,
  "kimi-cli": DEFAULT_BLOCK,
  "devpass-cli": DEFAULT_BLOCK,
};

export function isAuditProviderId(value: unknown): value is AuditProviderId {
  return typeof value === "string" && (AUDIT_PROVIDER_IDS as readonly string[]).includes(value);
}

/** The block a provider-local base id belongs to; throws when no block matches. */
export function blockForSeedId(
  providerId: AuditProviderId,
  baseModelId: string,
  blocks: Readonly<Record<AuditProviderId, readonly AuditBlockDef[]>> = AUDIT_BLOCKS
): AuditBlockDef {
  for (const def of blocks[providerId]) {
    if (def.prefix === undefined || baseModelId.startsWith(def.prefix)) {
      return def;
    }
  }
  throw new Error(`No audit block for ${providerId}:${baseModelId}`);
}

export interface SeedBlockGroup<T> {
  block: string;
  scope: AuditBlockScope;
  entries: T[];
}

/** Groups seeded entries by block, in `AUDIT_BLOCKS` order, dropping empty blocks. */
export function partitionSeedByBlock<T extends { model: string }>(
  providerId: AuditProviderId,
  entries: readonly T[]
): SeedBlockGroup<T>[] {
  const groups = new Map<string, SeedBlockGroup<T>>();
  for (const def of AUDIT_BLOCKS[providerId]) {
    groups.set(def.block, { block: def.block, scope: def.scope, entries: [] });
  }
  for (const entry of entries) {
    const def = blockForSeedId(providerId, stripVariantSuffixes(entry.model));
    groups.get(def.block)?.entries.push(entry);
  }
  return [...groups.values()].filter((group) => group.entries.length > 0);
}

// ---------------------------------------------------------------------------
// Ids and labels
// ---------------------------------------------------------------------------

/** Removes `+fast` and the trailing `@effort`, splitting at the last `@` the way the runners do (splitModelAtLastAt). */
export function stripVariantSuffixes(modelId: string): string {
  const withoutFast = modelId.endsWith("+fast") ? modelId.slice(0, -"+fast".length) : modelId;
  const separator = withoutFast.lastIndexOf("@");
  return separator <= 0 ? withoutFast : withoutFast.slice(0, separator);
}

/** `<providerId>:<baseModelId>` with every effort/fast variant collapsed to its base model. */
export function toBaseSelectionId(providerId: string, modelId: string): string {
  return `${providerId}:${stripVariantSuffixes(modelId)}`;
}

/** Splits `<providerId>:<baseModelId>`; undefined when the prefix is not a real provider id. */
export function splitBaseSelectionId(
  selectionId: string
): { provider: AuditProviderId; baseId: string } | undefined {
  const colon = selectionId.indexOf(":");
  if (colon <= 0) {
    return undefined;
  }
  const provider = selectionId.slice(0, colon);
  return isAuditProviderId(provider) ? { provider, baseId: selectionId.slice(colon + 1) } : undefined;
}

const FREE_BRACKETED = /\s*\(free\)/gi;
const FREE_WORD = /\s*\bfree\b/gi;

/** True for the bracketed token `(Free)` or the standalone word `Free` (`Freedom` does not count). */
export function hasFreeMarker(name: string): boolean {
  return /\(free\)|\bfree\b/i.test(name);
}

/** Removes either free-marker form and tidies spacing; a trailing `(high)` variant suffix is left intact. */
export function stripFreeMarker(name: string): string {
  return name
    .replace(FREE_BRACKETED, "")
    .replace(FREE_WORD, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Manifest path and validation
// ---------------------------------------------------------------------------

/** Nearest ancestor holding both `package.json` and `test-fixtures/` (the repository root), then the manifest tail. */
export function resolveAuditManifestPath(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "test-fixtures"))
    ) {
      return path.join(dir, ...AUDIT_MANIFEST_RELATIVE_TAIL);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Cannot locate the repository root (a directory with package.json and test-fixtures/) above ${startDir}`
      );
    }
    dir = parent;
  }
}

export interface AuditValidationOptions {
  /** `VERIFIED_FREE_MODEL_IDS`; when given, no id may fall in a non-picker block. */
  freeAllowlist?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validates an already-parsed manifest; every failure names the provider and id involved. */
export function validateAuditManifest(
  raw: unknown,
  options: AuditValidationOptions = {}
): AuditManifest {
  if (!isRecord(raw)) {
    throw new Error("Audit manifest must be a JSON object");
  }
  for (const field of AUDIT_REQUIRED_MANIFEST_FIELDS) {
    if (raw[field] === undefined) {
      throw new Error(`Audit manifest is missing required field "${field}"`);
    }
  }
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    throw new Error('Audit manifest field "version" must be a positive integer');
  }
  if (!isNonEmptyString(raw.auditDate)) {
    throw new Error('Audit manifest field "auditDate" must be a non-empty string');
  }
  if (!isNonEmptyString(raw.policy)) {
    throw new Error('Audit manifest field "policy" must be a non-empty string');
  }
  if (raw.notes !== undefined && typeof raw.notes !== "string") {
    throw new Error('Audit manifest field "notes" must be a string');
  }
  if (!Array.isArray(raw.records)) {
    throw new Error('Audit manifest field "records" must be an array');
  }
  const providerContext = validateProviderContext(raw.providerContext);
  const humanScopeWaivers = validateWaivers(raw.humanScopeWaivers);

  const seen = new Set<string>();
  const records = raw.records.map((rawRecord, index) => {
    const record = validateRecord(rawRecord, index, providerContext);
    const key = `${record.provider}/${record.block}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate audit record for ${record.provider} block "${record.block}"`);
    }
    seen.add(key);
    return record;
  });

  for (const id of options.freeAllowlist ?? []) {
    const split = splitBaseSelectionId(id);
    if (split && blockForSeedId(split.provider, split.baseId).scope === "non-picker") {
      throw new Error(`Free allowlist id ${id} falls in a non-picker block`);
    }
  }

  return {
    version: raw.version,
    auditDate: raw.auditDate,
    policy: raw.policy,
    providerContext,
    humanScopeWaivers,
    records,
    ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
  };
}

function validateProviderContext(raw: unknown): AuditManifest["providerContext"] {
  if (!isRecord(raw)) {
    throw new Error('Audit manifest field "providerContext" must be an object');
  }
  const context: AuditManifest["providerContext"] = {};
  for (const [provider, value] of Object.entries(raw)) {
    if (!isAuditProviderId(provider)) {
      throw new Error(`providerContext names unknown provider "${provider}"`);
    }
    if (
      !isRecord(value) ||
      !isNonEmptyString(value.defaultAuthPath) ||
      !Array.isArray(value.supportedPathClasses) ||
      !value.supportedPathClasses.every(isNonEmptyString)
    ) {
      throw new Error(
        `providerContext for ${provider} needs defaultAuthPath and a supportedPathClasses string array`
      );
    }
    context[provider] = {
      defaultAuthPath: value.defaultAuthPath,
      supportedPathClasses: [...value.supportedPathClasses],
    };
  }
  return context;
}

function validateWaivers(raw: unknown): AuditWaiver[] {
  if (!Array.isArray(raw)) {
    throw new Error('Audit manifest field "humanScopeWaivers" must be an array');
  }
  return raw.map((waiver, index) => {
    if (
      !isRecord(waiver) ||
      !isNonEmptyString(waiver.id) ||
      !isNonEmptyString(waiver.reason) ||
      !isNonEmptyString(waiver.decision)
    ) {
      throw new Error(`humanScopeWaivers[${index}] needs id, reason and decision`);
    }
    return { id: waiver.id, reason: waiver.reason, decision: waiver.decision };
  });
}

function validateRecord(
  raw: unknown,
  index: number,
  providerContext: AuditManifest["providerContext"]
): AuditProviderRecord {
  if (!isRecord(raw)) {
    throw new Error(`records[${index}] must be an object`);
  }
  const provider = raw.provider;
  if (!isAuditProviderId(provider)) {
    throw new Error(`records[${index}] has unknown provider ${JSON.stringify(provider)}`);
  }
  const providerBlocks = AUDIT_BLOCKS[provider];
  let blockDef: AuditBlockDef | undefined;
  if (providerBlocks.length === 1) {
    // Single-block providers omit `block`; naming one (even "default") is a schema violation.
    if (raw.block !== undefined) {
      throw new Error(`${provider} has a single block and its record must omit "block"`);
    }
    blockDef = providerBlocks[0];
  } else {
    blockDef = providerBlocks.find((def) => def.block === raw.block);
    if (!blockDef) {
      throw new Error(`${provider} record has unknown or missing block ${JSON.stringify(raw.block)}`);
    }
  }
  if (!blockDef) {
    throw new Error(`${provider} record has no audit block`);
  }
  const where = `${provider} block "${blockDef.block}"`;
  for (const field of AUDIT_REQUIRED_RECORD_FIELDS) {
    if (raw[field] === undefined) {
      throw new Error(`${where} is missing required field "${field}"`);
    }
  }
  if (raw.scope !== blockDef.scope) {
    throw new Error(`${where} has scope ${JSON.stringify(raw.scope)}, expected "${blockDef.scope}"`);
  }

  if (blockDef.scope === "non-picker") {
    for (const field of ["coverage", "snapshot", "entries"] as const) {
      if (raw[field] !== undefined) {
        throw new Error(`${where} is non-picker and must not carry "${field}"`);
      }
    }
    if (!isNonEmptyString(raw.reason)) {
      throw new Error(`${where} is non-picker and needs a "reason"`);
    }
    return { provider, block: blockDef.block, scope: "non-picker", reason: raw.reason };
  }

  const coverage = raw.coverage;
  if (!(AUDIT_COVERAGE_MODES as readonly unknown[]).includes(coverage)) {
    throw new Error(`${where} has missing or unknown coverage ${JSON.stringify(coverage)}`);
  }
  for (const field of AUDIT_REQUIRED_PICKER_FIELDS) {
    if (raw[field] === undefined) {
      throw new Error(`${where} is missing required field "${field}"`);
    }
  }
  if (typeof raw.freeLabelsAudited !== "boolean") {
    throw new Error(`${where} field "freeLabelsAudited" must be a boolean`);
  }
  if (!isNonEmptyString(raw.defaultAuthPath)) {
    throw new Error(`${where} field "defaultAuthPath" must be a non-empty string`);
  }
  if (!Array.isArray(raw.supportedPathClasses) || raw.supportedPathClasses.length === 0 || !raw.supportedPathClasses.every(isNonEmptyString)) {
    throw new Error(`${where} field "supportedPathClasses" must be a non-empty array of strings`);
  }
  const supportedPathClasses: string[] = [...raw.supportedPathClasses];
  const context = providerContext[provider];
  if (context && (context.defaultAuthPath !== raw.defaultAuthPath || context.supportedPathClasses.join("\n") !== supportedPathClasses.join("\n"))) {
    throw new Error(`${where} defaultAuthPath/supportedPathClasses disagree with providerContext for ${provider}`);
  }
  const evidence = validateRecordEvidence(raw.evidence, where);
  let snapshot: AuditSnapshot | undefined;
  if (coverage === "snapshot") {
    snapshot = validateSnapshot(raw.snapshot, where);
  } else if (raw.snapshot !== undefined) {
    throw new Error(`${where} has coverage "entries" but carries a snapshot object`);
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error(`${where} must carry an "entries" array`);
  }
  const ids = new Set<string>();
  const entries = raw.entries.map((rawEntry) => {
    const entry = validateEntry(rawEntry, provider, blockDef.block);
    if (ids.has(entry.id)) {
      throw new Error(`${where} lists entry id "${entry.id}" twice`);
    }
    ids.add(entry.id);
    return entry;
  });
  return {
    provider,
    block: blockDef.block,
    scope: "picker",
    defaultAuthPath: raw.defaultAuthPath,
    supportedPathClasses,
    evidence,
    coverage: coverage as AuditCoverageMode,
    freeLabelsAudited: raw.freeLabelsAudited,
    ...(snapshot ? { snapshot } : {}),
    entries,
    ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
  };
}

function validateRecordEvidence(raw: unknown, where: string): AuditRecordEvidence {
  if (!isRecord(raw)) {
    throw new Error(`${where} field "evidence" must be an object`);
  }
  for (const field of AUDIT_REQUIRED_EVIDENCE_FIELDS) {
    if (!isNonEmptyString(raw[field])) {
      throw new Error(`${where} evidence is missing required string "${field}"`);
    }
  }
  return {
    authContext: raw.authContext as string,
    cliVersion: raw.cliVersion as string,
    source: raw.source as string,
    date: raw.date as string,
  };
}

function validateSnapshot(raw: unknown, where: string): AuditSnapshot {
  if (!isRecord(raw)) {
    throw new Error(`${where} has coverage "snapshot" but no snapshot object`);
  }
  for (const field of AUDIT_REQUIRED_SNAPSHOT_FIELDS) {
    if (!isNonEmptyString(raw[field])) {
      throw new Error(`${where} snapshot is missing required string "${field}"`);
    }
  }
  if (!(AUDIT_CATALOG_AUTHORITIES as readonly unknown[]).includes(raw.catalogAuthority)) {
    throw new Error(`${where} snapshot has unknown catalogAuthority ${JSON.stringify(raw.catalogAuthority)}`);
  }
  if (raw.catalogAuthority === "entitlement-independent" && !isNonEmptyString(raw.citation)) {
    throw new Error(`${where} snapshot claims entitlement-independent authority without a citation`);
  }
  return {
    command: raw.command as string,
    cliVersion: raw.cliVersion as string,
    capturedAt: raw.capturedAt as string,
    authContext: raw.authContext as string,
    catalogAuthority: raw.catalogAuthority as AuditCatalogAuthority,
    ...(isNonEmptyString(raw.citation) ? { citation: raw.citation } : {}),
  };
}

function validateEntry(raw: unknown, provider: AuditProviderId, block: string): AuditEntry {
  if (!isRecord(raw) || !isNonEmptyString(raw.id)) {
    throw new Error(`${provider} block "${block}" has an entry without an id`);
  }
  const id = raw.id;
  const where = `${provider} entry "${id}"`;
  if (AUDIT_PROVIDER_IDS.some((known) => id.startsWith(`${known}:`))) {
    throw new Error(`${where} must be a provider-local id, not carry a provider prefix`);
  }
  if (stripVariantSuffixes(id) !== id) {
    throw new Error(`${where} must be a base id without an @effort or +fast suffix`);
  }
  let idBlock: string | undefined;
  try {
    idBlock = blockForSeedId(provider, id).block;
  } catch {
    idBlock = undefined;
  }
  if (idBlock !== block) {
    throw new Error(`${where} does not belong to block "${block}"`);
  }
  const status = raw.status;
  if (!(AUDIT_ENTRY_STATUSES as readonly unknown[]).includes(status)) {
    throw new Error(`${where} has unknown status ${JSON.stringify(status)}`);
  }
  const typedStatus = status as AuditEntryStatus;
  for (const field of AUDIT_REQUIRED_ENTRY_FIELDS[typedStatus]) {
    if (raw[field] === undefined || raw[field] === "") {
      throw new Error(`${where} (${typedStatus}) is missing required field "${field}"`);
    }
  }
  if ((AUDIT_UNSEEDED_STATUSES as readonly string[]).includes(typedStatus)) {
    for (const field of ["free", "requiresCompanion", "qualifier"] as const) {
      if (raw[field] !== undefined) {
        throw new Error(`${where} (${typedStatus}) must not carry "${field}"`);
      }
    }
  }
  const entry: AuditEntry = { id, status: typedStatus };
  for (const field of ["checkedAt", "source", "note", "reason", "qualifier", "requiresCompanion"] as const) {
    const value = raw[field];
    if (value !== undefined) {
      if (typeof value !== "string") {
        throw new Error(`${where} field "${field}" must be a string`);
      }
      entry[field] = value;
    }
  }
  if (raw.free !== undefined) {
    if (!isRecord(raw.free) || !isNonEmptyString(raw.free.source) || !isNonEmptyString(raw.free.date)) {
      throw new Error(`${where} "free" needs a source and a date`);
    }
    entry.free = { source: raw.free.source, date: raw.free.date };
  }
  if (raw.removalEvidence !== undefined) {
    entry.removalEvidence = validateRemovalEvidence(raw.removalEvidence, where);
  }
  if (raw.savedSelection !== undefined) {
    entry.savedSelection = validateSavedSelection(raw.savedSelection, where);
  }
  return entry;
}

function validateRemovalEvidence(raw: unknown, where: string): AuditRemovalEvidence {
  if (
    !isRecord(raw) ||
    !(AUDIT_REMOVAL_KINDS as readonly unknown[]).includes(raw.kind) ||
    !isNonEmptyString(raw.source) ||
    !isNonEmptyString(raw.date)
  ) {
    throw new Error(`${where} removalEvidence needs a known kind, a source and a date`);
  }
  const evidence: AuditRemovalEvidence = {
    kind: raw.kind as AuditRemovalKind,
    source: raw.source,
    date: raw.date,
  };
  if (isNonEmptyString(raw.citation)) {
    evidence.citation = raw.citation;
  }
  if (raw.captures !== undefined) {
    if (
      !Array.isArray(raw.captures) ||
      !raw.captures.every(
        (capture) =>
          isRecord(capture) &&
          isNonEmptyString(capture.pathClass) &&
          isNonEmptyString(capture.capturedAt) &&
          isNonEmptyString(capture.authContext)
      )
    ) {
      throw new Error(`${where} removalEvidence captures need pathClass, capturedAt and authContext`);
    }
    evidence.captures = (raw.captures as NonNullable<AuditRemovalEvidence["captures"]>).map((capture) => ({
      pathClass: capture.pathClass,
      capturedAt: capture.capturedAt,
      authContext: capture.authContext,
    }));
  }
  return evidence;
}

function validateSavedSelection(raw: unknown, where: string): AuditSavedSelection {
  if (!isRecord(raw) || !(AUDIT_SAVED_SELECTION_OUTCOMES as readonly unknown[]).includes(raw.outcome)) {
    throw new Error(`${where} savedSelection needs an outcome of alias or preserve`);
  }
  if (raw.outcome === "alias" && (!isNonEmptyString(raw.target) || !isNonEmptyString(raw.source))) {
    throw new Error(`${where} alias savedSelection needs a target and a cited source`);
  }
  return {
    outcome: raw.outcome as AuditSavedSelectionOutcome,
    ...(isNonEmptyString(raw.target) ? { target: raw.target } : {}),
    ...(isNonEmptyString(raw.source) ? { source: raw.source } : {}),
  };
}

/** Reads and validates the manifest file, with a message naming the path for a missing or malformed file. */
export function loadAuditManifest(
  filePath: string,
  options: AuditValidationOptions = {}
): AuditManifest {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Audit manifest not found at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Audit manifest at ${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateAuditManifest(parsed, options);
}

// ---------------------------------------------------------------------------
// Correlation with the seed
// ---------------------------------------------------------------------------

export interface AuditDisposition {
  /** `<providerId>:<baseModelId>`. */
  id: string;
  status: AuditEntryStatus;
}

/** Flattens the entries of every picker record (either coverage mode) into qualified base ids with their status. */
export function dispositionsFromManifest(manifest: AuditManifest): AuditDisposition[] {
  const result: AuditDisposition[] = [];
  for (const record of manifest.records) {
    if (record.scope !== "picker") {
      continue;
    }
    for (const entry of record.entries ?? []) {
      result.push({ id: toBaseSelectionId(record.provider, entry.id), status: entry.status });
    }
  }
  return result;
}

export type SeedCoverage =
  | { state: "entry"; status: AuditEntryStatus }
  | { state: "covered-by-snapshot" }
  | { state: "uncovered" };

/**
 * How the manifest accounts for one seeded base id: an explicit entry wins
 * (an `unverified` entry stays `unverified`), otherwise a snapshot record of
 * the id's own block covers it; ids of other blocks are never covered.
 */
export function classifySeedCoverage(
  manifest: AuditManifest,
  provider: AuditProviderId,
  baseId: string
): SeedCoverage {
  const block = blockForSeedId(provider, baseId).block;
  const record = manifest.records.find((r) => r.provider === provider && r.block === block);
  const entry = record?.entries?.find((e) => e.id === baseId);
  if (entry) {
    return { state: "entry", status: entry.status };
  }
  return record?.coverage === "snapshot" ? { state: "covered-by-snapshot" } : { state: "uncovered" };
}

/** Provider-local base ids of every seeded entry, per provider. */
export function buildSeedBaseIdIndex(
  seed: Readonly<Partial<Record<string, readonly { model: string }[]>>>
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const [provider, models] of Object.entries(seed)) {
    index.set(provider, new Set((models ?? []).map((m) => stripVariantSuffixes(m.model))));
  }
  return index;
}

/** Status/seed agreement: seeded statuses must be in the seed, `removed`/`not-added` must not be. */
export function findStatusSeedDisagreements(
  manifest: AuditManifest,
  seedIndex: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  const problems: string[] = [];
  for (const record of manifest.records) {
    if (record.scope !== "picker") {
      continue;
    }
    const seeded = seedIndex.get(record.provider);
    for (const entry of record.entries ?? []) {
      const inSeed = seeded?.has(entry.id) ?? false;
      const expectSeeded = (AUDIT_SEEDED_STATUSES as readonly string[]).includes(entry.status);
      if (expectSeeded && !inSeed) {
        problems.push(`${record.provider}:${entry.id} is ${entry.status} but not in the seed`);
      } else if (!expectSeeded && inSeed) {
        problems.push(`${record.provider}:${entry.id} is ${entry.status} but still in the seed`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Free-label rule
// ---------------------------------------------------------------------------

/**
 * Block-scoped free-label rule: for every seeded entry whose block has a
 * picker record with `freeLabelsAudited: true`, the name carries a free marker
 * if and only if its base selection id is on the allowlist. Applies to base
 * entries and every effort variant; unaudited and non-picker blocks are not
 * evaluated.
 */
export function findFreeLabelViolations(input: {
  seed: Readonly<Partial<Record<string, readonly { model: string; name: string }[]>>>;
  manifest: AuditManifest;
  allowlist: readonly string[];
}): string[] {
  const allowed = new Set(input.allowlist);
  const problems: string[] = [];
  for (const [provider, models] of Object.entries(input.seed)) {
    if (!isAuditProviderId(provider)) {
      continue;
    }
    for (const entry of models ?? []) {
      const block = blockForSeedId(provider, stripVariantSuffixes(entry.model)).block;
      const record = input.manifest.records.find((r) => r.provider === provider && r.block === block);
      if (!record || record.scope !== "picker" || record.freeLabelsAudited !== true) {
        continue;
      }
      const labelled = hasFreeMarker(entry.name);
      const verified = allowed.has(toBaseSelectionId(provider, entry.model));
      if (labelled && !verified) {
        problems.push(`${provider}:${entry.model} is labelled free ("${entry.name}") without a verified-free allowlist entry`);
      } else if (!labelled && verified) {
        problems.push(`${provider}:${entry.model} is allowlisted as free but its name "${entry.name}" has no free marker`);
      }
    }
  }
  return problems;
}

/**
 * Allowlist guard: every allowlisted id needs a real provider prefix, a
 * picker block whose record is `freeLabelsAudited`, and an explicit entry with
 * a seeded status and a dated `free` field (a snapshot claim alone never
 * suffices). Every stripped-marker id needs a `relabelled` entry.
 */
export function findFreeAllowlistViolations(input: {
  manifest: AuditManifest;
  allowlist: readonly string[];
  strippedFreeMarkerIds: readonly string[];
}): string[] {
  const problems: string[] = [];
  for (const id of input.allowlist) {
    const split = splitBaseSelectionId(id);
    if (!split) {
      problems.push(`${id}: allowlist id has no ProviderId prefix`);
      continue;
    }
    const def = blockForSeedId(split.provider, split.baseId);
    if (def.scope !== "picker") {
      problems.push(`${id}: falls in non-picker block "${def.block}"`);
      continue;
    }
    const record = input.manifest.records.find((r) => r.provider === split.provider && r.block === def.block);
    if (!record?.freeLabelsAudited) {
      problems.push(`${id}: block "${def.block}" has no record with freeLabelsAudited: true`);
      continue;
    }
    const entry = record.entries?.find((e) => toBaseSelectionId(record.provider, e.id) === id);
    if (!entry || !(AUDIT_SEEDED_STATUSES as readonly string[]).includes(entry.status) || !entry.free) {
      problems.push(`${id}: needs an explicit seeded-status entry with a dated free field`);
    }
  }
  for (const id of input.strippedFreeMarkerIds) {
    const hasEntry = dispositionsFromManifest(input.manifest).some(
      (d) => d.id === id && d.status === "relabelled"
    );
    if (!hasEntry) {
      problems.push(`${id}: stripped free marker has no relabelled entry`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export interface DriftItem {
  id: string;
  /** The manifest status that explains this difference, when one does. */
  explainedBy?: AuditEntryStatus;
}

export interface BlockDrift {
  provider: AuditProviderId;
  block: string;
  liveCount: number;
  seedCount: number;
  /** No live entries for the block: nothing was compared. */
  notChecked: boolean;
  liveOnly: DriftItem[];
  seedOnly: DriftItem[];
}

export interface CatalogDrift {
  blocks: BlockDrift[];
  /** Ids in non-picker blocks, dropped before comparison. */
  ignored: string[];
  unexplained: string[];
}

/**
 * Compares live discovery ids with seeded ids (both `<provider>:<base>`,
 * variants already collapsed by the caller or collapsed here). A live-only id
 * is explained only by `not-added`; a seed-only id only by
 * `verified-conditional` or `unverified`. Everything else, including a live id
 * whose entry is `removed`, is unexplained. Seed-only is absence in this
 * context only, never proof of retirement.
 */
export function computeCatalogDrift(input: {
  liveIds: readonly string[];
  seedIds: readonly string[];
  dispositions: readonly AuditDisposition[];
}): CatalogDrift {
  const statusById = new Map(input.dispositions.map((d) => [d.id, d.status]));
  const ignored = new Set<string>();
  const grouped = new Map<string, { provider: AuditProviderId; block: string; live: Set<string>; seed: Set<string> }>();

  const place = (rawId: string, side: "live" | "seed"): void => {
    const split = splitBaseSelectionId(rawId);
    if (!split) {
      return;
    }
    const id = toBaseSelectionId(split.provider, split.baseId);
    const def = blockForSeedId(split.provider, stripVariantSuffixes(split.baseId));
    if (def.scope === "non-picker") {
      ignored.add(id);
      return;
    }
    const key = `${split.provider}/${def.block}`;
    let group = grouped.get(key);
    if (!group) {
      group = { provider: split.provider, block: def.block, live: new Set(), seed: new Set() };
      grouped.set(key, group);
    }
    group[side].add(id);
  };
  input.liveIds.forEach((id) => place(id, "live"));
  input.seedIds.forEach((id) => place(id, "seed"));

  const unexplained: string[] = [];
  const blocks: BlockDrift[] = [];
  for (const group of grouped.values()) {
    const liveOnly = [...group.live]
      .filter((id) => !group.seed.has(id))
      .sort()
      .map((id): DriftItem => {
        const status = statusById.get(id);
        return status === "not-added" ? { id, explainedBy: status } : { id };
      });
    const seedOnly = [...group.seed]
      .filter((id) => !group.live.has(id))
      .sort()
      .map((id): DriftItem => {
        const status = statusById.get(id);
        return status === "verified-conditional" || status === "unverified"
          ? { id, explainedBy: status }
          : { id };
      });
    const notChecked = group.live.size === 0;
    if (!notChecked) {
      unexplained.push(...[...liveOnly, ...seedOnly].filter((item) => !item.explainedBy).map((item) => item.id));
    }
    blocks.push({
      provider: group.provider,
      block: group.block,
      liveCount: group.live.size,
      seedCount: group.seed.size,
      notChecked,
      // A block with no live entries compared nothing, so it reports no differences.
      liveOnly: notChecked ? [] : liveOnly,
      seedOnly: notChecked ? [] : seedOnly,
    });
  }
  return { blocks, ignored: [...ignored].sort(), unexplained };
}
