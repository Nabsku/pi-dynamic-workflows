import assert from "node:assert/strict";
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
import { runWorkflow } from "../src/workflow.js";

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
  assert.deepEqual(usages.at(-1), { total: 21, provenance: "pi-subagents-v1" });
  assert.ok(histories.flat().some((h: any) => h.text.includes("working")));
  assert.deepEqual(diagnostics.at(-1), {
    model: "vendor/resolved",
    sessionFile: "/tmp/session.jsonl",
    outputPath: "/tmp/output.md",
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
return await agent('task', { backend: 'pi-subagents' })`,
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
        recentOutputLines: [`line-${i}`, `line-${i}`],
      });
    }
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(raw.requestId));
  });
  await new PiSubagentsBackend(bus).run("task", { cwd: "/repo", onHistory: (value) => histories.push(value) });
  const tail = histories.at(-1) ?? [];
  assert.ok(tail.length <= 33, `expected bounded progress plus final output, got ${tail.length}`);
  assert.equal(tail.filter((entry) => entry.text === "line-99\nline-99").length, 1);
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
return await agent('task', { backend: 'pi-subagents' })`,
      { cwd: "/repo", agent, persistLogs: false, onAgentStart: () => starts++ },
    ),
    /provider discovery rejected/i,
  );
  assert.equal(starts, 0);
  assert.equal(runs, 0);
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
