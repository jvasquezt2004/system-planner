# Domain docs

## Layout

This is a single-context project.

- Glossary: GLOSSARY.md at the repository root.
- Architecture decisions: docs/adr/ at the repository root.

## Before exploring the codebase

1. Read GLOSSARY.md.
2. Read ADRs relevant to the area being investigated or changed.

If a referenced document does not exist, proceed silently.
Domain modeling creates documents lazily when terms or decisions
are resolved; missing documents are not a setup task.

## Vocabulary

Use the glossary's canonical terms in specs, issues, code discussions,
and tests. Respect its explicitly discouraged synonyms.

If a needed concept is missing, identify the vocabulary gap rather
than silently inventing a competing term.

## Architecture decisions

Respect relevant ADRs. If a proposal conflicts with one, identify
the conflict and explain why reconsidering the decision is warranted.
