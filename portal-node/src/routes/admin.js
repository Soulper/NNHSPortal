// ================================================================
// ADMIN ROUTER (port of admin.php + includes/admin.php)
// ================================================================
// GET  /admin.php?page=...  → page renderers (src/views/admin/*.ejs)
// POST /admin.php           → handle_admin_post(): same ?page= values, same
//                             POST action names, same checks (CSRF first),
//                             same flash messages, same redirects.
// All routes sit behind require_admin (admin.php's require_admin()).
// ================================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const { all, get, run, client } = require('../db');
const {
    require_admin, current_user_id, is_admin_user, current_role,
    csrf_ok, flash, audit, setting, set_setting, today,
} = require('../config');
const { PASSING_MARK, TERM_GRADE_MIN, TERM_GRADE_MAX } = require('../grade-engine');
const { save_upload } = require('../storage');

const router = express.Router();

// Assignment/announcement-style uploads arrive multipart. Memory storage:
// save_upload() decides where the bytes go (disk or Vercel Blob). Files are
// picked from req.files by fieldname and passed to save_upload() — the admin
// panel's own actions carry no file fields in the PHP original, so nothing
// consumes req.files today; the middleware is mounted so any future file
// action behaves exactly like the dashboard's.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });

// ---- navbar identity chip (admin.php computes these inline) ----
function chip(req) {
    const name = (req.session && req.session.full_name) || 'Administrator';
    const parts = String(name).replace(/[^A-Za-z ]/g, '').trim().split(/\s+/).filter(Boolean);
    const chip_ini = (((parts[0] || 'A')[0] || 'A') + (parts[1] ? parts[1][0] : '')).toUpperCase();
    return { chip_name: name, chip_ini };
}

// Shared render payload: shell partial data (navbar active state, identity
// chip, school name for the footer) plus the admin page title.
function page_ctx(ctx, slug, data = {}) {
    return {
        admin_page: slug,
        chip_name: ctx.chip_name,
        chip_ini: ctx.chip_ini,
        school_name: ctx.school_name,
        title: 'Admin Panel — ' + ctx.school_name,
        ...data,
    };
}

// PHP's (int) cast: non-numeric input becomes 0, decimals truncate toward
// zero. (Number() alone would yield NaN, which libsql refuses to bind.)
function php_int(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// PHP's (float) cast: non-numeric input becomes 0, never NaN.
function php_float(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

// ================================================================
// POST DISPATCH (port of includes/admin.php handle_admin_post)
// ================================================================
// Every branch ends in a redirect exactly like the PHP (which exit()s).
async function handle_admin_post(req, res) {
    const action = (req.body && req.body.action) || '';
    if (!csrf_ok(req)) {
        flash(req, 'Your session expired. Please try again.', 'danger');
        return res.redirect('/admin.php');
    }

    // ---- USERS ----
    if (action === 'user_toggle_admin') {
        const uid = php_int(req.body && req.body.user_id);
        if (uid === current_user_id(req)) {
            flash(req, 'You cannot change your own admin status.', 'danger');
        } else {
            const row = await get('SELECT is_admin FROM users WHERE id=?', [uid]);
            const cur = row ? Number(row.is_admin) : 0;
            await run('UPDATE users SET is_admin=? WHERE id=?', [cur ? 0 : 1, uid]);
            await audit(client, req, 'toggle_admin', 'users', uid, String(cur), cur ? '0' : '1');
            flash(req, 'Admin status updated.');
        }
        return res.redirect('/admin.php?page=users');
    }

    if (action === 'user_toggle_status') {
        const uid = php_int(req.body && req.body.user_id);
        if (uid === current_user_id(req)) {
            flash(req, 'You cannot disable your own account.', 'danger');
        } else {
            const row = await get('SELECT status FROM users WHERE id=?', [uid]);
            const cur = row ? String(row.status) : '';
            const nw = cur === 'active' ? 'disabled' : 'active';
            await run('UPDATE users SET status=? WHERE id=?', [nw, uid]);
            await audit(client, req, 'toggle_status', 'users', uid, cur, nw);
            flash(req, 'User status updated.');
        }
        return res.redirect('/admin.php?page=users');
    }

    if (action === 'user_reset_password') {
        const uid = php_int(req.body && req.body.user_id);
        const newpass = String((req.body && req.body.new_password) || '');
        if (newpass.length < 8) {
            flash(req, 'Password must be at least 8 characters.', 'danger');
        } else {
            await run('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(newpass, 10), uid]);
            await audit(client, req, 'reset_password', 'users', uid, null, 'password reset');
            flash(req, 'Password reset.');
        }
        return res.redirect('/admin.php?page=users');
    }

    // ---- ACADEMIC YEARS & TERMS ----
    if (action === 'add_year') {
        const label = String((req.body && req.body.label) || '').trim();
        if (!label) {
            flash(req, 'Year label required.', 'danger');
        } else {
            const r = await run('INSERT INTO academic_years (label, start_date, end_date, is_active) VALUES (?,?,?,0)',
                [label, (req.body && req.body.start_date) || null, (req.body && req.body.end_date) || null]);
            await audit(client, req, 'add_year', 'academic_years', Number(r.lastId), null, label);
            flash(req, 'Academic year added.');
        }
        return res.redirect('/admin.php?page=years');
    }

    if (action === 'set_active_year') {
        const yid = php_int(req.body && req.body.year_id);
        await run('UPDATE academic_years SET is_active=0');
        await run('UPDATE academic_years SET is_active=1 WHERE id=?', [yid]);
        await set_setting(client, 'active_academic_year_id', String(yid));
        await audit(client, req, 'set_active_year', 'academic_years', yid);
        flash(req, 'Active academic year updated.');
        return res.redirect('/admin.php?page=years');
    }

    if (action === 'add_term') {
        const yid = php_int(req.body && req.body.year_id);
        const label = String((req.body && req.body.label) || '').trim();
        if (!label) {
            flash(req, 'Term label required.', 'danger');
        } else {
            const nx = await get('SELECT COALESCE(MAX(number),0)+1 AS n FROM terms WHERE academic_year_id=?', [yid]);
            const num = Number(nx.n);
            const weight = php_float((req.body && req.body.weight) ?? 1);
            const r = await run(
                "INSERT INTO terms (academic_year_id, number, label, start_date, end_date, weight, status) VALUES (?,?,?,?,?,?, 'open')",
                [yid, num, label, (req.body && req.body.start_date) || null, (req.body && req.body.end_date) || null, weight]);
            await audit(client, req, 'add_term', 'terms', Number(r.lastId), null, label);
            flash(req, 'Term added.');
        }
        return res.redirect('/admin.php?page=years');
    }

    if (action === 'toggle_term_status') {
        const tid = php_int(req.body && req.body.term_id);
        const row = await get('SELECT status FROM terms WHERE id=?', [tid]);
        const cur = row ? String(row.status) : '';
        const nw = cur === 'open' ? 'closed' : 'open';
        await run('UPDATE terms SET status=? WHERE id=?', [nw, tid]);
        await audit(client, req, 'toggle_term_status', 'terms', tid, cur, nw);
        flash(req, 'Term status updated.');
        return res.redirect('/admin.php?page=years');
    }

    // ---- DESCRIPTORS ----
    // The DO 015 reporting scale. Policies, component weights and
    // transmutation tables are gone; these five bands are the only
    // configurable grading data left, because they are what a typed grade is
    // *labelled* with everywhere it appears.
    if (action === 'descriptor_save') {
        const raw = (req.body && req.body.desc) || null;
        if (raw && typeof raw === 'object') {
            // PHP sees $_POST['desc'] as a map of row id -> band. Express's
            // extended urlencoded parser (qs) compacts numeric keys into an
            // ARRAY sorted ascending by key and drops the ids, so the form's
            // desc[1]..desc[5] arrives at indexes 0..4. The scale editor posts
            // every row and nothing else ever inserts or deletes descriptor
            // rows, so an array maps back onto the row ids in ascending
            // order; a plain object (e.g. non-numeric keys) already carries
            // the ids as keys, like PHP's associative array.
            let rows = raw;
            if (Array.isArray(raw)) {
                const ids = (await all('SELECT id FROM descriptor_rows ORDER BY id')).map((r) => Number(r.id));
                rows = {};
                raw.forEach((d, i) => {
                    if (d !== null && d !== undefined) rows[i < ids.length ? ids[i] : i] = d;
                });
            }
            for (const [rid, d] of Object.entries(rows)) {
                if (!d || typeof d !== 'object') continue;
                const min = php_float(d.min ?? 0);
                const max = php_float(d.max ?? 0);
                if (max < min) continue; // reject an inverted band
                await run('UPDATE descriptor_rows SET label_en=?, label_fil=?, min_grade=?, max_grade=? WHERE id=?',
                    [String(d.label_en ?? '').trim(), String(d.label_fil ?? '').trim(), min, max, php_int(rid)]);
            }
            await audit(client, req, 'save_descriptors', 'descriptor_rows');
            flash(req, 'Grading scale saved.');
        }
        return res.redirect('/admin.php?page=policies');
    }

    // ---- CALENDAR ----
    if (action === 'add_event') {
        const title = String((req.body && req.body.title) || '').trim();
        const date = (req.body && req.body.event_date) || '';
        if (!title || !date) {
            flash(req, 'Title and date are required.', 'danger');
        } else {
            const r = await run(
                'INSERT INTO calendar_events (title, event_date, end_date, event_type, term_id, description, created_by) VALUES (?,?,?,?,?,?,?)',
                [title, date, (req.body && req.body.end_date) || null, (req.body && req.body.event_type) || 'event',
                 php_int(req.body && req.body.term_id) || null, (req.body && req.body.description) || '',
                 current_user_id(req)]);
            await audit(client, req, 'add_event', 'calendar_events', Number(r.lastId), null, title);
            flash(req, 'Event added.');
        }
        return res.redirect('/admin.php?page=calendar');
    }

    if (action === 'delete_event') {
        const eid = php_int(req.body && req.body.event_id);
        await run('DELETE FROM calendar_events WHERE id=?', [eid]);
        await audit(client, req, 'delete_event', 'calendar_events', eid);
        flash(req, 'Event deleted.');
        return res.redirect('/admin.php?page=calendar');
    }

    // ---- SCHOOL ANNOUNCEMENTS ----
    if (action === 'add_school_ann') {
        const title = String((req.body && req.body.title) || '').trim();
        const content = String((req.body && req.body.content) || '').trim();
        const audience = ['all', 'students', 'teachers'].includes(req.body && req.body.audience)
            ? req.body.audience : 'all';
        if (!title || !content) {
            flash(req, 'Title and content are required.', 'danger');
        } else {
            const r = await run('INSERT INTO school_announcements (title, content, audience, posted_by) VALUES (?,?,?,?)',
                [title, content, audience, current_user_id(req)]);
            await audit(client, req, 'add_school_ann', 'school_announcements', Number(r.lastId), null, title);
            flash(req, 'School announcement posted.');
        }
        return res.redirect('/admin.php?page=announcements');
    }

    if (action === 'delete_school_ann') {
        const aid = php_int(req.body && req.body.ann_id);
        await run('DELETE FROM school_announcements WHERE id=?', [aid]);
        await audit(client, req, 'delete_school_ann', 'school_announcements', aid);
        flash(req, 'Announcement deleted.');
        return res.redirect('/admin.php?page=announcements');
    }

    // ---- ADVISERS ----
    // Designate (or revoke) the advisory class for a section. Setting one
    // clears any other advisory class for the same section + school year, so
    // every section has at most one adviser.
    if (action === 'toggle_advisory') {
        const class_id = php_int(req.body && req.body.class_id);
        const c = await get(
            `SELECT c.section, c.academic_year_id, t.full_name, ay.label AS year_label
             FROM classes c
             LEFT JOIN teachers t ON t.user_id=c.teacher_id
             LEFT JOIN academic_years ay ON ay.id=c.academic_year_id
             WHERE c.id=?`, [class_id]);
        if (!c) {
            flash(req, 'Class not found.', 'danger');
            return res.redirect('/admin.php?page=advisers');
        }
        const now = await get('SELECT is_advisory FROM classes WHERE id=?', [class_id]);
        const nw = Number(now && now.is_advisory) ? 0 : 1;
        if (nw) {
            await run('UPDATE classes SET is_advisory=0 WHERE section=? AND academic_year_id=? AND id!=?',
                [c.section, c.academic_year_id, class_id]);
        }
        await run('UPDATE classes SET is_advisory=? WHERE id=?', [nw, class_id]);
        await audit(client, req, 'toggle_advisory', 'classes', class_id, null,
            nw ? 'adviser: ' + (c.full_name ?? '') : 'revoked');
        flash(req, nw
            ? (c.full_name !== ''
                ? (c.full_name ?? '') + ' is now the adviser of ' + (c.section ?? '') + ' (' + (c.year_label ?? '') + ').'
                : 'Class set as advisory.')
            : 'Advisory designation removed.');
        return res.redirect('/admin.php?page=advisers');
    }

    // ---- SETTINGS ----
    if (action === 'save_settings') {
        await set_setting(client, 'school_name', String((req.body && req.body.school_name) ?? 'School Portal').trim());
        await set_setting(client, 'registration_mode',
            ['open', 'approval'].includes(req.body && req.body.registration_mode) ? req.body.registration_mode : 'open');
        await audit(client, req, 'save_settings');
        flash(req, 'Settings saved.');
        return res.redirect('/admin.php?page=settings');
    }

    return res.redirect('/admin.php');
}

// ================================================================
// PAGES
// ================================================================

// ---- admin_overview() ----
async function admin_overview(req, res, ctx) {
    const teachers = Number((await get("SELECT COUNT(*) AS n FROM users WHERE role='teacher' AND status='active'")).n);
    const students = Number((await get("SELECT COUNT(*) AS n FROM users WHERE role='student' AND status='active'")).n);
    const classes = Number((await get("SELECT COUNT(*) AS n FROM classes WHERE status='active'")).n);
    const graded = Number((await get('SELECT COUNT(*) AS n FROM term_grades WHERE grade IS NOT NULL')).n);
    const events = Number((await get("SELECT COUNT(*) AS n FROM calendar_events WHERE event_date >= date('now')")).n);
    const unverified = Number((await get("SELECT COUNT(*) AS n FROM users WHERE status='pending'")).n);

    const evs = await all(
        "SELECT * FROM calendar_events WHERE event_date BETWEEN date('now') AND date('now','+30 days') ORDER BY event_date LIMIT 8");
    const logs = await all(
        'SELECT al.*, u.email FROM audit_logs al LEFT JOIN users u ON u.id=al.user_id ORDER BY al.id DESC LIMIT 8');

    res.render('admin/overview', page_ctx(ctx, 'overview', { teachers, students, classes, graded, events, unverified, evs, logs }));
}

// ---- admin_users() ----
async function admin_users(req, res, ctx) {
    const role_filter = String((req.query && req.query.role) ?? 'all');
    // PHP interpolated $db->quote($role_filter) here; a bound parameter is the
    // same query shape with the escaping done properly.
    const where = role_filter !== 'all' ? 'WHERE role=?' : '';
    const list = await all(
        'SELECT u.*, COALESCE(t.full_name, s.full_name) AS full_name, COALESCE(t.employee_number, s.student_number) AS number '
        + 'FROM users u LEFT JOIN teachers t ON t.user_id=u.id LEFT JOIN students s ON s.user_id=u.id '
        + where + ' ORDER BY u.id',
        role_filter !== 'all' ? [role_filter] : []);
    res.render('admin/users', page_ctx(ctx, 'users', { role_filter, list }));
}

// ---- admin_advisers() ----
// Adviser designations: which class is the advisory class per section for a
// school year. Its teacher is the section adviser and the only one who can
// generate SF9 report cards for those students.
async function admin_advisers(req, res, ctx) {
    const year_id = Number(await setting(client, 'active_academic_year_id', '')) || 0;

    let year_label = '';
    if (year_id) {
        const yl = await get('SELECT label FROM academic_years WHERE id=?', [year_id]);
        year_label = yl ? String(yl.label ?? '') : '';
    }

    const years = await all('SELECT id, label FROM academic_years ORDER BY start_date DESC');
    if (!years.length) {
        return res.render('admin/advisers', page_ctx(ctx, 'advisers', { years, year_id, year_label, sections: [] }));
    }

    const rows = await all(
        `SELECT c.id, c.subject, c.section, c.is_advisory, t.full_name AS teacher,
                (SELECT COUNT(*) FROM class_members cm WHERE cm.class_id=c.id) AS students
         FROM classes c LEFT JOIN teachers t ON t.user_id=c.teacher_id
         WHERE c.academic_year_id=? AND c.status='active'
         ORDER BY c.section, c.subject`, [year_id]);
    if (!rows.length) {
        return res.render('admin/advisers', page_ctx(ctx, 'advisers', { years, year_id, year_label, sections: [] }));
    }

    // Group by section so the advisory choice reads clearly. Map keeps the
    // ORDER BY section order, like PHP's insertion-ordered array.
    const by_section = new Map();
    for (const r of rows) {
        const sec = r.section == null ? '' : String(r.section);
        if (!by_section.has(sec)) by_section.set(sec, []);
        by_section.get(sec).push(r);
    }
    const sections = [...by_section.entries()].map(([section, cls]) => ({
        section,
        classes: cls,
        has_adviser: cls.some((r) => !!Number(r.is_advisory)),
    }));

    res.render('admin/advisers', page_ctx(ctx, 'advisers', { years, year_id, year_label, sections }));
}

// ---- admin_years() ----
async function admin_years(req, res, ctx) {
    const years = (await all('SELECT * FROM academic_years ORDER BY start_date DESC')).map((y) => ({ ...y }));
    for (const y of years) {
        y.terms = await all('SELECT * FROM terms WHERE academic_year_id=? ORDER BY number', [y.id]);
    }
    res.render('admin/years', page_ctx(ctx, 'years', { years }));
}

// ---- admin_policies() ----
// Grading scale editor. Grades are typed directly by teachers; these five
// DO 015 bands are what decide the descriptor word a grade is labelled with,
// on the teacher's grid and on the student's report card alike.
async function admin_policies(req, res, ctx) {
    const rows = await all('SELECT * FROM descriptor_rows ORDER BY min_grade DESC');

    const chkRow = await get(
        `SELECT COUNT(*) AS n FROM (
            SELECT CASE WHEN max_grade >= min_grade THEN 1 ELSE 0 END AS ok, COUNT(*) AS n
            FROM descriptor_rows GROUP BY min_grade, max_grade
        ) WHERE ok = 0`);
    const chk = Number(chkRow.n);

    let overlaps = 0;
    const s = await all('SELECT min_grade, max_grade FROM descriptor_rows ORDER BY min_grade');
    let prevMax = null;
    for (const b of s) {
        if (prevMax !== null && Number(b.min_grade) <= prevMax) overlaps++;
        prevMax = Number(b.max_grade);
    }

    res.render('admin/policies', page_ctx(ctx, 'policies', {
        rows, chk, overlaps,
        tg_min: Math.trunc(TERM_GRADE_MIN),
        tg_max: Math.trunc(TERM_GRADE_MAX),
        passing: Math.trunc(PASSING_MARK),
    }));
}

// PHP: date('Y-m-t', strtotime($month . '-01')) — the last day of the month.
// An unparseable month lands on the epoch (strtotime() false → 1970-01-31).
function php_month_end(start) {
    const m = /^(\d{4})-(\d{1,2})-01$/.exec(String(start));
    if (m) {
        const y = Number(m[1]);
        const mo = Number(m[2]);
        if (mo >= 1 && mo <= 12) {
            const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
            return y + '-' + String(mo).padStart(2, '0') + '-' + String(last).padStart(2, '0');
        }
    }
    return '1970-01-31';
}

// ---- admin_calendar() ----
async function admin_calendar(req, res, ctx) {
    const terms = await all(
        'SELECT t.*, y.label AS yl FROM terms t JOIN academic_years y ON y.id=t.academic_year_id ORDER BY t.academic_year_id DESC, t.number');

    const month = String((req.query && req.query.month) ?? today().slice(0, 7));
    const start = month + '-01';
    const end = php_month_end(start);

    const evs = await all('SELECT * FROM calendar_events WHERE event_date BETWEEN ? AND ? ORDER BY event_date', [start, end]);

    res.render('admin/calendar', page_ctx(ctx, 'calendar', { terms, month, evs }));
}

// ---- admin_announcements() ----
async function admin_announcements(req, res, ctx) {
    const list = await all('SELECT sa.*, u.email FROM school_announcements sa LEFT JOIN users u ON u.id=sa.posted_by ORDER BY sa.id DESC');
    res.render('admin/announcements', page_ctx(ctx, 'announcements', { list }));
}

// ---- admin_audit() ----
async function admin_audit(req, res, ctx) {
    // PHP: min(500, max(20, (int)($_GET['limit'] ?? 100)))
    const raw = (req.query && req.query.limit !== undefined) ? req.query.limit : 100;
    const n = parseInt(raw, 10);
    const limit = Math.min(500, Math.max(20, Number.isFinite(n) ? n : 0));
    const rows = await all(
        'SELECT al.*, u.email FROM audit_logs al LEFT JOIN users u ON u.id=al.user_id ORDER BY al.id DESC LIMIT ?',
        [limit]);
    res.render('admin/audit', page_ctx(ctx, 'audit', { rows }));
}

// ---- admin_settings() ----
async function admin_settings(req, res, ctx) {
    const registration_mode = await setting(client, 'registration_mode', 'open');
    res.render('admin/settings', page_ctx(ctx, 'settings', { school_name: ctx.school_name, registration_mode }));
}

// ================================================================
// DISPATCH (admin.php)
// ================================================================
router.get('/admin.php', require_admin, async (req, res, next) => {
    try {
        const page = (req.query && req.query.page) || 'overview';
        const school_name = await setting(client, 'school_name', 'School Portal');
        const ctx = { school_name, ...chip(req) };

        switch (page) {
            case 'users': return await admin_users(req, res, ctx);
            case 'advisers': return await admin_advisers(req, res, ctx);
            case 'years': return await admin_years(req, res, ctx);
            case 'policies': return await admin_policies(req, res, ctx);
            case 'calendar': return await admin_calendar(req, res, ctx);
            case 'announcements': return await admin_announcements(req, res, ctx);
            case 'audit': return await admin_audit(req, res, ctx);
            case 'settings': return await admin_settings(req, res, ctx);
            default: return await admin_overview(req, res, ctx);
        }
    } catch (e) { next(e); }
});

router.post('/admin.php', require_admin, upload.any(), async (req, res, next) => {
    try {
        await handle_admin_post(req, res);
    } catch (e) { next(e); }
});

module.exports = router;
