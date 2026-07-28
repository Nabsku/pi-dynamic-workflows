import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SUBAGENT_DELEGATION_PROVIDER, registerSubagentDelegationProvider } from "pi-subagents/delegation";
import {
  claimWorkflowRuntime,
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  WORKFLOW_EXTENSION_VERSION,
} from "../src/extension-reload.js";
import {
  PI_SUBAGENTS_CANCEL_EVENT,
  PI_SUBAGENTS_REQUEST_EVENT,
  PI_SUBAGENTS_RESPONSE_EVENT,
  PI_SUBAGENTS_STARTED_EVENT,
} from "../src/pi-subagents-backend.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowTool } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const parallelScript = `export const meta = { name: 'delegated_lifecycle', description: 'delegated lifecycle' }
const [first, second] = await parallel([
  () => agent('first task', { backend: 'pi-subagents', agentType: 'worker' }),
  () => agent('second task', { backend: 'pi-subagents', agentType: 'reviewer' }),
])
return { first, second }`;

const serialScript = `export const meta = { name: 'delegated_resume', description: 'delegated resume' }
const first = await agent('first task', { backend: 'pi-subagents' })
const second = await agent('second task', { backend: 'pi-subagents' })
return { first, second }`;

function reviewedBus(): EventBus {
  const bus = createEventBus();
  registerSubagentDelegationProvider(bus, DEFAULT_SUBAGENT_DELEGATION_PROVIDER);
  return bus;
}

function response(requestId: string, output: string) {
  return { version: 1, requestId, status: "completed", output };
}

function withTempRuntime(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-delegated-lifecycle-"));
    const home = mkdtempSync(join(tmpdir(), "pi-dw-delegated-home-"));
    try {
      await withFakeHomeAsync(home, () => fn(cwd));
    } finally {
      discardWorkflowRuntime(cwd);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function execute(tool: ReturnType<typeof createWorkflowTool>, id: string, args: Record<string, unknown>) {
  return (tool.execute as any)(id, args, undefined, undefined, undefined);
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test(
  "pi-subagents lifecycle: foreground waits while default background survives the initiating turn and settles parallel nodes",
  withTempRuntime(async (cwd) => {
    const bus = reviewedBus();
    const requests: any[] = [];
    bus.on(PI_SUBAGENTS_REQUEST_EVENT, (request: any) => {
      requests.push(request);
      bus.emit(PI_SUBAGENTS_STARTED_EVENT, { version: 1, requestId: request.requestId });
    });
    const manager = new WorkflowManager({ cwd, piSubagentsEvents: bus });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });

    const foreground = execute(tool, "foreground", { script: parallelScript, background: false });
    await waitFor(() => requests.length === 2, "foreground delegated requests did not start");
    assert.equal(requests.length, 2);
    for (const request of requests.splice(0)) {
      bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(request.requestId, request.agent));
    }
    const foregroundResult = await foreground;
    assert.equal((foregroundResult.details as any).result.first, "worker");
    assert.equal((foregroundResult.details as any).result.second, "reviewer");

    const backgroundResult = await execute(tool, "background", { script: parallelScript });
    const runId = (backgroundResult.details as any).runId as string;
    assert.equal((backgroundResult.details as any).background, true);
    assert.equal(manager.getRun(runId)?.status, "running", "the tool turn returns before delegated children settle");
    await waitFor(() => requests.length === 2, "background delegated requests did not start");
    assert.equal(requests.length, 2);
    const completion = new Promise<void>((resolve) => manager.once("complete", () => resolve()));
    for (const request of requests.splice(0)) {
      bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, {
        ...response(request.requestId, request.agent),
        runId: `child-${request.agent}`,
        model: "vendor/effective",
        turns: 2,
        toolCount: 1,
        durationMs: 25,
        tokens: 7,
      });
    }
    await completion;
    assert.equal(manager.getRun(runId)?.status, "completed");
    assert.deepEqual(JSON.parse(JSON.stringify(manager.getRun(runId)?.result?.result)), {
      first: "worker",
      second: "reviewer",
    });
    const persisted = manager.getPersistence().load(runId);
    assert.deepEqual(
      persisted?.agents.map((agent) => ({
        role: agent.delegatedDiagnostics?.role,
        status: agent.delegatedDiagnostics?.providerStatus,
        model: agent.delegatedDiagnostics?.effectiveModel,
        usage: agent.delegatedDiagnostics?.usage,
      })),
      [
        {
          role: "worker",
          status: "completed",
          model: "vendor/effective",
          usage: { total: 7, provenance: "pi-subagents-v1" },
        },
        {
          role: "reviewer",
          status: "completed",
          model: "vendor/effective",
          usage: { total: 7, provenance: "pi-subagents-v1" },
        },
      ],
    );
  }),
);

test(
  "pi-subagents lifecycle: workflow controls own abort and provider timeout/failure settle fail-closed",
  withTempRuntime(async (cwd) => {
    const abortBus = reviewedBus();
    let requestId = "";
    let cancelled = "";
    abortBus.on(PI_SUBAGENTS_REQUEST_EVENT, (request: any) => {
      requestId = request.requestId;
      abortBus.emit(PI_SUBAGENTS_STARTED_EVENT, { version: 1, requestId });
    });
    abortBus.on(PI_SUBAGENTS_CANCEL_EVENT, (event: any) => {
      cancelled = event.requestId;
    });
    const abortManager = new WorkflowManager({ cwd, piSubagentsEvents: abortBus });
    abortManager.on("error", () => {});
    const aborted = abortManager.startInBackground(serialScript);
    await waitFor(() => requestId !== "", "delegated request did not start before abort");
    assert.equal(abortManager.stop(aborted.runId), true);
    await assert.rejects(aborted.promise, /aborted|cancelled/i);
    assert.equal(cancelled, requestId);
    assert.equal(abortManager.listRuns().find(({ runId }) => runId === aborted.runId)?.status, "aborted");

    for (const [status, expectedStatus, expectedCode] of [
      ["timed_out", "completed", undefined],
      ["invalid_request", "failed", "SCRIPT_VALIDATION_ERROR"],
    ] as const) {
      const bus = reviewedBus();
      bus.on(PI_SUBAGENTS_REQUEST_EVENT, (request: any) => {
        bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, {
          version: 1,
          requestId: request.requestId,
          status,
          error: status === "invalid_request" ? "offline provider failure" : undefined,
        });
      });
      const manager = new WorkflowManager({ cwd: join(cwd, status), piSubagentsEvents: bus });
      manager.on("error", () => {});
      const run = manager.startInBackground(serialScript);
      if (expectedCode) await assert.rejects(run.promise, (error: any) => error?.code === expectedCode);
      else {
        const result = await run.promise;
        assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { first: null, second: null });
      }
      assert.equal(manager.listRuns().find(({ runId }) => runId === run.runId)?.status, expectedStatus);
      const diagnostics = manager.getPersistence().load(run.runId)?.agents.at(-1)?.delegatedDiagnostics;
      assert.equal(diagnostics?.providerStatus, status);
      assert.equal(diagnostics?.role, "delegate");
      if (status === "invalid_request") {
        assert.equal(diagnostics?.error, "offline provider failure");
        assert.match(diagnostics?.recoveryHint ?? "", /correct/i);
      }
    }
  }),
);

test(
  "pi-subagents lifecycle: compatible extension reload preserves ownership and paused work resumes from its journal",
  withTempRuntime(async (cwd) => {
    const bus = reviewedBus();
    const pending: any[] = [];
    bus.on(PI_SUBAGENTS_REQUEST_EVENT, (request: any) => {
      pending.push(request);
      bus.emit(PI_SUBAGENTS_STARTED_EVENT, { version: 1, requestId: request.requestId });
    });
    const manager = new WorkflowManager({ cwd, piSubagentsEvents: bus });
    manager.on("error", () => {});
    const run = manager.startInBackground(serialScript);
    await waitFor(() => pending.length === 1, "first delegated request did not start");
    assert.equal(pending.length, 1);
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(pending.shift().requestId, "first-result"));
    await waitFor(() => pending.length === 1, "second delegated request did not start");
    assert.equal(pending.length, 1);

    handoffWorkflowRuntime({ cwd, extensionVersion: WORKFLOW_EXTENSION_VERSION, manager, effort: { level: "high" } });
    const claimed = claimWorkflowRuntime(cwd).compatible;
    assert.equal(claimed?.manager, manager, "reload must retain the one manager that owns promises and controls");

    assert.equal(manager.pause(run.runId), true);
    await run.promise.catch(() => {});
    const resumed = await manager.resume(run.runId);
    assert.equal(resumed, true);
    await waitFor(() => pending.length >= 2, "resumed delegated request did not start");
    const resumedRequest = pending.at(-1);
    assert.ok(resumedRequest);
    bus.emit(PI_SUBAGENTS_RESPONSE_EVENT, response(resumedRequest.requestId, "second-result"));
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("resumed run did not settle")), 500);
      const poll = () => {
        if (manager.getRun(run.runId)?.status === "completed") {
          clearTimeout(deadline);
          resolve();
        } else setImmediate(poll);
      };
      poll();
    });
    assert.deepEqual(JSON.parse(JSON.stringify(manager.getRun(run.runId)?.result?.result)), {
      first: "first-result",
      second: "second-result",
    });
    const finalAgents = manager.getPersistence().load(run.runId)?.agents ?? [];
    assert.equal(
      finalAgents[0]?.delegatedDiagnostics?.providerStatus,
      "completed",
      "journal replay retains diagnostics",
    );
    assert.equal(
      finalAgents[1]?.delegatedDiagnostics?.providerStatus,
      "completed",
      "resumed live result persists diagnostics",
    );
  }),
);
