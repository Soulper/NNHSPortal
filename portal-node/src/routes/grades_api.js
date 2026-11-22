// ================================================================
// TERM GRADE LIVE ENDPOINT (port of grades_api.php)
// ================================================================
// POST /grades_api.php
//
// Accepts the dirty cells of the gradebook, validates + writes them, and
// returns each student's updated grade, descriptor and row stamp plus the
// refreshed progress so the browser can patch the grid in place.
//
// All grade rules stay in grade-engine.js - this file only moves data.
// Auth: teacher session + CSRF header + class ownership. Errors keep the
// PHP JSON shape {ok:false, error} with status 400/403/405/413/419.
// ================================================================
const express = require('express');
const { client } = require('../db');
const {
    current_role, current_user_id, csrf_ok, audit, teacher_owns_class,
} = require('../config');
const {
    save_term_grades, term_grade_row, class_term_progress,
} = require('../grade-engine');

const router = express.Router();

// router.all + an explicit method check so a GET keeps the PHP 405 JSON
// instead of the Express 404 HTML.
router.all('/grades_api.php', async (req, res) => {
    // Headers, exactly like the top of grades_api.php.
    res.set({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
    });
    const out = (payload, code = 200) => {
        res.status(code);
        res.json(payload);
    };

    if (current_role(req) !== 'teacher') {
        return out({ ok: false, error: 'Teacher access only.' }, 403);
    }
    if (!csrf_ok(req)) {
        return out({ ok: false, error: 'Session expired. Reload the page.' }, 419);
    }
    if (req.method !== 'POST') {
        return out({ ok: false, error: 'POST required.' }, 405);
    }

    const input = req.body;
    if (!is_object(input)) return out({ ok: false, error: 'Invalid request body.' }, 400);

    const class_id = Number(input.class_id || 0);
    const term_id = Number(input.term_id || 0);
    let changes = input.changes ?? null;
    let stamps = input.stamps ?? [];

    if (!class_id || !term_id) return out({ ok: false, error: 'Missing class or term.' }, 400);
    if (!is_object(changes) || Object.keys(changes).length === 0) {
        return out({ ok: false, error: 'No changes to save.' }, 400);
    }
    if (!(await teacher_owns_class(client, current_user_id(req), class_id))) {
        return out({ ok: false, error: 'Unauthorized.' }, 403);
    }

    // Guard against a runaway client posting the entire gradebook in one go.
    if (Object.keys(changes).length > 2000) {
        return out({ ok: false, error: 'Too many cells in one request.' }, 413);
    }

    if (stamps === null || typeof stamps !== 'object') stamps = [];

    const [ok, err, result] = await save_term_grades(client, class_id, term_id, changes, stamps, current_user_id(req));
    if (!ok) return out({ ok: false, error: err }, 400);

    // Return the row for every student we actually wrote, so the client can
    // apply the descriptor and the pass/fail colouring without re-rendering.
    const rows = {};
    for (const sid of Object.keys(result.stamps)) {
        rows[String(sid)] = await term_grade_row(client, class_id, Number(sid), term_id, result.stamps[sid]);
    }

    // A conflict means another session wrote this student first. Report it
    // separately from a validation error: the cell is still stale on screen
    // and the teacher needs to decide, so it is not an HTTP error.
    if (result.conflicts.length) {
        for (const sid of result.conflicts) {
            rows[String(sid)] = await term_grade_row(client, class_id, Number(sid), term_id, null);
        }
    }

    // Audit on a coarse cadence - one row per class per minute instead of one
    // per keystroke - so autosave does not flood the audit log.
    const now = Math.floor(Date.now() / 1000);
    const last = Number((req.session && req.session.gb_audit_at) || 0);
    if (result.saved.length && (now - last) >= 60) {
        await audit(client, req, 'term_grade_autosave', 'classes', class_id, null,
            `${result.saved.length} grade(s), term ${term_id}`);
        if (req.session) req.session.gb_audit_at = now;
    }

    out({
        ok: true,
        saved: result.saved,
        conflicts: result.conflicts,
        rows,
        progress: await class_term_progress(client, class_id, term_id),
    });
});

function is_object(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

module.exports = router;
