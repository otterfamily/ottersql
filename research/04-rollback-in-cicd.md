# 04 CI/CD でのマイグレーションとロールバック

調べた日：2026-10-24。一次資料（公式文書・ソースのリポジトリ・ADR・公式 blog）だけを使う。`[n]` は末尾の出典の番号。確かめられなかったことは「未確認」と書く。1〜3 章は事実、4 章は考察。

問い：「Prisma はなぜ down を入れないのか。CI/CD でマイグレーションを自動で流すなら、ロールバックの仕組みは絶対に必要ではないか」

## 0. 要約

- Prisma が down を嫌う理由は 2022 年の公式 blog に書かれている。「down は誤った安心感を与え、事態を悪くすることが多い」。理由は2つで、(a) up が途中で落ちると down も落ちる、(b) 消した列のデータは列を足し直しても戻らない [8]。Prisma 8（Prisma Next）はこの考えを仕組みにした。migration は contract のハッシュからハッシュへの有向の辺で、戻すのは前の状態へ向かう新しい辺になる（`git revert` であって `git reset` ではない）[1][3][4]。
- ほかの道具も、本番は「前へ進めて直す（roll-forward）」を基本にしている。graphile-migrate [11]、Atlas [13]、GitLab の本番 [20] がそうで、Flyway は undo を出しつつ、DB をいま動いている全版のコードと互換に保つほうを勧める [18]。Google の SRE はスキーマを戻さずにアプリだけを戻す手順（v+1 → スキーマ → v+2）を勧める [23]。
- ただし down を捨てた道具ばかりではない。Atlas は、今の DB の状態から戻す計画を作る `migrate down` を出した [12][13]。GitLab は全 migration に可逆を求め、CI で「全部上げる → 最初まで下げる → また上げる」を毎回流す [20][22]。
- 「ロールバック」には 4 つの違う仕組みがある。①アプリだけを戻す（スキーマは N-1 互換）、②down を流す、③DB ごと戻す（PITR・スナップショット・クローン）、④途中で落ちた migration を片付ける。CI/CD に絶対に要るのは①と④。②は安全に戻せる操作のときだけ使える。③は最後の手段で、時間がかかり、戻した時点より後の書き込みを失う。
- Aurora PostgreSQL には in-place で巻き戻す Backtrack が無い（Aurora MySQL だけ）[34]。PITR は新しいクラスタを作るので、AWS 自身が「数時間かかることがある」と書いている [34]。Aurora PostgreSQL のブルー/グリーンでは、blue で DDL を流すと複製が壊れるので、スキーマ変更を戻す道具にはならない [37]。Aurora DSQL は AWS Backup の表で「継続バックアップと PITR」に印が無い [40]。

## 1. Prisma が down を入れない理由

### 1.1 原文

| 出典 | 原文（抜粋） |
|---|---|
| Prisma blog 2022-02-03 [8] | "after careful consideration, we believe that rollbacks (down migrations) give a false sense of security and often exacerbate the situation." |
| 同 [8] | "If the up migration fails, and not all four fields were removed, re-adding those in the down migration will also fail" / "The data in the removed columns is gone; re-adding the columns won't help recover the lost data." |
| 同 [8] | "Stick to non-breaking additive changes and use the expand and contract pattern for renames and breaking-changes." |
| Prisma 8 docs [1] | `migrate down` も down のファイルも無い。理由は "undoing a change is not a special kind of operation here"。"Rolling back is one more migration that makes the database match an earlier contract state." "this is `git revert` rather than `git reset`." |
| 同 [1] | 回復（途中で落ちた migration）とロールバックを分ける。回復は原因を直して同じコマンドを流し直すだけ。"Re-running the same command is the whole of recovery, because there is no `migrate resolve` step first." |
| prisma-next 設計文書 [2] | "we don't have `up` and `down` migrations. Every migration is forward-applied; if you want to return to a prior state, you author a migration whose destination is that state, or `migrate --to <prior-ref>`" / "Avoid `rollback` and `revert` as user-facing verbs — they import semantics we don't honor." |
| prisma-next 利用の筋書き [4] | "we never reverse-execute a migration; we author a *new forward migration* whose `to`-contract is the earlier contract. … the ledger gets a new row, and the rollback is itself reviewable in PR." |
| ADR 001 [5] | migration を `fromHash → toHash` の辺にした理由：ファイルの順番に頼ると枝分かれ・squash に弱い。"Agents and CI need deterministic, machine-verifiable answers to basic questions like 'is it safe to apply this change'"。辺は DB の印が `fromHash` と一致するときだけ流せる。CI で shadow DB による事前の試しを必須にする。 |
| ADR 039・subsystem 文書 [3][7] | グラフは閉路を許す（"rollback migrations C1→C2→C1"）。経路は BFS で探し、訪れた点を覚えて無限ループを防ぐ。 |
| ADR 123 [6] | 途中で落ちたときは操作の冪等性（完全・条件付き・非冪等）で回復の手順を分ける。非冪等なら手で直すか DB を作り直す。"Rollback always possible (if backups available)" |

補足：「down を作らない」理由を正面から書いた ADR は、prisma-next の ADR の一覧（`docs/architecture docs/adrs/`）からは見つからなかった。理由は ADR 001（辺のモデル）・設計文書 [2]・2022 年の blog [8] に分かれて書かれている。なお利用の筋書き [4] は "The graph stays a DAG" と書くが、subsystem 文書と ADR 039 は閉路を許すと書いていて、文書どうしで食い違っている [3][4][7]。

### 1.2 Prisma 7 以前との違い

| | Prisma 7 以前 | Prisma 8 |
|---|---|---|
| down の作り方 | 手順の文書だけ。`migrate diff --script` で `down.sql` を作り、migration のフォルダに置く [9] | 作らない。`migration plan --from … --to "<dir>^"` で前の contract へ向かう新しい辺を作る [1][3] |
| down を流せる場面 | **失敗した migration だけ**。`db execute` で `down.sql` を流し、`migrate resolve --rolled-back` で記録する。`migrate resolve` は失敗した migration にしか使えない [9]。成功した migration を戻すには `schema.prisma` を戻して新しい migration を作る [9][10] | 失敗でも成功でも同じ「新しい辺」 |
| 戻らないもの | "other changes to data and application code … will not be reverted" [9] | 破壊的な操作を確認なしで流すので、計画を読んでから流す [1] |
| 途中で落ちたとき | `migrate resolve --rolled-back` か `--applied` で記録を直してから再実行 [10] | `migrate resolve` は無く、流し直すだけ [1] |

## 2. 他の道具・公式文書の立場

### 2.1 道具

| 道具 | 立場 | 原文・要点 |
|---|---|---|
| graphile-migrate | 前へ進むだけ | "roll-forward only — maintaining rollbacks is a chore, and in 10 years of API development I've never ran one in production" / "production issues should be fixed via additional migrations, development can iterate current migration" [11] |
| Atlas | 基本は前へ進む。戻すための `migrate down` は別に持つ | 履歴は "roll-forward" が既定。戻すのは、ステージングで試すときや "when the entire deployment is rolled back and the schema changes … are not backward compatible for old versions of the application" のとき [13]。前もって書いた down を退けた理由："the database might be in an unknown state" "Re-applying the migration would not bring back the data" "I never applied them on a real environment" [12]。そこで "Atlas computes a migration plan based on the current state of the database"。できれば1つのトランザクションで流し、できなければ1文ずつ戻す。データを消す計画は事前の検査で止める [13]。承認の流れは Pro の機能 [13] |
| pgroll | expand/contract と版ごとの view | "At any point during a migration, it can be rolled back to the previous version." "This will remove the new schema and leave the old one as it was before the migration started." view で古い版と新しい版のスキーマを同時に動かす。Postgres 14 以上 [14] |
| Reshape | 同じ型（view と trigger） | `reshape migration abort` は `start` の変更を "without losing data" で戻す [15]。2026-09-26 にも commit がある（GitHub API） |
| Rails | down／可逆な `change` | `change_column` は不可逆。`remove_column` は型を書けば可逆。戻せないものは `ActiveRecord::IrreversibleMigration` を投げる。migration はトランザクションで包まれ、`disable_ddl_transaction!` で外せる。データの移行を migration で行うことは勧めない [16] |
| Django | 逆向きの migrate | 前の番号を指定すれば戻せる。不可逆な操作があると `IrreversibleError`。`RunPython` は戻す関数を渡さないと戻せない。DDL のトランザクションに対応した DB（SQLite・PostgreSQL）では migration 全体が1つのトランザクションになり、`atomic = False` で外せる。MySQL は DDL がトランザクションに入らないので、失敗すると手で片付ける必要がある [17] |
| Flyway | undo（Teams 版） | "Undo migrations assume the whole migration succeeded and should now be undone." DDL がトランザクションに入らない DB で途中で落ちると undo は役に立たない。勧めるのは "maintain backwards compatibility between the DB and all versions of the code currently deployed in production" と、よく試したバックアップと復元 [18] |
| Liquibase | 一部は自動で戻す | `addColumn`・`createTable`・`createIndex`・`renameTable` は戻す SQL を自動で作る。`dropTable`・`dropColumn`・`insert`・`update`・`delete`・`sql` は自動では戻せない。SQL 形式の changelog は戻す文を全部手で書く [19] |

### 2.2 運用している組織の公式文書

| 出典 | 要点 |
|---|---|
| GitLab の migration の書き方 [20] | "Your migration must be reversible. This is very important, as it should be possible to downgrade in case of a vulnerability or bugs." 一方で "On GitLab production environments, if a problem occurs, a roll-forward strategy is used instead of rolling back migrations using `db:rollback`."。セルフマネージド版の利用者には、更新の前に取ったバックアップから戻すよう勧める。down は主に開発で使う |
| GitLab の CI [22] | `db:rollback` のジョブで、全部上げたあと最初の migration まで下げ、もう一度 `db:migrate` を流す。全 migration の up→down→up を CI で毎回確かめている |
| GitLab の無停止の手引き [21] | 列を消すときは 3 リリースに分ける（無視する → 消す → 無視をやめる）。"dropping a column is a destructive operation that can't be rolled back easily." 消すのはデプロイの後に流す migration（post-deployment migration）で行う |
| Google SRE（CRE の blog、2017）[23] | "rollbacks are normal"。スキーマを変えるときは、機能を足さずに新しいスキーマを扱えるだけの v+1 を出す → スキーマを変える → 機能を入れた v+2 を出す。こうすれば "you can roll back to a previous version without having to also roll back the schema." |
| Google Cloud Spanner [24] | DDL は長く動く処理として流れ、その間も読み書きできる。`NOT NULL` を足すと検証の前から NULL の書き込みを拒み、検証が失敗すると、その間に書き込みが止められていたことになる。バッチの途中で失敗したとき前の文が残るかは、ページからは未確認 |

## 3. CI/CD での「ロールバックの仕組み」の型

### 3.1 一覧

| 型 | 戻すもの | 時間 | 失うデータ | 条件 | 出典 |
|---|---|---|---|---|---|
| ① アプリだけを戻す（N-1 互換・expand/contract） | アプリの版 | アプリのデプロイと同じ | なし | スキーマが今の版と1つ前の版の両方で動くこと。破壊的な変更は後のリリースに回す | [18][20][21][23] |
| ①' 版ごとの view（pgroll・Reshape） | 新しいスキーマの版 | すぐ（`complete` の前） | なし | `complete` の前に限る。trigger で両方の版へ書き込む | [14][15] |
| ② down を流す | 最後の migration | 短い | 消した列・表・型を狭めた分のデータは戻らない | 操作が可逆であること。前提の状態と DB が一致していること | [8][12][16][17][19] |
| ③-a PITR（Aurora） | DB 全体を過去の時点へ | 新しいクラスタを作る。「数時間かかることがある」 | 指定した時点より後の書き込み全部（新しいクラスタへ移すので） | 保持期間の中。接続先を切り替える必要がある | [33][34] |
| ③-b Backtrack | DB 全体を in-place で巻き戻す | 数分 | 指定した時点より後の書き込み全部 | **Aurora MySQL だけ。Aurora PostgreSQL には無い**。作るときに有効にする。最大 72 時間 | [34] |
| ③-c クローン | 試すための複製 | 速い（copy-on-write） | — | 戻す仕組みではなく、本番に流す前の試しに使う。copy-on-write は 15 個まで | [35] |
| ③-d ブルー/グリーン | 切り替える前なら blue に残る | 切り替えは「たいてい1分以内」 | — | Aurora PG では DDL が複製されず、blue で DDL を流すと複製が壊れる。切り替えた後は逆向きの複製が無く、古い blue は読み取り専用 | [36][37][38] |
| ③-e Aurora DSQL のバックアップ | DB 全体 | 新しいクラスタを作る | バックアップの時点より後 | AWS Backup の表で、継続バックアップと PITR に印が無い（2026-10-24 時点） | [39][40] |
| ④ 途中で落ちた migration の片付け | 1つの migration | 短い | なし（トランザクションの中なら） | 下の 3.3 を参照 | [1][6][17] |

### 3.2 型ごとの補足（事実）

- **①**：Flyway [18]・GitLab [20][21]・Google [23] はどれも、DB をいま動いている全版のアプリと互換に保ち、アプリだけを戻す形を勧める。Atlas の `migrate down` も、互換でない変更をアプリと一緒に戻すときのためにある [13]。
- **②**：down が安全なのは、追加を戻す操作のうち、追加した物にまだ大事なデータが入っていないときだけ。Liquibase が自動で戻せるのは追加の操作（`addColumn` など）で、削除やデータの変更は戻せない [19]。追加を戻す down は、その間に書かれたデータを消す [12]。Rails も `change_column` を不可逆としている [16]。
- **③**：Aurora のドキュメントは Backtrack を勧める理由として、PITR は "launches a new DB cluster and restores it from backup data or a DB cluster snapshot, which can take hours" と書いている [34]。PITR の復元先は常に新しいクラスタ [33]。ブルー/グリーンで切り替えると PITR の履歴は引き継がれず、新しい本番は green を作った時点より前には戻せない [37]。切り替えの途中で止まった場合は両方が元に戻る [38]。
- **Aurora PostgreSQL のブルー/グリーンは、スキーマの migration を戻す手段にならない**：論理複製なので "DDL statements … aren't replicated from the blue environment to the green environment"。blue で DDL を見つけると "Replication degraded" になり、作り直すしかない [37]。切り替えの前の検査でも DDL を確かめる [38]。green でスキーマを変えてから切り替える使い方について、Aurora PostgreSQL での可否は文書から未確認。

### 3.3 失敗した migration の途中の状態（Postgres）

- Postgres は DDL をトランザクションに入れられるので、migration を1つのトランザクションで流せば、落ちたときは何も残らない（Django [17]、Rails [16]）。
- トランザクションに入らない操作があり、これを含む migration は途中まで流れた状態を残しうる：
  - `CREATE INDEX CONCURRENTLY`：トランザクションの中では流せない。失敗すると "invalid" な索引が残り、検索には使われないのに更新の手間はかかる。勧める片付けは索引を消して作り直すか、`REINDEX INDEX CONCURRENTLY` [25]
  - `DROP INDEX CONCURRENTLY` [26]、`REINDEX CONCURRENTLY` [27]、`ALTER TABLE … DETACH PARTITION CONCURRENTLY` [28]、`VACUUM` [29]、`CREATE DATABASE` [29]
- トランザクションに入っても後で使えないもの：`ALTER TYPE … ADD VALUE` をトランザクションの中で流すと、コミットするまで新しい値を使えない [30]。
- 戻らないもの：シーケンスの `nextval` はトランザクションが中断しても戻らない（番号に穴があく）[31]。
- ロック：`ALTER TABLE` の多くは ACCESS EXCLUSIVE ロックを取る [28]。`lock_timeout` でロックを長く待つ文を中断できる [32]。
- Prisma 8 の ADR は、操作ごとに冪等性を「完全・条件付き・非冪等」に分け、回復の手順を変える [6]。Atlas は、1つのトランザクションにできない down を1文ずつ戻す [13]。
- Aurora DSQL は1つのトランザクションに DDL を1文しか入れられず、DDL と DML は別のトランザクションにする（`02-migration-testing-compat.md` 参照）。複数の文からなる migration が原子的に流れることは前提にできない。

## 4. 考察：「ロールバックは絶対に必要」をどう設計に落とすか

ここからは考察。

### 4.1 問いを分ける

「ロールバックが要る」は、CI/CD では次の4つの要求に分かれる。道具が保証するものは要求ごとに違う。

| 要求 | 本当に要るか | 道具が保証できること |
|---|---|---|
| R1 アプリのデプロイを戻したら動く | **必ず要る** | 計画が N-1 互換かを判定する。互換でない操作は expand/contract に分け、デプロイの順番に縛りを付ける |
| R2 途中で落ちた migration を、決まった状態に戻すか先へ進める | **必ず要る** | 1つのトランザクションで流せる単位に分ける。分けられない操作（CONCURRENTLY など）は単独の段にし、冪等にして流し直せるようにする。DB の印と照合する |
| R3 成功した migration のスキーマを戻す | 場面による | 可逆な操作だけ down を自動で作り、往復を CI で確かめる。不可逆な操作は「戻せない」と宣言させる |
| R4 データまで過去に戻す | まれ（事故） | 道具ではなく基盤（PITR・バックアップ）の役目。道具は「不可逆な操作の前にバックアップがあること」を確かめるか、要求する |

Prisma 8 は R2 を「冪等にして流し直す」で、R3 を「新しい辺」で満たし、R1 は文書で勧めるに留めている [1][6][8]。ユーザーの「絶対に必要」は主に R1 と R2 を指していると考えられ、そこは down が無くても満たせる。一方 R3 で down を自動で作って往復を確かめるのは、調べた範囲の道具では GitLab が CI の仕組みとしてしているだけ [22]で、空いている所にあたる（01・02 と同じ結論）。

### 4.2 操作を可逆・不可逆に分ける（案）

| 分類 | 例 | down | CI での扱い |
|---|---|---|---|
| 可逆・データを失わない | 表・列（NULL 可）・索引・制約の追加（NOT VALID → VALIDATE）、既定値の変更、view・関数の作成と置換（前の定義を持っておく） | 自動で作る | up→down→up の往復を使い捨ての DB で流し、スキーマの差がゼロであることを確かめる |
| 可逆だが戻すとデータを失う | 追加した列・表を戻す | 自動で作るが「データを失う」の印を付ける | down を流す前に、対象にデータがあれば止める（Atlas の事前の検査 [13] と同じ考え） |
| 不可逆 | 列・表の削除、型を狭める変更、データの書き換え、enum の値の削除 | 作らない | expand/contract に分けることを強制する（削除は後のリリースの contract の段に回す）。contract の段の前にバックアップか PITR の時点を記録させる |
| トランザクションに入らない | `CREATE INDEX CONCURRENTLY` など | 逆の操作（`DROP INDEX CONCURRENTLY`）を自動で作る | 単独の段で流す。失敗して invalid な索引が残ったら、消して作り直す手順を計画に入れる [25] |

### 4.3 計画に入れるデプロイの順番

- 各操作に「アプリより前に流す（expand）」と「アプリの後に流す（contract）」の印を付ける。GitLab の通常の migration と post-deployment migration の分け方 [20][21]、Google の v+1 → スキーマ → v+2 の順番 [23] と同じ考え。
- contract の段は、1つ前のアプリの版がもう動いていないことを CI が確かめてから流す（pgroll の `complete` にあたる [14]）。
- 計画は JSON で出し、各操作に「可逆か」「データを失うか」「トランザクションに入るか」「段（expand／contract）」を持たせる。エージェントと CI はこれを読んで判定する。

### 4.4 down を残す場面と残さない場面

- 残す：開発やプレビューの環境でブランチを切り替えるとき（GitLab も down を主に開発で使う [20]）、ステージングで試してから戻すとき [13]、expand の段の直後に問題が見つかり、まだデータが入っていないとき。
- 残さない（前へ進めて直す）：contract の段の後、データを書き換えた後、本番で時間がたった後。この場面の down は Prisma [8] と Atlas [12] が書くとおり、データを戻せず、前提の状態が崩れていることが多い。
- 実装の方針：down は前もって書いたファイルにせず、Atlas のように今の DB の状態から作るか [13]、Prisma 8 のように「前の contract へ向かう辺」として作る [1]。そのうえで、可逆な操作の往復を CI で確かめた結果を辺に付けて保存すれば、「戻せることを確かめた辺」と「戻せない辺」を区別できる。

### 4.5 Aurora への当てはめ

- Aurora PostgreSQL には Backtrack が無く [34]、ブルー/グリーンも DDL を戻す道具にならない [37]。DB ごと戻すのは PITR（新しいクラスタ、数時間、それより後の書き込みを失う）[33][34] しか無いので、R1・R2 を道具で守ることの価値が大きい。
- クローン [35] は、本番の大きさのデータで計画を試す（ロックの時間や検証の時間を測る）用途に向く。
- Aurora DSQL は DDL を1文ずつしかトランザクションに入れられないので、計画を「1文1段」に分け、各段を冪等にする必要がある。PITR は AWS Backup の表で印が無く [40]、DB ごと戻す手段はバックアップからの新しいクラスタに限られる [39]。

## 出典

1. Prisma 8 docs「Rollbacks and recovery」 https://www.prisma.io/docs/orm/migrations/rollbacks-and-recovery
2. prisma/prisma-next `docs/design/04-inspirations/migrations/established-conventions.md` https://github.com/prisma/prisma-next/blob/main/docs/design/04-inspirations/migrations/established-conventions.md
3. prisma/prisma-next `docs/architecture docs/subsystems/7. Migration System.md` https://github.com/prisma/prisma-next/blob/main/docs/architecture%20docs/subsystems/7.%20Migration%20System.md
4. prisma/prisma-next `docs/design/10-domains/migration/user-journeys.md` https://github.com/prisma/prisma-next/blob/main/docs/design/10-domains/migration/user-journeys.md
5. prisma/prisma-next ADR 001「Migrations as Edges」 https://github.com/prisma/prisma-next/blob/main/docs/architecture%20docs/adrs/ADR%20001%20-%20Migrations%20as%20Edges.md
6. prisma/prisma-next ADR 123「Drift Detection, Recovery & Reconciliation」 https://github.com/prisma/prisma-next/blob/main/docs/architecture%20docs/adrs/ADR%20123%20-%20Drift%20Detection,%20Recovery%20&%20Reconciliation.md
7. prisma/prisma-next ADR 039「Migration graph path resolution & integrity」 https://github.com/prisma/prisma-next/blob/main/docs/architecture%20docs/adrs/ADR%20039%20-%20Migration%20graph%20path%20resolution%20&%20integrity.md
8. Prisma blog「Improving Prisma Migrate DX with two new commands」（2022-02-03） https://www.prisma.io/blog/prisma-migrate-dx-primitives
9. Prisma 7 docs「Generating down migrations」 https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/generating-down-migrations
10. Prisma 7 docs「Patching & hotfixing」 https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/patching-and-hotfixing
11. graphile/migrate README https://github.com/graphile/migrate/blob/main/README.md
12. Atlas blog「The Myth of Down Migrations; Introducing Atlas Migrate Down」（Ariel Mashraki、2024-04-01） https://atlasgo.io/blog/2024/04/01/migrate-down
13. Atlas docs「Down Migrations」 https://atlasgo.io/versioned/down
14. xataio/pgroll README https://github.com/xataio/pgroll/blob/main/README.md
15. fabianlindfors/reshape README https://github.com/fabianlindfors/reshape/blob/main/README.md
16. Rails Guides「Active Record Migrations」 https://guides.rubyonrails.org/active_record_migrations.html
17. Django docs「Migrations」 https://docs.djangoproject.com/en/5.2/topics/migrations/
18. Redgate Flyway「Undo migrations」 https://documentation.red-gate.com/fd/undo-migrations-273973334.html
19. Liquibase「Automatic and custom rollbacks」 https://docs.liquibase.com/workflows/liquibase-community/automatic-custom-rollbacks.html
20. GitLab「Migration Style Guide」 https://docs.gitlab.com/development/migration_style_guide/
21. GitLab「Avoiding downtime in migrations」 https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/
22. gitlab-org/gitlab `.gitlab/ci/database.gitlab-ci.yml`（`db:rollback` のジョブ） https://gitlab.com/gitlab-org/gitlab/-/blob/master/.gitlab/ci/database.gitlab-ci.yml
23. Google Cloud blog「Reliable releases and rollbacks — CRE life lessons」（Adrian Hilton、2017-03-25） https://cloud.google.com/blog/products/gcp/reliable-releases-and-rollbacks-cre-life-lessons
24. Google Cloud Spanner「Make schema updates」 https://docs.cloud.google.com/spanner/docs/schema-updates
25. PostgreSQL 18「CREATE INDEX」 https://www.postgresql.org/docs/current/sql-createindex.html
26. PostgreSQL 18「DROP INDEX」 https://www.postgresql.org/docs/current/sql-dropindex.html
27. PostgreSQL 18「REINDEX」 https://www.postgresql.org/docs/current/sql-reindex.html
28. PostgreSQL 18「ALTER TABLE」 https://www.postgresql.org/docs/current/sql-altertable.html
29. PostgreSQL 18「VACUUM」 https://www.postgresql.org/docs/current/sql-vacuum.html ・「CREATE DATABASE」 https://www.postgresql.org/docs/current/sql-createdatabase.html
30. PostgreSQL 18「ALTER TYPE」 https://www.postgresql.org/docs/current/sql-altertype.html
31. PostgreSQL 18「Sequence Manipulation Functions」 https://www.postgresql.org/docs/current/functions-sequence.html
32. PostgreSQL 18「Client Connection Defaults」（`lock_timeout`） https://www.postgresql.org/docs/current/runtime-config-client.html
33. Amazon Aurora「Restoring a DB cluster to a specified time」 https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-pitr.html
34. Amazon Aurora「Backtracking an Aurora DB cluster」 https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Backtrack.html
35. Amazon Aurora「Cloning a volume for an Amazon Aurora DB cluster」 https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Managing.Clone.html
36. Amazon Aurora「Overview of Amazon Aurora Blue/Green Deployments」 https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/blue-green-deployments-overview.html
37. Amazon Aurora「Limitations and considerations for Amazon Aurora blue/green deployments」 https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/blue-green-deployments-considerations.html
38. Amazon Aurora「Switching a blue/green deployment in Amazon Aurora」 https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/blue-green-deployments-switching.html
39. Amazon Aurora DSQL「Backup and restore for Amazon Aurora DSQL」 https://docs.aws.amazon.com/aurora-dsql/latest/userguide/backup-aurora-dsql.html
40. AWS Backup「Feature availability」 https://docs.aws.amazon.com/aws-backup/latest/devguide/backup-feature-availability.html
