module.exports = {
  apps: [
    {
      name: "image-server",
      script: "./app.js",
      instances: 1,
      autorestart: true,
      watch: false,
      // バイナリ転送はストリーム保存のため転送サイズに関係なくメモリはほぼ一定
      // （250MiB の動画6本を同時受信しても実測 190MiB 程度）。
      // この余裕は旧 JSON(base64) 経路を受けた場合の保険。
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",

        // === サーバ設定 ===
        PORT: 8443,
        HOST: "0.0.0.0",

        // === APIエンドポイント（送信側の "API path" と一致させる） ===
        ADD_FROM_URL_PATH: "/api",

        // === 認証 ===
        AUTH_TOKEN: "",

        // === 保存先（カンマ区切りで複数指定可能。1番目が主保存先） ===
        // 1番目への書き込み失敗はリクエスト失敗になるので、最も確実なディスクを先頭に。
        SAVE_ROOTS: "/tmp",

        // === バイナリ転送（画像・動画共通の本経路） ===
        // 1ファイルの上限。ストリーム保存なのでメモリではなくディスク保護用の値。
        MAX_UPLOAD_BYTES: "2gb",
        // 受信中のファイルを置く場所。空なら <SAVE_ROOTS[0]>/.spool。
        // 主保存先と同じファイルシステムに置くと、確定フェーズが rename だけで済む。
        SPOOL_DIR: "",
        // 確定フェーズ（最終パスへの移動＋副保存先へのコピー）の同時実行数。1 = 順次処理。
        SAVE_CONCURRENCY: 1,
        // 確定待ちキューの上限。超えると 503 を返して送信側にリトライさせる。
        QUEUE_LIMIT: 1000,

        // === タイムアウト（大容量転送用。既定のままだと動画で切れる） ===
        REQUEST_TIMEOUT_MS: 600000,   // 1リクエスト全体（10分）
        HEADERS_TIMEOUT_MS: 65000,
        KEEPALIVE_TIMEOUT_MS: 60000,

        // === 旧 JSON/base64 経路（非推奨・受信互換用。"0" で無効化） ===
        ACCEPT_LEGACY_JSON: "1",
        BODY_LIMIT: "256mb",          // 旧 JSON 経路にのみ適用
        WORKER_CONCURRENCY: 4         // 旧 JSON 経路にのみ適用
      }
    }
  ]
};
