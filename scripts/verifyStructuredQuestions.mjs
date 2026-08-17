/**
 * Structured question/answer schema and fixture verifier (plan §3.6,
 * verify:structured-questions).
 *
 * The checked-in wire-contract evidence — the two JSON Schemas under
 * workflow-inventories/schemas/ and the fixtures under
 * test-fixtures/structured-questions/ — must be exact, mechanically checked
 * representations of the runtime contract in
 * src/types/structuredQuestionV1.ts. This verifier proves that in four
 * fail-closed layers:
 *
 * 1. SCHEMA VALIDATOR SELF-TEST. Validation runs on a purpose-built draft-07
 *    subset validator that supports exactly the keywords these schemas use.
 *    A built-in self-test (one passing and one failing case per keyword,
 *    plus $ref resolution and oneOf cardinality) runs on every invocation
 *    before any real file is inspected, so a validator regression fails the
 *    check rather than silently passing it. Any keyword outside the
 *    supported set — in either schema — is itself a failure, so a schema
 *    edit cannot introduce a constraint this verifier silently ignores
 *    (the exact failure mode of the removed non-standard
 *    `uniqueItemProperties` keyword).
 *
 * 2. SCHEMA EXACTNESS. The schemas' numeric bounds and identifier pattern
 *    are asserted against the compiled runtime module's exported constants
 *    (MIN/MAX_QUESTIONS_V1, MIN/MAX_OPTIONS_V1, STABLE_ID_PATTERN_V1), and
 *    every object variant is asserted to be closed (additionalProperties
 *    false) with stable-identifier refs on questionId/optionId/selection
 *    fields. The oneOf variant rosters, each variant's complete property and
 *    required-field sets, and both definitions rosters are pinned to shape
 *    tables in this file, so adding, removing, or renaming a schema member
 *    fails here even when no targeted per-field assertion covers it. A
 *    runtime-constant change without a schema change (or vice versa) fails
 *    here.
 *
 * 3. EXACT FIXTURE ENUMERATION. Every entry in the fixture directory must be
 *    a regular file (directories, symlinks, and other non-file entries are
 *    rejected, not filtered out), every file must appear in the classified
 *    roster below, and every roster entry must exist, so a fixture cannot be
 *    added, removed, hidden, or misclassified without this verifier noticing.
 *
 * 4. SCHEMA/DECODER PARITY. Every fixture is evaluated twice: against the
 *    schema (plus the small set of supplementary semantic rules draft-07
 *    cannot express: unique questionIds, unique optionIds, selection bounds
 *    within the option count) and against the real compiled runtime
 *    decoders. The two verdicts must agree, and must match the roster's
 *    expected classification. Paired answer fixtures are additionally
 *    validated against their question set through the runtime validator,
 *    and every valid fixture must respect the canonical-byte limits.
 *
 * Run via `pnpm run verify:structured-questions`, which compiles
 * tsconfig.test.json first so the real runtime decoders are loadable.
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

const QUESTION_SCHEMA_RELATIVE = "workflow-inventories/schemas/structured-question-v1.schema.json";
const ANSWER_SCHEMA_RELATIVE = "workflow-inventories/schemas/structured-answer-v1.schema.json";
const FIXTURES_RELATIVE = "test-fixtures/structured-questions";
const COMPILED_RUNTIME_RELATIVE = "out/types/structuredQuestionV1.js";

/**
 * Exact classification of every fixture file. `expect` is the shape-level
 * verdict (schema + supplementary rules, which must equal the runtime
 * decoder's verdict). Answer fixtures may declare a paired question fixture
 * and the expected verdict of runtime cross-validation against it.
 */
const FIXTURE_ROSTER = {
  "valid-text.json": { contract: "questions", expect: "valid" },
  "valid-single-choice.json": { contract: "questions", expect: "valid" },
  "valid-multiple-choice.json": { contract: "questions", expect: "valid" },
  "valid-mixed.json": { contract: "questions", expect: "valid" },
  "empty-questions.json": { contract: "questions", expect: "invalid" },
  "too-many-questions.json": { contract: "questions", expect: "invalid" },
  "unknown-field-on-question.json": { contract: "questions", expect: "invalid" },
  "unknown-field-on-option.json": { contract: "questions", expect: "invalid" },
  "duplicate-question-ids.json": { contract: "questions", expect: "invalid" },
  "duplicate-option-ids.json": { contract: "questions", expect: "invalid" },
  "selection-bounds-exceed-options.json": { contract: "questions", expect: "invalid" },
  "invalid-question-id-pattern.json": { contract: "questions", expect: "invalid" },
  "too-few-options.json": { contract: "questions", expect: "invalid" },
  "end-to-end-answers.json": {
    contract: "answers",
    expect: "valid",
    pairWith: "valid-mixed.json",
    pairExpect: "valid",
  },
  "end-to-end-answers-skip-required.json": {
    contract: "answers",
    expect: "valid",
    pairWith: "valid-mixed.json",
    pairExpect: "invalid",
  },
  "unknown-field-on-skipped-answer.json": { contract: "answers", expect: "invalid" },
  "unknown-field-on-text-answer.json": { contract: "answers", expect: "invalid" },
  "empty-answers.json": { contract: "answers", expect: "invalid" },
  "duplicate-selected-option-ids.json": { contract: "answers", expect: "invalid" },
  "invalid-answer-question-id-pattern.json": { contract: "answers", expect: "invalid" },
};

// ---------------------------------------------------------------------------
// Minimal fail-closed draft-07 subset validator
// ---------------------------------------------------------------------------

/** Keywords that carry no constraint and are ignored during validation. */
const ANNOTATION_KEYWORDS = new Set(["$schema", "$id", "title", "description"]);

/** Constraint keywords the validator implements. Anything else fails the walk. */
const SUPPORTED_KEYWORDS = new Set([
  "$ref",
  "definitions",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "oneOf",
  "enum",
  "const",
  "pattern",
  "minLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

const SUPPORTED_TYPES = new Set(["array", "object", "string", "integer", "boolean"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively reject any schema node using a keyword or type this validator
 * does not implement, so an unenforced constraint can never pass silently.
 */
function walkSchemaForUnsupportedKeywords(schema, schemaPath, failures) {
  if (!isPlainObject(schema)) {
    failures.push(`${schemaPath}: schema node is not an object`);
    return;
  }
  const keys = Object.keys(schema);
  for (const key of keys) {
    if (ANNOTATION_KEYWORDS.has(key)) continue;
    if (!SUPPORTED_KEYWORDS.has(key)) {
      failures.push(
        `${schemaPath}: keyword "${key}" is not implemented by this verifier — either use a supported ` +
          "keyword or extend the validator (and its self-test) in the same change; unimplemented " +
          "keywords fail closed instead of passing silently."
      );
    }
  }
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string" || !/^#\/definitions\/[A-Za-z0-9_]+$/.test(schema.$ref)) {
      failures.push(`${schemaPath}: $ref must be a local "#/definitions/<name>" reference`);
    }
    const siblings = keys.filter((k) => !ANNOTATION_KEYWORDS.has(k) && k !== "$ref");
    if (siblings.length > 0) {
      failures.push(`${schemaPath}: $ref must not carry sibling constraint keywords (${siblings.join(", ")})`);
    }
    return;
  }
  if (schema.type !== undefined && !SUPPORTED_TYPES.has(schema.type)) {
    failures.push(`${schemaPath}: unsupported "type": ${JSON.stringify(schema.type)}`);
  }
  if (schema.pattern !== undefined && typeof schema.pattern !== "string") {
    failures.push(`${schemaPath}: "pattern" must be a string`);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === "string"))) {
    failures.push(`${schemaPath}: "required" must be an array of strings`);
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    failures.push(`${schemaPath}: only "additionalProperties": false is supported (closed objects)`);
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    failures.push(`${schemaPath}: "enum" must be an array`);
  }
  for (const bound of ["minLength", "minItems", "maxItems"]) {
    if (schema[bound] !== undefined && !Number.isInteger(schema[bound])) {
      failures.push(`${schemaPath}: "${bound}" must be an integer`);
    }
  }
  for (const bound of ["minimum", "maximum"]) {
    if (schema[bound] !== undefined && typeof schema[bound] !== "number") {
      failures.push(`${schemaPath}: "${bound}" must be a number`);
    }
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    failures.push(`${schemaPath}: "uniqueItems" must be a boolean`);
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      failures.push(`${schemaPath}: "properties" must be an object`);
    } else {
      for (const [name, sub] of Object.entries(schema.properties)) {
        walkSchemaForUnsupportedKeywords(sub, `${schemaPath}/properties/${name}`, failures);
      }
    }
  }
  if (schema.definitions !== undefined) {
    if (!isPlainObject(schema.definitions)) {
      failures.push(`${schemaPath}: "definitions" must be an object`);
    } else {
      for (const [name, sub] of Object.entries(schema.definitions)) {
        walkSchemaForUnsupportedKeywords(sub, `${schemaPath}/definitions/${name}`, failures);
      }
    }
  }
  if (schema.items !== undefined) {
    walkSchemaForUnsupportedKeywords(schema.items, `${schemaPath}/items`, failures);
  }
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf)) {
      failures.push(`${schemaPath}: "oneOf" must be an array`);
    } else {
      schema.oneOf.forEach((sub, i) => {
        walkSchemaForUnsupportedKeywords(sub, `${schemaPath}/oneOf/${i}`, failures);
      });
    }
  }
}

/** Deterministic stringify (sorted keys) for uniqueItems deep-equality on parsed JSON. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
      .join(",") +
    "}"
  );
}

function matchesType(value, type) {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    default:
      return false;
  }
}

/**
 * Validate a parsed JSON value against a schema node. Returns an array of
 * error strings (empty means valid). `root` supplies #/definitions targets.
 */
function validateAgainstSchema(value, schema, root, valuePath = "$") {
  if (schema.$ref !== undefined) {
    const name = schema.$ref.slice("#/definitions/".length);
    const target = root.definitions?.[name];
    if (!target) {
      return [`${valuePath}: unresolvable $ref ${schema.$ref}`];
    }
    return validateAgainstSchema(value, target, root, valuePath);
  }
  const errors = [];
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    return [`${valuePath}: expected type ${schema.type}`];
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${valuePath}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${valuePath}: value not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${valuePath}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${valuePath}: does not match pattern ${schema.pattern}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${valuePath}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${valuePath}: above maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${valuePath}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${valuePath}: more than maxItems ${schema.maxItems}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const entry of value) {
        const key = stableStringify(entry);
        if (seen.has(key)) {
          errors.push(`${valuePath}: duplicate items violate uniqueItems`);
          break;
        }
        seen.add(key);
      }
    }
    if (schema.items !== undefined) {
      value.forEach((entry, i) => {
        errors.push(...validateAgainstSchema(entry, schema.items, root, `${valuePath}[${i}]`));
      });
    }
  }
  if (isPlainObject(value)) {
    if (schema.required !== undefined) {
      for (const name of schema.required) {
        if (!(name in value)) {
          errors.push(`${valuePath}: missing required property "${name}"`);
        }
      }
    }
    if (schema.properties !== undefined) {
      for (const [name, sub] of Object.entries(schema.properties)) {
        if (name in value) {
          errors.push(...validateAgainstSchema(value[name], sub, root, `${valuePath}.${name}`));
        }
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const name of Object.keys(value)) {
        if (!allowed.has(name)) {
          errors.push(`${valuePath}: unexpected additional property "${name}"`);
        }
      }
    }
  }
  if (schema.oneOf !== undefined) {
    const matching = schema.oneOf.filter(
      (sub) => validateAgainstSchema(value, sub, root, valuePath).length === 0
    ).length;
    if (matching !== 1) {
      errors.push(`${valuePath}: matched ${matching} oneOf variants (exactly 1 required)`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Validator self-test: one passing and one failing case per keyword
// ---------------------------------------------------------------------------

const SELF_TEST_CASES = [
  { name: "type array pass", schema: { type: "array" }, value: [], expect: true },
  { name: "type array fail", schema: { type: "array" }, value: {}, expect: false },
  { name: "type object fail on array", schema: { type: "object" }, value: [], expect: false },
  { name: "type integer pass", schema: { type: "integer" }, value: 3, expect: true },
  { name: "type integer fail on float", schema: { type: "integer" }, value: 3.5, expect: false },
  { name: "type boolean fail on string", schema: { type: "boolean" }, value: "true", expect: false },
  { name: "const pass", schema: { const: "text" }, value: "text", expect: true },
  { name: "const fail", schema: { const: "text" }, value: "Text", expect: false },
  { name: "enum pass", schema: { enum: ["a", "b"] }, value: "b", expect: true },
  { name: "enum fail", schema: { enum: ["a", "b"] }, value: "c", expect: false },
  { name: "pattern pass", schema: { type: "string", pattern: "^[a-z]+$" }, value: "abc", expect: true },
  { name: "pattern fail", schema: { type: "string", pattern: "^[a-z]+$" }, value: "a b", expect: false },
  { name: "minLength pass", schema: { type: "string", minLength: 1 }, value: "x", expect: true },
  { name: "minLength fail", schema: { type: "string", minLength: 1 }, value: "", expect: false },
  { name: "minimum pass", schema: { type: "integer", minimum: 0 }, value: 0, expect: true },
  { name: "minimum fail", schema: { type: "integer", minimum: 0 }, value: -1, expect: false },
  { name: "maximum pass", schema: { type: "integer", maximum: 32 }, value: 32, expect: true },
  { name: "maximum fail", schema: { type: "integer", maximum: 32 }, value: 33, expect: false },
  { name: "minItems pass", schema: { type: "array", minItems: 1 }, value: [1], expect: true },
  { name: "minItems fail", schema: { type: "array", minItems: 1 }, value: [], expect: false },
  { name: "maxItems pass", schema: { type: "array", maxItems: 2 }, value: [1, 2], expect: true },
  { name: "maxItems fail", schema: { type: "array", maxItems: 2 }, value: [1, 2, 3], expect: false },
  { name: "uniqueItems pass", schema: { type: "array", uniqueItems: true }, value: ["a", "b"], expect: true },
  { name: "uniqueItems fail (scalar)", schema: { type: "array", uniqueItems: true }, value: ["a", "a"], expect: false },
  {
    name: "uniqueItems fail (deep object equality)",
    schema: { type: "array", uniqueItems: true },
    value: [{ a: 1, b: 2 }, { b: 2, a: 1 }],
    expect: false,
  },
  { name: "items pass", schema: { type: "array", items: { type: "string" } }, value: ["a"], expect: true },
  { name: "items fail", schema: { type: "array", items: { type: "string" } }, value: [1], expect: false },
  {
    name: "required pass",
    schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    value: { a: "x" },
    expect: true,
  },
  {
    name: "required fail",
    schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    value: {},
    expect: false,
  },
  {
    name: "additionalProperties false pass",
    schema: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
    value: { a: "x" },
    expect: true,
  },
  {
    name: "additionalProperties false fail",
    schema: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
    value: { a: "x", extra: 1 },
    expect: false,
  },
  {
    name: "properties nested fail",
    schema: { type: "object", properties: { a: { type: "string", minLength: 2 } } },
    value: { a: "x" },
    expect: false,
  },
  {
    name: "oneOf exactly-one pass",
    schema: { oneOf: [{ type: "string" }, { type: "integer" }] },
    value: "x",
    expect: true,
  },
  {
    name: "oneOf zero-match fail",
    schema: { oneOf: [{ type: "string" }, { type: "integer" }] },
    value: true,
    expect: false,
  },
  {
    name: "oneOf two-match fail",
    schema: { oneOf: [{ type: "string" }, { type: "string", minLength: 0 }] },
    value: "x",
    expect: false,
  },
  {
    name: "$ref resolution pass",
    schema: { definitions: { id: { type: "string", pattern: "^[a-z]+$" } }, items: { $ref: "#/definitions/id" }, type: "array" },
    value: ["abc"],
    expect: true,
  },
  {
    name: "$ref resolution fail",
    schema: { definitions: { id: { type: "string", pattern: "^[a-z]+$" } }, items: { $ref: "#/definitions/id" }, type: "array" },
    value: ["ABC"],
    expect: false,
  },
];

/** Schemas the keyword walk must reject (unsupported/malformed constructs). */
const SELF_TEST_WALK_REJECTIONS = [
  { name: "unsupported keyword", schema: { type: "array", uniqueItemProperties: ["id"] } },
  { name: "unsupported type", schema: { type: "null" } },
  { name: "$ref with constraint sibling", schema: { $ref: "#/definitions/x", minLength: 1 } },
  { name: "non-false additionalProperties", schema: { type: "object", additionalProperties: true } },
  { name: "external $ref", schema: { $ref: "https://example.com/schema.json" } },
];

function runValidatorSelfTest(failures) {
  for (const testCase of SELF_TEST_CASES) {
    const walkFailures = [];
    walkSchemaForUnsupportedKeywords(testCase.schema, `self-test "${testCase.name}"`, walkFailures);
    if (walkFailures.length > 0) {
      failures.push(`validator self-test "${testCase.name}": schema unexpectedly failed the keyword walk.`);
      continue;
    }
    const errors = validateAgainstSchema(testCase.value, testCase.schema, testCase.schema);
    const valid = errors.length === 0;
    if (valid !== testCase.expect) {
      failures.push(
        `validator self-test "${testCase.name}": expected ${testCase.expect ? "valid" : "invalid"}, ` +
          `got ${valid ? "valid" : `invalid (${errors.join("; ")})`}.`
      );
    }
  }
  for (const rejection of SELF_TEST_WALK_REJECTIONS) {
    const walkFailures = [];
    walkSchemaForUnsupportedKeywords(rejection.schema, `self-test "${rejection.name}"`, walkFailures);
    if (walkFailures.length === 0) {
      failures.push(
        `validator self-test "${rejection.name}": the keyword walk accepted a construct it must fail closed on.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime module loading and schema exactness
// ---------------------------------------------------------------------------

const REQUIRED_RUNTIME_EXPORTS = [
  "decodeStructuredQuestionsV1",
  "decodeStructuredAnswersArrayV1",
  "validateStructuredAnswersV1",
  "canonicalJsonByteLengthV1",
  "STABLE_ID_PATTERN_V1",
  "MIN_QUESTIONS_V1",
  "MAX_QUESTIONS_V1",
  "MIN_OPTIONS_V1",
  "MAX_OPTIONS_V1",
  "MAX_QUESTION_SET_CANONICAL_BYTES_V1",
  "MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1",
];

function loadRuntime(failures) {
  const compiledPath = path.join(repoRoot, COMPILED_RUNTIME_RELATIVE);
  if (!fs.existsSync(compiledPath)) {
    failures.push(
      `${COMPILED_RUNTIME_RELATIVE} is missing — run this via "pnpm run verify:structured-questions", ` +
        "which compiles tsconfig.test.json first so the real runtime decoders are checked, not a stand-in."
    );
    return undefined;
  }
  const runtime = requireCjs(compiledPath);
  for (const name of REQUIRED_RUNTIME_EXPORTS) {
    if (runtime[name] === undefined) {
      failures.push(`${COMPILED_RUNTIME_RELATIVE} does not export ${name}; parity cannot be verified.`);
      return undefined;
    }
  }
  return runtime;
}

function loadJson(relative, failures) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relative), "utf8"));
  } catch (error) {
    failures.push(`${relative} could not be read/parsed: ${error.message}`);
    return undefined;
  }
}

function findVariant(schema, title, relative, failures) {
  const variants = schema?.items?.oneOf;
  if (!Array.isArray(variants)) {
    failures.push(`${relative}: expected items.oneOf variant array`);
    return undefined;
  }
  const variant = variants.find((v) => v?.title === title);
  if (!variant) {
    failures.push(`${relative}: missing oneOf variant titled "${title}"`);
  }
  return variant;
}

function assertEqual(actual, expected, message, failures) {
  const same =
    Array.isArray(expected) && Array.isArray(actual)
      ? stableStringify(actual) === stableStringify(expected)
      : actual === expected;
  if (!same) {
    failures.push(`${message} (expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)})`);
  }
}

/**
 * Assert an exact, duplicate-free name set (order-insensitive — neither JSON
 * object member order nor draft-07 "required" order is semantic). Reports
 * missing and unexpected names so schema drift is pinpointed, not just flagged.
 */
function assertExactNameSet(actualNames, expectedNames, message, failures) {
  if (!Array.isArray(actualNames)) {
    failures.push(`${message} (expected [${expectedNames.join(", ")}], found ${JSON.stringify(actualNames)})`);
    return;
  }
  if (new Set(actualNames).size !== actualNames.length) {
    failures.push(`${message}: duplicate names in [${actualNames.join(", ")}]`);
    return;
  }
  const missing = expectedNames.filter((name) => !actualNames.includes(name));
  const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    failures.push(
      `${message}: expected exactly [${expectedNames.join(", ")}]` +
        (missing.length > 0 ? `; missing [${missing.join(", ")}]` : "") +
        (unexpected.length > 0 ? `; unexpected [${unexpected.join(", ")}]` : "")
    );
  }
}

/**
 * The complete pinned member/required contract for every oneOf variant, so a
 * property or required-field addition, removal, or rename in either schema
 * fails this gate instead of drifting past the targeted per-field assertions.
 */
const QUESTION_VARIANT_SHAPES = {
  text: {
    properties: ["questionId", "kind", "prompt", "helpText", "required", "allowBlank", "maxLength"],
    required: ["questionId", "kind", "prompt", "required"],
  },
  singleChoice: {
    properties: ["questionId", "kind", "prompt", "helpText", "required", "options"],
    required: ["questionId", "kind", "prompt", "required", "options"],
  },
  multipleChoice: {
    properties: ["questionId", "kind", "prompt", "helpText", "required", "minSelections", "maxSelections", "options"],
    required: ["questionId", "kind", "prompt", "required", "minSelections", "maxSelections", "options"],
  },
};

const ANSWER_VARIANT_SHAPES = {
  skipped: {
    properties: ["questionId", "kind", "state"],
    required: ["questionId", "kind", "state"],
  },
  "text answered": {
    properties: ["questionId", "kind", "state", "value"],
    required: ["questionId", "kind", "state", "value"],
  },
  "singleChoice answered": {
    properties: ["questionId", "kind", "state", "selectedOptionId"],
    required: ["questionId", "kind", "state", "selectedOptionId"],
  },
  "multipleChoice answered": {
    properties: ["questionId", "kind", "state", "selectedOptionIds"],
    required: ["questionId", "kind", "state", "selectedOptionIds"],
  },
};

/**
 * Assert the schema's oneOf variant roster and every variant's complete
 * property and required-field sets against the pinned shape table.
 */
function assertVariantShapes(schema, shapes, relative, failures) {
  const variantTitles = Array.isArray(schema?.items?.oneOf)
    ? schema.items.oneOf.map((variant) => variant?.title)
    : undefined;
  assertExactNameSet(variantTitles, Object.keys(shapes), `${relative}: items.oneOf variant titles`, failures);
  for (const [title, shape] of Object.entries(shapes)) {
    const variant = findVariant(schema, title, relative, failures);
    if (!variant) continue;
    assertExactNameSet(
      variant.properties === undefined ? undefined : Object.keys(variant.properties),
      shape.properties,
      `${relative}: "${title}" variant property set`,
      failures
    );
    assertExactNameSet(variant.required, shape.required, `${relative}: "${title}" variant required set`, failures);
  }
}

/**
 * Pin the checked-in schemas to the runtime contract's exported constants
 * and structural rules, so the two cannot drift apart silently.
 */
function assertSchemaExactness(questionSchema, answerSchema, runtime, failures) {
  const stablePattern = runtime.STABLE_ID_PATTERN_V1.source;
  const stableRef = "#/definitions/stableId";

  assertVariantShapes(questionSchema, QUESTION_VARIANT_SHAPES, QUESTION_SCHEMA_RELATIVE, failures);
  assertVariantShapes(answerSchema, ANSWER_VARIANT_SHAPES, ANSWER_SCHEMA_RELATIVE, failures);
  assertExactNameSet(
    questionSchema.definitions === undefined ? undefined : Object.keys(questionSchema.definitions),
    ["stableId", "questionOption"],
    `${QUESTION_SCHEMA_RELATIVE}: definitions roster`,
    failures
  );
  assertExactNameSet(
    answerSchema.definitions === undefined ? undefined : Object.keys(answerSchema.definitions),
    ["stableId"],
    `${ANSWER_SCHEMA_RELATIVE}: definitions roster`,
    failures
  );

  assertEqual(questionSchema.minItems, runtime.MIN_QUESTIONS_V1, `${QUESTION_SCHEMA_RELATIVE}: minItems must equal MIN_QUESTIONS_V1`, failures);
  assertEqual(questionSchema.maxItems, runtime.MAX_QUESTIONS_V1, `${QUESTION_SCHEMA_RELATIVE}: maxItems must equal MAX_QUESTIONS_V1`, failures);
  assertEqual(
    questionSchema.definitions?.stableId?.pattern,
    stablePattern,
    `${QUESTION_SCHEMA_RELATIVE}: definitions.stableId.pattern must equal STABLE_ID_PATTERN_V1`,
    failures
  );
  const option = questionSchema.definitions?.questionOption;
  assertEqual(option?.additionalProperties, false, `${QUESTION_SCHEMA_RELATIVE}: questionOption must be closed`, failures);
  assertExactNameSet(
    option?.properties === undefined ? undefined : Object.keys(option.properties),
    ["optionId", "label", "description"],
    `${QUESTION_SCHEMA_RELATIVE}: questionOption property set`,
    failures
  );
  assertExactNameSet(option?.required, ["optionId", "label"], `${QUESTION_SCHEMA_RELATIVE}: questionOption required set`, failures);
  assertEqual(option?.properties?.optionId?.$ref, stableRef, `${QUESTION_SCHEMA_RELATIVE}: optionId must be a stableId ref`, failures);
  assertEqual(option?.properties?.label?.minLength, 1, `${QUESTION_SCHEMA_RELATIVE}: option label must require minLength 1`, failures);

  for (const title of ["text", "singleChoice", "multipleChoice"]) {
    const variant = findVariant(questionSchema, title, QUESTION_SCHEMA_RELATIVE, failures);
    if (!variant) continue;
    assertEqual(variant.additionalProperties, false, `${QUESTION_SCHEMA_RELATIVE}: "${title}" variant must be closed`, failures);
    assertEqual(variant.properties?.questionId?.$ref, stableRef, `${QUESTION_SCHEMA_RELATIVE}: "${title}" questionId must be a stableId ref`, failures);
    if (title !== "text") {
      assertEqual(variant.properties?.options?.minItems, runtime.MIN_OPTIONS_V1, `${QUESTION_SCHEMA_RELATIVE}: "${title}" options.minItems must equal MIN_OPTIONS_V1`, failures);
      assertEqual(variant.properties?.options?.maxItems, runtime.MAX_OPTIONS_V1, `${QUESTION_SCHEMA_RELATIVE}: "${title}" options.maxItems must equal MAX_OPTIONS_V1`, failures);
      assertEqual(variant.properties?.options?.items?.$ref, "#/definitions/questionOption", `${QUESTION_SCHEMA_RELATIVE}: "${title}" options items must reference questionOption`, failures);
    }
  }
  const multipleChoice = findVariant(questionSchema, "multipleChoice", QUESTION_SCHEMA_RELATIVE, failures);
  if (multipleChoice) {
    for (const bound of ["minSelections", "maxSelections"]) {
      assertEqual(
        multipleChoice.properties?.[bound]?.maximum,
        runtime.MAX_OPTIONS_V1,
        `${QUESTION_SCHEMA_RELATIVE}: multipleChoice ${bound}.maximum must equal MAX_OPTIONS_V1`,
        failures
      );
    }
  }

  assertEqual(answerSchema.minItems, runtime.MIN_QUESTIONS_V1, `${ANSWER_SCHEMA_RELATIVE}: minItems must equal MIN_QUESTIONS_V1 (one answer per question)`, failures);
  assertEqual(answerSchema.maxItems, runtime.MAX_QUESTIONS_V1, `${ANSWER_SCHEMA_RELATIVE}: maxItems must equal MAX_QUESTIONS_V1`, failures);
  assertEqual(
    answerSchema.definitions?.stableId?.pattern,
    stablePattern,
    `${ANSWER_SCHEMA_RELATIVE}: definitions.stableId.pattern must equal STABLE_ID_PATTERN_V1`,
    failures
  );
  for (const title of ["skipped", "text answered", "singleChoice answered", "multipleChoice answered"]) {
    const variant = findVariant(answerSchema, title, ANSWER_SCHEMA_RELATIVE, failures);
    if (!variant) continue;
    assertEqual(variant.additionalProperties, false, `${ANSWER_SCHEMA_RELATIVE}: "${title}" variant must be closed`, failures);
    assertEqual(variant.properties?.questionId?.$ref, stableRef, `${ANSWER_SCHEMA_RELATIVE}: "${title}" questionId must be a stableId ref`, failures);
  }
  const skipped = findVariant(answerSchema, "skipped", ANSWER_SCHEMA_RELATIVE, failures);
  if (skipped) {
    assertEqual(skipped.properties?.kind?.enum, ["text", "singleChoice", "multipleChoice"], `${ANSWER_SCHEMA_RELATIVE}: skipped kind enum must list the three question kinds`, failures);
  }
  const singleAnswered = findVariant(answerSchema, "singleChoice answered", ANSWER_SCHEMA_RELATIVE, failures);
  if (singleAnswered) {
    assertEqual(singleAnswered.properties?.selectedOptionId?.$ref, stableRef, `${ANSWER_SCHEMA_RELATIVE}: selectedOptionId must be a stableId ref`, failures);
  }
  const multiAnswered = findVariant(answerSchema, "multipleChoice answered", ANSWER_SCHEMA_RELATIVE, failures);
  if (multiAnswered) {
    const selections = multiAnswered.properties?.selectedOptionIds;
    assertEqual(selections?.uniqueItems, true, `${ANSWER_SCHEMA_RELATIVE}: selectedOptionIds must require uniqueItems`, failures);
    assertEqual(selections?.maxItems, runtime.MAX_OPTIONS_V1, `${ANSWER_SCHEMA_RELATIVE}: selectedOptionIds.maxItems must equal MAX_OPTIONS_V1`, failures);
    assertEqual(selections?.items?.$ref, stableRef, `${ANSWER_SCHEMA_RELATIVE}: selectedOptionIds items must be stableId refs`, failures);
  }
}

// ---------------------------------------------------------------------------
// Supplementary semantic rules draft-07 cannot express (questions contract)
// ---------------------------------------------------------------------------

/**
 * The exact gap between structured-question-v1.schema.json and the runtime
 * decoder: unique questionIds, unique optionIds, and selection bounds within
 * the actual option count. Together with the schema these must reproduce
 * the runtime verdict for every fixture (the parity check below fails
 * otherwise), so a new runtime rule cannot land without either a schema
 * change or an entry here.
 */
function questionSupplementaryErrors(value) {
  if (!Array.isArray(value)) {
    return ["question set is not an array"];
  }
  const errors = [];
  const seenQuestionIds = new Set();
  for (const question of value) {
    if (!isPlainObject(question)) continue;
    if (typeof question.questionId === "string") {
      if (seenQuestionIds.has(question.questionId)) {
        errors.push(`duplicate questionId "${question.questionId}"`);
      }
      seenQuestionIds.add(question.questionId);
    }
    if (Array.isArray(question.options)) {
      const seenOptionIds = new Set();
      for (const option of question.options) {
        if (isPlainObject(option) && typeof option.optionId === "string") {
          if (seenOptionIds.has(option.optionId)) {
            errors.push(`duplicate optionId "${option.optionId}" in question "${String(question.questionId)}"`);
          }
          seenOptionIds.add(option.optionId);
        }
      }
      if (
        question.kind === "multipleChoice" &&
        Number.isInteger(question.minSelections) &&
        Number.isInteger(question.maxSelections) &&
        (question.maxSelections < question.minSelections || question.maxSelections > question.options.length)
      ) {
        errors.push(`selection bounds outside option count in question "${String(question.questionId)}"`);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Fixture enumeration, parity, and paired validation
// ---------------------------------------------------------------------------

function verifyFixtures(questionSchema, answerSchema, runtime, failures) {
  const fixturesDir = path.join(repoRoot, FIXTURES_RELATIVE);
  let actualFiles;
  try {
    const entries = fs.readdirSync(fixturesDir, { withFileTypes: true });
    actualFiles = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        actualFiles.push(entry.name);
      } else {
        failures.push(
          `${FIXTURES_RELATIVE}/${entry.name} is not a regular file ` +
            `(${entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symbolic link" : "non-file entry"}) — ` +
            "the fixture directory must contain only classified fixture files; nothing is filtered out silently."
        );
      }
    }
  } catch (error) {
    failures.push(`${FIXTURES_RELATIVE} could not be enumerated: ${error.message}`);
    return { checked: 0 };
  }
  const rosterNames = Object.keys(FIXTURE_ROSTER);
  for (const name of actualFiles) {
    if (!FIXTURE_ROSTER[name]) {
      failures.push(
        `${FIXTURES_RELATIVE}/${name} is not classified in this verifier's fixture roster — every fixture ` +
          "must be enumerated with an expected verdict."
      );
    }
  }
  for (const name of rosterNames) {
    if (!actualFiles.includes(name)) {
      failures.push(`${FIXTURES_RELATIVE}/${name} is classified in the roster but missing on disk.`);
    }
  }
  for (const contract of ["questions", "answers"]) {
    for (const expectation of ["valid", "invalid"]) {
      if (!rosterNames.some((n) => FIXTURE_ROSTER[n].contract === contract && FIXTURE_ROSTER[n].expect === expectation)) {
        failures.push(`fixture roster has no ${expectation} ${contract} fixture — both polarities are required.`);
      }
    }
  }

  const parsed = new Map();
  for (const name of rosterNames) {
    if (!actualFiles.includes(name)) continue;
    const data = loadJson(`${FIXTURES_RELATIVE}/${name}`, failures);
    if (data !== undefined) {
      parsed.set(name, data);
    }
  }

  let checked = 0;
  for (const [name, data] of parsed) {
    const spec = FIXTURE_ROSTER[name];
    const schema = spec.contract === "questions" ? questionSchema : answerSchema;
    const schemaErrors = validateAgainstSchema(data, schema, schema);
    const supplementaryErrors = spec.contract === "questions" ? questionSupplementaryErrors(data) : [];
    const mechanicalValid = schemaErrors.length === 0 && supplementaryErrors.length === 0;
    const runtimeResult =
      spec.contract === "questions"
        ? runtime.decodeStructuredQuestionsV1(data)
        : runtime.decodeStructuredAnswersArrayV1(data);
    const runtimeValid = runtimeResult.ok === true;

    if (mechanicalValid !== runtimeValid) {
      failures.push(
        `${FIXTURES_RELATIVE}/${name}: schema/decoder divergence — schema+supplementary says ` +
          `${mechanicalValid ? "valid" : `invalid (${[...schemaErrors, ...supplementaryErrors].join("; ")})`} but the runtime ` +
          `decoder says ${runtimeValid ? "valid" : `invalid (${runtimeResult.reason})`}. The checked-in ` +
          "schema evidence no longer matches the runtime contract."
      );
    }
    if ((spec.expect === "valid") !== runtimeValid) {
      failures.push(
        `${FIXTURES_RELATIVE}/${name}: classified ${spec.expect} but the runtime decoder says ` +
          `${runtimeValid ? "valid" : `invalid (${runtimeResult.reason})`}.`
      );
    }
    if (spec.expect === "valid") {
      const limit =
        spec.contract === "questions"
          ? runtime.MAX_QUESTION_SET_CANONICAL_BYTES_V1
          : runtime.MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1;
      const bytes = runtime.canonicalJsonByteLengthV1(data);
      if (bytes > limit) {
        failures.push(`${FIXTURES_RELATIVE}/${name}: valid fixture exceeds the ${limit}-byte canonical limit (${bytes}).`);
      }
    }
    if (spec.pairWith) {
      const questionData = parsed.get(spec.pairWith);
      if (questionData === undefined) {
        failures.push(`${FIXTURES_RELATIVE}/${name}: paired question fixture ${spec.pairWith} is unavailable.`);
      } else {
        const questions = runtime.decodeStructuredQuestionsV1(questionData);
        const answers = runtime.decodeStructuredAnswersArrayV1(data);
        if (!questions.ok || !answers.ok) {
          failures.push(`${FIXTURES_RELATIVE}/${name}: paired validation requires both sides to decode.`);
        } else {
          const paired = runtime.validateStructuredAnswersV1(questions.questions, answers.answers);
          if ((spec.pairExpect === "valid") !== (paired.ok === true)) {
            failures.push(
              `${FIXTURES_RELATIVE}/${name}: expected paired validation against ${spec.pairWith} to be ` +
                `${spec.pairExpect}, got ${paired.ok ? "valid" : `invalid (${paired.reason})`}.`
            );
          }
        }
      }
    }
    checked++;
  }
  return { checked };
}

// ---------------------------------------------------------------------------

function main() {
  const failures = [];

  runValidatorSelfTest(failures);
  if (failures.length > 0) {
    // The validator itself is broken; nothing downstream can be trusted.
    for (const failure of failures) {
      console.error(`✘ [structuredQuestions] ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  const runtime = loadRuntime(failures);
  const questionSchema = loadJson(QUESTION_SCHEMA_RELATIVE, failures);
  const answerSchema = loadJson(ANSWER_SCHEMA_RELATIVE, failures);
  let checked = 0;
  if (runtime && questionSchema && answerSchema) {
    walkSchemaForUnsupportedKeywords(questionSchema, QUESTION_SCHEMA_RELATIVE, failures);
    walkSchemaForUnsupportedKeywords(answerSchema, ANSWER_SCHEMA_RELATIVE, failures);
    if (failures.length === 0) {
      assertSchemaExactness(questionSchema, answerSchema, runtime, failures);
      ({ checked } = verifyFixtures(questionSchema, answerSchema, runtime, failures));
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`✘ [structuredQuestions] ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `✓ structuredQuestions: validator self-test passed (${SELF_TEST_CASES.length} cases, ` +
      `${SELF_TEST_WALK_REJECTIONS.length} keyword-walk rejections); both schemas use only verified keywords ` +
      "and match the runtime constants/pattern; " +
      `${checked} fixture(s) enumerated with exact schema/decoder parity and paired validation.`
  );
}

main();
