# 01. TypeScript の ORM・クエリビルダの競合（2026-10-24 時点）

目的：AI（コーディングエージェント）に最適化した、Postgres を主軸とする TS の ORM・クエリビルダ・マイグレーション・型安全ツールを作るにあたり、既存の道具の現状を一次資料で確かめる。
前半（1〜4）は事実、後半（5）は考察。数値はすべて 2026-10-24 に API から取った。

## 1. 勢い（数値）

- star・最終 push：GitHub REST API `repos/{owner}/{repo}` [1]
- 週 DL：npm downloads API `last-week`。API が返した窓は **2026-10-12〜10-18** [2]
- 最新版・最終公開日・npm 保守者数：npm registry の `dist-tags`・`time`・`maintainers` [3]
- 90 日のコミット：`commits?since=2026-07-24`（既定ブランチ、bot を除く）。Drizzle だけは開発ブランチ `beta` で数えた [4]

| 道具 | star | 主な npm パッケージ（週 DL） | latest（公開日） | 先行版 | npm 保守者 | 90日コミット / 作者数 |
|---|---:|---|---|---|---:|---|
| Prisma（repo は `prisma/orm` に改名） | 47,664 | `prisma` 11.69M / `@prisma/client` 11.12M / `@prisma/orm-postgres` 46.5k | CLI `prisma` は **8.0.0-rc.27**（2026-10-23）、`@prisma/client` 7.10.1（10-15） | `@prisma/orm-postgres` 8.0.0-rc.20 | 1〜4 | 507 / 13 |
| Drizzle ORM | 36,122 | `drizzle-orm` 18.34M / `drizzle-kit` 15.31M | 0.45.4（10-08）/ kit 0.31.11 | **1.0.0-rc.5**（10-21） | 4 | `beta` で 300超 / 10（上位4人が大半） |
| TypeORM | 36,659 | `typeorm` 2.84M | **1.1.2**（10-08）。1.0.0 は 2026-05-19 | nightly | 2 | 38 / 18 |
| Sequelize | 30,348 | `sequelize` 1.53M / `@sequelize/core` 61k | 6.37.8（2026-03-07） | 7.0.0-alpha.48（2026-02-04） | 9 | 95 / 17（リリース 0） |
| sqlc（Go 製。TS は plugin） | 18,406 | （Go）。`sqlc-gen-typescript` 523 star | — | TS plugin は early access | — | 59 / 4 |
| Effect（`@effect/sql`） | 17,365 | `effect` 30.10M / `@effect/sql-pg` 811k / `@effect/sql` 314k | `effect` **4.0.6**・`@effect/sql-pg` 4.0.6（10-22） | — | 2 | 1,777 / 159（Effect 全体） |
| Kysely | 14,298 | `kysely` 12.78M / `kysely-codegen` 859k / `kysely-ctl` 194k | 0.29.7（10-17） | 0.30.0-beta.2 | 2 | 88 / 7 |
| MikroORM | 9,253 | `@mikro-orm/core` 541k | **7.2.5**（10-09）。7.0.0 は 2026-03-11 | 7.2.6-dev | 1 | 254 / 37 |
| postgres.js | 8,733 | `postgres` 14.26M | 3.4.9（2026-04-05） | — | 1 | 2 / 1 |
| Objection | 7,337（Vincit） | `objection` 131k | **4.2.0**（10-18、`ditojs/objection` から公開） | — | 3 | Vincit 側 0 |
| Slonik | 4,940 | `slonik` 102k | 49.11.0（10-11） | — | 1 | 9 / 1 |
| PgTyped | 3,285 | `@pgtyped/runtime` 55k / `@pgtyped/cli` 46k | runtime 2.4.2（2025-02-10）/ cli 2.4.3（2025-03-15） | — | 1 | 0 |
| ZenStack | 2,955 | `@zenstackhq/orm` 47k（v3）/ `@zenstackhq/runtime` 42k（v2） | 3.9.8（10-19） | — | 2 | 63 / 14 |
| Zapatos | 1,403 | `zapatos` 25k | 6.6.1（2025-09-19） | — | 1 | 0（最終 push 2025-09-19） |
| Kanel | 1,183 | `kanel` 112k | 4.0.4（2026-08-24） | — | 1 | 1 / 1 |

注：週 DL は他の道具からの間接の依存を含む（例：MikroORM v7 は内部で Kysely を使う [8]、ZenStack v3 も Kysely の上に立つ [37]）。

### 状況の変化（2025〜2026）

- **Prisma**：6.16 で Rust を外したクライアントと driver adapter が GA、7.0.0（2025-11-19）で Rust を外した ESM クライアントが既定に（バンドル約 90% 減・最大 3 倍速いと公式が主張）[9][10]。さらに **Prisma ORM 8 を TypeScript でゼロから書き直し**、公式の説明は「extensible, composable, and AI-agent friendly」（旧 `prisma/prisma-next`、現在はアーカイブ済みで `prisma/orm` に統合）[6][11][12]。8 は RC で、GA は「2026 年 10 月の予定」。`npm install prisma` は既に 8 の CLI を入れ、`schema.prisma`・`generate`・`migrate dev`・`db push` を持たない [12]。7 は 8 の GA から 18 か月保守、6 は 2026-11-19 まで security のみ [12]。
- **Drizzle**：v1 は 2026-04-30 に RC.1、10-21 に RC.5。npm の `latest` はまだ 0.45 系 [5][13]。RC.5 でも [BREAKING] が多数（postgres-js のパーサ、RQB v2 のフィルタの `undefined` を禁止、エラーから params を既定で除外 など）[14]。
- **MikroORM 7**（2026-03-11）：knex を外し Kysely を実行層に、core の依存ゼロ、`defineEntity` で型推論、`em.getKysely()` が自動で型付き [7][8]。
- **TypeORM 1.0**（2026-05-19）：0.3 系から破壊的変更つきで 1.0 へ [15]。
- **Objection**：保守者が Vincit の repo の権限を外され、`ditojs/objection` で開発を続け同じ npm 名で 4.x を公開（README の記述）[16]。
- **Effect**：v4（`effect` 4.0.x）が latest。SQL のドライバは `@effect/sql-pg` 4.x として出ている [17]。
- **Sequelize**：v7 は 2026-02 の alpha.48 で止まり、90 日でリリースなし [3][4]。
- **PgTyped・Zapatos**：npm の公開が 2025 年で止まっている [3]。

## 2. 設計と型

| 道具 | 近さ | スキーマの定義 | 型の作り方 | 生 SQL の逃げ道 |
|---|---|---|---|---|
| Prisma 7 | ORM の DSL（オブジェクトの引数） | `schema.prisma`（PSL） | **生成**（`prisma generate`、v7 からは出力先が必須）[9] | `$queryRaw`、TypedSQL（`.sql` ファイルから型を生成） |
| Prisma 8（RC） | ORM の client ＋ **SQL クエリビルダ**（Postgres）＋ raw | `contract.prisma`（PSL）か `contract.ts`（TS のビルダ） | **生成**：`prisma contract emit` が `contract.json` と `contract.d.ts` を書く。同じ入力から同じバイト列になり、両方をコミットする [18] | `db.raw.sql` と `.returnsRow()`／`fns.raw(...).returns('pg/int4@1')` で型を手で付ける。TypedSQL は廃止 [19][20] |
| Drizzle | SQL に近いビルダ ＋ 関係クエリ（RQB） | TS のコード（`pgTable` 等） | **推論** | `sql` タグ（「Magical `sql` operator」）[13] |
| Kysely | SQL そのままのビルダ（ORM ではない） | なし。`DB` の interface を手書きか生成（kysely-codegen・Kanel・prisma-kysely）[21] | **推論**（interface から） | `sql` タグ、`DynamicModule` [22] |
| MikroORM | Data Mapper ＋ Unit of Work ＋ Identity Map | デコレータか `defineEntity` | `defineEntity` で推論、デコレータは反映 [8] | `em.getKysely()`、raw 断片 [8] |
| TypeORM | Active Record／Data Mapper | デコレータ | クラスから | `query()`、QueryBuilder（未確認：詳細は読んでいない） |
| Sequelize | Active Record | `Model.init`／デコレータ（v7） | クラスから | `sequelize.query` |
| Objection | knex の上の「関係つきクエリビルダ」[16] | Model クラス ＋ 任意で JSON Schema | 手書きの型 | knex |
| Zapatos | 「Zero-Abstraction」[23] | 生きた DB | **生成**（DB から） | `sql` タグ |
| PgTyped | 生 SQL | 生きた DB | **生成**（`.sql`／TS 内の SQL を DB に問い合わせて型を出す）[24] | SQL が本体 |
| sqlc（TS） | 生 SQL | `schema.sql` | **生成**（WASM の plugin、early access）[25] | SQL が本体 |
| Slonik | 生 SQL を推す・動的な SQL 生成を嫌う [26] | なし | `sql.type(zod)` で**実行時の検証**と型 | SQL が本体 |
| postgres.js | ドライバ（tagged template） | なし | 行の型は手で付ける | SQL が本体 |
| Effect SQL | tagged template ＋ Effect の Schema | なし | Schema から | SQL が本体 |
| ZenStack v3 | Prisma 互換の ORM API ＋ Kysely ＋ アクセス制御 [37] | ZModel（Prisma 互換） | **生成** | Kysely |
| Kanel | 型の生成だけ（「ORM が嫌いな人向け」）[27] | 生きた DB | **生成** | — |

### 型の重さ（公式の記述・issue）

- **Kysely**：公式の recipe に「Type instantiation is excessively deep（TS2589）への対処」がある。例として `with` を 13 個つなぐと TS2589 になり、`$assertType` で型を平らにして逃げると書く [28]。
- **Drizzle**：「drizzle の型が TS の検査を長く遅らせる」#870（closed）、drizzle-zod の TS2589 #3869、drizzle-valibot #3751、drizzle-typebox #4980 [29]。npm に `rqb-typeperf`・`rqb-perf-patch` の dist-tag があり、型の速さの作業が続いている [3]。
- **Prisma**：「Client Extensions が TS のコンパイルと IntelliSense を壊す」#23369、「`$extends` を重ねると TS2589」#26697（open）[29]。8 では `$extends` を作らず middleware に替えると明言 [19]。
- **MikroORM・TypeORM・ZenStack**：title に "excessively deep" の issue が数件ずつ（件数は search API の粗い値）[29]。
- tsc の速さを公式に測った数値は、どの道具でも見つけられなかった（未確認）。

## 3. Postgres の機能

○＝公式に書いてある、△＝一部・回り道、×＝無いと公式に書いてある／open の要望、？＝未確認。

| 機能 | Prisma 7 | Prisma 8 RC | Drizzle | Kysely | MikroORM 7 | TypeORM | 生 SQL 系（PgTyped・sqlc・Slonik・postgres.js・Zapatos） |
|---|---|---|---|---|---|---|---|
| JSONB | △ 型付けの要望 #3219（1,094 reactions、open）[30] | △ 列の比較だけ。JSON の中のフィルタは不可 [19] | ○（RC.5 で codec を変更）[14] | ○ `jsonArrayFrom` などの helper [22] | ？ | ？ | ○（SQL のまま） |
| 配列 | ○ `has` など | △ 列は可、`has`／`hasSome` のフィルタは不可 [19] | ○ `.array()` [14] | ○ | ？ | ？ | ○ |
| CTE | × ORM では不可（raw／TypedSQL） | ？ SQL ビルダの参照に CTE・window の記載なし [20] | ○ `$with`（未確認：頁は読んでいない） | ○ `with`・`withRecursive` [22][31] | Kysely 経由 | ？ | ○ |
| window | × | ？ [20] | △ `sql` で書く（未確認） | ○ `over()` [31] | Kysely 経由 | ？ | ○ |
| `DISTINCT ON`・LATERAL | ？ | ○ `distinctOn()`・`lateralJoin()` [20] | ？ | ○ `distinctOn` [22] | ？ | ？ | ○ |
| RLS | × | ○ policy を contract に書ける。ただし role・`GRANT`・`FORCE RLS` は対象外 [32] | ○ RLS の頁あり [13] | —（DDL を持たない） | ？ | ？ | 手で |
| 拡張 | △ | ○ pgvector・PostGIS・ParadeDB など。migration が要る拡張を宣言 [32][33] | ○ 拡張の頁あり [13] | — | ？ | ？ | 手で |
| トリガ・関数 | × | × contract の外、raw SQL の手順で [32] | × #843（562 reactions、open）[30] | — | ？ | ？ | 手で |
| パーティション | ？ | ？ | × #2854（199、open）[30] | — | ？ | ？ | 手で |
| 式・部分 index | 部分 index は 7.4 [10] | ○。ただし index 内の並び順は不可（#30270）[32] | ○ | — | ？ | × `NULLS NOT DISTINCT` #9827 open [30] | 手で |
| public 以外の schema | ○ | ○ `namespace`。ただし `contract infer` は public だけ（#30573）[20][32] | ○ | ○ | ？ | ？ | ○ |
| PostGIS | × #2789（1,098、open）[30] | ○ 拡張パッケージ [33] | ？ | — | ？ | ？ | ○ |

## 4. マイグレーション・ロールバック

| 道具 | 作り方 | ロールバック | 公式の記述・要望 |
|---|---|---|---|
| Prisma 7 | 宣言（schema）から差分の SQL | down なし | — |
| Prisma 8 RC | contract の差分から **TypeScript の `migration.ts`**（編集して再コンパイル）。各操作に `precheck`／`postcheck`・`operationClass`。DB に「どの contract に合っているか」のハッシュを記録し、`db verify` で照合。ブランチの合流は「migration graph」で扱う [18][34] | **down を作らない方針**。「前の contract の状態へ向かう新しい migration」を `migration plan --from X --to "X^"` で作る（git revert の考え）。破壊的な操作は plan で確認を求め、`db migrate` は確認なしで流す [34] | — |
| Drizzle Kit | TS のスキーマから SQL を生成、`push`・`pull`・`check` | なし | Rollback の要望 #2352（201、open）、TS で書く migration #2695（44、open）、衝突した migration の統合 #2488（52、open）[30] |
| Kysely | 手書きの `up`／`down`（Migrator、kysely-ctl）[35] | 手書きの `down` | トランザクションの外で流す migration（`CREATE INDEX CONCURRENTLY` 用）#352（30、open）[30] |
| TypeORM | エンティティから生成 | 手書きの `down` | 「生成が列を ALTER せず DROP→ADD してデータを失う」#3357（121、open）[30] |
| Sequelize | 手書き | 手書きの `down` | 「モデルから migration を生成」#120（162、2012 年から open）[30] |
| ZenStack v3 | **Prisma Migrate を包んだだけ**（ZModel から Prisma のスキーマを作って `prisma` CLI を呼ぶ）[36] | Prisma 7 と同じ | — |
| PgTyped・sqlc・Slonik・Zapatos・Kanel | 持たない（外部の道具を使う） | — | — |

## 5. AI 向けの取り組み

| 道具 | llms.txt | AI 用の文書・skill | MCP | エージェント向けの機能 |
|---|---|---|---|---|
| Prisma | ○ 領域ごとに分けた索引。冒頭で「学習データを信じず changelog.md を先に読め」と指示。全頁に `.md` 版 [11] | ○ Agent Skills：7 用は `prisma/skills`、**8 用は `@prisma/orm-*` パッケージに同梱**し `prisma init` で入れる [38] | ○ 公式（`https://mcp.prisma.io/mcp`、リモート）。ただし対象は **Prisma Postgres・Compute・Object Storage の管理** [39] | 6.15 で AI エージェント（Claude Code・Cursor 等）から `migrate reset --force` を呼ぶと確認を求める [40]。8 のエラーは `NAMESPACE.SUBCODE` の構造化（`why`・`fix`・`docsUrl`）と CLI の終了コードの決まり [41]。`lints` middleware（WHERE なしの DELETE／UPDATE を既定で止める等）[42]。エージェント用の別の資格情報と承認のポリシー（2026-10-02）[43] |
| Drizzle | ○（38KB）[13] | AI 用の頁なし（llms.txt に該当なし）[13] | 公式なし（`drizzle-team` org に MCP の repo なし）[1] | npm に `ai` という dist-tag（1.0.0-rc.3-…）があるが中身は未確認 [3] |
| Kysely | ○ `llms.txt`・`llms-full.txt`、全頁に AI 向けの案内の行 [21][28] | 「LLMs」の頁（llms.txt の使い方）[21] | なし | API の説明を型定義のファイルに書く方針（README）[22] |
| MikroORM | ○（110KB）[44] | ？ | なし（未確認） | — |
| TypeORM | ○ [45] | ？ | なし（未確認） | — |
| ZenStack | ×（404） | ？ | なし。「MCP サーバ用のスキーマ生成」の要望 #2277 が open [30] | — |
| Effect・Sequelize・sqlc・PgTyped・Zapatos・Kanel・Slonik | ×（404 か未提供） | ？ | なし（未確認） | — |

## 6. 公式の issue に繰り返し出る弱点（reactions の多い open の issue）[30]

- **Prisma**：DynamoDB 対応 #1676（**1,401**、2020 年から open）、PostGIS #2789（1,098）、Json の中身の型 #3219（1,094）、仮想の計算フィールド #3394（890）、Union 型 #2505（684）、`upsertMany` #4134（621）、複数の DB 接続 #2443（523）。8 は大きく作り直したが、JSON の中のフィルタ・`increment`・ネストした書き込みの大半・分離レベル・read replica などが「まだ無い」[19]。
- **Drizzle**：トリガ #843（562）、テーブル・列のコメント #886（287）、関係つきのモデル型の推論 #695（247）、**まともなエラー処理とラップ #376（217、2023 年から open）**、ロールバック #2352（201）、パーティション #2854（199）。v1 は RC が半年続き、RC でも破壊的変更が入る [5][14]。
- **Kysely**：非トランザクションの migration #352、複数文の実行 #904、生クエリの stream #1403。ORM の機能（関係・DDL の差分）は持たない方針 [22]。
- **TypeORM**：migration の生成でデータを失う #3357、relations の多いクエリの性能 #3857、`findOne` が 2 回問い合わせる #5694。
- **Sequelize**：モデルからの migration 生成 #120、複合外部キー #311。v7 が alpha のまま。
- **PgTyped**：動的なクエリが書けない #170・#273、空の配列の引数 #221。**sqlc**：動的なクエリ #3414、動的な `ORDER BY` #2061。生 SQL から型を出す道具は、条件で形が変わるクエリが共通の弱点。
- **postgres.js**：OpenTelemetry #461、`TransactionSql` の型 #1150。

## 7. その他（2025〜2026 に目立つもの・隣接するもの）

- **Prisma ORM 8（旧 Prisma Next）**：2025-10-31 に `prisma/prisma-next` として作られ、現在はアーカイブ。「Prisma ORM v8 として `prisma/prisma` で開発を続ける」と記す [12]。今回の調査で最も重要な新顔。
- **SafeQL**（`ts-safeql/safeql`、1,570 star、`@ts-safeql/eslint-plugin` 週 24k）：生 SQL を Postgres に照らして検証し型を出す ESLint plugin [1][2]。
- **Orchid ORM**（543 star、週 3.5k、1.78.37 を 10-22 に公開）[1][2][3]。
- 2025 年以降に作られ star 100 を超える TS の ORM・クエリビルダは、GitHub の検索ではほぼ無い。目立つのは `better-drizzle`（380、2026-06）、`sumak`（127、AST-first のクエリビルダ、週 8 DL）程度 [1][2]。
- 隣接（マイグレーション）：pgroll（6,608）、Atlas（8,794）、graphile-migrate（835）[1]。
- 隣接（DynamoDB）：ElectroDB（1,180 star、週 372k）、dynamodb-toolbox（2,002 star、週 80k）[1][2]。上の Postgres 系の道具で DynamoDB を扱うものは無い。

---

## 8. 考察：AI に最適化した新しい道具が入れる空き

ここからは上の事実をもとにした推論。

1. **最大の競合は Prisma 8 で、「AI 向け」の看板の一部は既に取られている。** 構造化エラー（`why`／`fix`）、決定的な生成物（`contract.d.ts` をコミット）、DB と contract のハッシュの照合、migration の precheck／postcheck、クエリの lint、パッケージに同梱した skill。どれもエージェントに効く。新しい道具は「AI 向け」を名乗るだけでは差にならず、Prisma 8 が手を付けていない所を取りに行く必要がある。
2. **「Postgres 完全互換」は、まだ誰も埋めていない。** Prisma 8 は RC の時点で、トリガ・関数・role・`GRANT`・`FORCE RLS`・index の並び順・public 以外の introspection・JSON の中のフィルタ・CTE や window の記載がない。Drizzle はトリガ・パーティション・コメントが長く open。Kysely は DDL を扱わない。**Postgres のカタログ全体（policy・grant・trigger・function・partition・comment・複数の schema）を宣言と差分の対象にする**ことは、はっきりした空き。
3. **ロールバックの扱いが割れている。** Prisma 8 は down を作らない（前の状態への新しい migration）、Drizzle は無い（201 reactions）、Kysely・TypeORM・Sequelize は手書きの down。エージェントは「戻せる」ことを確かめたい。**データを失うかどうかの分類と、戻す手順の自動生成・検証（適用して戻して差分ゼロを確かめる）**は差になりうる。
4. **型の重さは、推論型の構造的な弱点。** Kysely は公式に TS2589 の回避策を書き、Drizzle・Prisma（`$extends`）にも issue がある。Prisma 自身が 8 で生成（emit）に寄せた。エージェントにとっては、平らで読める生成物の型と短い型エラーの方が扱いやすいと考えられる。**生成を基本にしつつ、生成物を小さく保つ**設計が合う。tsc の速さを公式に測った道具が見当たらないので、ベンチマークを公開すること自体も差になる。
5. **生 SQL の型安全が中途半端。** Prisma 8 は TypedSQL を外し、raw は `.returns()` で型を手で付ける。Drizzle も `sql<T>` で手書き。DB に問い合わせて型を出す PgTyped・Zapatos は 2025 年で更新が止まり、sqlc の TS は early access、SafeQL は lint の位置づけ。エージェントは SQL を書くのが得意なので、**生 SQL を DB（あるいは shadow DB）に照らして型と誤りを返す道を第一級にする**ことは空き。PgTyped・sqlc が抱える「動的なクエリ」の弱点を、ビルダとの合成で解けるかが鍵になる。
6. **Prisma の AI 機能は自社の基盤に寄っている。** MCP は Prisma Postgres・Compute の管理用で、リモート。Aurora PostgreSQL や RDS の利用者には効かない。**どの Postgres でも手元で動く、スキーマ・計画・`EXPLAIN`・migration の計画を返す MCP や CLI の JSON 出力**には空きがある。他の道具は llms.txt 止まりか、それも無い。
7. **DynamoDB は需要がはっきりしていて、誰も満たしていない。** Prisma の reactions 最多の issue（1,401）が DynamoDB で、2020 年から open。ただし Postgres 系の道具で扱うものは無く、DynamoDB は ElectroDB・dynamodb-toolbox に分かれている。single-table 設計はリレーショナルとモデルが違うので、「同じ API」よりも「同じ contract・同じ検証と migration の考え方」で揃える方が現実的と考える（要検証）。
8. **既存勢の不安定さも機会。** Drizzle は v1 の RC が半年続き、RC でも破壊的変更が入り、コミットは 4 人前後に集中。Prisma は 7 から 8 へ API と CLI を総入れ替えし、利用者に移行の負担がかかる。Sequelize v7・PgTyped・Zapatos は止まりかけ、Objection は repo の分裂。**「今後も API を変えない」と約束できる小さな中核**は、エージェントが学習済みの知識で書けることにもつながる（Prisma 自身が llms.txt で「学習データを信じるな」と書いているのは、その裏返し）。

## 出典

1. GitHub REST API `https://api.github.com/repos/{owner}/{repo}`（取得 2026-10-24。prisma/prisma→prisma/orm、drizzle-team/drizzle-orm、kysely-org/kysely、mikro-orm/mikro-orm、typeorm/typeorm、sequelize/sequelize、Vincit/objection.js、jawj/zapatos、adelsz/pgtyped、sqlc-dev/sqlc、sqlc-dev/sqlc-gen-typescript、gajus/slonik、porsager/postgres、Effect-TS/effect、zenstackhq/zenstack、kristiandupont/kanel、ts-safeql/safeql、romeerez/orchid-orm、xataio/pgroll、ariga/atlas、graphile/migrate、almeidazs/better-drizzle、productdevbook/sumak、tywalch/electrodb、dynamodb-toolbox/dynamodb-toolbox）と `https://api.github.com/orgs/drizzle-team/repos`・`search/repositories`
2. npm downloads API `https://api.npmjs.org/downloads/point/last-week/{package}`（取得 2026-10-24、窓 2026-10-12〜10-18）
3. npm registry `https://registry.npmjs.org/{package}`（取得 2026-10-24）
4. GitHub REST API `https://api.github.com/repos/{owner}/{repo}/commits?since=2026-07-24T00:00:00Z`・`/releases`（取得 2026-10-24）
5. https://github.com/drizzle-team/drizzle-orm/releases
6. https://www.prisma.io/docs/llms/orm.txt
7. https://github.com/mikro-orm/mikro-orm/releases/tag/v7.0.0
8. https://mikro-orm.io/blog/mikro-orm-7-released
9. https://github.com/prisma/orm/releases/tag/7.0.0
10. https://www.prisma.io/changelog.md
11. https://www.prisma.io/docs/llms.txt
12. https://www.prisma.io/docs/orm/release-status.md ・ https://github.com/prisma/prisma-next
13. https://orm.drizzle.team/llms.txt
14. https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.5
15. https://github.com/typeorm/typeorm/releases/tag/1.0.0
16. https://github.com/ditojs/objection （README）
17. https://github.com/Effect-TS/effect/tree/main/packages/sql/pg （README）
18. https://www.prisma.io/docs/orm/core-concepts.md
19. https://www.prisma.io/docs/orm/coming-from-prisma-orm-7.md
20. https://www.prisma.io/docs/orm/reference/sql-query-builder.md
21. https://kysely.dev/llms.txt
22. https://github.com/kysely-org/kysely （README）・ https://kysely.dev/llms-full.txt
23. https://github.com/jawj/zapatos （README）
24. https://github.com/adelsz/pgtyped （README）
25. https://github.com/sqlc-dev/sqlc-gen-typescript （README）
26. https://github.com/gajus/slonik （README）
27. https://github.com/kristiandupont/kanel （README）
28. https://kysely.dev/docs/recipes/excessively-deep-types.md
29. GitHub issues：drizzle-team/drizzle-orm #870・#3869・#3751・#4980、prisma/orm #23369・#26697（`https://api.github.com/search/issues`、取得 2026-10-24）
30. GitHub issues（open・reactions 順、取得 2026-10-24）：prisma/orm #1676・#2789・#3219・#3394・#2505・#4134・#2443、drizzle-team/drizzle-orm #843・#886・#695・#376・#2352・#2854・#2488・#2695、kysely-org/kysely #352・#904・#1403、typeorm/typeorm #3357・#3857・#5694・#9827、sequelize/sequelize #120・#311、adelsz/pgtyped #170・#273・#221、sqlc-dev/sqlc #3414・#2061、porsager/postgres #461・#1150、zenstackhq/zenstack #2277
31. https://github.com/kysely-org/kysely/blob/master/src/query-builder/aggregate-function-builder.ts （`over`）・ https://github.com/kysely-org/kysely/blob/master/src/query-creator.ts （`withRecursive`）
32. https://www.prisma.io/docs/orm/contract-authoring/advanced-postgresql.md
33. https://www.prisma.io/docs/orm/supported-databases.md
34. https://www.prisma.io/docs/orm/migrations/rollbacks-and-recovery.md
35. https://kysely.dev/docs/migrations.md
36. https://github.com/zenstackhq/zenstack-docs/blob/main/docs/orm/migration.md
37. https://github.com/zenstackhq/zenstack （README）
38. https://www.prisma.io/docs/ai/tools/skills.md
39. https://www.prisma.io/docs/ai/tools/mcp-server.md
40. https://github.com/prisma/orm/releases/tag/6.15.0
41. https://www.prisma.io/docs/orm/reference/error-reference.md
42. https://www.prisma.io/docs/orm/middleware/built-in-lints.md
43. https://www.prisma.io/docs/prisma-compute/agent-enrollment.md
44. https://mikro-orm.io/llms.txt
45. https://typeorm.io/llms.txt
