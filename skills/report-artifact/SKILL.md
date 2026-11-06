---
name: report-artifact
description: Use when planning or completing durable work in any system from Claude Code with Sabia Output Reporting connected, even without an explicit reporting request. Retain real producing evidence immediately and reconcile every successful operation to a receipt or explicit blocker.
---

# Report completed work to Sabia

Output Reporting records completed actions on durable work, such as documents,
pull requests and presentations. Creating a document and later materially editing
it produces two Outputs linked to one Artifact. A generated response or trace
alone does not qualify.

## Plan, retain and reconcile reporting

Apply this skill while planning a task that may produce durable work, even when
an ordinary request mentions only creating or changing that work. Add a reporting
checkpoint to the task plan (or keep it in working context for a short task).
The agent performing the successful producing operation owns reporting by default;
do not wait for the user to say “report” or “Sync Sabia”. Planning creates no
Output, discovers no grant and authorizes no producing operation. When activated,
carry out these checkpoints for every qualifying operation. Skill selection is
host-dependent; these instructions do not guarantee implicit activation.

Immediately after each successful qualifying operation, before another operation,
compaction or delegation handoff can lose its result, retain a minimal occurrence
record in the current authorized task context:

- The reporting owner and actual producing host/application, established from the
  host; the verified reporting route when known, otherwise an explicit unknown.
- The successful action, Source/type and target identity actually returned, and
  the exact producing account when established. Unknown accounts remain unknown;
  a single available scope, model name or coordinator identity proves no account.
- The real allowed provider event, revision or producing tool-call reference,
  and the observed success. Preserve these fields from the mutation result now;
  a later object read cannot recover proof of the original action.
- One stable `event_id` once the successful occurrence qualifies, its reporting
  state, and, before submission, the exact finalized request. Immediately retain
  the returned receipt or the failure/uncertainty and bounded recovery state.

Keep only necessary metadata in task context, not full tool payloads, bodies,
transcripts, credentials, receipt proofs or a new disk spool. Keep summary prose
only in the authorized exact request, never a producer cache or diagnostic log.
Missing identity/scope follows the discovered null-Artifact rules; missing allowed
successful action evidence blocks submission even with `artifact: null`.

When delegating, explicitly include reporting ownership in the work instructions.
The producing agent should apply this skill on its actual supported host and
return the minimal occurrence record with its original event ID, reporting route,
exact submitted request if attempted, and receipt or explicit blocker. A
coordinator verifies each delegated outcome before finishing; it must not assume
that a worker reported, repeat its mutation, relabel its host/account, infer a
session, or submit a second report for the same occurrence. Transfer ownership
explicitly only when the recipient can use the same authorized producing route
and retained evidence; an uncertain attempt keeps its original request and ID.
An unsupported delegated host remains a blocker; coordination supplies no grant.

Before the final response, reconcile every successful qualifying occurrence,
including each target in a multi-output task and each delegated result, to either
a returned accepted/recovered receipt or an explicit reporting blocker. Distinct
acts/targets retain separate event IDs; intermediate writes in one coherent edit
remain coalesced. An attempt alone is not acceptance. State missing tools,
unsupported host, missing evidence, denied consent or uncertain receipt briefly
and accurately; pending or deferred recovery is still unresolved. Continue the
user's completed work without claiming it was reported. Never create another
Output to repair reporting, and never recursively report this reconciliation.

Use the connected `get_reporting_contract` and `report_artifact_v3` tools after
the producing operation has succeeded. They reach Claude Code from one of two
places, and either works:

- the server this plugin bundles as `sabia-artifacts`, whose tools are
  `mcp__plugin_sabia_sabia-artifacts__report_artifact_v3`,
  `…__get_reporting_contract`, `…__get_artifact_report`,
  `…__get_reporting_context` and `…__begin_reporting_session`;
- the Sabia connector added in Claude, with the same tool names under the
  connector's name, such as `mcp__claude_ai_Sabia__report_artifact_v3` on a
  computer or `mcp__Sabia__report_artifact_v3` in a cloud session.

Use whichever is connected, and the same one for every call about one report.
Do not use `report_artifact`: Sabia accepts new reports only through
`report_artifact_v3`. This skill works through those hosted tools only:
no shell, no Node process, no credential file, and nothing in the native OTel
configuration that `connect-sabia` manages. Native usage collection continues
independently through that skill and is never a substitute for a report.

If the tools are missing or answer with an authorization error, the user has
not connected Output Reporting yet. On their computer, tell them to run `/mcp`,
choose `plugin:sabia:sabia-artifacts`, sign in to Sabia and approve metadata
sharing for their organization. In a cloud session (claude.ai/code,
`claude --cloud` or a routine, where `CLAUDE_CODE_REMOTE` is `true`) that
sign-in cannot finish: tell them to add and connect Sabia at
claude.ai/customize/connectors and start a new session. If the connector
answers `DISALLOWED_SOURCE` for `claude_code`, it was connected before it
covered Claude Code: tell them to disconnect Sabia there and connect it again.
Do not attempt the report another way or under another `source_application`.

## Qualifying operations

Report one event for each distinct successful act on a distinct target.
Coalesce the intermediate writes of one coherent edit. A create that also
returns a download is one event; a later, separately requested delivery is
another. A material update changes content, findings, formulas, data,
functionality or requested presentation structure.

In Claude Code the producing operation is usually a tool result you can read.
These are common names, not the whole list: the contract decides what Sabia
accepts, so ask it about any other completed work too.

- `gh pr create` or `gh issue create` printed the new URL: `create` on
  `github`. A pull request review that printed its URL is `review` on that pull
  request, and a comment is `comment`; a material change to the pull request or
  issue itself is `update`. A `gh` call that exited 0 but printed nothing
  identifiable has no identity to send: never guess one.
- A commit pushed to a remote is `publish` of a `github` `commit`, only once
  the push succeeded and the commit SHA is known; a local commit is not.
- A Google Doc, Sheet, Slides or Drive file created or revised through a
  connected Drive tool: `create` or `update` on `google_drive` (`comment`,
  `add_sheet` and `add_slide` where they apply), one Artifact across them.
- A Linear issue created, changed or commented on through a connected Linear
  tool: `create`, `update` or `comment` on `linear`.
- A document, spreadsheet, presentation or other file the user asked to
  receive, written on this computer: `create` or `update` on `host`, or
  `deliver` of a `file`.
- An email sent through a connected Gmail tool: `send` of an `email` on
  `gmail`. An Apollo contact, company, deal, task, sequence or email draft
  created or changed: `apollo`.
- An explicit creation or update in a system Sabia does not list:
  `source_system` `other`, and lowercase slugs for `artifact_type` and
  `action`, such as `release` and `publish`. A new action on a type listed
  above, such as merging a pull request, keeps that type's `source_system` and
  `artifact_type`.

Do not report reads, searches, previews, downloads, lookups, plans, promises,
failed or cancelled writes, ordinary answers with no identifiable deliverable,
no-op saves or autosaves.
Files edited inside the working tree with `Write`, `Edit` or a shell are the
work in progress, not a delivered Artifact: they become reportable when they
reach a durable target such as a pull request, a pushed commit or a delivered
file, and that later act is what gets reported. Never report Sabia's own
tools — reporting, receipt lookups, context or verification calls — and never
report a Sabia telemetry `connect`, `sync` or `status`. This skill does not
authorize producing, publishing or sending anything on its own.

## Report construction

First call `get_reporting_contract` with `source_application` `claude_code` and
the operation's `source_system`, `artifact_type` and `action`. It returns the
input schema, the identity and evidence rules, the current `contract_version`
and `configuration_revision`, the authorized `artifact_scopes`, and an example.
Act on its `status`:

- `available`: call `report_artifact_v3` with exactly what the contract
  describes. Where this skill and the contract differ, the contract wins. When
  it carries `fallback`, follow its `fallback_guidance`. For `fallback`
  `unresolved`, send `artifact` as null and an `artifact_hint` with only what
  the successful tool result returned: `system` (required for `other`),
  `object_id` and/or an `https` `url`, and `title`. Never invent an ID, URL or
  title; the title is what people see for the Output until it is linked.
- `update_pending`: Sabia is mid-update. Nothing was refused; ask for the
  contract again later in the task and report with the same `event_id`. A
  report answered `REPORTING_UPDATE_PENDING` is retried the same way.
- `unsupported`, `not_selected` or `disabled`: stop. Tell the user in one
  sentence and do not report another way, including under `other`.

If `report_artifact_v3` answers `CONFIGURATION_CHANGED` or
`CONTRACT_INCOMPATIBLE`, recover the original receipt first. Only after an
explicit not-found result, refresh the contract once and correct a provably
unaccepted request with the same `event_id`. Never change an uncertain or
accepted request.

Mint a stable `event_id` once the operation has succeeded and keep it with the
report; reuse it and the identical request for every retry.
`source_application` is `claude_code`. The Artifact's source system (such as
`github` or `host`, or `other` for one the contract does not list) is where the
object lives, not the application that produced it. The service fixes the
authenticated organization, reporter and collection method `skill_tool`; do not
send credentials or identifiers for them.

Use actual identities from the successful operation. Never infer one from a
title or manufacture a URL, ID or scope:

- GitHub: the pull request's or issue's own URL without a fragment, or
  `owner`, `repository` and `number`; never a review or comment link. For a
  commit, its URL or `owner`, `repository` and the full `commit_sha`.
- Google Drive: the contract's exact `scope_ref` bound to the account established
  by the successful operation, plus the `file_id` or URL from the tool result.
  An unknown account or a single available scope establishes no scope.
- Linear: the contract's exact `scope_ref` plus the issue `identifier` (such as
  `ENG-123`) or its URL, and `comment_id` for a comment.
- Host: the file's absolute `path` and a stable `workspace_id` for the
  workspace it lives in, such as the repository name. Keep paths non-public and
  never fetch one remotely.

If the identity or the exact scope is unresolved, including when
`artifact_scope_status` is `unavailable` or `ambiguous`, send `artifact` as
null. The report is still kept, as an unresolved Output.

In `evidence`, use basis `tool_success` (`host_delivery` for a file you
delivered on the host) and exactly one reference the producing operation
returned: a provider event ID, a revision ID such as a pushed commit SHA, or
the producing tool call's reference. A read or lookup never counts. Never
include file content, transcripts, prompt or response text, credentials,
tokens, secret-bearing URLs or complete tool payloads. Use a short nullable
title.

## Context and usage

Reuse an explicitly supplied authorized session handle. `get_reporting_context`
without a handle returns no session and never chooses a recent chat. If the
user explicitly starts a Sabia work session, call `begin_reporting_session`
once with a fresh `request_id` and retain the returned handle; reuse the same
`request_id` for a retry. A new conversation, a resumed session or a fork gets
a distinct handle unless an authorized continuation was deliberately supplied.
Never use Claude Code's own session id, the MCP connection, the last active
session, a guessed id or an all-zero value. Leave `interaction_handle` null.
Reports may remain unassociated.

Keep every `usage` value null and `usage_reference` null. Never construct a
token, native session id or invocation id. Where a trusted PostToolUse helper
is installed, it separately sends the server-issued receipt proof and the host
tool-call coordinate to Sabia over the native telemetry connection; you never
read credentials or run that helper. Exact native evidence decides the acting
usage session; ambiguous matches stay unassociated.

Sabia answers with `usage_status` (`pending`, `linked` or `unavailable`) and a
bounded reason, independently of Artifact and occurrence verification. Never
infer usage from response length, a subscription price or a guessed model.
Reporting calls author no usage, requests, generations or cost, and object
verification establishes existence, not proof of the reported action.

## Receipt recovery

Keep the returned receipt IDs. After a timeout or a lost response, call
`get_artifact_report` with the original `event_id`, or retry the identical
report. Never repeat the create, send or publish operation to recover a
receipt. A conflict means the `event_id` was reused with different data:
preserve it for explicit resolution; do not mint a new id. Correct a rejected
schema only when no report was accepted. On missing or revoked consent, stop
and direct the user to reconnect: through `/mcp` for the plugin's server, or in
Claude's connector settings for the Sabia connector.

Allow at most one immediate retry within a six-second budget. Honour
`Retry-After`; defer long waits. Report an unresolved delivery in one sentence,
then finish the user's original task — a reporting failure never means the
original work failed, and the work must not be redone to obtain a report.
