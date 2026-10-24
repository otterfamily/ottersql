# Postgres のスキーマの基本の機能と、既存の道具の対応（2026-10-24）

AI に最適化した TS の ORM・クエリビルダ・マイグレーションの道具（主軸は Postgres・Aurora PostgreSQL）が、最低限網羅すべき「スキーマの基本の機能」を、Postgres 18 の公式文書から洗い出す。そのうえで既存の道具の対応、マイグレーションの落とし穴、Aurora での違いをまとめる。1〜4 章は事実（出典の番号付き）、5 章は考察。

調べた版：Postgres 18（公式文書の current。19 は RC）、Prisma 8.0.0-rc.27（prisma/orm main f543fb4）・Prisma 7、Drizzle `beta`（drizzle-orm・drizzle-kit 1.0.0-rc.5、5d71fc4）、Kysely 0.29.7（b506b63）、MikroORM 7.2.5（99f6af7）、TypeORM 1.1.2（da473df）、Atlas（ariga/atlas main ed994a7 と atlasgo.io）。道具の対応はソースと文書を読んで判断し、実行はしていない。

## 1. 網羅すべき基本の機能（Postgres 18 の公式文書から）

ID は 2 章の表と共通。「何か」は DB に詳しくない読者向けの1行。

| ID | 機能 | 何か | 注（版・制限） |
|---|---|---|---|
| F01 | 主キー | 行を一意に指す列。一意かつ NULL 不可。作ると B-tree の一意の索引ができる [4] | 1表に1つ [1] |
| F02 | 複合主キー | 複数の列の組で主キーにする [1] | — |
| F03 | 外部キー | 列の値が別の表の行に必ずある、と DB に保証させる [4] | 参照先は主キー・UNIQUE・部分でない一意の索引の列。参照する側の索引は自動では作られない [4] |
| F04 | 複合の外部キー | 複数の列の組で参照する [1] | — |
| F05 | ON DELETE / ON UPDATE | 参照先の行が消える・変わるときの動作。NO ACTION（既定。遅延できる）・RESTRICT（遅延できない）・CASCADE・SET NULL・SET DEFAULT [1] | — |
| F06 | SET NULL (列) / SET DEFAULT (列) | 外部キーの列の一部だけを NULL・既定値にする [1] | PG15 から。ON DELETE だけ。Postgres の独自の拡張 [1] |
| F07 | MATCH FULL / SIMPLE | 複合の外部キーで、一部の列が NULL の行を許すか。SIMPLE（既定）は1つでも NULL なら検査しない、FULL は全部 NULL か全部非 NULL [1] | MATCH PARTIAL は未実装 [1] |
| F08 | DEFERRABLE / INITIALLY DEFERRED | 制約の検査をトランザクションの終わりまで遅らせる。`SET CONSTRAINTS` で切り替える [1] | UNIQUE・主キー・EXCLUDE・外部キーだけ。NOT NULL・CHECK は不可。遅延できる制約は `ON CONFLICT` の判定に使えない [1] |
| F09 | NOT VALID と VALIDATE | 既存の行を検査せずに制約を足し、あとで `VALIDATE CONSTRAINT` で検査する [2] | 外部キー・CHECK・NOT NULL（NOT NULL は 18 から）だけ [2][7] |
| F10 | 自己参照の外部キー | 同じ表を参照する（木構造など）[4] | — |
| F11 | UNIQUE（単一・複合） | 列（の組）の値が重複しないことを保証する [4] | 既定では NULL 同士は別の値とみなす（NULL の行はいくつでも入る）[4] |
| F12 | NULLS NOT DISTINCT | UNIQUE で NULL 同士を同じ値とみなす [4] | PG15 から |
| F13 | 部分の一意の索引 | `CREATE UNIQUE INDEX ... WHERE` で、条件に合う行だけ一意にする（論理削除など）[3] | 制約ではなく索引。外部キーの参照先にできない [4] |
| F14 | CHECK | 行ごとの条件式を保証する [4] | 18 から NOT ENFORCED を付けられる [7] |
| F15 | EXCLUDE | 2行を指定の演算子で比べ、全部が真になる組を禁止する（期間の重なりの禁止など）[4] | 索引を作る。等号を GiST で使うには拡張 btree_gist が要る（未確認：本文では読んでいない） |
| F16 | NOT NULL | 列に NULL を入れさせない [4] | — |
| F17 | 名前付きの NOT NULL・NOT VALID | 18 から NOT NULL も `pg_constraint` に入る制約になり、名前を付け、NOT VALID で足せる [7] | 18 から [7] |
| F18 | DEFAULT | 値を省いた挿入で使う値。式も書ける（`now()`・`gen_random_uuid()`・18 の `uuidv7()`）[1][7] | 他の列は参照できない [5] |
| F19 | 生成列 STORED | 他の列から計算し、書き込み時に保存する列 [5] | 式は immutable な関数だけ。他の生成列・他の表は参照できない [5] |
| F20 | 生成列 VIRTUAL | 読むときに計算し、保存しない列 [5] | **18 から。しかも 18 では VIRTUAL が既定**。組み込みの関数・型だけ。`DROP EXPRESSION` は STORED だけ [1][2][5][7] |
| F21 | identity | 連番を自動で入れる列（標準の書き方。serial の後継）。ALWAYS は明示の値を拒む、BY DEFAULT は許す。sequence の設定を書ける [1][6] | 暗黙に NOT NULL [1] |
| F22 | 索引の方式 | B-tree（既定）・Hash・GiST・SP-GiST・GIN・BRIN [12] | 一意にできるのは B-tree だけ。複数の列は B-tree・GiST・GIN・BRIN [3] |
| F23 | 式の索引 | `lower(email)` など式の値で索引を作る [3] | immutable な関数だけ [3] |
| F24 | 部分の索引 | `WHERE` に合う行だけを索引に入れる [3] | — |
| F25 | INCLUDE | 検索には使わない列を索引に足し、表を見ずに返せるようにする [3] | B-tree・GiST・SP-GiST だけ。式は不可 [3] |
| F26 | CONCURRENTLY | 書き込みを止めずに索引を作る [3] | トランザクションの中で流せない。失敗すると INVALID の索引が残る [3]（3 章） |
| F27 | 並び順・NULLS FIRST/LAST | 索引の列ごとの ASC/DESC と NULL の位置 [3] | 順序のある走査は B-tree だけ [3] |
| F28 | 演算子クラス | 列ごとに索引の比較の仕方を選ぶ（`jsonb_path_ops`・`gin_trgm_ops` など）[3] | 引数を取るものもある [1] |
| F29 | 照合順序 | 文字列の並び順と比較の規則。列・式ごとに `COLLATE`。提供元は libc と ICU、非決定的な照合（大文字小文字を同一視など）もある [9] | 18 から主キーと外部キーは決定的な照合か同じ非決定的な照合が必要 [7] |
| F30 | コメント | `COMMENT ON` で表・列・制約・索引などに説明を付ける [10] | — |
| F31 | スキーマ | 表などを入れる名前空間。既定は `public`、`search_path` で探す [11] | 索引は表と同じスキーマに作られる [3] |
| F32 | 制約・索引の名前 | `CONSTRAINT 名前` で付ける。省くとシステムが付ける [4]（3 章） | 制約の名前は表ごとに一意。ただし主キー・UNIQUE・EXCLUDE は同名の索引を作るので、索引の名前はスキーマ内で一意 [1] |

このほか 18 では、主キー・UNIQUE の `WITHOUT OVERLAPS` と外部キーの `PERIOD`（時間の範囲の制約）、外部キーの `NOT ENFORCED` が入った [7]。基本の機能の外に置いたが、2 章の表では扱っていない。

## 2. 既存の道具の対応

### 2.1 表

判定は「スキーマに宣言でき、マイグレーションの生成（差分）がそれを出すか」。手書きの SQL を migration に足せば何でもできるので、それは数えない（Kysely は差分を作らないので、スキーマのビルダに API があれば ○、`sql` の生 SQL なら △）。Atlas は宣言（HCL・SQL のスキーマ）からの差分で判定し、Pro は印で見分けた。

○ 対応／△ 一部（注）／× 無し／？ 未確認（文書にもソースにも見つからない）。各セルの出典のファイルと行は、列ごとの出典（[29]〜[37]）にまとめた。

| ID | 機能 | Prisma 8 RC [29] | Prisma 7 [30] | Drizzle v1 RC [31][32] | Kysely [33] | MikroORM 7 [34] | TypeORM 1.x [35] | Atlas [36][37] |
|---|---|---|---|---|---|---|---|---|
| F01 | 主キー | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| F02 | 複合主キー | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| F03 | 外部キー | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| F04 | 複合の外部キー | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| F05 | 5つの動作 | ○ | ○ | ○ | ○ | △ 差分が RESTRICT と NO ACTION を同一視 | △ SET DEFAULT が無く `DEFAULT` を出す | ○ |
| F06 | SET NULL (列) | × | × | × | △ 生 SQL | ○ | × | ？ |
| F07 | MATCH FULL | × | × | × | △ 生 SQL | × | × | ？ |
| F08 | DEFERRABLE | × | × #8807 | × #1429 | ○ FK・UNIQUE・PK | ○ FK・UNIQUE | △ 宣言できるが FK の差分は比べない | ？ |
| F09 | NOT VALID→VALIDATE | × | × | × | △ 生 SQL | × | × | △ SQL を作る所に句はある。宣言からの付け方は？ |
| F10 | 自己参照 | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| F11 | UNIQUE | ○ | ○ | ○ | ○ | ○ | △ 名前付きの複合は変更を拾わない #12986 | ○ |
| F12 | NULLS NOT DISTINCT | × | × | ○ | ○ | × | × #9827 | △ 索引は ○、制約は？ |
| F13 | 部分の一意の索引 | ○ | ○ preview | △ push は WHERE の変更を無視 | ○ | ○ | △ 名前付きは変更を拾わない #12988 | ○ |
| F14 | CHECK | ○ | × #3388 | ○ | ○ | ○ | △ 差分は名前だけで比べる | ○ |
| F15 | EXCLUDE | × | × #17514 | × | △ 生 SQL | ○ | ○ | ○ |
| F16 | NOT NULL | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| F17 | 名前付き NOT NULL | × | × #29635（PG18 で panic） | × | △ 生 SQL | × | × | ？ |
| F18 | DEFAULT（式） | ○ | ○ `dbgenerated` | ○ | ○ | ○ | ○（差分が出続ける #3076） | ○ |
| F19 | 生成列 STORED | × | × #6336 | ○ | ○ | ○ | ○ | ○ |
| F20 | 生成列 VIRTUAL | × | × #6336 | × #4074 | △ 下の注 | △ 宣言できるが読み戻すと STORED | × #12807 | ？ |
| F21 | identity | × SERIAL | × SERIAL #4693 | ○ | △ sequence の設定は生 SQL | ○ | △ sequence の設定なし・差分で比べない #11449 | △ start・increment だけ |
| F22 | 索引の方式 | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| F23 | 式の索引 | ○ | × | △ push は式の変更を無視することがある | ○ | △ 生 SQL・差分は名前だけ | × #10118 | ○ |
| F24 | 部分の索引 | ○ | ○ preview | △ push は WHERE の変更を無視 | ○ | ○ | △ #12988 | ○ |
| F25 | INCLUDE | × | × | × | △ 生 SQL | ○ | × | ○ |
| F26 | CONCURRENTLY | × | △ 手書き SQL（7.4 から1文ずつ流す） | △ 出すが migrator が1トランザクションで包む | △ 生 SQL・回ごとにトランザクションを外す | △ 手書き・`isTransactional()` | ○ `concurrent`（要 `migrationsTransactionMode: none`） | ○ `concurrent_index`（`atlas:txmode none`） |
| F27 | 並び順・NULLS | × #30270 | △ ASC/DESC だけ | ○ | △ NULLS は生 SQL | ○ | × #3336 | ○ |
| F28 | 演算子クラス | × | ○ `ops` | ○ | △ 生 SQL | △ 生 SQL | × #12001 | ○ |
| F29 | 照合順序 | × | × | × #638 | △ 生 SQL | ○ | ○ | △ SQL を作る所は ○、HCL は？ |
| F30 | コメント | × | × #8703 | × #886 | △ 生 SQL | ○ | ○ | ○ |
| F31 | スキーマ | ○（`contract infer` は public だけ #30573） | ○ | ○ | ○ | ○ | ○ | ○ |
| F32 | 名前の指定 | ○ | ○ | △ NOT NULL 以外 | △ 列に付ける制約は名前を付けられない | △ 主キーは NamingStrategy で | ○ | △ 主キーは？ |

注：
- issue の番号は、Prisma が prisma/orm、Drizzle が drizzle-team/drizzle-orm、TypeORM が typeorm/typeorm（いずれも open。Prisma 7 の #14456 は 7.4.0 で close）[29]〜[35]。
- Kysely の F20：`generatedAlwaysAs()` に `stored()` を付けないと STORED も VIRTUAL も出さない [33]。18 では既定の VIRTUAL になり [1]、17 以前は構文に STORED が必須なので失敗する [28]。
- Prisma 8 RC は、宣言しなくても外部キーごとに索引を足し（`@relation(index: false)` で止める）、enum・リストの列に CHECK を足す（rc.19 から止められない）[29]。
- Prisma 8 RC は shadow DB を使わず、contract の比較だけで migration を作る。contract で書けないものは `rawSql` の手順に書き、前後の検査も手で書く [29]。Prisma 7 は手で足した索引を次の差分で消す問題が open（#12914）[30]。
- Atlas の lint（atlasgo.io/lint/analyzers）は、CONCURRENTLY の付け忘れ（PG101・PG102）、`atlas:txmode none` の付け忘れ（PG103）、主キー・UNIQUE・EXCLUDE の ACCESS EXCLUSIVE（PG104・PG105・PG109）、書き直し・全件の走査（PG301〜PG312。NOT VALID なしの CHECK・外部キーの追加は PG305・PG306）を指摘する。これらは **Pro**。データがあると落ちる変更（MF101〜MF104）・互換を壊す変更（BC）・削除（DS）は無料 [38]。

### 2.2 自動の名前と 63 の扱い

| 道具 | 名前を付けないとき | 63 を超えたとき |
|---|---|---|
| Postgres | `表_列_pkey`・`_key`・`_fkey`・`_check`・`_idx`・`_excl`・`_not_null` | 表と列の部分をバイトで切り、ラベルは残す [13] |
| Prisma 8 RC | `{table}_pkey`・`{table}_{cols}_key`・`{table}_{cols}_fkey`。`name:` を付けた索引・CHECK は末尾に 8 文字のハッシュ（`map:` で正確な名前） | 63 バイトで切る [29] |
| Prisma 7 | 同上、索引は `{table}_{cols}_idx` | 未確認 [30] |
| Drizzle v1 RC | PK `{table}_pkey`、FK `{table}_{cols}_{tableTo}_{colsTo}_fkey`、列の UNIQUE `{table}_{col}_key`、表の UNIQUE `{table}_{cols}_unique`、索引 `{table}_{cols}_index`。0.x から名前の既定が変わった | FK の既定の名前だけハッシュで縮める（UTF-16 の文字数で数える）。他は検査しない [31] |
| Kysely | 表に付ける制約・索引は名前が必須 | —（そのまま出す）[33] |
| MikroORM 7 | `{table}_{cols}_{type}`、PK は `{table}_pkey` | 末尾をハッシュに替えて縮める（JS の文字数で数える）。CHECK は 63 文字で切るだけ [34] |
| TypeORM 1.x | `PK_`・`FK_`・`UQ_`・`IDX_`・`CHK_`・`XCL_` ＋ sha1 の 26〜27 文字。索引と CHECK は式・WHERE を含めたハッシュなので、定義を変えると名前も変わり作り直す | 常に 30 文字ほどで届かない。明示した名前の検査は未確認 [35] |
| Atlas | 未確認 | 未確認 |

### 2.3 マイグレーションのトランザクション

| 道具 | 既定 | 外し方 |
|---|---|---|
| Prisma 8 RC | 1 migration = 1 トランザクション。CONCURRENTLY の選択肢は無い [29] | — |
| Prisma 7 | migration.sql を流す（7.4 から1文ずつ）[30] | 手書き |
| Drizzle v1 RC | `migrate()` は未実行の全部を1トランザクション。`push` はトランザクションなし [31] | 無し（見つからない） |
| Kysely | 未実行の全部を1トランザクション。`pg_advisory_lock` を取る [33] | `disableTransactions`（Migrator 全体か1回の呼び出し単位） |
| MikroORM 7 | 各 migration を包み、`allOrNothing` で全体も1つ [34] | `isTransactional()`（`allOrNothing` も false に） |
| TypeORM 1.x | `migrationsTransactionMode: all` [35] | `each`・`none`、各 migration の `transaction` |
| Atlas | 1ファイル = 1トランザクション（`--tx-mode file`）[37] | `all`・`none`、ファイルの頭の `-- atlas:txmode none` |

## 3. マイグレーションで扱うときの落とし穴（公式文書から）

### 3.1 ロックの強さ（ALTER TABLE の既定は ACCESS EXCLUSIVE）

`ALTER TABLE` は、文書が別に書いていない限り ACCESS EXCLUSIVE（読み書きを全部止める）を取る。1文に複数の変更を書くと、一番強いロックになる [2]。

| 操作 | ロック・走査 | 出典 |
|---|---|---|
| `ADD CONSTRAINT ... FOREIGN KEY` | SHARE ROW EXCLUSIVE を**自分の表と参照先の表の両方**に取り、既存の行を全部走査する（その間、書き込みが止まる） | [2] |
| 同上 `NOT VALID` | 走査を省き、すぐ commit できる。以後の挿入・更新は検査される | [2] |
| `VALIDATE CONSTRAINT` | SHARE UPDATE EXCLUSIVE（書き込みを止めない）。外部キーなら参照先に ROW SHARE も | [2] |
| `ADD CHECK` / `SET NOT NULL` | 全件を走査（書き直しはしない）。18 では NOT NULL も NOT VALID にでき、有効な CHECK (col IS NOT NULL) があれば走査を省く | [2][7] |
| その他の `ADD 制約`（主キー・UNIQUE・EXCLUDE） | ACCESS EXCLUSIVE | [2] |
| `CREATE INDEX` | 書き込みを止める（読みは通す）| [3] |
| `CREATE INDEX CONCURRENTLY` | 書き込みを止めない。代わりに表を2回走査し、既存のトランザクションの終わりを待つので遅い | [3] |

**外部キーの2段**：`ADD CONSTRAINT fk ... NOT VALID` → 別のトランザクションで `VALIDATE CONSTRAINT fk`。文書は、NOT VALID の主な目的を「同時の更新への影響を減らす」ことと書き、既存の違反を後で直す使い方も挙げている [2]。18 では分割した表の外部キーも NOT VALID にできる [7]。

### 3.2 CONCURRENTLY の制約

- **トランザクションの中で流せない** [3]。全部の migration を1つのトランザクションで包む道具（Drizzle の `migrate()`、Kysely の既定、MikroORM の `allOrNothing`、TypeORM の既定 `all`）では、そのままでは流せない（2 章の特記）。
- 失敗（デッドロック・一意の違反）すると **INVALID の索引が残る**。検索には使われないが更新の負担はかかる。勧められる回復は DROP して作り直すか `REINDEX INDEX CONCURRENTLY` [3]。一意の索引なら、INVALID のままでも一意の検査は効き続ける [3]。→ 道具は「再実行のときに INVALID の索引を検出して消す」必要がある。
- 1つの表で同時に走らせられる CONCURRENTLY は1つだけ。分割した表には使えない（各パーティションに個別に作ってから親に非同時で作る）[3]。

### 3.3 UNIQUE を足すときの既存の重複

- `ADD UNIQUE` は既存の行を検査し、重複があれば失敗する（NOT VALID は外部キー・CHECK・NOT NULL にしかない）[2]。CONCURRENTLY で作ったときも、重複があると失敗し INVALID の索引が残る [3]。
- 止めずに足す手順：`CREATE UNIQUE INDEX CONCURRENTLY` → `ALTER TABLE ... ADD CONSTRAINT 名前 UNIQUE USING INDEX 索引`。ただしこの索引は式・部分でなく、既定の並び順の B-tree に限る。名前を付けると索引の名前もそれに変わる。分割した表では使えない [2]。主キーを USING INDEX で足すと、列が NOT NULL でなければ全件を走査する [2]。
- 道具は、足す前に重複を数える事前の検査（`GROUP BY ... HAVING count(*) > 1`）を計画に入れられる（考察）。

### 3.4 列の型の変更での書き直し

- `SET DATA TYPE` は**通常、表と索引を全部書き直す**。例外は、`USING` が値を変えず、旧い型が新しい型に binary coercible（または制約のない domain）のとき。その場合も、照合順序が変われば索引は作り直す。`text` ⇔ `varchar` は索引も作り直さない [2]。
- `ADD COLUMN` に volatile な DEFAULT（`clock_timestamp()` など）・STORED の生成列・identity・制約付きの domain を付けると、表と索引を書き直す。non-volatile な DEFAULT は catalog に値を置くだけで速い。**VIRTUAL の生成列の追加は書き直さない** [2]。
- 書き直す形の ALTER TABLE は MVCC で安全でない：書き直しの前の snapshot を持つトランザクションからは、表が空に見える [2]。
- `SET EXPRESSION` は STORED の生成列なら既存のデータを書き直す [2]。

### 3.5 名前の長さ 63 バイトと自動の名前

- 識別子は NAMEDATALEN−1 = **63 バイト**まで。長い名前は書けるが**切り詰められる**（エラーにならない）[8]。マルチバイトの名前はバイトで数える。→ 道具が持つ名前と DB の名前が食い違う原因になる。
- 自動の名前の作り方は文書に規則が無い（「システムが選ぶ」とだけある）[4]。ソースでは `makeObjectName()` が `表_列_ラベル` を作り、63 バイトに収まるよう**表と列の部分を切り詰め、ラベルは切らない**。衝突すれば、ラベルに数字を足す [13]。ラベルは主キー `pkey`・UNIQUE `key`・EXCLUDE `excl`・索引 `idx`・外部キー `fkey`・CHECK `check`・NOT NULL `not_null` [13]。文書の例でも `films_lower_idx`・`distributors_pkey` が出る [2][3]。
- 自動の名前に頼ると、同じスキーマを別の順で作ったときに番号の付き方が変わりうる（考察。衝突時の番号付けは [13]）。差分の比較を名前で行う道具では、**名前を常に明示して保存する**のが安全（考察）。

### 3.6 制約の名前の付け方の規約

- 制約の名前は表ごとに一意であればよい。ただし主キー・UNIQUE・EXCLUDE は同名の索引を作るので、**スキーマ内のすべての relation（表・索引・sequence・view など）と重ならない**必要がある [1][3]。SQL 標準はスキーマ内で一意を求める [1]。
- Postgres 自身の規約（上の `_pkey`・`_key`・`_fkey`・`_check`・`_idx`・`_excl`・`_not_null`）に合わせておくと、名前を付けずに作った既存の DB を取り込んだときに差分が出にくい（考察）。各道具の既定の名前は 2.2 を参照。

## 4. Aurora PostgreSQL と Aurora DSQL での違い

### 4.1 Aurora PostgreSQL（プロビジョンド・Serverless v2）

- Aurora PostgreSQL 18.6（2026-09-29）・18.6.1（10-15）は PostgreSQL 18.6 互換 [24]。スキーマの DDL について、Aurora 固有の制限を書いた頁は見つからなかった（1 章の機能が Aurora で全部動くことは**未確認**。実機で確かめる）。
- 本当の superuser は無く、`rds_superuser` の役割で操作する [26]。拡張は AWS が載せたものだけ。18 の一覧に `btree_gist`・`btree_gin`・`pg_trgm`・`citext`・`pgvector`・`pg_partman` などがある [25]。`btree_gist`・`pg_trgm`（`gin_trgm_ops`）は一覧に入っている。
- **Aurora PostgreSQL Limitless Database**（シャーディング）は DDL の制限が多い [27]：EXCLUDE 不可、identity 列不可、関数を使う CHECK 不可（比較とリテラルだけ）、シャードの表の主キー・UNIQUE はシャードキーを含む必要、外部キーは表の種類の組み合わせで制限、`CREATE UNIQUE INDEX CONCURRENTLY` 不可（非一意の CONCURRENTLY はシャードの表で可）、ALTER TABLE の `RENAME CONSTRAINT`・`ADD GENERATED`・`DROP EXPRESSION`・`DROP IDENTITY`・型の変更の `USING` など不可。

### 4.2 Aurora DSQL

前回の調査（02）の「外部キーなし」は**古い**。今の文書では外部キー・sequence・identity が使える [14][16]。

| 機能 | DSQL | 出典 |
|---|---|---|
| F01・F02 主キー | ○。ただし**作るときに決め、あとで変更・追加できない**（データの分割のキーになる）。無ければ隠れた ID を付ける。単調増加の整数は避けるよう勧める | [21] |
| F03〜F05・F10 外部キー | ○（5動作・複合）。CASCADE・SET NULL・SET DEFAULT で変わる行も1トランザクション 3,000 行の上限に数える | [16][23] |
| F06 SET NULL (列) | ○ | [16] |
| F07 MATCH | FULL・SIMPLE ○ | [16] |
| F08 DEFERRABLE | **外部キーだけ**（UNIQUE・主キーは不可） | [16] |
| F09 NOT VALID | 既存の表への CHECK・外部キーの追加は **NOT VALID が必須**。検査は `ALTER TABLE ASYNC ... VALIDATE CONSTRAINT`（非同期のジョブ。`sys.jobs`・`sys.wait_for_job`） | [17] |
| F11 UNIQUE | 作るときは ○。既存の表には `CREATE UNIQUE INDEX ASYNC` → `ADD CONSTRAINT ... UNIQUE USING INDEX` だけ（ALTER TABLE で UNIQUE を直接足せない） | [16][17] |
| F12 NULLS NOT DISTINCT | ○ | [16][18] |
| F13・F24 部分の索引 | ○（WHERE） | [18] |
| F14 CHECK | ○ | [16] |
| F15 EXCLUDE | ×（CREATE TABLE の構文に無い） | [16] |
| F16 NOT NULL | 作るときは ○。ALTER は `DROP NOT NULL` だけで、`SET NOT NULL` が無い | [16][17] |
| F17 名前付き NOT NULL・NOT VALID | 未確認（構文の頁に記載なし） | [16][17] |
| F18 DEFAULT | ○（`SET DEFAULT`・`DROP DEFAULT` も） | [16][17] |
| F19 生成列 STORED | ○ | [16] |
| F20 VIRTUAL | ×（構文は `STORED` だけ） | [16] |
| F21 identity | ○。ただし sequence の CACHE は **1 か 65536 以上**を明示する必要 | [16][22] |
| F22 索引の方式 | `USING` の指定が構文に無い（例では `btree_index`）。GIN・GiST などは使えない | [18][19] |
| F23 式の索引・F25 INCLUDE | ○ | [18] |
| F26 CONCURRENTLY | 無い。代わりに **`CREATE INDEX ASYNC` が必須**（ロックしない。ジョブの ID を返す。失敗すると INVALID が残る） | [18][19] |
| F27 並び順 | NULLS FIRST/LAST は ○。ASC/DESC は構文に無い | [18] |
| F28 演算子クラス・F29 照合順序 | ×。照合順序は **C だけ** | [14][18] |
| F30 コメント | 機能の一覧の COMMENT ON は ROUTINE だけ。表・列は未確認 | [15] |
| F31 スキーマ | ○。1クラスタに DB は `postgres` の1つ、スキーマは 10 まで | [14][23] |
| 型の変更 | ALTER TABLE に `SET DATA TYPE` が無い | [17] |
| トランザクション | DDL は1トランザクションに1文、DML と混ぜられない。DDL のあと別のセッションが古いカタログで `40001`（OC001）を受けうる（再試行で通る） | [14][20] |
| 上限 | 表 1,000、1表の列 255、索引 24、索引・主キーの列 8 まで | [23] |

## 5. 考察：PoC で最初に網羅する範囲と、後に回してよいもの

ここからは考察（事実は 1〜4 章）。

### 5.1 観察

- **32 項目を全部、宣言と差分で扱える道具は無い。** 名前付きの NOT NULL（F17）・MATCH FULL（F07）・SET NULL (列)（F06。MikroORM だけ ○）は、ほぼどれも宣言できない。VIRTUAL（F20）を正しく扱う道具も無い。18 では生成列の既定が VIRTUAL になったので、`STORED` を付けずに `GENERATED ALWAYS AS (...)` を出す道具（Kysely）は、18 では VIRTUAL、17 以前では構文の誤りになる [1][28][33]。
- **最大の競合の Prisma 8 RC にも穴が多い。** 生成列・identity（SERIAL だけ）・NULLS NOT DISTINCT・INCLUDE・並び順・照合順序・コメント・EXCLUDE・DEFERRABLE が無い [29]。宣言の幅は Atlas と MikroORM が広い。
- **NOT VALID→VALIDATE の2段を自動で組む ORM は無い**（Prisma・Drizzle・Kysely・MikroORM・TypeORM のいずれも無いか生 SQL）。Atlas は SQL を作る所に句があり、lint（Pro）でロックを指摘する。DSQL では既存の表への外部キー・CHECK の追加に NOT VALID が**必須**なので、扱えない道具は DSQL で外部キーを足せない [17]。
- **CONCURRENTLY は「全体を1つのトランザクションで包む」設計とぶつかる。** Drizzle は CONCURRENTLY を出すが migrator は1つのトランザクションで流す。Kysely・MikroORM は回ごと・道具ごとに外すしかない。ファイル（操作）ごとに外せるのは Atlas（`atlas:txmode none`）と TypeORM の各 migration の `transaction`。
- **名前の扱いが割れている。** Drizzle・MikroORM は 63 を JS の文字数で数え、TypeORM はハッシュの短い名前、Postgres はバイトで切る。差分を名前で比べる道具（TypeORM の CHECK・索引、MikroORM の式の索引）は、定義だけを変えたときに拾い損ねる。

### 5.2 PoC で最初に網羅する範囲（案）

「既存の道具のどれかで扱え、利用者が日常で使い、Aurora PostgreSQL と DSQL の両方に関わる」ものを先にする。

1. **表・列・型・NOT NULL・DEFAULT（式を含む）・スキーマ**（F16・F18・F31）。
2. **主キー（複合）・UNIQUE（複合・NULLS NOT DISTINCT）・CHECK・外部キー（複合・5動作・自己参照・MATCH・DEFERRABLE）**（F01〜F05・F07・F08・F10〜F12・F14）。宣言の型の中で全オプションを持っておくと、後から足すより安い。
3. **索引：方式・式・部分・一意・INCLUDE・並び順と NULLS・演算子クラス**（F13・F22〜F25・F27・F28）。どれも CREATE INDEX の1文に収まり、差分は「定義を正規化して比べ、違えば作り直す」で済む。比較は名前ではなく `pg_get_indexdef` などの正規化した定義で行う。
4. **生成列 STORED と VIRTUAL、identity と sequence の設定**（F19〜F21）。VIRTUAL は他の道具に無く、18 の既定でもあるので差になる。STORED/VIRTUAL を常に明示して出す。
5. **名前の規則**（F32）：全部の制約と索引の名前を明示して保存し、63 バイトをバイトで検査して、超えたら計画の時点でエラーにする（黙って切らない）。既定の名前は Postgres の規約（`_pkey`・`_key`・`_fkey`・`_check`・`_idx`）に合わせる。
6. **安全な適用の型**：外部キー・CHECK・NOT NULL は「NOT VALID で足す → VALIDATE」、索引は「CONCURRENTLY（DSQL は ASYNC）→ 必要なら USING INDEX で制約に」を、計画の段階で選べるようにする。トランザクションは操作ごとに決め、CONCURRENTLY の操作は外に出す。INVALID の索引の後始末も入れる。UNIQUE の追加と型の変更の前には、重複の数・書き直しの有無を事前に検査して報告する。
7. **能力の検出**：接続先が PG 18 か・Aurora か・DSQL かで、使える構文（VIRTUAL・EXCLUDE・CONCURRENTLY と ASYNC・照合順序・USING）を切り替える。DSQL の「主キーは後で変えられない」「DDL は1トランザクションに1文」は計画で守らせる。

### 5.3 後に回してよいもの（案）

- **EXCLUDE**（F15）：Kysely 以外で扱える道具はあるが利用は少なく、DSQL・Limitless で使えない。宣言の型だけ用意し、差分は後で。
- **照合順序**（F29）・**コメント**（F30）：差分は単純だが、DSQL は C だけ。コメントは AI 向けの説明として価値があるので、早めでもよい。
- **SET NULL (列)**（F06）・**名前付き NOT NULL と NOT VALID**（F17）・**NOT ENFORCED・WITHOUT OVERLAPS・PERIOD**（18 の新機能）：使う人が少なく、18 未満では使えない。
- **パーティション・継承・トリガ・関数・RLS・GRANT**：今回の範囲の外（01・02 の空き）。基本のスキーマが固まってから。

## 出典

取得はすべて 2026-10-24。

Postgres（18）
1. https://www.postgresql.org/docs/18/sql-createtable.html
2. https://www.postgresql.org/docs/18/sql-altertable.html （Notes の節を含む）
3. https://www.postgresql.org/docs/18/sql-createindex.html （Building Indexes Concurrently を含む）
4. https://www.postgresql.org/docs/18/ddl-constraints.html
5. https://www.postgresql.org/docs/18/ddl-generated-columns.html
6. https://www.postgresql.org/docs/18/ddl-identity-columns.html
7. https://www.postgresql.org/docs/18/release-18.html （E.6.3.2.1 Constraints・生成列・uuidv7）
8. https://www.postgresql.org/docs/18/sql-syntax-lexical.html （NAMEDATALEN）
9. https://www.postgresql.org/docs/18/collation.html
10. https://www.postgresql.org/docs/18/sql-comment.html
11. https://www.postgresql.org/docs/18/ddl-schemas.html
12. https://www.postgresql.org/docs/18/indexes-types.html
13. Postgres のソース（REL_18_STABLE）：https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/indexcmds.c （`makeObjectName`・`ChooseRelationName`・`ChooseIndexName` の `pkey`・`excl`・`key`・`idx`）、src/backend/commands/tablecmds.c（`fkey`・`not_null`）、src/backend/catalog/heap.c（`check`）

AWS
14. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-unsupported-features.html （Migrating from PostgreSQL to Aurora DSQL・compatibility considerations）
15. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-sql-features.html
16. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.html
17. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/alter-table-syntax-support.html
18. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-index-syntax-support.html
19. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-create-index-async.html
20. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-ddl.html
21. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-primary-keys.html
22. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-sequence-syntax-support.html
23. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/CHAP_quotas.html
24. https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Updates.html
25. https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html
26. https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.rds_superuser.html
27. https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/limitless-reference.DDL-limitations.html

道具
28. https://www.postgresql.org/docs/17/sql-createtable.html （17 の生成列は構文に STORED が必須）
29. Prisma 8 RC：https://www.prisma.io/docs/orm/contract-authoring/psl-syntax ・ https://www.prisma.io/docs/orm/contract-authoring/advanced-postgresql （#limitations）・ https://www.prisma.io/docs/orm/reference/migration-api ・ https://www.prisma.io/docs/orm/migrations/how-migrations-work ・ https://www.prisma.io/docs/orm/migrations/editing-a-migration 。ソースは https://github.com/prisma/orm main f543fb4（2026-10-23。prisma/prisma-next は 2026-08-25 に archive され prisma/orm へ移った）の packages/2-sql-family/1-core/contract/src/ir/（foreign-key.ts・unique-constraint.ts・storage-column.ts・storage-table.ts）、packages/2-sql-family/2-authoring/contract-psl/src/sql-attribute-specs.ts、packages/3-targets/postgres/2-adapter/src/core/control-adapter.ts、packages/3-targets/postgres/1-target/src/core/（index-types.ts・default-constraint-names.ts・migrations/autoincrement-widths.ts）
30. Prisma 7：https://www.prisma.io/docs/orm/v7/reference/prisma-schema-reference ・ https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/indexes ・ …/v7/prisma-schema/data-model/relations/referential-actions ・ …/relations/self-relations ・ …/data-model/multi-schema ・ …/data-model/database-mapping ・ https://www.prisma.io/docs/orm/v7/more/troubleshooting/check-constraints 。ソースは https://github.com/prisma/prisma-engines d1b3f37 の schema-engine/connectors/sql-schema-connector/src/flavour/postgres/renderer.rs 。issue は prisma/orm #3388・#4693・#6336・#8703・#8807・#12914・#14456・#17514・#29635・#30270・#30573
31. Drizzle のソース：https://github.com/drizzle-team/drizzle-orm `beta` 5d71fc4（2026-10-21）の drizzle-orm/src/pg-core/（foreign-keys.ts・indexes.ts・columns/common.ts・checks.ts・unique-constraint.ts・primary-keys.ts・schema.ts・async/session.ts）、drizzle-kit/src/dialects/postgres/（ddl.ts・diff.ts・convertor.ts・grammar.ts）、drizzle-kit/src/cli/commands/push-postgres.ts
32. Drizzle の文書と issue：https://orm.drizzle.team/docs/indexes-constraints ・ https://orm.drizzle.team/docs/generated-columns 、issue #638・#886・#1429・#4074
33. Kysely：https://github.com/kysely-org/kysely v0.29.7（b506b63）の src/schema/（column-definition-builder.ts・create-table-builder.ts・foreign-key-constraint-builder.ts・unique-constraint-builder.ts・create-index-builder.ts）、src/query-compiler/default-query-compiler.ts、src/migration/migrator.ts、src/dialect/postgres/postgres-adapter.ts
34. MikroORM 7：https://github.com/mikro-orm/mikro-orm 99f6af7（@mikro-orm/core 7.2.5）の docs/docs/（defining-entities.md・indexes.md・composite-keys.md・multiple-schemas.md・migrations.md）、packages/sql/src/schema/（SchemaComparator.ts・SchemaHelper.ts・DatabaseSchema.ts）、packages/sql/src/dialects/postgresql/PostgreSqlSchemaHelper.ts、packages/core/src/naming-strategy/AbstractNamingStrategy.ts、packages/core/src/platforms/Platform.ts
35. TypeORM 1.x：https://github.com/typeorm/typeorm da473df（typeorm 1.1.2）の packages/typeorm/src/（driver/postgres/PostgresQueryRunner.ts・PostgresDriver.ts・schema-builder/RdbmsSchemaBuilder.ts・naming-strategy/DefaultNamingStrategy.ts・migration/MigrationExecutor.ts・metadata/types/OnDeleteType.ts）、docs/docs/indexes.md 。issue #3076・#3336・#9827・#10118・#11449・#12001・#12807・#12986・#12988
36. Atlas の文書：https://atlasgo.io/atlas-schema/hcl
37. Atlas のソースと文書：https://github.com/ariga/atlas main ed994a7 の sql/postgres/（sqlspec.go・migrate.go・driver.go）・sql/internal/specutil/convert.go、https://atlasgo.io/declarative/diff 、https://atlasgo.io/versioned/apply
38. https://atlasgo.io/lint/analyzers
