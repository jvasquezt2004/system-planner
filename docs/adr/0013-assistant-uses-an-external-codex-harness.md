# Run Codex as an app-owned Assistant harness

The Assistant can delegate its agent loop to an installed Codex app-server,
while Schema Designer continues to own Project state, Project tools,
confirmation and turn history. Project tools are attached to the app's Codex
thread rather than installed in global Codex configuration. This extends
ADR-0004: the existing pi runtime and saved Conversations remain available,
but Codex users can use their existing sign-in and harness capabilities from
the desktop sidebar. Codex governs its own tool permissions and history;
Project Revert does not reverse external file or command effects.
