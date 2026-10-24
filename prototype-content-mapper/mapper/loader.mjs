// PROTOTYPE, throwaway. Node module hooks: import './x.sql' at runtime without a database.
// Usage: node --import sql-content-mapper/register.mjs src/app.ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseBlocks, toPositional } from './sql-file.mjs'

export async function load(url, context, next) {
  if (!url.endsWith('.sql')) return next(url, context)
  const content = readFileSync(fileURLToPath(url), 'utf8')
  let source = ''
  for (const b of parseBlocks(content)) {
    const { sql, params } = toPositional(b.body, b.bodyStart)
    source += `export async function ${b.name}(db, params) {\n`
    source += `  return (await db.query(${JSON.stringify(sql)}, [${params.map((p) => `params.${p.name}`).join(', ')}])).rows;\n}\n`
  }
  return { format: 'module', source, shortCircuit: true }
}
