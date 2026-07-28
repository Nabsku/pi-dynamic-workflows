import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SUBAGENT_DELEGATION_PROVIDER, registerSubagentDelegationProvider } from "pi-subagents/delegation";
import { WorkflowAgent } from "../src/agent.js";
import { WorkflowError } from "../src/errors.js";
import {
  PI_SUBAGENTS_CANCEL_EVENT,
  PI_SUBAGENTS_REQUEST_EVENT,
  PI_SUBAGENTS_RESPONSE_EVENT,
  PI_SUBAGENTS_STARTED_EVENT,
  PI_SUBAGENTS_UPDATE_EVENT,
  PiSubagentsBackend,
} from "../src/pi-subagents-backend.js";
import { runWorkflow, type WorkflowAgentRunner } from "../src/workflow.js";

const response = (requestId: string, extra: Record<string, unknown> = {}) => ({
  version: 1,
  requestId,
  status: "completed",
  output: "done",
  ...extra,
});

function reviewedBus(): EventBus {
  const bus = createEventBus();
  registerSubagentDelegationProvider(bus, DEFAULT_SUBAGENT_DELEGATION_PROVIDER);
  return bus;
}

function listenerCountingBus() {
  const inner = createEventBus();
  let listeners = 0;
  const bus: EventBus = {
    emit: inner.emit.bind(inner),
    on(channel, handler) {
      listeners++;
      const off = inner.on(channel, handler);
      return () => {
        listeners--;
        off();
      };
    },
  };
  registerSubagentDelegationProvider(bus, DEFAULT_SUBAGENT_DELEGATION_PROVIDER);
  return { bus, count: () => listeners };
}

test("two-agent native/delegated smoke is deterministic and provider-free", async () => {
  const calls: Array<{ prompt: string; backend?: string }> = [];
  const agent: WorkflowAgentRunner = {
    preflight() {},
    async run(prompt, options) {
      calls.push({ prompt, backend: options?.backend });
      return options?.backend === "pi-subagents" ? "delegated-ok" : "native-ok";
    },
  };

  const result = await runWorkflow(
    `export const meta = { name: 'backend_smoke', description: 'backend smoke' }
const native = await agent('native task')
const delegated = await agent('delegated task', { backend: 'pi-subagents' })
return { native, delegated }`,
    { cwd: "/repo", agent, persistLogs: false },
  );

  assert.equal(JSON.stringify(result.result), JSON.stringify({ native: "native-ok", delegated: "delegated-ok" }));
  assert.deepEqual(calls, [
    { prompt: "native task", backend: undefined },
    { prompt: "delegated task", backend: "pi-subagents" },
  ]);
});

test("delegated execution is isolated from native-only runner setup failures", async () => {
  const bus = reviewedBus();
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId, { output: "isolated" }));
  });
  const options = {
    cwd: "/repo",
    piSubagentsEvents: bus,
    persistLogs: false,
    get session(): never {
      throw new Error("native session setup must not run");
    },
  };

  const result = await runWorkflow(
    `export const meta = { name: 'delegated_isolation', description: 'delegated isolation' }
return await agent('inspect', { backend: 'pi-subagents', agentType: 'reviewer' })`,
    options,
  );

  assert.equal(result.result, "isolated");
});

test("runWorkflow leaves implicit configured-medium model selection to the delegated role", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-delegated-model-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  mkdirSync(join(home, ".pi/workflows"), { recursive: true });
  writeFileSync(
    join(home, ".pi/workflows/model-tiers.json"),
    JSON.stringify({ tiers: { medium: "vendor/configured-medium" } }),
    { encoding: "utf8", flag: "wx" },
  );
  const bus = reviewedBus();
  let request: any;
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    request = raw;
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId));
  });

  try {
    await runWorkflow(
      `export const meta = { name: 'delegated_role_model', description: 'preserve delegated role model' }
return await agent('inspect', { backend: 'pi-subagents', agentType: 'reviewer' })`,
      { cwd: "/repo", piSubagentsEvents: bus, persistLogs: false },
    );
    assert.equal(Object.hasOwn(request, "model"), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("pi-subagents backend sends only protocol v1 and maps start/update/usage/history/diagnostics", async () => {
  const { bus, count } = listenerCountingBus();
  let request: any;
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw) => {
    request = raw;
    bus.emit(PI_SUBAGENTS_STARTED_EVENT, { version: 1, requestId: raw && (raw as any).requestId });
    bus.emit(PI_SUBAGENTS_UPDATE_EVENT, {
      version: 1,
      requestId: (raw as any).requestId,
      recentOutput: "working",
      currentTool: "read",
      model: "vendor/resolved",
      tokens: 12,
    });
    bus.emit(
      PI_SUBAGENTS_RESPONSE_EVENT,
      response((raw as any).requestId, {
        model: "vendor/resolved",
        tokens: 21,
        sessionFile: "/tmp/session.jsonl",
        outputPath: "/tmp/output.md",
        runId: "provider-run-1",
        durationMs: 1234,
        turns: 3,
        toolCount: 2,
        execution: {
          status: "completed",
          success: true,
          exitCode: 0,
          credentials: { apiKey: "ordinary-api-key", password: "ordinary-password" },
        },
        acceptance: { status: "checked", evidenceStatus: "checked", explicit: true },
        review: { status: "not-requested", auth: { client_secret: "ordinary-client-secret" } },
        effects: {
          fileMutation: { status: "not-applicable", expected: false, attempted: false },
          headers: { authorization: "ordinary-authorization", bearerToken: "ordinary-bearer-token" },
        },
        warnings: ["Bearer secret-token", "apiKey=private-value"],
      }),
    );
  });
  const models: string[] = [];
  const usages: any[] = [];
  const histories: any[] = [];
  const diagnostics: any[] = [];
  const result = await new PiSubagentsBackend(bus).run("task", {
    cwd: "/repo",
    model: "vendor/resolved",
    timeoutMs: 500,
    onModelResolved: (m) => models.push(m),
    onUsage: (u) => usages.push(u),
    onHistory: (h) => histories.push(h),
    onDiagnostics: (d) => diagnostics.push(d),
  });
  assert.equal(result, "done");
  assert.equal(request.version, 1);
  assert.equal(request.agent, "delegate");
  assert.equal(request.context, "fresh");
  assert.equal(request.task, "task");
  assert.equal(request.cwd, "/repo");
  assert.equal(request.model, "vendor/resolved");
  assert.equal(request.timeoutMs, 500);
  assert.match(request.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(models.at(-1), "vendor/resolved");
  assert.deepEqual(usages.at(-1), { total: 21, provenance: "pi-subagents-v1" });
  assert.ok(histories.flat().some((h: any) => h.text.includes("working")));
  assert.deepEqual(diagnostics.at(-1), {
    backend: "pi-subagents",
    provider: {
      id: "pi-subagents/prompt-template-bridge",
      package: "pi-subagents",
      protocolVersion: 1,
      status: "completed",
      role: "delegate",
      model: "vendor/resolved",
      modelPrecedence: "explicit",
      usageProvenance: "pi-subagents-v1",
      runId: "provider-run-1",
      sessionFile: "/tmp/session.jsonl",
      outputPath: "/tmp/output.md",
      durationMs: 1234,
      turns: 3,
      toolCount: 2,
      execution: {
        status: "completed",
        success: true,
        exitCode: 0,
        credentials: { apiKey: "[redacted]", password: "[redacted]" },
      },
      acceptance: { status: "checked", evidenceStatus: "checked", explicit: true },
      review: { status: "not-requested", auth: { client_secret: "[redacted]" } },
      effects: {
        fileMutation: { status: "not-applicable", expected: false, attempted: false },
        headers: { authorization: "[redacted]", bearerToken: "[redacted]" },
      },
      warnings: ["Bearer [redacted]", "apiKey=[redacted]"],
    },
  });
  assert.equal(count(), 1, "only the test request listener remains");
});

test("pi-subagents backend deduplicates repeated progress and terminal output", async () => {
  const bus = reviewedBus();
  const histories: any[][] = [];
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    bus.emit(PI_SUBAGENTS_UPDATE_EVENT, { version: 1, requestId: raw.requestId, recentOutput: "same" });
    bus.emit(PI_SUBAGENTS_UPDATE_EVENT, { version: 1, requestId: raw.requestId, recentOutput: "same" });
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId, { output: "same" }));
  });
  await new PiSubagentsBackend(bus).run("task", { cwd: "/repo", onHistory: (history) => histories.push(history) });
  assert.deepEqual(
    histories.at(-1)?.map((entry) => entry.text),
    ["same"],
  );
});

test("pi-subagents backend uses the exact agentType as role", async () => {
  const bus = reviewedBus();
  let role = "";
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    role = raw.agent;
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId));
  });
  await new PiSubagentsBackend(bus).run("task", { cwd: "/repo", agentType: "reviewer" });
  assert.equal(role, "reviewer");
});

test("pi-subagents backend normalizes fractional per-agent timeout to protocol integer", async () => {
  const bus = reviewedBus();
  let timeoutMs: unknown;
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    timeoutMs = raw.timeoutMs;
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId));
  });
  await new PiSubagentsBackend(bus).run("task", { cwd: "/repo", timeoutMs: 1.5 });
  assert.equal(timeoutMs, 2);
});

test("runWorkflow normalizes a fractional run-level timeout before bridge emission", async () => {
  const bus = reviewedBus();
  let timeoutMs: unknown;
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    timeoutMs = raw.timeoutMs;
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId));
  });
  await runWorkflow(
    `export const meta = { name: 'timeout_bridge', description: 'timeout bridge' }
return await agent('task', { backend: 'pi-subagents', agentType: 'reviewer' })`,
    { cwd: "/repo", agentTimeoutMs: 1_000.5, piSubagentsEvents: bus, persistLogs: false },
  );
  assert.equal(timeoutMs, 1_001);
});

test("pi-subagents backend rejects unknown terminal statuses nonrecoverably", async () => {
  const bus = reviewedBus();
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId, { status: "future_status" }));
  });
  await assert.rejects(
    new PiSubagentsBackend(bus).run("task", { cwd: "/repo" }),
    (error: unknown) =>
      error instanceof WorkflowError && !error.recoverable && /unsupported protocol status/.test(error.message),
  );
});

test("pi-subagents backend correlates concurrent responses strictly by requestId", async () => {
  const bus = reviewedBus();
  const requests: any[] = [];
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw) => requests.push(raw));
  const backend = new PiSubagentsBackend(bus);
  const a = backend.run("a", { cwd: "/repo" });
  const b = backend.run("b", { cwd: "/repo" });
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(requests[1].requestId, { output: "B" }));
  bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(requests[0].requestId, { output: "A" }));
  assert.deepEqual(await Promise.all([a, b]), ["A", "B"]);
});

test("provider-generation router keeps high-fanout dispatch O(1) with bounded progress", async () => {
  const { bus, count } = listenerCountingBus();
  const requests: any[] = [];
  const histories = new Map<string, any[]>();
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw) => requests.push(raw));
  const backend = new PiSubagentsBackend(bus);
  const pending = Array.from({ length: 128 }, (_, index) =>
    backend.run(`task-${index}`, {
      cwd: "/repo",
      onHistory: (history) => histories.set(`task-${index}`, history),
    }),
  );

  assert.equal(requests.length, 128);
  assert.equal(count(), 4, "one request listener plus one three-channel generation router");
  for (const request of requests.toReversed()) {
    bus.emit(PI_SUBAGENTS_UPDATE_EVENT, { version: 1, requestId: request.requestId, recentOutput: "latest" });
    bus.emit(PI_SUBAGENTS_STARTED_EVENT, { version: 1, requestId: request.requestId });
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(request.requestId, { output: request.task }));
    bus.emit(PI_SUBAGENTS_UPDATE_EVENT, { version: 1, requestId: request.requestId, recentOutput: "too late" });
  }

  assert.deepEqual(
    await Promise.all(pending),
    Array.from({ length: 128 }, (_, index) => `task-${index}`),
  );
  assert.equal(count(), 1, "the idle router releases every global listener");
  assert.ok([...histories.values()].every((history) => history.length <= 2));
  assert.ok([...histories.values()].every((history) => history.every((entry) => entry.text !== "too late")));
});

test("provider generations route independently across replacement and exact cleanup", async () => {
  const { bus, count } = listenerCountingBus();
  const requests: any[] = [];
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw) => requests.push(raw));
  const oldBackend = new PiSubagentsBackend(bus);
  const oldPending = oldBackend.run("old", { cwd: "/repo" });
  registerSubagentDelegationProvider(bus, DEFAULT_SUBAGENT_DELEGATION_PROVIDER);
  const newPending = new PiSubagentsBackend(bus).run("new", { cwd: "/repo" });

  assert.equal(count(), 7, "one request listener plus two generation-scoped routers");
  bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(requests[1].requestId, { output: "NEW" }));
  assert.equal(await newPending, "NEW");
  assert.equal(count(), 4, "the settled replacement generation is removed without disturbing the old request");
  bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(requests[0].requestId, { output: "OLD" }));
  assert.equal(await oldPending, "OLD");
  assert.equal(count(), 1);
});

test("cancellation storm emits once per request and releases the shared router", async () => {
  const { bus, count } = listenerCountingBus();
  const controllers = Array.from({ length: 128 }, () => new AbortController());
  const cancelled = new Set<string>();
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, () => {});
  bus.on(PI_SUBAGENTS_CANCEL_EVENT, (raw: any) => cancelled.add(raw.requestId));
  const backend = new PiSubagentsBackend(bus);
  const pending = controllers.map((controller, index) =>
    backend.run(`cancel-${index}`, { cwd: "/repo", signal: controller.signal }),
  );
  assert.equal(count(), 5, "two harness listeners plus one shared three-channel router");
  for (const controller of controllers) {
    controller.abort();
    controller.abort();
  }
  const settled = await Promise.allSettled(pending);
  assert.ok(settled.every(({ status }) => status === "rejected"));
  assert.equal(cancelled.size, 128);
  assert.equal(count(), 2);
});

test("pi-subagents backend abort emits correlated cancel and cleans listeners", async () => {
  const { bus, count } = listenerCountingBus();
  const controller = new AbortController();
  let requestId = "";
  let cancelled = "";
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    requestId = raw.requestId;
  });
  bus.on(PI_SUBAGENTS_CANCEL_EVENT, (raw: any) => {
    cancelled = raw.requestId;
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, { version: 1, requestId: raw.requestId, status: "cancelled" });
  });
  const pending = new PiSubagentsBackend(bus).run("task", { cwd: "/repo", signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled|aborted/i);
  assert.equal(cancelled, requestId);
  assert.equal(count(), 2);
});

test("pi-subagents backend timeout cancels and cleans listeners", async () => {
  const { bus, count } = listenerCountingBus();
  const controller = new AbortController();
  let cancel: any;
  let request: any;
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    request = raw;
    bus.emit(PI_SUBAGENTS_STARTED_EVENT, { version: 1, requestId: raw.requestId });
  });
  bus.on(PI_SUBAGENTS_CANCEL_EVENT, (raw) => (cancel = raw));
  const pending = new PiSubagentsBackend(bus).run("task", { cwd: "/repo", timeoutMs: 5, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled|aborted/i);
  assert.equal(request.timeoutMs, 5, "workflow policy is forwarded while its AbortSignal owns local timeout");
  assert.equal(cancel.version, 1);
  assert.equal(count(), 2);
});

test("pi-subagents backend fails closed when unavailable, unaccepted, invalid, or non-completed", async () => {
  for (const [status, pattern] of [
    ["timed_out", /timed out/i],
    ["cancelled", /cancelled/i],
    ["interrupted", /interrupted/i],
    ["unavailable_context", /active extension context/i],
    ["invalid_request", /invalid request/i],
    ["acceptance_failed", /acceptance/i],
    ["turn_budget_exhausted", /turn_budget_exhausted/i],
    ["tool_budget_exhausted", /tool_budget_exhausted/i],
    ["structured_output_failed", /structured_output_failed/i],
    ["failed", /provider rate limit reached/i],
  ] as const) {
    const bus = reviewedBus();
    bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) =>
      bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, {
        version: 1,
        requestId: raw.requestId,
        status,
        error: status === "failed" ? "provider rate limit reached" : `bridge ${status}`,
      }),
    );
    await assert.rejects(new PiSubagentsBackend(bus).run("task", { cwd: "/repo" }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.match(error.message, pattern);
      return true;
    });
  }
});

test("pi-subagents backend sanitizes terminal and nested diagnostics before exposing a failure", async () => {
  const bus = reviewedBus();
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, {
      version: 1,
      requestId: raw.requestId,
      status: "acceptance_failed",
      error: "apiKey=private-value useful acceptance detail",
      execution: {
        error: "Bearer nested-secret",
        detail: ["token=inner-token", { note: "execution retained" }],
        credentials: { apiKey: "object-api-key", password: "object-password" },
      },
      acceptance: { reason: "password=hunter2 evidence missing" },
      review: { comment: "token: reviewer-secret fix the evidence", client_secret: "object-client-secret" },
      effects: {
        warning: "api_key=effects-secret mutation unknown",
        headers: { authorization: "object-authorization", bearerToken: "object-bearer-token" },
      },
    });
  });

  await assert.rejects(new PiSubagentsBackend(bus).run("task", { cwd: "/repo" }), (error: unknown) => {
    assert.ok(error instanceof WorkflowError);
    const exposed = JSON.stringify({ message: error.message, details: error.details });
    for (const secret of [
      "private-value",
      "nested-secret",
      "inner-token",
      "hunter2",
      "reviewer-secret",
      "effects-secret",
      "object-api-key",
      "object-password",
      "object-client-secret",
      "object-authorization",
      "object-bearer-token",
    ]) {
      assert.doesNotMatch(exposed, new RegExp(secret));
    }
    assert.match(error.message, /apiKey=\[redacted\] useful acceptance detail/);
    assert.match(exposed, /execution retained/);
    assert.match(exposed, /fix the evidence/);
    assert.match(exposed, /mutation unknown/);
    assert.match(exposed, /\[redacted\]/);
    return true;
  });
});

test("pi-subagents backend rejects completed responses with empty or malformed output", async () => {
  for (const output of [undefined, "", "   "]) {
    const bus = reviewedBus();
    bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
      bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId, { output }));
    });
    await assert.rejects(new PiSubagentsBackend(bus).run("task", { cwd: "/repo" }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, "AGENT_EMPTY_OUTPUT");
      return true;
    });
  }

  const bus = reviewedBus();
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId, { output: { text: "not wire text" } }));
  });
  await assert.rejects(new PiSubagentsBackend(bus).run("task", { cwd: "/repo" }), (error: unknown) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.code, "AGENT_EXECUTION_ERROR");
    assert.equal(error.recoverable, false);
    assert.match(error.message, /malformed protocol response/i);
    return true;
  });
});

test("pi-subagents backend recognizes the 0.37 structured-output terminal status", async () => {
  const bus = reviewedBus();
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId, { status: "structured_output_failed" }));
  });
  await assert.rejects(new PiSubagentsBackend(bus).run("task", { cwd: "/repo" }), (error: unknown) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.code, "AGENT_EXECUTION_ERROR");
    assert.equal(error.recoverable, true);
    assert.doesNotMatch(error.message, /unsupported protocol status/i);
    return true;
  });
});

test("pi-subagents backend rejects schema and unsupported workflow tools before request emission", async () => {
  const bus = reviewedBus();
  let emitted = 0;
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, () => emitted++);
  const backend = new PiSubagentsBackend(bus);
  await assert.rejects(backend.run("task", { cwd: "/repo", schema: { type: "object" } as any }), /JSON Schema/i);
  await assert.rejects(backend.run("task", { cwd: "/repo", hasWorkflowTools: true }), /shared-store|toolset/i);
  assert.equal(emitted, 0);
});

test("pi-subagents backend rejects missing event bus without emitting", async () => {
  await assert.rejects(
    new PiSubagentsBackend(undefined).run("task", { cwd: "/repo" }),
    /unavailable.*same Pi process/i,
  );
});

test("pi-subagents backend fails closed when no bridge acknowledges the request", async () => {
  const bus = reviewedBus();
  await assert.rejects(new PiSubagentsBackend(bus, 5).run("task", { cwd: "/repo" }), /did not acknowledge/i);
});

test("pi-subagents updates never acknowledge the bridge", async () => {
  const bus = reviewedBus();
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    bus.emit(PI_SUBAGENTS_UPDATE_EVENT, { version: 1, requestId: raw.requestId, recentOutput: "" });
  });
  await assert.rejects(new PiSubagentsBackend(bus, 5).run("task", { cwd: "/repo" }), /did not acknowledge/i);
});

test("pi-subagents rejects non-plain, accessor-bearing, and unknown-field protocol events", async () => {
  for (const makeEvent of [
    (requestId: string) => Object.assign(Object.create({}), response(requestId)),
    (requestId: string) => Object.assign([], response(requestId)),
    (requestId: string) =>
      Object.defineProperty(response(requestId), "output", {
        enumerable: true,
        get() {
          throw new Error("getter must not run");
        },
      }),
    (requestId: string) => response(requestId, { surprise: true }),
  ]) {
    const bus = reviewedBus();
    bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, makeEvent(raw.requestId)));
    await assert.rejects(new PiSubagentsBackend(bus, 50).run("task", { cwd: "/repo" }), /malformed protocol response/i);
  }
});

test("pi-subagents caps oversized final output and diagnostics before callbacks", async () => {
  const bus = reviewedBus();
  let diagnostics: any;
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    bus.emit(
      PI_SUBAGENTS_RESPONSE_EVENT,
      response(raw.requestId, {
        output: "x".repeat(1_100_000),
      }),
    );
  });
  await assert.rejects(
    new PiSubagentsBackend(bus).run("task", { cwd: "/repo", onDiagnostics: (value) => (diagnostics = value) }),
    /final output exceeds/i,
  );
  assert.equal(diagnostics, undefined);

  const warningBus = reviewedBus();
  warningBus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    warningBus.emit(
      PI_SUBAGENTS_RESPONSE_EVENT,
      response(raw.requestId, { warnings: Array.from({ length: 51 }, () => "warning") }),
    );
  });
  await assert.rejects(
    new PiSubagentsBackend(warningBus).run("task", { cwd: "/repo" }),
    /malformed protocol response/i,
  );
});

test("a malformed response for one concurrent request cannot poison another", async () => {
  const bus = reviewedBus();
  const requests: any[] = [];
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw) => requests.push(raw));
  const backend = new PiSubagentsBackend(bus);
  const first = backend.run("first", { cwd: "/repo" });
  const second = backend.run("second", { cwd: "/repo" });
  bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(requests[0].requestId, { unknown: true }));
  bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(requests[1].requestId, { output: "second" }));
  await assert.rejects(first, /malformed protocol response/i);
  assert.equal(await second, "second");
});

test("pi-subagents retains a bounded coalesced progress tail", async () => {
  const bus = reviewedBus();
  const histories: any[][] = [];
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    bus.emit(PI_SUBAGENTS_STARTED_EVENT, { version: 1, requestId: raw.requestId });
    for (let i = 0; i < 100; i++) {
      bus.emit(PI_SUBAGENTS_UPDATE_EVENT, {
        version: 1,
        requestId: raw.requestId,
        recentOutput: `${String(i).padStart(3, "0")}:${"x".repeat(16_000)}`,
      });
    }
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId));
  });
  await new PiSubagentsBackend(bus).run("task", { cwd: "/repo", onHistory: (value) => histories.push(value) });
  const tail = histories.at(-1) ?? [];
  assert.ok(tail.length <= 33, `expected bounded progress plus final output, got ${tail.length}`);
  assert.ok(tail.reduce((total, entry) => total + entry.text.length, 0) <= 262_144 + "done".length);
  assert.match(tail.at(-2)?.text ?? "", /^099:/, "the newest progress survives after older output is coalesced");
});

test("pi-subagents rejects excessive progress before joining lines", async () => {
  const bus = reviewedBus();
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    bus.emit(PI_SUBAGENTS_STARTED_EVENT, { version: 1, requestId: raw.requestId });
    bus.emit(PI_SUBAGENTS_UPDATE_EVENT, {
      version: 1,
      requestId: raw.requestId,
      recentOutputLines: Array.from({ length: 10_000 }, () => "x"),
    });
  });
  await assert.rejects(new PiSubagentsBackend(bus).run("task", { cwd: "/repo" }), /malformed protocol update/i);
});

test("pi-subagents cancel is best-effort and abort settles exactly once", async () => {
  const inner = createEventBus();
  const controller = new AbortController();
  let cancels = 0;
  const bus: EventBus = {
    on: inner.on.bind(inner),
    emit(channel, data) {
      if (channel === PI_SUBAGENTS_CANCEL_EVENT) {
        cancels++;
        throw new Error("cancel subscriber exploded");
      }
      inner.emit(channel, data);
    },
  };
  registerSubagentDelegationProvider(bus, DEFAULT_SUBAGENT_DELEGATION_PROVIDER);
  const pending = new PiSubagentsBackend(bus).run("task", { cwd: "/repo", signal: controller.signal });
  controller.abort();
  controller.abort();
  await assert.rejects(pending, /cancelled|aborted/i);
  assert.equal(cancels, 1);
});

test("pi-subagents timeout/abort response races settle once and release listeners", async () => {
  const { bus, count } = listenerCountingBus();
  const controller = new AbortController();
  let requestId = "";
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => (requestId = raw.requestId));
  const pending = new PiSubagentsBackend(bus).run("task", { cwd: "/repo", signal: controller.signal });
  controller.abort();
  bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(requestId, { output: "too late" }));
  await assert.rejects(pending, /cancelled|aborted/i);
  assert.equal(count(), 1);
});

test("pi-subagents backend cleans listeners when request dispatch throws", async () => {
  const { bus, count } = listenerCountingBus();
  const broken: EventBus = {
    on: bus.on.bind(bus),
    emit(channel, data) {
      if (channel === PI_SUBAGENTS_REQUEST_EVENT) throw new Error("subscriber exploded");
      bus.emit(channel, data);
    },
  };
  registerSubagentDelegationProvider(broken, DEFAULT_SUBAGENT_DELEGATION_PROVIDER);
  await assert.rejects(
    new PiSubagentsBackend(broken).run("task", { cwd: "/repo" }),
    /dispatch failed.*subscriber exploded/i,
  );
  assert.equal(count(), 0);
});

test("provider negotiation caches by generation and observes reload/version drift", () => {
  const bus = createEventBus();
  const first = registerSubagentDelegationProvider(bus, DEFAULT_SUBAGENT_DELEGATION_PROVIDER);
  const backend = new PiSubagentsBackend(bus);
  assert.equal(backend.negotiate().generation, first.descriptor.generation);
  assert.equal(backend.negotiate(), first.descriptor);

  const replacement = registerSubagentDelegationProvider(bus, DEFAULT_SUBAGENT_DELEGATION_PROVIDER);
  first.dispose();
  assert.equal(backend.negotiate().generation, replacement.descriptor.generation);

  registerSubagentDelegationProvider(bus, {
    ...DEFAULT_SUBAGENT_DELEGATION_PROVIDER,
    packageVersion: "0.37.1-drift",
  });
  assert.throws(() => backend.negotiate(), /package version drifted.*0\.37\.1-drift/i);
});

test("cached provider generation still negotiates request-specific fields", () => {
  const bus = createEventBus();
  registerSubagentDelegationProvider(bus, {
    ...DEFAULT_SUBAGENT_DELEGATION_PROVIDER,
    protocols: DEFAULT_SUBAGENT_DELEGATION_PROVIDER.protocols.map((protocol) =>
      protocol.version === 1 ? { ...protocol, requestFields: { ...protocol.requestFields, model: false } } : protocol,
    ),
  });
  const backend = new PiSubagentsBackend(bus);
  backend.negotiate();
  assert.throws(() => backend.negotiate({ model: "vendor/model" }), /does not support requested model routing/i);
});

test("workflow negotiates delegated providers before starting or running an agent", async () => {
  let runs = 0;
  let starts = 0;
  const agent = {
    preflight() {
      throw new Error("provider discovery rejected");
    },
    async run() {
      runs++;
      return "unexpected";
    },
  };
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'provider_preflight', description: 'provider preflight' }
return await agent('task', { backend: 'pi-subagents', agentType: 'reviewer' })`,
      { cwd: "/repo", agent, persistLogs: false, onAgentStart: () => starts++ },
    ),
    /provider discovery rejected/i,
  );
  assert.equal(starts, 0);
  assert.equal(runs, 0);
});

test("WorkflowAgent fails closed for mutating or undeclared delegated roles before provider reservation", () => {
  const bus = reviewedBus();
  const agent = new WorkflowAgent({ cwd: process.cwd(), piSubagentsEvents: bus });

  for (const options of [
    { backend: "pi-subagents" as const },
    { backend: "pi-subagents" as const, agentType: "worker" },
    { backend: "pi-subagents" as const, agentType: "reviewer", isolation: "worktree" as const },
  ]) {
    assert.throws(() => agent.preflight(options), /analysis\/research\/review\/report|worktree isolation/i);
  }
  assert.doesNotThrow(() => agent.preflight({ backend: "pi-subagents", agentType: "reviewer" }));
});

test("workflow negotiates a tier-routed delegated model before reserving or starting an agent", async () => {
  const bus = createEventBus();
  registerSubagentDelegationProvider(bus, {
    ...DEFAULT_SUBAGENT_DELEGATION_PROVIDER,
    protocols: DEFAULT_SUBAGENT_DELEGATION_PROVIDER.protocols.map((protocol) =>
      protocol.version === 1 ? { ...protocol, requestFields: { ...protocol.requestFields, model: false } } : protocol,
    ),
  });
  let requests = 0;
  let starts = 0;
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, () => requests++);

  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'tier_preflight', description: 'tier preflight' }
return await agent('task', { backend: 'pi-subagents', agentType: 'reviewer', tier: 'medium' })`,
      {
        cwd: "/repo",
        mainModel: "vendor/default",
        piSubagentsEvents: bus,
        persistLogs: false,
        onAgentStart: () => starts++,
      },
    ),
    /does not support requested model routing/i,
  );
  assert.equal(starts, 0);
  assert.equal(requests, 0);
});

test("WorkflowAgent delegates an explicit role without overriding its configured model", async () => {
  const bus = reviewedBus();
  let request: any;
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    request = raw;
    bus.emit(PI_SUBAGENTS_STARTED_EVENT, { version: 1, requestId: raw.requestId });
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId, { output: "reviewed", model: "role/default" }));
  });
  const agent = new WorkflowAgent({ cwd: process.cwd(), piSubagentsEvents: bus });
  const result = await agent.run("inspect this", {
    backend: "pi-subagents",
    agentType: "reviewer",
    label: "review gate",
  });
  assert.equal(result, "reviewed");
  assert.equal(request.agent, "reviewer");
  assert.equal(request.model, undefined);
  assert.match(request.task, /Task label: review gate/);
  assert.match(request.task, /inspect this/);
});

test("workflow forwards phase and metadata model routes to delegated calls", async () => {
  const bus = reviewedBus();
  const requests: any[] = [];
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    requests.push(raw);
    bus.emit(PI_SUBAGENTS_STARTED_EVENT, { version: 1, requestId: raw.requestId });
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId));
  });
  const models = [
    { provider: "route", id: "phase" },
    { provider: "route", id: "metadata" },
  ] as any[];
  const modelRegistry = {
    find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    getAvailable: () => models,
    getAll: () => models,
  } as any;

  await runWorkflow(
    `export const meta = {
  name: 'delegated_routes', description: 'delegated phase and metadata routing', model: 'route/metadata',
  phases: [{ title: 'Phase route', model: 'route/phase' }, { title: 'Metadata route' }]
}
phase('Phase route')
await agent('phase task', { backend: 'pi-subagents', agentType: 'reviewer' })
phase('Metadata route')
await agent('metadata task', { backend: 'pi-subagents', agentType: 'reviewer' })
return {}`,
    { cwd: "/repo", modelRegistry, piSubagentsEvents: bus, persistLogs: false },
  );

  assert.deepEqual(
    requests.map(({ agent, model }) => ({ agent, model })),
    [
      { agent: "reviewer", model: "route/phase" },
      { agent: "reviewer", model: "route/metadata" },
    ],
  );
});
