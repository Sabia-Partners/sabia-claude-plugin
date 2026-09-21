# Sabia Cowork OTel helper

Claude Cowork exports OpenTelemetry events only when a Claude organization
admin configures an OTLP endpoint under **Admin settings > Cowork**. There is
no per-device exporter to configure, so this helper does two things:

1. runs Sabia's browser connect handoff for a `cowork` connection and receives
   the ingestion key;
2. prints the three values the admin pastes into Claude's Cowork settings.

```text
node cowork/scripts/sabia.mjs connect                 # token activity only
node cowork/scripts/sabia.mjs connect --tool-details  # + reduced tool evidence
node cowork/scripts/sabia.mjs settings                # print the admin values again
node cowork/scripts/sabia.mjs status
node cowork/scripts/sabia.mjs disconnect
```

Settings are loaded at Cowork session start, so a new session is needed after
the admin saves them. `--tool-details` requests Sabia's reduced tool-detail
grant; what that retains, and what Cowork's own `otlpContentCapture` setting
has to include for arguments to arrive at all, is in
[`docs/cowork-otel-connector.md`](https://github.com/Sabia-Partners/dashboard-langfuse/blob/main/docs/cowork-otel-connector.md).

The state file (`~/.claude/sabia-cowork-otel-state.json`, mode `0600`) holds
the ingestion key because `settings`, `status`, and `disconnect` need it. Never
paste it anywhere but the Cowork admin headers field.

## Explicit Workspace Outputs

Cowork telemetry does not currently provide sufficient result evidence for
reliable automatic creation detection. Report a confirmed operation explicitly:

```text
node cowork/scripts/sabia.mjs record-output --workflow-run-id <session.id> --kind document_create --external-id <drive-file-id>
```

Supported action kinds are `document_create`, `document_edit`,
`document_comment`, `spreadsheet_create`, `spreadsheet_edit`,
`spreadsheet_add_sheet`, `spreadsheet_comment`, `presentation_create`,
`presentation_edit`, and `presentation_add_slide`. Comment actions use the returned parent-qualified
`--external-id <drive-file-id>/comments/<comment-id>` (or `/replies/<reply-id>`).
The helper preserves the workflow session identity and requires the existing
Output capture grant. Generic document/spreadsheet/presentation claims are
rejected; only report the specific operation after its success is confirmed.
