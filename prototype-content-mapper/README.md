# PROTOTYPE（使い捨て）：SQL のファイルを TS 7.1 の content mappers で型にする

問い：`schema.sql`（正）と `.sql` のクエリのファイルから、生成のファイルなしで TS の型が出せるか。変更のたびに実用の速さで反映されるか。同じ `.sql` が実行時にも動くか。

## 動かし方
```sh
pnpm install
pnpm check   # 型の検査（わざと入れた誤りが2つ出るのが正しい）
pnpm watch   # db/schema.sql や src/queries/*.sql を変えて反映を見る
pnpm start   # 実行時：PGlite にスキーマを流してクエリを当てる
```

## 仕組み
- `mapper/server.mjs`：content mapper。TS と JSON-RPC（Content-Length の枠）で話す。`openProject` で `db/schema.sql` を PGlite に流し、`transform` で `.sql` の各 `-- @name` を Postgres に Describe させて型付きの関数（TS）に写す。行の型の NULL の有無は、列の出どころ（テーブルと列番号）から `pg_attribute.attnotnull` を引く。CHECK の `IN (...)` と ENUM は文字列のユニオンにする。
- `mapper/loader.mjs`：Node の module hooks。実行時は DB なしで `.sql` を JS の関数にする（型は要らないので Describe しない）。
- `dynamicConfig: true` と `watchedFiles: [schema.sql]` で、スキーマの変更をクエリの型に伝える。

## 結果（2026-10-24、TS 7.1.0-beta、PGlite 0.5.11、Node 24.22.1、Apple Silicon）
| 確かめたこと | 結果 |
|---|---|
| 型が出るか | 出る。`bio` の NULL、CHECK からの `'draft' \| 'published'`、引数の型の誤りを `tsc` が検出 |
| SQL の誤り | `.sql` の上に `error sql90002: Postgres: column p.titel does not exist` と出る |
| 起動（初回だけ） | PGlite の起動とスキーマの読み込みで 0.8 秒 |
| スキーマの変更 | PGlite を使い回し `public` を作り直して 20ms。watch でクエリの型まで伝わる |
| クエリの編集 | 1〜2ms |
| 型の重さ | Instantiations 209（平らな型） |
| 実行時 | loader で `.sql` を import して PGlite で動く |
| VS Code | 出る（TypeScript Native Preview 1.0.1 の拡張。同梱の TS は 7.0.2 なので `.vscode/settings.json` で手元の 7.1 beta を指す。信頼したワークスペースが要る） |

## わかった限界（本番の設計で直すもの）
- 行の NULL の有無は列の出どころだけで決めている。LEFT JOIN の右側・式・集計は正しく扱えない（`count(*)` が `number | null` になる等）。
- `int8`（`count(*)` など）を `number` にしている。codec の決め方が要る。
- SQL の誤りの位置は `-- @name` に出している。Postgres の `position` から正確な位置に写せる。
- 全体の設定で TS 7 を有効にすると、TS 6 までの言語サーバのプラグイン（Svelte など）が読み込まれない。
