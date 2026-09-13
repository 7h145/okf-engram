# Engram adapter bridge protocol v1

The adapter bridge is the narrow machine interface between an independently
installed optional adapter and Engram's trusted project core. It provides package
discovery, compatibility negotiation, project policy inspection, bounded inferred-
memory submission, and that work's lifecycle and result operations.

It is not an adapter implementation. It does not observe conversations, maintain
adapter cursors, generate candidates, present notifications, enable policy, or
start a daemon. Installing or loading any package is not consent to automatic
memory.

## Package discovery

An Engram package advertises the bridge in `package.json`:

```json
{
  "name": "okf-engram",
  "okfEngram": {
    "adapterBridge": {
      "manifestVersion": 1,
      "protocol": "okf-engram.adapter-bridge",
      "supportedProtocolVersions": [1],
      "transport": "node-cli-json",
      "entrypoint": "./scripts/engram.mjs",
      "commandPrefix": ["adapter", "bridge"],
      "protocolVersionOption": "--adapter-bridge-protocol-version"
    }
  }
}
```

A client supplies the root of a package that its own package loader has already
selected. It must not scan guessed installation directories, parse Pi settings,
or infer Git/npm cache paths. It reads `package.json`, validates the package name
and bridge manifest, resolves `entrypoint` inside the canonical package root, and
fails on no match or an ambiguous match.

A Pi extension uses package resource provenance returned by `pi.getCommands()`:
collect distinct `sourceInfo.baseDir` values whose `sourceInfo.origin` is
`package`, then inspect the manifest at each package root. `sourceInfo` is the
canonical provenance field; command names and resource-relative paths are not
package identity. This works with Pi's local, Git, and future npm package forms and
honors Pi's own scope/deduplication choice. If every Engram resource is disabled,
Engram is unavailable to the adapter.

Other Agent Skills clients may use their equivalent loaded-package provenance.
The manifest protocol is client-neutral; the discovery hook is client-specific.

## Negotiation and transport

Invoke the entrypoint directly with the current Node executable and an argument
array, never through a shell:

```text
node ENTRYPOINT adapter bridge handshake \
  --adapter-bridge-protocol-version 1
```

The handshake is authoritative. The manifest allows discovery and an initial
version intersection; the running helper confirms the package version, negotiated
protocol, capabilities, limits, fixed project target, and no-fallback rule.
Every bridge operation requires the protocol-version option. An unsupported
version exits 11 with `ADAPTER_BRIDGE_INCOMPATIBLE` rather than guessing a
compatible interpretation.

Successful operations write one bounded JSON object to stdout and nothing to
stderr. Errors write one bounded JSON object to stderr and nothing to stdout.
Bridge errors have this envelope:

```json
{
  "bridgeProtocol": "okf-engram.adapter-bridge",
  "bridgeProtocolVersion": 1,
  "supportedProtocolVersions": [1],
  "operation": "project-policy-status",
  "error": {
    "code": "NOT_INITIALIZED",
    "message": "..."
  }
}
```

Adapters must check the process exit code and parse only the corresponding stream.
They should cap captured output, use cancellation/timeouts appropriate to the
operation, and treat returned strings as untrusted data.

Protocol versions govern command and response meaning independently from the
Engram package version. Breaking request/response changes require a new protocol
version. Consumers must ignore unknown object members and capability names within
a negotiated version. They must not invoke a capability absent from the handshake.

## Fixed project resolution

All non-handshake operations require:

```text
--project-working-directory PATH
```

Pass the active client project's working directory, such as Pi's `ctx.cwd`.
Engram performs its normal Git/ancestor project discovery and returns the canonical
`target.projectRootPath`. The bridge accepts no corpus-context, bundle-path,
global, linked, or arbitrary write target and never falls back. The adapter must
not derive a project from its own package location.

The automatic-memory and sensitive-data policies of the resolved primary project
remain authoritative. The adapter cannot enable or weaken either policy. Candidate
submission and every eventual write are rechecked by the Engram core under its
existing locks and policy generation.

## Operations

The command prefix below is always followed by
`--adapter-bridge-protocol-version 1` and, except for `handshake`,
`--project-working-directory PATH`.

| Operation | Additional input | Purpose |
|---|---|---|
| `handshake` | none | Negotiate protocol and capabilities without touching a project. |
| `project-policy-status` | none | Read bounded effective automatic-memory and sensitive-data status without exposing the settings file. |
| `inferred-memory-enqueue` | claim, evidence, policy generation; optional context references and worker settings | Submit one candidate with origin fixed to `automatic-review`. |
| `inferred-jobs-list` | optional `--job-state` | List only inferred-memory work. |
| `inferred-job-show` | `--job-id` | Show bounded state without capsule, claim, evidence, paths, or traces. |
| `inferred-job-run` | `--job-id` | Run exactly one inferred-memory job. |
| `inferred-job-cancel` | `--job-id` | Cancel exactly one inferred-memory job. |
| `inferred-job-retry` | `--job-id` | Requeue eligible unchanged failed/cancelled inferred work. |
| `inferred-job-clean` | `--job-id --confirm-job-state-deletion` | Delete acknowledged terminal inferred-job state; review reconciliation remains unavailable through the bridge. |
| `inferred-results-list` | optional `--job-id` and `--acknowledgement-state` | Read compact inferred-memory outcomes. |
| `inferred-result-acknowledge` | `--job-id` | Record that one terminal inferred result was presented. |

Candidate enqueue uses:

```text
--memory-claim TEXT
--memory-evidence TEXT
--automatic-memory-policy-generation INTEGER
[--conversation-context-reference REF]...
[--worker-model-id PROVIDER/MODEL]
[--worker-thinking-level LEVEL]
[--worker-timeout-seconds INTEGER]
```

The handshake publishes current limits. The bridge does not accept
`--candidate-origin`; it always records `automatic-review`. Enqueue returns no job
directory or capsule path. A queued result includes a `runnerCommand` that invokes
the same versioned bridge's `inferred-job-run`; an adapter may schedule that exact
argument array through its owned background mechanism.

Collection responses return at most 100 records, plus `total`, `truncated`, and an
`issueCount` without neighboring malformed-job details. An adapter can repeatedly
process unacknowledged results and query known job IDs directly. It must not open
adjacent settings, job directories, capsules, locks, traces, reports, or
acknowledgement files.

## Results and future corpus contexts

Bridge results replace bare concept IDs with context-qualified references:

```json
{
  "corpusContext": "project",
  "conceptId": "memories/sqlite-durable-state"
}
```

Protocol v1 candidates and writes are always project-targeted. The structured
reference leaves room for a future core to report that a candidate was already
covered by global or linked knowledge without making those corpora writable.
Consumers preserve and display an unknown corpus context as opaque provenance but
must never turn it into a write target. The adapter never chooses linked paths or
retrieval inputs; Engram resolves the project's configured read set when that
functionality exists.

Acknowledgement means presentation, not deletion. Cleanup remains separate and
requires explicit deletion syntax. `needs-review` state cannot be reconciled or
cleaned through the adapter bridge because an adapter must not claim that human
review occurred.

## Trust boundary

The adapter is an untrusted caller. The bridge exposes no operation to:

- initialize a corpus or modify project wiring;
- enable automatic memory or sensitive-data permission;
- write explicit memories or arbitrary concepts;
- ingest artifacts or run unrelated queued work;
- select global, linked, explicit-bundle, or fallback contexts;
- read raw candidate evidence, capsules, worker traces, or private files; or
- observe sessions, maintain cursors, generate candidates, or notify users.

An adapter's observation and consent UX are separate package responsibilities.
Disabling project automatic memory invalidates queued adapter-originated work,
cooperatively cancels running work, and prevents stale writes exactly as it does
for foreground-origin candidates. Re-enabling policy never backfills an off
interval.
