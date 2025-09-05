// worker.js
'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('fs');
const fsp = require('fs').promises;
const fse = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

// 保存先は環境変数で柔軟に（カンマ区切りで複数ディレクトリへ複写）
const SAVE_ROOTS = (process.env.SAVE_ROOTS || '/mnt/Ext9/makesd,/mnt/gd_ilacts_crypt/makesd')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// base64をBufferへ（巨大でも一括→今回はdata URL想定なので妥当）
function b64ToBuffer(b64) {
    return Buffer.from(b64, 'base64');
}

// 疑似アトミック: 一時ファイルへ書いてからrename
async function atomicWrite(fullPath, buf) {
    const dir = path.dirname(fullPath);
    await fse.mkdirs(dir);
    const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fsp.writeFile(tmp, buf, { flag: 'w' });
    await fsp.rename(tmp, fullPath);
}

// 重複排除用にオプションでハッシュ名にする例（ここでは通常名＋拡張子を採用）
// 必要になったら下記のname決定ロジックを切り替え:
// const hash = crypto.createHash('sha256').update(buf).digest('hex');
// const fileName = `${hash}${ext}`;

(async () => {
    const { mime, base64, name, folderId, datePath } = workerData;
    const buf = b64ToBuffer(base64);

    // 同日ディレクトリ配下に folderId/name で保存
    const rel = path.join(folderId, datePath, name);

    for (const root of SAVE_ROOTS) {
        const outPath = path.join(root, rel);
        try {
            await atomicWrite(outPath, buf);
            // ログを短く
            console.log(`write: ${outPath}`);
        } catch (e) {
            console.error(`write failed: ${outPath} : ${e && e.message}`);
        }
    }

    // 親へ完了通知（内容はシンプルに）
    if (parentPort) parentPort.postMessage({ ok: true, name, folderId, bytes: buf.length });
})().catch(e => {
    console.error('worker top-level error:', e && e.message);
    if (parentPort) parentPort.postMessage({ ok: false, error: e && e.message });
});