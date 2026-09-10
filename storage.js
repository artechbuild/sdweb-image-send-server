// storage.js
// 保存処理の共通モジュール。
//
// バイナリ転送は2段構え:
//   1) 受信フェーズ  receiveToTmp() … リクエストボディを一時領域(TMP_PATH)へ直接ストリーム書き込み
//   2) 確定フェーズ  finalize()     … 副保存先へコピーし、最終パスへ rename して一時ファイルを消す
// 送信側は 1) が終わった時点で解放され、2) はサーバ側のキューで順次処理される。
// 確定が終われば TMP_PATH には何も残らない（rename で移動、別FSならコピー後に削除）。
'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

// 保存先（カンマ区切りで複数指定可能）。1番目が主保存先。
const SAVE_ROOTS = (process.env.SAVE_ROOTS || '/tmp')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// ================= 一時領域 (TMP_PATH) =================
// 受信中のファイルを一旦置く場所。SAVE_ROOTS とは役割を分けている。
//   - SAVE_ROOTS : 最終的な保存先（カンマ区切りで複数）
//   - TMP_PATH   : 受信中の作業領域（1箇所）
// TMP_PATH が SAVE_ROOTS[0] と同じファイルシステム上にあると、確定フェーズが
// rename だけで済むので速い。別FSの場合はコピーになる（動作はする）。
function tmpCandidates() {
    const list = [];
    const explicit = (process.env.TMP_PATH || process.env.SPOOL_DIR || '').trim();
    if (explicit) list.push(explicit);
    // 既定は OS の一時領域
    list.push(path.join(os.tmpdir(), 'sdweb-image-send'));
    // どうしても書けない場合の最後の砦（保存先の配下を借りる）
    list.push(path.join(SAVE_ROOTS[0], '.tmp'));
    return [...new Set(list)];
}

let _tmpDir = null;        // 検証済みの一時領域
let _tmpPromise = null;    // 同時アクセスでの重複初期化を防ぐ

// mkdir だけでは足りない（作れても書けないことがある）ので、実際にファイルを書いて消す
async function probeWritable(dir) {
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${Math.random().toString(16).slice(2)}`);
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
}

/**
 * 一時領域を確定する。候補を順に試し、最初に書けたものを採用する。
 * 一度成功したら記憶する。失敗した場合は次回呼び出しで再挑戦するので、
 * 権限を直せばサーバを再起動せずに復旧する。
 */
async function ensureTmpDir() {
    if (_tmpDir) return _tmpDir;
    if (_tmpPromise) return _tmpPromise;

    _tmpPromise = (async () => {
        const errors = [];
        for (const dir of tmpCandidates()) {
            try {
                await probeWritable(dir);
                _tmpDir = dir;
                return dir;
            } catch (e) {
                errors.push(`${dir}: ${e && e.code ? e.code : ''} ${e && e.message}`);
            }
        }
        const err = new Error('no writable temp directory. tried:\n  ' + errors.join('\n  '));
        err.code = 'E_NO_TMP';
        throw err;
    })();

    try {
        return await _tmpPromise;
    } finally {
        _tmpPromise = null;
    }
}

function tmpDir() {
    return _tmpDir;
}

// tmpfs / ramfs のマジックナンバー（Linux）。ここに大きな動画を置くとRAMを消費する。
const RAM_FS_TYPES = new Set([0x01021994, 0x858458f6]);

/** 同じファイルシステム上か（デバイス番号で判定するので文字列比較より正確） */
async function sameDevice(a, b) {
    try {
        const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
        return sa.dev === sb.dev;
    } catch {
        return null; // 判定できず
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

// ---- 空き容量チェック ----
// statfs は Node 18.15+ / 19.6+。使えない環境では常に true（チェックしない）。
async function hasFreeSpace(root, needBytes) {
    if (!needBytes || typeof fsp.statfs !== 'function') return true;
    try {
        await fsp.mkdir(root, { recursive: true });
        const st = await fsp.statfs(root);
        return st.bsize * st.bavail >= needBytes;
    } catch {
        return true; // 判定できないときは通す
    }
}

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

// ================= 受信フェーズ =================

/**
 * 読み取りストリームを一時領域(TMP_PATH)へ直接書き込む。
 * メモリ使用量は転送サイズに依存せず、ストリームのバッファ分のみ。
 * 併せて、クラッシュ後に確定できるようメタ情報を .json サイドカーに残す。
 *
 * @returns {Promise<{tmpFile:string, metaPath:string, bytes:number}>}
 */
async function receiveToTmp(readable, { rel, maxBytes = 0 }) {
    const dir = await ensureTmpDir();
    const id = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const tmpFile = path.join(dir, `${id}.part`);
    const metaPath = path.join(dir, `${id}.json`);
    const state = { bytes: 0 };

    try {
        await pipeline(
            readable,
            byteCounter(state, maxBytes),
            fs.createWriteStream(tmpFile, { flags: 'wx' })
        );
        // 本体が揃ってからメタを書く。メタがあれば「本体は完成済み」と判断できる。
        await fsp.writeFile(metaPath, JSON.stringify({ rel, bytes: state.bytes, receivedAt: new Date().toISOString() }));
    } catch (e) {
        await unlinkQuiet(tmpFile);
        await unlinkQuiet(metaPath);
        throw e;
    }
    return { tmpFile, metaPath, bytes: state.bytes };
}

// ================= 確定フェーズ =================

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
 * 一時領域のファイルを最終パスへ確定する。ここはキュー経由で直列に呼ばれる想定。
 *
 * 順序が重要:
 *   1) 副保存先へコピー（コピー元は一時ファイル）
 *   2) 主保存先へ rename（同一FSなら即時。別FSならコピーにフォールバック）
 *   3) メタを削除
 * この順なら、どこで異常終了しても「一時ファイル＋メタが残っている = まだ未完了」が保たれ、
 * 次回起動時の回収でやり直せる。逆順（主保存先を先に rename）にすると、
 * 副保存先のコピー中に落ちたとき一時ファイルが消えていて回収できない。
 */
async function finalize({ tmpFile, metaPath, rel }) {
    const primary = resolveIn(SAVE_ROOTS[0], rel);
    await fsp.mkdir(path.dirname(primary), { recursive: true });

    // 1) 副保存先（失敗しても主保存先は続行する）
    const paths = [];
    const failed = [];
    for (const root of SAVE_ROOTS.slice(1)) {
        try {
            paths.push(await copyToRoot(tmpFile, root, rel));
        } catch (e) {
            failed.push({ root, error: (e && e.message) || String(e) });
        }
    }

    // 2) 主保存先
    try {
        await fsp.rename(tmpFile, primary);
    } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        // 一時領域が主保存先と別ファイルシステムにある場合
        const tmp = tmpPathFor(primary);
        try {
            await fsp.copyFile(tmpFile, tmp);
            await fsp.rename(tmp, primary);
        } catch (e2) {
            await unlinkQuiet(tmp);
            throw e2;
        }
        await unlinkQuiet(tmpFile);
    }
    paths.unshift(primary);

    // 3) ここまで来れば完了。メタを消して回収対象から外す。
    if (metaPath) await unlinkQuiet(metaPath);
    return { paths, failed };
}

/**
 * 起動時に一時領域の残骸を回収する。
 * メタ付き(=受信完了済み)は確定対象として返し、本体だけ / メタだけの残骸は破棄する。
 */
async function recoverTmp() {
    const pending = [];
    let discarded = 0;
    let dir, entries;
    try {
        dir = await ensureTmpDir();
        entries = await fsp.readdir(dir);
    } catch {
        return { pending, discarded };
    }

    const parts = new Set(entries.filter(f => f.endsWith('.part')).map(f => f.slice(0, -5)));
    const metas = new Set(entries.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)));

    for (const id of metas) {
        const metaPath = path.join(dir, `${id}.json`);
        const tmpFile = path.join(dir, `${id}.part`);
        if (!parts.has(id)) { await unlinkQuiet(metaPath); discarded++; continue; }
        try {
            const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
            if (!meta || typeof meta.rel !== 'string' || !meta.rel) throw new Error('bad meta');
            pending.push({ tmpFile, metaPath, rel: meta.rel, bytes: Number(meta.bytes) || 0 });
        } catch {
            await unlinkQuiet(metaPath);
            await unlinkQuiet(tmpFile);
            discarded++;
        }
    }
    // 受信途中で落ちた本体（メタが無い）は宛先不明なので破棄
    for (const id of parts) {
        if (!metas.has(id)) { await unlinkQuiet(path.join(dir, `${id}.part`)); discarded++; }
    }
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
    tmpDir,
    ensureTmpDir,
    checkSaveRoots,
    sameDevice,
    isRamBacked,
    ALLOWED_EXT,
    extFromMime,
    normalizeExt,
    isMediaMime,
    hasFreeSpace,
    receiveToTmp,
    finalize,
    recoverTmp,
    saveBuffer,
};
