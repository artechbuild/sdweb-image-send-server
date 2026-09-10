// storage.js
// 保存処理の共通モジュール。
//
// 役割の分離:
//   SAVE_ROOTS … 最終的な保存先（カンマ区切りで複数）。すべてに同じファイルを書く。
//   TMP_PATH   … 受信したファイルの「実体」を置く一時領域。全保存先へ書き終わったら消す。
//   SPOOL_DIR  … 並行処理の「状態記録」を置くジャーナル。どの保存先まで書けたかを残す。
//
// 流れ:
//   1) 受信      receiveToTmp() … ボディを TMP_PATH へ直接ストリーム書き込み
//                                 → SPOOL_DIR に状態記録を作成 → 呼び出し側が 202 を返す
//   2) 保存      finalize()     … TMP_PATH のファイルを SAVE_ROOTS の各所へコピーし、
//                                 1件ごとに状態記録を更新する
//   3) 後片付け                  … 全保存先が完了したら TMP_PATH のファイルと状態記録を削除
//
// 状態記録があるおかげで、異常終了しても「未完了の保存先だけ」をやり直せる。
'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

// 最終的な保存先（カンマ区切りで複数指定可能）。すべてに保存する。
const SAVE_ROOTS = (process.env.SAVE_ROOTS || '/tmp')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// ---- 書き込み可否の実測 ----
// mkdir だけでは足りない（作れても書けないことがある）ので、実際にファイルを書いて消す
async function probeWritable(dir) {
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${Math.random().toString(16).slice(2)}`);
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
}

// 候補を順に試して最初に書けたものを採用する仕組み。
// 一度成功したら記憶し、失敗した場合は次回呼び出しで再挑戦するので、
// 権限を直せばサーバを再起動せずに復旧する。
function makeDirResolver(name, candidatesFn, errCode) {
    let resolved = null;
    let inflight = null;

    async function ensure() {
        if (resolved) return resolved;
        if (inflight) return inflight;

        inflight = (async () => {
            const errors = [];
            for (const dir of candidatesFn()) {
                try {
                    await probeWritable(dir);
                    resolved = dir;
                    return dir;
                } catch (e) {
                    errors.push(`${dir}: ${e && e.code ? e.code : ''} ${e && e.message}`);
                }
            }
            const err = new Error(`no writable ${name} directory. tried:\n  ` + errors.join('\n  '));
            err.code = errCode;
            throw err;
        })();

        try {
            return await inflight;
        } finally {
            inflight = null;
        }
    }

    return { ensure, get: () => resolved };
}

// ---- TMP_PATH: 受信ファイルの実体 ----
// SAVE_ROOTS[0] と同じファイルシステム上にあってもコピーで書くため、
// 置き場所は速度ではなく「十分な空き容量がある実ディスク」で選ぶとよい。
function tmpCandidates() {
    const list = [];
    const explicit = (process.env.TMP_PATH || '').trim();
    if (explicit) list.push(explicit);
    list.push(path.join(os.tmpdir(), 'sdweb-image-send'));
    list.push(path.join(SAVE_ROOTS[0], '.tmp'));       // 最後の砦
    return [...new Set(list)];
}
const _tmp = makeDirResolver('temp', tmpCandidates, 'E_NO_TMP');

// ---- SPOOL_DIR: 並行処理の状態記録 ----
// 中身は小さな JSON だけ。TMP_PATH と生死を共にする必要があるため、既定は TMP_PATH の配下。
function spoolCandidates() {
    const list = [];
    const explicit = (process.env.SPOOL_DIR || '').trim();
    if (explicit) list.push(explicit);
    const t = _tmp.get();
    if (t) list.push(path.join(t, '.spool'));
    list.push(path.join(os.tmpdir(), 'sdweb-image-send', '.spool'));
    list.push(path.join(SAVE_ROOTS[0], '.spool'));     // 最後の砦
    return [...new Set(list)];
}
const _spool = makeDirResolver('spool', spoolCandidates, 'E_NO_SPOOL');

async function ensureTmpDir() { return _tmp.ensure(); }
async function ensureSpoolDir() {
    await _tmp.ensure().catch(() => {});   // TMP_PATH 配下を既定にするため先に解決を試みる
    return _spool.ensure();
}
function tmpDir() { return _tmp.get(); }
function spoolDir() { return _spool.get(); }

// ---- 診断 ----
// tmpfs / ramfs のマジックナンバー（Linux）。ここに大きな動画を置くとRAMを消費する。
const RAM_FS_TYPES = new Set([0x01021994, 0x858458f6]);

/** 同じファイルシステム上か（デバイス番号で判定するので文字列比較より正確） */
async function sameDevice(a, b) {
    try {
        const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
        return sa.dev === sb.dev;
    } catch {
        return null;
    }
}

/** RAM上のファイルシステムかどうか。判定できない場合は null */
async function isRamBacked(dir) {
    if (typeof fsp.statfs !== 'function') return null;
    try {
        const st = await fsp.statfs(dir);
        if (typeof st.type !== 'number') return null;
        return RAM_FS_TYPES.has(st.type);
    } catch {
        return null;
    }
}

/** 各保存先に実際に書けるかを起動時に確認する（診断用） */
async function checkSaveRoots() {
    const results = [];
    for (const root of SAVE_ROOTS) {
        try {
            await probeWritable(root);
            results.push({ root, ok: true });
        } catch (e) {
            results.push({ root, ok: false, error: `${e && e.code ? e.code + ' ' : ''}${e && e.message}` });
        }
    }
    return results;
}

/** 空き容量チェック。statfs は Node 18.15+ / 19.6+。使えない環境では常に true。 */
async function hasFreeSpace(dir, needBytes) {
    if (!needBytes || typeof fsp.statfs !== 'function') return true;
    try {
        await fsp.mkdir(dir, { recursive: true });
        const st = await fsp.statfs(dir);
        return st.bsize * st.bavail >= needBytes;
    } catch {
        return true; // 判定できないときは通す
    }
}

// ---- MIME / 拡張子 ----
const MIME_TO_EXT = {
    // 画像
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'image/bmp': '.bmp',
    'image/tiff': '.tif',
    'image/apng': '.apng',
    // 動画
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'video/x-matroska': '.mkv',
    'video/x-msvideo': '.avi',
    'video/x-m4v': '.m4v',
    'video/mpeg': '.mpeg',
    'video/ogg': '.ogv',
};

// クライアントが X-Item-Ext で明示してきた拡張子の許可リスト
const ALLOWED_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.tif', '.tiff', '.apng',
    '.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.mpeg', '.mpg', '.ogv',
]);

function extFromMime(mime) {
    if (typeof mime !== 'string') return null;
    return MIME_TO_EXT[mime.toLowerCase()] || null;
}

// ".MP4" → ".mp4" / 許可外や不正形式は null
function normalizeExt(ext) {
    if (typeof ext !== 'string' || !ext) return null;
    const e = (ext.startsWith('.') ? ext : '.' + ext).toLowerCase();
    if (!/^\.[a-z0-9]{1,8}$/.test(e)) return null;
    return ALLOWED_EXT.has(e) ? e : null;
}

function isMediaMime(mime) {
    return typeof mime === 'string' && /^(image|video)\//i.test(mime);
}

// ---- パス組み立て ----
// rel が root の外に出ないことを保証（多重防御）
function resolveIn(root, rel) {
    const base = path.resolve(root);
    const abs = path.resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
        throw new Error(`path escapes save root: ${rel}`);
    }
    return abs;
}

function tmpPathFor(fullPath) {
    return path.join(path.dirname(fullPath), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function unlinkQuiet(p) {
    try { await fsp.unlink(p); } catch { /* 無視 */ }
}

// ================= 状態記録 (SPOOL_DIR) =================

function statePath(dir, id) {
    return path.join(dir, `${id}.json`);
}

/** 状態記録を書く。書き換え途中で落ちても壊れないよう一時ファイル経由で置き換える。 */
async function writeState(job) {
    const dir = await ensureSpoolDir();
    const dest = statePath(dir, job.id);
    const tmp = `${dest}.writing`;
    const body = JSON.stringify({
        id: job.id,
        rel: job.rel,
        bytes: job.bytes,
        tmpFile: job.tmpFile,
        receivedAt: job.receivedAt,
        done: job.done,          // 書き込みが完了した保存先
        attempts: job.attempts,  // 保存を試みた回数
        updatedAt: new Date().toISOString(),
    });
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, dest);
    return dest;
}

async function deleteState(id) {
    const dir = _spool.get();
    if (!dir) return;
    await unlinkQuiet(statePath(dir, id));
}

// ================= 受信フェーズ =================

// バイト数を数えつつ上限を超えたら中断する Transform
function byteCounter(state, maxBytes) {
    return new Transform({
        transform(chunk, _enc, cb) {
            state.bytes += chunk.length;
            if (maxBytes && state.bytes > maxBytes) {
                const err = new Error(`payload exceeds ${maxBytes} bytes`);
                err.code = 'E_TOO_LARGE';
                return cb(err);
            }
            cb(null, chunk);
        }
    });
}

/**
 * 読み取りストリームを TMP_PATH へ直接書き込み、SPOOL_DIR に状態記録を作る。
 * メモリ使用量は転送サイズに依存せず、ストリームのバッファ分のみ。
 *
 * 状態記録は本体を書き終えてから作る。そのため「状態記録がある = 本体は完成済み」が成り立ち、
 * 受信途中で落ちた本体は状態記録を持たないので回収時に区別できる。
 *
 * @returns {Promise<object>} job
 */
async function receiveToTmp(readable, { rel, maxBytes = 0 }) {
    const dir = await ensureTmpDir();
    const id = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const tmpFile = path.join(dir, `${id}.part`);
    const counted = { bytes: 0 };

    try {
        await pipeline(
            readable,
            byteCounter(counted, maxBytes),
            fs.createWriteStream(tmpFile, { flags: 'wx' })
        );
    } catch (e) {
        await unlinkQuiet(tmpFile);
        throw e;
    }

    const job = {
        id,
        rel,
        bytes: counted.bytes,
        tmpFile,
        receivedAt: new Date().toISOString(),
        done: [],
        attempts: 0,
    };

    try {
        await writeState(job);
    } catch (e) {
        await unlinkQuiet(tmpFile);
        throw e;
    }
    return job;
}

// ================= 保存フェーズ =================

/** 1つの保存先へコピーする（疑似アトミック: 一時名で書いて rename） */
async function copyToRoot(srcPath, root, rel) {
    const dest = resolveIn(root, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = tmpPathFor(dest);
    try {
        await fsp.copyFile(srcPath, tmp);
        await fsp.rename(tmp, dest);
        return dest;
    } catch (e) {
        await unlinkQuiet(tmp);
        throw e;
    }
}

/**
 * TMP_PATH のファイルを SAVE_ROOTS のすべてへコピーする。
 * 保存先は1件ごとに状態記録へ反映するので、途中で落ちても未完了分だけを再開できる。
 * すべて完了したら TMP_PATH のファイルと状態記録を削除する。
 *
 * @returns {Promise<{paths:string[], failed:{root,error}[], complete:boolean}>}
 */
async function finalize(job) {
    job.attempts = (job.attempts || 0) + 1;
    const paths = [];
    const failed = [];

    for (const root of SAVE_ROOTS) {
        if (job.done.includes(root)) {
            // 前回の試行で完了済み。やり直さない。
            paths.push(resolveIn(root, job.rel));
            continue;
        }
        try {
            paths.push(await copyToRoot(job.tmpFile, root, job.rel));
            job.done.push(root);
            await writeState(job);   // 1件ごとに記録（落ちてもここまでは残る）
        } catch (e) {
            failed.push({ root, error: (e && e.message) || String(e) });
        }
    }

    const complete = job.done.length === SAVE_ROOTS.length;
    if (complete) {
        // すべての保存先へ書き終わったので、実体と記録を消す
        await unlinkQuiet(job.tmpFile);
        await deleteState(job.id);
    } else {
        await writeState(job);       // 試行回数を残す
    }
    return { paths, failed, complete };
}

/** あきらめる場合の後片付け（完了した保存先はそのまま残す） */
async function abandon(job) {
    await unlinkQuiet(job.tmpFile);
    await deleteState(job.id);
}

// ================= 起動時の回収 =================

/**
 * SPOOL_DIR の状態記録を読み、未完了のものを回収対象として返す。
 * 実体が無い記録、壊れた記録、記録の無い実体（受信途中で落ちたもの）は破棄する。
 */
async function recoverJobs() {
    const pending = [];
    let discarded = 0;

    let spool, tmp;
    try {
        tmp = await ensureTmpDir();
        spool = await ensureSpoolDir();
    } catch {
        return { pending, discarded };
    }

    // 1) 状態記録を走査
    let entries = [];
    try {
        entries = await fsp.readdir(spool);
    } catch {
        entries = [];
    }
    const known = new Set();

    for (const f of entries) {
        if (f.endsWith('.json.writing')) {
            // 書き換え途中で落ちた残骸
            await unlinkQuiet(path.join(spool, f));
            continue;
        }
        if (!f.endsWith('.json')) continue;

        const p = path.join(spool, f);
        let job;
        try {
            job = JSON.parse(await fsp.readFile(p, 'utf8'));
            if (!job || typeof job.rel !== 'string' || !job.rel || typeof job.tmpFile !== 'string') {
                throw new Error('bad state record');
            }
        } catch {
            await unlinkQuiet(p);
            discarded++;
            continue;
        }

        job.done = Array.isArray(job.done) ? job.done : [];
        job.attempts = Number(job.attempts) || 0;
        known.add(path.basename(job.tmpFile));

        try {
            await fsp.access(job.tmpFile);
        } catch {
            // 実体が無い。全保存先が完了していれば正常終了直後の記録漏れ、
            // そうでなければ実体を失っているのでどちらも回収できない。
            await unlinkQuiet(p);
            discarded++;
            continue;
        }
        pending.push(job);
    }

    // 2) 状態記録を持たない実体（受信途中で落ちたもの）を破棄
    try {
        for (const f of await fsp.readdir(tmp)) {
            if (!f.endsWith('.part') || known.has(f)) continue;
            await unlinkQuiet(path.join(tmp, f));
            discarded++;
        }
    } catch { /* 無視 */ }

    return { pending, discarded };
}

// ================= 旧 JSON/base64 経路 =================

async function saveBuffer(buf, { rel }) {
    const paths = [];
    const failed = [];
    for (const root of SAVE_ROOTS) {
        let tmp;
        try {
            const dest = resolveIn(root, rel);
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            tmp = tmpPathFor(dest);
            await fsp.writeFile(tmp, buf, { flag: 'wx' });
            await fsp.rename(tmp, dest);
            paths.push(dest);
        } catch (e) {
            if (tmp) await unlinkQuiet(tmp);
            failed.push({ root, error: (e && e.message) || String(e) });
        }
    }
    return { bytes: buf.length, paths, failed };
}

module.exports = {
    SAVE_ROOTS,
    ensureTmpDir,
    ensureSpoolDir,
    tmpDir,
    spoolDir,
    checkSaveRoots,
    sameDevice,
    isRamBacked,
    hasFreeSpace,
    ALLOWED_EXT,
    extFromMime,
    normalizeExt,
    isMediaMime,
    receiveToTmp,
    finalize,
    abandon,
    recoverJobs,
    saveBuffer,
};
