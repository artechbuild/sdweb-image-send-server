# sdweb-image-send-server

Stable Diffusion WebUI の拡張機能から送信された画像を受け取り、ディスクに保存する Node.js サーバです。  
**clone → npm install → npm run pm2:start** ですぐに動作します。

**サーバには、事前に、node,npm,pm2のインストール**が必要です。

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

|変数|デフォルト|説明
|-|-|-|
|PORT|8443|サーバの待ち受けポート
|HOST|0.0.0.0|バインド先ホスト
|BODY_LIMIT|256mb|リクエストボディ上限
|ADD_FROM_URL_PATH|/api/item/addFromURL|受け取りAPIのパス
|AUTH_TOKEN|(空)|任意。設定するとヘッダ X-Auth-Token を必須に
|WORKER_CONCURRENCY|4|同時実行ワーカー数
|SAVE_ROOTS|/|保存先ディレクトリ（カンマ区切りで複数指定可能）

## 🔧 動作確認

🔧 動作確認

1. Stable Diffusion WebUI 側拡張機能を有効化し、
    - Outside server base URL: http://\<your-host\>:8443
    - API path: /api/item/addFromURL
    - FolderID: 任意
    - Auth Token: 必要なら設定

2. 画像を生成すると、自動的に保存されます。
3. 保存先は SAVE_ROOTS で指定したディレクトリの下に作成され、カンマ区切りで複数の保存先も指定できます
```text
<folderId>/<YYYY-MM-DD>/<filename>.png
の形式で保存されます。
```