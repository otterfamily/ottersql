// PROTOTYPE, throwaway. Shared by the content mapper (types) and the Node loader (runtime).
export function parseBlocks(content) {
  const re = /^--\s*@name\s+(\w+)\s*$/gm
  const heads = [...content.matchAll(re)]
  return heads.map((h, i) => {
    const bodyStart = h.index + h[0].length
    const bodyEnd = i + 1 < heads.length ? heads[i + 1].index : content.length
    return { name: h[1], nameStart: h.index + h[0].indexOf(h[1], 3), bodyStart, body: content.slice(bodyStart, bodyEnd) }
  })
}

export function toPositional(body, bodyStart) {
  const params = [] // { name, origin }
  let sql = ''
  let last = 0
  for (const m of body.matchAll(/(?<!:):([a-zA-Z_]\w*)/g)) {
    let idx = params.findIndex((p) => p.name === m[1])
    if (idx < 0) idx = params.push({ name: m[1], origin: bodyStart + m.index + 1 }) - 1
    sql += body.slice(last, m.index) + `$${idx + 1}`
    last = m.index + m[0].length
  }
  sql += body.slice(last)
  return { sql: sql.trim().replace(/;\s*$/, ''), params }
}

