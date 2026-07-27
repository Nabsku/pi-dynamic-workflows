import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  PI_SUBAGENTS_COMPATIBILITY_RANGE,
  PI_SUBAGENTS_PROTOCOL_VERSION,
  PI_SUBAGENTS_REQUEST_EVENT,
  PI_SUBAGENTS_RESPONSE_EVENT,
  PiSubagentsBackend,
} from "../src/pi-subagents-backend.js";

type BridgeModule = {
  registerPromptTemplateDelegationBridge(options: {
    events: ReturnType<typeof createEventBus>;
    getContext: () => { cwd: string };
    execute: (
      requestId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      ctx: { cwd: string },
      onUpdate: (result: unknown) => void,
    ) => Promise<unknown>;
    executeVersioned?: (
      requestId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      ctx: { cwd: string },
      onUpdate: (result: unknown) => void,
    ) => Promise<unknown>;
  }): { dispose(): void };
};

type DelegationModule = {
  SUBAGENT_DELEGATION_PROTOCOL_VERSION: number;
  SUBAGENT_DELEGATION_REQUEST_EVENT: string;
  SUBAGENT_DELEGATION_RESPONSE_EVENT: string;
};

const releases = [
  { packageName: "pi-subagents-v0351", version: "0.35.1" },
  { packageName: "pi-subagents", version: "0.37.0" },
] as const;

async function loadRelease(packageName: string): Promise<{ bridge: BridgeModule; delegation: DelegationModule }> {
  const entry = import.meta.resolve(packageName);
  const bridgeUrl = new URL("./src/slash/prompt-template-bridge.ts", entry);
  return {
    bridge: (await import(bridgeUrl.href)) as BridgeModule,
    delegation: (await import(`${packageName}/delegation`)) as DelegationModule,
  };
}

function completed(output: string, model?: string) {
  return {
    details: {
      mode: "single",
      results: [{ agent: "delegate", exitCode: 0, finalOutput: output, ...(model ? { model } : {}) }],
    },
  };
}

for (const release of releases) {
  test(`pi-subagents ${release.version} public v1 bridge accepts omitted and explicit models`, async () => {
    const { bridge, delegation } = await loadRelease(release.packageName);
    assert.equal(delegation.SUBAGENT_DELEGATION_PROTOCOL_VERSION, PI_SUBAGENTS_PROTOCOL_VERSION);
    assert.equal(delegation.SUBAGENT_DELEGATION_REQUEST_EVENT, PI_SUBAGENTS_REQUEST_EVENT);
    assert.equal(delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT, PI_SUBAGENTS_RESPONSE_EVENT);

    const bus = createEventBus();
    const params: Record<string, unknown>[] = [];
    const registration = bridge.registerPromptTemplateDelegationBridge({
      events: bus,
      getContext: () => ({ cwd: "/repo" }),
      execute: async (_requestId, value) => {
        params.push(value);
        return completed(`done:${String(value.model ?? "default")}`, value.model as string | undefined);
      },
      executeVersioned: async (_requestId, value) => {
        params.push(value);
        return completed(`done:${String(value.model ?? "default")}`, value.model as string | undefined);
      },
    });

    try {
      const backend = new PiSubagentsBackend(bus);
      assert.equal(await backend.run("omitted", { cwd: "/repo" }), "done:default");
      assert.equal(await backend.run("explicit", { cwd: "/repo", model: "vendor/model" }), "done:vendor/model");
      assert.equal(params[0]?.model, undefined);
      assert.equal(params[1]?.model, "vendor/model");
    } finally {
      registration.dispose();
    }
  });

  test(`pi-subagents ${release.version} real parser rejects malformed v1 fields`, async () => {
    const { bridge } = await loadRelease(release.packageName);
    const bus = createEventBus();
    const responses: unknown[] = [];
    bus.on(PI_SUBAGENTS_RESPONSE_EVENT, (response) => responses.push(response));
    const registration = bridge.registerPromptTemplateDelegationBridge({
      events: bus,
      getContext: () => ({ cwd: "/repo" }),
      execute: async () => completed("unexpected"),
    });

    try {
      for (const malformed of [{ model: "" }, { timeoutMs: 1.5 }, { unknownField: true }]) {
        bus.emit(PI_SUBAGENTS_REQUEST_EVENT, {
          version: 1,
          requestId: `bad-${responses.length}`,
          agent: "delegate",
          task: "task",
          context: "fresh",
          cwd: "/repo",
          ...malformed,
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(
        responses.map((response) => (response as { status?: string }).status),
        ["invalid_request", "invalid_request", "invalid_request"],
      );
    } finally {
      registration.dispose();
    }
  });
}

test("documented pi-subagents compatibility range is bounded by the conformance fixtures", () => {
  assert.equal(PI_SUBAGENTS_COMPATIBILITY_RANGE, ">=0.35.1 <0.38.0");
});
