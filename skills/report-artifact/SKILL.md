---
name: report-artifact
description: Report metadata about work Claude Code has successfully created, materially updated, sent, published or delivered to Sabia through its authenticated hosted MCP tools. Use after a qualifying completed operation when Sabia artifact reporting is connected.
---

# Report completed work to Sabia

Use the connected `report_artifact` tool after the producing operation has
succeeded. The plugin bundles the server as `sabia-artifacts`, so Claude Code
lists its tools under the scoped names
`mcp__plugin_sabia-claude-code-otel_sabia-artifacts__report_artifact`,
`…__get_artifact_report`, `…__get_reporting_context` and
`…__begin_reporting_session`. This skill works through those hosted tools only:
no shell, no Node process, no credential file, and nothing in the native OTel
configuration that `connect-sabia` manages. Native usage collection continues
independently through that skill and is never a substitute for a report.

If the tools are missing or answer with an authorization error, the user has
not connected artifact reporting yet: tell them to run `/mcp`, choose
`plugin:sabia-claude-code-otel:sabia-artifacts`, sign in to Sabia and approve
metadata sharing for their organization. Do not attempt the report another way.

## Qualifying operations

Report one event for each distinct successful act on a distinct target.
Coalesce the intermediate writes of one coherent edit. A create that also
returns a download is one event; a later, separately requested delivery is
another. A material update changes content, findings, formulas, data,
functionality or requested presentation structure.

In Claude Code the producing operation is usually a tool result you can read:

- `gh pr create` or `gh issue create` printed the new URL: `create` on
  `github`, with the actual `owner/repository#number`. A pull request review or
  comment that printed its URL is an `update` on that pull request. A `gh`
  call that exited 0 but printed nothing identifiable is not reportable.
- A commit pushed to a remote is `publish` on `github` only once the push
  succeeded and the commit SHA is known; a local commit is not.
- A Google Doc, Sheet or Slides file created or revised through a connected
  Drive tool: `create` or `update` on `google_drive`, one Artifact ID across
  both. Use the file ID from the tool result, never from the title.
- A message a connected Slack tool sent: `send` on `slack`, only after the
  provider accepted it. A draft or a preview is not a send.
- A site or page a deploy tool published: `publish` on `web`, only after the
  publication succeeded, never while the deployment is pending.
- A generated PDF, image, archive or other file the user asked to receive:
  `deliver` as `file`, using the actual host reference, availability
  `host_local`.

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

Use schema version 2 exactly as the tool's input schema describes it. Mint a
stable `event_id` once the operation has succeeded and keep it with the report;
reuse it and the identical request for every retry. `source_application` is
`claude_code`. The Artifact's source system (`github`, `google_drive`, `slack`,
`host`, `web`) is where the object lives, not the application that produced it.
The service fixes the authenticated organization, reporter and collection
method `skill_tool`; do not send credentials or identifiers for them.

Use actual provider identities from the successful operation. Do not infer an
identity from a title or manufacture a URL. For GitHub, `account_id` is the
owner, `workspace_id` the repository, and `external_id` the number or full
`owner/repository#number`; a contradictory URL, repository or number is
rejected. For Google Drive, `account_id` is the authorized Google connection
and `external_id` the Drive file ID. If scope cannot be established, leave the
Artifact null rather than guessing: an unassociated Output is still a record of
the delivery.

For host files, take the authenticated `artifact_account_id` from
`get_reporting_context` and use the actual host file or download identity.
Keep paths non-public and availability `host_local` or `temporary`. Do not
fetch a host path remotely or claim permanent storage.

Use only allowlisted receipt references in `evidence`. Never include file
content, transcripts, prompt or response text, credentials, tokens or complete
tool payloads. Use a short nullable title. Secret-bearing URLs must not be
sent; if an exact safe reference is unavailable, leave the reference null —
the Artifact identity can still be supplied without one. For unsupported
reference schemes, keep the Artifact null rather than coercing the type.

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
