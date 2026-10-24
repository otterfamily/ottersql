// PROTOTYPE, throwaway. TS 7.1 content mapper for .sql query files.
// Protocol: JSON-RPC with Content-Length framing over stdio (microsoft/TypeScript tsc/internal/jsonrpc).
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PGlite, protocol } from '@electric-sql/pglite'
import { parseBlocks, toPositional } from './sql-file.mjs'

const logFile = process.env.SQL_MAPPER_LOG ?? resolve(import.meta.dirname, 'mapper.log')
const log = (...a) => appendFileSync(logFile, `${new Date().toISOString()} ${a.join(' ')}\n`)

// ---------- JSON-RPC over stdio ----------
let buf = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n')
    if (sep < 0) return
    const header = buf.subarray(0, sep).toString()
    const len = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1])
    if (buf.length < sep + 4 + len) return
    const body = buf.subarray(sep + 4, sep + 4 + len).toString()
    buf = buf.subarray(sep + 4 + len)
    queue = queue.then(() => handle(JSON.parse(body)))
  }
})
let queue = Promise.resolve()

function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

async function handle(msg) {
  const t0 = performance.now()
  try {
    const result = await methods[msg.method](msg.params ?? {})
    if (msg.id !== undefined) send({ id: msg.id, result })
  } catch (e) {
    log('ERROR', msg.method, e.stack)
    if (msg.id !== undefined) send({ id: msg.id, error: { code: -32603, message: String(e.message) } })
  }
  log(msg.method, msg.params?.fileName ?? '', `${(performance.now() - t0).toFixed(1)}ms`)
}

// ---------- schema: PGlite + catalog ----------
const projects = new Map() // projectHandle -> { schemaPath, schema }
const schemas = new Map() // hash -> Promise<Schema>

async function loadSchema(schemaPath) {
  const text = readFileSync(schemaPath, 'utf8')
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  if (!schemas.has(hash)) schemas.set(hash, buildSchema(text, hash))
  return schemas.get(hash)
}

let shared // one PGlite per process; a schema change resets public instead of booting a new instance
async function buildSchema(text, hash) {
  const t0 = performance.now()
  shared ??= PGlite.create()
  const db = await shared
  for (const h of schemas.keys()) if (h !== hash) schemas.delete(h)
  let error
  try {
    await db.exec('drop schema public cascade; create schema public;')
    await db.exec(text)
  } catch (e) {
    error = e.message
  }
  const cols = (
    await db.query(`
      select a.attrelid::int as rel, a.attnum as num, a.attnotnull as notnull
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped`)
  ).rows
  const checks = (
    await db.query(`
      select conrelid::int as rel, conkey[1] as num, pg_get_constraintdef(oid) as def
      from pg_constraint where contype = 'c' and array_length(conkey, 1) = 1`)
  ).rows
  const enums = (
    await db.query(`select enumtypid::int as oid, array_agg(enumlabel order by enumsortorder) as labels
      from pg_enum group by enumtypid`)
  ).rows
  const column = new Map()
  for (const c of cols) column.set(`${c.rel}:${c.num}`, { notNull: c.notnull })
  for (const ch of checks) {
    const m = /= ANY \(ARRAY\[(.*)\]\)/.exec(ch.def)
    const col = column.get(`${ch.rel}:${ch.num}`)
    if (m && col) col.values = [...m[1].matchAll(/'((?:[^']|'')*)'::/g)].map((x) => x[1])
  }
  const enumLabels = new Map(enums.map((e) => [e.oid, e.labels]))
  log('schema', hash, `${(performance.now() - t0).toFixed(0)}ms`, error ? `error: ${error}` : 'ok')
  return { db, hash, error, column, enumLabels }
}

// ---------- types ----------
const OID = {
  16: 'boolean', 21: 'number', 23: 'number', 26: 'number', 700: 'number', 701: 'number',
  20: 'number', 1700: 'string', 25: 'string', 1043: 'string', 1042: 'string', 19: 'string',
  2950: 'string', 1082: 'Date', 1114: 'Date', 1184: 'Date', 114: 'unknown', 3802: 'unknown', 17: 'Uint8Array',
  1007: 'number[]', 1009: 'string[]', 1015: 'string[]', 1000: 'boolean[]',
}
const lit = (v) => JSON.stringify(v.replaceAll("''", "'"))
function tsType(schema, field) {
  const col = schema.column.get(`${field.tableID}:${field.columnID}`)
  let t = col?.values ? col.values.map(lit).join(' | ') : (schema.enumLabels.get(field.dataTypeID)?.map(lit).join(' | ') ?? OID[field.dataTypeID] ?? 'unknown')
  // Origin NOT NULL is only trustworthy for plain columns; outer joins are not analysed in this prototype.
  if (!col?.notNull) t += ' | null'
  return t
}

// ---------- .sql query files ----------
const pascal = (s) => s[0].toUpperCase() + s.slice(1)

async function describe(db, sql) {
  const s = protocol.serialize
  const r = await db.execProtocol(new Uint8Array([...s.parse({ text: sql }), ...s.describe({ type: 'S' }), ...s.sync()]), { throwOnError: false })
  const err = r.messages.find((m) => m.name === 'error')
  if (err) return { error: err }
  return {
    params: r.messages.find((m) => m.name === 'parameterDescription')?.dataTypeIDs ?? [],
    fields: r.messages.find((m) => m.name === 'rowDescription')?.fields ?? [],
  }
}

async function transformQueries(fileName, content, schema) {
  let text = 'type Db = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };\n'
  const mappings = []
  const diagnostics = []
  if (schema.error) diagnostics.push({ messageText: `schema.sql failed to load: ${schema.error}`, start: 0, length: 0, code: 90001 })
  const emit = (s, origin) => {
    if (origin !== undefined) mappings.push([text.length, s.length, origin, s.length, 0])
    text += s
  }
  for (const b of parseBlocks(content)) {
    const { sql, params } = toPositional(b.body, b.bodyStart)
    const d = await describe(schema.db, sql)
    const P = pascal(b.name)
    if (d.error) {
      diagnostics.push({ messageText: `Postgres: ${d.error.message}`, start: b.nameStart, length: b.name.length, code: 90002 })
      text += `export declare function ${b.name}(db: Db, params: never): never;\n`
      continue
    }
    text += `export type ${P}Params = { `
    params.forEach((p, i) => {
      emit(p.name, p.origin)
      text += `: ${OID[d.params[i]] ?? 'unknown'}; `
    })
    text += `};\nexport type ${P}Row = { `
    for (const f of d.fields) text += `${JSON.stringify(f.name)}: ${tsType(schema, f)}; `
    text += `};\nexport async function `
    emit(b.name, b.nameStart)
    text += `(db: Db, params: ${P}Params): Promise<${P}Row[]> {\n`
    text += `  return (await db.query<${P}Row>(${JSON.stringify(sql)}, [${params.map((p) => `params.${p.name}`).join(', ')}])).rows;\n}\n`
  }
  return { text, extension: '.ts', mappings, diagnostics }
}

// ---------- methods ----------
const methods = {
  initialize: () => ({ positionEncoding: 'utf-16', diagnosticSource: 'sql' }),
  openProject: async ({ configFileName, projectHandle, options }) => {
    const schemaPath = resolve(dirname(configFileName), options?.schema ?? 'schema.sql')
    const schema = await loadSchema(schemaPath)
    projects.set(projectHandle, { schemaPath })
    return { configIdentity: schema.hash, watchedFiles: [schemaPath] }
  },
  transform: async ({ fileName, content, projectHandle }) => {
    const schema = await loadSchema(projects.get(projectHandle).schemaPath)
    return transformQueries(fileName, content, schema)
  },
  closeProject: ({ projectHandle }) => {
    projects.delete(projectHandle)
    return null
  },
}
log('started pid', process.pid)
