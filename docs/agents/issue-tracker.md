# Issue tracker: GitHub

Issues and specs live in GitHub Issues for jvasquezt2004/db-planner.
Use the gh CLI with --repo jvasquezt2004/db-planner.

## Operations

- Before creating an issue, search existing issues for duplicates.
- Create: gh issue create --title "..." --body-file <markdown-file>
- Read: gh issue view <number> --json number,title,body,labels,comments
- List: gh issue list --state open --json number,title,labels
- Comment: gh issue comment <number> --body-file <markdown-file>
- Add labels: gh issue edit <number> --add-label "..."
- Remove labels: gh issue edit <number> --remove-label "..."
- Close: gh issue close <number> --comment "..."

Use the label strings defined in triage-labels.md.
Preserve unrelated labels when changing triage status.

## Publishing and fetching

When a skill says "publish to the issue tracker", create a GitHub issue.

When a skill says "fetch the relevant ticket", read the referenced
GitHub issue, including its comments and labels.

When publishing a spec with to-spec, apply ready-for-agent without
additional triage labels.

## Related issues

Use native GitHub sub-issues and issue dependencies where supported.
Otherwise, record Part of #<parent> and Blocked by: #<number> references
in the issue body.

## Pull requests as a triage surface

PRs as a request surface: no.
