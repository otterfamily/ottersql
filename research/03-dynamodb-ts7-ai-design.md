# DynamoDB を SQL っぽく・TypeScript 7 と型の性能・AI エージェント向けのライブラリ設計

調べた日：2026-10-24。出典は一次資料（公式文書・ソースのリポジトリ・リリース・npm registry・GitHub API）だけ。番号は末尾の「出典」。確かめられなかったことは「未確認」と書く。
§1〜§3 は事実、§4 は考察。

## 結論の要約

- **DynamoDB の PartiQL は「SQL の形をした DynamoDB の API」にとどまる。** `WHERE` に分割キーの `=` か `IN` が無いと全件の Scan になる。`UPDATE`・`DELETE` は1項目だけ。JOIN・集計は無く、関数は5つと `SIZE` だけ。IAM の `dynamodb:FullTableScan` で Scan を拒否できる [13][14][15][16][19]。
- **TS の DynamoDB ライブラリで勢いがあるのは ElectroDB と DynamoDB-Toolbox v2。** OneTable は archived。どれも「アクセスパターンを先に定義から作る」形で、SQL の自由な問い合わせとは違う [1]〜[12]。
- **複数の DB を1つの API で扱う試みでは、Prisma の経緯が一番参考になる。** Prisma 6 の MongoDB は Migrate に対応しなかった。Prisma 7 では MongoDB への対応をやめた。Prisma 8（RC）では、SQL とは別の「family」として MongoDB を作り直している。共有するのは契約（contract）の構造・ORM のメソッドの形・エラーの形・マイグレーションの枠組みで、問い合わせの言語は共有しない [22]〜[28]。
- **TypeScript 7.0 は 2026-07-08 に安定版になった（npm の `latest` は 7.0.2）。** 7.0 にはプログラムから使う API が無く、7.1 beta（2026-10-20）で新しい API（`typescript/sync`・`typescript/async`）が入った [35][36][38]。
- **TS 7 では、型の重い ORM がかえって遅くなる例が出ている。** Kysely の再現では、型のインスタンス化が TS 6 の 60 万回から TS 7 の 980 万回に増えた。TS 7 が、TS 6 なら途中で打ち切っていた再帰を深く調べるようになったため。Kysely 側で型の再帰を取り除くと 9.5 万回に下がった [42][43]。
- **エージェント向けの公式の知見は次の4つにまとまる。** 版に合った文書を手元に置く（`AGENTS.md` から node_modules の文書へ案内する）、構造を持ったエラー（コード・理由・次の手）、ツールのエラーはモデルが直せる形で返す（MCP の `isError`）、ツールは少なく名前と説明を明確に [53][54][55][58][59][27]。

## 1. DynamoDB を SQL っぽく・型安全に扱う

### 1.1 PartiQL for DynamoDB（AWS 公式）

| 項目 | 事実 | 出典 |
| --- | --- | --- |
| 位置づけ | PartiQL の「部分集合」に対応する。Ion の形式には対応しない。性能・可用性・遅延は他のデータプレーンの操作と同じ | [13] |
| SELECT の文法 | `SELECT expr FROM table[.index] [WHERE cond] [ORDER BY key]`。FROM はテーブルか索引1つだけで、JOIN の構文は無い | [14] |
| Scan になる条件 | 「WHERE に分割キーの等号か IN が無いと、全件の Scan になり得る」。`OrderID > 1`、キーでない属性だけの条件、`OrderID = 100 OR Address = ...` はすべて Scan。WHERE を省くと全件を読む | [14] |
| Scan を防ぐ | IAM で `dynamodb:PartiQLSelect` を、条件キー `dynamodb:FullTableScan = true` のときに Deny にする | [14][19] |
| UPDATE / DELETE | 1つの文で1項目だけ。条件は「主キーの値1つに決まる」必要がある。該当が無いと `ConditionalCheckFailedException` を返す | [15] |
| 関数 | `SIZE`・`EXISTS`・`ATTRIBUTE_TYPE`・`BEGINS_WITH`・`CONTAINS`・`MISSING` だけ。「一覧に無い SQL の関数は対応していない」。COUNT・SUM などの集計は無い | [16] |
| トランザクション | `ExecuteTransaction` で最大 100 文。読みと書きは混ぜられない（`EXISTS` だけは例外で、ConditionCheck の代わりに使える） | [17] |
| バッチ | `BatchExecuteStatement` で最大 25 文。読みと書きは混ぜられない。読みは BatchGetItem を使い、主キーの一覧を取る | [18] |
| ページングと費用 | 1回で読めるのは 1 MB まで。`Limit` は「評価する件数」で、合う件数ではない。フィルタは読んだ後にかかる。`NextToken` が付けば続きを読む。消費した容量は `ReturnConsumedCapacity` で返る | [20] |
| 文の長さ | 最大 8,192 文字 | [20] |

- PartiQL の課金が、元の API（Query・Scan・GetItem）と同じかどうかを書いた公式の文は見つけられなかった（**未確認**）。容量は応答の `ConsumedCapacity` で確かめられる [20]。
- IAM の権限は `PartiQLSelect`・`PartiQLInsert`・`PartiQLUpdate`・`PartiQLDelete` に分かれていて、`dynamodb:EnclosingOperation` を使えばトランザクションの中だけ許す・拒む、もできる [19]。

### 1.2 TS の DynamoDB ライブラリ

| | ElectroDB | DynamoDB-Toolbox v2 | Dynamoose | OneTable |
| --- | --- | --- | --- | --- |
| 最新の版（npm の latest） | 3.9.3（2026-08-09） | 2.11.1（2026-10-22） | 4.2.0（2026-05-05） | 2.7.7（2025-02-25） |
| 週のダウンロード数 | 約 37.2 万 | 約 8.0 万 | 約 10.3 万 | 約 2.1 万 |
| GitHub の star / 最後の push | 1,180 / 2026-08-09 | 2,002 / 2026-10-22 | 2,250 / 2026-10-11 | 716 / archived |
| 単一テーブルの扱い | Entity から pk・sk・GSI を作る。同じ分割キーを持つ Entity をまとめた **Collection** を1回の Query で読み、Entity ごとの配列で返す | Entity が項目にエンティティ名の印を自動で付ける（`entityAttribute`。単一テーブルでは外さないよう勧める）。キーは `computeKey` で作る | Mongoose に倣った Model と Schema | 単一テーブルの設計のための API。キーの組み立て・疎な GSI・属性の詰め込み |
| 型の作り方 | 「スキーマがそのまま型になる」（推論） | スキーマから推論する。Zod・JSON Schema と相互に変換できる | 未確認（調べていない） | スキーマから型付きの Entity を自動で作る |
| 操作の形 | `get`・`put`・`update`・`patch`・`query`・`scan` を連鎖させる。filter と condition を持つ | `Entity.build(UpdateItemCommand).item(...).send()`。操作（action）を個別に import するので tree-shake できる。依存が無い | Model のメソッド | 高水準の API。DynamoDB を呼ばずにパラメータだけを作ることもできる |
| 出典 | [1][5][6][9][10] | [2][5][6][11][12] | [3][5][6][8] | [4][5][6][7] |

- どれも PartiQL ではなく、ネイティブの API（Query・GetItem など）の式を作る。PartiQL に対応すると書いた公式の文は、ElectroDB と DynamoDB-Toolbox の概要のページには無い [9][11]。
- 同じユーザーの以前の調査（ElectroDB 3.9.3 と Toolbox 2.11.0 の比較、束ねた大きさ 225 KB 対 43 KB など）は [21] にある。

### 1.3 複数の DB を1つの道具で扱う試み

| 道具 | 公式の設計 | うまくいかなかった点・制約 | 出典 |
| --- | --- | --- | --- |
| Prisma 6 × MongoDB | 同じ Prisma Schema と Client を使う | Migrate に対応しない（「対応する予定は無い」とし、`db push` を使う）。外部キーが無いので、リレーションはフィールドで真似る。イントロスペクションでリレーションが出ない。入れ子の書き込みが内部でトランザクションを使うため、レプリカセットが要る。null と「無い」を区別しない。複合 ID・`autoincrement`・Decimal に対応しない | [22] |
| Prisma 7 | Rust を使わない ESM のクライアント | 「Prisma 7 は MongoDB に対応していない。MongoDB を使う人は v6 にとどまる」 | [23] |
| Prisma 8（RC、npm の `prisma@latest` は 8.0.0-rc.27） | TS で書き直した。**契約が先**（決まった形の JSON の IR と軽い型を出す。生成したクライアントをやめる）。SQL と MongoDB を別の **family** にし、family ごとに契約・実行の流れ・マイグレーションを持つ。ORM は `where`・`select`・`include`・`orderBy` などの形を family の間でそろえる | 「文書 DB に共通の問い合わせの言語は無い」ので、汎用の「document family」を作らず、Firestore を足すなら別の family にすると書く。契約の **ドメインの層**（models・fields・relations）は family をまたいで同じ構造、**保存の層**（table・column と collection）は family ごとに分ける。DynamoDB の family は無い（リポジトリを `dynamo` で探して見つからない） | [24][25][26][28][29] |
| Kysely | `Dialect` = `createDriver`・`createQueryCompiler`・`createAdapter`・`createIntrospector` | 方言は SQL のエンジンに限る（公式の一覧は PostgreSQL・MySQL・MSSQL・SQLite・PGlite と community の方言）。DynamoDB の方言は公式の一覧に無い | [30][31] |
| Drizzle | 方言ごとに別の core（`pg-core`・`mysql-core`・`sqlite-core`・`singlestore-core`・`gel-core`）を持ち、方言をまたぐ抽象の API は作らない | 1.0.0-beta.9 で `PgColumn` の型の連鎖を他の方言から切り離し、型の性能を上げた | [32][33] |

### 1.4 「Postgres と DynamoDB を同じ道具で」が成り立つ範囲（事実と考察を分ける）

事実：
- DynamoDB の読みが安いのは、分割キーの等号（と並べ替えキーの範囲）で読むときだけ。それ以外は Scan で、1 MB ごとのページングとフィルタ後の空のページが起きる [14][20]。
- 書き込みは1項目ずつ（トランザクションは 100 件、バッチは 25 件）で、集計と JOIN は無い [15][16][17][18]。
- Prisma は、MongoDB を SQL と同じ抽象に入れて一度うまくいかず、別の family として作り直している [22][23][26]。

考察：
- 共通にできるのは、①ドメインのモデルの記述（エンティティ・属性・型・コーデック）、②エラーの形、③マイグレーションの枠組み（計画 → 適用 → 検証。DynamoDB ではテーブルと GSI、データの書き換え）、④実行の計画（plan）を観測する仕組み、⑤メソッドの名前と形。
- 共通にできないのは、問い合わせの意味。Postgres の `where` は何でも書けるが、DynamoDB の `where` は「どのキーで読むか」を決める。DynamoDB の側は「アクセスパターンを契約に書き、それ以外は型で書けない（Scan は明示した名前の別の API だけ）」にすると、SQL っぽさと DynamoDB らしさの両方を保てる。

## 2. TypeScript 7 と型の性能

### 2.1 TS 6・7 の状況

| 項目 | 事実 | 出典 |
| --- | --- | --- |
| TS 6.0 | 2026-03-23 に公開。「5.9 と 7.0 の橋渡し」で、JS のコードで作る最後の版。7.0 で消える設定を非推奨にした（`target: es5`・`moduleResolution node10`・`baseUrl` など）。`--stableTypeOrdering` で 7.0 と同じ型の順番にできる（最大 25% 遅くなる）。npm の最後の 6.x は 6.0.3（2026-04-16） | [37][38] |
| TS 7.0 | 2026-07-08 に公開（npm の `latest` は 7.0.2）。Go で書き直した。全体のビルドは 8〜12 倍速い（`--checkers 8` では 10.6〜16.7 倍）。既定の型検査のワーカーは 4 つ。`--checkers` の数を変えると「まれに順番に依存した結果が出る」 | [35][38] |
| 互換 | 「6.0 で（`stableTypeOrdering` を有効にし、`ignoreDeprecations` を使わずに）エラーなく通るコードは、ほぼ同じ結果になる」。既定が変わった：`strict: true`・`module: esnext`・`types: []` など。テンプレートリテラル型の推論が Unicode のコードポイント単位になった | [35] |
| API | 7.0 にはプログラムから使う API が無い。6.0 の API を使う道具（typescript-eslint など）のために、`@typescript/typescript6`（`tsc6` コマンドと 6.0 の API）を並べて入れる | [35] |
| 言語サーバ | 7.0 のエディタの機能は LSP で動く。Vue・Svelte・Astro・MDX・Angular のテンプレートの検査はまだ 7 を使えない | [35] |
| TS 7.1 beta | 2026-10-20 に公開。新しい API（`typescript/sync`・`typescript/async`・`typescript/ast`・`typescript/fs`）。`API` と `Program` は `Disposable` で、`using` で閉じる（閉じないと Go の側のメモリが漏れる）。tsconfig は自分で読まない。安定とはまだ宣言していない。7.0 より 1.2〜1.9 倍速く、メモリは 16〜50% 減る。テンプレートリテラル型の大きさに上限を付けた。分配条件型を厳しくした（破壊的な変更）。RC は「約1か月後」の予定で、7.1 の安定版の日付は書かれていない | [36] |
| リポジトリ | `microsoft/typescript-go` は archived になった。開発は `microsoft/TypeScript` に戻り、Go のソースは `tsc/internal/...` にある。`@typescript/native-preview` は `typescript@next` に置き換わる | [35][39][41] |
| 言語サービスのプラグイン | 7.0 の発表は、プラグインへの対応に触れていない（**未確認**）。7.1 には埋め込みの形式のための `contentMappers`（`--runExternalCode` が要る）がある | [35][36] |

### 2.2 型の重い ORM の公式の issue

| 例 | 内容 | 出典 |
| --- | --- | --- |
| Kysely × TS 7（typescript-go #4579） | 同じコードで TS 7 の検査が TS 6 の5倍以上遅い。Hejlsberg：TS 6 は「無限に広がる型」と見なして早めに打ち切っていたが、TS 7（#3445）は再帰でない型を見分けて深く調べる。インスタンス化は TS 6 が 601,143 回、TS 7 が 9,795,115 回。「想定どおりの振る舞いで、問題は型の複雑さと費用」 | [42] |
| Kysely の直し（kysely #1947） | 型の無限の再帰を取り除いた。インスタンス化は TS 7.0.2 で 9,795,115 → 94,536 回（−99%）、検査の時間は 2.794 秒 → 0.056 秒。TS 6.0.3 でも 601,143 → 93,113 回 | [43] |
| 再帰の深さのエラー（typescript-go #4055） | 再帰する mapped 型で TS2589。Hejlsberg：「このエラーは意図どおりで、TS 6 が出さないことがあったのがバグ。TS 7 で直した」 | [44] |
| TS 7 だけのエラー（typescript-go #4630） | 7.0.2 で TS2321（比較の stack が深すぎる）。原因は利用者の道具（`@effect/tsgo`）だった。TS のチームは、再現を小さくするエージェント用の skill（`ts-maintain-reduce-repro`）を案内した | [45][50] |
| 上限の値 | TS 7 の checker は、インスタンス化の再帰が 100 段、または1つの文・式で 500 万回に達すると止めて、エラーの型を返す | [41] |
| Kysely の文書 | TS2589 には `$assertType` で出力の型を単純な型に置き換えるよう案内する（例：`with` を 12 個を超えて重ねると起きる）。PR #1637（最小の型で検査を軽くする案）はマージされていない | [46][47] |
| Drizzle | drizzle-zod・drizzle-valibot・drizzle-typebox で TS2589（#3869 など、closed）。drizzle-zod と NestJS で推論が非常に遅い（#4823、open） | [48] |

### 2.3 型の計算を軽くする定石（公式）

- 交差型より `interface` の `extends` を使う。interface の関係はキャッシュされるが、交差型は全体としてはキャッシュされない [40]。
- 戻り値の型を注釈する。宣言の出力に `import("...").T` が出たら、名前の付いた型にする合図 [40]。
- 十数個を超える union は避け、基底の型を使う [40]。
- 複雑な条件型には名前（型エイリアス）を付けて、キャッシュが効くようにする [40]。
- `--extendedDiagnostics` で `Types`・`Check time`（とインスタンス化の数）を見る。`--generateTrace` の形式は版ごとに変わり得る [40]。
- `--isolatedDeclarations`（TS 5.5〜）：公開する API に型を明示すれば、型検査なしで `.d.ts` を作れる。並列のビルドが速くなる [49]。
- 生成した型と推論した型：Prisma 8 は「重い実行時のコード生成」をやめ、「決まった形の JSON の契約と TypeScript の型」を出す方へ移った [25]。推論で作る型と生成した型の性能を比べた公式の資料は見つからなかった（**未確認**）。

## 3. AI エージェントに向けたライブラリ設計の公式の知見

| 出所 | 要点 | 出典 |
| --- | --- | --- |
| llms.txt（Jeremy Howard、2024-09-03 提案、2026-08-10 更新） | サイトの根かサブパスに Markdown の `/llms.txt` を置く。必須は H1 だけ。要約の引用、H2 のリンクの一覧、飛ばしてよい `Optional` の節を書く。各ページの `.md` 版を同じ URL に置く | [51] |
| MCP 2026-07-28（調べた時点で見つかった最新の版。前の版は 2025-11-25） | ステートレスな中核にし、initialize と `Mcp-Session-Id` をやめた。ツールの入出力のスキーマは JSON Schema 2020-12。エラーは2種類：プロトコルのエラー（JSON-RPC）と、ツールの実行のエラー（`isError: true`。「モデルが自分で直して再試行できる、行動につながる内容」を返す）。クライアントはツールのエラーをモデルに渡すべき（SHOULD）。`outputSchema` と `structuredContent` を持てる。状態はハンドルを明示して渡す。ツールの一覧は決まった順で返す（プロンプトのキャッシュが効く） | [52][53] |
| Anthropic「Writing effective tools for agents」（2025-09-11） | ツールは少なく、役割を重ねない。名前空間の接頭辞を付ける。情報量の多いものだけを返し、`response_format` で詳しさを選ばせる。ページング・絞り込み・切り詰めを良い既定で入れる。エラーは「何が悪く、何を変えればよいか」を書く。評価のタスクで測る | [54] |
| OpenAI 関数の呼び出しのガイド | 名前と説明を明確にする。enum とオブジェクトの構造で「不正な状態を作れない」ようにする。「新人のテスト」に通るか。コードで分かる引数をモデルに求めない。最初に見せる関数は 20 個未満。`strict: true` でスキーマに必ず従わせる | [55] |
| AGENTS.md | エージェント向けの README。Linux Foundation の Agentic AI Foundation が管理する。決まった書式は無い。一番近い場所のファイルが優先される | [56] |
| Agent Skills の仕様 | `SKILL.md`（`name`・`description` が必須）と `scripts/`・`references/`・`assets/`。段階的に読み込む（メタデータ約 100 トークン → 本文 5,000 トークン未満 → 資料は必要なときに） | [57] |
| Vercel（2026-01-27） | Next.js 16 の評価で、8 KB に縮めた文書の索引を `AGENTS.md` に入れると合格率 100%。skill は既定で 53%（文書が無いときと同じ。56% の場面で呼ばれなかった）、明示して指示しても 79% | [58] |
| Next.js（16.2〜16.3） | 版に合った文書を `node_modules/next/dist/docs/` に同梱する。`AGENTS.md` に管理された節（「これはあなたの知っている Next.js ではない」）を自動で書く。ページごとの `.md`・`llms.txt`・`llms-full.txt` を用意。MCP サーバ（`/_next/mcp`）でコンパイルの問題を返す。エラーは「直し方の選択肢（ラベル付き）＋エージェント向けのエラーのページ」。skill は調べものではなく「複数の手順の作業」に使う | [59] |
| Prisma 8 | 「AI エージェントに優しい」を掲げる。プロジェクトに `prisma-8.md` を置き、パッケージに同梱した `SKILL.md` を `.claude/skills/` などに入れる（版と一致する）。エラーは `NAMESPACE.SUBCODE` のコード・`why`・型付きの `nextActions`（`run-command`・`edit-file` など）・`where` を持つ構造で、P2002 のような番号のコードはやめた。契約の組み立ては拒否をデータで全部返し、どこの問題かをキーで示す | [24][27][28] |
| TypeScript のチーム | issue の再現を小さくするためのエージェント用の skill を公開し、案内している | [45][50] |

- 型エラーをエージェントが直しやすくする工夫（例：型のエラーの文面を自分で設計する）を、ライブラリ作者向けにまとめた公式のガイドは見つからなかった（**未確認**）。見つかった公式の実例は、Kysely の `$assertType` の案内 [46]、Next.js のエラーごとのページ [59]、Prisma 8 の構造化したエラー [27] で、どれも実行時またはビルドのエラーについてのもの。

## 4. 設計の方向の考察（ここからは考察）

1. **契約を先に作り、型は生成する。** スキーマを決まった形の JSON（IR）にし、そこから平らで名前の付いた型（interface）を `.d.ts` として生成する。問い合わせの組み立ての型は浅く保ち、ジェネリクスの再帰で列の集合を運ぶ設計（Kysely・Drizzle の型の重さの元）は避ける。TS 7 は再帰を深く調べるので、TS 6 で問題の無かった型が 10 倍以上重くなることがある [42][43]。CI で TS 6 と 7 の両方の `--extendedDiagnostics` を測り、インスタンス化の数に上限を置くとよい。
2. **TS の API に頼らない。** 7.0 には API が無く、7.1 の API はまだ安定していない [35][36]。コード生成は文字列（.ts と .d.ts）を書き出す形にし、言語サービスのプラグイン（SQL の文字列の検査など）を前提にしない。`isolatedDeclarations` を有効にして公開の型を明示すれば、利用者の側の型検査も軽くなる [49]。
3. **family を分け、共有は契約の構造・エラー・マイグレーションの枠組み・メソッドの形に限る。** Prisma の経緯（6 で制約だらけ → 7 で外す → 8 で別の family）をそのまま教訓にする [22][23][26]。Postgres を先に作り、DynamoDB は「アクセスパターンを契約に書く family」として後から足す。
4. **DynamoDB の「SQL っぽさ」はキーの条件を型で強制して作る。** `where` には、契約に書いたアクセスパターンのキー（分割キーの等号と並べ替えキーの範囲）しか書けないようにし、Scan は名前で分かる別の API にする。実行は Query・GetItem を使い、PartiQL は「出力の形の1つ」か「人が読むための説明（explain）」にとどめる。さらに IAM の `FullTableScan` の Deny を生成する IaC の部品を添えると、二重に守れる [14][19]。集計・JOIN が要る場面は、型で「この family ではできない」と分かるようにする。
5. **マイグレーションとロールバックは family ごとに意味を変える。** Postgres は DDL を戻せるが、DynamoDB はスキーマを持たない。テーブルと GSI の変更、データの書き換え（不変条件で守る。Prisma 8 の `dataTransform({ check, run })` の形）、の2つに分ける [26]。DynamoDB の表と GSI は CloudFormation・CDK と役目が重なるので、IaC に渡す形で出すか、自分で適用するかを早めに決める（未決）。
6. **エージェント向けの面を製品の一部として最初から作る。** ①版に合った文書をパッケージに同梱し、`AGENTS.md` に短い索引を管理された節として書く（Vercel の評価で skill より効いた）[58][59]。②エラーは `CODE.SUBCODE`・`why`・`nextActions`・`where` の構造にし、CLI は JSON でも出す [27]。③契約・実行の計画・マイグレーションの計画を MCP のツールで読めるようにし、失敗は `isError` で直せる文にする [53]。④skill は「マイグレーションを作る」「DynamoDB のアクセスパターンを足す」のような手順の作業に限る [57][59]。⑤`llms.txt` と各ページの `.md` を用意する [51]。
7. **PoC で確かめること。** (a) 生成した平らな型で、TS 7 のインスタンス化が利用者のコードの大きさに比例して増えるか。(b) DynamoDB の `where` の型の制約が、エージェントの書いたコードの誤り（Scan）をどれだけ防ぐか（評価のタスクを作って測る [54]）。(c) Postgres と DynamoDB で同じメソッドの形を保ったとき、エージェントがどちらでも正しく書けるか。

## 出典

1. npm registry `electrodb` https://registry.npmjs.org/electrodb
2. npm registry `dynamodb-toolbox` https://registry.npmjs.org/dynamodb-toolbox
3. npm registry `dynamoose` https://registry.npmjs.org/dynamoose
4. npm registry `dynamodb-onetable` https://registry.npmjs.org/dynamodb-onetable
5. npm downloads API（直近1週、2026-10-24 に取得）https://api.npmjs.org/downloads/point/last-week/electrodb （ほかのパッケージも同じ形）
6. GitHub API（star・archived・pushed_at）https://api.github.com/repos/tywalch/electrodb ・ https://api.github.com/repos/dynamodb-toolbox/dynamodb-toolbox ・ https://api.github.com/repos/dynamoose/dynamoose ・ https://api.github.com/repos/sensedeep/dynamodb-onetable
7. OneTable README https://github.com/sensedeep/dynamodb-onetable
8. Dynamoose README https://github.com/dynamoose/dynamoose
9. ElectroDB Introduction https://electrodb.dev/en/core-concepts/introduction/
10. ElectroDB Collections https://electrodb.dev/en/modeling/collections/
11. DynamoDB-Toolbox Overview https://www.dynamodbtoolbox.com/docs/getting-started/overview
12. DynamoDB-Toolbox Entity usage https://www.dynamodbtoolbox.com/docs/entities/usage
13. PartiQL for DynamoDB https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.html
14. PartiQL SELECT https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.select.html
15. PartiQL UPDATE https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.update.html
16. PartiQL functions https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-functions.html
17. PartiQL transactions https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.multiplestatements.transactions.html
18. PartiQL batch https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.multiplestatements.batching.html
19. PartiQL IAM policies https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-iam.html
20. ExecuteStatement API https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_ExecuteStatement.html
21. 参考：DynamoDB の TS と Go のベストプラクティスの別の調査（非公開のメモ。本文で使った事実は上の一次資料で確かめた）
22. Prisma ORM v6 MongoDB https://www.prisma.io/docs/orm/v6/overview/databases/mongodb
23. Prisma 7.0.0 release https://github.com/prisma/orm/releases/tag/7.0.0
24. Prisma（Prisma 8）README https://github.com/prisma/orm
25. Prisma 8 ARCHITECTURE.md https://github.com/prisma/orm/blob/main/ARCHITECTURE.md
26. Prisma 8 MongoDB Family https://github.com/prisma/orm/blob/main/docs/architecture%20docs/subsystems/10.%20MongoDB%20Family.md
27. Prisma 8 ADR 239（構造化したエラー）https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20239%20-%20Errors%20are%20structural%20envelopes%20with%20dotted%20namespace%20codes.md
28. Prisma 8 ADR 306（family ごとに1つの定義と builder）https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20306%20-%20One%20plain-data%20definition%20and%20one%20builder%20per%20family.md
29. npm registry `prisma`・`@prisma/client`（`prisma` の latest は 8.0.0-rc.27、`@prisma/client` の latest は 7.10.1）https://registry.npmjs.org/prisma ・ https://registry.npmjs.org/@prisma/client
30. Kysely Dialects https://kysely.dev/docs/dialects
31. Kysely `Dialect` interface https://github.com/kysely-org/kysely/blob/master/src/dialect/dialect.ts
32. Drizzle のソースの構成 https://github.com/drizzle-team/drizzle-orm/tree/main/drizzle-orm/src
33. Drizzle releases（v1.0.0-beta.9、v1.0.0-rc.5 は 2026-10-21。npm の latest は 0.45.4）https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-beta.9 ・ https://registry.npmjs.org/drizzle-orm
34. npm registry `kysely`（latest 0.29.7、next 0.30.0-beta.2）https://registry.npmjs.org/kysely
35. Announcing TypeScript 7.0 https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
36. Announcing TypeScript 7.1 Beta https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/
37. Announcing TypeScript 6.0 https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/
38. npm registry `typescript`（latest 7.0.2、beta 7.1.0-beta）https://registry.npmjs.org/typescript
39. microsoft/typescript-go README（閉じた・archived）https://github.com/microsoft/typescript-go
40. TypeScript Wiki: Performance https://github.com/microsoft/TypeScript/wiki/Performance
41. TS 7 checker（`instantiateTypeWithAlias` の上限）https://github.com/microsoft/TypeScript/blob/main/tsc/internal/checker/checker.go
42. typescript-go #4579 https://github.com/microsoft/typescript-go/issues/4579
43. kysely #1947 https://github.com/kysely-org/kysely/issues/1947
44. typescript-go #4055 https://github.com/microsoft/typescript-go/issues/4055
45. typescript-go #4630 https://github.com/microsoft/typescript-go/issues/4630
46. Kysely recipe: excessively deep types https://github.com/kysely-org/kysely/blob/master/site/docs/recipes/0009-excessively-deep-types.md
47. kysely PR #1637 https://github.com/kysely-org/kysely/pull/1637
48. drizzle-orm #3869 https://github.com/drizzle-team/drizzle-orm/issues/3869 ・ #4823 https://github.com/drizzle-team/drizzle-orm/issues/4823
49. TypeScript 5.5 release notes（isolatedDeclarations）https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-5.html
50. microsoft/TypeScript-Maintainer-Skills https://github.com/microsoft/TypeScript-Maintainer-Skills
51. llms.txt https://llmstxt.org/
52. MCP 2026-07-28 Key Changes https://modelcontextprotocol.io/specification/2026-07-28/changelog
53. MCP 2026-07-28 Tools https://modelcontextprotocol.io/specification/2026-07-28/server/tools
54. Anthropic: Writing effective tools for AI agents https://www.anthropic.com/engineering/writing-tools-for-agents
55. OpenAI: Function calling https://developers.openai.com/api/docs/guides/function-calling
56. AGENTS.md https://agents.md/
57. Agent Skills Specification https://agentskills.io/specification
58. Vercel: AGENTS.md outperforms skills in our agent evals https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals
59. Next.js: How Next.js supports AI coding agents https://nextjs.org/docs/app/guides/ai-agents
