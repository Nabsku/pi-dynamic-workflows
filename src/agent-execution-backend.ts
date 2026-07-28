import type { TSchema } from "typebox";
import { type AgentRunOptions, resolveAgentModelSpec, WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { canonicalModelSpec, resolveModelSpecWithThinking } from "./model-spec.js";
import { loadModelTierConfig, type ModelTierConfig } from "./model-tier-config.js";
import { PiSubagentsBackend } from "./pi-subagents-backend.js";

/** Canonical execution request shared by the native and delegated backends. */
export interface AgentExecutionBackend {
  preflight?(options: AgentRunOptions<TSchema | undefined>): void;
  run(prompt: string, options?: AgentRunOptions<TSchema>): Promise<unknown>;
}

const DELEGATED_READ_ONLY_ROLES = new Set(["analyst", "researcher", "reviewer", "reporter"]);

function hasConfiguredTools(options: WorkflowAgentOptions): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(options, "tools");
  if (!descriptor) return false;
  return "value" in descriptor ? descriptor.value !== undefined : true;
}

class PiSubagentsExecutionBackend implements AgentExecutionBackend {
  private readonly backend: PiSubagentsBackend;
  private tierConfigBox?: { value: ModelTierConfig | null };

  constructor(private readonly options: WorkflowAgentOptions) {
    this.backend = new PiSubagentsBackend(options.piSubagentsEvents);
  }

  preflight(options: AgentRunOptions<TSchema | undefined>): void {
    if (options.isolation === "worktree") {
      throw new WorkflowError(
        'backend "pi-subagents" cannot be combined with workflow-owned worktree isolation; select backend "native" for isolated mutation',
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    const delegatedRole = options.agentType?.trim().toLowerCase();
    if (!delegatedRole || !DELEGATED_READ_ONLY_ROLES.has(delegatedRole)) {
      throw new WorkflowError(
        'backend "pi-subagents" is limited to analysis/research/review/report roles because its public provider contract cannot enforce durable filesystem effects; use agentType "analyst", "researcher", "reviewer", or "reporter", or select backend "native" for mutation',
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    this.backend.negotiate({ model: this.requestedModel(options), timeoutMs: options.timeoutMs });
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<unknown> {
    this.preflight(options);
    const requestedModel = this.requestedModel(options);
    let forwardedModel = requestedModel;
    if (requestedModel && options.modelRegistry) {
      const resolved = resolveModelSpecWithThinking(requestedModel, options.modelRegistry);
      forwardedModel = resolved.model ? canonicalModelSpec(resolved.model) : undefined;
      if (!resolved.model) options.onModelFallback?.(requestedModel);
    }
    const task = [
      this.options.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    return (await this.backend.run(task, {
      cwd: options.cwd ?? this.options.cwd ?? process.cwd(),
      agentType: options.agentType,
      model: forwardedModel,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      schema: options.schema,
      hasWorkflowTools:
        hasConfiguredTools(this.options) || Boolean(options.tools?.length || options.systemTools?.length),
      onModelResolved: options.onModelResolved,
      onUsage: options.onUsage,
      onHistory: options.onHistory,
      onDiagnostics: options.onDiagnostics,
    })) as unknown;
  }

  private requestedModel(options: Pick<AgentRunOptions, "model" | "tier">): string | undefined {
    // An unqualified delegated role keeps pi-subagents' configured model. The
    // workflow layer folds explicit and resolved phase routes into model, while
    // tier remains explicit here, so only those caller-owned routes resolve.
    if (!options.model && !options.tier) return undefined;
    return resolveAgentModelSpec(options, this.options.mainModel, () => this.loadTierConfig());
  }

  private loadTierConfig(): ModelTierConfig | null {
    if (!this.tierConfigBox) this.tierConfigBox = { value: loadModelTierConfig() };
    return this.tierConfigBox.value;
  }
}

/**
 * Select execution before constructing either implementation. The native runner
 * remains lazy so an explicitly delegated workflow cannot inherit native tool,
 * session, or resource-loader setup failures.
 */
export function createAgentExecutionBackendSelector(
  options: WorkflowAgentOptions,
  injected?: AgentExecutionBackend,
): (backend: "native" | "pi-subagents") => AgentExecutionBackend {
  let native: AgentExecutionBackend | undefined;
  let delegated: AgentExecutionBackend | undefined;
  return (backend) => {
    if (injected) return injected;
    if (backend === "pi-subagents") {
      if (!delegated) delegated = new PiSubagentsExecutionBackend(options);
      return delegated;
    }
    if (!native) native = new WorkflowAgent(options);
    return native;
  };
}
