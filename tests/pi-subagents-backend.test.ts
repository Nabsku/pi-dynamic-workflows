import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
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
import { runWorkflow } from "../src/workflow.js";

const response = (requestId: string, extra: Record<string, unknown> = {}) => ({
  version: 1,
  requestId,
  status: "completed",
  output: "done",
  ...extra,
});

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
  return { bus, count: () => listeners };
}

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
  assert.equal(usages.at(-1).total, 21);
  assert.ok(histories.flat().some((h: any) => h.text.includes("working")));
  assert.deepEqual(diagnostics.at(-1), {
    model: "vendor/resolved",
    sessionFile: "/tmp/session.jsonl",
    outputPath: "/tmp/output.md",
  });
  assert.equal(count(), 1, "only the test request listener remains");
});

test("pi-subagents backend deduplicates repeated progress and terminal output", async () => {
  const bus = createEventBus();
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
  const bus = createEventBus();
  let role = "";
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    role = raw.agent;
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId));
  });
  await new PiSubagentsBackend(bus).run("task", { cwd: "/repo", agentType: "reviewer" });
  assert.equal(role, "reviewer");
});

test("pi-subagents backend normalizes fractional per-agent timeout to protocol integer", async () => {
  const bus = createEventBus();
  let timeoutMs: unknown;
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    timeoutMs = raw.timeoutMs;
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId));
  });
  await new PiSubagentsBackend(bus).run("task", { cwd: "/repo", timeoutMs: 1.5 });
  assert.equal(timeoutMs, 2);
});

test("runWorkflow normalizes a fractional run-level timeout before bridge emission", async () => {
  const bus = createEventBus();
  let timeoutMs: unknown;
  bus.on(PI_SUBAGENTS_REQUEST_EVENT, (raw: any) => {
    timeoutMs = raw.timeoutMs;
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId));
  });
  await runWorkflow(
    `export const meta = { name: 'timeout_bridge', description: 'timeout bridge' }
return await agent('task', { backend: 'pi-subagents' })`,
    { cwd: "/repo", agentTimeoutMs: 1_000.5, piSubagentsEvents: bus, persistLogs: false },
  );
  assert.equal(timeoutMs, 1_001);
});

test("pi-subagents backend rejects unknown terminal statuses nonrecoverably", async () => {
  const bus = createEventBus();
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
  const bus = createEventBus();
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
  let cancel: any;
  bus.on(PI_SUBAGENTS_CANCEL_EVENT, (raw) => (cancel = raw));
  await assert.rejects(new PiSubagentsBackend(bus).run("task", { cwd: "/repo", timeoutMs: 5 }), /timed out/i);
  assert.equal(cancel.version, 1);
  assert.equal(count(), 1);
});

test("pi-subagents backend fails closed when unavailable, unaccepted, invalid, or non-completed", async () => {
  for (const [status, pattern] of [
    ["unavailable_context", /active extension context/i],
    ["invalid_request", /invalid request/i],
    ["acceptance_failed", /acceptance/i],
    ["turn_budget_exhausted", /turn_budget_exhausted/i],
    ["tool_budget_exhausted", /tool_budget_exhausted/i],
    ["failed", /provider rate limit reached/i],
  ] as const) {
    const bus = createEventBus();
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

test("pi-subagents backend rejects schema and unsupported workflow tools before request emission", async () => {
  const bus = createEventBus();
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
    /not available.*same Pi process/i,
  );
});

test("pi-subagents backend fails closed when no bridge acknowledges the request", async () => {
  const bus = createEventBus();
  await assert.rejects(new PiSubagentsBackend(bus, 5).run("task", { cwd: "/repo" }), /did not acknowledge/i);
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
  await assert.rejects(
    new PiSubagentsBackend(broken).run("task", { cwd: "/repo" }),
    /dispatch failed.*subscriber exploded/i,
  );
  assert.equal(count(), 0);
});

test("WorkflowAgent delegates an explicit role without overriding its configured model", async () => {
  const bus = createEventBus();
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
