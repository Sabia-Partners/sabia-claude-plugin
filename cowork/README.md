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
grant. Tool arguments arrive only when Cowork's own `otlpContentCapture`
setting includes them; your Sabia contact can confirm what the grant retains.

The state file (`~/.claude/sabia-cowork-otel-state.json`, mode `0600`) holds
the ingestion key because `settings`, `status`, and `disconnect` need it. Never
paste it anywhere but the Cowork admin headers field.

## Pro and Max plans: the Sabia extension for Claude Desktop

Cowork's OpenTelemetry export exists only on Claude Team and Enterprise plans.
On any plan, Claude Desktop keeps a local log of every Cowork session. The
**Sabia Desktop Extension** (`desktop-extension/`, released as `sabia.mcpb`)
shares it with no terminal:

1. In Sabia, **Settings → AI Providers → Claude → Add to Claude Desktop**
   downloads `sabia.mcpb`; opening it shows Claude Desktop's install dialog.
2. After installing, a Sabia page opens in the browser; approve it.
3. Usage then syncs at start-up and every ten minutes while Claude is open.

Ask Claude "is Sabia connected?" to see the status (`sabia_status`), or run
`sabia_sync_now`. Content sharing is a toggle in the extension's settings and
still needs approval in Sabia. Build it with `pnpm build:extension`.

The same engine is available from the command line, for scripted installs:

```text
node cowork/scripts/sabia.mjs connect --local            # usage only
node cowork/scripts/sabia.mjs connect --local --content  # + prompts, responses, tool details
node cowork/scripts/sabia.mjs sync                       # send what is new (also runs every 10 min)
node cowork/scripts/sabia.mjs disconnect --local
```

`connect --local` runs the browser handoff for a key that belongs to the
person on this device, so their Cowork usage is attributed to them. It then
sends past sessions and, on macOS, installs a LaunchAgent
(`ca.sabiapartners.cowork-sync`) that runs `sync` every ten minutes. Use
`--no-schedule` to skip it; on other platforms, schedule `sync` yourself.

What is sent:

- **Always:** per turn and per model, the token totals Cowork itself records
  (input, output, cache reads, cache writes), the number of model calls, the
  time, and the Cowork session id. Tool names and success are sent without
  their arguments.
- **With `--content`, once an owner or administrator approves the grant in
  Sabia:** prompts, responses, and tool inputs and results (bounded to Cowork's
  own exporter limits). Until the grant is approved, `sync` sends usage only.

Each session log is read from where the last sync stopped
(`~/.claude/sabia-cowork-local-cursor.json`), so a sync can run any number of
times without double counting.

Caveats: the log is the desktop app's internal format, not a documented
contract, so an app update can change it; anything unrecognised is skipped
rather than guessed at. A turn is sent when it finishes. If an organization
also uses the Team/Enterprise admin export for the same account, use one or
the other, or the usage is counted twice.

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
