module.exports = {
  apps: [
    {
      name: "image-server",
      script: "./app.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",

        // === サーバ設定 ===
        PORT: 8443,
        HOST: "0.0.0.0",
        BODY_LIMIT: "256mb",

        // === APIエンドポイント ===
        ADD_FROM_URL_PATH: "/api",

        // === 認証 ===
        AUTH_TOKEN: "",

        // === ワーカープロセス ===
        WORKER_CONCURRENCY: 4,

        // === 保存先（カンマ区切りで複数指定可能） ===
        SAVE_ROOTS: "/tmp"
      }
    }
  ]
};
