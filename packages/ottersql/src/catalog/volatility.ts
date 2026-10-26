/**
 * SQL that is true when the stored expression tree `tree` (a `pg_node_tree`) calls a volatile
 * function, directly or through an operator. `alias` keeps its table aliases apart from the
 * query it is part of.
 */
export function callsVolatile(tree: string, alias: string): string {
  // Dependencies on built-in functions are not recorded in pg_depend, so the tree itself is read.
  return `coalesce((
    select bool_or(${alias}_func.provolatile = 'v')
    from regexp_matches(${tree}::text, ':(funcid|opno) (\\d+)', 'g') as ${alias}_node(found)
      join pg_proc ${alias}_func on ${alias}_func.oid = case ${alias}_node.found[1]
        when 'funcid' then ${alias}_node.found[2]::oid
        else (select oprcode from pg_operator where oid = ${alias}_node.found[2]::oid)::oid
      end
  ), false)`;
}
