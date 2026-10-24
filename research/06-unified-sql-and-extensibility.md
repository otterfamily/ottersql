# 06. NoSQL を SQL のように扱う試み・複数の DB を扱う拡張の仕組み・能力の表（2026-10-24 時点）

目的：「NoSQL（DynamoDB など）と RDB（Postgres・Aurora）を SQL のように、ほぼ互換に扱い、独自にカスタマイズできる」TS の道具を設計する前に、既存の言語・エンジン・TS のライブラリがどこで線を引いているかを一次資料で確かめる。
1〜3 は事実（出典の番号は末尾）。4 は考察。DynamoDB の PartiQL の細部は `03-dynamodb-ts7-ai-design.md` にあるので、ここでは要点だけを引く。

## 要点

- **言語の側は「書ける」と「速い」を分けていない。** SQL++・PartiQL・Cosmos DB の SQL は SQL に近い文法で書けるが、キー・索引に乗らない問い合わせは全件の走査・全パーティションへの分散になる。違いを見せる手段は、拒否（Cassandra の `ALLOW FILTERING`、Firestore Standard の索引の要求、Couchbase の索引なしのエラー）か、費用の表示（Cosmos の RU、Firestore Enterprise の Query Explain）か、権限（DynamoDB の `FullTableScan`）のどれか [10][11][12][15][17][18]。
- **エンジンの側は「押し下げられなければ自分で処理する」。** Calcite・Trino・GlueSQL・Steampipe は、下の DB にできない操作をエンジンが引き取る。結果は正しいが、費用は見えにくい。Trino は `EXPLAIN` に残る演算子で「押し下げられなかった」ことを見せる [20][24][25][28][30]。
- **TS の道具は、方言の差を「型で隠す」より「別の入口に分ける」方向に動いている。** Drizzle は方言ごとに `*-core` を分け、Prisma 8 は SQL と MongoDB を別の family にし、さらに「能力」を契約に書いて、能力の無いメソッドは存在しない（型に出ない）ようにした [37][39][42]。Kysely は能力を5つの真偽値しか持たず、ほとんどは文書の注記に任せる [31]。Knex は対応しない `returning()` を警告だけ出して無視する [49]。
- **能力の表の設計は Prisma 8 の ADR が一番詳しい。** 名前空間の付いた能力のキー（`core.*`・`sql.*`・`ext.<pack>.*`）、静的と接続時の検出、強制の on/off、契約と照合した hash、能力が無いときは「required なら決まったコードで失敗」[40][41]。Trino は SPI の能力は DDL の4つだけで、押し下げは `apply*` が `Optional.empty()` を返す形で表し、能力の宣言はテスト用の列挙（含意の関係つき）で共通のテストに通す [25][26][27]。

---

## 1. NoSQL を SQL のように扱う既存の試み

### 1.1 言語

| 言語 | 何をしたか | どこまで SQL か | 性能の差の見せ方・拒否 | 出典 |
|---|---|---|---|---|
| SQL++（論文 2014、UCSD） | SQL と JSON の両方を覆うデータモデル。SQL と後方互換にし、追加は少数。**意味の違い（欠けた属性・型の混在）を「設定の項目」にし、設定しだいで SQL・MongoDB・CQL・N1QL・AQL の意味を再現できる** | 構文と意味を形式的に定義 | 言語としては扱わない（実装に任せる） | [1] |
| SQL++（AsterixDB） | 「SQL とほぼ後方互換」。`NULL`（値が null）と `MISSING`（属性が無い）を分ける。入れ子を扱う新しい JOIN・入れ子の GROUP BY | JOIN・GROUP BY あり | — | [2] |
| SQL++（Couchbase、旧 N1QL） | DDL・DCL・DML を持つ。ANSI JOIN・NEST | JOIN・集計あり | primary index は「他の索引も経路も使えないとき」の全件走査で、**本番の問い合わせに使うことを勧めない**。nested-loop の JOIN は右側に secondary index が要る。hash join は Enterprise だけで、Community は `USE HASH` を**黙って無視**する。索引が無いときのエラーの公式の記述は見つけられなかった（**未確認**。フォーラムでは "No index available on keyspace"） | [3][4][5][6] |
| PartiQL（仕様 2019-08-01 の草案、Amazon） | 「入れ子のデータを話す SQL」。保存の形式と問い合わせの意味を切り離す。仕様は「core（関数型）」と「SQL の構文糖（core に還元）」の2層。`NULL` と `MISSING` を分ける。**permissive モード**（型の誤りは `MISSING`）と**型検査モード**（失敗させる）を選べ、スキーマがあればコンパイル時の誤りにできる | JOIN・LATERAL・GROUP BY・PIVOT まで仕様にある | 仕様は性能を扱わない。DynamoDB の実装は部分集合で、WHERE に分割キーの `=`/`IN` が無いと Scan、IAM `dynamodb:FullTableScan` で拒否できる | [7][8][10] |
| PartiQL の実装 | Kotlin の参照実装（v1.6.1、2026-09-03、547 star）と Rust（v0.15.0、2026-10-02）。使う側として DynamoDB・Redshift・IoT TwinMaker を挙げる | — | — | [7][9] |
| Azure Cosmos DB（NoSQL の SQL） | `JOIN` は**1つの項目の中の配列との自己結合だけ**で、項目・コンテナをまたげない。またぐ必要があればデータの形を見直せ、と書く | JOIN は項目内のみ | 分割キーの等号が無いと全物理パーティションへ分散（索引は使う）。物理パーティションごとに約 2.5 RU の最低料金。30,000 RU 超・100 GB 超なら避けよと数値で示す。代わりに global secondary index | [11][12] |
| MongoDB SQL Interface（Atlas SQL、MongoSQL） | 「SQL-92 互換」の方言を MQL に訳す。**読み取り専用**で、ODBC/JDBC の BI 道具（Tableau・Power BI）向け。対応付けに JSON のスキーマが要り、静的な型検査で合わない問い合わせはコンパイルで落とす | `date` 型・interval・`INTERSECT`/`EXCEPT` なし | 性能の記述は無い | [13][14] |
| Cassandra の CQL | 既定では**全パーティションの走査になる SELECT を拒否**。`ALLOW FILTERING` で明示すると全件を走査し、「性能は予測できない」。分割キーは等号（と IN）だけ、クラスタ列は連続した範囲だけ。JOIN・サブクエリなし | 単一の表 | 拒否＋明示の句 | [15] |
| ScyllaDB の CQL | 同じ。`ALLOW FILTERING` が無ければ「費用が返す量に比例する」問い合わせだけを許す。GROUP BY は主キーの接頭辞だけ | 単一の表 | 同上 | [16] |
| Firestore | Standard：**すべての問い合わせに索引が要り**、無いとエラー（索引を作るリンク付き）。性能は「結果の件数に比例し、DB の件数に比例しない」。Enterprise：索引は任意で、無いと**コレクション全体の走査**。pipeline の操作で集計・相関サブクエリによる JOIN もできる。GA かどうかはページに表示が無い（**未確認**） | Enterprise の pipeline で拡張 | Standard は拒否、Enterprise は Query Explain で見せる | [17][18] |
| Spanner | 分散の RDB。GoogleSQL と PostgreSQL の2方言（DB ごとに1つ）。pipe 構文は GoogleSQL だけなど方言の差の一覧を公式が持つ | 完全な SQL | （本調査の範囲外） | [19] |

### 1.2 エンジン

| エンジン | 押し下げの仕組み | 押し下げられないとき | 出典 |
|---|---|---|---|
| Apache Calcite | adapter は `SchemaFactory` と `Table`。簡単には `FilterableTable`/`ProjectableFilterableTable` で filter・project を渡す。JOIN・集計・並べ替えまで渡すには planner の規則（`RelOptRule`）と calling convention を書き、費用で計画を選ぶ。MongoDB の adapter が持つ規則は Sort・Filter・Project・Aggregate の4つ | **enumerable convention（Calcite 自身の実行）に落ちる**。MongoDB の JOIN は Calcite が処理する | [20][21] |
| Trino | `ConnectorMetadata.applyFilter/applyProjection/applyLimit/applyTopN/applyAggregation/applyJoin`。できなければ `Optional.empty()`。filter は一部だけ受けて「残り」を返せる。limit は「保証できるか」を `limitGuaranteed` で返す。並べ替えを受けられないときは無視か `INVALID_ORDER_BY` で拒否 | Trino が処理し、`EXPLAIN` に `ScanFilterProject`・`Aggregate`・`Join`・`TopN` が残る。公式文書は「残っていれば押し下げられていない明白な印」と書く | [24][25] |
| GlueSQL（Rust、3,132 star、v0.20.0） | 必須の `Store`（読み）・`StoreMut`（書き）と、任意の `Index`・`IndexMut`・`AlterTable`・`Transaction`・`Metadata`・`CustomFunction`。任意の trait の既定の実装は `"... is not supported"` の実行時のエラーを返す。storage は memory・sled・redb・json・csv・parquet・mongo・redis・git・composite など | JOIN・集計はエンジンが行う | [28] |
| DuckDB の postgres 拡張（2.0 の文書） | `pg_enable_filter_pushdown`（既定 on）。`CONNECT` 中は remote pushdown optimizer が問い合わせを Postgres へ送る。生の SQL の抜け道として `postgres_query`（読み）・`postgres_execute`（書き・DDL） | DuckDB が処理 | [29] |
| Steampipe（Postgres の FDW、v2.4.8） | 表ごとに `KeyColumns`（`Required`/`Optional`）と演算子を宣言し、WHERE の条件（quals）を API の引数へ写す。quals がキー列に合うかで `Get` と `List` を選ぶ。LIMIT は plugin が `d.QueryContext.Limit` を読んで自分で使う | 必須のキー列が無いときの動作は文書に無い（**未確認**） | [30] |

### 1.3 事実のまとめ

- 押し下げの線は、どこも「主キー・分割キーの等号（と並べ替えキーの範囲）」「射影」「件数の上限」までは素直に下ろせ、それ以外（キー以外の条件・JOIN・集計・任意の並べ替え）は、下の DB しだいで拒否・全件走査・エンジン側の処理に分かれる [10][12][15][20][24]。
- 同じ SQL で性能がまったく違う問題の見せ方は4通り：(a) 既定で拒否し、明示の句で許す（CQL）[15]、(b) 索引が無ければ拒否（Firestore Standard、Couchbase）[4][17]、(c) 実行はするが費用・計画で見せる（Cosmos の RU、Trino の EXPLAIN、Firestore Enterprise の Query Explain）[12][18][24]、(d) 権限で拒否（DynamoDB の IAM）[10]。
- 黙って意味・性能を変える例もある：Couchbase Community の `USE HASH` の無視 [5]、Knex の MySQL での `returning()` の無視（警告だけ）[49]。

## 2. 1つの API で複数の DB を扱う TS のライブラリの拡張の仕組み

| 道具 | 方言の単位 | 方言の差の扱い | 独自の型 | 独自の演算子・関数 | クエリの書き換え・フック | NoSQL | 出典 |
|---|---|---|---|---|---|---|---|
| Kysely 0.29 | `Dialect`＝`createDriver`・`createQueryCompiler`・`createAdapter`・`createIntrospector` の4つ | `DialectAdapter` の真偽値は `supportsCreateIfNotExists`・`supportsMultipleConnections`・`supportsTransactionalDdl`・`supportsReturning`・`supportsOutput` の5つと、マイグレーションの lock。`supportsReturning` は結果の形の判定に使うだけ。builder のメソッドはどの方言でも型に出て、差は JSDoc の注記（「PostgreSQL では `returning` が要る」など） | `Expression<T>` を実装するか、`sql` タグの `RawBuilder<T>` を関数で包む | 同左（公式は「汎用に作るのが難しいものは、自分の小さな helper を作れ」） | `KyselyPlugin`＝`transformQuery`（操作の木を書き換える）・`transformResult`。組み込みは CamelCase・DeduplicateJoins・in () の扱い・null の比較など。継承は勧めず、module augmentation は「支えない」 | 公式・組織・コミュニティの方言の一覧に NoSQL・DynamoDB・PartiQL は無い（S3 Select と SurrealDB はある） | [31][32][33][34] |
| Drizzle（1.0 RC、`beta` ブランチ） | `pg-core`・`mysql-core`・`sqlite-core`・`mssql-core`・`singlestore-core`・`cockroach-core`・`effect-core` を分け、driver は別のディレクトリ | 方言ごとに表の定義の関数・列の型が別。方言をまたいで同じ表の定義を使う仕組みは無い | `customType<{ data; driverData; config }>`（`dataType`・`toDriver`・`fromDriver`）。各 `*-core` にある | `sql<T>` のテンプレート。`sql<T>` は実行時に変換しないので、`.mapWith()` で写す | （本調査で専用のフックの文書は未確認） | 無し | [35][36][37] |
| Prisma 8（RC） | **family**（SQL・MongoDB）→ target → adapter。family ごとに契約の保存の層・実行・マイグレーションを持つ | **能力**を adapter が報告し、契約に記録する。builder と ORM は契約を読んで、**能力の無いメソッド・選択肢を出さない**（例：行の lock の7つの能力。Postgres は7つ、SQLite は0）。renderer は対応できない節を「落とさず、拒否する」 | extension pack が型・codec を足す（ADR 114・202 など） | 関数・演算子の registry（署名・null の規則・volatility を持ち、型を推論する）[43] | **`$extends` を廃止**（2026-10-22 の ADR）。代わりに runtime の middleware（ログ・キャッシュ・追跡・**クエリの書き換え**）、package によるコレクションのメソッドの追加、アプリのコレクションのクラス | MongoDB は別の family。DynamoDB は無い（`03` を参照） | [39][40][41][42][43] |
| Prisma 7（現行の GA） | provider ごと | `previewFeatures`（`relationJoins`・`typedSql`・`views` など）を generator に書く | — | — | `$extends`（model・client・query・result の4種）。7 の文書に「8 では DB の能力を足す extension と、すべての問い合わせを包む middleware に替わる」と注記 | 7 で MongoDB への対応をやめた（`03`） | [38][45] |
| MikroORM 7 | driver（postgresql・mysql・mariadb・sqlite・libsql・mssql・oracledb・pglite・mongodb など） | `Platform` に `supportsTransactions`・`usesReturningStatement`・`supportsNativeEnums`・`supportsDownMigrations`・`supportsRowLevelSecurity` など28 の能力のメソッド（実行時の分岐） | （本調査の範囲外） | — | — | MongoDB は同じ `EntityManager` の形だが、`em.aggregate()` などは MongoDB の `EntityManager` に型を寄せる必要がある。トランザクションは replica set が必須 | [46][47] |
| Effect SQL（`effect` 4.x） | `Dialect = "sqlite" \| "pg" \| "mysql" \| "mssql" \| "clickhouse"`（閉じた union）と方言ごとの `Compiler` | `sql.onDialect({...})`（全方言を必須）・`sql.onDialectOrElse({...})` で方言ごとに値を分ける。ライブラリ自身も migration・model でこれを使う | `Custom` の fragment を compiler が描く | 同左 | — | 無し | [48] |
| Knex | 方言ごとの compiler | 対応しない機能は例外（view の一部）か、警告して無視（MySQL の `returning()`） | — | — | — | 無し | [49] |

事実のまとめ：
- 方言の差を **型** で表すのは、調べた中では Prisma 8 だけ（能力を契約に書き、無いメソッドは型に出ない）[42]。Kysely・MikroORM・Knex は実行時の分岐か文書の注記 [31][46][49]。Effect は差を利用者の分岐（`onDialect`）に出す [48]。
- 独自のカスタマイズの入口は、どこも (1) 値の型と変換（codec・customType・Expression）、(2) 生の SQL の断片を型付きで包む、(3) 実行の前後のフック（plugin・middleware）の3つに集まる [34][35][39][43]。Prisma 8 はさらに (4) pack（型・演算子・能力・migration の操作・lint の規則をまとめて足す）を持つ [41][43][44]。

## 3. 能力（capabilities）で方言の差を表す設計の例

| 例 | 単位 | 値 | 誰が決める | 足りないとき | 出典 |
|---|---|---|---|---|---|
| Calcite `SqlConformance` | 文法・検証の許し（`isGroupByAlias`・`isLimitStartCountAllowed`・`isApplyAllowed`・`isBangEqualAllowed` など約37） | 真偽値。`SqlConformanceEnum` に `STRICT_92`・`PRAGMATIC_2003`・`BIG_QUERY`・`MYSQL_5`・`PRESTO`・`LENIENT` などの組 | 利用者が組を選ぶ。独自の組は `SqlAbstractConformance`・`SqlDelegatingConformance` から作れと勧める | 検証で拒否 | [22] |
| Calcite `SqlDialect` | SQL を生成するときの差（`supportsWindowFunctions`・`supportsJoinType`・`supportsAggregateFunction(kind)`・`supportsFunction(...)`・`supportsDataType` など） | 真偽値（引数つきもある） | adapter（JDBC） | 押し下げず Calcite が処理 | [20][23] |
| Trino `ConnectorCapabilities` | DDL の4つだけ（`DEFAULT_COLUMN_VALUE`・`NOT_NULL_COLUMN_CONSTRAINT`・materialized view の2つ） | 集合 | connector | DDL を拒否 | [26] |
| Trino の押し下げ | `apply*` の戻り値（`Optional.empty()`・残りの filter・`limitGuaranteed`） | 問い合わせごとの交渉 | connector | エンジンが処理 | [25] |
| Trino `TestingConnectorBehavior` | 84 の振る舞い（`SUPPORTS_PREDICATE_PUSHDOWN_WITH_VARCHAR_INEQUALITY`・`SUPPORTS_AGGREGATION_PUSHDOWN_COUNT_DISTINCT`・`SUPPORTS_JOIN_PUSHDOWN_WITH_FULL_JOIN` など） | 真偽値。**含意の関係**を持つ（例：`SUPPORTS_TOPN_PUSHDOWN_WITH_VARCHAR` は TopN と varchar の不等号の両方を前提） | connector のテスト | 共通のテストの組が、宣言と実際が合うかを確かめる | [27] |
| Prisma 8 ADR 031・065・117 | `core.*`・`sql.*`・`ext.<pack>.*` の名前空間のキー（例 `sql.lateral`・`core.transactionalDDL`・`ext.pgvector.index.hnsw`） | 真偽値・enum・semver・範囲・record | adapter の静的な能力 ∪ 接続時の検出。`forceEnable`/`forceDisable` で固定できる。能力から `profileHash` を作り、契約・DB の印と照合 | lowering で required なら `ERR_CAPABILITY_MISSING`。多文のフォールバックで黙って補わない（非目標に明記） | [40][41] |
| Prisma 8 ADR 261 | 機能の粒度を「1つのメソッド・選択肢に1つの能力」にする（行の lock の強さ・選択肢で7つ）。粒度は他の DB（MySQL・Vitess など）の表を作って決めた | 真偽値 | adapter が報告し、契約に記録 | **メソッド・選択肢が型に出ない**。renderer は拒否し、黙って落とさない | [42] |
| Prisma 8 ADR 115 | 拡張（pgvector・PostGIS）の誤用の guardrail と EXPLAIN の方針 | 規則の組 | pack | 開発・CI の preflight では厳しく、本番は静的な検査だけ。`E_EXT_CAPABILITY_MISSING` | [44] |
| Prisma 7 preview features | 機能の成熟度のフラグ | 文字列の配列 | 利用者 | フラグが無いと使えない | [45] |
| Kysely `DialectAdapter` | 5つ | 真偽値（任意） | dialect | 主に結果の形の判定 | [31] |
| MikroORM `Platform` | 28 のメソッド | 真偽値 | driver | 実行時の分岐 | [46] |
| GlueSQL の trait | 機能の群ごとの trait | 実装の有無 | storage | 実行時の "not supported" | [28] |

## 4. 考察（ここからは事実ではなく案）

### 4.1 「NoSQL と RDB をほぼ互換で SQL のように」の現実的な線

1章のどの試みも、**文法を共通にすることには成功し、性能の保証を共通にすることには失敗している**（できない所は拒否か全件走査か別のエンジン）。AI が書く前提では、「書けたが本番で全件走査」は一番見つけにくい誤りなので、線は「意味と費用の両方が同じものだけを共通にする」に引くのがよいと考える。

| 操作 | Postgres・Aurora | DynamoDB | 共通にするか | 扱い（案） |
|---|---|---|---|---|
| 主キーで1件を取る・置く・消す | 索引で O(1) | GetItem・PutItem・DeleteItem | **共通** | 同じメソッド・同じ型 |
| 分割キーの等号＋並べ替えキーの範囲・順序・件数 | 複合索引があれば同等 | Query（GSI を含む） | **共通**（契約に「アクセスパターン」を書いたものだけ） | `where` に書けるのは契約のキーの条件だけ。Postgres 側は契約から索引を生成して同じ費用を保証する |
| 条件付き書き込み（楽観ロック・存在の確認） | `UPDATE ... WHERE version = $1` | `ConditionExpression` | **共通** | 「1項目への条件」に限る。結果は「条件に合わず書かなかった」を型付きのエラーで返す |
| トランザクション | 対話的（読んで決めて書く）・行数の上限なし | 1回の要求で最大100操作・4 MB、同じ項目を2回触れない、索引には書けない、リージョン内だけ [50] | **一部だけ共通** | 共通の形は「事前に組み立てた書き込みの束（＋条件の確認）」。対話的なトランザクションは RDB 専用の API |
| ページング | keyset・offset | `LastEvaluatedKey`（1 MB ごと、filter 後は空のページもある） | **共通**（keyset だけ） | 不透明なカーソルで返す。offset は RDB 専用 |
| キー以外の条件での絞り込み | 自由（索引が無ければ seq scan） | Scan＋filter | **共通にしない** | DynamoDB では型で書けない。Scan は名前で分かる別の API（`scanAll` など）。Postgres でも「契約に無い条件」は lint で警告できる |
| JOIN | 自由 | 無し | **共通にしない** | 型で拒否。1対多は「同じ分割キーに置いた項目の集まり（single-table）」を契約に書けば、Query 1回で読む「入れ子の読み」として共通にできる余地がある（**PoC が要る**） |
| 集計・GROUP BY | 自由 | 無し | **共通にしない** | 型で拒否。必要なら書き込み時に集計を持つ（契約に宣言）か、分析は別の道（Athena・DuckDB）へ |
| エミュレーション（アプリ側で JOIN・集計） | — | 可能だが費用は全件 | **既定ではしない** | Calcite・Trino 型の「エンジンが引き取る」は正しいが費用が見えない。やるなら明示の opt-in（`.emulate()` など）にし、計画に「全件を読む」を出す |

### 4.2 型で拒否するか・別の API にするか・エミュレーションするか

- **型で拒否**：Prisma 8 の「能力が無いメソッドは型に出ない」[42] を、family の中の差（Postgres と Aurora DSQL の差など）にも使う。DSQL のように能力が年に何度も変わる DB は、静的な表と接続時の検出の両方を持ち、契約に記録して hash で照合する [40][41]。
- **別の API**：意味が違うもの（Scan・対話的なトランザクション・offset）は、名前を変える。CQL の `ALLOW FILTERING` と同じく「明示すれば許す」が AI にも人にも分かりやすい [15]。
- **エミュレーション**：黙ってしない。Knex のように「警告して無視」は AI にとって最悪の形 [49]。するなら opt-in で、計画（explain）に出し、Trino の `limitGuaranteed` のように「保証できるか」を結果に持たせる [25]。

### 4.3 独自のカスタマイズの設計の案

調べた道具の入口を合わせると、次の5つの層に分けると重ならない。

1. **値の型（codec）**：TS の型・DB の型・変換。Drizzle の `customType` [35]、Prisma 8 の codec [43] と同じ。family ごとに実装し、名前は共通。
2. **演算子・関数の registry**：署名・null の規則・必要な能力を宣言し、型の推論と能力の照合に使う（Prisma 8 ADR 113 [43]）。生の SQL の断片を型付きで包む口（Kysely の `Expression<T>` [34]）も残す。
3. **能力**：`core.*`・`sql.*`・`dynamo.*`・`ext.<pack>.*` の名前空間のキー [41]。粒度は「1つのメソッドに1つ」[42]。含意の関係を持たせ（Trino [27]）、**宣言と実際が合うかを共通のテストの組で確かめる**（Trino の BaseConnectorTest の形）。第三者の adapter でも同じテストを流せるようにする。
4. **クエリの書き換え・フック**：操作の木を受けて木を返す plugin（Kysely の `transformQuery` [32]）と、実行の前後を観測する middleware（Prisma 8 ADR 271・289 [39]）。書き換えの後にも能力の照合をもう一度通す（書き換えで能力の無い節が入るのを防ぐ）。
5. **pack**：1〜4 と migration の操作・lint の規則・EXPLAIN の方針を束ねる（Prisma 8 ADR 112〜117 [41][44]）。DynamoDB 自体も「family＋pack」として作れば、同じ仕組みで第三者が Firestore・Cosmos を足せる。

### 4.4 未確認・PoC で確かめること

- 「契約のアクセスパターンだけを `where` に書ける」型が、TS 7 で重くならないか（`03` の PoC (a) と同じ）。
- single-table の「同じ分割キーの項目の集まり」を、RDB の 1対多の入れ子の読みと同じ形で返せるか。
- 能力の照合をコンパイル時（型）と実行時（接続時の検出）の両方で持つときの、ずれの扱い（契約の hash を DB の印と照合する Prisma 8 の形 [40] で足りるか）。
- Couchbase の索引なしのエラー、Steampipe の必須のキー列が欠けたときの動作、Firestore の pipeline の GA の状態は、公式の記述を見つけられなかった。

---

## 出典

1. Ong, Papakonstantinou, Vernoux, "The SQL++ Query Language: Configurable, Unifying and Semi-structured"（arXiv 1405.3631、2014、改訂 2015）https://arxiv.org/abs/1405.3631
2. AsterixDB SQL++ manual 0.9.9 https://asterixdb.apache.org/docs/0.9.9/sqlpp/manual.html
3. Couchbase SQL++ for Query reference https://docs.couchbase.com/server/current/n1ql/n1ql-language-reference/index.html
4. Couchbase Indexing and Query Performance https://docs.couchbase.com/server/current/learn/services-and-indexes/indexes/indexing-and-query-perf.html
5. Couchbase JOIN clause https://docs.couchbase.com/server/current/n1ql/n1ql-language-reference/join.html
6. Couchbase CREATE PRIMARY INDEX https://docs.couchbase.com/server/current/n1ql/n1ql-language-reference/createprimaryindex.html
7. PartiQL https://partiql.org/
8. PartiQL Specification（草案、2019-08-01）https://partiql.org/assets/PartiQL-Specification.pdf
9. GitHub API（2026-10-24）：partiql/partiql-lang-kotlin（v1.6.1）https://github.com/partiql/partiql-lang-kotlin ・partiql/partiql-lang-rust（v0.15.0）https://github.com/partiql/partiql-lang-rust
10. 本調査の `03-dynamodb-ts7-ai-design.md`（DynamoDB の PartiQL の公式文書 [13]〜[20] をまとめたもの）
11. Cosmos DB Self-joins https://learn.microsoft.com/en-us/cosmos-db/query/join
12. Cosmos DB Query a container（in-partition / cross-partition）https://learn.microsoft.com/en-us/azure/cosmos-db/how-to-query-container
13. MongoDB SQL Interface https://www.mongodb.com/docs/sql-interface/
14. MongoSQL Language Reference https://www.mongodb.com/docs/atlas/data-federation/query/sql/language-reference/
15. Apache Cassandra CQL Data Manipulation https://cassandra.apache.org/doc/latest/cassandra/developing/cql/dml.html
16. ScyllaDB CQL SELECT https://opensource.docs.scylladb.com/stable/cql/dml/select.html
17. Firestore Index overview https://firebase.google.com/docs/firestore/query-data/index-overview
18. Firestore Enterprise pipelines overview https://firebase.google.com/docs/firestore/enterprise/pipelines-overview
19. Spanner dialect differences https://docs.cloud.google.com/spanner/docs/reference/dialect-differences
20. Apache Calcite Adapters https://calcite.apache.org/docs/adapter.html
21. Calcite MongoRules.java https://github.com/apache/calcite/blob/main/mongodb/src/main/java/org/apache/calcite/adapter/mongodb/MongoRules.java
22. Calcite SqlConformance https://calcite.apache.org/javadocAggregate/org/apache/calcite/sql/validate/SqlConformance.html
23. Calcite SqlDialect https://calcite.apache.org/javadocAggregate/org/apache/calcite/sql/SqlDialect.html
24. Trino Pushdown https://trino.io/docs/current/optimizer/pushdown.html
25. Trino Connectors（SPI の開発）https://trino.io/docs/current/develop/connectors.html
26. Trino ConnectorCapabilities.java https://github.com/trinodb/trino/blob/master/core/trino-spi/src/main/java/io/trino/spi/connector/ConnectorCapabilities.java
27. Trino TestingConnectorBehavior.java https://github.com/trinodb/trino/blob/master/testing/trino-testing/src/main/java/io/trino/testing/TestingConnectorBehavior.java
28. GlueSQL store（`core/src/store.rs`・`store/*.rs`・`storages/`、v0.20.0）https://github.com/gluesql/gluesql/tree/main/core/src/store
29. DuckDB PostgreSQL extension（2.0）https://duckdb.org/docs/2.0/core_extensions/postgres/overview.html
30. Steampipe Writing plugins https://steampipe.io/docs/develop/writing-plugins
31. Kysely `dialect.ts`・`dialect-adapter.ts`・`kysely-plugin.ts`・`insert-query-builder.ts` https://github.com/kysely-org/kysely/tree/master/src
32. Kysely Plugins https://kysely.dev/docs/plugins
33. Kysely Dialects https://kysely.dev/docs/dialects
34. Kysely recipe: Extending kysely https://github.com/kysely-org/kysely/blob/master/site/docs/recipes/0010-extending-kysely.md
35. Drizzle Custom types https://orm.drizzle.team/docs/custom-types
36. Drizzle Magic sql operator https://orm.drizzle.team/docs/sql
37. Drizzle `drizzle-orm/src`（`beta` ブランチ）https://github.com/drizzle-team/drizzle-orm/tree/beta/drizzle-orm/src
38. Prisma 7 Client extensions https://www.prisma.io/docs/orm/prisma-client/client-extensions
39. Prisma 8 ADR 289（`$extends` を持たない）https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20289%20-%20Prisma%208%20has%20no%20%24extends%20client%20extensions.md
40. Prisma 8 ADR 031（adapter の能力の検出と交渉）https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20031%20-%20Adapter%20capability%20discovery%20%26%20negotiation.md
41. Prisma 8 ADR 117（拡張の能力のキー）https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20117%20-%20Extension%20capability%20keys.md
42. Prisma 8 ADR 261（行の lock と能力の粒度）https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20261%20-%20Row%20locks%20are%20a%20select%20clause%20named%20after%20the%20SQL%2C%20with%20one%20capability%20per%20strength%20or%20option.md
43. Prisma 8 ADR 113（関数・演算子の registry）https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20113%20-%20Extension%20function%20%26%20operator%20registry.md
44. Prisma 8 ADR 115（拡張の guardrail と EXPLAIN）https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20115%20-%20Extension%20guardrails%20%26%20EXPLAIN%20policies.md
45. Prisma 7 Preview features https://www.prisma.io/docs/orm/reference/preview-features/client-preview-features
46. MikroORM `Platform.ts` https://github.com/mikro-orm/mikro-orm/blob/master/packages/core/src/platforms/Platform.ts
47. MikroORM Usage with MongoDB https://mikro-orm.io/docs/usage-with-mongo
48. Effect `sql/Statement.ts`（`Dialect`・`onDialect`・`Compiler`）https://github.com/Effect-TS/effect/blob/main/packages/effect/src/sql/Statement.ts
49. Knex `mysql-querycompiler.js`（`_returningCheck`）・`viewcompiler.js` https://github.com/knex/knex/blob/master/lib/dialects/mysql/query/mysql-querycompiler.js
50. DynamoDB Transactions: How it works https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html
