# 10 ローカルの開発・デバッグ・型の速さ・AI に向けた CLI と GUI

調べた日：2026-10-24。一次資料（公式の文書・リポジトリ・リリース・npm registry・GitHub API）だけを使う。`[n]` は末尾の出典の番号。確かめられなかったことは「未確認」と書く。1〜5 章は事実、6 章は考察。前の調査と重なるところ（MCP の各社の tool・Prisma のエージェントの検知・PGlite と testcontainers・型の重さの定石）は 02・03 を参照し、ここでは繰り返さない。

## 0. 要約

- GUI は「人が見る」ための道具として残っているが、作り手の側で縮んでいる。Prisma 8 には Studio が無く、Prisma 7 の CLI で動かすよう案内している [6]。Prisma 8 の同梱の skill は「GUI が無い・クエリのロガーが無い・EXPLAIN の統合が無い」と明記し、`prisma db schema`（CLI の木の表示）か psql などを使えと書く [8]。Drizzle Studio はローカル版が無料だが閉じたソース [1][2]。
- エージェント向けの CLI の形は各社でそろってきた。`--output json`（または `--json`）で stdout に1つの JSON、非対話を自動で検知、決められないことは「足りない判断」として JSON で返し、次の呼び出しで渡させる（drizzle-kit の `missing_hints`、exit 2）[35][36]。Prisma 8 は `ok/code/why/fix/nextActions/where` の封筒と意味のある終了コード（2・3・4）[8]、Neon は全コマンドに `--output json` [33]。
- Anthropic の公式は「CLI は外のサービスを扱う最も文脈の効率が良い方法」と書き [22]、Claude Code は MCP の tool のスキーマを使うまで読み込まず [23]、MCP の出力は既定で 25,000 トークンまで、Bash の出力は 30,000 文字まで読む [24][25]。
- デバッグ：OpenTelemetry の DB の semantic conventions は Stable。パラメータ付きの SQL の本文は既定で集めてよく、パラメータの値は opt-in [53]。ドライバ層（`instrumentation-pg`）は `db.collection.name` を出せない [56]。ORM はそれを知っているので、ここに価値がある。Prisma 8 は OTel のスパン・`$on('query')` を 8.0 に入れていない [48]。Drizzle は v1 で sqlcommenter の `.comment()` を足した [52]。
- 型の速さ：CI で測る実例は Kysely（`@ark/attest` でインスタンス化の数を PR に貼る）[72] と Prisma 8（インスタンス化の数で回帰を落とす方針、機能ごとの費用を ADR に記録）[74][75]。TS 7（tsgo）は `--generateTrace` を 2026-04〜05 に実装し、analyze-trace 0.11 が対応した [65][66]。ただし tsgo は既定で複数の checker が並列に動くため、インスタンス化の数が単一スレッドのときと大きく違う（例：689 万 vs 254 万）[67]。CI では `--checkers 1` で数を固定する必要がある。

## 1. 既存の GUI と CLI

### 1.1 比較表

| 道具 | 形・仕組み | ライセンス | データの閲覧・編集 | スキーマの可視化 | クエリの実行 |
|---|---|---|---|---|---|
| Drizzle Studio（ローカル） | `drizzle-kit studio` が `127.0.0.1:4983` にサーバを立て、ブラウザは `local.drizzle.studio`（Drizzle が置く UI）を開く。接続は手元で行い「データは外に出ない」。リモートの VPS で使うものではない [1][2] | Studio は閉じたソース。ORM と Kit はオープンソース。ローカル版は「永久に無料」[1][2] | ページング・絞り込み・並べ替え・行の追加・更新・削除、範囲のコピー、JSON・CSV・SQL での出し入れ [1] | テーブル・ビュー・列・index・外部キー・policy・権限を表示と管理 [1]。ER 図は未確認 | SQL コンソール（補完、EXPLAIN/ANALYZE）、Drizzle のクエリの実行 [1] |
| Drizzle Gateway・Chrome 拡張・埋め込み部品 | Gateway は Docker かバイナリで自前で立てる（複数の DB・パスワード）。Chrome 拡張は PlanetScale・D1・Vercel Postgres の画面に足す。埋め込み部品は有償の B2B。デスクトップ版は「近日」[1] | 同上 | 同上 | 同上 | 同上 |
| Prisma Studio（7 系） | `prisma studio` が `localhost:5555` を開く。`--url` で接続文字列を直に渡せる [3]。7.0 で作り直し、7.5 で複数セルの選択・全体の検索・Cmd+K・「SQL」タブ（生 SQL の実行）を追加 [4]。7.9 から適用済みの migration の時系列（変えたモデル・実行した SQL・前後の差分）を表示 [7]。7.10 でローカルのサーバを `127.0.0.1` に固定し、他の origin を拒否、ワイルドカードの CORS をやめた [5] | `@prisma/studio-core` は Apache-2.0（0.34.1、2026-10-15）[9] | セルの編集・行の追加と削除・絞り込み・関連の展開・CSV/JSON の書き出し [3] | migration の履歴の差分 [7]。ER 図は未確認 | SQL タブ [4] |
| Prisma 8 | Studio は「Prisma ORM 8 の道具には無い」。プロジェクトの外で `npx prisma@7 studio --url ...` を使えと案内 [6]。同梱の skill は「first-party の Studio は無い。`prisma db schema` で CLI の木を出すか、TablePlus・DataGrip・psql を使う」と書く [8] | ― | ― | `prisma db schema`（CLI）[8] | ― |
| Atlas | `atlas schema inspect` は既定で HCL、`--format` に Go のテンプレートを渡せる（`'{{ json . }}'` で JSON）[10][12]。`-w`（`--web`）で ER 図をブラウザで開く [10]。ORM の可視化のガイドは「可視化は Atlas Pro のみ」「先に `atlas login`」と書く [11]。Atlas Cloud はスキーマの文書を push のたびに作り直す [13] | CLI の版ごとの条件は 02 を参照 | なし | ER 図（Pro・Cloud）[11]。Mermaid の出力は公式の該当ページを取れず未確認 | なし（`migrate` などは 02） |
| Supabase Studio | ローカルは `supabase start`（Docker が必要）で `localhost:54323` [14]。ローカル版は Platform より機能が少なく、設定は config ファイルで変える [15] | リポジトリは Apache-2.0 [18] | Table Editor で閲覧と編集 [15] | Schema Visualizer（2023-08 の Studio 3.0 で追加）[17] | SQL Editor と AI（差分で受け入れ・拒否）[17] |
| pgAdmin 4（9.18） | デスクトップ・サーバ | リポジトリの表示は「Other」（名前は未確認）[18] | 主キーを含む結果は編集できる。改名・重複した列は読み取りのみ [20] | ER 図ツール：DB・スキーマ・テーブルから作る、図から DDL を作る、画像で保存 [19] | Query Tool、EXPLAIN の図（SVG で保存、VERBOSE は図にできない）[20] |
| psql（18） | 端末 | PostgreSQL | `\x`・`\gx`・`\crosstabview` [21] | `\d`・`\d+`・`\dt`・`\df`・`\sf`・`\dx`・`\dconfig` など。`-E` で `\d` が出す SQL を見せる [21] | `\bind`・`\parse`・`\bind_named` で拡張プロトコル、`\gdesc` で実行せずに列の名前と型 [21] |

### 1.2 psql の機械向けの面（事実）

- 出力の形式は `aligned`・`asciidoc`・`csv`・`html`・`latex`・`latex-longtable`・`troff-ms`・`unaligned`・`wrapped`。**JSON は無い** [21]。
- 台本向け：`--csv`・`-A`・`-t`・`-X`（`.psqlrc` を読まない）・`-c`・`-f`・`-1`（1つのトランザクション）[21]。
- 終了コード：0 正常、1 致命的、2 接続が切れた（非対話）、3 `ON_ERROR_STOP` のときのスクリプトのエラー [21]。

## 2. AI エージェントに向けた CLI の設計（公式の知見と実例）

### 2.1 公式の文書

| 出所 | 要点 |
|---|---|
| Claude Code のベストプラクティス | 「CLI は外のサービスを扱う最も文脈の効率が良い方法」。知らない CLI も `--help` から学べる。Claude が自分で確かめられる手段（テスト・ビルドの終了コード・lint）を渡す。文脈の窓が最も大事な資源 [22] |
| Claude Code の拡張の概要 | MCP は起動時に tool の名前だけを読み、スキーマは使うときまで遅らせる（tool search は既定で有効）。skill は説明だけを常に読む。hook は出力を返さない限り文脈を使わない [23] |
| Claude Code の上限 | MCP の出力が 10,000 トークンを超えると警告、既定で 25,000 トークンまで（`MAX_MCP_OUTPUT_TOKENS`）。50,000 文字を超える成功の結果はファイルに保存 [24]。Bash の出力は既定で 30,000 文字まで読む（最大 150,000）。Claude Code が起こす子のプロセスには `CLAUDECODE=1` が入る [25] |
| Anthropic「Writing effective tools for agents」（2025-09-11） | Claude Code は tool の応答を既定で 25,000 トークンに制限。ページング・範囲・絞り込み・切り詰めを良い既定で。`response_format` で concise（72 トークン）と detailed（206 トークン）。エラーは「具体的で行動につながる」文に。UUID より意味のある識別子 [26]（他の点は 03） |
| Anthropic「Code execution with MCP」（2025-11-04） | 多くの MCP クライアントは tool の定義を全部先に読み、途中の結果もすべてモデルを通る。コードで tool を呼ばせると 150,000→2,000 トークン（98.7% 減）。データはコードの中で絞り、モデルには5行だけ見せる。途中の結果は実行環境に残る（個人情報を守れる）。ただしサンドボックス・資源の制限・監視が要る [27] |
| GitHub CLI | 既定は行の平文。`--json` に項目を渡すと JSON、項目を省くと使える項目の一覧。`--jq`（jq を入れなくてよい）・`--template`。端末なら整形して出す [28]。終了コード 0 成功・1 失敗・2 取り消し・4 認証が要る（コマンドごとに追加あり）[29] |
| Vercel CLI | 2026-03-02：エージェント向けに `discover`・`guide`、`--format=json` で非対話の JSON。エージェントの評価で継続して試す [30]。非対話モード（`--non-interactive` かエージェントの自動検知）で自力で終われないとき、次のコマンドの候補を JSON で出す。この候補に `--token` の値がそのまま入る脆弱性があった（GHSA-pgf8-2hgj-grqg）[31] |
| Command Line Interface Guidelines（clig.dev） | 主な出力は stdout、ログとエラーは stderr。`--json`・`--plain`。stdin が TTY のときだけ対話。`--no-input`。`--dry-run`。危ない操作は確認、非対話なら `--force`。できる限り冪等に。大事な情報は出力の最後に [32] |
| OpenAI | Codex の CLI と IDE は MCP の設定を共有する、などの文書はある。CLI と MCP のどちらを使うべきかの公式の記述は見つからなかった（未確認） |

**MCP と CLI のどちらか**：Anthropic の公式の文書は二者択一としては書いていない。CLI は文脈の効率が良い [22]、MCP は外のサービスへの接続と認証をサーバが持つ [23]、tool の数が多いと定義と途中の結果が文脈を食う [27]、という三点が公式の記述。

### 2.2 DB の道具の CLI の実例（02 の MCP の表と重ならない範囲）

| 道具 | 機械が読める出力 | 非対話・判断の渡し方 | エラー・終了コード | エージェント向けの導入 |
|---|---|---|---|---|
| drizzle-kit（v1.0.0-rc.4、2026-06-27） | `generate`・`push`・`pull`・`up`・`export`・`check` に `--output text\|json`。stdout に1つの JSON（`status`: `ok`・`no_changes`・`missing_hints`・`error`）。同じ契約の SDK（`drizzle-kit/cli`）[35][36] | `--output json` か非 TTY の stdin で対話を出さない。改名か新規か・データの消失の承認を `missing_hints` で返し（exit 2）、`--hints`・`--hints-file` で渡させる [35][36] | `error.code`（`invalid_hints`・`check_error`・`database_driver_error` など）。接続文字列・SQL・パラメータは封筒に入れない [36] | `drizzle-kit mcp`（stdio）と `drizzle-kit skills`（8 個）[35] |
| Prisma 8 | 全コマンドに `--json`・`-v` [8] | 02 を参照（エージェントの検知と同意の文） | `ok:false`・`code`（`NAMESPACE.SUBCODE`）・`severity`・`why`・`fix`・`nextActions`・`where`・`docsUrl`。終了コード 2 実行できない・3 利用者が中止・4 実行して何かを見つけた（`db verify`）。終了コードだけでなく severity と code で分けよと書く [8] | 同梱の skill（03） |
| Neon CLI | 全コマンドに `--output json\|yaml\|table`。table は項目を省くことがある [33] | `NEON_API_KEY` で非対話の認証、`neon link` の非対話のフラグ [33]。`neon init -y` で推奨の設定を対話なしに（plugin か skills＋MCP を入れる）[34] | 未確認 | `neon init`・`neon mcp`・`neon skills` [33][34]。`neon inspect db`（bloat・calls・locks・outliers・seq-scans・unused-indexes など 15 種）[33] |
| Supabase CLI | `-o env\|pretty\|json\|toml\|yaml` は「status の変数の出力形式」[16]（全コマンドの JSON 化は未確認） | ― | 未確認 | `supabase inspect db`（bloat・blocking・calls・locks・outliers・traffic-profile など）[16]。宣言的なスキーマの同期（pg-delta）は `--experimental` [16] |

## 3. ローカルの開発のしやすさ

### 3.1 DB の立ち上げ

| 方法 | 事実 |
|---|---|
| PGlite | 02 を参照。最新 0.5.11（2026-10-21）、Apache-2.0 [9]。 |
| Prisma 7 の `prisma dev` | `@prisma/dev`（0.25.2、「開発とテスト用のローカルの Prisma Postgres サーバ」）は PGlite・`pglite-socket` に依存する [38]。Prisma 8 の `prisma dev` は Composer のアプリを手元のエミュレータで動かすコマンドに変わった [39] |
| Supabase local | Docker で Postgres・Auth・Storage など一式。API 54321・Postgres 54322・Studio 54323・Mailpit 54324。初回は image の取得で遅い [14]。`supabase stop --no-backup` は手元のスキーマとデータを消す [14] |
| Neon Local | Docker の proxy。データはクラウドの Neon の branch にあり、手元には無い。`PARENT_BRANCH_ID` で起動時に一時の branch を作り、止めると消す（`DELETE_BRANCH` 既定 true）。API キーが要る [37] |
| Docker の素の Postgres・testcontainers | 02 を参照 |

### 3.2 seed

| 道具 | 事実 |
|---|---|
| drizzle-seed（latest 0.3.1、2025-01-29。v1 は rc の tag で配布）[40] | seed の値を固定できる疑似乱数で、同じ seed なら同じデータ。既定は表ごとに 10 行。`.refine` で列ごとの生成器・行数・`with`（1 対多の子）。`reset()` は Postgres で `TRUNCATE ... CASCADE`。`with` は 1 対多のみ、列を共有する複合 unique が2つあると不可 [40] |
| Prisma 7 | `prisma.config.ts` の `migrations.seed` に任意のコマンド。v7 から `prisma db seed` を明示したときだけ動き、`migrate dev`・`migrate reset` での自動の seed はやめた [42] |
| Prisma 8 | seed のコマンドは無い。`db` を import して `.create(...)` を呼ぶスクリプトを `tsx` などで動かす [6] |
| Supabase | `supabase/seed.sql` を `db reset` が流す [15]。`supabase db seed` もある [16] |
| Snaplet seed の後継 | `supabase-community/seed`（MIT）。スキーマから型付きのクライアントを作り、関連を自動で作る [41]。コードの最後の変更は 2024-08、2026-10-01 に CI の設定の変更のみ。npm の `@snaplet/seed` の latest は 0.98.0（2024-07-30）[41]。実質は止まっている |

### 3.3 スキーマの即時の反映とドリフト

| 道具 | 事実 |
|---|---|
| drizzle-kit push | スキーマを JSON の snapshot にし、DB を introspect、差分の SQL を作って当てる。SQL ファイルは作らない。`--verbose`（実行前に全 SQL）、`--explain`（dry run）、`--force`（データ消失を自動承認）。「素早い試作に最適」で、本番の主の流れに使うチームもあると書く [43]。v1 rc.4 から JSON と hints で非対話 [36] |
| Prisma 7 `db push` | migration の表もファイルも作らない。データ消失が見込まれると `--accept-data-loss` を要求。「変更を事前に見る方法は無い」「他の環境へ再現するなら migration を使え」[44] |
| Prisma 8 | `db init`（空の DB）・`db update`（既存の DB を契約に合わせる。`--dry-run`、データ消失の前に確認、`--rename old:new`）。`db verify` で DB が契約と一致するかを確かめる（exit 4 で所見）[6][8] |
| Atlas・pgroll など | ドリフト検出・計画は 02・04 を参照 |

## 4. デバッグのしやすさ

### 4.1 発行した SQL とパラメータの記録

| ORM | 事実 |
|---|---|
| Drizzle | `drizzle-kit studio --verbose` は全 SQL を出す [2]。ORM のロガーの公式のページは取得できなかった（URL が 404。`logQuery(query, params)` の形は未確認）。OTel：`drizzle-orm/src/tracing.ts` は `drizzle.operation`・`drizzle.prepareQuery`・`drizzle.buildSQL`・`drizzle.execute`・`drizzle.driver.execute`・`drizzle.mapResponse` のスパンを定義するが、main の版では `@opentelemetry/api` の読み込みがコメントアウトされており、そのままでは動かない [51]。v1.0.0-beta.19 で sqlcommenter の `.comment({ key: 'val' })` を追加（Postgres・MySQL、prepared statement では使えない）[52] |
| Kysely | `log: ['query', 'error']`。`query` は SQL を出すがパラメータの値は出さない。関数を渡すと `event.query.sql`・`event.query.parameters`・`queryDurationMillis` を読める [45]。`.explain(format?, options?)` で `explain (analyze, format json) ...` を出せる [76]。OTel の公式の対応は文書に無い [45] |
| Prisma 7 | `log: ['query','info','warn','error']`、`emit: 'event'` で `$on('query')` から `query`・`params`・`duration` [46]。OTel は `@prisma/instrumentation`。スパンは `prisma:client:operation`・`prisma:engine:db_query` など。db の semantic conventions に沿うかは文書に書かれていない [47] |
| Prisma 8 | OTel のスパン・`$on('query')`・`$on('error')` は「8.0 に入れない」と明記 [48]。テレメトリは middleware の plugin が出す設計で、`planId`・`sqlFingerprint`（塩付きのハッシュ）・`latency.ms`・`rows.observed`・`rows.estimated`（EXPLAIN から）を持ち、パラメータは既定で伏せ、型と大きさだけを出す [49]（実装の検証は「Untested」[48]）。クエリのロガー・`.explain()` は無く、`db.raw.sql` で EXPLAIN を書けと案内 [8]。`lints` middleware：WHERE の無い DELETE・UPDATE は既定で止め（error）、LIMIT 無し・SELECT * は warn [50] |

### 4.2 OpenTelemetry の db.* の約束（事実）

- DB のクライアントのスパンは Stable。必須は `db.system.name`（Postgres は `postgresql`）。条件付きで必須：`db.collection.name`・`db.namespace`・`db.operation.name`・`db.response.status_code`（失敗時）・`error.type`（失敗時）。推奨：`db.query.text`・`db.query.summary`・`db.operation.batch.size`・`server.address` [53]。
- スパンの名前は `db.query.summary` を第一にする [53]。
- パラメータ付きの SQL の本文は既定で集めてよく、伏せない。パラメータ無しの本文は伏せてから。`db.query.parameter.<key>` は opt-in（Development）で、既定で集めてはならない [53]。
- 旧い規約からの移行は `OTEL_SEMCONV_STABILITY_OPT_IN=database`（または `database/dup`）[53]。
- Postgres：`db.namespace` は `{database}|{schema}`、`db.response.status_code` は SQLSTATE、Class 02 以上をエラーとする [54]。
- 文脈の伝播：sqlcommenter で `/*traceparent='...'*/` を SQL の末尾に付けてよい（Development、既定では無効）。prepared statement などで性能に響くことがある [53]。
- ソースの位置：`code.file.path`・`code.line.number`・`code.column.number`・`code.function.name`・`code.stacktrace` は Stable [55]。
- `@opentelemetry/instrumentation-pg`（0.77.0）：0.72.0 から Stable の規約を出す。`db.collection.name` は「pg は表の名前を別に出さず、仕様は複数の表に触れる SQL の解析を勧めない」ので出さない。`enhancedDatabaseReporting` でパラメータと結果を属性に、`addSqlCommenterCommentToQueries` で sqlcommenter（既に `--`・`/* */` を含む SQL には付けない）[56]。

### 4.3 エラーとソースの位置

- V8 の `stack` は既定で上から 10 フレーム（`Error.stackTraceLimit`）。`Error.captureStackTrace(obj, fn)` で `fn` より上を省いて取れる。取るのは作ったときだが、文字列にするのは読んだときで、`--async-stack-traces`（V8 7.3 から既定）は `await` の位置を足す [62]。
- どの TS の行がどの SQL を出したかを ORM が示す公式の仕組みは、Drizzle の `.comment()`（手で書く）[52] と OTel の `code.*` 属性（ORM 側の対応は確認できず）[55] の他に見つからなかった。Prisma 7 のエラーが呼び出しの位置を示すかは、文書の `errorFormat` の項に記述が無く未確認 [46]。Prisma 8 の CLI の封筒は `where: { path, line }` を持つ（契約や migration のファイルの位置）[8]。

### 4.4 Postgres の側の仕組み（PG 18）

| 仕組み | 事実 |
|---|---|
| EXPLAIN | `ANALYZE`・`VERBOSE`・`COSTS`・`SETTINGS`・`GENERIC_PLAN`（`$1` のまま計画、ANALYZE とは併用不可）・`BUFFERS`（ANALYZE のとき自動で含む）・`SERIALIZE`・`WAL`・`TIMING`・`SUMMARY`・`MEMORY`・`FORMAT TEXT\|XML\|JSON\|YAML`。ANALYZE は文を実際に実行するので、書き込みは `BEGIN; EXPLAIN ANALYZE ...; ROLLBACK;` で包む [58] |
| auto_explain | `log_min_duration`（既定 -1）・`log_analyze`・`log_buffers`・`log_format json` など。`log_parameter_max_length` の既定は -1（値を全部出す）。変更は superuser のみ。`log_analyze` は記録されない文にも節ごとの計時が入り「性能にきわめて悪い影響」があり得る。`LOAD` か `session_preload_libraries` [59]。Aurora はクラスタのパラメータグループの `shared_preload_libraries` に足す [61] |
| pg_stat_statements | `shared_preload_libraries` と `compute_query_id`、再起動が要る。定数は `$1` に置き換えて同じ形をまとめる。`IN` の長さ違いもまとめる。既定 5,000 件。`queryid` はメジャー版をまたいで安定と仮定してはいけない [60]。SQL のコメントを残すかは文書に記述が無い（未確認） |

### 4.5 N+1 の検出

- Sentry：連続して重ならない似た DB のスパン、合計 50ms 超、数が閾値（ふつう 5）超、本文が切れていない、前に1つ DB のスパンがある、の全部で検出 [57]。
- ORM 側：Prisma 8 の `lints` に N+1 の規則は無い [50]。Drizzle・Kysely の公式の N+1 の検出は見つからなかった（未確認）。

## 5. 型の速さの測り方

### 5.1 道具

| 道具 | 事実 |
|---|---|
| `tsc --extendedDiagnostics` | 型の数・インスタンス化の数・check の時間を出す（03 も参照）[63] |
| `--generateTrace` と `@typescript/analyze-trace` | trace を `about://tracing` で開くか、analyze-trace でホットスポットを出す。bundler 経由や遅いのがエディタでも、`tsc` の trace のほうが調べやすく代表的と書く [63][64]。analyze-trace の latest は 0.11.1（2026-06-26）[69] |
| TS 7（tsgo）の trace | `--generateTrace` は旗だけあって動かなかった（#3054）。#2914（2026-04-24）で `types.json`・`trace.json` を出すようにし、#3703（2026-05-12）で並列の checker ごとに `types_0.json`… と `legend.json` を出す形に直した。analyze-trace 0.11.0 以降が対応 [65][66] |
| TS 7 のインスタンス化の数の注意 | 既定の並列の検査では、重い union を参照するファイルが各 checker の受け持ちに入り、同じ仕事を何度もする。例：既定 6,891,764 回・40.2 秒 → `--checkers 1` で 2,537,315 回・14.3 秒（#2454、Hejlsberg のまとめ）[67] |
| エディタの補完の遅さ | 公式の手順は VS Code の `typescript.tsserver.log: verbose` と `TypeScript: Open TS Server log`、`typescript.tsserver.enableTracing` [63]。`@typescript/server-harness`（0.3.6）は tsserver に要求を送って編集の場面を再現する Microsoft の道具 [70]。補完の待ち時間を CI で測る公式の道具は見つからなかった（未確認）。TS 7 の LSP は README で「in progress（ほぼ全機能）」、API は「not ready」[68]。server-harness が tsgo の LSP に使えるかは未確認 |
| `@ark/attest`（0.58.0、alpha）| `bench(...).types([N, 'instantiations'])` で呼び出し1つが足すインスタンス化の数を決定的に測り、インラインの snapshot として比べる。`bench.baseline` で初回の費用を除く。閾値の既定は 20%、`--benchErrorOnThresholdExceeded` で落とす。`attest stats`（check の時間・インスタンス化・型の数）・`attest trace`（analyze-trace でホットスポット）[71] |

### 5.2 各 ORM の CI の実例

| リポジトリ | 事実 |
|---|---|
| Kysely | `test/ts-benchmarks/*.bench.ts` を `@ark/attest` で書き、`bench.yml` が PR ごとに `pnpm run bench:ts` を流して結果を PR に貼る。コマンドが失敗したら job を落とす [72]。例：`select(column)` は 279 回、誤った列名（`@ts-expect-error`）は 7,231 回 [72]。型の誤りを出す経路のほうが 26 倍重い |
| Drizzle | `drizzle-arktype/benchmarks/types.ts` に attest のベンチ（`createSelectSchema` が 13,129 回）[73]。ORM の本体の型を CI で測る仕組みは、コード検索の範囲では見つからなかった（未確認） |
| Prisma 8 | 設計のメモ：型の性能を型の凍結の前に測る。Bencher に `--extendedDiagnostics` の check の時間・インスタンス化・メモリをスキーマの大きさ（10/100/500 モデル）と TS の版（5.9・7）ごとに載せ、PR の回帰はウォールタイムでなくインスタンス化の数で落とす [74]（実際に運用しているかは未確認）。ADR に機能ごとの費用を記録（例：使っていない機能の存在だけで +342 回、200 モデルで fragment の定義 19,732 回）[75] |

## 6. 考察（ここからは事実ではなく案）

### 6.1 AI の時代に GUI は要るか

- 要らなくなる場面：スキーマの閲覧・データの確認・クエリの試行は、エージェントが CLI で JSON を読めば足りる。Prisma 8 が Studio を落として CLI の木の表示と既存の道具に回したのは、この判断に近い [6][8]。psql は `\d` で十分な情報を出すが JSON を出せないので [21]、「psql の `\d` 相当を JSON で返す CLI」には空きがある。
- 残る場面は「人が承認する」ところ。①破壊的な migration の計画の承認（差分・影響の行数・ロック）、②ER 図（全体の把握。数十の表を文で読むのは人に向かない）、③実データの見た目の確認（seed の結果、文字化け、NULL の分布）、④EXPLAIN の木。どれも「読むだけ・一時的」でよく、編集できる GUI である必要は薄い。
- 案：常駐の GUI を作らず、CLI が人に見せる成果物を出す。`schema --format mermaid`（ER 図を PR に貼れる）、`plan --format html`（承認の頁を1枚の静的な HTML に）、`explain --format html`。Drizzle Studio の作り（手元のサーバ＋ホストされた UI）は閉じたソースと外部のドメインへの依存を生む [1][2]。Prisma 7.10 の修正のとおり、手元のサーバは 127.0.0.1 固定と origin の検査が要る [5]。静的なファイルならこの面が無い。

### 6.2 AI に向けた CLI の機能の案

1. **出力の契約**：全コマンドに `--json`。stdout に JSON を1つ、ログは stderr。`status` を判別子にした union にし、CLI と同じ型の SDK を出す（drizzle-kit の形）[36]。端末でないときは自動で非対話。
2. **判断を返す**：対話の代わりに「足りない判断」を JSON で返し、`--hints` で次に渡させる（改名か新規か・データ消失の承認）[36]。危ない操作は `--force` ではなく、計画の hash を指定させる（`apply --plan <hash>`）と、見た計画と流す計画のずれを防げる。
3. **エラー**：`code`・`why`・`fix`・`nextActions`・`where`（ファイルと行）・`docsUrl` [8]。終了コードを意味で分ける（例：0 成功・1 予期しない失敗・2 判断が要る・3 中止・4 所見あり）[8][29][36]。
4. **大きさ**：既定で行数と列数を絞り、切ったことと続きの取り方（`nextCursor`）を出す。Claude Code の Bash は 30,000 文字で切れる [25]。表の中身は既定で 20 行程度、`--limit`・`--columns`・`--where` で絞る [26][27]。
5. **秘密を出さない**：接続文字列・パラメータの値・トークンを JSON に入れない（Vercel の脆弱性と drizzle-kit の方針）[31][36]。
6. **読み取りの道具**：`db inspect`（Neon・Supabase の `inspect db` 相当を JSON で：遅いクエリ・未使用の index・ロック・bloat）[16][33]、`db describe <table>`（psql の `\d+` 相当）、`db sample <table> --limit`、`db verify`（契約と DB の差、exit 4）[8]。
7. **MCP は薄く**：CLI と SDK を本体にし、MCP は同じ関数を出すだけにする。文脈の費用は CLI が小さく [22][27]、MCP は接続と認証を持たせたいときに使う [23]。

### 6.3 PoC に入れるべきデバッグの機能

1. **クエリのイベント**：1つの購読口（`onQuery`）に `sql`・`params`（既定は伏せ、開発では表示の切り替え）・`durationMs`・`rows`・`table`・`operation`・`callsite`。
2. **呼び出しの位置**：開発の既定でだけ `Error.captureStackTrace` で取り、ORM の内部のフレームを省いて最初の利用者の行を `code.file.path`・`code.line.number` にする [55][62]。本番は既定で切る（費用は PoC で測る）。
3. **OTel**：Stable の db.* に沿ったスパンを最初から出す。ORM は表と操作を知っているので、ドライバ層が出せない `db.collection.name`・`db.query.summary`（例：`SELECT users`）を埋める [53][56]。sqlcommenter は opt-in [53]。
4. **EXPLAIN**：`.explain({ analyze })` を全てのクエリに。書き込みの ANALYZE は自動で `BEGIN … ROLLBACK` に包む [58]。CLI からは保存したクエリやログの1行を `explain` に渡せるように。`GENERIC_PLAN` でパラメータ無しの計画も [58]。
5. **N+1**：開発のときだけ、1つの要求（AsyncLocalStorage の範囲）の中で同じ `db.query.summary` が N 回続いたら警告。閾値は Sentry の形（回数と合計時間）を初期値に [57]。
6. **lint**：WHERE の無い UPDATE・DELETE を止める、LIMIT 無しを警告（Prisma 8 の形）[50]。
7. **型の速さを CI に**：attest で代表のクエリ（正しい呼び出しと誤った呼び出しの両方。誤りのほうが重い [72]）のインスタンス化の数を固定する。TS 6 と TS 7 の両方で、TS 7 は `--checkers 1` で数を安定させる [67]。PR で回帰を落とす基準はインスタンス化の数（決定的）にし、時間は参考にとどめる [74]。

### 6.4 未確認・PoC で確かめること

- 呼び出しの位置を毎回取る費用（V8 の `captureStackTrace` を毎クエリ。async の深い呼び出しで）。
- `--checkers 1` の数と既定の並列の数のどちらで基準を置くか（利用者の体感は並列、決定性は単一）。
- エディタの補完の待ち時間を TS 7 の LSP で自動で測る方法（server-harness が使えるか）。
- sqlcommenter のコメントが pg_stat_statements の正規化でどう扱われるか（文書に記述が無い）[60]。

## 出典

1. Drizzle Studio overview — https://orm.drizzle.team/drizzle-studio/overview
2. drizzle-kit studio — https://orm.drizzle.team/docs/drizzle-kit-studio
3. Prisma Studio Getting Started — https://www.prisma.io/docs/orm/tools/prisma-studio
4. Prisma 7.5.0 release — https://github.com/prisma/prisma/releases/tag/7.5.0
5. Prisma 7.10.0 release — https://github.com/prisma/prisma/releases/tag/7.10.0
6. Coming from Prisma ORM 7 — https://www.prisma.io/docs/orm/coming-from-prisma-orm-7.md
7. Studio with Prisma ORM — https://www.prisma.io/docs/studio/prisma-next.md
8. Prisma 8 skill: debug — https://github.com/prisma/orm/blob/main/skills/prisma-8/references/debug.md
9. npm registry（@prisma/studio-core・@electric-sql/pglite）— https://registry.npmjs.org/@prisma/studio-core ・ https://registry.npmjs.org/@electric-sql/pglite
10. Atlas CLI reference — https://atlasgo.io/cli-reference
11. Atlas: Visualize Drizzle schema — https://atlasgo.io/guides/orms/drizzle/visualize
12. Atlas blog: ERD and JSON（2022-12-06）— https://atlasgo.io/blog/2022/12/06/erd-and-json
13. Atlas Cloud Schema Docs — https://atlasgo.io/cloud/features/schema-docs
14. Supabase CLI Getting started — https://supabase.com/docs/guides/local-development/cli/getting-started
15. Supabase Local development overview — https://supabase.com/docs/guides/local-development/overview
16. Supabase CLI reference — https://supabase.com/docs/reference/cli/introduction
17. Supabase Studio 3.0（2023-08-09）— https://supabase.com/blog/supabase-studio-3-0
18. GitHub API（supabase/supabase・pgadmin-org/pgadmin4 の license）— https://api.github.com/repos/supabase/supabase ・ https://api.github.com/repos/pgadmin-org/pgadmin4
19. pgAdmin 4 9.18 ERD Tool — https://www.pgadmin.org/docs/pgadmin4/latest/erd_tool.html
20. pgAdmin 4 9.18 Query Tool — https://www.pgadmin.org/docs/pgadmin4/latest/query_tool.html
21. PostgreSQL 18 psql — https://www.postgresql.org/docs/current/app-psql.html
22. Claude Code Best practices — https://code.claude.com/docs/en/best-practices
23. Claude Code Extend Claude Code — https://code.claude.com/docs/en/features-overview
24. Claude Code MCP — https://code.claude.com/docs/en/mcp
25. Claude Code environment variables — https://code.claude.com/docs/en/env-vars
26. Anthropic, Writing effective tools for agents（2025-09-11）— https://www.anthropic.com/engineering/writing-tools-for-agents
27. Anthropic, Code execution with MCP（2025-11-04）— https://www.anthropic.com/engineering/code-execution-with-mcp
28. gh help formatting — https://cli.github.com/manual/gh_help_formatting
29. gh help exit-codes — https://cli.github.com/manual/gh_help_exit-codes
30. Vercel changelog（2026-03-02）— https://vercel.com/changelog/vercel-cli-for-marketplace-integrations-optimized-for-agents
31. GHSA-pgf8-2hgj-grqg（CVE-2026-44479）— https://github.com/advisories/GHSA-pgf8-2hgj-grqg
32. Command Line Interface Guidelines — https://clig.dev/
33. Neon CLI reference — https://neon.com/docs/reference/neon-cli
34. Neon CLI init — https://neon.com/docs/cli/init
35. Drizzle v1.0.0-rc.4 release — https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4
36. drizzle-kit JSON_CONTRACT.md（rc.4）— https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-kit/JSON_CONTRACT.md
37. Neon Local — https://neon.com/docs/local/neon-local
38. npm @prisma/dev — https://registry.npmjs.org/@prisma/dev
39. Prisma CLI dev（Prisma 8）— https://www.prisma.io/docs/cli/dev.md
40. drizzle-seed overview — https://orm.drizzle.team/docs/seed-overview ・ https://registry.npmjs.org/drizzle-seed
41. supabase-community/seed — https://github.com/supabase-community/seed ・ https://registry.npmjs.org/@snaplet/seed
42. Prisma 7 Seeding — https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/seeding.md
43. drizzle-kit push — https://orm.drizzle.team/docs/drizzle-kit-push
44. Prisma 7 Prototyping your schema — https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/prototyping-your-schema.md
45. Kysely Logging — https://kysely.dev/docs/recipes/logging
46. Prisma 7 Logging・errorFormat — https://www.prisma.io/docs/orm/prisma-client/observability-and-logging/logging ・ https://www.prisma.io/docs/orm/v7/reference/prisma-client-reference.md
47. Prisma 7 OpenTelemetry tracing — https://www.prisma.io/docs/orm/prisma-client/observability-and-logging/opentelemetry-tracing
48. Prisma 8 scorecard: Observability & lifecycle — https://github.com/prisma/orm/blob/main/scorecard/19-observability-and-lifecycle.md
49. Prisma 8 ADR 024 Telemetry schema — https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20024%20-%20Telemetry%20Schema.md
50. Prisma 8 Built-in: lints — https://www.prisma.io/docs/orm/middleware/built-in-lints.md
51. drizzle-orm/src/tracing.ts — https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/tracing.ts
52. Drizzle v1.0.0-beta.19 release — https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.19
53. OTel Semantic conventions for database client spans — https://opentelemetry.io/docs/specs/semconv/database/database-spans/
54. OTel Semantic conventions for PostgreSQL — https://opentelemetry.io/docs/specs/semconv/database/postgresql/
55. OTel registry: code attributes — https://github.com/open-telemetry/semantic-conventions/blob/main/docs/registry/attributes/code.md
56. @opentelemetry/instrumentation-pg README — https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/packages/instrumentation-pg/README.md
57. Sentry N+1 Queries — https://docs.sentry.io/product/issues/issue-details/performance-issues/n-one-queries/
58. PostgreSQL 18 EXPLAIN — https://www.postgresql.org/docs/current/sql-explain.html
59. PostgreSQL 18 auto_explain — https://www.postgresql.org/docs/current/auto-explain.html
60. PostgreSQL 18 pg_stat_statements — https://www.postgresql.org/docs/current/pgstatstatements.html
61. Aurora: Working with extensions — https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Appendix.PostgreSQL.CommonDBATasks.html
62. V8 Stack trace API — https://v8.dev/docs/stack-trace-api
63. TypeScript wiki: Performance — https://github.com/microsoft/TypeScript/wiki/Performance
64. TypeScript wiki: Performance Tracing — https://github.com/microsoft/TypeScript/wiki/Performance-Tracing
65. typescript-go #2914 adds tracing — https://github.com/microsoft/typescript-go/pull/2914 ・ #3054 https://github.com/microsoft/typescript-go/issues/3054
66. typescript-go #3703 Fixes to --generateTrace — https://github.com/microsoft/typescript-go/pull/3703
67. typescript-go #2454 — https://github.com/microsoft/typescript-go/issues/2454
68. typescript-go README — https://github.com/microsoft/typescript-go
69. npm @typescript/analyze-trace — https://registry.npmjs.org/@typescript/analyze-trace
70. @typescript/server-harness — https://github.com/microsoft/typescript-server-harness
71. @ark/attest — https://github.com/arktypeio/arktype/tree/main/ark/attest ・ https://arktype.io/docs/attest/benches ・ https://arktype.io/docs/attest/cli
72. Kysely type benchmarks — https://github.com/kysely-org/kysely/blob/master/test/ts-benchmarks/select.bench.ts ・ https://github.com/kysely-org/kysely/blob/master/.github/workflows/bench.yml
73. drizzle-arktype benchmarks — https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-arktype/benchmarks/types.ts
74. Prisma 8 RC1 design notes — https://github.com/prisma/orm/blob/main/projects/prisma-8-rc1/design-notes.md
75. Prisma 8 ADR 259 Query fragments are functions — https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20259%20-%20Query%20fragments%20are%20functions.md
76. Kysely src/util/explainable.ts — https://github.com/kysely-org/kysely/blob/master/src/util/explainable.ts
