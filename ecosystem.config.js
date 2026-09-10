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

        // === 保存先（最終的な保存先。カンマ区切りで複数指定可能） ===
        // 指定した「すべての」ディレクトリに保存される。
        // 1番目は主保存先で、ここへの書き込み失敗はリクエスト失敗になるため、
        // 最も確実なディスク（できればローカル）を先頭に置く。
        SAVE_ROOTS: "/home",

        // === 一時領域（受信したファイルの「実体」を置く場所） ===
        // 受信したデータはまずここに書き、202 を返す。その後 SAVE_ROOTS の
        // すべてへコピーし、全部書き終わったらここのファイルを削除する。
        // （通常は空。残るのは異常終了したときだけで、次回起動時に回収される）
        // 空なら OS の一時ディレクトリ配下 (<os.tmpdir()>/sdweb-image-send) を使う。
        // 注意: /tmp が tmpfs（RAM）の環境では実ディスク上のパスを明示すること。
        TMP_PATH: "/tmp/sdweb-image-send",

        // === 状態記録（並行処理の進捗を残すジャーナル） ===
        // 「どの保存先まで書けたか」を1件ごとに記録する。中身は小さな JSON だけ。
        // これがあるので、異常終了しても未完了の保存先だけをやり直せる。
        // 空なら <TMP_PATH>/.spool を使う。
        SPOOL_DIR: "",

        // === バイナリ転送（画像・動画共通の本経路） ===
        // 1ファイルの上限。ストリーム保存なのでメモリではなくディスク保護用の値。
        MAX_UPLOAD_BYTES: "2gb",
        // 保存フェーズ（TMP_PATH から SAVE_ROOTS へのコピー）の同時実行数。1 = 順次処理。
        SAVE_CONCURRENCY: 1,
        // 保存待ちキュー（メモリ上）の上限。超えると 503 を返して送信側にリトライさせる。
        QUEUE_LIMIT: 1000,
        // 一部の保存先が失敗したときの再試行回数と間隔。
        // 超えたら諦めて TMP_PATH のファイルを消す（成功した保存先はそのまま残る）。
        SAVE_MAX_ATTEMPTS: 3,
        SAVE_RETRY_DELAY_MS: 30000,

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
