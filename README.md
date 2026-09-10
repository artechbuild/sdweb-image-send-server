# sdweb-image-send-server

Stable Diffusion WebUI の拡張機能から送信された**画像・動画**を受け取り、ディスクに保存する Node.js サーバです。
**clone → npm install → npm run pm2:start** ですぐに動作します。

**サーバには、事前に、node,npm,pm2のインストール** が必要です。

---

## 🆕 v2.0.0 の変更点（バイナリ転送対応）

これまでは画像を **data URL（Base64）を JSON に埋め込む方式** で受け取っていました。
この方式は転送サイズの数倍のメモリを消費するため、動画のような大きなファイルを扱えませんでした。

v2.0.0 では **生バイナリをストリームで受け取る方式** を追加し、**画像・動画のどちらも扱える** ようになりました。

|                | 旧方式 (プロトコル1) | 新方式 (プロトコル2) |
|----------------|--------------------|--------------------|
| ボディ         | JSON + data URL(base64) | 生バイナリ |
| メタデータ     | JSON のフィールド   | HTTP ヘッダ |
| 転送量         | 元サイズ × 1.33     | 元サイズ × 1.00 |
| サーバのメモリ | 元サイズ × 約6      | **転送サイズに依存しない（ほぼ一定）** |
| 扱える最大サイズ | 約 190MB（V8の文字列長上限により理論上も 384MB が限界） | **`MAX_UPLOAD_BYTES` 次第（既定 2GB）** |
| 動画           | 不可                | **可** |

### 実測値（250MiB の動画を送信）

| 項目 | 結果 |
|-|-|
| サーバのピークメモリ (RSS) | 起動時 56MiB → **96MiB** |
| 250MiB × 6本を同時受信したとき | **186MiB**（旧方式なら計算上 7GB 超） |
| 保存 4件滞留中の `GET` 応答 | **1〜3ms**（保存処理は受付をブロックしない） |
| 送信側のメモリ増加 | **0MiB**（ファイルを一切メモリに載せない） |
| 保存内容 | 全保存先で SHA-256 一致 |

### 非同期化と保存キュー

役割の異なる3つのディレクトリを使い、受信と保存を分離しています。

| 変数 | 役割 |
|-|-|
| `TMP_PATH` | 受信したファイルの**実体**を置く。全保存先へ書き終わったら削除する |
| `SPOOL_DIR` | 並行処理の**状態記録**（どの保存先まで書けたか）を置くジャーナル。中身は小さな JSON だけ |
| `SAVE_ROOTS` | **最終的な保存先**。カンマ区切りで複数指定でき、すべてに同じファイルを書く |

処理の流れは次のとおりです。

1. 受信したデータを `TMP_PATH` へ直接ストリーム書き込みする
2. `SPOOL_DIR` に状態記録を作り、**`202 Accepted` を返す**（送信側はここで解放され、保存の完了を待ちません）
3. キュー（メモリ上、既定は同時実行 1 = **順次処理**）が `TMP_PATH` のファイルを `SAVE_ROOTS` の**すべて**へコピーする。1件書けるたびに状態記録へ反映する
4. **全保存先へ書き終わったら** `TMP_PATH` のファイルと状態記録を削除する

したがって `TMP_PATH` と `SPOOL_DIR` は**通常は空**です。

状態記録があるため、異常終了しても**完了済みの保存先をやり直さずに未完了分だけ再開**できます（次回起動時に自動で回収）。SIGKILL 中断からの復元を検証済みです。

一部の保存先が失敗した場合は `SAVE_MAX_ATTEMPTS` 回まで再試行し、それでも書けなければ諦めます（**成功した保存先はそのまま残ります**）。

> **スレッド構成について**
> サーバは**単一プロセス・単一 JS スレッド**（イベントループ）で動きます。`storage.js` は別スレッドではなく、app.js が読み込むモジュールです。
> 実際のファイル読み書きは Node（libuv）のスレッドプールが担うため、保存処理中も受付はブロックされません（保存 4 件が滞留中でも `GET` は 1〜3ms で応答することを実測）。
> 同時に書き込みたい場合は `SAVE_CONCURRENCY` を上げてください。

### 互換性

新旧のどちらの組み合わせでも動作します（実測で確認済み）。

| 送信側 | 受信側 | 動作 |
|-|-|-|
| 新 | 新 | プロトコル2（バイナリ）。動画も送れる |
| 新 | 旧 | 送信側が `GET` で問い合わせ、404 が返るのでプロトコル1（base64）に自動降格 |
| **旧（改造前のまま）** | **新** | `X-Protocol-Version` が無いので Content-Type から旧方式と判定し、そのまま受理 |
| 旧 | 旧 | 従来どおり |

旧方式の受信は `ACCEPT_LEGACY_JSON=0` で無効化できます。全台を更新し終えたら切ってください。

---

## 🚀 セットアップ手順

```text
git clone https://github.com/artechbuild/sdweb-image-send-server.git
cd sdweb-image-send-server
npm install
npm run pm2:start
pm2 save
```

## 🔧 利用コマンド

すべて npm run で操作できます。

```text
# サーバ起動
npm run pm2:start

# 再起動
npm run pm2:restart

# 設定ファイルをリロード
npm run pm2:reload

# 停止
npm run pm2:stop

# ログ確認
npm run pm2:logs
```

## ⚙️ 設定

設定はすべて ecosystem.config.js に記載されています。

### サーバ

|変数|デフォルト|説明|
|-|-|-|
|PORT|8443|サーバの待ち受けポート|
|HOST|0.0.0.0|バインド先ホスト|
|ADD_FROM_URL_PATH|/api|受け取りAPIのパス（**送信側の "API path" と一致させる**）|
|AUTH_TOKEN|(空)|任意。設定するとヘッダ `X-Auth-Token` を必須に|
|SAVE_ROOTS|/tmp|**最終的な保存先**。カンマ区切りで複数指定でき、**指定したすべてのディレクトリに保存されます**。1番目が主保存先|

### バイナリ転送（画像・動画共通の本経路）

|変数|デフォルト|説明|
|-|-|-|
|MAX_UPLOAD_BYTES|2gb|1ファイルの上限。ストリーム保存なのでメモリではなくディスク保護のための値|
|TMP_PATH|`<OSの一時ディレクトリ>/sdweb-image-send`|**受信したファイルの実体**を置く場所。詳細は下記|
|SPOOL_DIR|`<TMP_PATH>/.spool`|**状態記録**（ジャーナル）を置く場所。詳細は下記|
|SAVE_CONCURRENCY|1|保存フェーズの同時実行数。1 = 順次処理|
|QUEUE_LIMIT|1000|保存待ちキュー（メモリ上）の上限。超えると `503` を返して送信側にリトライさせる|
|SAVE_MAX_ATTEMPTS|3|一部の保存先が失敗したときの再試行回数。超えたら諦める|
|SAVE_RETRY_DELAY_MS|30000|再試行の間隔|

#### TMP_PATH について

受信したファイルの実体を置く場所です。`SAVE_ROOTS` の**すべて**へ書き終わると**削除される**ので、通常は空です。

- **十分な空き容量がある実ディスクを指定してください** — 受信中のファイルがここに丸ごと乗ります
- **`/tmp` が tmpfs（RAM）の環境では必ず実ディスク上のパスを指定してください** — 大きな動画がメモリを消費してしまいます。起動時に検知して警告を出します（`/var/tmp` などが無難です）
- 空欄なら OS の一時ディレクトリ配下を使い、そこが書けない場合は `<SAVE_ROOTS[0]>/.tmp` へ退避します

#### SPOOL_DIR について

並行処理の状態記録（ジャーナル）を置く場所です。1リクエストにつき1つの小さな JSON が作られます。

```json
{
  "id": "1789003053200-28684-65d068bcc77988",
  "rel": "Local/2026-09-10/flow.mp4",
  "bytes": 262144000,
  "tmpFile": "/var/tmp/sdweb-image-send/1789003053200-....part",
  "done": ["/mnt/Ext9/makesd"],
  "attempts": 1
}
```

`done` に書き込みが完了した保存先が積まれていきます。全保存先が揃った時点でこの記録と `TMP_PATH` の実体を削除します。異常終了した場合は次回起動時にこの記録を読み、**`done` に無い保存先だけ**をやり直します。

- 容量はほとんど不要ですが、`TMP_PATH` と**生死を共にする必要があります**（実体だけ残って記録が消えると回収できません）。既定が `<TMP_PATH>/.spool` なのはこのためです
- 空欄なら `<TMP_PATH>/.spool` を使います

### タイムアウト

|変数|デフォルト|説明|
|-|-|-|
|REQUEST_TIMEOUT_MS|600000|1リクエスト全体の上限（10分）。**Node の既定 300 秒では大きな動画で切れることがある**|
|HEADERS_TIMEOUT_MS|65000|ヘッダ受信の上限|
|KEEPALIVE_TIMEOUT_MS|60000|Keep-Alive の上限|

### 旧 JSON/base64 経路（非推奨・受信互換用）

|変数|デフォルト|説明|
|-|-|-|
|ACCEPT_LEGACY_JSON|1|`0` にすると旧方式を拒否する（`415`）|
|BODY_LIMIT|256mb|**旧 JSON 経路にのみ**適用されるボディ上限|
|WORKER_CONCURRENCY|4|**旧 JSON 経路にのみ**適用されるワーカー数|

> 起動時に **各保存先と一時領域へ実際に書き込めるかを検証** し、結果をログに出します。権限不足はここで判ります。
>
> ```text
> save root [primary] OK: /mnt/Ext9/makesd
> save root [copy] OK: /mnt/gd_ilacts_crypt/makesd
> temp path (file body):   /var/tmp/sdweb-image-send
> spool dir (job state):   /var/tmp/sdweb-image-send/.spool
> ```
>
> `SAVE_ROOTS` の1番目は主保存先です。ここへの書き込みが失敗するとリクエスト自体が失敗するので、**最も確実なディスク（できればローカル）を1番目に**指定してください。2番目以降のコピー失敗はログに残りますが、リクエストは成功扱いになります。

---

## 🌐 API

### 保存（プロトコル2 / 推奨）

```text
POST ${ADD_FROM_URL_PATH}

ヘッダ:
  X-Protocol-Version: 2
  Content-Type: image/png | video/mp4 | ... | application/octet-stream
  Content-Length: <バイト数>
  X-Item-Name: <拡張子なしのファイル名>   ※非ASCIIはパーセントエンコード
  X-Folder-Id: <フォルダ識別子>            ※同上
  X-Item-Ext:  <.mp4 など>                 ※任意。Content-Type より優先される
  X-Auth-Token: <AUTH_TOKEN>               ※設定時のみ

ボディ: 生バイナリ（base64 にしない）

応答: 202 {"status":"accepted","bytes":<数>,"queued":<確定待ち件数>}
```

`202` は「**受信してディスクに置いた**」の意味で、最終パスへの確定はこの後キューで行われます。

対応する Content-Type: `image/png` `image/jpeg` `image/webp` `image/gif` `image/avif` `image/bmp` `image/tiff` `image/apng` / `video/mp4` `video/webm` `video/quicktime` `video/x-matroska` `video/x-msvideo` `video/x-m4v` `video/mpeg` `video/ogg`

主なエラー: `400` 名前/フォルダID不正・バージョン不正 / `401` 認証 / `413` サイズ超過 / `415` 非対応の種別 / `503` キュー満杯 / `507` 空き容量不足

### サポート状況の問い合わせ

```text
GET ${ADD_FROM_URL_PATH}

応答: 200
{
  "status": "ok",
  "protocol": { "min": 1, "max": 2 },
  "maxUploadBytes": 2147483648,
  "legacyJson": true,
  "saveRoots": 2,
  "tmpPath": "/var/tmp/sdweb-image-send",
  "spoolDir": "/var/tmp/sdweb-image-send/.spool",
  "queue": { "pending": 0, "running": 0, "concurrency": 1, "done": 12, "failed": 0 }
}
```

送信側はこれで新方式が使えるか判断します。**旧サーバはこの GET を持たないため 404 が返り、それが「旧方式のみ」の目印になります。**
キューの状況もここで確認できるので、動作監視にも使えます。

### 保存（プロトコル1 / 非推奨）

従来どおり `Content-Type: application/json` で `{"url":"data:...;base64,...","name":"...","folderId":"..."}` を POST します。改造前の送信側との互換のためだけに残しています。

---

## 🗂 保存先

```text
<SAVE_ROOTS の各ディレクトリ>/<folderId>/<YYYY-MM-DD>/<filename><拡張子>
```

`folderId` と `filename` は `[a-zA-Z0-9_-.]` 以外を除去してから使います（パストラバーサル対策）。

---

## 🔧 動作確認

1. Stable Diffusion WebUI 側拡張機能を有効化し、
    - Outside server base URL: `http://<your-host>:8443`
    - API path: `/api`（サーバの `ADD_FROM_URL_PATH` と一致させる）
    - FolderID: 任意
    - Auth Token: 必要なら設定
    - Transfer protocol: `auto`
2. 画像を生成すると、自動的に保存されます。
3. 動画も送る場合は、拡張機能側で `Send videos (watch output folders)` を ON にします。

### curl での確認

```bash
# サポート状況
curl -H "X-Auth-Token: my-secret" http://localhost:8443/api

# 画像/動画の送信（生バイナリ）
curl -X POST http://localhost:8443/api \
  -H "X-Auth-Token: my-secret" \
  -H "X-Protocol-Version: 2" \
  -H "Content-Type: video/mp4" \
  -H "X-Item-Name: test-video" \
  -H "X-Folder-Id: album001" \
  -H "X-Item-Ext: .mp4" \
  --data-binary "@/path/to/video.mp4"
```

---

## 🐞 トラブルシューティング

- **`413 payload_too_large`** — `MAX_UPLOAD_BYTES` を上げてください。旧方式で送っている場合は `BODY_LIMIT` 側の上限です（そもそも大容量は新方式で送ってください）。
- **`503 queue_full`** — 確定処理が追いついていません。副保存先が遅い（ネットワークマウント等）可能性があります。`SAVE_CONCURRENCY` や保存先構成を見直してください。
- **`507 insufficient_storage`** — `TMP_PATH` またはいずれかの保存先に空き容量がありません。応答の `where` にどこが足りないかが入ります。
- **`507 storage_unavailable` / 起動ログに `no writable temp directory` `no writable spool directory`** — `TMP_PATH` または `SPOOL_DIR` を作れません。書き込み可能なディレクトリを指定してください。
- **起動ログに `save root ... NOT WRITABLE: ... EACCES`** — そのディレクトリにサーバの実行ユーザの書き込み権限がありません。`chown`/`chmod` で権限を与えるか、`SAVE_ROOTS` を書き込めるパスに変更してください。保存先の**直下**に書ける必要があります（日付フォルダを作成するため）。
- **起動ログに `WARNING: TMP_PATH ... is a RAM-backed filesystem`** — `/tmp` が tmpfs です。`TMP_PATH` に実ディスク上のパスを指定してください。
- **動画で転送が途中で切れる** — `REQUEST_TIMEOUT_MS` と、送信側の `Request timeout (seconds)` の両方を大きくしてください。
- **起動時に `recovery: resuming N unfinished job(s)`** — 前回の異常終了で保存しきれなかったファイルを、未完了の保存先だけ再開しています。正常な動作です。
- **`recovery: discarded N unusable leftover(s)`** — 受信途中で落ちて実体が不完全なもの、または実体を失った記録です。回収できないため破棄しています。送信側から再送してください。
- **`giving up after N attempts: ... (saved to M/K roots)`** — 一部の保存先へ書けないまま再試行回数を使い切りました。その保存先の権限・容量・マウント状態を確認してください。成功した保存先には保存済みです。

---

## 📝 更新履歴

- **v2.1.0** — `TMP_PATH`（受信ファイルの実体）と `SPOOL_DIR`（状態記録）を役割ごとに分離。保存先はすべて同格に扱い、全保存先へ書き終わってから `TMP_PATH` を削除する。状態記録により、異常終了しても未完了の保存先だけを再開できる。一部の保存先が失敗した場合の再試行（`SAVE_MAX_ATTEMPTS`）を追加。
- **v2.0.0** — バイナリ転送（プロトコル2）対応。画像・動画の両方に対応。受信即応答＋保存キューによる非同期・順次保存、起動時の書き込み権限検証、`GET` によるサポート状況の問い合わせを追加。`fs-extra` 依存を削除。旧 JSON/base64 経路は受信互換のため維持（非推奨）。
- v1.0.0 — 初版。JSON + data URL(base64) による画像受信。
