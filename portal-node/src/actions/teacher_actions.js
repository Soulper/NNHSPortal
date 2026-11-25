// ================================================================
// TEACHER POST ACTIONS (port of the teacher half of includes/actions.php)
// ================================================================
// handle(req, res, action) -> true when the action was handled + responded,
// false when unknown (the dashboard dispatcher then redirects to /dashboard.php
// exactly like the PHP fallthrough).
//
// CSRF is checked first, exactly like actions.php. Uploaded files arrive via
// multer (memory storage) at req.files; save_upload() decides disk vs blob.
// ================================================================
const crypto = require('crypto');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

const { client, get, run, all, cluster_subjects } = require('../db');
const {
    current_user_id, csrf_ok, flash, audit,
    teacher_owns_class, notify, notify_class_students, today,
} = require('../config');
const {
    class_terms, class_term_progress, class_roster, term_grade_stamps,
    class_grade_averages, save_term_grades,
} = require('../grade-engine');
const { save_upload, read_stored } = require('../storage');

// ---------------------------------------------------------------
// LOCAL HELPERS
// ---------------------------------------------------------------

// Find one multer file among req.files by field name (PHP: $_FILES['name']).
function find_file(req, fieldname) {
    if (!req.files || !Array.isArray(req.files)) return null;
    return req.files.find((f) => f.fieldname === fieldname) || null;
}

// PHP (float) cast: leading-numeric prefix, everything else -> 0.
function to_float(v, def = 0) {
    const s = v === undefined || v === null ? String(def) : String(v);
    const n = parseFloat(s);
    return Number.isNaN(n) ? 0 : n;
}

function is_plain_object(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------
// LOCAL HELPER: rebuild the {sid: value} grade/stamp maps from a POST.
// ---------------------------------------------------------------
// PHP reads $_POST['grade'][sid] / $_POST['stamp'][sid]. Express's default
// urlencoded parser (qs, as configured by body-parser's extended mode) turns
// those bracket fields into a compacted ARRAY when every bracket index is a
// number at or under its array limit: `grade[5]=87&grade[9]=` arrives as
// ["87",""] and the student-id keys are gone (with mixed/over-limit indices
// qs keeps the object keys, which passes through untouched below).
//
// The keys are recovered by zipping the surviving values with the roster in
// student-id ascending order: the grid renders class_roster() rows and posts
// one grade[sid] + stamp[sid] per row, so after compaction the values are
// ordered by sid. The stamps travelled through the same compaction, so every
// recovered pair is verified against the stored row stamp: a non-empty stamp
// mismatch is a normal engine conflict (save_term_grades skips it), but an
// empty stamp on a student who already has a stored row means the pairing
// cannot be trusted (the roster moved), and saving could erase another
// student's grade - so the whole batch is refused instead.
// Returns { grades, stamps } or null when the pairing cannot be trusted.
async function expand_grade_maps(req, class_id, term_id) {
    let g = req.body.grade;
    let st = req.body.stamp;

    if (g === undefined || g === null || (typeof g !== 'object' && typeof g !== 'string')) {
        // PHP: not an array -> []. Nothing to save.
        return { grades: {}, stamps: {} };
    }
    if (st === undefined || st === null || (typeof st !== 'object' && typeof st !== 'string')) {
        st = [];
    }

    // Already keyed by student id (JSON-shaped body, over-arrayLimit ids, or
    // a parser that preserves bracket keys) - use exactly as received.
    if (is_plain_object(g)) {
        return { grades: g, stamps: is_plain_object(st) ? st : {} };
    }
    if (!Array.isArray(g) || !Array.isArray(st)) return null;
    if (g.length !== st.length) return null;
    if (g.length === 0) return { grades: {}, stamps: {} };

    const roster = await class_roster(client, class_id); // grid order
    if (g.length !== roster.length) return null; // roster changed -> refuse

    const by_sid = roster
        .map((s) => Number(s.user_id))
        .sort((a, b) => a - b); // compaction orders values by ascending index (= sid)

    const stored = await term_grade_stamps(client, class_id, term_id, by_sid);
    const grades = {};
    const stamps = {};
    for (let i = 0; i < by_sid.length; i++) {
        const sid = by_sid[i];
        const sent = String(st[i] ?? '');
        const cur = String((stored[sid] && stored[sid].stamp) ?? '');
        if (sent !== cur && sent === '') return null; // unverifiable pairing -> refuse
        grades[sid] = g[i];
        stamps[sid] = st[i];
    }
    return { grades, stamps };
}

// Flatten an ExcelJS cell to the scalar PHP's toArray() would give.
function cell_value(cell) {
    const v = cell.value;
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
    if (typeof v === 'object') {
        if (v.richText) return v.richText.map((t) => t.text).join('');
        if (v.text !== undefined) return String(v.text); // hyperlink
        if (v.formula || v.sharedFormula) return v.result !== undefined ? v.result : '';
        if (v.error !== undefined) return v.error;
        return '';
    }
    return v;
}

// $sheet->toArray() equivalent: 0-indexed rows of plain values, every row
// padded to the sheet's widest row (the worksheet-dimensions behaviour).
function sheet_to_array(ws) {
    const rows = [];
    let max_cols = 0;
    ws.eachRow({ includeEmpty: true }, (row, row_number) => {
        const vals = [];
        for (let c = 1; c <= row.cellCount; c++) vals.push(cell_value(row.getCell(c)));
        rows[row_number - 1] = vals;
        if (vals.length > max_cols) max_cols = vals.length;
    });
    for (let i = 0; i < rows.length; i++) {
        if (!rows[i]) rows[i] = [];
        while (rows[i].length < max_cols) rows[i].push('');
    }
    return rows;
}

function cell_text(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return String(v);
    if (typeof v === 'object') {
        if (v.richText) return v.richText.map((t) => t.text).join('');
        if (v.text !== undefined) return String(v.text);
        if (v.result !== undefined) return String(v.result);
        return '';
    }
    return String(v);
}

// Approximates PhpSpreadsheet's setAutoSize(true): ExcelJS stores an explicit
// width, so measure the longest cell per column like the PHP writer did.
function autosize_columns(ws, letters, last_row) {
    for (const letter of letters) {
        let max = 0;
        for (let r = 1; r <= last_row; r++) {
            const len = cell_text(ws.getCell(letter + r).value).length;
            if (len > max) max = len;
        }
        ws.getColumn(letter).width = Math.max(1, max + 1);
    }
}

// ================================================================
// DISPATCHER (port of handle_post_actions' teacher half)
// ================================================================
async function handle(req, res, action) {
    const uid = current_user_id(req);

    // -- CSRF PROTECTION (checked first, exactly like actions.php) --
    if (!csrf_ok(req)) {
        flash(req, 'Your session expired. Please try again.', 'danger');
        res.redirect('/dashboard.php');
        return true;
    }

    // ================= TEACHER ACTIONS =================

    // DOWNLOAD ALL SUBMISSIONS (ZIP) - streams a file, so handled before the redirect flow
    if (action === 'download_all_submissions') {
        const assignment_id = Number(req.body.assignment_id || 0);
        const a = await get('SELECT a.id, a.title, a.class_id FROM assignments a WHERE a.id=?', [assignment_id]);
        if (!a || !(await teacher_owns_class(client, uid, Number(a.class_id)))) {
            flash(req, 'Unauthorized.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        const rows = await all(
            "SELECT sub.file_url, sub.original_name, s.full_name, sub.is_late FROM submissions sub JOIN students s ON s.user_id = sub.student_id WHERE sub.assignment_id=? AND sub.file_url IS NOT NULL AND sub.file_url != '' ORDER BY s.full_name",
            [assignment_id]);
        if (!rows.length) {
            flash(req, 'No submitted files to download.', 'danger');
            res.redirect('/dashboard.php?page=submissions&id=' + assignment_id);
            return true;
        }
        const zip_name_raw = String(a.title ?? '').replace(/[^A-Za-z0-9 _-]/g, '');
        const zip_name = zip_name_raw.trim() !== '' ? zip_name_raw : 'assignment_' + assignment_id;

        const zip = new JSZip();
        let added = 0;
        for (const r of rows) {
            const buf = await read_stored(r.file_url);
            if (!buf) continue;
            const orig = (r.original_name !== '' && r.original_name !== null && r.original_name !== undefined)
                ? r.original_name : r.file_url;
            const extMatch = String(orig).match(/\.([A-Za-z0-9]+)$/);
            const ext = extMatch ? extMatch[1].toLowerCase() : '';
            let safe = String(orig).replace(/[^A-Za-z0-9_.\- ]+/g, '_');
            if (safe === '') safe = 'submission';
            if (ext === '' && !safe.includes('.')) safe += '.file';
            zip.file(String(r.full_name) + (Number(r.is_late) ? ' (LATE)' : '') + ' - ' + safe, buf);
            added++;
        }
        if (added === 0) {
            flash(req, 'No readable files found to download.', 'danger');
            res.redirect('/dashboard.php?page=submissions&id=' + assignment_id);
            return true;
        }
        const buf = await zip.generateAsync({ type: 'nodebuffer' });
        res.set({
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="' + zip_name + '_submissions.zip"',
            'Content-Length': String(buf.length),
            'Cache-Control': 'private, no-store',
        });
        res.send(buf);
        return true;
    }

    // CREATE CLASS
    if (action === 'create_class') {
        const subject = String(req.body.subject ?? '').trim();
        const section = String(req.body.section ?? '').trim();
        const school_year = String(req.body.school_year ?? '').trim();
        const description = String(req.body.description ?? '').trim();
        const year_id = Number(req.body.academic_year_id || 0);
        const join_code = crypto.randomBytes(4).toString('hex').slice(0, 8).toUpperCase();

        let first_term = 0;
        if (year_id) {
            const t = await get('SELECT id FROM terms WHERE academic_year_id=? ORDER BY number LIMIT 1', [year_id]);
            first_term = t ? Number(t.id) : 0;
        }
        const ins = await run(
            'INSERT INTO classes (teacher_id, subject, section, school_year, description, join_code, academic_year_id, current_term_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [uid, subject, section, school_year, description, join_code, year_id || null, first_term || null]);
        const cid = Number(ins.lastId);

        await audit(client, req, 'create_class', 'classes', cid, null, `${subject} - ${section}`);
        flash(req, 'Class created successfully! Join code: ' + join_code);
        res.redirect('/dashboard.php');
        return true;
    }

    // UPDATE CLASS
    if (action === 'update_class') {
        const class_id = Number(req.body.class_id || 0);
        await run(
            'UPDATE classes SET subject=?, section=?, school_year=?, description=? WHERE id=? AND teacher_id=?',
            [req.body.subject, req.body.section, req.body.school_year, req.body.description, class_id, uid]);
        await audit(client, req, 'update_class', 'classes', class_id, null, 'subject');
        flash(req, 'Class updated.');
        res.redirect('/dashboard.php?page=settings&id=' + class_id);
        return true;
    }

    // ARCHIVE / RESTORE / DELETE CLASS
    if (action === 'archive_class') {
        const class_id = Number(req.body.class_id || 0);
        await run("UPDATE classes SET status='archived' WHERE id=? AND teacher_id=?", [class_id, uid]);
        await audit(client, req, 'archive_class', 'classes', class_id);
        flash(req, 'Class archived.');
        res.redirect('/dashboard.php');
        return true;
    }
    if (action === 'restore_class') {
        const class_id = Number(req.body.class_id || 0);
        await run("UPDATE classes SET status='active' WHERE id=? AND teacher_id=?", [class_id, uid]);
        flash(req, 'Class restored.');
        res.redirect('/dashboard.php');
        return true;
    }
    if (action === 'delete_class') {
        const class_id = Number(req.body.class_id || 0);
        await run('DELETE FROM classes WHERE id=? AND teacher_id=?', [class_id, uid]);
        await audit(client, req, 'delete_class', 'classes', class_id);
        flash(req, 'Class deleted.');
        res.redirect('/dashboard.php');
        return true;
    }

    // JOIN CODE
    if (action === 'disable_join') {
        const class_id = Number(req.body.class_id || 0);
        await run('UPDATE classes SET join_code=NULL WHERE id=? AND teacher_id=?', [class_id, uid]);
        flash(req, 'Join code disabled.');
        res.redirect('/dashboard.php?page=settings&id=' + class_id);
        return true;
    }
    if (action === 'new_code') {
        const class_id = Number(req.body.class_id || 0);
        const code = crypto.randomBytes(4).toString('hex').slice(0, 8).toUpperCase();
        await run('UPDATE classes SET join_code=? WHERE id=? AND teacher_id=?', [code, class_id, uid]);
        flash(req, 'New join code: ' + code);
        res.redirect('/dashboard.php?page=settings&id=' + class_id);
        return true;
    }

    // SET TERM CLUSTER TAG (gradebook header picker)
    // Labels the CURRENT term's grades with a cluster + subject. Stored
    // per class+term in term_clusters; the classes table is not touched.
    if (action === 'set_term_cluster') {
        const class_id = Number(req.body.class_id || 0);
        const term_id = Number(req.body.term_id || 0);
        if (!(await teacher_owns_class(client, uid, class_id))) {
            flash(req, 'Unauthorized.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        const own = await get(
            'SELECT COUNT(*) AS n FROM terms t JOIN classes c ON c.academic_year_id=t.academic_year_id WHERE t.id=? AND c.id=? AND c.teacher_id=?',
            [term_id, class_id, uid]);
        if (!term_id || Number(own.n) === 0) {
            flash(req, 'No term selected.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }

        const subject = String(req.body.cluster_subject ?? '').trim();
        let cluster = null;
        const subjects = cluster_subjects();
        for (const cl of Object.keys(subjects)) {
            if (subjects[cl].includes(subject)) { cluster = cl; break; }
        }
        if (subject === '' || cluster === null) {
            flash(req, 'Pick a subject from the list.', 'danger');
            res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
            return true;
        }
        await run(
            `INSERT INTO term_clusters (class_id, term_id, cluster, subject) VALUES (?, ?, ?, ?)
             ON CONFLICT(class_id, term_id) DO UPDATE SET cluster=excluded.cluster, subject=excluded.subject`,
            [class_id, term_id, cluster, subject]);
        await audit(client, req, 'set_term_cluster', 'classes', class_id, null, `${subject} (${cluster}), term ${term_id}`);
        flash(req, `${subject} (${cluster}) set for this term's grades.`);
        res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
        return true;
    }

    // SET CURRENT TERM
    if (action === 'set_term') {
        const class_id = Number(req.body.class_id || 0);
        if (!(await teacher_owns_class(client, uid, class_id))) {
            flash(req, 'Unauthorized.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        const term_id = Number(req.body.term_id || 0);
        await run('UPDATE classes SET current_term_id=? WHERE id=? AND teacher_id=?', [term_id || null, class_id, uid]);
        await audit(client, req, 'set_term', 'classes', class_id, null, String(term_id));
        flash(req, 'Active term updated.');
        res.redirect(`/dashboard.php?page=grades&id=${class_id}`);
        return true;
    }

    // SAVE TERM GRADES (no-JS fallback; JS autosave posts to grades_api.php)
    if (action === 'save_term_grades') {
        const class_id = Number(req.body.class_id || 0);
        const term_id = Number(req.body.term_id || 0);
        if (!(await teacher_owns_class(client, uid, class_id))) {
            flash(req, 'Unauthorized.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        if (!term_id) {
            flash(req, 'No term selected.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }

        const maps = await expand_grade_maps(req, class_id, term_id);
        if (maps === null) {
            flash(req, 'The class roster changed while the gradebook was open. Reload the page and try again.', 'danger');
            res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
            return true;
        }

        const [ok, err, res_] = await save_term_grades(client, class_id, term_id, maps.grades, maps.stamps, uid);
        if (!ok) {
            flash(req, err, 'danger');
            res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
            return true;
        }

        const n = res_.saved.length;
        if (res_.conflicts.length) {
            flash(req,
                `${n} grade(s) saved. ${res_.conflicts.length} row(s) changed elsewhere and were NOT overwritten - reload to see the current values.`,
                'warning');
        } else {
            flash(req, n ? `${n} grade(s) saved.` : 'No changes to save.');
        }
        await audit(client, req, 'save_term_grades', 'classes', class_id, null, `${n} grade(s), term ${term_id}`);
        res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
        return true;
    }

    // PUBLISH / UNPUBLISH TERM
    if (action === 'publish_term') {
        const class_id = Number(req.body.class_id || 0);
        if (!(await teacher_owns_class(client, uid, class_id))) {
            flash(req, 'Unauthorized.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        const term_id = Number(req.body.term_id || 0);
        if (!term_id) {
            flash(req, 'No term selected.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }

        // The gate is enforced here, not just hidden in the UI: a term is
        // only released once every enrolled student has a real grade, so a
        // student can never see a half-filled class average.
        const progress = await class_term_progress(client, class_id, term_id);
        if (Number(progress.total) === 0) {
            flash(req, 'Cannot release: this class has no students.', 'danger');
            res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
            return true;
        }
        if (!progress.complete) {
            flash(req,
                `Cannot release yet: ${progress.ungraded} of ${progress.total} student(s) still need a Term Grade.`,
                'warning');
            res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
            return true;
        }

        await run('INSERT OR IGNORE INTO class_term_status (class_id, term_id) VALUES (?, ?)', [class_id, term_id]);
        await audit(client, req, 'publish_term', 'classes', class_id, null, `term ${term_id}`);
        await notify_class_students(client, class_id, 'Term grades have been released.', 'dashboard.php?page=report_card');
        flash(req, 'Term released. Students can now see these grades.');
        res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
        return true;
    }

    if (action === 'unpublish_term') {
        const class_id = Number(req.body.class_id || 0);
        if (!(await teacher_owns_class(client, uid, class_id))) {
            flash(req, 'Unauthorized.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        const term_id = Number(req.body.term_id || 0);
        await run('DELETE FROM class_term_status WHERE class_id=? AND term_id=?', [class_id, term_id]);
        await audit(client, req, 'unpublish_term', 'classes', class_id, null, `term ${term_id}`);
        flash(req, 'Term withdrawn. Students can no longer see these grades.');
        res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
        return true;
    }

    // CREATE ASSIGNMENT
    if (action === 'create_assignment') {
        const class_id = Number(req.body.class_id || 0);
        if (!(await teacher_owns_class(client, uid, class_id))) {
            flash(req, 'Unauthorized.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        const title = String(req.body.title ?? '').trim();
        const description = String(req.body.description ?? '').trim();
        const due_date = String(req.body.due_date ?? '');
        const requires_file = req.body.requires_file !== undefined ? 1 : 0;
        const allowed_exts = String(req.body.allowed_exts ?? '').trim().toLowerCase().replace(/\s+/g, '');
        const max_size_mb = Math.max(0.1, Math.min(25, to_float(req.body.max_size_mb ?? 10)));
        const allow_late = req.body.allow_late !== undefined ? 1 : 0;
        const cutoff_date = String(req.body.cutoff_date ?? '').trim() || null;
        if (!allow_late && cutoff_date && due_date && cutoff_date < due_date) {
            flash(req, 'Cutoff date must be on or after the due date.', 'danger');
            res.redirect(`/dashboard.php?page=class&id=${class_id}`);
            return true;
        }
        const up = await save_upload(find_file(req, 'attachment'), 'assign_' + class_id);
        if (up.error) {
            flash(req, up.error, 'danger');
            res.redirect(`/dashboard.php?page=class&id=${class_id}`);
            return true;
        }
        const attachment = up.file;
        await run(
            'INSERT INTO assignments (class_id, title, description, due_date, attachment, requires_file, allowed_exts, max_size_mb, allow_late, cutoff_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [class_id, title, description, due_date, attachment, requires_file, allowed_exts !== '' ? allowed_exts : null, max_size_mb, allow_late, cutoff_date]);
        await notify_class_students(client, class_id, `New assignment: ${title}`, 'dashboard.php?page=assignments');
        flash(req, 'Assignment created.');
        res.redirect(`/dashboard.php?page=class&id=${class_id}`);
        return true;
    }

    // GRADE SUBMISSION
    if (action === 'grade_submission') {
        const sub_id = Number(req.body.submission_id || 0);
        const score = to_float(req.body.score ?? 0);
        const feedback = String(req.body.feedback ?? '').trim();
        const info_c = await get(
            'SELECT a.id AS assignment_id, a.class_id FROM submissions s JOIN assignments a ON s.assignment_id=a.id WHERE s.id=?',
            [sub_id]);
        if (!info_c || !(await teacher_owns_class(client, uid, Number(info_c.class_id)))) {
            flash(req, 'Unauthorized.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        await run('UPDATE submissions SET score=?, feedback=? WHERE id=?', [score, feedback, sub_id]);
        const info = await get(
            'SELECT s.student_id, a.title FROM submissions s JOIN assignments a ON s.assignment_id = a.id WHERE s.id=?',
            [sub_id]);
        if (info) {
            await notify(client, Number(info.student_id), `Assignment graded: ${info.title}`, 'dashboard.php?page=grades', 'grade');
        }
        await audit(client, req, 'grade_submission', 'submissions', sub_id, null, String(score));
        flash(req, 'Submission graded.');
        res.redirect('/dashboard.php?page=submissions&id=' + Number(info_c.assignment_id));
        return true;
    }

    // MARK ATTENDANCE (notify only on new records)
    if (action === 'mark_attendance') {
        const class_id = Number(req.body.class_id || 0);
        if (!(await teacher_owns_class(client, uid, class_id))) {
            flash(req, 'Unauthorized.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        const date = String(req.body.date || today());
        let student_ids = req.body['student_id'];
        if (student_ids === undefined || student_ids === null || student_ids === '') student_ids = [];
        if (!Array.isArray(student_ids)) student_ids = [student_ids];
        const subj = await get('SELECT subject FROM classes WHERE id=?', [class_id]);
        const subject_name = subj ? subj.subject : '';
        let new_records = 0;
        for (const sidRaw of student_ids) {
            const sid = String(sidRaw);
            let status = req.body['status_' + sid] ?? 'absent';
            if (!['present', 'late', 'absent', 'excused'].includes(status)) status = 'absent';
            const existing = await get(
                'SELECT COUNT(*) AS n FROM attendance WHERE class_id=? AND student_id=? AND date=?',
                [class_id, sid, date]);
            if (Number(existing.n) > 0) {
                await run('UPDATE attendance SET status=? WHERE class_id=? AND student_id=? AND date=?', [status, class_id, sid, date]);
            } else {
                await run('INSERT INTO attendance (class_id, student_id, date, status) VALUES (?, ?, ?, ?)', [class_id, sid, date, status]);
                new_records++;
            }
        }
        if (new_records > 0) {
            await notify_class_students(client, class_id, `Attendance recorded for ${subject_name}`, 'dashboard.php?page=attendance', 'attendance');
        }
        await audit(client, req, 'mark_attendance', 'classes', class_id, null, `${date} (${new_records} new)`);
        flash(req, 'Attendance recorded.');
        res.redirect(`/dashboard.php?page=attendance&id=${class_id}`);
        return true;
    }

    // CREATE ANNOUNCEMENT
    if (action === 'create_announcement') {
        const class_id = Number(req.body.class_id || 0);
        if (!(await teacher_owns_class(client, uid, class_id))) {
            flash(req, 'Unauthorized.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        const title = String(req.body.title ?? '').trim();
        const content = String(req.body.content ?? '').trim();
        const up = await save_upload(find_file(req, 'attachment'), 'ann_' + class_id);
        if (up.error) {
            flash(req, up.error, 'danger');
            res.redirect(`/dashboard.php?page=class&id=${class_id}`);
            return true;
        }
        const attachment = up.file;
        await run('INSERT INTO announcements (class_id, title, content, attachment) VALUES (?, ?, ?, ?)',
            [class_id, title, content, attachment]);
        const subj_name = await get('SELECT subject FROM classes WHERE id=?', [class_id]);
        const sub = subj_name ? subj_name.subject : '';
        await notify_class_students(client, class_id, `New announcement in ${sub}: ${title}`, `dashboard.php?page=class&id=${class_id}`, 'announcement');
        flash(req, 'Announcement posted.');
        res.redirect(`/dashboard.php?page=class&id=${class_id}`);
        return true;
    }

    // REMOVE STUDENT
    if (action === 'remove_student') {
        const class_id = Number(req.body.class_id || 0);
        if (!(await teacher_owns_class(client, uid, class_id))) {
            flash(req, 'Unauthorized.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        const student_id = Number(req.body.student_id || 0);
        await run('DELETE FROM class_members WHERE class_id=? AND student_id=?', [class_id, student_id]);
        await audit(client, req, 'remove_student', 'classes', class_id, null, 'student ' + student_id);
        flash(req, 'Student removed.');
        res.redirect(`/dashboard.php?page=class&id=${class_id}`);
        return true;
    }

    // EXPORT XLSX - one Term Grade column per student.
    // Columns are matched by header name on import, so a teacher can add,
    // remove or reorder their own helper columns without breaking it.
    if (action === 'export_xlsx') {
        const class_id = Number(req.body.class_id || 0);
        let term_id = Number(req.body.term_id || 0);
        const cinfo = await get('SELECT subject, section, school_year FROM classes WHERE id=? AND teacher_id=?', [class_id, uid]);
        if (!cinfo) {
            flash(req, 'Class not found.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }

        const terms = await class_terms(client, class_id);
        let term_label = 'Term';
        if (!term_id && terms.length) term_id = Number(terms[0].id);
        for (const t of terms) {
            if (Number(t.id) === Number(term_id)) term_label = t.label;
        }

        const roster = await class_roster(client, class_id);
        const rows = await term_grade_stamps(client, class_id, term_id);

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Term Grades');

        ws.getCell('A1').value = 'Student No.';
        ws.getCell('B1').value = 'Student Name';
        ws.getCell('C1').value = 'Term Grade';
        ws.getCell('D1').value = 'Descriptor';
        ws.getCell('E1').value = 'Result';

        let rowNum = 2;
        for (const s of roster) {
            const sid = Number(s.user_id);
            const r = rows[sid] || null;
            const g = r ? r.grade : null;
            ws.getCell('A' + rowNum).value = s.student_number;
            ws.getCell('B' + rowNum).value = s.full_name;
            ws.getCell('C' + rowNum).value = (g === null || g === undefined) ? '' : Number(g);
            ws.getCell('D' + rowNum).value = r ? r.descriptor : '';
            ws.getCell('E' + rowNum).value = (r && g !== null && g !== undefined) ? (r.passed ? 'Passed' : 'Failed') : 'Not graded';
            rowNum++;
        }

        const avg = class_grade_averages(rows);
        ws.getCell('B' + rowNum).value = 'Class average';
        ws.getCell('C' + rowNum).value = (avg.tg === null || avg.tg === undefined) ? '' : Number(avg.tg);
        ws.getCell('E' + rowNum).value = avg.n + ' graded';

        ws.getRow(1).font = { bold: true };
        autosize_columns(ws, ['A', 'B', 'C', 'D', 'E'], rowNum);
        for (let r = 2; r <= rowNum; r++) ws.getCell('C' + r).numFmt = '0.00';

        const safe = String(`${cinfo.subject}_${cinfo.section}_${term_label}`).replace(/[^A-Za-z0-9_-]+/g, '_');
        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': 'attachment; filename="term_grades_' + safe + '.xlsx"',
        });
        res.send(buf);
        return true;
    }

    // IMPORT XLSX - reads the "Term Grade" column, matching each row to a
    // student by Student No. first and full name second.
    if (action === 'import_xlsx') {
        const class_id = Number(req.body.class_id || 0);
        const term_id = Number(req.body.term_id || 0);
        if (!(await teacher_owns_class(client, uid, class_id))) {
            flash(req, 'Unauthorized.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        if (!term_id) {
            flash(req, 'No term selected.', 'danger');
            res.redirect('/dashboard.php');
            return true;
        }
        const file = find_file(req, 'xlsx_file');
        if (!file) {
            flash(req, 'Please upload a valid XLSX file.', 'danger');
            res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
            return true;
        }
        let allRows;
        try {
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(file.buffer);
            allRows = sheet_to_array(wb.worksheets[0]);
        } catch (e) {
            flash(req, 'Invalid XLSX file.', 'danger');
            res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
            return true;
        }
        if (allRows.length < 2) {
            flash(req, 'File has no data.', 'danger');
            res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
            return true;
        }

        // Locate the columns by header name, case-insensitively.
        const headers = allRows[0].map((h) => String(h ?? '').trim().toLowerCase());
        const idx = {};
        headers.forEach((h, i) => {
            if (h === 'student no.' || h === 'student no' || h === 'student number') idx.no = i;
            else if (h === 'student name' || h === 'name') idx.name = i;
            else if (h === 'term grade' || h === 'grade') idx.grade = i;
        });
        if (idx.grade === undefined || (idx.no === undefined && idx.name === undefined)) {
            flash(req, 'Could not find the required columns. The file needs a "Term Grade" column and a "Student No." or "Student Name" column.', 'danger');
            res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
            return true;
        }

        const roster = {};
        for (const s of await class_roster(client, class_id)) roster[Number(s.user_id)] = s;

        const changes = {};
        let matched = 0;
        let unmatched = 0;
        let blank = 0;
        for (let r = 1; r < allRows.length; r++) {
            const row = allRows[r];
            let sid = 0;
            if (idx.no !== undefined) {
                const no = String(row[idx.no] ?? '').trim();
                if (no !== '') {
                    for (const id of Object.keys(roster)) {
                        if (String(roster[id].student_number).toLowerCase() === no.toLowerCase()) { sid = Number(id); break; }
                    }
                }
            }
            if (!sid && idx.name !== undefined) {
                const nm = String(row[idx.name] ?? '').trim();
                if (nm !== '') {
                    for (const id of Object.keys(roster)) {
                        if (String(roster[id].full_name).toLowerCase() === nm.toLowerCase()) { sid = Number(id); break; }
                    }
                }
            }
            if (!sid) {
                if (String(row[idx.grade] ?? '').trim() !== '') unmatched++;
                continue;
            }

            const raw = row[idx.grade] ?? '';
            if (raw === '' || raw === null || raw === undefined) { blank++; continue; }
            changes[sid] = raw;
            matched++;
        }

        if (Object.keys(changes).length === 0) {
            flash(req, 'No grades found in the file.', 'warning');
            res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
            return true;
        }

        const [ok, err, res_] = await save_term_grades(client, class_id, term_id, changes, [], uid);
        if (!ok) {
            flash(req, 'Import failed - ' + err, 'danger');
            res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
            return true;
        }

        const saved = res_.saved.length;
        const parts = [`${saved} grade(s) imported`];
        if (unmatched) parts.push(`${unmatched} row(s) did not match a student on the roster and were skipped`);
        if (blank) parts.push(`${blank} blank cell(s) left unchanged`);
        flash(req, parts.join('. ') + '.', unmatched ? 'warning' : 'success');
        await audit(client, req, 'import_xlsx', 'classes', class_id, null, `${saved} grade(s)`);
        res.redirect(`/dashboard.php?page=grades&id=${class_id}&term=${term_id}`);
        return true;
    }

    // UPDATE PROFILE (teacher)
    if (action === 'update_profile') {
        const office_hours = String(req.body.office_hours ?? '').trim();
        const contact_email = String(req.body.contact_email ?? '').trim();
        const up = await save_upload(find_file(req, 'photo'), 'teacher_' + uid, ['jpg', 'jpeg', 'png', 'gif', 'webp']);
        if (up.error) {
            flash(req, up.error, 'danger');
            res.redirect('/dashboard.php?page=profile');
            return true;
        }
        if (up.file) {
            await run('UPDATE teachers SET profile_photo=? WHERE user_id=?', [up.file, uid]);
        }
        await run('UPDATE teachers SET office_hours=?, contact_email=? WHERE user_id=?', [office_hours, contact_email, uid]);
        flash(req, 'Profile updated.');
        res.redirect('/dashboard.php?page=profile');
        return true;
    }

    // No action matched
    return false;
}

module.exports = { handle };
