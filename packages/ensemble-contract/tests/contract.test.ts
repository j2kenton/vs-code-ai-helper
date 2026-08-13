/**
 * Structural verification of the Part 3 control-plane contract: the OpenAPI
 * document must mechanically satisfy the plan's contract-level requirements
 * (single security scheme, per-operation ownership, read-only file/diff
 * surface, required SandboxBinding, idempotent gate commands, write-only key
 * records), and the SandboxBinding validators must enforce the typed-error
 * and path-confinement rules. This keeps the contract self-checking the same
 * way verify:structured-questions keeps the question schemas honest.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  confinePathToBindingRootV1,
  validateSandboxBindingRequestV1,
} from "../src/sandboxBindingV1";
import {
  areTokenSpansWellFormedV1,
  isTokenSpanV1,
  TOKEN_SPAN_SCOPES_V1,
} from "../src/tokenSpanV1";

interface OpenApiOperation {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  responses?: Record<string, unknown>;
  ["x-ownership"]?: string;
}

type OpenApiPathItem = Record<string, OpenApiOperation>;

/**
 * One `allOf` entry expressing a conditional requirement — the shape the
 * SandboxBinding schema uses to require `sandboxId` for user-managed sandboxes
 * only. Declared rather than reached for with `any` so the assertion below
 * fails to compile if the shape it probes stops existing.
 */
interface OpenApiConditionalRuleV1 {
  if?: { properties?: { lifecycle?: { const?: string } } };
  then?: { required?: readonly string[] };
  else?: { not?: { required?: readonly string[] } };
}

const specPath = path.join(__dirname, "..", "..", "..", "..", "packages", "ensemble-contract", "openapi", "control-plane.v1.json");
// __dirname is the compiled mirror (out-test/packages/ensemble-contract/tests);
// walk up to the package root that holds openapi/.
function findSpec(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, "openapi", "control-plane.v1.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate openapi/control-plane.v1.json above ${__dirname} (tried ${specPath})`);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const spec: any = JSON.parse(fs.readFileSync(findSpec(), "utf8"));
/* eslint-enable @typescript-eslint/no-explicit-any */

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function operations(): Array<{ pathKey: string; method: string; operation: OpenApiOperation }> {
  const out: Array<{ pathKey: string; method: string; operation: OpenApiOperation }> = [];
  for (const [pathKey, item] of Object.entries(spec.paths as Record<string, OpenApiPathItem>)) {
    for (const method of HTTP_METHODS) {
      if (item[method] !== undefined) {
        out.push({ pathKey, method, operation: item[method] });
      }
    }
  }
  return out;
}

test("contract surface is the exact expected path/method roster", () => {
  const actual = operations()
    .map(({ pathKey, method }) => `${method.toUpperCase()} ${pathKey}`)
    .sort();
  const expected = [
    "POST /v1/auth/exchange",
    "POST /v1/auth/refresh",
    "POST /v1/auth/revoke",
    "GET /v1/tasks",
    "POST /v1/tasks",
    "GET /v1/tasks/{taskId}",
    "GET /v1/tasks/{taskId}/history",
    "GET /v1/tasks/{taskId}/chat",
    "POST /v1/tasks/{taskId}/chat",
    "GET /v1/tasks/{taskId}/gates",
    "GET /v1/gates/{gateId}",
    "POST /v1/gates/{gateId}/decision",
    "GET /v1/tasks/{taskId}/files",
    "GET /v1/tasks/{taskId}/file",
    "GET /v1/tasks/{taskId}/diff",
    "GET /v1/keys",
    "PUT /v1/keys/{keyKind}",
    "DELETE /v1/keys/{keyKind}",
    "GET /v1/events",
  ].sort();
  assert.deepEqual(actual, expected);
});

test("the session token is the contract's only security scheme", () => {
  const schemes = Object.keys(spec.components.securitySchemes);
  assert.deepEqual(schemes, ["sessionToken"]);
  assert.equal(spec.components.securitySchemes.sessionToken.type, "http");
  assert.equal(spec.components.securitySchemes.sessionToken.scheme, "bearer");
  assert.deepEqual(spec.security, [{ sessionToken: [] }]);
});

test("only the identity-establishing auth endpoints are public", () => {
  for (const { pathKey, method, operation } of operations()) {
    const isPublic = Array.isArray(operation.security) && operation.security.length === 0;
    const mayBePublic = pathKey === "/v1/auth/exchange" || pathKey === "/v1/auth/refresh";
    assert.equal(
      isPublic,
      mayBePublic,
      `${method.toUpperCase()} ${pathKey} must ${mayBePublic ? "" : "not "}override the session-token requirement`
    );
  }
});

test("every operation declares its ownership rule", () => {
  for (const { pathKey, method, operation } of operations()) {
    const rule = operation["x-ownership"];
    assert.ok(
      typeof rule === "string" && rule.length > 0,
      `${method.toUpperCase()} ${pathKey} is missing x-ownership`
    );
  }
});

test("file and diff retrieval is read-only at the contract level", () => {
  for (const { pathKey, method } of operations()) {
    if (/\/(files|file|diff)$/.test(pathKey)) {
      assert.equal(method, "get", `${pathKey} must expose only GET (read-only surface)`);
    }
  }
  // No write/exec endpoint exists anywhere: nothing outside the audited
  // roster above, and no path suggests execution.
  for (const pathKey of Object.keys(spec.paths)) {
    assert.ok(
      !/exec|command|run|write|upload/i.test(pathKey),
      `path ${pathKey} suggests a write/exec surface, which this contract forbids`
    );
  }
});

test("task creation requires a validated SandboxBinding", () => {
  const create = spec.components.schemas.TaskCreateRequest;
  assert.ok(create.required.includes("sandboxBinding"));
  const binding = spec.components.schemas.SandboxBinding;
  assert.deepEqual(
    [...binding.required].sort(),
    ["cleanup", "lifecycle", "provider", "source", "workingDirectoryRoot"]
  );
  // sandboxId is conditionally required rather than unconditionally: an
  // ephemeral sandbox has no id until the control plane creates it.
  assert.ok(
    binding.allOf?.some(
      (rule: OpenApiConditionalRuleV1) =>
        rule.if?.properties?.lifecycle?.const === "user-managed-persistent" &&
        rule.then?.required?.includes("sandboxId") &&
        rule.else?.not?.required?.includes("sandboxId")
    ),
    "SandboxBinding must require sandboxId only for user-managed-persistent"
  );
  assert.deepEqual(binding.properties.provider.enum, ["e2b", "daytona"]);
  const createOp = spec.paths["/v1/tasks"].post;
  assert.ok(createOp.responses["400"], "task creation must declare the typed binding-error response");
});

test("task creation accepts an optional provider-qualified model selection (Part 9)", () => {
  const create = spec.components.schemas.TaskCreateRequest;
  assert.ok(create.properties.model, "TaskCreateRequest must carry the optional model property");
  assert.equal(create.properties.model.type, "string");
  assert.ok(
    !create.required.includes("model"),
    "the model selection is optional — absent means the default chain"
  );
  const createOp = spec.paths["/v1/tasks"].post;
  assert.match(createOp.description, /modelSelectionInvalid/);
});

test("the token-span schema is shared and its scope vocabulary is closed", () => {
  const span = spec.components.schemas.TokenSpan;
  assert.deepEqual([...span.required].sort(), ["end", "scope", "start"]);
  assert.equal(span.additionalProperties, false);
  // The OpenAPI enum and the TS vocabulary are the SAME closed set.
  assert.deepEqual(span.properties.scope.enum, [...TOKEN_SPAN_SCOPES_V1]);
  // FileContent relays these spans (server-tokenized path, Part 10).
  const fileContent = spec.components.schemas.FileContent;
  assert.equal(fileContent.properties.tokenSpans.items.$ref, "#/components/schemas/TokenSpan");

  assert.ok(isTokenSpanV1({ start: 0, end: 3, scope: "keyword" }));
  assert.ok(!isTokenSpanV1({ start: 3, end: 3, scope: "keyword" }), "empty spans are invalid");
  assert.ok(!isTokenSpanV1({ start: 0, end: 3, scope: "rainbow" }), "unknown scopes are invalid");
  assert.ok(
    areTokenSpansWellFormedV1(
      [
        { start: 0, end: 3, scope: "keyword" },
        { start: 4, end: 9, scope: "string" },
      ],
      10
    )
  );
  assert.ok(
    !areTokenSpansWellFormedV1(
      [
        { start: 0, end: 5, scope: "keyword" },
        { start: 4, end: 9, scope: "string" },
      ],
      10
    ),
    "overlapping spans are malformed"
  );
  assert.ok(
    !areTokenSpansWellFormedV1([{ start: 0, end: 11, scope: "keyword" }], 10),
    "out-of-bounds spans are malformed"
  );
});

test("gate decisions are idempotent with typed mismatch and conflict", () => {
  const request = spec.components.schemas.GateDecisionRequest;
  assert.ok(request.required.includes("idempotencyKey"));
  assert.equal(request.properties.idempotencyKey.pattern, "^[0-9a-f]{32}$");
  const decisionOp = spec.paths["/v1/gates/{gateId}/decision"].post;
  assert.ok(decisionOp.responses["409"], "decided-gate conflict (gateAlreadyDecided) must be declared");
  assert.ok(decisionOp.responses["422"], "payload mismatch (gateDecisionPayloadMismatch) must be declared");
  assert.match(decisionOp.description, /gateDecisionPayloadMismatch/);
  assert.match(decisionOp.description, /gateAlreadyDecided/);
});

test("key records are write/rotate/delete only with masked metadata reads", () => {
  // No GET on the individual key record — material is never readable back.
  const keyItem = spec.paths["/v1/keys/{keyKind}"];
  assert.equal(keyItem.get, undefined, "an individual key record must not be readable");
  assert.ok(keyItem.put && keyItem.delete);
  // The masked-metadata schema must not carry key material.
  const metadata = spec.components.schemas.KeyRecordMetadata;
  assert.equal(metadata.properties.key, undefined);
  assert.equal(metadata.additionalProperties, false);
  // "key" appears as a property only on the write request, nowhere else.
  for (const [name, schema] of Object.entries<Record<string, unknown>>(spec.components.schemas)) {
    if (name === "KeyWriteRequest") {
      continue;
    }
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(!("key" in properties), `schema ${name} must not expose key material`);
  }
  // The write response echoes nothing.
  assert.equal(keyItem.put.responses["204"].content, undefined);
});

// ---------------------------------------------------------------------------
// SandboxBinding validators
// ---------------------------------------------------------------------------

// The common case: nothing to attach to, so no sandboxId — the control plane
// creates the sandbox and assigns the id.
const validBinding = {
  provider: "e2b",
  source: { kind: "gitClone", repoUrl: "https://github.com/example/repo.git", ref: "main" },
  workingDirectoryRoot: "/workspace/repo",
  lifecycle: "task-owned-ephemeral",
  cleanup: "destroy-on-completion",
};

/** Attaching to a workspace the user already owns — the only mode with an id. */
const validPersistentBinding = {
  ...validBinding,
  sandboxId: "sbx_123",
  lifecycle: "user-managed-persistent",
  cleanup: "retain",
};

test("sandbox binding validation: typed errors, no unbound path", () => {
  assert.equal(validateSandboxBindingRequestV1(validBinding).ok, true);
  assert.equal(validateSandboxBindingRequestV1(validPersistentBinding).ok, true);

  // An ephemeral binding cannot name a sandbox that does not exist yet.
  const ephemeralWithId = validateSandboxBindingRequestV1({ ...validBinding, sandboxId: "sbx_123" });
  assert.ok(!ephemeralWithId.ok && ephemeralWithId.code === "sandboxBindingInvalid");

  // Attaching to an existing workspace without saying which one is not a binding.
  const persistentWithoutId = validateSandboxBindingRequestV1({
    ...validPersistentBinding,
    sandboxId: undefined,
  });
  assert.ok(!persistentWithoutId.ok && persistentWithoutId.code === "sandboxBindingInvalid");

  const missing = validateSandboxBindingRequestV1(undefined);
  assert.ok(!missing.ok && missing.code === "sandboxBindingMissing");

  const badProvider = validateSandboxBindingRequestV1({ ...validBinding, provider: "aws-ec2" });
  assert.ok(!badProvider.ok && badProvider.code === "sandboxBindingInvalid");

  const unknownField = validateSandboxBindingRequestV1({ ...validBinding, extra: 1 });
  assert.ok(!unknownField.ok && unknownField.code === "sandboxBindingInvalid");

  const badRoot = validateSandboxBindingRequestV1({ ...validBinding, workingDirectoryRoot: "workspace/../x" });
  assert.ok(!badRoot.ok && badRoot.code === "workingDirectoryRootInvalid");

  const badCleanup = validateSandboxBindingRequestV1({
    ...validBinding,
    lifecycle: "user-managed-persistent",
    cleanup: "destroy-on-completion",
  });
  assert.ok(!badCleanup.ok && badCleanup.code === "sandboxBindingInvalid");

  const attach = validateSandboxBindingRequestV1({
    ...validPersistentBinding,
    source: { kind: "attachExisting", path: "/home/user/project" },
  });
  assert.equal(attach.ok, true);
});

test("path confinement: escapes are rejected, clean paths resolve under the root", () => {
  const root = "/workspace/repo";
  const good = confinePathToBindingRootV1(root, "src/app/main.ts");
  assert.ok(good.ok && good.absolutePath === "/workspace/repo/src/app/main.ts");

  const dotSegments = confinePathToBindingRootV1(root, "./src//app/./main.ts");
  assert.ok(dotSegments.ok && dotSegments.absolutePath === "/workspace/repo/src/app/main.ts");

  for (const escape of [
    "../etc/passwd",
    "src/../../etc/passwd",
    "/etc/passwd",
    "C:\\Windows\\system32",
    "src\\app\\main.ts",
    "src/\0/x",
    "",
  ]) {
    const result = confinePathToBindingRootV1(root, escape);
    assert.ok(!result.ok, `path ${JSON.stringify(escape)} must be rejected`);
    assert.equal(result.ok === false && result.code, "pathOutsideBindingRoot");
  }
});
