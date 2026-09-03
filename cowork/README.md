# Sabia Cowork OTel helper

Claude Cowork exports OpenTelemetry events only when a Claude organization
admin configures an OTLP endpoint under **Admin settings > Cowork**. There is
no per-device exporter to configure, so this helper does two things:

1. runs Sabia's browser connect handoff for a `cowork` connection and receives
   the ingestion key;
2. prints the three values the admin pastes into Claude's Cowork settings.

```text
node plugins/sabia-cowork-otel/scripts/sabia.mjs connect                 # token activity only
node plugins/sabia-cowork-otel/scripts/sabia.mjs connect --tool-details  # + Google Drive Output capture
node plugins/sabia-cowork-otel/scripts/sabia.mjs settings                # print the admin values again
node plugins/sabia-cowork-otel/scripts/sabia.mjs status
node plugins/sabia-cowork-otel/scripts/sabia.mjs disconnect
```

Settings are loaded at Cowork session start, so a new session is needed after
the admin saves them. `--tool-details` requests Sabia's reduced tool-detail
grant; what that retains, and what Cowork's own `otlpContentCapture` setting
has to include for arguments to arrive at all, is in
[`docs/cowork-otel-connector.md`](../../docs/cowork-otel-connector.md).

The state file (`~/.claude/sabia-cowork-otel-state.json`, mode `0600`) holds
the ingestion key because `settings`, `status`, and `disconnect` need it. Never
paste it anywhere but the Cowork admin headers field.
