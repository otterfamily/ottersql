# テーブル以外の DB のもの（view・関数・トリガなど）と履歴テーブル（2026-10-24）

「view・トリガ・関数・Temporal（履歴テーブル）に強い」を差にできるかを調べた。前提は「down を作らず前へ進める」。§1〜§5 は事実で、各文の末尾の番号が出典。§6 は考察。

## 0. 用語（1 行ずつ）

- **view**：保存した SELECT。表のように読めるが、データは持たない。
- **materialized view**：SELECT の結果を保存した表。`REFRESH` で作り直す。
- **関数**（function）：DB の中で動く処理。SQL か PL/pgSQL（Postgres の手続き型の言語）で書く。
- **procedure**：関数に似ているが、値を返さず、中でトランザクションを確定できる。`CALL` で呼ぶ。
- **トリガ**：行の INSERT・UPDATE・DELETE のときに、決めた関数を自動で動かす仕組み。
- **RLS の policy**：行ごとに「誰が読めるか・書けるか」を決める規則。
- **GRANT**：表などへの権限を role に与える文。
- **enum**：決めた値だけを取る型。**domain**：制約付きの別名の型。
- **拡張**（extension）：`CREATE EXTENSION` で足す機能のまとまり。
- **sequence**：連番を出すもの。**パーティション**：大きな表を範囲などで分けたもの。**コメント**：`COMMENT ON` で付ける説明。
- **宣言型**：「あるべき姿」を書き、道具が今の DB との差分から DDL を作る方式。
- **履歴テーブル**：行が変わる前の値を残しておく別の表。「ある時点の状態」を後から問い合わせるのに使う。

## 1. 既存の道具がテーブル以外のものをどこまで扱えるか

### 1-1. ORM・クエリビルダ

記号の意味：○＝扱える、△＝一部だけ、×＝扱えない、？＝未確認。

| 対象 | Prisma 8 RC | Prisma 7 | Drizzle 1.0 RC | Kysely | MikroORM 7.2 | TypeORM 1.1 |
|---|---|---|---|---|---|---|
| view | × [32][34] | △ preview。作るのは手書き、pull すると全列が nullable [33] | ○ [36] | DDL のビルダだけ [41] | ○ [43] | ○。ただし `typeorm_metadata` に記録したものだけを見る [46][47] |
| materialized view | × | × [33] | ○ [36] | DDL のビルダだけ [41] | ○ [43] | ○ [46] |
| 関数・procedure | ×（`rawSql`）[32] | ×（手書き）[33] | × | × | ○（実験的）[44] | × [47] |
| トリガ | ×（`rawSql`）[32] | × | ×（#843 が open）[39] | × | ○（v7.1）[44] | × [47] |
| RLS の policy | ○（public の schema だけ）[35] | × | ○ [37] | × | ○（v7.2）[45] | × |
| GRANT・role | role は宣言だけ。GRANT は × [32] | × | role ○、GRANT × [37][40] | × | policy の role だけ | × |
| enum | ○ | ○ | ○ | ○ [41] | ○ | ○ |
| domain | × | ？ | ×（#218 が open） | × | ？ | × |
| 拡張 | △ | ×（手書き） | ×（docs に「作るコードは無い」）[38] | × | ？ | △（使う型に応じて自動） |
| sequence | △（autoincrement の分だけ） | △ | ○ | × | △ | △ |
| パーティション | × | × | ×（#2854 が open）[39] | × | ○（v7.1） | × |
| コメント | × | × | ×（#886 が open）[39] | × | ○ | ○ |

- Prisma 8 は、表せないもの（トリガ・関数・GRANT・FORCE RLS）を migration の `rawSql` で書くことを公式の答えにしている [32]。
- Prisma 8 の view は、移行ガイドが「Prisma 7 の view ブロックがあると emit が失敗する」と書いている。rc.15 のリリースノートとは書き方が食い違っており、細部は未確認 [34]。
- Drizzle は view の定義が変わると、drop して作り直す [40]。
- 版（npm registry、2026-10-24）[48]
  - prisma 8.0.0-rc.27
  - drizzle-orm・drizzle-kit 1.0.0-rc.5
  - kysely 0.29.7
  - @mikro-orm/core 7.2.5
  - typeorm 1.1.2

### 1-2. スキーマの差分を取る道具

| 対象 | Atlas 無料（Starter） | Atlas Pro | pg-delta（Supabase） | migra | pg-schema-diff（Stripe） | pgschema | pgroll |
|---|---|---|---|---|---|---|---|
| view・materialized view | × | ○ | ○ | ○ | ○ | ○ | 生 SQL だけ |
| 関数（SQL・PL/pgSQL） | × | ○ | ○ | ○ | ○ | ○ | 生 SQL だけ |
| procedure | × | ○ | ○ | ？ | ○ | ○ | 生 SQL だけ |
| トリガ | × | ○ | ○ | ○ | ○ | ○ | 生 SQL だけ |
| RLS の policy | × | ○ | ○ | ○ | ○ | ○ | 生 SQL だけ |
| GRANT | × | ○ | ○ | △（`--with-privileges`） | △（表の権限だけ） | ○ | 生 SQL だけ |
| enum | ○ | ○ | ○ | ○ | ○ | ○ | 生 SQL だけ |
| domain | × | ○ | ○ | × | ×（PR が open） | ○ | 生 SQL だけ |
| 拡張 | × | ○ | ○ | ○ | ○ | × | 生 SQL だけ |
| sequence | × | ○ | ○ | ○ | ○ | ○ | 生 SQL だけ |
| パーティション | × | ○ | ○ | ？ | ○ | ○ | ？ |
| コメント | ○ | ○ | ○ | × | ×（#207 が open） | △ | 表と列だけ |

出典：Atlas [7][8][9][10]、pg-delta [14]、migra [18]、pg-schema-diff [20]、pgschema [23][24]、pgroll [27]

**Atlas**
- 無料版では、view・関数・トリガ・RLS・GRANT・sequence・domain・拡張・パーティションがすべて Pro 限定。docs の各節に「available only to Atlas Pro users」とある [7][8]。
- Pro は「$9 per developer, per month から」[9]。
- 無料で扱えるのは、上の表の対象のうち enum とコメントだけ。

**pgroll**
- 宣言型の道具ではない。表の操作以外は生 SQL で書き、docs は安全を保証しないと明記している [27]。

**Supabase の declarative schemas**
- 既定のエンジンは今も migra。pg-delta は `[experimental.pgdelta]` を設定したときだけ使う [28][29]。
- migra 自体は 2025-08 に公式に deprecated になった（最後のリリースは 2022-09）[17]。
- pg-delta は `supabase/pg-toolbelt` で作り直しが進んでいる。npm では 1.0.0-alpha.60（2026-10-22）[15][31]。

**最新版**（GitHub API・npm・PyPI、2026-10-24）[31]

| 道具 | 版 | 日付 |
|---|---|---|
| Atlas | v1.3.0 | 2026-08-02 |
| pgroll | v0.16.3 | 2026-09-08 |
| pg-schema-diff | v1.0.9 | 2026-08-06 |
| pgschema | v1.13.3 | 2026-10-15 |
| Supabase CLI | v2.122.0 | 2026-10-23 |
| Bytebase | 3.24.0 | 2026-10-22 |

- Bytebase の SDL は、トリガ・RLS・複雑な procedure を対象外としている [30]。

## 2. 宣言型で差分を取るときの難しさ

### 2-1. Postgres 本体の決まり（Postgres 18.6 の文書）

**`CREATE OR REPLACE VIEW`**
- 新しい問い合わせは、元と同じ列（同じ名前・同じ順・同じ型）を返さなければならない。許されるのは末尾に列を足すことだけ。
- 列を消す・名前を変える・型を変えるときは、DROP して作り直すしかない [1]。
- 置き換えても、所有者と権限は変わらない [1]。

**`CREATE OR REPLACE FUNCTION`**
- 戻り値の型、OUT 引数の型、入力の引数の名前、出力が複数あるときの出力の名前は変えられない。変えるには DROP して作り直す [2]。
- 引数の型を変えると、別の関数（オーバーロード）として新しく作られる [2]。
- DROP して作り直した関数は「別のもの」になる。そのため、それを参照する view・トリガ・rule も作り直しが要る [2]。

**依存関係の記録**
- 文字列で書いた関数の本体（PL/pgSQL や、従来の書き方の SQL 関数）は、本体の中で使う表への依存を Postgres が記録しない [4]。
- Postgres 14 で入った SQL 標準の本体（`BEGIN ATOMIC`）だけは、定義した時に解析して依存を記録する [4][6]。
- つまり、PL/pgSQL の関数が何に依存しているかは、カタログ（`pg_depend`）からは分からない。

**トリガ**
- `CREATE OR REPLACE TRIGGER` は Postgres 14 から使える。constraint trigger には使えない [5][6]。
- 同じ種類のトリガが複数あるときは、名前のアルファベット順に動く [5]。
- トリガ関数は、引数を取らず、`trigger` 型を返す関数でなければならない [5]。

**materialized view の `REFRESH ... CONCURRENTLY`**
- 読み取りを止めずに作り直せる。
- ただし、式や WHERE を使わない UNIQUE の index が要り、中身が既に入っていることも条件 [3]。

### 2-2. 各道具の扱い

| 難しさ | pg-delta | pgschema | pg-schema-diff | migra | Atlas |
|---|---|---|---|---|---|
| 関数の本体の比べ方 | `pg_get_functiondef` で取る。表記の揺れは、shadow DB で落ち着くまで流し直して吸収する（alpha.59）[14][16] | 一時の Postgres に流してから読み、文字列で比べる [25] | `pg_get_functiondef` の結果で比べる [115] | `prosrc` の文字列で比べる [19] | 「関数の本体は意図して編集しない」[11]。比べ方は未確認 |
| 依存の順番 | `pg_depend` から依存のグラフを作り、決まった順に並べる [15] | view から view への依存に対応 [26]。並べ方は未確認 | view から view、view から関数への依存が抜けている（#283・#284 が open）。PL/pgSQL の関数には `HAS_UNTRACKABLE_DEPENDENCIES` の警告を出す [20][22] | 依存するものを全部たどって作り直す [18] | SQL のファイルは、利用者が依存の順に並べる [12] |
| view の列の変更 | 定義が変わったら DROP して CREATE し、依存するものも作り直す [14] | REPLACE で済むならそうし、済まなければ依存する view・materialized view・INSTEAD OF トリガごと作り直す [23] | その場で変えずに作り直す [115] | 末尾に列を足すだけなら REPLACE、それ以外は作り直す [18][19] | 未確認 |
| 関数の戻り値・引数の変更 | DROP して作り直し、依存するものも作り直す [14] | DROP して CREATE する [23] | REPLACE を出してしまい失敗する（#251 が open）[21] | 作り直す [19] | 未確認 |
| ロックなどの危険の表示 | lock table の上限で計画を分ける。複製した DB で試す [15] | `--lock-timeout` だけ [23] | hazards（ACCESS EXCLUSIVE のロック、データの削除など）を出し、`--allow-hazards` を付けないと流さない [20] | なし | トリガ（PG308）などの lint は Pro [13] |

- 作り直すと、materialized view の中身は消える。pg-delta はこれを `dataLoss: "destructive"` として印を付ける [14]。
- この中で一番扱いが揃っているのは、pg-delta と pgschema（ソースとテストから読んだ。動かしてはいない）。

## 3. view・関数・トリガを TS の型に出す方法

**view の列が NOT NULL かどうかは、DB に記録されない**
- Postgres は not-null の制約を表に対して持ち [49]、`ALTER VIEW` には SET NOT NULL が無い [50]。`information_schema.columns.is_nullable` も「NOT NULL と分かっているときだけ NO」という定義 [51]。
- そのため、カタログから読む道具では view の列が全部 nullable になる。
- Supabase の typegen のソースのコメントにも「PostgreSQL never sets attnotnull on view columns」とある [52]。
- Postgres の文書がこのことを直接書いた文は見つからなかった。上の 2 つの事実から導いたもの。

| 道具 | view の型 | 関数の引数と戻り値 | トリガで値が入る列 |
|---|---|---|---|
| Drizzle | `.as(qb)` なら select から推論する。`.existing()` なら手で書く [36] | × | — |
| MikroORM | view の列は手書き | `callRoutine` が設定から推論する（実験的）[44] | トリガを宣言して管理する |
| kysely-codegen 0.20.0 | 全列 nullable（#261 が open）[53] | × | `--overrides` で手で上書き |
| kanel 4.0.4 | view の SQL をたどり、元の表の列の nullability を使う（`resolveViews`）[54] | 引数と戻り値を出す。RETURNS TABLE はオブジェクトの型 [54] | `optionalOverride` |
| supabase gen types | CLI ではまだ全列 nullable。推論は postgrest-typegen 0.6.0 に入ったが、CLI には未搭載（依存関係から推論）[55][57]。docs は `MergeDeep` で上書きする方法を示す [56] | `{ Args; Returns }`。オーバーロードは union、SETOF は配列、DEFAULT のある引数は optional [55] | INSTEAD OF トリガのある view に Insert・Update の型を付ける [55] |
| zapatos 6.6.1 | 全列 nullable | × | `columnOptions` で insert を optional にできる。docs はトリガの例を載せている [58] |
| pgtyped 2.4.3 | 問い合わせごと。`AS "x!"` で NOT NULL に上書き [59] | 関数の結果は nullable [59] | — |
| Prisma 7 TypedSQL | 問い合わせごと [60] | 事実上 nullable | — |
| Prisma 8 | 生 SQL の結果は `.returnsRow({...})` で手で型を書く [32] | 同上 | `@@control` で管理の外に出す |

- MikroORM と kanel で、SETOF・オーバーロード・OUT 引数がどんな型になるかは未確認。

## 4. Temporal

### 4-a. JavaScript の Temporal API（要点だけ）

**仕様**
- TC39 で Stage 4 になった（2026-03 の会合）[61]。
- ただし、仕様に載る予定の年は 2027 で、ES2026 には入っていない。ECMA-262 に取り込む PR は open のまま [62][63]。

**実行環境**
- Firefox 139、Chrome・Edge 144、Node.js 26.0.0（2026-05-05）から、フラグなしで使える [64][65]。
- Safari は preview だけ [64]。
- Node 24 には入らず、バックポートの予定も無い [66]。
- TS は 6.0 から `lib.esnext.temporal` を持つ [67]。

**polyfill**
- `temporal-polyfill` 1.0.6、`@js-temporal/polyfill` 0.5.1 [68]。

**ドライバと ORM**
- node-postgres は、timestamp を Date に変え、timestamp without time zone を「プロセスのローカルの時刻」として読む。Date はミリ秒までなので、マイクロ秒を残すには独自の parser が要る、と公式の文書が書いている [69]。
- Temporal への組み込みの対応は、次の状況。
  - node-postgres：issue が open [70]
  - postgres.js：custom types で対応する方針 [71]
  - Drizzle：PR #5656 が open [73]
  - MikroORM・TypeORM：issue が open [74]
- Prisma 8 RC は `Timestamptz` を Temporal で読み書きする。Node 24 では `RUNTIME.TEMPORAL_UNAVAILABLE` で落ちる [72]。
- Postgres の型（date・timestamp・timestamptz・time・interval・range）と Temporal の型（PlainDate・PlainDateTime・Instant・PlainTime・Duration）の対応を公式に決めた文書は、どこにも無い（issue の提案だけ）[70][73]。

### 4-b. 履歴テーブル（変更の履歴を残す方法）

#### Postgres 本体の状況

**システム時間（SQL:2011 の system-versioned tables）は、Postgres 19 にも入らない**
- 「DB が自動で変更履歴を残す」SQL:2011 の機能（`FOR SYSTEM_TIME AS OF`）は、今も本体に無い。
- 開発版の文書は「PostgreSQL does not currently support system time, but it could be emulated using triggers, and there are external extensions」と書いている [75]。
- 本体へのパッチ（commitfest 2316）は 2021-11 に差し戻され、その後は出ていない [76]。

**アプリケーション時間（Postgres 18）**
- 現実の世界での有効期間を、範囲の型（range）の列で持つ方式。
- 主キーと UNIQUE に `WITHOUT OVERLAPS`、外部キーに `PERIOD` が書ける [82][83]。
- 中身は GiST の index による排他制約と同じで、range か multirange の列が要る。範囲以外の列を一緒に使うには btree_gist を入れるのが「想定された使い方」と文書が書いている [83]。
- 外部キーの動作は NO ACTION だけ [75]。
- ある時点の状態は `WHERE valid_at @> '2026-01-01'::date` のように問い合わせる [84]。

**`UPDATE/DELETE ... FOR PORTION OF`**
- 期間の一部だけを変える・消す文。
- 2026-04-01 に Postgres 19 へ commit されたが、2026-09-15 に並行性の問題で revert された [77][78][79]。
- 19 のリリースノートにある temporal の項目は、文書の節を足しただけ [80]。
- Postgres 20 向けの関連のパッチは取り下げられた [81]。再提出の予定は未確認。

#### 履歴を残す方法の比較

| 方法 | 仕組み | ある時点の状態の取り方 | 本体の表を ALTER したとき | 保守の状況 |
|---|---|---|---|---|
| temporal_tables（arkhipov） | C で書いた `versioning()` トリガが、古い行を別の履歴の表へ移す。`sys_period tstzrange` の列を持つ | 今の表と履歴の表を UNION し、`sys_period @> ts` で絞る | 手で同じ ALTER をする。履歴の表に無い列は記録されない | v1.2.2（2023-09）、BSD-2 [85] |
| temporal_tables（nearform） | 上と同じものの PL/pgSQL 版。README に「RDS など C の拡張が使えない環境向け」とある | 同上 | 手で | v1.2.1（2025-09）、MIT [86] |
| periods | SYSTEM_TIME とアプリケーション期間をまねる。履歴は別の表 | `t__as_of(ts)` などの関数 | 一度 versioning を外し、両方の表を ALTER して、付け直す | v1.2.2（2022）、最後の commit は 2025-10 [87] |
| pgMemento | PL/pgSQL のトリガで、差分を JSONB にして1つのログの表へ入れる | `restore_recordset` などの関数 | **自動**。event trigger で DDL を追い、列の生き死にを記録する | v0.7.4（2022）、最後の commit は 2026-04、LGPL-3.0 [88] |
| supa_audit | トリガで、行を JSONB にして1つの表へ入れる | `record_id` と時刻で絞る | 不要（JSONB なので） | **archived**、Apache-2.0 [89] |
| pgaudit | Postgres のログに出すだけ | できない（ログを読むだけ） | 関係しない | 18.0 [90] |
| Postgres 18 のアプリケーション時間 | 利用者が有効期間の列を持ち、制約で重なりを防ぐ | `@>` | 普通の列なので通常の ALTER | 本体の機能 [82][83] |

**比べるときの軸**
- 監査の向き（誰が・いつ変えたか）：pgaudit・supa_audit。
- 「ある時点の状態」を取り出す向き：temporal_tables・periods・pgMemento。

**ORM の外の参考**
- Rails の paper_trail（アプリから `versions` の表に書く）[106]
- Rails の logidze（トリガで、行の `log_data jsonb` の列に持つ）[107]
- django-simple-history（モデルごとに履歴の表）[108]
- Hibernate Envers（エンティティごとに `_AUD` の表）[112]
- EF Core の temporal tables（SQL Server 専用）[111]

**TS での例**
- Bemi（`@bemi-db/prisma`・typeorm・mikro-orm）：WAL による CDC と、ORM から渡した文脈を突き合わせる。LGPL-3.0 [109]。
- Prisma 公式の例 `audit-log-context`：トリガと Client extension を組み合わせる。README に「本番向けではない」とある [110]。
- `drizzle-audit`（0.1.13）、`@bcap/drizzle-history`（0.1.1。型の付いた `<t>_history` の表を drizzle-kit で migrate する。GitHub は 404）[48]。
- Kysely と MikroORM には、公式の履歴のプラグインが見つからなかった。

## 5. Aurora PostgreSQL と Aurora DSQL で使えないもの

**Aurora PostgreSQL**
- Postgres 18 系が使える。18.3 が 2026-06-11、18.6 が 2026-09-29 [97]。
- PL/pgSQL・トリガ・btree_gist・pgAudit・hstore・pg_cron・plv8・pg_partman・pg_tle は、公式の拡張の一覧にある [91]。
- temporal_tables・periods・pgMemento は、Aurora と RDS の一覧に無い [91][92]。
  - C の拡張（arkhipov 版・periods）は入れられないと見る（推論）。
  - PL/pgSQL だけで書かれたもの（nearform 版・pgMemento・supa_audit）は、普通の SQL として流せる見込み（推論・未確認）。
  - pg_tle は PL/pgSQL・SQL・JavaScript などで書いた拡張を入れられる [93]。
- 利用者は本当の superuser ではなく、rds_superuser になる [95]。
- イベントトリガは、RDS の文書では「main user で作れる」とあり、読み取りレプリカでは作れない [94]。Aurora については例が載っているだけで、作れると明記した文は未確認 [96]。

**Aurora DSQL**
- 「使えない機能」の一覧の頁は 2025-12 に無くなった [105]。そのため、ここに書く「なし」は「Supported の頁と構文の頁に載っていない」という判断で、「使えない」と明記した文ではない。その頁自身も「This list is not exhaustive」と書いている [99]。

| 対象 | DSQL |
|---|---|
| view | ○（一時的な view は ×）[100] |
| materialized view | なし [99] |
| 関数 | SQL の関数だけ。PL/pgSQL は × [98][101] |
| procedure | なし [99] |
| **トリガ** | **×**。公式は「アプリの側や EventBridge に移す、監査はアプリのログで」と案内 [98] |
| RLS の policy | なし [99][104] |
| GRANT | ○ [99] |
| enum（`CREATE TYPE`） | ×（「doesn't currently support CREATE TYPE」）[102] |
| domain | ○ [99] |
| 拡張 | なし [99] |
| sequence・identity | ○（2026-02 から）[105][114] |
| パーティション | なし [103] |
| コメント | `COMMENT ON ROUTINE` だけ載っている。表や列へのコメントは未確認 [99] |
| range 型（tstzrange など） | なし [102] |
| EXCLUDE 制約・WITHOUT OVERLAPS | なし（使える制約は CHECK・UNIQUE・PK・FK だけ）[103] |
| 日時の型 | date・time・timestamp・timestamptz は ○（マイクロ秒）。interval・timetz は ○ だが index を作れない [102] |

- まとめると、DSQL では、トリガ型の履歴も、Postgres 18 のアプリケーション時間も使えない。履歴はアプリの側で書くしかない [98][102][103]。

## 6. 考察（事実ではない）

**1. 空いている所ははっきりしている**
- TS の ORM で、トリガ・関数・view を宣言して差分を取れるのは MikroORM 7.1 以降だけ。その関数の機能も実験的。
- 差分の道具では、Atlas はこれらを有料にしている。無料で揃っているのは pg-delta（alpha、Supabase 向け）と pgschema（Go の CLI）で、どちらも TS の型を出さない。
- 「宣言 → 差分 → 型」が1本につながる道具は無い。

**2. 前へ進むだけの方針と、相性が良い**
- view・関数は「作り直し」が基本の操作で、down が無くても、新しい定義を流せば戻せる。
- 難しいのは次の2つ。
  - 作り直しの連鎖：依存する view・トリガ・GRANT をまとめて作り直すこと。
  - データが消える作り直し：materialized view。
- この2つを計画の段で見せることが差になる。

**3. PoC の範囲の案（2〜3 週を想定）**
- 対象は view・materialized view・SQL と PL/pgSQL の関数・トリガ・それらへの GRANT。policy・domain・パーティションは後に回す。
- 宣言は TS か SQL のファイル。差分の比べ方は pg-delta のやり方に倣う：shadow DB に流し、`pg_get_*def` で取り出して正規化し、落ち着くまで流し直す。
- 依存のグラフは `pg_depend` から作る。PL/pgSQL の本体の依存は記録されないので、shadow DB で `check_function_bodies` を有効にして作り直しを試し、その結果で確かめる。
- 計画の JSON に、操作ごとに次を載せる。
  - `replace`（その場で置き換え）か `recreate`（作り直し）か
  - 作り直しになる理由（Postgres のどの制限に当たるか）
  - 一緒に作り直すものの一覧
  - データの消失（materialized view）とロック
- 型の出力
  - view の列は、宣言の SELECT の型から推論する。DB からは NOT NULL を読めないため。
  - 関数は引数と戻り値（SETOF・RETURNS TABLE・OUT）を型にする。
  - トリガで値が入る列は、宣言で insert を optional にする。
- 合格の条件
  - 3 段の依存（view → view → 関数）で、関数の戻り値の型を変えると、正しい順で作り直されること。
  - 計画を流した後、もう一度差分を取るとゼロになること。

**4. 履歴テーブルは「宣言の1行」で済ませる案**
- 宣言で `history: true` を付けると、次のものを生成し、本体の表と同じ migration で追従させる。
  - 履歴の表
  - トリガ（PL/pgSQL。Aurora で使えるもの）
  - 「ある時点」を問い合わせる関数と、その型
- 本体の表を ALTER すると、履歴の表にも同じ変更を自動で計画に入れる。pgMemento が event trigger でやっていることを、計画の段でやる形。
- DSQL ではトリガが使えないので、同じ宣言からアプリ側（同じトランザクションで履歴の表に書く）の実装に切り替える。接続先の能力に応じて計画を変える、という 02 の案の具体例になる。
- Postgres 18 の `WITHOUT OVERLAPS`・`PERIOD` は、宣言の型として小さく対応する。`FOR PORTION OF` は本体での見通しが立たないので、PoC には入れない。

**5. Temporal API は「既定は Date か文字列、選べば Temporal」にとどめる**
- Node 24 では使えず、型の対応の決まりも無い。
- 型の対応表を自分で決めて文書にすれば、小さな差にはなる。

## 出典

1. https://www.postgresql.org/docs/current/sql-createview.html （18.6）
2. https://www.postgresql.org/docs/current/sql-createfunction.html
3. https://www.postgresql.org/docs/current/sql-refreshmaterializedview.html
4. https://www.postgresql.org/docs/current/ddl-depend.html
5. https://www.postgresql.org/docs/current/sql-createtrigger.html
6. https://www.postgresql.org/docs/release/14.0/
7. https://atlasgo.io/atlas-schema/hcl
8. https://atlasgo.io/community-edition
9. https://atlasgo.io/pricing
10. https://atlasgo.io/features
11. https://github.com/ariga/atlas/issues/3207
12. https://atlasgo.io/atlas-schema/sql
13. https://atlasgo.io/lint/analyzers
14. https://github.com/supabase/pg-toolbelt/blob/main/packages/pg-delta/COVERAGE.md （と `src/plan/rules/routines.ts`・`replacement-expansion.ts`）
15. https://github.com/supabase/pg-toolbelt/tree/main/packages/pg-delta ・ https://github.com/supabase/pg-toolbelt/blob/main/docs/overview.md
16. https://github.com/supabase/pg-toolbelt/blob/main/packages/pg-delta/CHANGELOG.md
17. https://github.com/djrobstep/migra
18. https://github.com/djrobstep/migra/blob/master/migra/changes.py
19. https://github.com/djrobstep/schemainspect/blob/master/schemainspect/pg/obj.py
20. https://github.com/stripe/pg-schema-diff
21. https://github.com/stripe/pg-schema-diff/issues/251
22. https://github.com/stripe/pg-schema-diff/issues/283 ・ https://github.com/stripe/pg-schema-diff/issues/284
23. https://github.com/pgplex/pgschema （`internal/diff/function.go`・`internal/diff/diff.go`・`testdata/diff/`）
24. https://www.pgschema.com/syntax/unsupported
25. https://www.pgschema.com/cli/plan-db
26. https://www.pgschema.com/syntax/create_view
27. https://github.com/xataio/pgroll/blob/main/docs/operations/raw_sql.mdx
28. https://supabase.com/docs/guides/local-development/declarative-database-schemas
29. https://github.com/supabase/cli/blob/main/packages/config/src/experimental.ts
30. https://docs.bytebase.com/gitops/state-based-workflow/limitations
31. https://api.github.com/repos/{ariga/atlas,xataio/pgroll,stripe/pg-schema-diff,pgplex/pgschema,supabase/cli,bytebase/bytebase}/releases/latest ・ https://registry.npmjs.org/@supabase/pg-delta ・ https://pypi.org/pypi/migra/json
32. https://github.com/prisma/web/blob/main/apps/docs/content/docs/orm/contract-authoring/advanced-postgresql.mdx
33. https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/views
34. https://github.com/prisma/web/blob/main/apps/docs/content/docs/orm/coming-from-prisma-orm-7.mdx ・ https://github.com/prisma/orm/blob/main/docs/releases/v8.0.0-rc.15.md
35. https://github.com/prisma/orm/blob/main/docs/releases/v0.15.0.md ・ https://github.com/prisma/orm/blob/main/docs/releases/v0.17.0.md
36. https://github.com/drizzle-team/drizzle-orm-docs/blob/main/src/content/docs/pg/views.mdx
37. https://github.com/drizzle-team/drizzle-orm-docs/blob/main/src/content/docs/pg/rls.mdx
38. https://github.com/drizzle-team/drizzle-orm-docs/blob/main/src/content/docs/pg/extensions.mdx
39. https://github.com/drizzle-team/drizzle-orm/issues/843 ・ /886 ・ /2854
40. https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.5/drizzle-kit/src/dialects/postgres/diff.ts
41. https://github.com/kysely-org/kysely/blob/master/src/schema/schema-module.ts
42. https://github.com/kysely-org/kysely/blob/master/src/dialect/postgres/postgres-introspector.ts
43. https://github.com/mikro-orm/mikro-orm/blob/master/docs/docs/view-entities.md
44. https://github.com/mikro-orm/mikro-orm/blob/master/docs/docs/stored-routines.md
45. https://github.com/mikro-orm/mikro-orm/blob/master/docs/docs/row-level-security.md
46. https://github.com/typeorm/typeorm/blob/master/docs/docs/entity/5-view-entities.md
47. https://github.com/typeorm/typeorm/blob/master/packages/typeorm/src/driver/postgres/PostgresQueryRunner.ts
48. npm registry（2026-10-24）：https://registry.npmjs.org/<名前>（prisma・drizzle-orm・drizzle-kit・kysely・@mikro-orm/core・typeorm・kysely-codegen・kanel・zapatos・@pgtyped/cli・drizzle-audit・@bcap/drizzle-history）
49. https://www.postgresql.org/docs/current/catalog-pg-constraint.html
50. https://www.postgresql.org/docs/current/sql-alterview.html
51. https://www.postgresql.org/docs/current/infoschema-columns.html
52. https://github.com/supabase/sdk/blob/HEAD/packages/postgrest-typegen/src/introspection/view-nullability.ts
53. https://github.com/RobinBlomberg/kysely-codegen/blob/master/src/introspector/dialects/postgres/postgres-introspector.ts ・ https://github.com/RobinBlomberg/kysely-codegen/issues/261
54. https://github.com/kristiandupont/kanel/blob/main/packages/kanel/src/generators/resolveViewSource.ts ・ makeRoutineGenerator.ts
55. https://github.com/supabase/sdk/blob/HEAD/packages/postgrest-typegen/src/generation/typescript.ts
56. https://supabase.com/docs/guides/api/rest/generating-types
57. https://github.com/supabase/cli/blob/HEAD/apps/cli-go/pkg/config/templates/Dockerfile
58. https://jawj.github.io/zapatos/
59. https://github.com/adelsz/pgtyped/blob/master/docs-new/docs/sql-file.md
60. https://github.com/prisma/web/blob/main/apps/docs/content/docs/orm/v7/prisma-client/using-raw-sql/typedsql.mdx
61. https://github.com/tc39/proposal-temporal ・ https://github.com/tc39/notes/blob/HEAD/meetings/2026-03/march-11.md
62. https://github.com/tc39/proposals/blob/main/finished-proposals.md
63. https://github.com/tc39/ecma262/pull/3966
64. https://github.com/mdn/browser-compat-data/blob/main/javascript/builtins/Temporal.json
65. https://nodejs.org/en/blog/release/v26.0.0
66. https://github.com/nodejs/node/issues/57127
67. https://devblogs.microsoft.com/typescript/announcing-typescript-6-0-rc/
68. https://registry.npmjs.org/temporal-polyfill ・ https://registry.npmjs.org/@js-temporal/polyfill
69. https://node-postgres.com/features/types
70. https://github.com/brianc/node-postgres/issues/3663
71. https://github.com/porsager/postgres/issues/856
72. https://github.com/prisma/orm/issues/16119 ・ https://github.com/prisma/orm/issues/30252
73. https://orm.drizzle.team/docs/column-types/pg ・ https://github.com/drizzle-team/drizzle-orm/pull/5656
74. https://github.com/mikro-orm/mikro-orm/issues/7771 ・ https://github.com/typeorm/typeorm/issues/12434
75. https://www.postgresql.org/docs/devel/ddl-temporal-tables.html
76. https://commitfest.postgresql.org/patch/2316/
77. https://github.com/postgres/postgres/commit/8e72d914c5 ・ https://github.com/postgres/postgres/commit/a4b26b8f7c
78. https://commitfest.postgresql.org/patch/5836/
79. https://www.postgresql.org/message-id/62bf70cc-dc33-4188-8070-a8c177bb61de%40eisentraut.org
80. https://www.postgresql.org/docs/19/release-19.html
81. https://commitfest.postgresql.org/61/ ・ https://commitfest.postgresql.org/62/
82. https://www.postgresql.org/docs/18/release-18.html
83. https://www.postgresql.org/docs/18/sql-createtable.html
84. https://www.postgresql.org/docs/18/functions-range.html
85. https://github.com/arkhipov/temporal_tables
86. https://github.com/nearform/temporal_tables
87. https://github.com/xocolatl/periods
88. https://github.com/pgMemento/pgMemento ・ https://github.com/pgMemento/pgMemento/blob/master/src/DDL_LOG.sql
89. https://github.com/supabase/supa_audit
90. https://github.com/pgaudit/pgaudit
91. https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html
92. https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html
93. https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/PostgreSQL_trusted_language_extension.html
94. https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.EventTriggers.html
95. https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.rds_superuser.html
96. https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora_delegated_ext.html
97. https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/aurorapostgresql-release-calendar.html
98. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-migration-guide.html
99. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-sql-features.html
100. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-view.html
101. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-function-syntax-support.html
102. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-data-types.html
103. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.html
104. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.html
105. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/doc-history.html
106. https://github.com/paper-trail-gem/paper_trail
107. https://github.com/palkan/logidze
108. https://django-simple-history.readthedocs.io/en/latest/querying_history.html
109. https://github.com/pgstack-io/bemi-prisma
110. https://github.com/prisma/prisma-client-extensions/tree/main/audit-log-context
111. https://learn.microsoft.com/en-us/ef/core/providers/sql-server/temporal-tables
112. https://docs.jboss.org/hibernate/orm/current/userguide/html_single/Hibernate_User_Guide.html
113. （欠番）
114. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/sequences-identity-columns.html
115. https://github.com/stripe/pg-schema-diff/blob/main/pkg/diff/function_sql_vertex_generator.go ・ https://github.com/stripe/pg-schema-diff/blob/main/pkg/diff/view_sql_generator.go
