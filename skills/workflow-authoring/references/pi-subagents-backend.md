# pi-subagents backend authoring

Use `backend: "pi-subagents"` only when the operator has installed and verified the exact fork pair documented in the packaged [operator guide](../../../docs/pi-subagents-backend.md). Native remains the default. Selection is per `agent()` call; there is no automatic selection or silent fallback.

This backend is for foreground text-result delegation through pi-subagents' same-process EventBus provider. It does not support `schema`, workflow shared-store child tools, or workflow custom toolsets. A workflow may run in the background, but its delegated child request is still foreground within that run.

`agentType` is the exact pi-subagents role and is not merged with this extension's agent registry. Explicit `model` wins; otherwise a configured tier/phase/metadata route may be forwarded. With no workflow-side model route, omit the model so the pi-subagents role keeps its own configuration.

Treat progress, provider discovery, bridge acknowledgement, review fields, diagnostics, and output paths as reports only—not authentication, authorization, operator approval, or acceptance evidence. Protocol v1 aggregate token totals are preserved; unavailable splits and cost remain unknown.
