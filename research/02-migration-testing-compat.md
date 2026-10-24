# 02 マイグレーション・ロールバック・テスト・Postgres 互換

調べた日：2026-10-24。一次資料（公式文書・ソース・リリース・npm registry・GitHub API）だけを使う。`[n]` は末尾の出典の番号。確かめられなかったことは「未確認」と書く。1〜4 章は事実、5 章は考察。

## 0. 要約

- 「down を自動で作る」道具は少ない。多くは手書きの down（dbmate・Kysely・Sqitch・Flyway の undo）か、前へ進むだけ（graphile-migrate・Prisma 8）。差分から戻す計画を作るのは Atlas の `migrate down` だけで、今の DB の状態から計画し、事前の確認を付けて流す [8]。
- 無停止で戻せる仕組みは pgroll と Reshape の「expand/contract＋版ごとの view」。`complete` の前ならデータを失わずに戻せる [1][5]。
- 危険な操作の検出は Squawk（78 規則・JSON 出力）[11][12] と Atlas の lint（データ消失・後方非互換・ロック。ロックの検査の多くは Pro）[6] が中心。
- 往復（up→down→up）を道具が自動で確かめる仕組みは、調べた範囲では見つからなかった（未確認。Atlas の `migrate test` はデータの検証で、往復の自動検証ではない [9]）。
- テストの土台は PGlite（WASM の Postgres 18.6、接続は1つ）[35][36]、testcontainers（template DB で巻き戻す snapshot）[38]、Neon の copy-on-write の branch [42]。
- Aurora DSQL は 2026 年に sequence（2月）・外部キー（8月）・`DROP COLUMN`（8月）を足したが、トリガー・PL/pgSQL・一時テーブルは無く、1 トランザクションに DDL は1文・DDL と DML は別のトランザクション [47][51]。
- AI 向けは Neon（一時 branch で試してから本番の branch へ）[45]、Supabase（破壊的な SQL で確認を出す）[46]、Prisma（CLI がエージェントを検知して `migrate reset --force` などを止め、同意の文を環境変数で要求）[21]、Atlas（MCP ではなく agent skills）[10]、drizzle-kit（beta のソースに MCP サーバ）[17]。

## 1. マイグレーションの道具

### 1.1 比較表

| 道具（最新版） | 型 | down / ロールバック | 危険な操作の検出 | 無停止 | 機械が読める出力・AI 向け |
|---|---|---|---|---|---|
| Atlas（v1.3.0, 2026-08-02）[30] | 宣言型＋版管理（`migrate diff` で差分を生成）[10] | `migrate down` は事前の down ファイルに頼らず、今の DB から計画を作る。事前の確認（破壊・データ削除）を作って流し、`--dry-run`・ドリフト検出あり。承認の流れは Pro [8] | `migrate lint`：データ消失（DS1xx）・データ次第で落ちる（MF1xx）・後方非互換（BC1xx）は無料、Postgres の非同時の index（PG1xx）・ロックや書き換え（PG3xx）は Pro [6]。lint には dev DB が要る [7] | 検出のみ。無停止の実行の仕組みは無い（未確認） | `--format` に Go テンプレート [7]（JSON の公式の例は未確認）。agent skills（Claude Code・Codex・Cursor）と Copilot の指示 [10]。MCP の記述なし [10] |
| pgroll（v0.16.3, 2026-09-08）[2] | 命令型（JSON/YAML の操作の列）[1][2] | `start`→`complete`。`complete` の前なら `rollback` で新しい版を消し、古い版は元のまま [1] | 操作の型で危険を避ける作り（列の変更は新しい列＋backfill＋双方向のトリガー）[1]。lint の機能は無い（未確認） | あり。物理表の上に版ごとの view の schema を作り、`search_path` で切り替え [1] | `status` は JSON [4]。`convert` は SQL を pgroll の操作に変えるが up/down は手で埋める [3]。`migrate --expect-one`（v0.15.0）[2]。AI・MCP の記述なし [1] |
| Reshape（v0.11.2, 2026-09-09）[30] | 命令型（TOML/JSON の actions）[5] | `migration start`→`complete`、`abort` でデータを失わずに戻す [5] | 同上（view とトリガーで新旧を変換）[5] | あり [5] | README がエージェント向けの基盤 Specific（specific.dev）を案内 [5] |
| Squawk（v2.70.0, 2026-10-15）[30] | lint 専用 | ― | 78 規則：`adding-field-with-default`・`changing-column-type`・`constraint-missing-not-valid`・`require-concurrent-index-creation`・`require-lock-timeout`・`ban-drop-column` など [11]。`--pg-version`・`--assume-in-transaction` [12] | 検出のみ | `--reporter` に `json`・`gcc`・`gitlab`。PR へのコメント、言語サーバ（`squawk server`）[12] |
| graphile-migrate（1.4.1）[29] | 命令型の SQL | 前へ進むだけ（"Roll-forward only"）。開発中だけ `uncommit` [13] | 無し。shadow DB で整合を確かめる [13] | 無し | `current.sql` を保存のたびに流し直す（冪等が必須）。commit 済みはハッシュで改変を検出 [13] |
| dbmate（v2.37.0, 2026-10-18）[30] | 命令型の SQL | `-- migrate:up` と `-- migrate:down` を同じファイルに手で書く。`rollback` で直前を戻す [14] | 無し。`--strict` で順の乱れを拒否 [14] | 無し | `schema.sql` を自動で書き出す [14] |
| drizzle-kit（npm latest 0.31.11、rc 1.0.0-rc.5）[29] | 宣言型（TS のスキーマから `generate`）＋`push` [15] | down のコマンド無し [15][16] | `push` は消える文で確認を出す。`--force` で自動承認、`--strict` で毎回確認 [16] | 無し | beta ブランチに `mcp`（generate・push・check・pull・export などを tool に）と `skills` のコマンド [17]。どの版で出たかは未確認 |
| Prisma Migrate（npm latest が 8.0.0-rc.27）[29] | 宣言型（`contract.prisma`→`migration plan`）[19] | 8 系は down の仕組みを持たず「戻すのも1つのマイグレーション」[19]。7 系までは `migrate diff` で down.sql を手で作り `db execute`・`migrate resolve --rolled-back`（失敗したものだけ）[18] | 操作ごとに precheck・postcheck と `operationClass`（additive・widening・destructive・data）。`migration show` で破壊的な操作を表示 [19]。`db migrate` は確認なしで破壊的な操作も流す [20] | 無し | 型の付いたエラー（`MIGRATION.PRECHECK_FAILED`・`MIGRATION.MARKER_MISMATCH`）[19][20]、`db migrate --show`（変えずに表示）[20]。エージェント向けの skills [19]。`--json` の記述なし [19] |
| Kysely Migrator（0.29.7）[29] | 命令型（TS の `up`/`down`）[23] | `migrateDown`・`migrateTo(NO_MIGRATIONS)` [24]。down は手書き | 無し。DB のロックで並行実行を直列に [23] | 無し | 結果は `{ error, results }` で返る [23] |
| Flyway | 命令型の SQL | `U<版>` の undo スクリプト。有償の版（文書で Teams / Enterprise と表記）[25][26]。データの変更の取り消しは苦手、DDL のトランザクションの無い DB で失敗した版は戻せない [25] | 未確認 | 無し | AI・MCP は未確認 |
| Liquibase | 命令型（XML/YAML/JSON/SQL の changeset） | `createTable`・`addColumn`・`renameColumn` などは自動で戻す。drop 系・データの変更・`sql` は手書き。SQL 形式の changelog は自動のロールバックなし [27] | 未確認 | 無し | AI・MCP は未確認 |
| Sqitch（v1.6.1）[30] | 命令型（変更ごとに deploy・revert・verify の3本） | revert を手で書く。`verify` で deploy の成否を確かめる。番号でなく `sqitch.plan` と依存（`--requires`）で順を決める [28] | 無し | 無し | 未確認 |

### 1.2 型で分けた見取り図（事実の整理）

- **down を手で書く**：dbmate・Kysely・Sqitch・Flyway の undo・Liquibase の多く。正しさは人が担保する。
- **戻さずに前へ進む**：graphile-migrate [13]・Prisma 8 [19]。
- **計画を動的に作る**：Atlas の `migrate down` [8]。
- **新旧を同時に生かす**：pgroll・Reshape。`complete` するまでは戻せるが、`complete` の後は戻せない作り [1][5]。
- 往復（up→down→up）や「down の後のスキーマが up の前と同じか」を自動で比べる機能は、調べた資料には無かった（未確認）。Atlas の `migrate test` は版の間でデータを入れて確かめる枠組み（Pro）[9]。

## 2. テストのしやすさ

| 方法 | 事実 |
|---|---|
| PGlite（0.5.11）[29] | WASM の Postgres。Node・Bun・ブラウザで動き、gzip で 3MB 未満。メモリ・ファイル・IndexedDB に置ける [31]。Postgres 18.6（0.5.9 で上げた）[36]。シングルユーザーモードを使い、接続は1つ [35][32]。拡張は contrib 33 個を同梱、pgvector・PostGIS・pgTAP・pg_uuidv7 などは別パッケージ [34]。`clone()`（テストに向くと明記）・`dumpDataDir`/`loadDataDir`・`transaction` [33]。標準のクライアントから繋ぐ `pglite-socket` パッケージがある [35]（使い方は未確認）。起動・破棄が速いと書くが数値はない [31] |
| testcontainers（@testcontainers/postgresql 12.2.1）[29] | 本物の Postgres をコンテナで起動。`snapshot()`/`restoreSnapshot()` は中で `CREATE DATABASE ... WITH TEMPLATE` を使う [38]。接続を閉じてから呼ぶ必要があり、DB 名に `postgres` は使えない [37] |
| template database | `CREATE DATABASE ... TEMPLATE` で複製。複製元に他の接続があると失敗する [40]。PG18 の既定は `WAL_LOG`（小さい DB に効率的）、`FILE_COPY` は WAL が少ないが前後で checkpoint、`file_copy_method` の影響を受ける [41] |
| pg_tmp（ephemeralpg） | 一時の Postgres を作り URI を返すシェルスクリプト。fsync を切る・事前に initdb しておくなどで速くする。`-w` で保持の秒数 [39] |
| トランザクションで巻き戻す型 | Postgres は DDL もトランザクションに入る（一般的な性質。公式の該当ページは本調査で未取得）。PGlite の `transaction` は callback の reject で巻き戻す [33]。DSQL は DDL と DML を同じトランザクションにできず [47]、CockroachDB は複数文のトランザクション内の DDL を勧めない [54] ので、この型は互換 DB では崩れる |
| Neon の branch | copy-on-write の複製で親に負荷をかけない。schema だけの branch、親からの reset、期限（TTL）付きの branch、CI 向けの使い方を公式が勧める [42] |
| Supabase の branch | 既定でデータなし（seed か「Include data」）。schema は git のマイグレーションから作る。PR ごとの preview branch は merge/close で消える [43] |

## 3. Postgres 互換の DB の違い

| DB | 基の版・確かめ方 | マイグレーションに効く違い |
|---|---|---|
| Aurora PostgreSQL | `version()` が PostgreSQL の版、`aurora_version()` が Aurora の版 [52] | 本体は Postgres と同じ系統。pgroll は Aurora で動くと明記 [1]。拡張は版ごとの一覧あり [52]（個別の差は未確認） |
| Aurora DSQL | Postgres 互換（基の版は文書で未確認） | 1 クラスタに DB は `postgres` の1つ。照合は `C` のみ。分離は Repeatable Read 固定。DDL と DML は別のトランザクション・1 トランザクションに DDL は1文・DML は 3,000 行まで。接続は1時間で切れる [47]。一時テーブル・トリガー・PL/pgSQL なし（SQL 関数のみ）[47]。index は `CREATE INDEX ASYNC`、`TRUNCATE` の代わりに `DELETE` [47][48]。sequence・identity は 2026-02-11 から（identity は `bigint` のみ・`CACHE` の明示が必須）[49][51]。外部キーは 2026-08-26 から（後から足すときは `NOT VALID`＋`ALTER TABLE ASYNC ... VALIDATE CONSTRAINT`）[49][50][51]。`ALTER TABLE` に `ALTER COLUMN TYPE`・`SET NOT NULL` が無い [49]。`DROP COLUMN` は 2026-08-03 から、列は生涯 1600 個まで [49][51]。`CREATE EXTENSION` は対応の一覧に無い [48]（不可と明記する文は未確認） |
| CockroachDB（v26.3） | ― | 既定の分離は SERIALIZABLE、READ COMMITTED も選べる [55]。schema の変更はロックを持たない背景のジョブ。複数文のトランザクション内の DDL は勧めず、一部だけ確定することがある。`autocommit_before_ddl` あり [54]。template からの DB 作成・FDW・範囲型・列の権限・セッション単位の advisory lock がない。主キーは必須 [53]。トリガー・PL/pgSQL は未確認 |
| YugabyteDB | YSQL は PostgreSQL 15 のコードで作る（`version()` は `15.2-YB`）[56] | 分散のため一部の機能が無いとの一般的な注意のみ [56]。transactional DDL はフラグで有効にする機能として文書がある [57]（既定値と版ごとの状態は未確認） |
| AlloyDB | 拡張の一覧は PG14〜18 の記載 [58] | 独自の拡張（`google_columnar_engine`・`alloydb_scann`・`google_ml_integration` など）[58]。DDL の違いは未確認 |
| Neon・Supabase | ― | 本体の Postgres の差は本調査で未確認。違いは主に branch・MCP などの周辺 [42][43][44][46] |

**能力の検出についての事実**：Aurora は `aurora_version()` [52]、Yugabyte は `version()` の `-YB` [56] で見分けられる。DSQL・CockroachDB の確実な見分け方は本調査で未確認。

## 4. AI エージェントとマイグレーションの公式の取り組み

| 提供元 | 事実 |
|---|---|
| Neon | MCP に `prepare_database_migration`（一時 branch に当てて試す）→`complete_database_migration`（本体の branch に当てて一時 branch を片付ける）、`compare_database_schema`、クエリの調整も同じ2段 [45]。read-only の時は書き込みの tool を出さない [45]。公式は「開発とテストだけ、本番に繋がない」、`?readonly=true`・`?category=`・`?roleName=` で絞る [44] |
| Supabase | MCP に `apply_migration`・`list_migrations`・`execute_sql`。破壊的な SQL はクライアントが対応していれば確認を出す。branch の tool（有償・実験的）。`read_only`・`project_ref`・`features` で絞る [46] |
| Prisma | CLI が AI エージェントからの実行を検知し、`prisma migrate reset --force` などの破壊的な操作を止める。ユーザーの明示の同意の文を `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` に入れて再実行させる。この安全装置は MCP の tool には効かない [21]。MCP にはスキーマの読み取り・`execute_prisma_postgres_schema_update`・バックアップからの復元など [22]。Prisma 8 は agent 向けの skills を同梱 [19] |
| Atlas | MCP ではなく agent skills。`migrate diff`→`migrate lint`→`migrate apply`（dry-run から）、ドリフトを承認なしに直さない、適用済みのファイルを書き換えない、を指示 [10]。`llms.txt` を公開 [10] |
| drizzle-kit | beta ブランチのソースに `drizzle-kit mcp`（generate・push・check・pull など）と `skills` [17]。正式な版での提供は未確認 |
| AWS（Aurora DSQL） | AWS Labs の Aurora DSQL MCP Server と、Claude・Codex・Gemini・Kiro 向けの skills を公式文書が案内 [51] |

## 5. 考察：AI に最適化したマイグレーション・ロールバック・テストに入れる空き

以下は 1〜4 章の事実からの推論で、検証していない。

1. **down を「証明付き」で作る**。今は手書きか動的な計画（Atlas）かで、往復の自動の検証が見当たらない。マイグレーションごとに「up→down→up でスキーマが一致」「down で消えるデータの有無」を、PGlite の `clone()` や template DB で毎回確かめ、結果を機械が読める形で返す。戻せない操作（列の削除など）は「不可逆」と型で宣言させ、逃げ道（バックアップ・expand/contract）を必須にする。
2. **操作を分類した中間表現を1つ持つ**。Prisma 8 の `operationClass`・precheck/postcheck [19]、Atlas の分析器のコード [6]、Squawk の規則 [11] は似たことを別々にしている。操作を「追加・拡大・破壊・データ・ロック」で分類した JSON の計画を中心に置けば、lint・承認・無停止の変換（pgroll 型）・方言ごとの書き換えを同じ入力から作れる。エージェントは SQL ではなくこの計画を読み書きする。
3. **方言を「能力の表」で扱う**。DSQL は 2026 年だけで sequence・外部キー・`DROP COLUMN` が増え [51]、宣言の一覧で静的に持つとすぐ古くなる。接続先の版・能力（DDL のトランザクション・1 トランザクション1 DDL・`ASYNC` の index・`NOT VALID` の必須・トリガーの有無）を検出して表にし、計画の段で「この DB では N 本のトランザクションに分ける」「この操作は不可」を決める。expand/contract はトリガーに頼るので（pgroll・Reshape [1][5]）、トリガーの無い DSQL では別の戦略が要る。
4. **エージェントの安全装置を道具の側に**。Prisma の同意の文 [21]、Neon の一時 branch で試す2段 [45]、Supabase の破壊的な SQL の確認 [46] はそれぞれ別の形。「計画→試す（使い捨ての DB）→差分と危険の報告→人の承認の印→適用」を、CLI・MCP・ライブラリで同じ状態機械にし、承認の無い破壊的な適用を型と実行時の両方で拒む。
5. **テストの層をそろえる**。単体は PGlite（速いが接続1つ・拡張は一部 [34][35]）、互換の確認は testcontainers＋template DB [38]、DB ごとの差は Neon の branch や実機。マイグレーションの道具が「同じテストを3層で流す」口と、PGlite と本物の Postgres の差（拡張・接続数）を事前に教える仕組みを持つと、AI が手元で確かめて出せる。
6. **エラーと出力を全部構造化する**。Squawk の JSON [12]・pgroll の `status` [4]・Prisma のエラーのコード [19] は部分的。計画・lint・検証・適用の結果すべてに、安定したコード・対象のオブジェクト・直し方の候補を持つ JSON を返せば、エージェントが自分で直す輪を回しやすい。

## 出典

1. https://github.com/xataio/pgroll
2. https://github.com/xataio/pgroll/releases （GitHub API で取得：v0.16.3・v0.16.0・v0.15.0 の本文）
3. https://github.com/xataio/pgroll/blob/main/docs/cli/convert.mdx
4. https://github.com/xataio/pgroll/blob/main/docs/cli/status.mdx
5. https://github.com/fabianlindfors/reshape
6. https://atlasgo.io/lint/analyzers
7. https://atlasgo.io/versioned/lint
8. https://atlasgo.io/versioned/down
9. https://atlasgo.io/testing/migrate
10. https://atlasgo.io/guides/ai-tools
11. https://squawkhq.com/docs/rules
12. https://github.com/sbdchd/squawk
13. https://github.com/graphile/migrate
14. https://github.com/amacneil/dbmate
15. https://orm.drizzle.team/docs/kit-overview
16. https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-kit/src/cli/schema.ts
17. https://github.com/drizzle-team/drizzle-orm/blob/beta/drizzle-kit/src/mcp/server.ts ・ https://github.com/drizzle-team/drizzle-orm/blob/beta/drizzle-kit/src/cli/schema.ts
18. https://www.prisma.io/docs/orm/prisma-migrate/workflows/generating-down-migrations
19. https://www.prisma.io/docs/orm/prisma-migrate
20. https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production
21. https://www.prisma.io/docs/postgres/integrations/mcp-server
22. https://www.prisma.io/docs/ai/mcp-tools
23. https://kysely.dev/docs/migrations
24. https://github.com/kysely-org/kysely/blob/HEAD/src/migration/migrator.ts
25. https://documentation.red-gate.com/fd/undo-migrations-273973334.html
26. https://documentation.red-gate.com/fd/undo-277578896.html
27. https://docs.liquibase.com/workflows/liquibase-community/automatic-custom-rollbacks.html
28. https://sqitch.org/docs/manual/sqitchtutorial/
29. npm registry（2026-10-24 取得）：https://registry.npmjs.org/@electric-sql/pglite/latest ・ https://registry.npmjs.org/-/package/drizzle-kit/dist-tags ・ https://registry.npmjs.org/-/package/prisma/dist-tags ・ https://registry.npmjs.org/kysely/latest ・ https://registry.npmjs.org/@testcontainers/postgresql/latest ・ https://registry.npmjs.org/graphile-migrate/latest
30. GitHub API の releases/latest（2026-10-24 取得）：https://api.github.com/repos/ariga/atlas/releases/latest ・ https://api.github.com/repos/sbdchd/squawk/releases/latest ・ https://api.github.com/repos/fabianlindfors/reshape/releases/latest ・ https://api.github.com/repos/sqitchers/sqitch/releases/latest ・ https://api.github.com/repos/amacneil/dbmate/releases/latest
31. https://pglite.dev/docs/about
32. https://pglite.dev/docs/
33. https://pglite.dev/docs/api
34. https://pglite.dev/extensions/
35. https://github.com/electric-sql/pglite （README と packages/ の一覧）
36. https://github.com/electric-sql/pglite/blob/main/packages/pglite/CHANGELOG.md
37. https://node.testcontainers.org/modules/postgresql/
38. https://github.com/testcontainers/testcontainers-node/blob/main/packages/modules/postgresql/src/postgresql-container.ts
39. https://eradman.com/ephemeralpg/
40. https://www.postgresql.org/docs/current/manage-ag-templatedbs.html
41. https://www.postgresql.org/docs/current/sql-createdatabase.html
42. https://neon.com/docs/introduction/branching
43. https://supabase.com/docs/guides/deployment/branching
44. https://neon.com/docs/ai/neon-mcp-server
45. https://github.com/neondatabase/mcp-server-neon
46. https://supabase.com/docs/guides/getting-started/mcp
47. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-migration-guide.html
48. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-sql-features.html
49. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.html
50. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-foreign-key-constraints.html
51. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/doc-history.html
52. https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Updates.html
53. https://docs.cockroachlabs.com/docs/stable/postgresql-compatibility
54. https://docs.cockroachlabs.com/docs/stable/online-schema-changes
55. https://docs.cockroachlabs.com/docs/stable/transactions
56. https://docs.yugabyte.com/stable/api/ysql/
57. https://docs.yugabyte.com/stable/explore/transactions/transactional-ddl/
58. https://docs.cloud.google.com/alloydb/docs/reference/extensions
