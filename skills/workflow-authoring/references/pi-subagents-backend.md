# pi-subagents backend

Use `backend: "pi-subagents"` only when the active installation provides the reviewed fork contract. Native execution is the default; selection is per `agent()` call, fail-closed, and has no automatic fallback.

The complete operator path—exact pinned installation, compatibility matrix, deterministic provider-free smoke, observation, recovery, supported boundaries, and trust model—is in [`docs/pi-subagents-backend.md`](../../../docs/pi-subagents-backend.md).

## Authoring rules

- Delegate only when the operator has confirmed `Nabsku/pi-subagents@b77781ea926203b32af8fad439432e5cef2aae5f` is active in the same Pi process. Stock 0.35.1 and 0.37.0 lack provider discovery and fail closed.
- Do not combine delegation with `schema`, workflow shared-store child tools, workflow custom toolsets, or worktree isolation.
- `agentType` is the pi-subagents role. This extension does not merge its local agent definition for delegated calls.
- Explicit `model` or resolved `tier` overrides the delegated role model. Omit both to preserve pi-subagents' configured role/default model.
- A background workflow still uses foreground delegation inside its run. Background controls result delivery; it does not create a second delegated lifecycle authority.
- Treat bridge reports as diagnostics, not authentication, authorization, approval, or permission evidence.