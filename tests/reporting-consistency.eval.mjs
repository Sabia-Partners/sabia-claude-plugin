// Test-only checker for authored coordination traces. It does not implement
// reporting, execute a model, prove skill activation or attest provenance.
import assert from 'node:assert/strict';

export function assertConsistency(events) {
  const records = new Map(), owners = new Set(), ids = new Set();
  let last;
  for (const event of events) {
    if (last?.type === 'produce') assert.equal(event.type, 'retain', 'Retain before another operation or handoff');
    if (event.type === 'plan' || event.type === 'delegate') {
      assert(event.owner && event.reporting === true, 'Planning/delegation must assign reporting ownership');
      owners.add(event.owner);
    } else if (event.type === 'produce') {
      assert(owners.has(event.owner), 'Producing agent must own reporting');
      assert(!records.has(event.key), 'Do not repeat production to recover reporting');
      records.set(event.key, { operation: event });
    } else {
      const record = records.get(event.key);
      if (event.type === 'finish') {
        for (const entry of records.values()) assert(entry.retained && (entry.receipt || entry.blocker), 'Every occurrence needs a receipt or explicit blocker');
      } else {
        assert(record, 'Retain actual successful production before reporting');
        const operation = record.operation;
        if (event.type === 'retain') {
          assert.equal(last, operation, 'Retain immediately after the successful producing operation');
          assert.deepEqual(event.producer, { owner: operation.owner, host: operation.host, account: operation.account,
            action: operation.action, target: operation.target, evidence: operation.evidence }, 'Preserve real producing facts, including unknowns');
          assert(event.eventId && !ids.has(event.eventId), 'Distinct occurrences need distinct stable event IDs');
          ids.add(event.eventId); record.retained = event;
        } else if (event.type === 'attempt') {
          assert(!record.receipt, 'Never submit a new report for accepted work');
          assert.equal(event.owner, operation.owner, 'Do not silently take over delegated reporting');
          assert(operation.host && operation.evidence, 'Missing producer/evidence blocks submission');
          assert(event.route, 'Missing tools/route blocks submission');
          assert.equal(event.request.source_application, operation.host, 'Never relabel a producer');
          assert.equal(event.request.event_id, record.retained.eventId);
          assert.equal(event.request.action, operation.action);
          assert.equal(event.request.artifact.url, operation.target);
          assert.equal(event.request.evidence.revision_id, operation.evidence);
          if (event.request.artifact.scope_ref) assert(operation.account, 'Unknown account cannot select a scope');
          if (record.attempt) {
            assert(record.notFound, 'Lookup before retrying an uncertain report');
            assert.deepEqual(event.request, record.attempt.request, 'Exact replay preserves payload and summary omission');
            assert.equal(event.route, record.attempt.route, 'Recovery retains the same route');
          }
          record.attempt = structuredClone(event); record.notFound = false;
        } else if (event.type === 'receipt' || event.type === 'lookup') {
          assert(record.attempt, 'An attempted report must precede receipt recovery');
          assert.equal(event.eventId, record.retained.eventId);
          assert.equal(event.route, record.attempt.route);
          if (event.receipt) {
            assert(event.receipt.output_id && event.receipt.report_id, 'Acceptance needs an actual returned receipt');
            if (record.receipt) assert.deepEqual(event.receipt, record.receipt, 'Sync recovers the same Output');
            record.receipt = event.receipt;
          } else {
            assert.equal(event.type, 'lookup', 'An attempt alone is not a receipt');
            record.notFound = true;
          }
        } else if (event.type === 'block') {
          assert(typeof event.reason === 'string' && event.reason.trim(), 'Explain the reporting blocker');
          assert(!record.receipt, 'Accepted work is already reconciled');
          record.blocker = event.reason;
        } else assert.fail(`Unknown trace event: ${event.type}`);
      }
    }
    last = event;
  }
  assert.equal(last?.type, 'finish', 'Require final reconciliation');
  return { occurrences: records.size, accepted: [...records.values()].filter(r => r.receipt).length,
    blocked: [...records.values()].filter(r => r.blocker && !r.receipt).length };
}
