# Offer OpenCode as an Assistant harness; do not offer Claude Code

The Assistant can run an installed OpenCode, using the same arrangement as
ADR-0013: the app starts a private `opencode serve` per Conversation, supplies
its configuration by environment (nothing is written to OpenCode's config), and
exposes the Project tools through a loopback MCP server that exists only for
that process. OpenCode keeps its own providers, models, permissions and history.

Claude Code is not offered. Anthropic's Claude Code legal and compliance page
says third-party developers may not offer claude.ai login or route requests
through Free, Pro, Max or Ultra credentials, and that products built on Claude
Code or the Agent SDK should use API-key or cloud-provider authentication. It
does not say whether a local app may drive the user's own signed-in `claude`
binary. Until that is clarified by Anthropic, or until an API-key-only
integration is wanted, the app does not launch Claude Code. This does not
prevent users from choosing Anthropic models in OpenCode or through the
existing Anthropic API-key connection.
