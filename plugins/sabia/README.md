# Sabia for Claude Code

Reports the work Claude Code finishes (pull requests, commits, documents,
issues, emails) to your team's Sabia workspace, through Sabia's hosted
connector. It has no hooks and runs nothing on your machine.

| Piece | What it does |
| --- | --- |
| `.mcp.json` | Sabia's hosted MCP server, `sabia-artifacts`: HTTP with OAuth. |
| `skills/report-artifact` | When a completed piece of work is worth reporting, and how to report it. |
| `skills/review-work` | Submit the selected text for a requested Sabia review. |

Install with `/plugin marketplace add Sabia-Partners/sabia-claude-plugin`, then
`/plugin install sabia@sabia`, and sign in through `/mcp`.

Output Reporting sends the action, title, Artifact type and references. When you ask
Sabia to review a passage, Claude sends the selected text, title, available source
URL and review goal. Sabia saves the passage in your Organization. The
[privacy notice](https://app.sabia.work/privacy/claude-code) covers what Sabia
keeps and for how long.

Setup, the complete plugin with native usage, and support:
[github.com/Sabia-Partners/sabia-claude-plugin](https://github.com/Sabia-Partners/sabia-claude-plugin).
Released under the MIT license.
