# 型の作り方と行の変換（mapper）

調べた日：2026-10-24。出典は一次資料（公式文書・ソース・リリース・npm registry・GitHub API・公開されたパッケージの中身）だけ。番号は末尾の「出典」。確かめられなかったことは「未確認」と書く。
§1〜§4 は事実、§5 は考察。前提の TS 7 と型の重さは `03-dynamodb-ts7-ai-design.md` を参照。

## 結論の要約

- **「最近出てきた mapper」に当たるものは2つの層にある。** 型の層では TS 7.1 の **content mappers**（2026-08-19 に typescript-go へ入った、`.vue`・`.sql` のような別の形式のファイルを TS に写して型検査に入れる差し込み口）[27][26]。実行の層では **Drizzle 1.0 の JIT mapper と codec**（rc.1 2026-04-30〜rc.5 2026-10-21。行を `new Function` で作った専用の関数で変換し、ドライバごとの差を codec で吸収）[2][3][4][5]。このほかに Prisma 8 の codec、Zod 4.1 の codec（双方向）、Effect 4 の Schema（`SqlSchema`・`Model`）、DynamoDB-Toolbox の transformer が「1つの定義から型と変換の両方」を作る [7][8][9][12][21][39]。
- **型の作り方の新しい選択肢は「SQL の文字列を型の上で解析する」で、TS 7.1 が前提になった。** TypeSQL（`@typesql/core` 0.4.0、2026-10-14 作成）は Postgres の文を型で解析し、1文あたり約 9.2K 回のインスタンス化・約 5ms。content mapper で結果をファイルに貯めると1文 約 230 回に下がる [23]。生成と推論の中間の形として参考になる。
- **TS 7 では「TS の API に乗る道具」が弱い。** typescript-eslint は TS `<6.1` だけに対応し、TS 7 は API が無いため未対応（SafeQL はこの上に乗る）[24][25]。Typia は ts-patch ではなく自作の `ttsc`（typescript-go の上の plugin host）で TS 7.0・7.1 に対応した [30][31]。7.1 の新しい API は安定と宣言されていない [26]。
- **行の変換を速くする道は、各道具で同じ形にそろってきた。** 定義から専用の関数を `new Function` で作る（JIT）。それが使えない実行環境（Cloudflare Workers）のために、ビルド時に作った関数を差し込む道（AOT）も持つ。Drizzle・Zod 4.5 `z.compile`・Effect 4 `SchemaJITCompiler`/`SchemaAOTCompiler`・MikroORM の `compiledFunctions` が同じ形 [5][14][21][22][33]。
- **Standard Schema（1.1.0）は検証の受け渡しの約束で、逆向き（encode）を持たない。** DB の行の変換の中心には置けず、JSON 列や利用者の独自の検証の受け口に向く [11]。
- **考察：** 1つの TS の定義（列ごとに codec を指す）から、(a) 平らな `.d.ts`、(b) マイグレーション用の JSON、(c) 実行時の JIT mapper を作るのが目標に合う。型は推論でなく出力（生成）を正にし、TS 7.1 の content mapper は「生成物をファイルに置かない」選択肢として後から足す。

## 1. 型の作り方

### 1.1 方式ごとの比較（事実）

| 方式 | 例（版） | 型の強さ | tsc の重さ | 生成物の管理 | 出典 |
|---|---|---|---|---|---|
| DB から生成 | kysely-codegen 0.20.0（2026-02-16）、Kanel 4.0.4（2026-08-24）、PgTyped 2.4.2（2025-02-10、以後の版なし）、sqlc（TS は plugin の early access） | 実際の DB と一致。動的なクエリは弱い（PgTyped・sqlc） | 平らな interface なので軽い | 生成のコマンド・コミット・CI での差の検出が要る | [1][38]、`01` |
| 契約から生成 | Prisma 8 RC：`contract emit` が `contract.json` と `contract.d.ts` を同じバイト列で書く。両方をコミットし、CI で差を見る | 契約と一致。DB とはハッシュで照合 | 平らな型 | 同上。Vite plugin で自動の再生成 | [7] |
| TS の推論だけ | Drizzle（テーブルの定義から推論）、Kysely（手書きの `DB` の型） | 強い | 列の数・連鎖で増える。Drizzle 0.45 の `$inferInsert` は列数 N に対し約 27.6·N² 回、424 列で TS2589（1.0 RC では直った）。Kysely は TS 7 で 60 万→980 万回の例 | 生成物なし | [6]、`03` |
| スキーマのライブラリから推論 | Zod 4.6.7、Valibot 1.5.0、ArkType 2.2.9、Effect 4.0.6 | 入力と出力の2つの型を持てる | Zod 4 は Zod 3 の >25,000 回→約 175 回（公式の例）。他は公式の数値を見つけられず（未確認） | 生成物なし | [13]、§1.2 |
| SQL を型で解析 | TypeSQL `@typesql/core` 0.4.0（TS ≥ 7.1 必須） | 行の型・引数の型・DDL の結果のスキーマまで。未対応の構文は型のエラー（`any` にしない） | 1文 約 9.2K 回・約 5ms。500 文で 4.6M 回・2.6 秒。キャッシュで 123K 回・0.13 秒 | 任意のキャッシュ・ファイル | [23] |
| DB に問い合わせる lint | SafeQL `@ts-safeql/eslint-plugin` 5.4.2（2026-10-18） | 実際の DB と一致。型の注釈を自動で直す | tsc には載らない（ESLint で動く） | 注釈がソースに残る | [24] |
| コンパイル時の変換 | Typia 15.2.0（`ttsc` が必須） | TS の型から検証・JSON 化の関数を作る | 変換の費用は ttsc 側 | 標準の `tsc`・`tsx` では動かない | [30][31] |

### 1.2 スキーマのライブラリと Standard Schema

- **Standard Schema 1.1.0**（2025-12-15）：`StandardTypedV1`（型だけ）、`StandardSchemaV1`（`validate(value) → { value } | { issues }`、同期か Promise）、`StandardJSONSchemaV1`（入力・出力の JSON Schema を出す。target は draft-2020-12・draft-07・openapi-3.0）。入力と出力の型は持つが、**出力→入力（encode）の関数は仕様に無い** [11]。Zod 4.2 は Standard JSON Schema を実装した [16]。
- **Zod 4**：4.1 で codec（`z.codec(入力, 出力, { decode, encode })`、`.encode()` で逆向き）。4.4 で codec の反転（`z.invertCodec`）。4.5 で `z.compile()`、4.6 で `.validate()`（結果を作らない検査）[12][14][15][16]。
- **ArkType 2.2**：morph（`pipe` など）は一方向の変換。2.2 で `@ark/json-schema`（JSON Schema との双方向の変換）、Standard Schema の値を定義に埋め込める。encode にあたる API は CHANGELOG に見つからない（未確認）[18][19]。
- **Valibot 1.5**：双方向の変換は要望（#658、2024-06 から open）のまま。`new Function` による JIT は配布物に無い [20]。
- **Effect 4**（4.0.0 は 2026-10-01、latest 4.0.6）：`Schema` が `Type` と `Encoded` の両方向を持つ。`effect/sql` の `SqlSchema` は「要求を encode してから実行し、行を decode する」部品、`SqlModel.makeRepository` は `schema/Model` の1つの定義から insert・update・select・JSON の変種を作る。どれも `@stability unstable` [21]。

### 1.3 TS 7.0／7.1 の差し込み口

| 項目 | 状況 | 出典 |
|---|---|---|
| 7.1 の API（`typescript/sync`・`async`・`ast`） | program・型検査器・emit を外から使える。安定とは書かれていない。transformer・言語サービスのプラグインには触れていない | [26] |
| content mappers（7.1） | tsconfig の `contentMappers` に拡張子とパッケージを書く。TS が別のプロセスを JSON-RPC（STDIO）で呼び、ファイルの中身を TS の構文に写してもらう（位置の対応も返す）。実行には `--runExternalCode` が要り、tsconfig では設定できない。VS Code では workspace trust と許可が要る。Vue・Svelte・Astro・MDX・CSS Modules の試作がある | [26][27][23] |
| 言語サービスのプラグイン | typescript-go の質問（#473「LS プラグインと transformer の予定は」）は回答なしで close。7.0・7.1 の発表にも記述なし（未確認） | [29][26] |
| transformer | 公式の仕組みは無い。ts-patch 4 は「TS 6 以上」と書くが TS 7（Go 製）で動くかは書いていない（未確認）。Typia は自作の `ttsc` に移り、15.2.0 で 7.1 の content mapper の型も検証の関数に反映する | [32][30][31] |
| テンプレートリテラル型の上限（7.1） | 文字の長さ 5,000 万・穴の数 10 万で TS2589。SQL の解析のような普通の使い方には届かない大きさ | [28] |
| typescript-eslint | peer は `typescript >=4.8.4 <6.1.0`。メンテナ：「TS 7 には API が無いので対応できない。TS 6 と並べて使う」 | [25] |

## 2. 「mapper」に当たるもの

| 名前 | 何をするか | 1つの定義から型と実行時の変換の両方を作るか | 出典 |
|---|---|---|---|
| **TS 7.1 content mappers** | 別の形式のファイルを TS に写して型検査に入れる（型の層の mapper）。TypeSQL は検査の結果のキャッシュを `.typesqlcache` として content mapper で配る | 型だけ。実行時の変換は別 | [26][27][23] |
| **Drizzle 1.0 の JIT mapper**（`drizzle({ jit: true })`、opt-in） | 選んだ列から行の変換の関数を文字列で組み、`Function` のコンストラクタで作る。行は配列で受け、`const [c0, c1, …] = rows[i]` から入れ子のオブジェクトを直接組む。`.prepare()` で作った関数を使い回す。rc.5 で「`.prepare()` しないクエリでも mapper をキャッシュ」。`new Function` が使えないと分かれば既製の mapper に戻る。D1・Durable Objects のドライバは `jit` を受け付けない | テーブルの定義（TS）から型を推論し、同じ定義から mapper を作る | [2][4][5] |
| **Drizzle 1.0 の codec**（npm の dist-tag `codecs` は 1.0.0-beta.23 の試作、rc.1 で本体へ） | Postgres の型ごと・ドライバごとに `normalize`（受けた値の変換）・`normalizeParam`（送る値）・`cast`（SQL 側で `::text` にするなど）と、配列・JSON の中の版を持つ表。例：neon-serverless は `bigint` を `BigInt`、`timestamp` を文字列から `Date` に。rc.4 で MySQL、rc.5 で SQLite・CockroachDB・MSSQL・SingleStore に広げた | 型は列の定義から。codec は実行時だけ（ドライバの差の吸収） | [2][3][4][5] |
| **Prisma 8 の codec** | `namespace/name@version` の ID（例 `pg/text@1`）を契約の各列が持つ。`Codec` は `fromWire`/`toWire`（非同期、1回の呼び出しの文脈を受ける）と `fromDataTypeValue`/`toDataTypeValue`（同期）を持つ。型の引数は Standard Schema で検査する。codec は拡張で足せる（pgvector、arktype-json、暗号化の非同期の codec の例） | 契約（PSL か TS）→ 生成した `contract.d.ts` が型、codec が実行時。拡張の codec の型が `.d.ts` にどう入るかは文書に無い（未確認） | [7][8][9][10] |
| **Zod の codec** | スキーマ同士の双方向の変換（`decode`・`encode`） | はい（入力の型・出力の型・両方向の関数） | [12] |
| **Effect Schema ＋ `effect/sql`** | `SqlSchema.findAll` などが要求の encode と行の decode を包む。`Model` は1つの定義から DB の形・JSON の形・insert/update の変種 | はい | [21] |
| **ArkType の morph** | 検証のあとの一方向の変換 | 型と decode だけ（encode は未確認） | [18][19] |
| **Data Mapper（MikroORM 7.2.5）** | エンティティと行を別にし、Unit of Work・Identity Map で写す。行→エンティティの hydrator を `new Function` で作り、`compile` の CLI で事前に作った関数（`compiledFunctions`）を渡せば eval を禁じる実行環境でも動く | `defineEntity` で推論（`01`） | [22] |
| **DynamoDB-Toolbox 2.11.1 の transformer** | 属性ごとに `encode`（保存の前）・`decode`（読んだあと）。既製の prefix・suffix・jsonStringify は型も変える（hotscript）・直列化できる・`pipe` でつなげる | はい | [39] |
| **TypeSQL の type map** | `createSql<DB>()` に渡す DB の型の列は Postgres の型名（`Col<"int4">`）。ドライバごとの対応表（`@typesql/pg` は pg の対応）で TS の型が決まる。実行時は行を変換せず返す（`rowKeys: "camelCase"` で上の階層のキーだけ変える） | 型だけ（実行時の変換はドライバ任せ） | [23] |

ユーザーの言う「最近出てきた mapper」がどれかは確かめられない（未確認）。「型をコード生成で作る仕組みではなく」と対にしている点では TS 7.1 の content mappers が、「mapper」という名前と時期（2026）では Drizzle の JIT mapper が、それぞれ一番近い。

## 3. 実行時の速さ

### 3.1 行の変換・検証

| 道具 | 主張（公式） | 条件 | 出典 |
|---|---|---|---|
| Drizzle JIT mapper ＋ codec | 遅延が 25〜30% 減り、14,500→15,300 rps | 自社のベンチ。条件の詳細は書かれていない | [2] |
| Zod 4.5 `z.compile()` | 解析が 2.8〜7.8 倍（20 キーのオブジェクト 301ns→38ns など）。moltar の parseSafe で Zod 4 compiled 47.5M ops/s、typia 45.3M、Zod 4 11.6M、valibot 1.8M、effect 1.7M、arktype 152k。assertLoose で typia 74.9M、arktype 66.2M、Zod 4 compiled 60.6M | Zod 自身の発表。moltar の PR #2329 の値。仕組みは「1回スキーマを歩き、ループの無い平らな JS を `new Function` で作る。失敗時は元の解析に戻る」 | [14] |
| Zod 4.6 `.validate()` | compile 済みで不正な入力に対し `.safeParse().success` の最大 35 倍 | 結果のオブジェクトを作らない | [15] |
| Zod 4 | Zod 3 比で文字列 14.7 倍・配列 7.4 倍・オブジェクト 6.5 倍 | node 22.13.0、arm64 | [13] |
| Typia | class-validator の 20,000 倍・class-transformer の 200 倍（JSON 化） | README の主張。ベンチの結果は repo に | [30] |
| ArkType | 「1:1 validator」。速さの数値の主張は README に見つからない（未確認）。2.2.9 は「`jitless` のときだけ NaN を拒否していた」不具合を直しており、JIT と jitless の2つの道がある | [18] |

`new Function` の扱い：Cloudflare Workers は `eval()` と `new Function` を禁じる [33]。Drizzle（既製の mapper に戻る）、Zod（`jitless`、`z.withParser()` でビルド時に作った解析を差し込む）、Effect（`SchemaAOTCompiler` が ES module を出す）、MikroORM（`compiledFunctions`）はどれも「JIT ＋ 戻り道 ＋ AOT」を持つ [5][15][17][21][22]。

### 3.2 ドライバ

| ドライバ（版） | 速さに関わる機能 | 出典 |
|---|---|---|
| node-postgres `pg` 8.23.1 | 8.23.0 でパイプライン（`client.pipelining = true`、`Pool({ pipelining: true })`）。単純なクエリの束で 2〜3 倍の処理量（手元の計測）。名前付きの準備した文は接続ごとにサーバで計画を持つ。`rowMode: 'array'` で行を配列で受ける。作者は「準備した文の多くは効果が小さい」と書く | [34][35] |
| `pg-native` 3.9.1 | libpq を使う。作者は「JS のドライバで十分速く、移植性も高いので自分は JS 版を使う」「両者の振る舞いに差が残り得る」と書く | [35] |
| postgres.js 3.4.9（2026-04-05） | 静的と推定できるクエリは自動で準備した文にする（`prepare: true` が既定）。トランザクションの中で配列を返すとパイプライン。「Fastest full-featured node & deno client」と自称し、別 repo のベンチを示す | [36] |
| Bun.sql | 準備した文が既定。Postgres では準備した文で `bool`・`int4`・`float4`・`float8`・`numeric`・`bytea`・`time`・`timestamp(tz)`・`int4[]`・`float4[]` をバイナリの形式で受ける。`.raw()`・`.values()` で変換を省ける。Bun 1.2 の発表の比較は画像だけで、数値は確かめていない（未確認） | [37] |

### 3.3 クエリの組み立て

- TypeSQL：`sql("… WHERE id = $1", 7)` の組み立て 1.1µs、`${sql.param()}` 4.0µs（Node 26）。実行時は SQL を解析しない [23]。
- Drizzle：`.prepare()` で SQL と mapper を一度だけ作る。rc.5 で「`.prepare()` しなくても mapper をキャッシュ」「組み立てと mapper の生成を最適化」[2][4]。
- Prisma 8：codec の `fromWire`/`toWire` は値ごとに非同期 [9]。行の数×列の数の Promise の費用がどれだけかは測られていない（未確認）。

## 4. AI が読みやすいか（事実として言えること）

- Prisma 8 は生成物（`contract.json`・`contract.d.ts`）をコミットさせ、エージェントは生成のコマンドなしで契約を読める [7]。
- TypeSQL は型の誤りを Postgres の文言・位置・「Perhaps you meant …」付きで出す。エラーが型のエラーの中に入るので、`tsc` の出力だけで直せる [23]。
- 推論だけの方式は、ホバーしないと結果の型が見えず、エージェントは型を読むために型検査を動かす必要がある（Drizzle・Kysely）。これは構造上の性質で、ベンチの数値は無い（考察に近い）。

## 5. 考察（目標に照らした組み方）

目標：速い・型が強力・DB とホスティングに依存しない・DynamoDB と Postgres を SQL のように扱う・独自に拡張できる。

1. **「1つの定義」は TS で書いた契約にし、列は codec を指す。** codec は Prisma 8 の形に近く、ID（`pg/int8@1`・`ddb/N@1` など）、TS の型、DB の型（マイグレーション用）、`decode`/`encode`（同期を基本、必要なときだけ非同期）を持つ。DynamoDB では wire を AttributeValue にすれば同じ codec の考えで足りる（DynamoDB-Toolbox の transformer が実例）[9][39]。利用者の独自の型は「codec を1つ足す」で拡張でき、JSON 列の中身は Standard Schema を受けて検証だけを任せる（encode は codec 側）[11]。
2. **型は「推論で書き、生成で配る」。** 定義を書く場所では TS の推論を使ってよいが、アプリが読むのは生成した平らな `.d.ts` にする（Prisma 8 と同じ）。理由：推論の型は列の数や連鎖で重くなり（Drizzle 0.45 の N²、Kysely の TS 7 の例）、TS 7 は深い再帰を打ち切らない [6]・`03`。平らな interface は AI が読め、`git diff` に出る。CI で生成物との差と、TS 7 の `--extendedDiagnostics` のインスタンス化の数に上限を置く（TypeSQL の `thresholds.json` が実例）[23]。
3. **TS 7.1 の content mapper は「生成物をファイルに置かない」選択肢として後から足す。** 契約ファイル（例 `.contract`）を content mapper で直接 TS の型に写せば、`emit` を忘れて型がずれる問題が消える。ただし `--runExternalCode` が要り（tsconfig に書けない）、7.1 はまだ beta で API も安定と宣言されていない [26][27]。既定はファイルの生成、content mapper は opt-in が安全。
4. **生 SQL は二段にする。** (a) 型の上で解析（TypeSQL の方式。1文 約 9K 回、TS 7.1 が必須）か、(b) 使い捨ての DB に `PREPARE` して型を得て生成する（SafeQL・PgTyped の方式）。typescript-eslint が TS 7 で動かないので、(b) は ESLint ではなく自前の CLI（JSON を返す）で行うのがよい [23][24][25]。DynamoDB には生 SQL を開かず、契約に書いたアクセスパターンだけを型で許す（`03` の結論のまま）。
5. **実行時の変換は「行は配列で受ける ＋ クエリの形ごとに JIT ＋ AOT の戻り道」。** Drizzle の JIT mapper の形（`rowMode: 'array'` 相当で受け、列ごとの codec を直列に並べた関数を作り、準備した文と一緒にキャッシュ）が一番速い道の実例 [5][35]。`new Function` を禁じる環境のために、ビルド時に mapper を出力する道を最初から用意する（MikroORM・Zod・Effect と同じ）[22][15][21]。値ごとの非同期の codec は、使う列があるときだけ非同期の道に切り替える。
6. **ドライバは差し替えられる層にし、codec でドライバの差を吸収する。** 同じ Postgres の型でもドライバごとに返す形が違う（Drizzle が codec を作った理由）[2]。パイプライン（pg 8.23・postgres.js）・バイナリの受け取り（Bun.sql）は adapter の能力として申告させ、使えるときだけ使う [34][36][37]。
7. **PoC で測ること。** (a) 生成した平らな型と推論の型で、TS 7.0/7.1 のインスタンス化と編集のたびの遅れ。(b) JIT mapper と素の `pg` の行（object 形）の差、codec が同期と非同期のときの差。(c) content mapper で契約を直接読ませたとき、`tsc --runExternalCode` と VS Code での体験。

## 出典

1. npm registry（2026-10-24 取得）：`drizzle-orm`（latest 0.45.4、rc 1.0.0-rc.5、dist-tag `codecs` = 1.0.0-beta.23-5d05836）、`zod` 4.6.7、`valibot` 1.5.0、`arktype` 2.2.9、`effect` 4.0.6、`typia` 15.2.0、`@standard-schema/spec` 1.1.0、`kysely-codegen` 0.20.0、`kanel` 4.0.4、`@pgtyped/runtime` 2.4.2、`@ts-safeql/eslint-plugin` 5.4.2、`pg` 8.23.1、`pg-native` 3.9.1、`postgres` 3.4.9、`@mikro-orm/core` 7.2.5、`dynamodb-toolbox` 2.11.1、`@typesql/core` 0.4.0、`ttsc` 0.34.1　https://registry.npmjs.org/{package}
2. Drizzle ORM v1.0.0-rc.1（JIT mappers・codec）https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.1
3. Drizzle ORM v1.0.0-rc.4 https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4
4. Drizzle ORM v1.0.0-rc.5 https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.5
5. `drizzle-orm@1.0.0-rc.5` の配布物（`utils.js` の `makeJitQueryMapper`・`jitCompatCheck`、`codecs.d.ts`、`neon-serverless/codecs.js`、`d1/driver.d.ts`、`zod/`・`valibot/`・`arktype/`・`typebox/`・`effect-schema/`）https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-1.0.0-rc.5.tgz
6. drizzle-orm #6391「0.45.x: `$inferInsert` cost is quadratic in column count」https://github.com/drizzle-team/drizzle-orm/issues/6391
7. Prisma docs「contract.json and contract.d.ts」https://www.prisma.io/docs/orm/contract-authoring/the-contract-artifact
8. Prisma blog「Prisma Next: call for extension authors」（2026-05-07）https://www.prisma.io/blog/prisma-next-call-for-extension-authors
9. `@prisma/orm-framework@8.0.0-rc.20` の型定義（`codec-types-*.d.mts` の `Codec`・`CodecImpl`、`codec-*.d.mts`）https://registry.npmjs.org/@prisma/orm-framework/-/orm-framework-8.0.0-rc.20.tgz
10. `@prisma/orm-postgres@8.0.0-rc.20` の依存（`arktype`・`pg` など）https://registry.npmjs.org/@prisma/orm-postgres/8.0.0-rc.20
11. Standard Schema `@standard-schema/spec@1.1.0`（`dist/index.d.ts`）https://registry.npmjs.org/@standard-schema/spec/-/spec-1.1.0.tgz ・ https://standardschema.dev
12. Zod docs「Codecs」https://zod.dev/codecs （ソース https://github.com/colinhacks/zod/blob/main/packages/docs/content/codecs.mdx）
13. Zod 4 リリースノート https://zod.dev/v4
14. Zod v4.5.0（`z.compile()`・moltar の結果）https://github.com/colinhacks/zod/releases/tag/v4.5.0
15. Zod v4.6.0（`.validate()`・`z.withParser()`）https://github.com/colinhacks/zod/releases/tag/v4.6.0
16. Zod v4.4.0（codec の反転・`jitless`）、v4.2.0（Standard JSON Schema）https://github.com/colinhacks/zod/releases/tag/v4.4.0 ・ https://github.com/colinhacks/zod/releases/tag/v4.2.0
17. `zod@4.6.7` の配布物（`v4/core/compile.js`・`util.js` の `allowsEval`）https://registry.npmjs.org/zod/-/zod-4.6.7.tgz
18. ArkType CHANGELOG（2.2.0〜2.2.9）https://github.com/arktypeio/arktype/blob/main/ark/type/CHANGELOG.md
19. ArkType docs「Morphs & More」https://arktype.io/docs/intro/morphs-and-more
20. Valibot のリリース https://github.com/open-circle/valibot/releases 、#658「Bi-directional encoding/decoding」https://github.com/open-circle/valibot/issues/658 、配布物 https://registry.npmjs.org/valibot/-/valibot-1.5.0.tgz
21. `effect@4.0.6` の配布物（`dist/sql/SqlSchema.d.ts`・`SqlModel.d.ts`、`dist/schema/Model.d.ts`・`SchemaJITCompiler.d.ts`・`SchemaAOTCompiler.d.ts`・`SchemaCompiler.d.ts`）https://registry.npmjs.org/effect/-/effect-4.0.6.tgz
22. `@mikro-orm/core@7.2.5` の配布物（`utils/Utils.js` の `createFunction`、`utils/Configuration.d.ts` の `compiledFunctions`）https://registry.npmjs.org/@mikro-orm/core/7.2.5 、docs https://github.com/mikro-orm/mikro-orm/blob/master/docs/docs/deployment.md
23. TypeSQL README・「Type cache」https://github.com/ismailkarsli/TypeSQL ・ https://github.com/ismailkarsli/TypeSQL/blob/main/packages/docs/guide/caching.md （GitHub API：12 star、2026-10-14 作成）
24. SafeQL https://github.com/ts-safeql/safeql （1,570 star）
25. `@typescript-eslint/typescript-estree@8.72.0` の peerDependencies、#12518 のメンテナのコメント https://github.com/typescript-eslint/typescript-eslint/issues/12518 、#10940 https://github.com/typescript-eslint/typescript-eslint/issues/10940
26. Announcing TypeScript 7.1 Beta https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/
27. typescript-go PR #4712「Content mappers」（2026-08-19 merge）https://github.com/microsoft/typescript-go/pull/4712
28. TypeScript PR #64194「cap template literal type size」（2026-09-28 merge）https://github.com/microsoft/TypeScript/pull/64194
29. typescript-go #473「Do you have a plan to support language service plugins and transformer plugins?」https://github.com/microsoft/typescript-go/issues/473
30. Typia v15.2.0（TS 7.1 対応）https://github.com/samchon/typia/releases/tag/v15.2.0 、README https://github.com/samchon/typia
31. ttsc README https://github.com/samchon/ttsc
32. ts-patch README・v4.0.1 https://github.com/nonara/ts-patch
33. Cloudflare Workers「Web standards」https://developers.cloudflare.com/workers/runtime-apis/web-standards/
34. node-postgres CHANGELOG https://github.com/brianc/node-postgres/blob/master/CHANGELOG.md 、PR #3652「Add opt-in query pipelining」https://github.com/brianc/node-postgres/pull/3652
35. node-postgres docs「Native Bindings」「Queries」https://node-postgres.com/features/native ・ https://node-postgres.com/features/queries
36. postgres.js README https://github.com/porsager/postgres
37. Bun docs「SQL」https://bun.com/docs/runtime/sql 、Bun 1.2 https://bun.com/blog/bun-v1.2
38. Kysely docs「Generating types」https://kysely.dev/docs/generating-types
39. DynamoDB-Toolbox docs「Transformers」https://github.com/dynamodb-toolbox/dynamodb-toolbox/blob/main/docs/docs/4-schemas/19-transformers/1-usage.md
