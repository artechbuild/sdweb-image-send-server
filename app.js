// app.js
'use strict';

const express = require('express');
const { Worker } = require('node:worker_threads');
const path = require('path');
const storage = require('./storage');

// ---- 設定 ----
function parseSize(v, fallbackBytes) {
    if (v === undefined || v === null || v === '') return fallbackBytes;
    const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?\s*$/i.exec(String(v));
    if (!m) return fallbackBytes;
    const mul = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
    return Math.floor(parseFloat(m[1]) * mul[(m[2] || 'b').toLowerCase()]);
}

// 転送プロトコルのバージョン
//   1 = 旧方式: JSON + data URL(base64)
//   2 = 新方式: 生バイナリをボディにストリーム、メタデータはヘッダ
const PROTOCOL_MIN = 1;
const PROTOCOL_MAX = 2;

const PORT = Number(process.env.PORT || 8443);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''; // 空ならチェックしない
const ADD_FROM_URL_PATH = process.env.ADD_FROM_URL_PATH || '/api';

// バイナリ転送の上限。ストリーム保存なのでメモリではなくディスク保護のための値。
const MAX_UPLOAD_BYTES = parseSize(process.env.MAX_UPLOAD_BYTES, 2 * 1024 ** 3); // 既定 2GB

// 確定フェーズ（最終パスへの rename + 副保存先へのコピー）の同時実行数。
// 1 = 順次処理。ディスクを取り合わせないため既定は 1。
const SAVE_CONCURRENCY = Math.max(1, Number(process.env.SAVE_CONCURRENCY || 1));
// 保存待ちキューの上限。超えたら 503 を返して送信側にリトライさせる。
const QUEUE_LIMIT = Math.max(1, Number(process.env.QUEUE_LIMIT || 1000));
// 一部の保存先が失敗したときに再試行する回数と間隔。
// 超えたら諦めて TMP_PATH のファイルと状態記録を消す（成功した保存先はそのまま残す）。
const SAVE_MAX_ATTEMPTS = Math.max(1, Number(process.env.SAVE_MAX_ATTEMPTS || 3));
const SAVE_RETRY_DELAY_MS = Math.max(1000, Number(process.env.SAVE_RETRY_DELAY_MS || 30000));

// 旧 JSON(base64/data URL) 経路。ローリング更新用に受信のみ残す。0 で無効化。
const ACCEPT_LEGACY_JSON = process.env.ACCEPT_LEGACY_JSON !== '0';
const BODY_LIMIT = process.env.BODY_LIMIT || '256mb'; // 旧 JSON 経路にのみ適用
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 4)); // 同上

// タイムアウト（大容量転送では既定値が短すぎるため明示設定）
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 600000);   // 1リクエスト全体
const HEADERS_TIMEOUT_MS = Number(process.env.HEADERS_TIMEOUT_MS || 65000);
const KEEPALIVE_TIMEOUT_MS = Number(process.env.KEEPALIVE_TIMEOUT_MS || 60000);

// 旧 JSON 経路を無効化している場合、実際に受理できる最小バージョンは 2
const EFFECTIVE_MIN = ACCEPT_LEGACY_JSON ? PROTOCOL_MIN : 2;

const app = express();
app.disable('x-powered-by');

// express.json は Content-Type: application/json のときだけボディを消費する。
// バイナリ転送(image/*, video/*, application/octet-stream)は素通りしてハンドラへ届く。
if (ACCEPT_LEGACY_JSON) {
    app.use(express.json({ limit: BODY_LIMIT }));
}

// 送信側が対応バージョンを学習できるよう、全レスポンスに載せる
app.use((_req, res, next) => {
    res.set('X-Protocol-Version', String(PROTOCOL_MAX));
    next();
});

const server = app.listen(PORT, HOST, () => {
    console.log(`listening on ${HOST}:${PORT} path=${ADD_FROM_URL_PATH}`);
    console.log(`max upload: ${(MAX_UPLOAD_BYTES / 1024 ** 2).toFixed(0)} MiB, protocol: ${EFFECTIVE_MIN}-${PROTOCOL_MAX}, legacy json: ${ACCEPT_LEGACY_JSON ? 'on' : 'off'}`);
    console.log(`save concurrency: ${SAVE_CONCURRENCY}, queue limit: ${QUEUE_LIMIT}`);
    startup();
});

// 起動時に保存先とスプールへ実際に書けるかを確認する。
// 権限不足をリクエストのたびに EACCES で失敗させるのではなく、起動時に気づけるようにする。
async function startup() {
    const roots = await storage.checkSaveRoots();
    for (const r of roots) {
        const tag = r.root === storage.SAVE_ROOTS[0] ? 'primary' : 'copy';
        if (r.ok) {
            console.log(`save root [${tag}] OK: ${r.root}`);
        } else {
            console.error(`save root [${tag}] NOT WRITABLE: ${r.root} : ${r.error}`);
        }
    }
    if (roots.every(r => !r.ok)) {
        console.error('ERROR: no save root is writable. check ownership/permissions of SAVE_ROOTS.');
    }

    let tmp, spool;
    try {
        tmp = await storage.ensureTmpDir();
    } catch (e) {
        console.error(`ERROR: ${e && e.message}`);
        console.error('set TMP_PATH to a writable directory with enough free space.');
        return;
    }
    try {
        spool = await storage.ensureSpoolDir();
    } catch (e) {
        console.error(`ERROR: ${e && e.message}`);
        console.error('set SPOOL_DIR to a writable directory.');
        return;
    }
    console.log(`temp path (file body):   ${tmp}`);
    console.log(`spool dir (job state):   ${spool}`);

    // /tmp が tmpfs の環境では大きな動画がRAMを消費してしまう
    if (await storage.isRamBacked(tmp)) {
        console.error(`WARNING: TMP_PATH (${tmp}) is a RAM-backed filesystem (tmpfs/ramfs).`);
        console.error('         large uploads would consume memory. set TMP_PATH to a real disk.');
    }

    recoverJobsOnBoot();
}

server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;

// ---- ユーティリティ ----
function todayStr() {
    const d = new Date();
    const mm = `${d.getMonth() + 1}`.padStart(2, '0');
    const dd = `${d.getDate()}`.padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

// ファイル名/フォルダIDの簡易サニタイズ
function sanitizeId(s, max = 200) {
    if (typeof s !== 'string' || !s.length) return null;
    const cleaned = s.replace(/[^a-zA-Z0-9_\-\.]/g, '').slice(0, max);
    return cleaned || null;
}

// HTTPヘッダは非ASCIIを安全に運べないため、送信側でパーセントエンコードしている
function decodeHeader(v) {
    if (typeof v !== 'string' || !v.length) return null;
    try {
        return decodeURIComponent(v);
    } catch {
        return v; // エンコードされていない値もそのまま受ける
    }
}

// ボディを読まずに拒否する。巨大データを無駄に受信しないよう接続を閉じる。
function reject(res, code, body) {
    res.set('Connection', 'close');
    res.status(code).json(body);
}

function checkAuth(req) {
    if (!AUTH_TOKEN) return true;
    return (req.get('X-Auth-Token') || '') === AUTH_TOKEN;
}

// ================= 確定キュー（順次処理） =================
// 受信済み(スプール済み)のファイルを最終パスへ確定する処理を直列に流す。
// 送信側はスプール完了時点で 202 を受け取り、ここの完了は待たない。
const saveQueue = [];
let saveRunning = 0;
let totalQueued = 0;
let totalDone = 0;
let totalFailed = 0;

function enqueueFinalize(job) {
    saveQueue.push(job);
    totalQueued++;
    drainSaveQueue();
}

function drainSaveQueue() {
    while (saveRunning < SAVE_CONCURRENCY && saveQueue.length > 0) {
        const job = saveQueue.shift();
        saveRunning++;
        storage.finalize(job)
            .then(async result => {
                if (result.complete) {
                    totalDone++;
                    console.log(`saved: ${job.rel} (${job.bytes} bytes, roots=${result.paths.length}, queue=${saveQueue.length})`);
                    return;
                }

                for (const f of result.failed) {
                    console.error(`save failed [${job.done.length}/${storage.SAVE_ROOTS.length} done]: ${f.root} : ${f.error}`);
                }

                if (job.attempts < SAVE_MAX_ATTEMPTS) {
                    // 未完了の保存先だけを後で再試行する（完了済みはやり直さない）
                    console.log(`retrying ${job.rel} in ${SAVE_RETRY_DELAY_MS / 1000}s (attempt ${job.attempts}/${SAVE_MAX_ATTEMPTS})`);
                    setTimeout(() => enqueueFinalize(job), SAVE_RETRY_DELAY_MS).unref();
                    return;
                }

                totalFailed++;
                console.error(`giving up after ${job.attempts} attempts: ${job.rel} (saved to ${job.done.length}/${storage.SAVE_ROOTS.length} roots)`);
                await storage.abandon(job);
            })
            .catch(e => {
                totalFailed++;
                // 一時ファイルと状態記録は残す（次回起動時の回収対象になる）
                console.error(`finalize error: ${job.rel} : ${e && e.message} (temp file kept: ${job.tmpFile})`);
            })
            .finally(() => {
                saveRunning--;
                setImmediate(drainSaveQueue);
            });
    }
}

async function recoverJobsOnBoot() {
    try {
        const { pending, discarded } = await storage.recoverJobs();
        if (discarded) console.log(`recovery: discarded ${discarded} unusable leftover(s)`);
        if (pending.length) {
            console.log(`recovery: resuming ${pending.length} unfinished job(s)`);
            for (const job of pending) {
                console.log(`  ${job.rel} (${job.done.length}/${storage.SAVE_ROOTS.length} roots already saved)`);
                job.attempts = 0;   // 起動しなおしたので試行回数をリセット
                enqueueFinalize(job);
            }
        }
    } catch (e) {
        console.error('recovery failed:', e && e.message);
    }
}

// ---- 旧 JSON/base64 経路のワーカープール ----
const queue = [];
let running = 0;

function runInWorker(payload) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: payload });
        worker.once('message', msg => resolve(msg));
        worker.once('error', err => reject(err));
        worker.once('exit', code => {
            if (code !== 0) reject(new Error(`worker stopped with code ${code}`));
        });
    });
}

function schedule(payload) {
    return new Promise((resolve, reject) => {
        queue.push({ payload, resolve, reject });
        drain();
    });
}

async function drain() {
    if (running >= CONCURRENCY) return;
    const next = queue.shift();
    if (!next) return;

    running++;
    try {
        next.resolve(await runInWorker(next.payload));
    } catch (e) {
        next.reject(e);
    } finally {
        running--;
        setImmediate(drain);
    }
}

// data URL検証 & 解析（旧経路のみ）
function parseDataUrl(u) {
    if (typeof u !== 'string' || !u.startsWith('data:')) return null;
    const semi = u.indexOf(';');
    const comma = u.indexOf(',');
    if (semi < 0 || comma < 0 || comma < semi) return null;
    const mime = u.slice('data:'.length, semi);
    const enc = u.slice(semi + 1, comma);
    const data = u.slice(comma + 1);
    if (!/^base64$/i.test(enc)) return null;
    if (!storage.isMediaMime(mime)) return null;
    return { mime, data };
}

// ================= バイナリ転送（画像・動画共通の本経路） =================
async function handleBinary(req, res) {
    const rawName = decodeHeader(req.get('X-Item-Name'));
    const rawFolder = decodeHeader(req.get('X-Folder-Id'));
    const mime = (req.get('Content-Type') || '').split(';')[0].trim().toLowerCase();

    const safeName = sanitizeId(rawName);
    const safeFolder = sanitizeId(rawFolder);
    if (!safeName || !safeFolder) {
        return reject(res, 400, { status: 'bad_request', reason: 'invalid or missing X-Item-Name / X-Folder-Id' });
    }

    // 拡張子は送信側の明示指定（X-Item-Ext）を優先し、無ければ Content-Type から決める
    const ext = storage.normalizeExt(req.get('X-Item-Ext')) || storage.extFromMime(mime);
    if (!ext) {
        return reject(res, 415, { status: 'unsupported_media_type', reason: `cannot determine extension (content-type=${mime || 'none'})` });
    }
    if (!storage.isMediaMime(mime) && mime !== 'application/octet-stream') {
        return reject(res, 415, { status: 'unsupported_media_type', reason: `content-type must be image/*, video/* or application/octet-stream (got ${mime || 'none'})` });
    }

    // 確定待ちが溜まりすぎているときは受け付けない（ディスクを守る）
    if (saveQueue.length >= QUEUE_LIMIT) {
        res.set('Retry-After', '30');
        return reject(res, 503, { status: 'queue_full', queued: saveQueue.length });
    }

    // Content-Length が分かっていれば受信前に上限と空き容量を判定
    const declared = Number(req.get('Content-Length') || 0);
    if (declared > MAX_UPLOAD_BYTES) {
        return reject(res, 413, { status: 'payload_too_large', limit: MAX_UPLOAD_BYTES, declared });
    }
    if (declared > 0) {
        // スプール + 全保存先の分
        // 一時領域(1) + 全保存先(N) 分の空きが必要
        const need = declared * (storage.SAVE_ROOTS.length + 1);
        if (!(await storage.hasFreeSpace(storage.tmpDir() || storage.SAVE_ROOTS[0], need))) {
            return reject(res, 507, { status: 'insufficient_storage', need });
        }
    }

    const rel = path.join(safeFolder, todayStr(), safeName + ext);

    try {
        // --- 受信フェーズ: ボディを TMP_PATH へ直接ストリーム書き込み + 状態記録の作成 ---
        const job = await storage.receiveToTmp(req, { rel, maxBytes: MAX_UPLOAD_BYTES });

        // --- ここで送信側を解放する。保存はキューに任せて待たせない ---
        res.status(202).json({ status: 'accepted', bytes: job.bytes, queued: saveQueue.length + 1 });

        enqueueFinalize(job);
    } catch (e) {
        if (e && e.code === 'E_TOO_LARGE') {
            console.error(`rejected (too large): ${rel}`);
            if (!res.headersSent) return reject(res, 413, { status: 'payload_too_large', limit: MAX_UPLOAD_BYTES });
            return;
        }
        if (req.destroyed || (e && (e.code === 'ECONNRESET' || e.code === 'ERR_STREAM_PREMATURE_CLOSE'))) {
            console.error(`upload aborted: ${rel} : ${e && e.message}`);
            if (!res.headersSent) return reject(res, 400, { status: 'aborted' });
            return;
        }
        if (e && (e.code === 'E_NO_TMP' || e.code === 'E_NO_SPOOL')) {
            console.error(`storage unavailable: ${rel} : ${e.message}`);
            if (!res.headersSent) return reject(res, 507, {
                status: 'storage_unavailable',
                reason: e.code === 'E_NO_TMP'
                    ? 'server has no writable temp directory; set TMP_PATH'
                    : 'server has no writable spool directory; set SPOOL_DIR',
            });
            return;
        }
        console.error(`receive failed: ${rel} : ${e && e.message}`);
        if (!res.headersSent) return reject(res, 500, { status: 'error' });
    }
}

// ================= 旧 JSON/base64 経路（非推奨。受信互換のためだけに残す） =================
function handleLegacyJson(req, res) {
    const { url, name, folderId } = req.body || {};
    if (!url || !name || !folderId) {
        return reject(res, 400, { status: 'bad_request', reason: 'missing fields' });
    }

    const parsed = parseDataUrl(url);
    if (!parsed) {
        return reject(res, 400, { status: 'bad_request', reason: 'invalid data url' });
    }

    const safeName = sanitizeId(name);
    const safeFolder = sanitizeId(folderId);
    if (!safeName || !safeFolder) {
        return reject(res, 400, { status: 'bad_request', reason: 'invalid name or folderId' });
    }

    const ext = storage.extFromMime(parsed.mime) || '.png';

    schedule({
        base64: parsed.data,
        name: safeName + ext,
        folderId: safeFolder,
        datePath: todayStr(),
    }).catch(err => {
        console.error('worker failed:', err && err.message);
    });

    // 旧クライアント互換: 保存完了を待たずに 202 を返す
    res.status(202).json({ status: 'success' });
}

// ---- ルート ----

// 送信側がサポート状況を問い合わせるためのエンドポイント。
// 旧サーバはこのGETを持たないため404が返り、送信側は「旧方式のみ」と判断できる。
app.get(ADD_FROM_URL_PATH, (req, res) => {
    if (!checkAuth(req)) {
        return reject(res, 401, { status: 'unauthorized' });
    }
    res.status(200).json({
        status: 'ok',
        server: 'sdweb-image-send-server',
        protocol: { min: EFFECTIVE_MIN, max: PROTOCOL_MAX },
        maxUploadBytes: MAX_UPLOAD_BYTES,
        legacyJson: ACCEPT_LEGACY_JSON,
        saveRoots: storage.SAVE_ROOTS.length,
        tmpPath: storage.tmpDir(),
        spoolDir: storage.spoolDir(),
        queue: {
            pending: saveQueue.length,
            running: saveRunning,
            concurrency: SAVE_CONCURRENCY,
            limit: QUEUE_LIMIT,
            queued: totalQueued,
            done: totalDone,
            failed: totalFailed,
        },
    });
});

app.post(ADD_FROM_URL_PATH, (req, res) => {
    if (!checkAuth(req)) {
        return reject(res, 401, { status: 'unauthorized' });
    }

    const rawVer = req.get('X-Protocol-Version');
    const ct = (req.get('Content-Type') || '').toLowerCase();

    let version;
    if (rawVer === undefined || rawVer === '') {
        // バージョン未指定の旧クライアント: Content-Type から推定する
        version = ct.startsWith('application/json') ? 1 : 2;
    } else {
        version = Number(rawVer);
        if (!Number.isInteger(version) || version < PROTOCOL_MIN) {
            return reject(res, 400, {
                status: 'bad_request',
                reason: `invalid X-Protocol-Version: ${rawVer}`,
                supported: { min: EFFECTIVE_MIN, max: PROTOCOL_MAX },
            });
        }
        if (version > PROTOCOL_MAX) {
            // 送信側が本サーバより新しい。対応範囲を伝えて再送(ダウングレード)させる。
            return reject(res, 400, {
                status: 'unsupported_protocol_version',
                requested: version,
                supported: { min: EFFECTIVE_MIN, max: PROTOCOL_MAX },
            });
        }
    }

    if (version >= 2) {
        return handleBinary(req, res);
    }

    if (!ACCEPT_LEGACY_JSON) {
        return reject(res, 415, {
            status: 'unsupported_media_type',
            reason: 'protocol 1 (base64) is disabled on this server; use protocol 2 (binary)',
            supported: { min: 2, max: PROTOCOL_MAX },
        });
    }
    return handleLegacyJson(req, res);
});

// JSON パースエラー等をJSONで返す
app.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.too.large') {
        console.error('legacy json payload too large');
        return reject(res, 413, { status: 'payload_too_large', reason: 'use binary transfer instead of base64' });
    }
    console.error('handler error:', err && err.message);
    if (!res.headersSent) reject(res, 500, { status: 'error' });
});
