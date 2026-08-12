/**
 * Shared test fixtures for the control-plane suites: a controllable clock,
 * binding/task builders, and a deterministic fake identity validator (the
 * real validators get their own coverage in sessions.test.ts).
 */
import type { SandboxBindingV1 } from "../../ensemble-contract/src/sandboxBindingV1";
import type { PersistedTaskProgressV1 } from "../../ensemble-core/src/taskProgressDecoderV1";
import type { ControlPlaneTaskRecordV1 } from "../src/storeV1";
import {
  AuthExchangeRequestV1,
  IdentityProviderNameV1,
  IdentityValidationErrorV1,
  IdentityValidatorV1,
} from "../src/identityValidatorsV1";

export interface TestClockV1 {
  readonly now: () => Date;
  advance(deltaMs: number): void;
}

export function makeClock(startIso = "2026-08-12T00:00:00.000Z"): TestClockV1 {
  let ms = Date.parse(startIso);
  return {
    now: (): Date => new Date(ms),
    advance(deltaMs: number): void {
      ms += deltaMs;
    },
  };
}

export function makeBinding(
  ownerUserId: string,
  overrides?: Partial<SandboxBindingV1>
): SandboxBindingV1 {
  return {
    bindingId: "b".repeat(32),
    ownerUserId,
    provider: "e2b",
    sandboxId: "sbx-1",
    source: { kind: "attachExisting", path: "/workspace" },
    workingDirectoryRoot: "/workspace",
    lifecycle: "user-managed-persistent",
    cleanup: "retain",
    ...overrides,
  };
}

export function makeProgress(taskId: string, atIso: string): PersistedTaskProgressV1 {
  return {
    ensembleProgressVersion: 1,
    taskFolder: taskId,
    currentStage: "desc",
    status: "creating",
    createdAt: atIso,
    updatedAt: atIso,
  };
}

export function makeTaskRecord(
  taskId: string,
  ownerUserId: string,
  atIso: string,
  bindingOverrides?: Partial<SandboxBindingV1>
): ControlPlaneTaskRecordV1 {
  return {
    taskId,
    ownerUserId,
    request: "test task",
    binding: makeBinding(ownerUserId, bindingOverrides),
    progress: makeProgress(taskId, atIso),
    rounds: [],
    createdAt: atIso,
  };
}

/**
 * A deterministic validator: authorization codes map straight to provider
 * subjects; anything unrecognized is rejected exactly like a failed
 * provider-side exchange.
 */
export function makeFakeValidator(
  provider: IdentityProviderNameV1,
  codeToSubject: Readonly<Record<string, string>>
): IdentityValidatorV1 {
  return {
    provider,
    validate(request: AuthExchangeRequestV1): Promise<{
      readonly provider: IdentityProviderNameV1;
      readonly providerSubjectId: string;
    }> {
      const subject = codeToSubject[request.authorizationCode];
      if (subject === undefined) {
        return Promise.reject(new IdentityValidationErrorV1("unrecognized authorization code"));
      }
      return Promise.resolve({ provider, providerSubjectId: subject });
    },
  };
}
