import { PGlite } from '@electric-sql/pglite'
import { countByStatus, latestPublishedPosts } from './queries/posts.sql'

const db = await PGlite.create()

const posts = await latestPublishedPosts(db, { userId: 1, limit: 10 })
for (const p of posts) {
  const status: 'draft' | 'published' = p.status // CHECK から来た型
  console.log(p.title.toUpperCase(), p.name, status, p.created_at.getTime())
  console.log(p.bio.toUpperCase()) // わざとの誤り：bio は NULL を取りうる
}

const counts = await countByStatus(db, {})
console.log(counts.map((c) => `${c.status}=${c.n}`))

await latestPublishedPosts(db, { userId: '1', limit: 10 }) // わざとの誤り：userId は数
