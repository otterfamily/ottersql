# 0008. ottersql decodes values from text

- Status: Accepted
- Date: 2026-10-24

## Context

ADR 0002 requires every type to match the value the driver returns at runtime. The drivers ottersql supports disagree. `int8` comes back as a string from `pg` and Bun.sql but as `number | bigint` from PGlite. A `timestamp` without time zone is read in the machine's time zone by `pg` and PGlite but as UTC by Bun.sql. `infinity` becomes `±Infinity` in `pg` and Bun.sql and an Invalid Date in PGlite. Leaving decoding to the driver would make one schema produce different types per driver.

JavaScript's `Date` keeps milliseconds while Postgres keeps microseconds. `Date` also has no way to say "a date and time with no time zone". Temporal reached Stage 4 in March 2026 and ships enabled in Node 26, Bun 1.4 and Deno 2.7. Neither `Date` nor Temporal can hold `infinity` or the furthest years Postgres allows.

Decoding a million `int8` values took about 7 ms as strings and about 45 ms as `bigint`, with 24 MB more memory for `bigint`.

## Decision

- Driver adapters return every value in Postgres's text format, and ottersql decodes it with its own codecs. Parameters are encoded by the same codecs.
- Default codecs, which are exact for every value they accept:

  | Postgres                                       | TypeScript                                                      |
  | ---------------------------------------------- | --------------------------------------------------------------- |
  | `int2`, `int4`, `float4`, `float8`             | `number`                                                        |
  | `int8`, `numeric`, `money`                     | `string`                                                        |
  | `bool`                                         | `boolean`                                                       |
  | `text`, `varchar`, `char`, `uuid`, `timetz`    | `string`                                                        |
  | `timestamptz`                                  | `Temporal.Instant`                                              |
  | `timestamp`                                    | `Temporal.PlainDateTime`                                        |
  | `date`                                         | `Temporal.PlainDate`                                            |
  | `time`                                         | `Temporal.PlainTime`                                            |
  | `interval`                                     | `{ months: number; days: number; microseconds: bigint }`        |
  | range                                          | `{ lower, upper, lowerInclusive, upperInclusive }` or `"empty"` |
  | multirange                                     | an array of ranges                                              |
  | `json`, `jsonb`                                | `unknown`                                                       |
  | `bytea`                                        | `Uint8Array`                                                    |
  | array of T                                     | `(T \| null)[]`                                                 |
  | enum, or a check that allows a list of strings | a union of those strings                                        |
  | domain                                         | its base type, narrowed like a column                           |

- A value a codec cannot represent exactly, such as `infinity` or a year beyond Temporal's range, fails decoding with an error that names the column and the value. Types are not widened for values most columns never hold.
- A project can replace the codec for any type name with its own decode, encode and TypeScript type, for example to use a decimal library for `numeric`.

## Consequences

- Types are the same whichever driver runs the query.
- Each driver adapter must be able to receive text: `pg` through `getTypeParser`, PGlite through its `parsers` option. Whether Bun.sql can is unverified and is checked when its adapter is built.
- Users need a runtime with Temporal, or a polyfill on Node 24 and Safari.
- Arithmetic on `int8` and `numeric` needs a conversion or a codec override.
