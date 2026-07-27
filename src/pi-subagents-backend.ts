import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { SubagentDelegationRequest, SubagentDelegationStatus } from "pi-subagents/delegation";
import type { TSchema } from "typebox";
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";

export const PI_SUBAGENTS_PROTOCOL_VERSION = 1 as const;
/** Releases exercised by the real-parser/bridge conformance fixtures. */
export const PI_SUBAGENTS_COMPATIBILITY_RANGE = ">=0.35.1 <0.38.0" as const;
export const PI_SUBAGENTS_REQUEST_EVENT = "prompt-template:subagent:request";
export const PI_SUBAGENTS_STARTED_EVENT = "prompt-template:subagent:started";
export const PI_SUBAGENTS_UPDATE_EVENT = "prompt-template:subagent:update";
export const PI_SUBAGENTS_RESPONSE_EVENT = "prompt-template:subagent:response";
export const PI_SUBAGENTS_CANCEL_EVENT = "prompt-template:subagent:cancel";

export interface PiSubagentsDiagnosticDetails {
  runId?: string;
  model?: string;
  outputPath?: string;
  sessionFile?: string;
  warnings?: string[];
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
}

type TerminalStatus = SubagentDelegationStatus;

const MAX_PROTOCOL_STRING_CHARS = 4_096;
const MAX_PROGRESS_LINE_CHARS = 16_384;
const MAX_PROGRESS_LINES = 200;
const MAX_PROGRESS_CHARS = 262_144;
const MAX_PROGRESS_HISTORY = 32;
const MAX_WARNING_COUNT = 50;
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

/** Narrow optional adapter over pi-subagents' public v1 foreground delegation protocol. */
export class PiSubagentsBackend {
  constructor(
    private readonly events: EventBus | undefined,
    private readonly handshakeTimeoutMs = 2_000,
  ) {}

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
    if (!this.events) {
      return Promise.reject(
        new WorkflowError(
          'backend "pi-subagents" is not available in the same Pi process; install/enable a compatible pi-subagents bridge or select backend "native"',
          WorkflowErrorCode.AGENT_EXECUTION_ERROR,
          { recoverable: false },
        ),
      );
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
          events.emit(PI_SUBAGENTS_CANCEL_EVENT, { version: PI_SUBAGENTS_PROTOCOL_VERSION, requestId });
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
          if (progressChars + text.length > MAX_PROGRESS_CHARS) return;
          progressChars += text.length;
          while (history.length >= MAX_PROGRESS_HISTORY) history.shift();
        }
        history.push({ role: "assistant", kind: "text", text });
        options.onHistory?.([...history]);
      };
      const malformed = (kind: string) =>
        fail(`pi-subagents returned malformed protocol ${kind}`, WorkflowErrorCode.AGENT_EXECUTION_ERROR, false);

      cleanups.push(
        events.on(PI_SUBAGENTS_STARTED_EVENT, (raw) => {
          const started = ownDataRecord(raw, STARTED_FIELDS);
          if (!started) {
            if (safelyTargets(raw, requestId)) malformed("started event");
            return;
          }
          if (!validBase(started, requestId)) return;
          acknowledgeBridge();
        }),
        events.on(PI_SUBAGENTS_UPDATE_EVENT, (raw) => {
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
              !(lines?.every((line) => typeof line === "string" && line.length <= MAX_PROGRESS_LINE_CHARS) ?? false)) ||
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
        }),
        events.on(PI_SUBAGENTS_RESPONSE_EVENT, (raw) => {
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
                warnings?.every((item) => typeof item === "string" && item.length <= MAX_PROTOCOL_STRING_CHARS) ?? false
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
          const details: PiSubagentsDiagnosticDetails = {
            ...(typeof terminal.runId === "string" ? { runId: terminal.runId } : {}),
            ...(typeof terminal.model === "string" ? { model: terminal.model } : {}),
            ...(typeof terminal.outputPath === "string" ? { outputPath: terminal.outputPath } : {}),
            ...(typeof terminal.sessionFile === "string" ? { sessionFile: terminal.sessionFile } : {}),
            ...(warnings ? { warnings: warnings as string[] } : {}),
          };
          options.onDiagnostics?.(details);
          if (typeof terminal.model === "string") options.onModelResolved?.(terminal.model);
          if (typeof terminal.tokens === "number" && Number.isFinite(terminal.tokens) && terminal.tokens >= 0) {
            // Protocol v1 reports only a total. Do not fabricate an input/output
            // split or cost; the workflow still receives the authoritative total.
            options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: terminal.tokens, cost: 0 });
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
          const wireError = typeof terminal.error === "string" ? terminal.error : undefined;
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
