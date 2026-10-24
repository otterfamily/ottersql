// 実行時の確認：schema.sql を流した PGlite に .sql のクエリを当てる
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { countByStatus, latestPublishedPosts } from './queries/posts.sql'

const db = await PGlite.create()
await db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'))
await db.exec(`
  insert into users (name, bio) values ('alice', null);
  insert into posts (author_id, title, status) values (1, 'hello', 'published'), (1, 'wip', 'draft');
`)

console.log(await latestPublishedPosts(db, { userId: 1, limit: 10 }))
console.log(await countByStatus(db, {}))
