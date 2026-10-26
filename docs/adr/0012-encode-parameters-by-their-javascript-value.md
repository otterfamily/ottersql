# 0012. Encode parameters by their JavaScript value

- Status: Accepted
- Date: 2026-10-26
- Supersedes: in ADR 0008, "Parameters are encoded by the same codecs" and that a failed decoding names the value

## Context

ADR 0008 has ottersql decode every value from Postgres's text format with its own codecs, and says parameters are encoded by the same codecs. A codec is chosen by a column's type, and a `.sql` file becomes a module without a database (ADR 0003), so at run time ottersql does not know a parameter's type. Encoding by type would need the types written into each module by the content mapper, which only type checking runs, or a round trip to describe each statement before its first run.

The types the content mapper gives parameters already decide which JavaScript values a parameter takes, so the value's kind is enough to write its text: a `Temporal.PlainDate` can only be meant as a date. The one ambiguity is JSON: a string or an array passed to a `jsonb` parameter would be sent as text or as a Postgres array, so the content mapper types `json` and `jsonb` parameters as `Json`, which `json(value)` makes.

ADR 0008 also has a value that does not fit its codec fail with an error naming the value. Errors end up in logs, and rows hold personal data; Postgres itself leaves bind parameters out of its error reports by default (`log_parameter_max_length_on_error` is 0).

## Decision

- A parameter is encoded by the kind of its JavaScript value: strings as they are, numbers, bigints and booleans in their text form, `Json` as `JSON.stringify`, `Uint8Array` as hex bytea, Temporal values as their ISO strings, intervals and ranges as Postgres literals, and arrays as Postgres array literals of their items. Postgres casts the text to the parameter's type.
- A value of any other kind is rejected before the query is sent, with an error that names its kind, not its text. ottersql never falls back to `String(value)`.
- No error ottersql writes, for decoding or encoding, quotes a value from a row or a parameter. It names the column, the type and ottersql's own reason.
- When codecs can be replaced (ADR 0008), a replacement that brings its own class of values also brings an encoder for that class.

## Consequences

- Running a query needs no type information beyond what each result row's oids give.
- `json(...)` is the only wrapper users write, and the types ask for it.
- A wrong-kind value that TypeScript did not stop, such as from untyped JavaScript, is reported by Postgres as a cast error, not by ottersql.
- Errors are safe to log as they are; finding the value behind a decoding error means reading the row.
