// app.js
'use strict';

const express = require('express');
const { Worker } = require('node:worker_threads');
const path = require('path');

const PORT = Number(process.env.PORT || 8443);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''; // 空ならチェックしない
const BODY_LIMIT = process.env.BODY_LIMIT || '256mb'; // 既定: 256MB
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 4));
const ADD_FROM_URL_PATH = process.env.ADD_FROM_URL_PATH || '/';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: BODY_LIMIT }));

const server = app.listen(PORT, HOST, () => {
    console.log(`listening on ${HOST}:${PORT}`);
});

// ---- 簡易ワーカープール（同時実行数を制限） ----
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
        const result = await runInWorker(next.payload);
        next.resolve(result);
    } catch (e) {
        next.reject(e);
    } finally {
        running--;
        // スループット向上: 次をすぐ流す
        setImmediate(drain);
    }
}

// ---- ユーティリティ ----
function todayStr() {
    const d = new Date();
    const mm = `${d.getMonth() + 1}`.padStart(2, '0');
    const dd = `${d.getDate()}`.padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

// data URL検証 & 解析
function parseDataUrl(u) {
    // 形式例: data:image/png;base64,XXXXX
    if (typeof u !== 'string' || !u.startsWith('data:image/')) return null;
    const semi = u.indexOf(';');
    const comma = u.indexOf(',');
    if (semi < 0 || comma < 0 || comma < semi) return null;
    const mime = u.slice('data:'.length, semi);      // image/png 等
    const enc = u.slice(semi + 1, comma);            // base64 など
    const data = u.slice(comma + 1);                 // 本体
    if (!/^base64$/i.test(enc)) return null;
    if (!/^image\//i.test(mime)) return null;
    return { mime, data };
}

// ファイル名/フォルダIDの簡易サニタイズ
function sanitizeId(s, max = 200) {
    if (typeof s !== 'string' || !s.length) return null;
    const cleaned = s.replace(/[^a-zA-Z0-9_\-\.]/g, '').slice(0, max);
    return cleaned || null;
}

function extFromMime(mime) {
    switch (mime.toLowerCase()) {
        case 'image/png': return '.png';
        case 'image/jpeg': return '.jpg';
        case 'image/webp': return '.webp';
        case 'image/gif': return '.gif';
        default: return '.png';
    }
}

// ---- ルート ----
app.post(ADD_FROM_URL_PATH, async (req, res) => {
    try {
        // 認証（任意）
        if (AUTH_TOKEN) {
            const token = req.get('X-Auth-Token') || '';
            if (token !== AUTH_TOKEN) {
                return res.status(401).json({ status: 'unauthorized' });
            }
        }

        const { url, name, folderId } = req.body || {};
        if (!url || !name || !folderId) {
            return res.status(400).json({ status: 'bad_request', reason: 'missing fields' });
        }

        const parsed = parseDataUrl(url);
        if (!parsed) {
            return res.status(400).json({ status: 'bad_request', reason: 'invalid data url' });
        }

        const safeName = sanitizeId(name);
        const safeFolder = sanitizeId(folderId);
        if (!safeName || !safeFolder) {
            return res.status(400).json({ status: 'bad_request', reason: 'invalid name or folderId' });
        }

        // 拡張子をMIMEから決める
        const ext = extFromMime(parsed.mime);
        // 同日パスはサーバで固定（ワーカーごとズレ防止）
        const datePath = todayStr();

        // ここでキュー投入（非同期処理）
        schedule({
            mime: parsed.mime,
            base64: parsed.data,
            name: safeName + ext,
            folderId: safeFolder,
            datePath
        }).catch(err => {
            // バックグラウンド失敗時はログのみ（応答はすでに返している想定）
            console.error('worker failed:', err && err.message);
        });

        // 互換性を保ちつつ、処理は非同期化
        res.status(202).json({ status: 'success' });
    } catch (e) {
        console.error('handler error:', e && e.message);
        res.status(500).json({ status: 'error' });
    }
});