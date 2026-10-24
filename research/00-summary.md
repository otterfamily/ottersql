# 調査のまとめ（2026-10-24）

AI に最適化した TypeScript の ORM・クエリビルダ・マイグレーションの道具を作る前の、競合と技術の調査。詳細と出典は各ファイル。要件は `../requirements.md`。

| ファイル | 中身 |
|---|---|
| `01-ts-orm-landscape.md` | TS の ORM・クエリビルダの競合 |
| `02-migration-testing-compat.md` | マイグレーション・テスト・Postgres 互換の DB |
| `03-dynamodb-ts7-ai-design.md` | DynamoDB を SQL らしく・TS 7 と型の重さ・エージェント向けの設計 |
| `04-rollback-in-cicd.md` | down を作らない理由・CI/CD のロールバックの4種 |
| `05-types-and-mappers.md` | 型の作り方・TS 7.1 の content mappers・JIT mapper と codec |
| `06-unified-sql-and-extensibility.md` | NoSQL と RDB を SQL らしく・能力・カスタマイズの層 |
| `07-db-objects-and-temporal.md` | view・関数・トリガ・履歴テーブル |
| `08-active-record-in-ts.md` | Active Record の評価と TS で難しい点 |
| `09-postgres-schema-coverage.md` | Postgres 18 の基本の機能 32 項目と各道具の対応 |
| `10-dx-debug-cli.md` | GUI と AI 向けの CLI・デバッグ・型の速さの測り方 |

npm の版は 2026-10-24 に registry で確かめた：`prisma` latest 8.0.0-rc.27（`@prisma/client` は 7.10.1）、`typescript` latest 7.0.2・beta 7.1.0-beta、`drizzle-orm` latest 0.45.4・rc 1.0.0-rc.5、`kysely` 0.29.7。TS 7.1 の content mappers は typescript-go PR #4712（2026-08-19 merge）で確かめた。

## 競合の現状
- 一番の競合は Prisma 8（TS で書き直し、RC）。構造化したエラー・生成した平らな型・DB とスキーマのハッシュの照合・migration の前後の検査・能力を型で表す仕組みを持つ。ただし view・関数・トリガ・生成列・EXCLUDE・DEFERRABLE などを扱えず、Studio も無い。
- Drizzle は利用が最多（週 1834 万）だが v1 が RC のまま。トリガ・関数は扱わない。推論の型が列の数で重くなる。
- Active Record 型（TypeORM・Sequelize）は勢いを失った。理由は型が実行時に消える・デコレータ・非同期の遅延読み込み・クラスのインスタンスを渡せないこと。

## 空いている所
1. **Postgres の機能の網羅**：基本の 32 項目を全部扱う道具は無い。view・関数・トリガを宣言と差分で扱い TS の型も出す道具も無い（Atlas は Pro だけ、MikroORM は一部が実験的）。
2. **安全な適用の手順を自動で組む**：外部キーの NOT VALID→VALIDATE、索引の CONCURRENTLY、UNIQUE の段階的な追加、63 バイトの名前、依存する view の作り直しの順番。どの ORM も自動では組まない。
3. **CI/CD で戻せることの保証**：アプリだけを戻せる（expand/contract の印）・途中で落ちても片付けられる。down は作らない（前へ進めて戻す）。
4. **履歴テーブル**：Postgres 19 にも組み込みは無く、Aurora で使える拡張も無い。スキーマに1行書けば履歴テーブル・トリガ・時点の問い合わせ・追従を作る道具は無い。
5. **型の速さ**：TS 7 で推論の型が重くなる例がある。生成した平らな型か、TS 7.1 の content mappers で軽くできる。content mappers で ORM のスキーマを直接型にする例は見当たらない。
6. **互換の DB の差の吸収**：Aurora DSQL（トリガ・PL/pgSQL・materialized view・RLS 無し、索引は ASYNC、DDL は1文ずつ）。能力を型で表すのは Prisma 8 だけ。
7. **AI 向けの CLI**：psql の `\d` に当たる情報を JSON で返す CLI は無い。OTel の db.* を ORM が埋める実装も弱い。

## 設計の方向の案（考察）
- **正は1つ**：宣言型のスキーマ。マイグレーション・型・実行時の mapper はそこから作り、DB とのずれはハッシュで検出する。
- **型**：平らな型。届け方は TS 7.1 の content mappers（ファイルを置かない）と生成した型のファイル（どの TS でも動く）を、同じ関数から選べるようにする。
- **実行時**：列ごとの codec と JIT mapper（`new Function` を使えない環境向けに AOT も）。
- **マイグレーション**：down は作らない。計画は JSON で、各操作に「可逆・データを失う・不可逆・トランザクションに入らない」の分類と「アプリより前（expand）・後（contract）」の印を持たせる。使い捨ての DB で試してから適用する。
- **Active Record の取り入れ方**：規約・1つの書き方・関連の読みやすさを取り、中身は素のデータ。デコレータ・遅延読み込み・callback は持たない。関連は頼んだときだけ型に出る。
- **NoSQL**：共通にするのは意味と費用が同じ操作（主キー・キーの条件・条件付き書き込み・まとめて送るトランザクション・keyset のページング）だけ。JOIN・集計・キー以外の条件は型で拒否するか別の API。
- **カスタマイズ**：codec・演算子・能力・書き換え（middleware）・それらを束ねた pack の5層。
- **CLI と GUI**：常駐の GUI は作らない。CLI は JSON・非対話・`code`/`why`/`nextActions` のエラー。人が承認する場面（ER 図・計画・EXPLAIN）だけ静的な HTML を出す。
- **デバッグ**：呼び出した TS の行・OTel の db.*・`.explain()`・N+1 の警告・WHERE の無い UPDATE と DELETE を止める lint。
- **型の速さ**：CI でインスタンス化の数を測る（TS 7 は `--checkers 1` で固定）。
