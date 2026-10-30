# Sabia Cowork cloud capture

An opt-in companion to the Sabia plugin, for Cowork sessions that run in Anthropic's cloud. There, the Sabia plugin's own connector hook has no key and sends nothing, so this plugin reports the same connector writes, such as a Notion page created or a HubSpot deal updated, through the Sabia connector you added in Claude.

## Use it

1. In Sabia, go to Settings, AI Tools, Claude Cowork, and turn on cloud capture. An owner or administrator must allow Tool details for it.
2. Add the Sabia connector in Claude (Customize, then Connectors), named Sabia.
3. Add this plugin to your Claude account: under Customize, then Plugins, choose Add, then Add marketplace, enter Sabia-Partners/sabia-claude-plugin, and install Sabia Cowork cloud capture from it. Installed this way it updates with the marketplace; an uploaded zip does not.
4. In Claude, under Customize, then Connectors, open Sabia and set Cowork cloud capture (plugin only) to Always allow. If it is not listed, choose the ⋯ menu next to Disconnect, then Refresh tools list; Sabia lists it only once cloud capture is on. A hook cannot ask for approval, so until this is set Claude refuses each call and nothing reaches Sabia.

## Data

After each successful write by a connector tool Sabia supports, the hook passes the tool's name, its full input and its full reply to the Sabia connector's report_connector_result tool. A hook cannot trim a reply on the machine, so document or email text in that input or reply reaches Sabia. Sabia keeps only the identifiers of the item created or changed (ids, keys, names and links) and discards the rest, and it stores nothing when cloud capture is off or Tool details is not allowed. Reads, failed calls and tools that also perform reads are never matched. Remove this plugin to stop sending.
