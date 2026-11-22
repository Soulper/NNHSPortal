// ================================================================
// FILE UPLOAD + DOWNLOAD STORAGE (port of config.php handle_upload)
// ================================================================
// PHP wrote uploads to a local folder. On Vercel there is no writable disk,
// so production uploads go to Vercel Blob (when BLOB_READ_WRITE_TOKEN is
// set) and local development keeps writing to data/uploads/. Either way the
// database stores an opaque key that download.php authorises before serving.
// ================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx',
    'ppt', 'pptx', 'txt', 'csv', 'zip', 'rar', '7z'];

// The serverless request body caps uploads near 4.5MB; the PHP default was 10.
const MAX_SIZE_MB = Number(process.env.UPLOAD_MAX_MB || (process.env.VERCEL ? 4 : 10));

function upload_dir() {
    const dir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function is_blob_configured() {
    return !!process.env.BLOB_READ_WRITE_TOKEN;
}

// ---------------------------------------------------------------
// MIME SNIFF (best-effort, like PHP's finfo; a mismatch is rejected
// for types we can recognise, and unknown binaries pass as octet-stream)
// ---------------------------------------------------------------
function sniff_mime(buf) {
    if (!buf || buf.length < 4) return '';
    const b = buf;
    const startsWith = (...bytes) => bytes.every((v, i) => b[i] === v);
    if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
    if (b.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
    if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (b.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
    if (startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06)) return 'application/zip';
    if (b.slice(0, 6).toString('binary') === '7z\xBC\xAF\x27\x1C') return 'application/x-7z-compressed';
    if (startsWith(0x52, 0x61, 0x72, 0x21)) return 'application/x-rar-compressed';
    // Likely plain text (txt/csv): every byte printable or common whitespace.
    let printable = 0;
    const n = Math.min(b.length, 512);
    for (let i = 0; i < n; i++) {
        const c = b[i];
        if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) printable++;
    }
    if (printable / n > 0.95) return 'text/plain';
    return 'application/octet-stream';
}

const OK_MIMES = {
    'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/gif': ['gif'],
    'image/webp': ['webp'], 'application/pdf': ['pdf'],
    'text/plain': ['txt'], 'text/csv': ['csv'],
    'application/zip': ['zip'], 'application/x-7z-compressed': ['7z'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
    'application/msword': ['doc'], 'application/vnd.ms-excel': ['xls'], 'application/vnd.ms-powerpoint': ['ppt'],
    'application/x-rar-compressed': ['rar'], 'application/vnd.rar': ['rar'],
    'application/octet-stream': ['doc', 'xls', 'ppt', 'rar', 'zip'],
};

// multer memory storage gives us {originalname, buffer, size}.
// Returns { file, error } exactly like the PHP helper: file '' + error '' means
// "no file uploaded", file '' + error '...' means "upload rejected".
async function save_upload(file, prefix, allowed_exts = null, max_size_mb = MAX_SIZE_MB) {
    if (allowed_exts === null) allowed_exts = DEFAULT_EXTS.slice();
    if (!file || !file.originalname || file.size === 0) {
        return { file: '', error: '' };
    }
    if (file.size > max_size_mb * 1048576) {
        return { file: '', error: 'File too large (max ' + max_size_mb + 'MB).' };
    }
    const ext = path.extname(file.originalname).replace('.', '').toLowerCase();
    if (ext === '' || !allowed_exts.includes(ext)) {
        return { file: '', error: 'File type not allowed: ' + (ext ? '.' + ext : 'unknown') };
    }
    // MIME sniff (best-effort; a mismatch is rejected for known signatures)
    const mime = sniff_mime(file.buffer);
    if (OK_MIMES[mime]) {
        if (!OK_MIMES[mime].includes(ext) && mime !== 'application/octet-stream') {
            return { file: '', error: 'File content does not match its extension.' };
        }
    }
    const name = prefix + '_' + crypto.randomBytes(8).toString('hex') + '.' + ext;

    if (is_blob_configured()) {
        // Vercel Blob. The returned URL is unguessable and stored in the DB;
        // download.php still authorises every request before redirecting.
        try {
            const { put } = require('@vercel/blob');
            const { url } = await put(name, file.buffer, { access: 'public', addRandomSuffix: false });
            return { file: url, error: '' };
        } catch (e) {
            return { file: '', error: 'Could not save the uploaded file.' };
        }
    }
    fs.writeFileSync(path.join(upload_dir(), name), file.buffer);
    return { file: name, error: '' };
}

// Read a stored file back into memory (for ZIP bundling / download streaming).
// Returns a Buffer or null.
async function read_stored(file_key) {
    if (!file_key) return null;
    if (/^https?:\/\//i.test(file_key)) {
        try {
            const res = await fetch(file_key);
            if (!res.ok) return null;
            return Buffer.from(await res.arrayBuffer());
        } catch (_) {
            return null;
        }
    }
    const p = path.join(upload_dir(), path.basename(file_key));
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
}

module.exports = { save_upload, read_stored, upload_dir, sniff_mime, DEFAULT_EXTS, MAX_SIZE_MB };
