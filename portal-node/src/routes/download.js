// ================================================================
// AUTHENTICATED FILE DOWNLOAD (port of download.php)
// ================================================================
// Replaces direct uploads/ URLs. Validates that the requester owns or is
// related to the file before a single byte is served.
//
// Storage note: keys that start with http(s) are Vercel Blob URLs (written by
// save_upload() in production); everything else is a random file name under
// the local upload dir. Both are read back with read_stored(). The PHP
// original only knew local files, so the path-traversal guard is applied to
// non-URL keys only — a URL cannot traverse the upload dir.
// ================================================================
const path = require('path');
const express = require('express');

const { get, client } = require('../db');
const {
    require_login, current_user_id, is_admin_user,
    teacher_owns_class, student_in_class,
} = require('../config');
const { read_stored, stored_exists } = require('../storage');

const router = express.Router();

router.get('/download.php', require_login, async (req, res) => {
    const file = String((req.query && req.query.f) ?? '');
    if (file === '') {
        res.status(400).send('No file specified.');
        return;
    }

    // Only the stored random name may be requested (no path traversal).
    // Blob URLs are opaque keys in the database and cannot traverse a path.
    const is_url = /^https?:\/\//i.test(file);
    if (!is_url && path.basename(file) !== file) {
        res.status(400).send('Invalid file name.');
        return;
    }

    // PHP checked the local file before the access rules (404 beats 403 for a
    // missing local file). URL keys (Vercel Blob) cannot be probed without
    // fetching them, so for those the 404 comes after the access checks
    // instead; stored_exists() answers true for them.
    if (!is_url && !(await stored_exists(file))) {
        res.status(404).send('File not found.');
        return;
    }

    const uid = current_user_id(req);
    const is_admin = is_admin_user(req);

    // ---- Access checks ----
    let allowed = false;

    // 1. Submission file: the student who submitted, or the class teacher
    const sub = await get(
        'SELECT s.student_id, a.class_id FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.file_url = ?',
        [file]);
    if (sub) {
        allowed = Number(sub.student_id) === uid || (await teacher_owns_class(client, uid, sub.class_id));
    }

    // 2. Assignment attachment: enrolled students or class teacher
    if (!allowed) {
        const a = await get('SELECT a.class_id FROM assignments a WHERE a.attachment = ?', [file]);
        if (a) {
            allowed = (await student_in_class(client, uid, a.class_id)) || (await teacher_owns_class(client, uid, a.class_id));
        }
    }

    // 3. Announcement attachment: enrolled students or class teacher
    if (!allowed) {
        const a = await get('SELECT a.class_id FROM announcements a WHERE a.attachment = ?', [file]);
        if (a) {
            allowed = (await student_in_class(client, uid, a.class_id)) || (await teacher_owns_class(client, uid, a.class_id));
        }
    }

    // 4. Profile photo: the owner or any admin
    if (!allowed) {
        const t = await get('SELECT user_id FROM teachers WHERE profile_photo = ?', [file]);
        const s = await get('SELECT user_id FROM students WHERE profile_photo = ?', [file]);
        const owner = t ? Number(t.user_id) : (s ? Number(s.user_id) : null);
        if (owner !== null && (owner === uid || is_admin)) {
            allowed = true;
        }
    }

    // 5. Admins can fetch anything
    if (!allowed && is_admin) {
        allowed = true;
    }

    if (!allowed) {
        res.status(403).send('You do not have permission to access this file.');
        return;
    }

    // ---- Serve ----
    const buf = await read_stored(file);
    if (!buf) {
        res.status(404).send('File not found.');
        return;
    }

    const ext_source = is_url ? file.replace(/[?#].*$/, '') : file;
    const ext = path.extname(ext_source).replace('.', '').toLowerCase();
    const mime_map = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
        doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        zip: 'application/zip', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
    };
    const mime = mime_map[ext] || 'application/octet-stream';

    // setHeader (not res.set): Express's res.set appends "; charset=utf-8" to
    // text/* types, but PHP sent the bare header ('Content-Type: text/plain').
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline; filename="' + file + '"');
    res.send(buf);
});

module.exports = router;
