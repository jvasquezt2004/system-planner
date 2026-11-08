# Attach files to a Project so the Assistant has background

A designer can attach files to a Project (a specification, a PDF, notes) so the
Assistant understands a feature before it designs it. The files belong to the
Project, not to a Conversation or a Design, and they never change the Design:
nothing is derived from them unless the Assistant reads them and the designer
accepts what it proposes.

Files are stored in the application database next to the Project, so deleting the
Project deletes them. On attach, text is extracted once (PDF and plain text) and
stored beside the original. Codex and OpenCode have file tools, so the Project
folder carries them: `context/<name>`, with `<name>.txt` next to a PDF, read-only.
Provider connections have no files, so they read the extracted text through one
tool, `read_project_file`, which lists the files or reads one in parts. Both are
told to treat the contents as reference material and never as instructions,
because a document can contain text written to steer an agent.

## Consequences

- Limits: 20 MB per file, 50 files per Project. Text is kept for the first two
  million characters. Files that cannot be read as text (images, scanned PDFs,
  password-protected PDFs, Word documents) are stored and shown as "no text", and
  an agent with image tools may still open them from `context/`.
- Project export and import carry the Design, not the files, to keep export files
  small and text-only (ADR-0012). Re-attach files to an imported Project.
- Only the file's text reaches a model, and only when the Assistant reads it.
