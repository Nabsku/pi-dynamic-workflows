import type { TSchema } from "typebox";
import {
  type AgentRunOptions,
  type AgentRunResult,
  resolveAgentModelSpec,
  type WorkflowAgentOptions,
} from "./agent.js";
import { loadModelTierConfig, type ModelTierConfig } from "./model-tier-config.js";
import { PiSubagentsBackend } from "./pi-subagents-backend.js";

/** Internal canonical execution seam selected by runWorkflow for each agent call. */
export interface AgentExecutionBackend {
  run(prompt: string, options?: AgentRunOptions<TSchema>): Promise<unknown>;
  preflight?(options: AgentRunOptions<TSchema>): string | undefined;
}

/** Delegated execution without constructing or initializing the native WorkflowAgent. */
export class PiSubagentsExecutionBackend implements AgentExecutionBackend {
  private readonly cwd: string;
  private readonly instructions?: string;
  private readonly mainModel?: string;
  private readonly backend: PiSubagentsBackend;
  private readonly hasCustomToolset: boolean;
  private tierConfigBox?: { value: ModelTierConfig | null };

  constructor(
    options: Pick<WorkflowAgentOptions, "cwd" | "instructions" | "mainModel" | "piSubagentsEvents" | "tools"> = {},
  ) {
    this.cwd = options.cwd ?? process.cwd();
    this.instructions = options.instructions;
    this.mainModel = options.mainModel;
    this.backend = new PiSubagentsBackend(options.piSubagentsEvents);
    this.hasCustomToolset = options.tools !== undefined;
  }

  private loadTierConfig(): ModelTierConfig | null {
    this.tierConfigBox ??= { value: loadModelTierConfig() };
    return this.tierConfigBox.value;
  }

  private requestedModel(options: AgentRunOptions<TSchema>): string | undefined {
    return resolveAgentModelSpec(options, this.mainModel, () => this.loadTierConfig());
  }

  preflight(options: AgentRunOptions<TSchema>): string | undefined {
    return this.backend.executionIdentity({
      model: options.model || options.tier ? this.requestedModel(options) : undefined,
      timeoutMs: options.timeoutMs,
    });
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const requestedModel =
      options.model || options.tier ? this.requestedModel(options as AgentRunOptions<TSchema>) : undefined;
    const task = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    return (await this.backend.run(task, {
      cwd: options.cwd ?? this.cwd,
      agentType: options.agentType,
      model: requestedModel,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      schema: options.schema,
      hasWorkflowTools: this.hasCustomToolset || Boolean(options.tools?.length || options.systemTools?.length),
      onModelResolved: options.onModelResolved,
      onUsage: options.onUsage,
      onHistory: options.onHistory,
      onDiagnostics: options.onDiagnostics,
      modelPrecedence: options.modelPrecedence,
    })) as AgentRunResult<TSchemaDef>;
  }
}
