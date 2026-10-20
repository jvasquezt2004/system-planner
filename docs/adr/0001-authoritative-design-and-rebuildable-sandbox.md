# Keep the design authoritative and the sandbox rebuildable

Persist the design independently in local SQLite and treat the database sandbox as a disposable preview, rather than deriving the design exclusively from a running database. A designer must be able to retain unfinished or temporarily invalid work that PostgreSQL cannot accept; sandbox validation failures must not discard that work. This requires distinguishing the current draft from the last successfully applied version, but avoids coupling editing and recovery to database availability or to preservation of sandbox data.
