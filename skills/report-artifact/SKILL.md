---
name: report-artifact
description: Report metadata about work Claude Code has successfully created, materially updated, sent, published or delivered to Sabia through its authenticated hosted MCP tools. Use after a qualifying completed operation when Sabia Output Reporting is connected.
---

# Report completed work to Sabia

Output Reporting records completed actions on durable work, such as documents,
pull requests and presentations. Creating a document and later materially editing
it produces two Outputs linked to one Artifact. A generated response or trace
alone does not qualify.

Use the connected `get_reporting_contract` and `report_artifact_v3` tools after
the producing operation has succeeded. The plugin bundles the server as
`sabia-artifacts`, so Claude Code lists its tools under the scoped names
`mcp__plugin_sabia_sabia-artifacts__report_artifact_v3`,
`…__get_reporting_contract`, `…__get_artifact_report`,
`…__get_reporting_context` and `…__begin_reporting_session`. Do not use
`report_artifact`: Sabia accepts new reports only through
`report_artifact_v3`. This skill works through those hosted tools only:
no shell, no Node process, no credential file, and nothing in the native OTel
configuration that `connect-sabia` manages. Native usage collection continues
independently through that skill and is never a substitute for a report.

If the tools are missing or answer with an authorization error, the user has
not connected Output Reporting yet: tell them to run `/mcp`, choose
`plugin:sabia:sabia-artifacts`, sign in to Sabia and approve
metadata sharing for their organization. Do not attempt the report another way.

## Qualifying operations

Report one event for each distinct successful act on a distinct target.
Coalesce the intermediate writes of one coherent edit. A create that also
returns a download is one event; a later, separately requested delivery is
another. A material update changes content, findings, formulas, data,
functionality or requested presentation structure.

In Claude Code the producing operation is usually a tool result you can read:

- `gh pr create` or `gh issue create` printed the new URL: `create` on
  `github`. A pull request review that printed its URL is `review` on that pull
  request, and a comment is `comment`; a material change to the pull request or
  issue itself is `update`. A `gh` call that exited 0 but printed nothing
  identifiable is not reportable.
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

Slack messages, web publications and email cannot be reported yet; do not ask
the contract about them.

Do not report reads, searches, plans, promises, failed or cancelled writes,
ordinary answers with no identifiable deliverable, no-op saves or autosaves.
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
  describes. Where this skill and the contract differ, the contract wins.
- `incompatible`: ask for the contract once more, then report.
- `unsupported`, `not_selected` or `disabled`: stop. Tell the user in one
  sentence and do not report another way.

Mint a stable `event_id` once the operation has succeeded and keep it with the
report; reuse it and the identical request for every retry.
`source_application` is `claude_code`. The Artifact's source system (`github`,
`google_drive`, `linear`, `host`) is where the object lives, not the
application that produced it. The service fixes the authenticated organization,
reporter and collection method `skill_tool`; do not send credentials or
identifiers for them.

Use actual identities from the successful operation. Never infer one from a
title or manufacture a URL, ID or scope:

- GitHub: the object's URL, or `owner`, `repository` and `number` (for a
  commit, `owner`, `repository` and the full `commit_sha`).
- Google Drive: the contract's exact `scope_ref` plus the `file_id` or URL from
  the tool result.
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
and direct the user to reconnect through `/mcp`.

Allow at most one immediate retry within a six-second budget. Honour
`Retry-After`; defer long waits. Report an unresolved delivery in one sentence,
then finish the user's original task — a reporting failure never means the
original work failed, and the work must not be redone to obtain a report.
