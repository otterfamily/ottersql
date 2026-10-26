# Architecture decision records

Each record states one decision, why it was made, and what follows from it. Records are never rewritten; a changed decision gets a new record, and the old one is marked superseded. Edits that leave the decision as it was, such as the status line, typos and broken links, are allowed. The research behind them is kept in a private notes repository and summarised in each record.

| ADR                                                             | Decision                                         | Status                                 |
| --------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------- |
| [0001](0001-plain-sql-is-the-source-of-truth.md)                | Plain SQL is the source of truth                 | Accepted                               |
| [0002](0002-types-say-only-what-the-database-guarantees.md)     | Types say only what the database guarantees      | Accepted                               |
| [0003](0003-deliver-types-through-content-mappers.md)           | Deliver types through TypeScript content mappers | Accepted                               |
| [0004](0004-forward-only-migrations.md)                         | Forward-only migrations                          | Accepted                               |
| [0005](0005-sql-files-and-a-relational-api-no-query-builder.md) | SQL files and a relational API, no query builder | Accepted                               |
| [0006](0006-every-layer-works-on-its-own.md)                    | Every layer works on its own                     | Accepted; packaging superseded by 0013 |
| [0007](0007-design-principles.md)                               | Design principles                                | Accepted                               |
| [0008](0008-ottersql-decodes-values-from-text.md)               | ottersql decodes values from text                | Accepted; partly superseded by 0012    |
| [0009](0009-prove-non-null-from-the-analyzed-query.md)          | Prove non-null from the analyzed query           | Accepted                               |
| [0010](0010-supported-postgres-versions.md)                     | Supported Postgres versions                      | Accepted                               |
| [0011](0011-leave-no-session-state-behind.md)                   | Leave no session state behind                    | Accepted                               |
| [0012](0012-encode-parameters-by-their-javascript-value.md)     | Encode parameters by their JavaScript value      | Accepted                               |
| [0013](0013-one-package-with-an-entry-point-per-layer.md)       | One package with an entry point per layer        | Accepted                               |
| [0014](0014-json-numbers-follow-json-parse.md)                  | JSON numbers follow JSON.parse                   | Accepted                               |
