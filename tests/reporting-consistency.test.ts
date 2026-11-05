import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Test-only authored-trace checker.
import { assertConsistency } from './reporting-consistency.eval.mjs';

// All identities, owners, receipts and events below are authored synthetic data.
// These regressions validate the trace checker and instruction contract only.
const host = 'claude_code';
const plan = (owner = 'producer') => ({ type: 'plan', owner, reporting: true });
function occurrence(key = 'first', owner = 'producer', evidence = `fixture-revision-${key}`) {
  const operation = { type: 'produce', key, owner, host, account: null, action: 'create',
    target: `https://github.com/example/fixture/pull/${key}`, evidence };
  const { type, key: ignored, ...producer } = operation;
  return [operation, { type: 'retain', key, eventId: `fixture-event-${key}`, producer }];
}
function attempt(key = 'first', owner = 'producer') {
  return { type: 'attempt', key, owner, route: 'fixture-reporting', request: {
    event_id: `fixture-event-${key}`, source_application: host, action: 'create',
    artifact: { url: `https://github.com/example/fixture/pull/${key}` },
    evidence: { revision_id: `fixture-revision-${key}` } } };
}
const receipt = (key = 'first', type = 'receipt') => ({ type, key, eventId: `fixture-event-${key}`,
  route: 'fixture-reporting', receipt: { output_id: `fixture-output-${key}`, report_id: `fixture-report-${key}` } });
const finish = { type: 'finish' };
const rejected = events => assert.throws(() => assertConsistency(events));

describe('reporting consistency (authored traces, no host activation claims)', () => {
  it('reconciles an ordinary implicit request without a reporting keyword', () => {
    const prompt = 'Create the pull request.';
    assert.doesNotMatch(prompt, /report|sabia|sync/i);
    assert.deepEqual(assertConsistency([plan(), ...occurrence(), attempt(), receipt(), finish]), { occurrences: 1, accepted: 1, blocked: 0 });
    assert.equal(assertConsistency([plan(), finish]).occurrences, 0); // A plan is not an Output.
  });
  it('requires delegated ownership, returns real producer facts and reconciles every target', () => {
    const events = [plan('coordinator'), { type: 'delegate', owner: 'worker', reporting: true },
      ...occurrence('first', 'worker'), attempt('first', 'worker'), receipt(),
      ...occurrence('second', 'worker'), attempt('second', 'worker'), receipt('second'), finish];
    assert.equal(assertConsistency(events).accepted, 2);
    rejected(events.filter(event => event.type !== 'delegate'));
    rejected(events.filter(event => !(event.type === 'receipt' && event.key === 'second')));
    const takeover = structuredClone(events); takeover[4].owner = 'coordinator'; rejected(takeover);
    const duplicate = structuredClone(events); duplicate[7].eventId = 'fixture-event-first'; duplicate[8].request.event_id = 'fixture-event-first'; rejected(duplicate);
    const mixed = [...events.slice(0, 8), { type: 'block', key: 'second', reason: 'Reporting unavailable' }, finish];
    assert.deepEqual(assertConsistency(mixed), { occurrences: 2, accepted: 1, blocked: 1 });
  });
  it('retains producing facts before another operation and rejects fabricated host/account/evidence', () => {
    const events = [plan(), ...occurrence(), attempt(), receipt(), finish];
    rejected([events[0], events[1], plan('another'), ...events.slice(2)]);
    for (const field of ['host', 'account', 'evidence', 'target']) {
      const changed = structuredClone(events); changed[2].producer[field] = 'invented'; rejected(changed);
    }
    const scoped = structuredClone(events); scoped[3].request.artifact.scope_ref = 'guessed-scope'; rejected(scoped);
    const relabeled = structuredClone(events); relabeled[3].request.source_application = 'another-host'; rejected(relabeled);
    const unavailable = structuredClone(events); unavailable[3].route = null; rejected(unavailable);
  });
  it('finishes successful work with explicit unavailable-tool or missing-evidence blockers', () => {
    for (const [evidence, reason] of [['fixture-revision-first', 'Reporting tools unavailable'], ['fixture-revision-first', 'Consent denied'], [null, 'No allowed mutation evidence returned']]) {
      const events = [plan(), ...occurrence('first', 'producer', evidence), { type: 'block', key: 'first', reason }, finish];
      assert.equal(assertConsistency(events).blocked, 1);
      rejected(events.filter(event => event.type !== 'block'));
      rejected(events.map(event => event.type === 'block' ? { ...event, reason: '' } : event));
      if (!evidence) rejected([...events.slice(0, 3), attempt(), receipt(), finish]);
    }
  });
  it('recovers a lost response and repeated Sync without another producing act or Output', () => {
    const events = [plan(), ...occurrence(), attempt(), receipt('first', 'lookup'), receipt('first', 'lookup'), finish];
    assert.equal(assertConsistency(events).accepted, 1);
    rejected([...events.slice(0, -1), attempt(), finish]);
    const changed = structuredClone(events); changed[5].receipt.output_id = 'another-output'; rejected(changed);
  });
  it('retries only after not-found with the original route, event ID and exact request', () => {
    const events = [plan(), ...occurrence(), attempt(), { ...receipt('first', 'lookup'), receipt: null }, attempt(), receipt(), finish];
    assert.equal(assertConsistency(events).accepted, 1);
    rejected(events.filter(event => event.type !== 'lookup'));
    for (const change of [event => event.request.summary = null, event => event.request.event_id = 'replacement', event => event.route = 'other']) {
      const changed = structuredClone(events); change(changed[5]); rejected(changed);
    }
    const uncertain = [...events.slice(0, 4), { type: 'block', key: 'first', reason: 'Receipt unavailable; recovery remains uncertain' }, finish];
    assert.equal(assertConsistency(uncertain).blocked, 1);
    rejected([...events.slice(0, 4), finish]);
  });
});

describe('reporting instruction contract (static only)', () => {
  it('loads a planning trigger and preserves evidence, delegation and final reconciliation instructions', async () => {
    const skill = (await readFile('skills/report-artifact/SKILL.md', 'utf8')).replace(/\s+/g, ' ');
    assert(skill.includes('description: Use when planning or completing durable work'));
    for (const clause of ['do not guarantee implicit activation', 'owns reporting by default',
      'Immediately after each successful qualifying operation', 'Unknown accounts remain unknown',
      'not full tool payloads', 'missing allowed successful action evidence blocks submission',
      'When delegating, explicitly include reporting ownership', 'An unsupported delegated host remains a blocker',
      'reconcile every successful qualifying occurrence', 'An attempt alone is not acceptance',
      'original request and ID']) assert(skill.includes(clause), clause);
  });
});
