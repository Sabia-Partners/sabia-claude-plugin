# Artifact report contract 2.1.0-beta.1

The schema and conformance fixtures are metadata-only. IDs in examples are synthetic.
`manifest.json` pins the schema's SHA-256. The backend pins these assets as test
fixtures; neither package imports the other repository at runtime.
The manifest's `backend_migration` identifies the schema migration
(`20260916220422`). Exact native usage association additionally requires the
separate runtime migration `20260916225235`, as documented in the release README.

Canonical request hash: UTF-8 SHA-256 of recursively key-sorted compact JSON.
Object keys use lexical ordering (all schema keys are ASCII); array order,
string bytes and explicit nulls remain significant. No Unicode normalization,
trimming, timestamps inferred from receipt time or omitted-field defaults are
applied. The accepted JSON is stored alongside the hash and compared on replay.
Scope is Organization + stable authenticated reporter + event ID. Credentials and
late relationship associations are not part of that identity. Request changes
require explicit conflict resolution, never a newly minted retry ID.

Additional semantic validation: an event ID is at most 128 UTF-8 bytes, the serialized
request at most 8 KiB, application must be allowed by the granted connection, and
host-file scope must match the authenticated reporter's installation scope.
Provider URLs must use an allowlisted exact HTTPS host, no port/credentials/query/
fragment, and the Google file ID must match the supplied identity. Host references
remain opaque and non-fetchable. Unknown fields are rejected at every schema level.
Do not submit secret-bearing URLs. Every reported usage field must be null.
Usage references may be null or an opaque version-1 value issued by the native
bridge; agents must never construct one from session IDs or prompt text.

First acceptance uses HTTP 201; replay uses 200. `get_artifact_report` resolves the
original event after a lost response. Typical receipt:

```json
{
  "report_id": "synthetic-report-1",
  "output_id": "synthetic-output-1",
  "artifact_id": "synthetic-artifact-1",
  "receipt_status": "accepted",
  "received_at": "2026-09-12T20:00:00Z",
  "artifact_verification": "pending",
  "occurrence_verification": "reported",
  "association_status": "unassociated",
  "usage_status": "unavailable"
}
```

An update has another event/report/Output ID and the same Artifact ID. Drive object
verification can change `artifact_verification` to `verified` while occurrence
verification stays `reported`. A Drive metadata read never proves an update.

| Error | HTTP | Recovery |
| --- | --- | --- |
| INVALID_REPORT / UNTRUSTED_USAGE | 400 | Correct a rejected request; do not recreate the work. |
| UNAUTHORIZED | 401 | Reconnect; no automatic loop. |
| FORBIDDEN / DISALLOWED_SOURCE / INVALID_CONTEXT / INVALID_USAGE_REFERENCE | 403 | Resolve grant, source or exact context. |
| EVENT_CONFLICT | 409 | Preserve original event and receipt. |
| PAYLOAD_TOO_LARGE / UNSUPPORTED_VERSION | 413 | Reduce metadata or upgrade. |
| RATE_LIMITED | 429 | Honor Retry-After; defer long waits. |
| REPORTING_UNAVAILABLE | 503 | Retry the same event within the bounded budget. |

MCP failures use `isError: true` with the error code; they are never success-shaped
receipts. OAuth failures use HTTP bearer challenges with protected-resource metadata.
Default client budget: at most one immediate retry, 2.5 seconds per request and
6 seconds overall where the host offers cancellation/timeout controls. Native
ChatGPT tool dispatch may not expose such controls; no hard latency guarantee or
local spool is claimed.

Version 2.1 permits `usage_reference: null | { version: 1, token }`. Every reported usage field remains null. References are server-issued, Organization/reporter/device scoped and validated against exact native evidence. Receipt retries never issue a new proof.
