# Experimental pi-subagents backend

This is the operator path for the fork-only `backend: "pi-subagents"` integration. It is not released support in the public npm package. Native execution remains the default; every delegated call must opt in explicitly. There is no automatic selection or silent fallback, and the runtime never invents missing accounting.

## Install and enable the reviewed pair

Install the exact consumer and provider commits as Pi git packages:

```bash
pi install git:github.com/Nabsku/pi-dynamic-workflows@c4a45209ba2229b86df8b4e1e40ac1143609b78e
pi install git:github.com/Nabsku/pi-subagents@b77781ea926203b32af8fad439432e5cef2aae5f
```

`pi install` adds both package sources to Pi settings, which enables their declared extensions. Run `/reload` in the Pi process that will execute the workflow. Both extensions must share that process and its EventBus; installing only one side is not enough.

Verify the configured sources and checked-out commits before running:

```bash
pi list
git -C ~/.pi/agent/git/github.com/Nabsku/pi-dynamic-workflows rev-parse HEAD
git -C ~/.pi/agent/git/github.com/Nabsku/pi-subagents rev-parse HEAD
```

The two hashes must be exactly the hashes above. If another source for either package is already enabled, remove or filter the duplicate rather than loading two implementations of the same extension or tool.

## Compatibility

| Consumer | Provider | Result |
| --- | --- | --- |
| `Nabsku/pi-dynamic-workflows@c4a45209ba2229b86df8b4e1e40ac1143609b78e` | `Nabsku/pi-subagents@b77781ea926203b32af8fad439432e5cef2aae5f` | Tested experimental provider discovery, delegation v1, request-scoped lifecycle semantics, and truthful delegated model diagnostics |
| Same consumer | stock `pi-subagents@0.35.1` | Fails closed: no provider discovery |
| Same consumer | stock `pi-subagents@0.37.0` | Fails closed: no provider discovery |
| Public `@quintinshaw/pi-dynamic-workflows` releases | Any provider | No released support implied by this fork guide |

Package version `0.37.0` reported by the reviewed provider fork is package metadata, not proof that stock `0.37.0` implements discovery. Unknown provider identity, generation, package metadata, protocol shape, required request fields, status, or acknowledgement fails closed.

## Deterministic offline smoke

`pi install` installs runtime dependencies, not the test-only dependencies used by these checks. Bootstrap a disposable verification checkout at the exact reviewed consumer commit before running them:

```bash
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-dynamic-workflows-verify.XXXXXX")"
trap 'rm -rf -- "$VERIFY_DIR"' EXIT
git clone --no-checkout https://github.com/Nabsku/pi-dynamic-workflows.git "$VERIFY_DIR"
git -C "$VERIFY_DIR" checkout --detach c4a45209ba2229b86df8b4e1e40ac1143609b78e
cd "$VERIFY_DIR"
npm ci
```

The checkout is removed when the shell exits. Do not run these test commands directly from Pi's managed package checkout unless its development dependencies were installed separately.

From the disposable consumer checkout, run the offline native/delegated smoke. It executes one native fake agent and one delegated EventBus provider concurrently; it makes no model request and needs no paid credentials:

```bash
node --import tsx --test --test-name-pattern="offline two-agent native and delegated smoke" tests/pi-subagents-backend.test.ts
```

Expected result: one matching test passes and the process exits zero. This proves the selected checkout's routing and lifecycle seam, not a live model/provider session.

Run the focused lifecycle matrix separately. It uses only deterministic EventBus fakes and makes no model request:

```bash
node --import tsx --test tests/pi-subagents-lifecycle.test.ts
```

Expected result: three tests pass. Together they exercise explicit foreground execution, the default background return boundary, parallel delegated nodes, settlement after the initiating tool turn has returned, `/workflows`-equivalent stop ownership and correlated cancellation, delegated timeout and provider rejection, compatible extension reload handoff, journal replay, and resume.

For an actual workflow, opt in per call:

```js
const native = await agent('Inspect locally.', { label: 'native' })
const delegated = await agent('Review the finding.', {
  label: 'delegated-review',
  backend: 'pi-subagents',
  agentType: 'reviewer',
})
return { native, delegated }
```

Omitting `backend` uses native execution. There is no global backend switch.

## Supported boundary

The delegated adapter supports awaited, request-scoped text-result calls inside both foreground and background workflow runs, explicit pi-subagents role names, optional resolved model forwarding, timeout policy, correlated start/progress/terminal events, cancellation, aggregate token totals when reported, and diagnostic paths/warnings. The workflow runtime remains authoritative for workflow call identity, run ownership, controls, limits, retries, journal/result handling, persistence, reload handoff, resume, and UI state; pi-subagents remains authoritative for its role configuration and each delegated child execution until a correlated terminal event settles that request.

It does not support workflow JSON Schema, workflow shared-store child tools, workflow custom toolsets, detached provider-owned child jobs, or a second workflow lifecycle authority. It does not define a public provider registry/discovery protocol: discovery is the exact reviewed fork's synchronous process-local compatibility seam. `background` controls the workflow run's delivery boundary, not a second provider mode: each delegated request stays awaited by and correlated to its owning workflow run, including after a default-background tool call has returned its run ID.

Model and role precedence differs deliberately from native execution:

- `agentType` is forwarded as the exact pi-subagents role. This extension does not resolve or merge its own `.pi/agents` definition for that call.
- An explicit `model` wins. Otherwise a configured `tier`, phase route, or workflow metadata route may supply the forwarded model.
- With no workflow-side model route, no model is forwarded, so the pi-subagents role keeps its configured model.
- An unavailable workflow-selected model follows the workflow model resolver's visible session-default behavior; there is no backend fallback.

Protocol v1 can report only aggregate tokens. The runtime preserves that total and marks unavailable input/output/cache/cost dimensions unknown; it never fabricates a split or cost. Provider diagnostics, bridge acknowledgement, output paths, review fields, and provider-discovery reports are observations only. They are not authentication, authorization, operator approval, or acceptance evidence.

## Observe and recover

Observe delegated work through the normal workflow panel or `/workflows status <run-id>`. Correlated progress, resolved model, aggregate token total, warnings, session file, and output path appear only when the provider reports them. A request is acknowledged only by a valid correlated started or terminal event; generic progress does not acknowledge it.

Common failures and recovery:

| Failure | Meaning | Recovery |
| --- | --- | --- |
| `provider discovery is unavailable` | Wrong/stock provider, provider not loaded, or extensions are not in one process | Recheck both sources and exact HEADs, then `/reload` once |
| provider identity/package/generation/protocol drift | Loaded provider differs from the reviewed contract | Restore the exact provider commit; do not bypass negotiation |
| `did not acknowledge` | Discovery succeeded but no valid correlated started/terminal event arrived | Check the provider extension loaded in the same process, then retry only after fixing it |
| `invalid_request` or unsupported request field | Role/model/timeout request is incompatible | Correct the call or use native; do not strip fields silently |
| schema/shared-store/custom-tool rejection | Capability is intentionally unsupported | Use `backend: "native"` for that call |
| timed out/cancelled/interrupted | The delegated child did not complete | Inspect the workflow result and provider diagnostics; retry only under the workflow's explicit retry policy |
| unknown/malformed status or response | Protocol drift or invalid data | Fail closed, preserve diagnostics, restore the reviewed pair |

After changing either checkout, repeat exact-HEAD verification and the offline smoke. A process restart or `/reload` creates a new provider generation; the consumer renegotiates it. Never treat successful discovery as permission to run tools or accept a result.

## Architecture and trust boundary

The Pi host owns the same-process EventBus. The workflow extension emits a bounded delegation request and validates correlated provider events. The reviewed pi-subagents fork registers one provider descriptor for that EventBus and owns child execution. No EventBus secret, authenticated peer, external registry, second socket, or second lifecycle controller exists in this design.

Therefore any extension loaded in the same Pi process is inside this transport's trust boundary and could emit EventBus data. Validation limits malformed or drifted messages; it does not establish sender identity. Use ordinary Pi package trust and explicit operator review for what is installed and enabled.
