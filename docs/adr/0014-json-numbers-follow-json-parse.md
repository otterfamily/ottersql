# 0014. JSON numbers follow JSON.parse

- Status: Accepted
- Date: 2026-10-26

## Context

ADR 0008 makes every default codec exact for the values it accepts. `json` and `jsonb` decode with `JSON.parse`, which reads a number beyond what a JavaScript number holds exactly with the nearest one: `12345678901234567890` becomes `12345678901234567000`. Postgres keeps the digits.

Keeping them would mean returning such numbers as `bigint` or strings inside the parsed value. `JSON.stringify` throws on a `bigint`, so code that passes a JSON column through to a response would break, and the parsed value would no longer match what `JSON.parse` gives the same text anywhere else. Every Postgres driver for JavaScript decodes JSON with `JSON.parse`.

## Decision

- `json` and `jsonb` decode with `JSON.parse`, as other tools do, and are typed `unknown`. A number in them that a JavaScript number cannot hold exactly is rounded: an exception to ADR 0008's exactness, written in the codec's documentation.
- A project that needs those digits will replace the codec (issue #62) or select the field as text or `numeric`.

## Consequences

- JSON columns decode as everyone expects, and stay fast.
- Large numbers inside JSON lose digits silently.
