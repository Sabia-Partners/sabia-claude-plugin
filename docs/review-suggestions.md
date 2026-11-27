# Verify Advanced review suggestions in Claude

Claude Code and Cowork use the Sabia connector’s `review_work` and `get_work`
tools. The connector supplies the instructions for text replies and the panel
for hosts that can display it. This check applies to both clients.

## Review cases

The [synthetic review rows](../tests/fixtures/review-suggestions.json) are
examples of the result inside a completed `review_work.review.result` and the
matching entry of `get_work.reviews`. Each row can be presented in both forms.

| Case | Expected text and panel |
| --- | --- |
| All pass | Pass. A separate **Suggestions** section names “Labels the chart,” proposes labeling the two peaks, explains the comparison benefit, and cites evidence 2 for that check on review ledger page 4. |
| Mixed | Fail. “Add the missing citation” belongs to the “Cites its sources” finding. The chart advice appears only under **Suggestions** with its own criterion and evidence. If asked what “fix them all” covers, Claude lists only the citation fix. |
| Empty or legacy | The passing result has no Suggestions heading. |
| Permission-filtered | The readable failed criterion remains visible. Neither the hidden fix nor the optional chart advice appears. Claude infers no missing content. |

## Run in each host

Use an existing authorized test connection on the candidate server. Select
synthetic work with a known Advanced review and the intended visibility. For
the filtered case use a reader who can see the result but cannot see its
reference-derived advice. Keep that reader’s existing grants. If either tool
is unavailable, record the host and missing capability.

1. Observe a requested review of the test work. Ask “What did this review find?”
   Compare the reply and its panel, if available, against the returned result.
   Check criterion names, improvement, benefit, evidence number and ledger page.
2. In the same host ask “Show me the result of that review again.” Observe
   `get_work` on the same work, Evaluation and review timestamp. Compare the
   visible suggestions with the completed result. If the initial review is still
   running, wait and read it with `get_work`. Confirm there was only one
   `review_work` call and no older advice appeared while waiting.
3. For mixed results ask “Which edits would ‘fix them all’ include? Just list
   them.” Check that no edit or `mark_finding` call occurred and only returned
   fixes appear in the list. Repeat the read cases on existing test results.
4. Record the host/version, case, observed tool sequence, text outcome and panel
   outcome. Mark the panel unavailable in a text-only host. A fixture replay
   verifies the candidate renderer; a live host result requires the actual
   authorized session.

To replay all ten case/tool combinations against the shared panel locally, use
Node 24 and a trusted checkout of the candidate Sabia server with its development
dependencies installed. The replay runs its panel in jsdom with a synthetic
MCP Apps host and prints one result per combination.

```sh
node tests/review-suggestions-panel.mjs /path/to/dashboard-langfuse
```
