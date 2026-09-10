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
| 送信側のメモリ増加 | **0MiB**（ファイルを一切メモリに載せない） |
| 保存内容 | 全保存先で SHA-256 一致 |

### 非同期化と確定キュー

受信と保存を 2 段に分けています。

1. **受信フェーズ** — リクエストボディを一時領域（`TMP_PATH`）へ直接ストリーム書き込みし、書けた時点で `202 Accepted` を返す。**送信側はここで解放され、保存の完了を待ちません。**
2. **保存フェーズ** — キュー（メモリ上）が、副保存先へのコピーと最終パスへの移動を行う。既定は同時実行 1 = **順次処理** なので、複数リクエストが来てもディスクを取り合いません。

`TMP_PATH` のファイルは保存完了時に `SAVE_ROOTS` へ移動して消えるため、**通常は空のまま**です。サーバが異常終了して残った場合は**次回起動時に自動で回収・保存**されます（SIGKILL 中断からの復元を検証済み）。

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
|TMP_PATH|`<OSの一時ディレクトリ>/sdweb-image-send`|**受信中の作業領域**（保存先とは別）。詳細は下記|
|SAVE_CONCURRENCY|1|保存フェーズの同時実行数。1 = 順次処理|
|QUEUE_LIMIT|1000|保存待ちキュー（メモリ上）の上限。超えると `503` を返して送信側にリトライさせる|

#### TMP_PATH について

受信したファイルは一旦ここへ書き、保存が終わると `SAVE_ROOTS` へ移動して**削除されます**。したがって通常は空です。

- **`SAVE_ROOTS[0]` と同じファイルシステム上に置くと速い** — 移動が `rename` だけで済みます。別のファイルシステムだとコピーになります（動作はします。起動時にログで知らせます）
- **`/tmp` が tmpfs（RAM）の環境では必ず実ディスク上のパスを指定してください** — 大きな動画がメモリを消費してしまいます。起動時に検知して警告を出します
- 空欄なら OS の一時ディレクトリ配下を使い、そこが書けない場合は `<SAVE_ROOTS[0]>/.tmp` へ退避します
- `SPOOL_DIR` は本変数の旧名です。互換のため受け付けますが、`TMP_PATH` を使ってください

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
> temp path: /var/tmp/sdweb-image-send
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
- **`507 insufficient_storage`** — 一時領域 + 全保存先の合計に必要な空き容量がありません。
- **`507 temp_unavailable` / 起動ログに `no writable temp directory`** — 一時領域を作れません。`TMP_PATH` に書き込み可能なディレクトリを指定してください。
- **起動ログに `save root ... NOT WRITABLE: ... EACCES`** — そのディレクトリにサーバの実行ユーザの書き込み権限がありません。`chown`/`chmod` で権限を与えるか、`SAVE_ROOTS` を書き込めるパスに変更してください。保存先の**直下**に書ける必要があります（日付フォルダを作成するため）。
- **起動ログに `WARNING: TMP_PATH ... is a RAM-backed filesystem`** — `/tmp` が tmpfs です。`TMP_PATH` に実ディスク上のパスを指定してください。
- **動画で転送が途中で切れる** — `REQUEST_TIMEOUT_MS` と、送信側の `Request timeout (seconds)` の両方を大きくしてください。
- **起動時に `temp: recovering N pending file(s)`** — 前回の異常終了で保存できなかったファイルを回収しています。正常な動作です。
- **`temp: discarded N incomplete leftover(s)`** — 受信途中で落ちたファイルです。宛先が判らないため破棄しています。送信側から再送してください。

---

## 📝 更新履歴

- **v2.0.0** — バイナリ転送（プロトコル2）対応。画像・動画の両方に対応。受信即応答＋保存キューによる非同期・順次保存、一時領域(`TMP_PATH`)の自動回収、起動時の書き込み権限検証、`GET` によるサポート状況の問い合わせを追加。`fs-extra` 依存を削除。旧 JSON/base64 経路は受信互換のため維持（非推奨）。
- v1.0.0 — 初版。JSON + data URL(base64) による画像受信。
