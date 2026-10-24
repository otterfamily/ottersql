# 0009. Prove non-null from the analyzed query

- Status: Accepted
- Date: 2026-10-24

## Context

ADR 0002 gives a result column `null` in its type unless ottersql can prove it is never null. The column a value comes from is not enough: a `NOT NULL` column read from the nullable side of a `LEFT JOIN` is still null for unmatched rows, yet Postgres reports the same origin for it. PgTyped and the throwaway prototype went wrong this way. Reading `EXPLAIN` plans, as sqlx does, breaks when the planner swaps join sides and needs text matching of deparsed expressions, which ADR 0001 rules out.

Since Postgres 16, the analyzed query tree marks every column reference with the outer joins that can null it (`varnullingrels`). With `debug_print_rewritten` on, Postgres sends that tree back for every statement it parses, including statements with `$n` parameters and `INSERT`, `UPDATE` and `DELETE ... RETURNING`, with views expanded. No superuser is needed.

Measured on a 50-table schema in PGlite, describing a statement went from 0.03–0.06 ms to 0.15–0.93 ms, the upper end for a five-table join. Across ten common query shapes, nothing was wrongly proven non-null; two columns that are non-null only because an inner join after a left join filters out unmatched rows stayed nullable.

## Decision

- ottersql describes each statement with `debug_print_rewritten` on and reads the analyzed tree it sends back. It reads Postgres's node format, not SQL.
- A result column is non-null only when its expression is one of:
  - a column reference with no nulling outer join, pointing at a validated `NOT NULL` column, and not the `old` side of `RETURNING`;
  - a non-null constant;
  - `count`, or a window function on an allow-list such as `row_number`;
  - `coalesce` with a non-null argument, or a `CASE` whose branches, including `ELSE`, are all non-null;
  - a cast of a non-null value;
  - a function or operator on an allow-list whose arguments are all non-null;
  - a column of a subquery, CTE, view or set operation whose every source is non-null by these rules.
- Everything else is nullable, including parameters, scalar subqueries, other aggregates and functions not on the allow-list.

## Consequences

- Types never claim non-null wrongly; some non-null columns stay nullable, such as those filtered by `WHERE x IS NOT NULL` or by a later inner join. Users can rewrite the query (`coalesce`, an inner join) to drop the `null`.
- The node format is internal to Postgres and changes between major versions, so the reader is pinned to the Postgres major that PGlite ships and covered by fixture tests per major.
- The allow-list of functions and operators is maintained by hand and grows with need.
