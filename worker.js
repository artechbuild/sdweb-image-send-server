// worker.js
// 旧 JSON/base64 経路の保存ワーカー。
// バイナリ転送(本経路)は app.js がストリームで直接保存するため、ここは通らない。
'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const path = require('path');
const storage = require('./storage');

(async () => {
    const { base64, name, folderId, datePath } = workerData;
    const buf = Buffer.from(base64, 'base64');

    const rel = path.join(folderId, datePath, name);
    const result = await storage.saveBuffer(buf, { rel });

    for (const p of result.paths) console.log(`write: ${p}`);
    for (const f of result.failed) console.error(`write failed: ${f.root} : ${f.error}`);

    if (parentPort) {
        parentPort.postMessage({
            ok: result.paths.length > 0,
            name,
            folderId,
            bytes: result.bytes,
            saved: result.paths.length,
            failed: result.failed.length,
        });
    }
})().catch(e => {
    console.error('worker top-level error:', e && e.message);
    if (parentPort) parentPort.postMessage({ ok: false, error: e && e.message });
});
