# 08. Active Record は超えられないのか・TypeScript で難しい所（2026-10-24）

問い：「ActiveRecord を超える ORM は無い」という言われ方をどう考えるか。実際どう評価されていて、TypeScript だと何が難しいのか。
1〜4 は一次資料で確かめた事実、5 は考察。数値は 2026-10-24 に API から取った。

結論を先に：
- 「超える ORM は無い」と述べる一次資料は見つからなかった（作者や公式の発言としては未確認。言い回しとして広まっているものと見る）。
- 一次資料が示すのは、Active Record は「規約で書く量を減らし、モデルに DB と業務の両方を持たせる」という**割り切り**で、Rails 自身がその代価（N+1・callback の副作用・選んでいない列の実行時エラー）に注意書きと「厳しくする」設定を足し続けている、という姿。
- Data Mapper 側（Doctrine・Hibernate・MikroORM）と Ecto は、「DB を知らない素のオブジェクト」と「明示的な読み込み」を理由に別の道を選んでいる。
- TS では、型が実行時に消える・I/O が非同期・クラスのインスタンスが境界を越えにくい、という言語と実行環境の性質のため、Rails の書き味をそのまま移せない。TS の Active Record 系の勢いも Data Mapper／クエリビルダ系より弱い。

---

## 1. パターンの定義（Fowler, PoEAA）

まず例で。`users` テーブルの1行を扱うとき：

```ts
// Active Record：行のオブジェクト自身が保存の仕方を知っている
const u = await User.find(1); u.name = "A"; await u.save();

// Data Mapper：オブジェクトは素のデータ。保存は別の「マッパー」が行う
const u = await userMapper.find(1); u.name = "A"; await userMapper.update(u);

// Table Data Gateway：テーブルごとの窓口。返すのは素の行
const row = await usersTable.findById(1); await usersTable.update(1, { name: "A" });
```

| パターン | Fowler の定義（原文） | ひとことで |
|---|---|---|
| Active Record | "An object that wraps a row in a database table or view, encapsulates the database access, and adds domain logic on that data." [1] | 行＋DB の操作＋業務のロジックを1つのクラスに |
| Data Mapper | "A layer of mappers that moves data between objects and a database while keeping them independent" [2] | オブジェクトと DB を互いに知らないままにする層 |
| Unit of Work | "Maintains a list of objects affected by a business transaction and coordinates the writing out of changes and the resolution of concurrency problems." [3] | 変更を覚えておき、最後にまとめて書く（`flush()`） |
| Identity Map | "Ensures that each object gets loaded only once by keeping every loaded object in a map." [4] | 同じ主キーは同じインスタンス |
| Table Data Gateway | "An object that acts as a gateway to a database table. One instance handles all the rows in the table." [5] | テーブルごとの窓口。行はただのデータ |

- Fowler のページは Active Record を "the most obvious approach" と書くだけで、向く場面・向かない場面は本（PoEAA 10 章）に回している [1]。本の「When to Use It」の文は今回読んでいない（**未確認**）。
- Unit of Work と Identity Map は Data Mapper と組で使われることが多い。MikroORM の文書は自らを "a data-mapper that tries to achieve persistence-ignorance (PI)" と呼び、Identity Map で同じ主キーの二度目の取得を省き、Unit of Work で変わった列だけを `flush()` 時に書き、トランザクションで包むと説明する [20]。

## 2. Rails・Laravel の公式が掲げる考え方と、自ら付けている注意

### 2.1 Rails（Active Record 8.1.4。rubygems の最新、2026-09-24 公開 [11]）

掲げる考え方（Rails Guides「Active Record Basics」v8.1.4 [6]）
- Active Record は Fowler の定義を引き、"carry both data and behavior" と説明する [6]。
- **Convention over Configuration**："Explicit configuration should be needed only in those cases where you can't follow the convention." [6]。`Book` → `books`、`BookClub` → `book_clubs` と複数形の表名を自動で決める [6]。
- 属性は書かずに **DB の表から推定**する："Active Record objects don't specify their attributes directly, but rather infer them from the table definition" [7]。スキーマは schema cache か DB から読み込み（`load_schema`）、`reset_column_information` で読み直す [8]。
- validation（`save`・`create`・`update` の前に検査し、失敗なら DB に触れない）、callback（生成・更新・削除の前後にコードを差し込む）、マイグレーション（DB に依存しない書き方、`schema_migrations` で履歴）、関連（1対1・1対多・多対多）を1つの枠組みに持つ [6]。
- DHH の「Rails Doctrine」：Convention over Configuration は「繰り返しの決定から解放し、より深い抽象を育てる」「初心者の入口を下げる」ため [12]。"No one paradigm" の節で "Even the very foundation of the Active Record framework offends some purists." "We're mixing the logic needed for interfacing with the database directly with the business domain and logic." と、DB と業務を混ぜていることを**自覚したうえで選んでいる**と書く [12]。"Value integrated systems"（統合された一枚岩）も掲げる [12]。

Rails 自身が付けている注意（Guides）
- **N+1**：関連を1件ずつ読むと "N extra queries; one for each record"。本 10 冊なら 11 回、eager loading で 2 回 [9]。
- **`includes`／`preload`／`eager_load`**：`preload` は関連ごとに1クエリ、`eager_load` は `LEFT OUTER JOIN` で1クエリ、`includes` は "the most performant queries" を選ぶ高水準の方法で、こちらを勧める。`preload` には関連への条件を付けられない [9]。→ どの SQL が出るかは**実行時に ORM が決める**。
- **`strict_loading`**：遅延読み込みをしようとすると `ActiveRecord::StrictLoadingViolationError`。関係ごと・`config.active_record.strict_loading_by_default = true` で全体にも [9]。
- **部分 SELECT**：`select` すると "you're initializing a model record with only the fields that you've selected"。選ばなかった列を読むと `ActiveModel::MissingAttributeError`（実行時）。`id` だけは例外なので関連で注意 [9]。
- **callback**：callback の中で `update`・`save` など "methods that cause side effects" を呼ばない。`after_commit` は既に保存済みで、トランザクションの外で動き、途中で例外が出ると残りの `after_commit` は動かない。callback を飛ばすメソッドは "there may be important business rules" を迂回し "may lead to invalid data" [10]。

### 2.2 Laravel Eloquent（`illuminate/database` v13.38.0、2026-10-19 [15]）

- 自らを ORM と呼び、"each database table has a corresponding 'Model'" [13]。`php artisan make:model Flight -a` で model・migration・factory・seeder・policy・controller をまとめて生成する [13]。
- 関連は**動的プロパティで遅延読み込み**（`$user->posts` に触れた時に読む）。25 冊なら 26 クエリになる例と、`with()` で 2 クエリにする方法を公式が示す [14]。
- 厳しくする設定：`Model::preventLazyLoading(! $this->app->isProduction())`（違反で `LazyLoadingViolationException`。本番では動かし続けるため開発時だけ有効にする例）、`preventSilentlyDiscardingAttributes`（`fillable` に無い属性を**黙って捨てる**のをやめて例外に）[13][14]。
- 逆向きの道具 `Model::automaticallyEagerLoadRelationships()` もある。触れた関連を、取った集合全体に対して自動でまとめ読みする [14]。
- 一括の更新・削除では `saving`・`updated`・`deleting` などの model event が**発火しない**（"the models are never actually retrieved"）[13]。

## 3. 評価（作者・公式の一次の発言）

| 誰 | 言っていること |
|---|---|
| DHH（Rails Doctrine） | 純粋主義者には不快でも、DB と業務を混ぜるのは意図した選択。規約で決定を減らし、統合された道具で一貫させる [12] |
| Fowler（OrmHate, 2012-05-08） | ORM 一般について "the ORM can handle about 80-90% of the mapping problems, but that last chunk always needs careful work"。Active Record（Rails）は "takes care of boring stuff, but provides manholes so you can get down with the SQL" と好意的に挙げる。振る舞いの多いドメインモデルを作らないなら Row Data Gateway などでよいとも [16] |
| Doctrine（PHP） | "uses the Data Mapper pattern at the heart"、目的は "a complete separation of your domain/business logic from the persistence"。エンティティは基底クラスを継承せず、リフレクションで値を読み書きし、Unit of Work で `flush()` 時にまとめて書く [18] |
| Hibernate 7.1 | 伝統的な立場は「エンティティは枠組みに依存しない素の Java オブジェクト」。ただし "An alternative approach is the Active Record pattern, as exemplified by Panache" "Active Record comes with both upsides and downsides, but we don't mean to exclude it from consideration" と、Active Record を**排除しない**と明記。どちらでも「エンティティはオーケストレーション（トランザクション管理など）をしない」[19] |
| MikroORM | Data Mapper ＋ persistence ignorance。Identity Map と Unit of Work で最適化と自動のトランザクション [20] |
| Ecto（Elixir） | 構成は Repo・Schema（"map external data into Elixir structs"）・Query・Changeset（"track and validate changes before they are applied"）。"Ecto does not lazy load associations." "While lazily loading associations may sound convenient at first, in the long run it becomes a source of confusion and performance issues." [17]。「Active Record を選ばなかった理由」を Active Record の名で説明した公式の文は見つからなかった（**未確認**）。公式の文書で読めるのは上の「遅延読み込みをしない理由」と「データ（struct）と保存（Repo）を分ける構成」 |
| TypeORM | 両方を提供。"The Data Mapper approach helps with maintainability, which is more effective in larger apps." "The Active Record approach helps keep things simple which works well in smaller apps." [25] |
| Objection（作者の README） | 「ORM より relational query builder と呼ぶ方が正確」。"With objection you don't work with entities. You work with queries." "writing a good traditional ORM is borderline impossible" [44] |
| Prisma | クラスでモデルを書かず、スキーマから型を生成し、素のオブジェクトを返す。Sequelize のインスタンスを "It's not a POJO, but an object that implements additional behavior" と対比 [43] |

整理（事実の範囲）：
- Active Record を「最良」と言い切る一次資料は無く、作者も含めて**割り切りの選択**として語られている。Hibernate のように Data Mapper 側の代表が「排除しない」と書く例もある。
- Rails・Laravel とも「遅延読み込みを止める」設定を公式に持ち、Ecto は最初から遅延読み込みを持たない。暗黙のクエリが問題の中心であることは、立場を問わず公式の文書で一致している。

## 4. TypeScript で Active Record が難しい点

### 4.1 型が実行時に消える → DB から属性を作れない

- TS は "Type annotations never change the runtime behavior of your program."、型は "completely erased" [32]。
- Rails は実行時に DB の表を読んで属性を作る [7][8]。TS では静的な型を DB から実行時に作ることはできないので、**型をどこかに書く（二重定義）か、生成する**しかない。
- 実例：
  - Sequelize v6：クラスに `declare` で型を書き、さらに "`Model.init` requires an attribute configuration for each attribute declared in typings."（型と実行時の定義の2か所）[41]
  - TypeORM：デコレータでクラスに書く（4.2）[27]
  - MikroORM 7：`defineEntity` で実行時の定義から `InferEntity<typeof Book>` で型を推論する方法を "the recommended way to define entities programmatically without decorators" とする。ただし "produces complex computed types on hover" [24]
  - Prisma：スキーマから型を生成 [43]

### 4.2 デコレータ（クラスに注釈を書く仕組み）

- TypeORM は `experimentalDecorators: true`・`emitDecoratorMetadata: true` と `reflect-metadata` を必須にする [27]。
- TS 5.0 の標準（TC39）のデコレータは "not compatible with `--emitDecoratorMetadata`, and it does not allow decorating parameters." [30]。TS 5.2 の `Symbol.metadata` はデコレータが書いたものを入れるだけで、型の情報は入らない [31]。→ 標準のデコレータでは「プロパティの TS の型から列の型を決める」ことができない。
- MikroORM："ES spec decorators do not support metadata reflection."、関連の先のエンティティを常に明示が必要 [23]。`ReflectMetadataProvider` は legacy ＋ `emitDecoratorMetadata` でしか動かず、それでも nullable は読めない・`Opt` などの交差型は型を失う・文字列 enum は明示が要る [22]。`TsMorphMetadataProvider` はソースを読むが、本番に `.d.ts` が要り、webpack・babel などとは "in general not compatible" [22]。
- TypeORM の標準デコレータ対応（issue #9862、2023-03 から open）：2026-07-08 に共同保守者が「experimentalDecorators は非推奨ではない」「対応にはパッケージ分割の大きなリファクタが要り、優先はドライバとプラットフォーム」「デコレータを避けたいなら entity schema を」と回答 [28]。
- 変換器の対応：
  - esbuild：`emitDecoratorMetadata` は "not supported"。理由は "esbuild does not replicate TypeScript's type system" [33]
  - SWC：`jsc.transform.decoratorMetadata` で対応、標準のデコレータも `decoratorVersion` で選べる [34]
  - TS 7（tsgo）：当初は decorator を変換しない既知の穴（issue #914）。PR #2343「--experimentalDecorators and --emitDecoratorMetadata」が 2025-12-12 にマージされ対応。2026-06 にも `design:type` の bigint の出力差を修正（#4093・#4106）[35][36]
  - Node.js（v26.12.1）の型の除去：デコレータは "not transformed and will result in a parser error"。`tsconfig.json` も読まない [37]。→ デコレータ前提の ORM は Node の素の TS 実行では動かない。

### 4.3 関連の遅延読み込み：JS の I/O は非同期

- Rails・Eloquent の `user.posts` は触れた時に同期で SQL を出せる [9][14]。JS では DB の I/O は Promise なので同じことができない。
- TypeORM の lazy relations：型を `Promise<Category[]>` にし、`await` して読む。"In JavaScript and Node.JS, you have to use promises if you want to have lazy-loaded relations." "a non-standard technique and considered experimental in TypeORM." [26]
- その副作用の実例：TypeORM issue #12984（2026-10-20 に修正）。lazy relation の結合列が主キーでもあると、`insert()`・`save()` のたびに**誰も await しない SELECT** が裏で走り、未処理の reject がテストの後片付けとデッドロックした [29]。
- MikroORM は「読んだか否か」を型で表す：`Reference` で包み、`Loaded<Entity, Hints>` が "tracks which relations are populated at compile time"。`populate` に書いた関連だけ `$`／`get()` で同期に読め、書いていなければコンパイルエラー。理由は "TypeScript has no way of knowing whether the relation is loaded or not." [21]。代わりに `Reference`・`$`・`Loaded` という固有の概念が増える。

### 4.4 クラスのインスタンス vs 素のオブジェクト

- React Server Components：Client Component に渡せる props は primitives・配列・Map・Set・Date・"Plain objects: those created with object initializers" など。"Classes" と "Objects that are instances of any class (other than the built-ins mentioned)" は**渡せない** [38]。
- `structuredClone`（Worker・`postMessage` も同じ仕組み）："The prototype chain is not walked or duplicated."、getter・setter、private 要素も複製されない [39]。
- `JSON.stringify` は "Only enumerable own properties are visited"（メソッドや getter は落ちる。`toJSON()` で形を決められる）[40]。
- → Active Record のインスタンス（メソッドと DB 接続を持つ）は、サーバとクライアント・Worker・キャッシュの境界で素のオブジェクトへ変換が要る。Prisma・Drizzle・Kysely は最初から素のオブジェクトを返す [42][43]。

### 4.5 部分的な SELECT の型

- Rails は選ばなかった列に触れると実行時に `MissingAttributeError` [9]。Eloquent の `with('author:id,name,book_id')` も id と外部キーを含めるよう注意書きのみ [14]。
- Drizzle は `db.select({ field1: users.id, ... })` の結果の型が選んだ形になり、型は "inferred automatically based on the table definition, including columns nullability" [42]。クラスのインスタンスを返す Active Record では、同じクラスが「全列を持つ時」と「一部の時」を区別しにくい（MikroORM の `Loaded` のように別の型の仕組みが要る [21]）。

### 4.6 TS の Active Record 系の勢い（2026-10-24 取得）

週 DL は npm downloads API の last-week（窓 2026-10-12〜10-18）[45]、版は npm registry [46]、star・最終 push は GitHub API [47]。「180日の安定版」は 2026-04-24 以降に出た、先行版の印（`-`）が無い版の数。

| 道具 | 形 | 週 DL | latest（公開日） | 180日の安定版 | star | 最終 push |
|---|---|---:|---|---:|---:|---|
| `typeorm` | Active Record（`BaseEntity`）と Data Mapper の両方 | 2,842,581 | 1.1.2（10-08） | 7 | 36,659 | 10-22 |
| `sequelize` | Active Record（Model） | 1,525,333 | 6.37.8（2026-03-07） | 0 | 30,348 | 10-23 |
| `@sequelize/core`（v7） | 同上 | 61,012 | 7.0.0-alpha.48（2026-02-04） | 0 | — | — |
| `@mikro-orm/core` | Data Mapper（UoW・Identity Map） | 540,835 | 7.2.5（10-09） | 31 | 9,253 | 10-23 |
| `objection` | モデルクラス＋クエリビルダ | 131,322 | 4.2.0（10-18、`ditojs/objection`） | 13 | 7,337（Vincit）/ 12（ditojs） | Vincit 06-23 / ditojs 10-18 |
| 参考 `drizzle-orm` | クエリビルダ＋関係クエリ | 18,338,838 | 0.45.4（10-08） | — | — | — |
| 参考 `kysely` | クエリビルダ | 12,784,451 | 0.29.7（10-17） | — | — | — |
| 参考 `@prisma/client` | 生成したクライアント | 11,124,022 | 7.10.1（10-15） | — | — | — |

- TypeORM の週 DL のうち Active Record（`BaseEntity`）で使われている割合は分からない（**未確認**）。
- Sequelize は v6 が 2026-03 から安定版を出しておらず、v7 は alpha のまま [46]。
- 週 DL は間接の依存を含む（01 の注を参照）。

## 5. 考察（ここからは事実ではなく意見）

### 5.1 「超える ORM は無い」をどう読むか

- 一次資料から言えるのは「Active Record は**1つの言語・1つのフレームワークと一体で**、規約・生成・マイグレーション・validation を1つの書き方にまとめた完成度が高い」ということ [6][12][13]。比べる軸が「書く量の少なさと一貫性」なら強い。
- 一方で、Rails・Laravel が公式に「遅延読み込みを止める」「黙って捨てるのをやめる」設定を足していること [9][13][14]、callback の注意書きの多さ [10] は、その書き味が**暗黙の動き**に支えられていることを示す。比べる軸が「読んだだけで何が起きるか分かるか」なら、Ecto や Data Mapper・クエリビルダの方が有利。
- TS では 4 の理由で Rails の書き味そのものは再現できない。TS で「Active Record を超える」を狙うなら、同じ実装を移すのではなく、**AR の良さのうち言語に依存しない部分**を取り出すのが筋。

### 5.2 AI に効く所・悪い所

| Active Record の性質 | AI にとって | 理由 |
|---|---|---|
| 規約（名前・表名・主キー・時刻の列） | 良い | 選択肢が減り、生成が1通りに決まる。学習データにも多い |
| 1つの書き方・統合された道具（`make:model -a`、マイグレーション、validation） | 良い | 「どこに何を書くか」が決まっていて、エージェントが迷わない |
| 関連の宣言（`has_many` など）と読みやすい呼び出し | 良い | 意図が名前に出る。差分のレビューもしやすい |
| 遅延読み込み（`user.posts` で SQL） | 悪い | コードを読んでもクエリの数が分からない。N+1 を生みやすい |
| callback・model event | 悪い | `save()` の1行の裏で別の書き込みや外部呼び出しが起きる。一括更新では発火しない、など条件で変わる [10][13] |
| 黙って捨てる・実行時の `MissingAttributeError` | 悪い | 失敗が型や静的検査で見えず、動かして初めて分かる |
| 可変のインスタンス＋接続 | 悪い（TS で特に） | 境界で素のオブジェクトへの変換が要る [38][39] |

### 5.3 作る道具に取り入れる案

1. **書き味は AR、中身は素のデータ**：`User.find(id)` のようなモデル名の名前空間は持つが、返すのは素のオブジェクト（RSC にそのまま渡せる）。保存も `User.update(id, patch)` のような関数で、インスタンスの `save()` は持たない。
2. **定義は TS のコード1か所、デコレータを使わない**：`defineEntity` 型の定義から型を推論するか、契約から平らな型を生成する（03 の方針）。Node の型の除去・esbuild・tsgo のどれでも動く [33][35][37]。MikroORM の「hover が複雑」[24] を避けるため、外に見せる型は生成した名前付きの型にする。
3. **遅延読み込みを持たない**（Ecto と同じ [17]）。関連は宣言しておき、`with: { posts: true }` を書いた分だけ結果の型に現れる（MikroORM の `Loaded` の考え [21] を、ラッパーなしで素のオブジェクトの型として）。読んでいない関連は型に無いので、触れればコンパイルエラー。
4. **出る SQL を事前に見せる**：`includes` のように実行時に戦略を選ぶ [9] のではなく、戦略（JOIN か別クエリか）を API で明示し、`explain`／計画の出力でクエリ数を示す。エージェントが N+1 を静的に検出できる形にする。
5. **callback の代わりに名前の付いた操作**：「保存と同時に起きること」は `createUserWithProfile()` のような明示の関数か、トランザクション後の処理を宣言的に登録して計画に列挙する。一括更新でも単体の更新でも同じ規則が動くようにする（Eloquent の差 [13] を作らない）。
6. **規約は強く、例外は宣言**：表名・列名の変換、主キー・時刻の列を既定で決め、外すときだけ書く（Convention over Configuration [6]）。生成の CLI（モデル・マイグレーション・テストの雛形を一度に）を JSON で結果を返す形で持つ。
7. **厳しさは既定で最大**：Rails・Laravel が後から足した strict 系の設定 [9][13][14] を最初から既定にし、緩める方を明示にする。部分 SELECT は型で狭め [42]、`fillable` に当たるものは入力の型で表し、黙って捨てない。
8. **validation はスキーマと同じ所に**：列の制約とアプリの検査を1か所で宣言し、DB の制約とアプリの検査の両方に使う（Ecto の changeset [17] のように「変更を検査してから適用」の段を明示）。

---

## 出典

1. Martin Fowler, Active Record（PoEAA catalog）https://martinfowler.com/eaaCatalog/activeRecord.html
2. Data Mapper https://martinfowler.com/eaaCatalog/dataMapper.html
3. Unit of Work https://martinfowler.com/eaaCatalog/unitOfWork.html
4. Identity Map https://martinfowler.com/eaaCatalog/identityMap.html
5. Table Data Gateway https://martinfowler.com/eaaCatalog/tableDataGateway.html
6. Rails Guides, Active Record Basics（v8.1.4）https://guides.rubyonrails.org/active_record_basics.html
7. Rails API, ActiveRecord::Base https://api.rubyonrails.org/classes/ActiveRecord/Base.html
8. Rails API, ActiveRecord::ModelSchema::ClassMethods https://api.rubyonrails.org/classes/ActiveRecord/ModelSchema/ClassMethods.html
9. Rails Guides, Active Record Query Interface https://guides.rubyonrails.org/active_record_querying.html
10. Rails Guides, Active Record Callbacks https://guides.rubyonrails.org/active_record_callbacks.html
11. RubyGems API, activerecord https://rubygems.org/api/v1/versions/activerecord.json
12. DHH, The Rails Doctrine https://rubyonrails.org/doctrine
13. Laravel 13.x, Eloquent: Getting Started https://laravel.com/docs/13.x/eloquent
14. Laravel 13.x, Eloquent: Relationships https://laravel.com/docs/13.x/eloquent-relationships
15. Packagist, illuminate/database https://repo.packagist.org/p2/illuminate/database.json
16. Martin Fowler, OrmHate（2012-05-08）https://martinfowler.com/bliki/OrmHate.html
17. Ecto（hexdocs）https://ecto.hexdocs.pm/Ecto.html
18. Doctrine ORM, Getting Started https://www.doctrine-project.org/projects/doctrine-orm/en/latest/tutorials/getting-started.html
19. Hibernate ORM 7.1 Introduction（7.1.36.Final）https://docs.hibernate.org/orm/7.1/introduction/html_single/
20. MikroORM, Unit of Work https://mikro-orm.io/docs/unit-of-work
21. MikroORM, Type-Safe Relations https://mikro-orm.io/docs/type-safe-relations
22. MikroORM, Metadata Providers https://mikro-orm.io/docs/metadata-providers
23. MikroORM, Using Decorators https://mikro-orm.io/docs/using-decorators
24. MikroORM, defineEntity https://mikro-orm.io/docs/define-entity
25. TypeORM, Active Record vs Data Mapper https://typeorm.io/docs/guides/active-record-data-mapper/
26. TypeORM, Eager and Lazy Relations https://typeorm.io/docs/relations/eager-and-lazy-relations/
27. TypeORM, Getting Started https://typeorm.io/docs/getting-started/
28. typeorm/typeorm#9862 TypeScript 5.0 decorators support https://github.com/typeorm/typeorm/issues/9862
29. typeorm/typeorm#12984 insert()/save() start an unawaited lazy-relation query https://github.com/typeorm/typeorm/issues/12984
30. TypeScript 5.0 Release Notes（Decorators）https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html
31. TypeScript 5.2 Release Notes（Decorator Metadata）https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html
32. TypeScript Handbook, The Basics（Erased Types）https://www.typescriptlang.org/docs/handbook/2/basic-types.html
33. esbuild, Content Types（TypeScript caveats）https://esbuild.github.io/content-types/
34. SWC, Compilation https://swc.rs/docs/configuration/compilation
35. microsoft/typescript-go#914 Not transpiling decorators https://github.com/microsoft/typescript-go/issues/914 ・ PR #2343 https://github.com/microsoft/typescript-go/pull/2343
36. microsoft/typescript-go#4093 https://github.com/microsoft/typescript-go/issues/4093 ・ PR #4106 https://github.com/microsoft/typescript-go/pull/4106
37. Node.js v26.12.1, Modules: TypeScript https://nodejs.org/api/typescript.html
38. React, 'use client'（Serializable types）https://react.dev/reference/rsc/use-client
39. MDN, The structured clone algorithm https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm
40. MDN, JSON.stringify() https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify
41. Sequelize v6, TypeScript https://sequelize.org/docs/v6/other-topics/typescript/
42. Drizzle ORM, Select https://orm.drizzle.team/docs/select
43. Prisma, Data modeling https://www.prisma.io/docs/orm/overview/introduction/data-modeling
44. ditojs/objection README https://github.com/ditojs/objection
45. npm downloads API（last-week）https://api.npmjs.org/downloads/point/last-week/{package}
46. npm registry https://registry.npmjs.org/{package}
47. GitHub REST API `repos/{owner}/{repo}` https://docs.github.com/rest/repos/repos
