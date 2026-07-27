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

type WireEvent = { version?: unknown; requestId?: unknown; [key: string]: unknown };
type TerminalStatus = SubagentDelegationStatus;

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
      let timer: ReturnType<typeof setTimeout> | undefined;
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanups: Array<() => void> = [];
      const cleanup = () => {
        if (timer) clearTimeout(timer);
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
      const emitCancel = () =>
        events.emit(PI_SUBAGENTS_CANCEL_EVENT, { version: PI_SUBAGENTS_PROTOCOL_VERSION, requestId });
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
      const correlated = (raw: unknown): WireEvent | undefined => {
        if (!raw || typeof raw !== "object") return undefined;
        const event = raw as WireEvent;
        return event.version === PI_SUBAGENTS_PROTOCOL_VERSION && event.requestId === requestId ? event : undefined;
      };
      const acknowledgeBridge = () => {
        if (!handshakeTimer) return;
        clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
      };
      const appendHistory = (text: string) => {
        if (!text.trim() || history.at(-1)?.text === text) return;
        history.push({ role: "assistant", kind: "text", text });
        options.onHistory?.([...history]);
      };

      cleanups.push(
        events.on(PI_SUBAGENTS_STARTED_EVENT, (raw) => {
          if (!correlated(raw)) return;
          acknowledgeBridge();
        }),
        events.on(PI_SUBAGENTS_UPDATE_EVENT, (raw) => {
          const update = correlated(raw);
          if (!update) return;
          acknowledgeBridge();
          if (typeof update.model === "string") options.onModelResolved?.(update.model);
          const text =
            typeof update.recentOutput === "string"
              ? update.recentOutput
              : Array.isArray(update.recentOutputLines)
                ? update.recentOutputLines.filter((line): line is string => typeof line === "string").join("\n")
                : typeof update.currentTool === "string"
                  ? `Running ${update.currentTool}`
                  : "";
          appendHistory(text);
        }),
        events.on(PI_SUBAGENTS_RESPONSE_EVENT, (raw) => {
          const terminal = correlated(raw);
          if (!terminal || typeof terminal.status !== "string") return;
          acknowledgeBridge();
          if (!isTerminalStatus(terminal.status)) {
            fail(
              `pi-subagents returned unsupported protocol status ${JSON.stringify(terminal.status)}`,
              WorkflowErrorCode.AGENT_EXECUTION_ERROR,
              false,
            );
            return;
          }
          const status = terminal.status;
          const details: PiSubagentsDiagnosticDetails = {
            ...(typeof terminal.runId === "string" ? { runId: terminal.runId } : {}),
            ...(typeof terminal.model === "string" ? { model: terminal.model } : {}),
            ...(typeof terminal.outputPath === "string" ? { outputPath: terminal.outputPath } : {}),
            ...(typeof terminal.sessionFile === "string" ? { sessionFile: terminal.sessionFile } : {}),
            ...(Array.isArray(terminal.warnings)
              ? { warnings: terminal.warnings.filter((item): item is string => typeof item === "string") }
              : {}),
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
      if (delegatedTimeoutMs !== undefined) {
        timer = setTimeout(() => {
          emitCancel();
          fail(
            `pi-subagents delegation timed out after ${delegatedTimeoutMs}ms`,
            WorkflowErrorCode.AGENT_TIMEOUT,
            true,
          );
        }, delegatedTimeoutMs);
        timer.unref?.();
      }
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
