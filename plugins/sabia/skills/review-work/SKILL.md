---
name: review-work
description: Run requested Sabia Quick or Advanced reviews on selected text, PR descriptions, drafts or recorded work using the Sabia connector in Claude Code and Cowork.
---

## Review selected text

When the user asks for a Sabia review, or says “quick review the PR’s description to see if it contains any slop” in an established Sabia review conversation, use the connected review tool. A quick editorial request in an unrelated conversation can be answered locally. Never save or spend a review unit just because the plugin is installed.

Fetch only the named content through the host’s authorized source tool. For a PR description, read the GitHub body only. If access fails, say which content you could not read. For recorded work as a whole use its Sabia link. For a selected passage or a PR body, pass its exact text, title, part (e.g. `pr_description`), source application and source URL in `review_work.selected_text`. Include `copy_of` when the matching Sabia link is already known. A missing work record does not prevent a text review. Pass the requested `level` and `goal` (“filler” in this example). Omit `evaluation` unless the person named one. Sabia selects a runnable Evaluation and explains the match. Relay a material choice or missing evidence before starting another request.

Use the server’s advertised schema. On an older server without `selected_text`, use `save_file` with the exact text, select a runnable Evaluation whose criteria match the input and goal using `list_evaluations`, and call `review_work` with the saved link. Never downgrade after a refusal or an uncertain write. Retry the same request with its original ID and payload. Poll a pending run with `get_work`. Return Sabia’s actual result, any separate Suggestions and the Sabia link.
