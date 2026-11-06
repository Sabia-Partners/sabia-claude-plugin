# Reporting consistency validation

The reporting skill now applies during planning as well as after completed work.
Once activated, the producing agent owns the reporting checkpoint, retains actual
mutation metadata immediately in the current task, and reconciles each completed
occurrence to an accepted/recovered receipt or a clear blocker before finishing.
The instructions add no hooks, permissions, background retry or disk spool.
Installation and skill descriptions do not guarantee implicit host invocation.

## Automated evidence

`tests/reporting-consistency.test.*` checks authored synthetic coordination traces
using `tests/reporting-consistency.eval.mjs`, plus static assertions against the
shipped skill. It covers ordinary requests with no reporting keyword, explicit
worker ownership, multiple targets, immediate evidence retention, unknown accounts,
missing evidence/tools, receipt uncertainty, repeated Sync and exact replay after
not-found. Negative traces reject omitted outcomes, silent coordinator takeover,
changed producer facts, replacement event IDs, route changes and changed payloads.
The checker is test-only; it does not run in the plugin or establish provenance.

These checks do **not** execute a model or demonstrate automatic skill selection,
live provider mutations, OAuth consent, live Sabia acceptance, native association,
or recovery after loss of task context. Existing contract/transport tests remain
separate evidence for their own boundaries. Do not describe authored trace passes
as live activation or a production reporting success.

## Host verification still required

Run these ordinary requests in an authorized supported host with the candidate
installed, retaining the observed tool calls and original receipts:

| Request or condition | Required observed outcome |
| --- | --- |
| Create a real authorized durable target, without mentioning reporting | Skill applies, successful mutation evidence is retained, current contract is discovered, one receipt or an explicit blocker is returned |
| Create two targets | Each successful target has its own original event ID and receipt/blocker |
| Delegate one authorized operation | Instructions name the reporting owner; worker returns actual producer metadata and receipt/blocker; coordinator does not report it twice |
| Reporting tools unavailable | User work completes; reporting limitation is explicit; no substitute route or fabricated evidence |
| Successful result lacks allowed mutation evidence | Record the missing evidence and stop submission, including null-Artifact fallback |
| Drop a reporting response, then Sync twice | Original ID/route/request are retained; lookup resolves the same Output or bounded uncertainty is explicit; no repeat production |
| Read-only, unchanged or failed operation | No new ordinary Output |

Respect each edition's supported hosts and current discovery/consent. Unsupported
delegated hosts remain blocked. Use only minimal safe metadata already available
from the operation; never collect credentials, transcripts, tool bodies or extra
content for a test. Unknown account/session/native coordinates remain unknown.
Report a failure to invoke the skill as an activation failure, not as a successful
blocked reporting attempt. A claim of live acceptance requires its actual receipt.
