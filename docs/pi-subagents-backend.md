# pi-subagents backend operator guide

The `pi-subagents` backend is optional and fork-only. Native pi-dynamic-workflows execution remains the default. A workflow uses delegation only when that individual `agent()` call sets `backend: "pi-subagents"`; there is no automatic selection or fallback.

## Install and enable the reviewed provider

Install both extensions into the same Pi configuration. Pin the provider to the exact reviewed commit—do not substitute a stock release or a moving branch:

```bash
pi install npm:@quintinshaw/pi-dynamic-workflows
pi install 'git:https://github.com/Nabsku/pi-subagents.git#b77781ea926203b32af8fad439432e5cef2aae5f'
pi list
```

`pi list` must show both sources. Run `/reload` in Pi after installation. The two extensions must load in the same Pi process because the adapter uses that process's Pi EventBus.

For a project-local installation, add `--local` to both `pi install` commands and run them from the project root. Do not install one globally and one project-locally unless `pi list` for that project proves both are active together.

## Compatibility

| pi-subagents source | Provider discovery | Result |
| --- | --- | --- |
| `Nabsku/pi-subagents` commit `b77781ea926203b32af8fad439432e5cef2aae5f` | Reviewed synchronous provider descriptor | Supported for the boundaries below |
| Stock npm `pi-subagents@0.35.1` | Absent | Rejected before an agent slot is reserved |
| Stock npm `pi-subagents@0.37.0` | Absent | Rejected before an agent slot is reserved |
| Other commits, releases, or package metadata | Not reviewed | Fail closed; no compatibility range is promised |

The workflow runtime verifies provider identity, package name/version, generation, protocol version and statuses, request fields, cancellation, and concurrency before reservation. A later correlated `started` event acknowledges one request; discovery and acknowledgement are separate checks.

## Deterministic provider-free smoke

From a checkout of this repository, run the native/delegated two-agent routing smoke and release-conformance suite. These tests use deterministic fake agents and an in-process bridge; they make no paid or live model requests:

```bash
node --import tsx --test \
  --test-name-pattern='two-agent native/delegated smoke|fails closed without provider discovery|exact reviewed fork bridge' \
  tests/pi-subagents-backend.test.ts tests/pi-subagents-release-conformance.test.ts
```

A passing run executes exactly one native call and one explicitly delegated call, proves stock 0.35.1/0.37.0 rejection, and exercises the reviewed provider descriptor. It verifies repository compatibility, not the authentication or availability of any live model.

## Run and observe

Select the backend per call:

```js
export const meta = {
  name: 'delegated_review',
  description: 'Run one native scout and one delegated reviewer',
}

const evidence = await agent('Collect the bounded evidence.', {
  label: 'native scout',
})

return await agent(`Review this evidence:\n${evidence}`, {
  label: 'delegated reviewer',
  backend: 'pi-subagents',
  agentType: 'reviewer',
})
```

The workflow itself may run in the foreground or background. `background` is a workflow-invocation delivery choice: the default `true` returns a run ID and later delivers the result, while `false` waits inline. Delegated child execution uses pi-subagents' foreground delegation bridge inside that workflow run; it does not create a second background-run authority.

The background contract is therefore supported at the workflow layer, not forwarded as a child setting. The owning `WorkflowManager` retains the run, abort controller, journal, timeout policy, and result delivery while pi-subagents owns each correlated child until its terminal response. `/workflows stop <runId>` and `workflow_control stop` cancel the owning workflow, which propagates one correlated cancellation to every active delegated child.

Observe the workflow through `/workflows`, `workflow_control status`, or the normal task panel. Delegated updates can supply bounded progress, resolved model, aggregate token total, session file, and output path. Missing token splits or cost remain unknown; the bridge does not invent them.

### Role and model precedence

- Native calls use pi-dynamic-workflows' normal priority: explicit `model` > local `agentType` model > `tier` > phase model > metadata model > implicit `medium` > session default.
- Delegated calls pass `agentType` unchanged as the pi-subagents role. pi-dynamic-workflows does not also resolve its local agent registry for that role.
- Delegated model precedence is explicit `model` > resolved `tier` > phase model > metadata model > pi-subagents role/default model. Any resolved workflow route is forwarded and overrides the delegated role's configured model. Only a call with none of those workflow routes leaves the model unset for pi-subagents to choose.
- An unsupported requested model field is rejected during provider negotiation. It does not silently use another selector or backend.

## Supported and unsupported behavior

Supported: foreground v1 delegation within either a foreground or background workflow run; analysis/research/review/report roles (`analyst`, `researcher`, `reviewer`, `reporter`); exact request correlation; concurrent requests; cancellation and timeout propagation; extension reload while the same-process runtime is handed off; workflow resume with delegated calls rerun live; bounded progress/history; aggregate token totals when reported; role forwarding; explicit model routing; terminal diagnostics.

Unsupported: mutation/implementation roles; JSON Schema results; workflow shared-store child tools; workflow custom toolsets; delegated worktree isolation; automatic backend selection; backend fallback; a public released provider compatibility range; a second provider registry or EventBus discovery protocol; delegated token split/cost accounting when the provider does not report it; a second lifecycle authority.

The public provider descriptor does not expose a tool allowlist, a read-only guarantee, a durable effect identity, or worktree ownership. The role allowlist therefore limits the advertised use but is not a security boundary: configure those provider roles without mutation tools. Any call without an allowed role, any writer-style role, and every `backend: "pi-subagents"` + `isolation: "worktree"` combination fails before an agent slot or worktree is reserved. Native pi-dynamic-workflows is the sole worktree owner.

Resume hashes bind native execution policy and, for delegated calls, the reviewed `v1@b77781ea926203b32af8fad439432e5cef2aae5f` protocol contract. Because the provider's effective role/tool contract and filesystem effects are not available to bind, delegated calls always rerun live on workflow resume. Worktree-isolated native calls also rerun live: cached assistant text is never replayed as proof that a removed worktree's filesystem effects still exist.

## Expected failures and recovery

| Symptom | Meaning | Recovery |
| --- | --- | --- |
| `provider discovery is unavailable` | Wrong/stock pi-subagents, one extension is not active, or the extensions are not in the same Pi process | Check `pi list`, reinstall the exact pinned source, then `/reload` |
| Provider identity/package/version/protocol drift | The active bridge is not the reviewed contract | Restore the pinned commit; do not bypass the check |
| `did not acknowledge` | Discovery passed, but no bridge accepted the correlated request in time | Check extension load errors and reload once; retry only after the bridge is healthy |
| Requested model routing is unsupported | The provider descriptor cannot carry the selected explicit, tier, phase, or metadata model | Remove every applicable workflow model route to use the delegated role model, or restore the reviewed provider |
| `invalid_request`, unknown status, malformed/oversized output | Contract drift or invalid bridge data | Preserve the error, stop delegated use, and restore/review the provider pair |
| `timed_out`, `cancelled`, `interrupted`, budget/acceptance failure | The delegated lifecycle ended without a completed result | Fix the named limit or task, then rerun; the runtime does not switch to native automatically |

To recover immediately without delegation, edit the workflow to omit `backend` (or set `backend: "native"`) and rerun it deliberately. This is an operator choice, not runtime fallback.

## Provider-free lifecycle smoke

Run the committed same-process bridge harness; it does not contact a model provider:

```bash
node --import tsx --test tests/pi-subagents-lifecycle.test.ts
```

The harness exercises inline foreground settlement, default background ownership with immediate parent continuation, parallel delegated nodes, workflow-control abort propagation, timeout, provider failure without fallback, extension reload, and resume that reruns delegated calls live. It uses the exact pinned fork's real provider registration/parser with deterministic local executors. A passing harness proves adapter and workflow lifecycle semantics only; it is not evidence that a live model, credentials, or external side effect works.

## Architecture ownership and trust

pi-dynamic-workflows owns workflow topology, limits, journaling/resume, progress aggregation, and the final workflow result. pi-subagents owns delegated roles, child execution, child tools/model defaults, acceptance, and its child lifecycle. The adapter translates one bounded request/response lifecycle; it is not another orchestrator or lifecycle authority.

The shared Pi EventBus is a same-process trusted integration boundary, not a security boundary. Provider descriptors, `started` events, progress, terminal responses, diagnostics, session paths, and output paths are bridge reports. They are not authentication, authorization, user approval, or evidence that an external action was permitted. The protocol defines no bus secret and must not be described as one. Keep untrusted extensions out of the same Pi process and apply approval policy at the actual tool/action boundary.