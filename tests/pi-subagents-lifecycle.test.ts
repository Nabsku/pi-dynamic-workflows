import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { createWorkflowControlTool } from "../src/workflow-control-tool.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowTool } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

type BridgeParams = Record<string, unknown>;
type BridgeModule = {
  registerPromptTemplateDelegationBridge(options: {
    events: EventBus;
    getContext: () => { cwd: string };
    execute: (
      requestId: string,
      params: BridgeParams,
      signal: AbortSignal,
      ctx: { cwd: string },
      onUpdate: (result: unknown) => void,
    ) => Promise<unknown>;
    executeVersioned?: (
      requestId: string,
      params: BridgeParams,
      signal: AbortSignal,
      ctx: { cwd: string },
      onUpdate: (result: unknown) => void,
    ) => Promise<unknown>;
  }): { dispose(): void };
};

const piSubagentsEntry = import.meta.resolve("pi-subagents");
const bridgeUrl = new URL("./src/slash/prompt-template-bridge.ts", piSubagentsEntry);
const { registerPromptTemplateDelegationBridge } = (await import(bridgeUrl.href)) as BridgeModule;

const delegatedScript = `export const meta = { name: 'delegated_lifecycle', description: 'delegated lifecycle' }
const value = await agent('delegated task', { backend: 'pi-subagents', agentType: 'analyst' })
return { value }`;

const strictDelegatedScript = `export const meta = { name: 'strict_delegated_lifecycle', description: 'strict delegated lifecycle' }
const value = await agent('delegated task', { backend: 'pi-subagents', agentType: 'analyst' })
if (value === null) throw new Error('delegated child failed')
return { value }`;

const parallelScript = `export const meta = { name: 'delegated_parallel', description: 'delegated parallel' }
const values = await parallel([
  () => agent('first', { backend: 'pi-subagents', agentType: 'researcher' }),
  () => agent('second', { backend: 'pi-subagents', agentType: 'reviewer' }),
])
return { values }`;

function completed(output: string) {
  return { details: { mode: "single", results: [{ agent: "delegate", exitCode: 0, finalOutput: output }] } };
}

function withHarness(
  fn: (context: { cwd: string; bus: EventBus; manager: WorkflowManager }) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-delegated-lifecycle-"));
    const home = mkdtempSync(join(tmpdir(), "pi-dw-delegated-home-"));
    try {
      await withFakeHomeAsync(home, async () => {
        const bus = createEventBus();
        const manager = new WorkflowManager({ cwd, piSubagentsEvents: bus });
        manager.on("error", () => {});
        await fn({ cwd, bus, manager });
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test(
  "reviewed bridge settles foreground workflows inline",
  withHarness(async ({ cwd, bus, manager }) => {
    const registration = registerPromptTemplateDelegationBridge({
      events: bus,
      getContext: () => ({ cwd }),
      execute: async () => completed("foreground-ok"),
      executeVersioned: async () => completed("foreground-ok"),
    });
    try {
      const result = await manager.runSync(delegatedScript);
      assert.equal(JSON.stringify(result.result), JSON.stringify({ value: "foreground-ok" }));
      assert.ok(result.runId);
      assert.equal(manager.getRun(result.runId)?.background, false);
      assert.equal(manager.getRun(result.runId)?.status, "completed");
    } finally {
      registration.dispose();
    }
  }),
);

test(
  "background workflow returns ownership immediately and settles through the same provider lifecycle",
  withHarness(async ({ cwd, bus, manager }) => {
    let release!: () => void;
    let childSettled = false;
    const child = new Promise<void>((resolve) => (release = resolve));
    const registration = registerPromptTemplateDelegationBridge({
      events: bus,
      getContext: () => ({ cwd }),
      execute: async () => {
        await child;
        childSettled = true;
        return completed("background-ok");
      },
      executeVersioned: async () => {
        await child;
        childSettled = true;
        return completed("background-ok");
      },
    });
    try {
      const tool = createWorkflowTool({ cwd, manager });
      const toolResult = await (tool.execute as any)(
        "background-call",
        { script: delegatedScript },
        undefined,
        undefined,
        undefined,
      );
      const details = toolResult.details as { runId: string; background: boolean };
      assert.equal(details.background, true);
      assert.equal(manager.getRun(details.runId)?.background, true);
      assert.equal(manager.getRun(details.runId)?.status, "running");
      assert.equal(childSettled, false, "workflow tool did not return control before the child settled");
      release();
      await waitFor(() => manager.getRun(details.runId)?.status === "completed", "background run did not settle");
      assert.equal(childSettled, true);
      assert.equal(
        JSON.stringify((manager.getRun(details.runId)?.result as { result?: unknown } | undefined)?.result),
        JSON.stringify({ value: "background-ok" }),
      );
    } finally {
      registration.dispose();
    }
  }),
);

test(
  "parallel delegated nodes retain provider-owned request settlement",
  withHarness(async ({ cwd, bus, manager }) => {
    const seen = new Set<string>();
    const registration = registerPromptTemplateDelegationBridge({
      events: bus,
      getContext: () => ({ cwd }),
      execute: async (requestId, params) => {
        seen.add(requestId);
        return completed(`${String(params.agent)}:${String(params.task)}`);
      },
      executeVersioned: async (requestId, params) => {
        seen.add(requestId);
        return completed(`${String(params.agent)}:${String(params.task)}`);
      },
    });
    try {
      const result = await manager.runSync(parallelScript, undefined, { concurrency: 2 });
      assert.equal(seen.size, 2);
      const values = (result.result as { values: string[] }).values;
      assert.match(values[0] ?? "", /^researcher:.*first$/s);
      assert.match(values[1] ?? "", /^reviewer:.*second$/s);
    } finally {
      registration.dispose();
    }
  }),
);

test(
  "workflow stop aborts the provider child and settles the background run once",
  withHarness(async ({ cwd, bus, manager }) => {
    let providerAborted = false;
    let providerStarted = false;
    const registration = registerPromptTemplateDelegationBridge({
      events: bus,
      getContext: () => ({ cwd }),
      execute: async (_requestId, _params, signal) =>
        new Promise((_, reject) => {
          providerStarted = true;
          signal.addEventListener(
            "abort",
            () => {
              providerAborted = true;
              reject(new Error("provider child aborted"));
            },
            { once: true },
          );
        }),
      executeVersioned: async (_requestId, _params, signal) =>
        new Promise((_, reject) => {
          providerStarted = true;
          signal.addEventListener(
            "abort",
            () => {
              providerAborted = true;
              reject(new Error("provider child aborted"));
            },
            { once: true },
          );
        }),
    });
    try {
      const started = manager.startInBackground(delegatedScript);
      await waitFor(() => providerStarted, "child did not start");
      const control = createWorkflowControlTool({ manager });
      const controlResult = await (control.execute as any)(
        "stop-call",
        { action: "stop", runId: started.runId },
        undefined,
        undefined,
        undefined,
      );
      assert.equal(controlResult.details.result, "stopped");
      await assert.rejects(started.promise, (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.WORKFLOW_ABORTED);
        return true;
      });
      assert.equal(providerAborted, true);
      assert.equal(manager.getRun(started.runId)?.status, "aborted");
    } finally {
      registration.dispose();
    }
  }),
);

test(
  "delegated timeout and provider failure settle as workflow failures without fallback",
  withHarness(async ({ cwd, bus, manager }) => {
    let mode: "hang" | "fail" = "hang";
    const registration = registerPromptTemplateDelegationBridge({
      events: bus,
      getContext: () => ({ cwd }),
      execute: async () => {
        if (mode === "fail") throw new Error("provider exploded");
        return new Promise(() => {});
      },
      executeVersioned: async () => {
        if (mode === "fail") throw new Error("provider exploded");
        return new Promise(() => {});
      },
    });
    try {
      await assert.rejects(
        manager.runSync(strictDelegatedScript, undefined, { agentTimeoutMs: 20 }),
        /delegated child failed/i,
      );
      assert.match(manager.listRuns().at(0)?.agents[0]?.error ?? "", /timed out/i);
      mode = "fail";
      await assert.rejects(manager.runSync(strictDelegatedScript), /delegated child failed/i);
      assert.equal(manager.listRuns().filter((run) => run.status === "failed").length, 2);
    } finally {
      registration.dispose();
    }
  }),
);

test(
  "reload reconfiguration preserves an in-flight provider child and uses the refreshed bus next",
  withHarness(async ({ cwd, bus, manager }) => {
    let release!: () => void;
    let providerStarted = false;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const first = registerPromptTemplateDelegationBridge({
      events: bus,
      getContext: () => ({ cwd }),
      execute: async () => {
        providerStarted = true;
        await pending;
        return completed("before-reload");
      },
      executeVersioned: async () => {
        providerStarted = true;
        await pending;
        return completed("before-reload");
      },
    });
    const started = manager.startInBackground(delegatedScript);
    await waitFor(() => providerStarted, "child did not start");

    const nextBus = createEventBus();
    const next = registerPromptTemplateDelegationBridge({
      events: nextBus,
      getContext: () => ({ cwd }),
      execute: async () => completed("after-reload"),
      executeVersioned: async () => completed("after-reload"),
    });
    manager.reconfigureAfterReload({ piSubagentsEvents: nextBus });
    release();
    assert.equal(JSON.stringify((await started.promise).result), JSON.stringify({ value: "before-reload" }));
    assert.equal(
      JSON.stringify((await manager.runSync(delegatedScript)).result),
      JSON.stringify({ value: "after-reload" }),
    );
    first.dispose();
    next.dispose();
  }),
);

test(
  "resume reruns delegated calls because cached text is not durable effect evidence",
  withHarness(async ({ cwd, bus, manager }) => {
    const calls: string[] = [];
    let failSecond = true;
    const registration = registerPromptTemplateDelegationBridge({
      events: bus,
      getContext: () => ({ cwd }),
      execute: async (_requestId, params) => {
        const task = String(params.task);
        const name = task.endsWith("second") ? "second" : "first";
        calls.push(name);
        if (name === "second" && failSecond) throw new Error("retry me");
        return completed(`${name}-ok`);
      },
      executeVersioned: async (_requestId, params) => {
        const task = String(params.task);
        const name = task.endsWith("second") ? "second" : "first";
        calls.push(name);
        if (name === "second" && failSecond) throw new Error("retry me");
        return completed(`${name}-ok`);
      },
    });
    const script = `export const meta = { name: 'delegated_resume', description: 'delegated resume' }
const first = await agent('first', { backend: 'pi-subagents', agentType: 'analyst' })
const second = await agent('second', { backend: 'pi-subagents', agentType: 'analyst' })
if (second === null) throw new Error('retry me')
return { first, second }`;
    const started = manager.startInBackground(script);
    await assert.rejects(started.promise, /retry me/i);
    failSecond = false;
    assert.equal(await manager.resume(started.runId), true);
    await waitFor(() => manager.getRun(started.runId)?.status === "completed", "resumed run did not complete");
    assert.deepEqual(calls, ["first", "second", "first", "second"]);
    registration.dispose();
  }),
);
