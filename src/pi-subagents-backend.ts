import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";

export const PI_SUBAGENTS_PROTOCOL_VERSION = 1 as const;
export const PI_SUBAGENTS_REVIEWED_COMMIT = "b77781ea926203b32af8fad439432e5cef2aae5f" as const;
export const PI_SUBAGENTS_PROVIDER_ID = "pi-subagents/prompt-template-bridge" as const;
export const PI_SUBAGENTS_PROVIDER_PACKAGE = "pi-subagents" as const;
/** Package metadata reported by the exact reviewed fork commit; this is not a release claim. */
export const PI_SUBAGENTS_PROVIDER_PACKAGE_VERSION = "0.37.0" as const;
export const PI_SUBAGENTS_REQUEST_EVENT = "prompt-template:subagent:request";
export const PI_SUBAGENTS_STARTED_EVENT = "prompt-template:subagent:started";
export const PI_SUBAGENTS_UPDATE_EVENT = "prompt-template:subagent:update";
export const PI_SUBAGENTS_RESPONSE_EVENT = "prompt-template:subagent:response";
export const PI_SUBAGENTS_CANCEL_EVENT = "prompt-template:subagent:cancel";

export interface PiSubagentsDiagnosticDetails {
  backend: "pi-subagents";
  providerStatus: SubagentDelegationStatus;
  providerId: typeof PI_SUBAGENTS_PROVIDER_ID;
  providerGeneration: number;
  protocol: typeof PI_SUBAGENTS_PROTOCOL_VERSION;
  role: string;
  roleSemantics: "pi-subagents-provider-role";
  requestedModel?: string;
  effectiveModel?: string;
  modelPrecedence: "explicit" | "tier" | "phase" | "session";
  usage?: { total: number; provenance: "pi-subagents-v1" };
  runId?: string;
  outputPath?: string;
  sessionFile?: string;
  warnings?: string[];
  durationMs?: number;
  turns?: number;
  toolCount?: number;
  acceptance?: unknown;
  review?: unknown;
  effects?: unknown;
  /** True only for journal replay; cached text is not fresh effect evidence. */
  replayed?: boolean;
  error?: string;
  recoveryHint?: string;
}

export interface PiSubagentsRunOptions {
  cwd: string;
  agentType?: string;
  model?: string;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  schema?: TSchema;
  /** True when workflow-owned shared-store/custom tool surfaces would be required. */
  hasWorkflowTools?: boolean;
  onModelResolved?: (model: string) => void;
  onUsage?: (usage: AgentUsage) => void;
  onHistory?: (history: AgentHistoryEntry[]) => void;
  onDiagnostics?: (details: PiSubagentsDiagnosticDetails) => void;
  modelPrecedence?: PiSubagentsDiagnosticDetails["modelPrecedence"];
}

type SubagentDelegationStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "turn_budget_exhausted"
  | "tool_budget_exhausted"
  | "structured_output_failed"
  | "acceptance_failed"
  | "invalid_request"
  | "unavailable_context";

interface SubagentDelegationProviderDescriptor {
  readonly providerId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly generation: number;
  readonly protocols: readonly {
    readonly version: 1 | 2;
    readonly terminalStatuses: readonly string[];
    readonly requestFields: Readonly<Record<string, boolean>>;
  }[];
  readonly cancellation: Readonly<{
    supported: boolean;
    preCancellation: boolean;
    identity: "requestId" | "requestId+ownerRunId+nodeId" | "protocol-specific";
  }>;
  readonly concurrency: Readonly<{
    semantics: string;
    maximumConcurrentRequests: number | null;
    v1DuplicateIdentity: string;
  }>;
}

interface SubagentDelegationProviderRegistry {
  readonly providers: WeakMap<object, SubagentDelegationProviderDescriptor>;
}

interface SubagentDelegationRequest {
  version: 1;
  requestId: string;
  agent: string;
  task: string;
  context: "fresh" | "fork";
  cwd: string;
  model?: string;
  timeoutMs?: number;
}

const DELEGATION_PROVIDER_REGISTRY = Symbol.for("pi-subagents.delegation-provider-registry.v1");

/** Read the exact process-global discovery registry exposed by the reviewed fork API. */
function getSubagentDelegationProvider(context: object): SubagentDelegationProviderDescriptor | undefined {
  const registry = (globalThis as Record<PropertyKey, unknown>)[DELEGATION_PROVIDER_REGISTRY] as
    | SubagentDelegationProviderRegistry
    | undefined;
  return registry?.providers.get(context);
}

type TerminalStatus = SubagentDelegationStatus;

const MAX_PROTOCOL_STRING_CHARS = 4_096;
const MAX_PROGRESS_LINE_CHARS = 16_384;
const MAX_PROGRESS_LINES = 200;
const MAX_PROGRESS_CHARS = 262_144;
const MAX_PROGRESS_HISTORY = 32;
const MAX_WARNING_COUNT = 50;
const MAX_PERSISTED_WARNING_COUNT = 10;
const MAX_PERSISTED_DIAGNOSTIC_CHARS = 1_024;
const MAX_FINAL_OUTPUT_CHARS = 1_000_000;

const STARTED_FIELDS = new Set(["version", "requestId"]);
const UPDATE_FIELDS = new Set([
  ...STARTED_FIELDS,
  "currentTool",
  "currentToolArgs",
  "recentOutput",
  "recentOutputLines",
  "recentTools",
  "model",
  "toolCount",
  "durationMs",
  "tokens",
]);
const RESPONSE_FIELDS = new Set([
  ...STARTED_FIELDS,
  "status",
  "error",
  "runId",
  "childIndex",
  "agent",
  "model",
  "exitCode",
  "execution",
  "output",
  "outputPath",
  "sessionFile",
  "acceptance",
  "review",
  "effects",
  "turns",
  "toolCount",
  "durationMs",
  "tokens",
  "warnings",
]);

type PlainRecord = Record<string, unknown>;

function ownDataRecord(raw: unknown, allowed: ReadonlySet<string>): PlainRecord | undefined {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const result: PlainRecord = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!allowed.has(key) || !("value" in descriptor) || descriptor.get || descriptor.set) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function validBase(event: PlainRecord, requestId: string): boolean {
  return event.version === PI_SUBAGENTS_PROTOCOL_VERSION && event.requestId === requestId;
}

function safelyTargets(raw: unknown, requestId: string): boolean {
  try {
    if (raw === null || typeof raw !== "object") return false;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const version = descriptors.version;
    const id = descriptors.requestId;
    return (
      Boolean(version && "value" in version && !version.get && !version.set) &&
      version.value === PI_SUBAGENTS_PROTOCOL_VERSION &&
      Boolean(id && "value" in id && !id.get && !id.set) &&
      id.value === requestId
    );
  } catch {
    return false;
  }
}

function safelyTargetedRequestId(raw: unknown): string | undefined {
  try {
    if (raw === null || typeof raw !== "object") return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const version = descriptors.version;
    const id = descriptors.requestId;
    if (
      !version ||
      !("value" in version) ||
      version.get ||
      version.set ||
      version.value !== PI_SUBAGENTS_PROTOCOL_VERSION ||
      !id ||
      !("value" in id) ||
      id.get ||
      id.set ||
      typeof id.value !== "string"
    )
      return undefined;
    return id.value;
  } catch {
    return undefined;
  }
}

function validOptionalString(value: unknown, max = MAX_PROTOCOL_STRING_CHARS): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function validOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function ownArrayValues(raw: unknown, maxLength: number): unknown[] | undefined {
  try {
    if (!Array.isArray(raw)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(raw, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maxLength) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const values: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) return undefined;
      values.push(descriptor.value);
    }
    if (Object.keys(descriptors).some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key))) return undefined;
    return values;
  } catch {
    return undefined;
  }
}

function validKnownJson(value: unknown, depth = 0): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= MAX_PROGRESS_LINE_CHARS;
  if (depth >= 4) return false;
  if (Array.isArray(value)) {
    const values = ownArrayValues(value, MAX_PROGRESS_LINES);
    return values?.every((item) => validKnownJson(item, depth + 1)) ?? false;
  }
  try {
    const record = ownDataRecord(value, new Set(Object.keys(value as object)));
    if (!record || Object.keys(record).length > MAX_PROGRESS_LINES) return false;
    return Object.values(record).every((item) => validKnownJson(item, depth + 1));
  } catch {
    return false;
  }
}

function sanitizeDiagnosticText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PERSISTED_DIAGNOSTIC_CHARS);
}

function recoveryHint(status: SubagentDelegationStatus): string | undefined {
  if (status === "completed") return undefined;
  if (status === "timed_out") return "Increase timeoutMs or reduce the delegated task scope, then retry.";
  if (status === "cancelled" || status === "interrupted") return "Retry after confirming the workflow is still active.";
  if (status === "turn_budget_exhausted" || status === "tool_budget_exhausted")
    return "Reduce the task scope or adjust the provider-owned budget, then retry.";
  if (status === "unavailable_context")
    return "Enable the reviewed pi-subagents fork in the same Pi process, then retry.";
  if (status === "invalid_request") return "Correct the delegated role, model, or options before retrying.";
  if (status === "acceptance_failed") return "Inspect the bridge acceptance metadata and address its unmet criteria.";
  if (status === "structured_output_failed")
    return "Use backend native when workflow-owned structured output is required.";
  return "Inspect the sanitized bridge error and provider run reference before retrying.";
}

interface DelegatedRequestRoute {
  started(raw: unknown): void;
  update(raw: unknown): void;
  response(raw: unknown): void;
}

/** One EventBus subscription set per provider generation, with O(1) request correlation. */
class DelegatedEventRouter {
  private readonly routes = new Map<string, DelegatedRequestRoute>();
  private readonly off: Array<() => void>;

  constructor(
    events: EventBus,
    private readonly onEmpty: () => void,
  ) {
    const dispatch = (kind: keyof DelegatedRequestRoute, raw: unknown) => {
      const requestId = safelyTargetedRequestId(raw);
      if (requestId === undefined) return;
      this.routes.get(requestId)?.[kind](raw);
    };
    this.off = [
      events.on(PI_SUBAGENTS_STARTED_EVENT, (raw) => dispatch("started", raw)),
      events.on(PI_SUBAGENTS_UPDATE_EVENT, (raw) => dispatch("update", raw)),
      events.on(PI_SUBAGENTS_RESPONSE_EVENT, (raw) => dispatch("response", raw)),
    ];
  }

  add(requestId: string, route: DelegatedRequestRoute): () => void {
    this.routes.set(requestId, route);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.routes.delete(requestId);
      if (this.routes.size === 0) this.onEmpty();
    };
  }

  dispose(): void {
    for (const off of this.off.splice(0)) off();
    this.routes.clear();
  }
}

/** Narrow optional adapter over pi-subagents' public v1 awaited text-result delegation protocol. */
export class PiSubagentsBackend {
  private negotiated?: {
    generation: number;
    descriptor: SubagentDelegationProviderDescriptor;
  };
  private readonly routers = new Map<number, DelegatedEventRouter>();

  constructor(
    private readonly events: EventBus | undefined,
    private readonly handshakeTimeoutMs = 2_000,
  ) {}

  /** Discover and negotiate synchronously; request acknowledgement remains separate. */
  negotiate(options: Pick<PiSubagentsRunOptions, "model" | "timeoutMs"> = {}): SubagentDelegationProviderDescriptor {
    if (!this.events) throw unavailableProvider("no Pi EventBus was supplied");
    const descriptor = getSubagentDelegationProvider(this.events);
    if (!descriptor) {
      throw unavailableProvider(
        "provider discovery is unavailable (stock pi-subagents 0.35.1 and 0.37.0 do not expose the reviewed fork contract)",
      );
    }
    if (this.negotiated?.generation !== descriptor.generation) {
      validateProviderDescriptor(descriptor);
      this.negotiated = { generation: descriptor.generation, descriptor };
    }
    validateRequestedFields(this.negotiated.descriptor, options);
    return this.negotiated.descriptor;
  }

  /** Stable identity for resume across compatible provider reloads. */
  executionIdentity(options: Pick<PiSubagentsRunOptions, "model" | "timeoutMs"> = {}): string {
    const descriptor = this.negotiate(options);
    return `${descriptor.providerId}@${descriptor.packageVersion}:v${PI_SUBAGENTS_PROTOCOL_VERSION}`;
  }

  run(prompt: string, options: PiSubagentsRunOptions): Promise<string> {
    if (options.schema) {
      return Promise.reject(
        new WorkflowError(
          'backend "pi-subagents" cannot carry workflow JSON Schema; select backend "native" for schema agents',
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        ),
      );
    }
    if (options.hasWorkflowTools) {
      return Promise.reject(
        new WorkflowError(
          'backend "pi-subagents" cannot carry workflow shared-store child tools or workflow custom toolsets; select backend "native" when those capabilities are required',
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        ),
      );
    }
    let descriptor: SubagentDelegationProviderDescriptor;
    try {
      descriptor = this.negotiate(options);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!prompt.trim() || !options.cwd.trim()) {
      return Promise.reject(
        new WorkflowError(
          "pi-subagents invalid request: task and cwd must be non-empty",
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          {
            recoverable: false,
          },
        ),
      );
    }

    const events = this.events;
    if (!events) return Promise.reject(unavailableProvider("no Pi EventBus was supplied"));
    const requestId = randomUUID();
    const history: AgentHistoryEntry[] = [];
    const delegatedTimeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? Math.max(1, Math.ceil(options.timeoutMs))
        : undefined;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      let cancelEmitted = false;
      let progressChars = 0;
      const cleanups: Array<() => void> = [];
      const cleanup = () => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        for (const off of cleanups.splice(0)) off();
        options.signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const emitCancel = () => {
        if (cancelEmitted) return;
        cancelEmitted = true;
        try {
          events.emit(PI_SUBAGENTS_CANCEL_EVENT, {
            version: PI_SUBAGENTS_PROTOCOL_VERSION,
            requestId,
          });
        } catch {
          // Cancellation transport is best-effort. Local settlement must win.
        }
      };
      const fail = (message: string, code: WorkflowErrorCode, recoverable: boolean, details?: unknown) =>
        settle(() => reject(new WorkflowError(message, code, { recoverable, details })));
      const onAbort = () => {
        emitCancel();
        fail(
          "pi-subagents delegation cancelled because the workflow was aborted",
          WorkflowErrorCode.WORKFLOW_ABORTED,
          true,
        );
      };
      const acknowledgeBridge = () => {
        if (!handshakeTimer) return;
        clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
      };
      const appendHistory = (text: string, progress = false) => {
        if (!text.trim() || history.at(-1)?.text === text) return;
        if (progress) {
          while (history.length >= MAX_PROGRESS_HISTORY || progressChars + text.length > MAX_PROGRESS_CHARS) {
            const removed = history.shift();
            if (!removed) break;
            progressChars = Math.max(0, progressChars - removed.text.length);
          }
          if (text.length > MAX_PROGRESS_CHARS) return;
          progressChars += text.length;
        }
        history.push({ role: "assistant", kind: "text", text });
        options.onHistory?.([...history]);
      };
      const malformed = (kind: string) =>
        fail(`pi-subagents returned malformed protocol ${kind}`, WorkflowErrorCode.AGENT_EXECUTION_ERROR, false);

      let router = this.routers.get(descriptor.generation);
      if (!router) {
        router = new DelegatedEventRouter(events, () => {
          if (this.routers.get(descriptor.generation) !== router) return;
          router?.dispose();
          this.routers.delete(descriptor.generation);
        });
        this.routers.set(descriptor.generation, router);
      }
      cleanups.push(
        router.add(requestId, {
          started: (raw) => {
            const started = ownDataRecord(raw, STARTED_FIELDS);
            if (!started) {
              if (safelyTargets(raw, requestId)) malformed("started event");
              return;
            }
            if (!validBase(started, requestId)) return;
            acknowledgeBridge();
          },
          update: (raw) => {
            const update = ownDataRecord(raw, UPDATE_FIELDS);
            if (!update) {
              if (safelyTargets(raw, requestId)) malformed("update");
              return;
            }
            if (!validBase(update, requestId)) return;
            const rawLines = update.recentOutputLines;
            const lines = rawLines === undefined ? undefined : ownArrayValues(rawLines, MAX_PROGRESS_LINES);
            const recentTools = update.recentTools;
            if (
              !validOptionalString(update.currentTool) ||
              !validOptionalString(update.currentToolArgs, MAX_PROGRESS_LINE_CHARS) ||
              !validOptionalString(update.recentOutput, MAX_PROGRESS_LINE_CHARS) ||
              !validOptionalString(update.model) ||
              !validOptionalNumber(update.toolCount) ||
              !validOptionalNumber(update.durationMs) ||
              !validOptionalNumber(update.tokens) ||
              (rawLines !== undefined &&
                !(
                  lines?.every((line) => typeof line === "string" && line.length <= MAX_PROGRESS_LINE_CHARS) ?? false
                )) ||
              (recentTools !== undefined && !validKnownJson(recentTools))
            ) {
              malformed("update");
              return;
            }
            if (typeof update.model === "string") options.onModelResolved?.(update.model);
            const text =
              typeof update.recentOutput === "string"
                ? update.recentOutput
                : lines
                  ? lines.join("\n")
                  : typeof update.currentTool === "string"
                    ? `Running ${update.currentTool}`
                    : "";
            appendHistory(text, true);
          },
          response: (raw) => {
            const terminal = ownDataRecord(raw, RESPONSE_FIELDS);
            if (!terminal) {
              if (safelyTargets(raw, requestId)) malformed("response");
              return;
            }
            if (!validBase(terminal, requestId)) return;
            if (typeof terminal.output === "string" && terminal.output.length > MAX_FINAL_OUTPUT_CHARS) {
              fail(
                `pi-subagents final output exceeds ${MAX_FINAL_OUTPUT_CHARS} characters`,
                WorkflowErrorCode.AGENT_EXECUTION_ERROR,
                false,
              );
              return;
            }
            if (terminal.output !== undefined && typeof terminal.output !== "string") {
              malformed("response");
              return;
            }
            const rawWarnings = terminal.warnings;
            const warnings = rawWarnings === undefined ? undefined : ownArrayValues(rawWarnings, MAX_WARNING_COUNT);
            if (
              typeof terminal.status !== "string" ||
              !validOptionalString(terminal.error, MAX_PROGRESS_LINE_CHARS) ||
              !validOptionalString(terminal.runId) ||
              !validOptionalString(terminal.agent) ||
              !validOptionalString(terminal.model) ||
              !validOptionalString(terminal.outputPath, MAX_PROGRESS_LINE_CHARS) ||
              !validOptionalString(terminal.sessionFile, MAX_PROGRESS_LINE_CHARS) ||
              !validOptionalNumber(terminal.childIndex) ||
              !validOptionalNumber(terminal.turns) ||
              !validOptionalNumber(terminal.toolCount) ||
              !validOptionalNumber(terminal.durationMs) ||
              !validOptionalNumber(terminal.tokens) ||
              (terminal.exitCode !== undefined &&
                (typeof terminal.exitCode !== "number" || !Number.isInteger(terminal.exitCode))) ||
              !validKnownJson(terminal.execution) ||
              !validKnownJson(terminal.acceptance) ||
              !validKnownJson(terminal.review) ||
              !validKnownJson(terminal.effects) ||
              (rawWarnings !== undefined &&
                !(
                  warnings?.every((item) => typeof item === "string" && item.length <= MAX_PROTOCOL_STRING_CHARS) ??
                  false
                ))
            ) {
              malformed("response");
              return;
            }

            if (!isTerminalStatus(terminal.status)) {
              fail(
                `pi-subagents returned unsupported protocol status ${JSON.stringify(terminal.status)}`,
                WorkflowErrorCode.AGENT_EXECUTION_ERROR,
                false,
              );
              return;
            }
            acknowledgeBridge();
            const status = terminal.status;
            const wireError = typeof terminal.error === "string" ? sanitizeDiagnosticText(terminal.error) : undefined;
            const effectiveModel = typeof terminal.model === "string" ? terminal.model : undefined;
            const usage =
              typeof terminal.tokens === "number"
                ? {
                    total: terminal.tokens,
                    provenance: "pi-subagents-v1" as const,
                  }
                : undefined;
            const details: PiSubagentsDiagnosticDetails = {
              backend: "pi-subagents",
              providerStatus: status,
              providerId: PI_SUBAGENTS_PROVIDER_ID,
              providerGeneration: descriptor.generation,
              protocol: PI_SUBAGENTS_PROTOCOL_VERSION,
              role: options.agentType ?? "delegate",
              roleSemantics: "pi-subagents-provider-role",
              ...(options.model ? { requestedModel: options.model } : {}),
              ...(effectiveModel ? { effectiveModel } : {}),
              modelPrecedence: options.modelPrecedence ?? (options.model ? "explicit" : "session"),
              ...(usage ? { usage } : {}),
              ...(typeof terminal.runId === "string" ? { runId: terminal.runId } : {}),
              ...(typeof terminal.outputPath === "string" ? { outputPath: terminal.outputPath } : {}),
              ...(typeof terminal.sessionFile === "string" ? { sessionFile: terminal.sessionFile } : {}),
              ...(warnings
                ? {
                    warnings: (warnings as string[]).slice(0, MAX_PERSISTED_WARNING_COUNT).map(sanitizeDiagnosticText),
                  }
                : {}),
              ...(typeof terminal.durationMs === "number" ? { durationMs: terminal.durationMs } : {}),
              ...(typeof terminal.turns === "number" ? { turns: terminal.turns } : {}),
              ...(typeof terminal.toolCount === "number" ? { toolCount: terminal.toolCount } : {}),
              ...(terminal.acceptance !== undefined ? { acceptance: terminal.acceptance } : {}),
              ...(terminal.review !== undefined ? { review: terminal.review } : {}),
              ...(terminal.effects !== undefined ? { effects: terminal.effects } : {}),
              ...(wireError ? { error: wireError } : {}),
              ...(recoveryHint(status) ? { recoveryHint: recoveryHint(status) } : {}),
            };
            options.onDiagnostics?.(details);
            if (typeof terminal.model === "string") options.onModelResolved?.(terminal.model);
            if (typeof terminal.tokens === "number" && Number.isFinite(terminal.tokens) && terminal.tokens >= 0) {
              // Protocol v1 reports only a total. Do not fabricate an input/output
              // split or cost; the workflow still receives the authoritative total.
              options.onUsage?.({
                total: terminal.tokens,
                provenance: "pi-subagents-v1",
              });
            }
            if (status === "completed") {
              const output = typeof terminal.output === "string" ? terminal.output : "";
              if (!output.trim()) {
                fail(
                  "pi-subagents completed without inline assistant output",
                  WorkflowErrorCode.AGENT_EMPTY_OUTPUT,
                  true,
                  details,
                );
                return;
              }
              appendHistory(output);
              settle(() => resolve(output));
              return;
            }
            const message = terminalMessage(status, wireError);
            const limit = classifyProviderLimit(message);
            if (limit.matched) {
              settle(() =>
                reject(
                  new WorkflowError(message, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
                    recoverable: false,
                    resetHint: limit.resetHint,
                    details,
                  }),
                ),
              );
              return;
            }
            if (status === "timed_out") fail(message, WorkflowErrorCode.AGENT_TIMEOUT, true, details);
            else if (status === "cancelled" || status === "interrupted")
              fail(message, WorkflowErrorCode.WORKFLOW_ABORTED, true, details);
            else if (status === "invalid_request")
              fail(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, false, details);
            else if (status === "unavailable_context" || status === "acceptance_failed")
              fail(message, WorkflowErrorCode.AGENT_EXECUTION_ERROR, false, details);
            else fail(message, WorkflowErrorCode.AGENT_EXECUTION_ERROR, true, details);
          },
        }),
      );

      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      handshakeTimer = setTimeout(() => {
        emitCancel();
        fail(
          'backend "pi-subagents" did not acknowledge the public delegation protocol; ensure pi-subagents is enabled in the same Pi process',
          WorkflowErrorCode.AGENT_EXECUTION_ERROR,
          false,
        );
      }, this.handshakeTimeoutMs);
      try {
        const request = {
          version: PI_SUBAGENTS_PROTOCOL_VERSION,
          requestId,
          agent: options.agentType ?? "delegate",
          task: prompt,
          context: "fresh",
          cwd: options.cwd,
          ...(options.model ? { model: options.model } : {}),
          ...(delegatedTimeoutMs !== undefined ? { timeoutMs: delegatedTimeoutMs } : {}),
        } satisfies SubagentDelegationRequest;
        events.emit(PI_SUBAGENTS_REQUEST_EVENT, request);
      } catch (error) {
        fail(
          `pi-subagents request dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
          WorkflowErrorCode.AGENT_EXECUTION_ERROR,
          false,
        );
      }
    });
  }
}

const SUPPORTED_TERMINAL_STATUSES = new Set<SubagentDelegationStatus>([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  "turn_budget_exhausted",
  "tool_budget_exhausted",
  "structured_output_failed",
  "acceptance_failed",
  "invalid_request",
  "unavailable_context",
]);

function unavailableProvider(reason: string): WorkflowError {
  return new WorkflowError(
    `backend "pi-subagents" is unavailable: ${reason}; enable Nabsku/pi-subagents@${PI_SUBAGENTS_REVIEWED_COMMIT} in the same Pi process or select backend "native"`,
    WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    { recoverable: false },
  );
}

function providerDrift(message: string): never {
  throw unavailableProvider(`provider capability negotiation failed: ${message}`);
}

function validateProviderDescriptor(descriptor: SubagentDelegationProviderDescriptor): void {
  if (descriptor.providerId !== PI_SUBAGENTS_PROVIDER_ID)
    providerDrift(`unexpected providerId ${JSON.stringify(descriptor.providerId)}`);
  if (descriptor.packageName !== PI_SUBAGENTS_PROVIDER_PACKAGE)
    providerDrift(`unexpected packageName ${JSON.stringify(descriptor.packageName)}`);
  if (descriptor.packageVersion !== PI_SUBAGENTS_PROVIDER_PACKAGE_VERSION) {
    providerDrift(
      `package version drifted from reviewed metadata ${PI_SUBAGENTS_PROVIDER_PACKAGE_VERSION} to ${JSON.stringify(descriptor.packageVersion)}`,
    );
  }
  if (!Number.isSafeInteger(descriptor.generation) || descriptor.generation <= 0)
    providerDrift("invalid provider generation");

  const protocol = descriptor.protocols.find(({ version }) => version === PI_SUBAGENTS_PROTOCOL_VERSION);
  if (!protocol) providerDrift("delegation protocol v1 is not advertised");
  const statuses = new Set(protocol.terminalStatuses);
  if (
    statuses.size !== SUPPORTED_TERMINAL_STATUSES.size ||
    [...SUPPORTED_TERMINAL_STATUSES].some((status) => !statuses.has(status))
  ) {
    providerDrift("delegation v1 terminal statuses differ from the reviewed contract");
  }
  if (!protocol.requestFields.textResult) providerDrift("delegation v1 does not support text results");

  if (
    !descriptor.cancellation.supported ||
    !descriptor.cancellation.preCancellation ||
    (descriptor.cancellation.identity !== "requestId" && descriptor.cancellation.identity !== "protocol-specific")
  ) {
    providerDrift("cancellation semantics differ from the reviewed requestId contract");
  }
  if (
    descriptor.concurrency.semantics !== "v1-request-id-v2-owner-node" ||
    descriptor.concurrency.maximumConcurrentRequests !== null ||
    descriptor.concurrency.v1DuplicateIdentity !== "ignored"
  ) {
    providerDrift("concurrency semantics differ from the reviewed unbounded v1 requestId contract");
  }
}

function validateRequestedFields(
  descriptor: SubagentDelegationProviderDescriptor,
  options: Pick<PiSubagentsRunOptions, "model" | "timeoutMs">,
): void {
  const requestFields = descriptor.protocols.find(
    ({ version }) => version === PI_SUBAGENTS_PROTOCOL_VERSION,
  )?.requestFields;
  if (!requestFields) providerDrift("delegation protocol v1 disappeared from the cached descriptor");
  if (options.model && !requestFields.model) providerDrift("delegation v1 does not support requested model routing");
  if (typeof options.timeoutMs === "number" && options.timeoutMs > 0 && !requestFields.timeout) {
    providerDrift("delegation v1 does not support requested timeout forwarding");
  }
}

function isTerminalStatus(status: string): status is TerminalStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "turn_budget_exhausted" ||
    status === "tool_budget_exhausted" ||
    status === "structured_output_failed" ||
    status === "acceptance_failed" ||
    status === "invalid_request" ||
    status === "unavailable_context"
  );
}

function terminalMessage(status: TerminalStatus, error?: string): string {
  const suffix = error?.trim() ? `: ${error}` : "";
  switch (status) {
    case "unavailable_context":
      return `pi-subagents delegation requires an active extension context in the same Pi process${suffix}`;
    case "invalid_request":
      return `pi-subagents rejected an invalid request${suffix}`;
    case "acceptance_failed":
      return `pi-subagents delegation failed acceptance${suffix}`;
    case "timed_out":
      return "pi-subagents delegation timed out";
    case "cancelled":
    case "interrupted":
      return `pi-subagents delegation ${status}`;
    default:
      return error?.trim() || `pi-subagents delegation ended with status ${status}`;
  }
}
