// ================================================================
// TEACHER PAGE RENDERERS (port of includes/teacher.php)
// ================================================================
// One async renderer per PHP function. Each computes the same data the PHP
// function computed and renders a full shell via the partials:
//   app_head + navbar (with page/unread/chip_role/chip_ini) + flash + footer
// so src/views/teacher/*.ejs only restate the page markup.
// ================================================================
const { client, all, get } = require('../db');
const { cluster_subjects } = require('../db');
const {
    current_user_id, current_role, is_admin_user, esc, today,
} = require('../config');
const {
    class_term_progress, class_terms, class_is_published, class_roster,
    term_grade_stamps, class_grade_averages, descriptor_rows_all,
    PASSING_MARK,
} = require('../grade-engine');

// ---------------------------------------------------------------
// NAVBAR IDENTITY CHIP (dashboard.php computes these inline)
// ---------------------------------------------------------------
function chip(req) {
    const name = (req.session && req.session.full_name) || 'User';
    let chip_role = current_role(req) === 'teacher' ? 'Teacher' : 'Student';
    if (is_admin_user(req)) chip_role += ' · Admin';
    const parts = String(name).replace(/[^A-Za-z ]/g, '').trim().split(/\s+/);
    const first = parts[0] || 'U';
    const chip_ini = ((first ? first.charAt(0) : 'U') + (parts[1] ? parts[1].charAt(0) : '')).toUpperCase();
    return { chip_role, chip_ini };
}

// PHP nl2br(htmlspecialchars($x)): escape first, then <br /> before newlines.
const NL_RE = /\r\n|\r|\n/g;
function nl2br_html(s) {
    return esc(String(s ?? '')).replace(NL_RE, '<br />$&');
}

// ---------------------------------------------------------------
// MY CLASSES (teacher_dashboard)
// ---------------------------------------------------------------
async function teacher_dashboard(req, res) {
    const uid = current_user_id(req);
    const active = await all(
        "SELECT c.*, (SELECT COUNT(*) FROM class_members WHERE class_id=c.id) as student_count FROM classes c WHERE c.teacher_id=? AND c.status='active' ORDER BY c.created_at DESC",
        [uid]);
    const archived = await all(
        "SELECT c.*, (SELECT COUNT(*) FROM class_members WHERE class_id=c.id) as student_count FROM classes c WHERE c.teacher_id=? AND c.status='archived' ORDER BY c.created_at DESC",
        [uid]);

    let total_students = 0;
    const cards = [];
    let ai = 0;
    for (const c of active) {
        const student_count = Number(c.student_count);
        total_students += student_count;
        const cid = Number(c.id);
        const term_id = Number(c.current_term_id || 0);
        const prog = term_id ? await class_term_progress(client, cid, term_id) : null;

        let state = '';
        if (prog) {
            if (prog.published) state = '<span class="badge bg-success">Term released</span>';
            else if (prog.complete) state = '<span class="badge bg-warning text-dark">Ready to release</span>';
            else if (prog.graded > 0) state = '<span class="badge bg-info text-dark">' + Number(prog.graded) + ' of ' + Number(prog.total) + ' graded</span>';
            else state = '<span class="badge bg-secondary">Not started</span>';
        }
        const pct = prog && prog.total > 0 ? Math.round(prog.graded / prog.total * 100) : null;

        cards.push({ ...c, student_count, cid, prog, state, pct, accent: ai++ % 6 });
    }

    const { chip_role, chip_ini } = chip(req);
    res.render('teacher/dashboard', {
        page: 'dashboard', unread: 0, chip_role, chip_ini,
        classes: cards, archived, total_students,
    });
}

// ---------------------------------------------------------------
// CREATE CLASS (teacher_create_class)
// ---------------------------------------------------------------
async function teacher_create_class(req, res) {
    const years = await all('SELECT * FROM academic_years ORDER BY start_date DESC');
    const { chip_role, chip_ini } = chip(req);
    res.render('teacher/create_class', {
        page: 'create_class', unread: 0, chip_role, chip_ini,
        years,
    });
}

// ---------------------------------------------------------------
// CLASS DETAIL (teacher_class_detail) - stream / assignments / students tabs
// ---------------------------------------------------------------
async function teacher_class_detail(req, res, class_id) {
    const uid = current_user_id(req);
    const cls = await get('SELECT * FROM classes WHERE id=? AND teacher_id=?', [class_id, uid]);
    const tab = String(req.query.tab || 'stream');
    const data = {
        page: 'class', unread: 0, ...chip(req),
        cls: null, tab, class_id: Number(class_id),
    };
    if (!cls) return res.render('teacher/class', data);
    data.cls = cls;

    if (tab === 'stream') {
        data.anns = (await all('SELECT * FROM announcements WHERE class_id=? ORDER BY posted_at DESC', [class_id]))
            .map((a) => ({ ...a, content_html: nl2br_html(a.content) }));
    } else if (tab === 'assignments') {
        const assignments = await all('SELECT * FROM assignments WHERE class_id=? ORDER BY due_date DESC', [class_id]);
        for (const a of assignments) {
            const sc = await get('SELECT COUNT(*) AS n FROM submissions WHERE assignment_id=?', [a.id]);
            const lc = await get('SELECT COUNT(*) AS n FROM submissions WHERE assignment_id=? AND is_late=1', [a.id]);
            a.sub_count = Number(sc.n);
            a.late_count = Number(lc.n);
        }
        data.assignments = assignments;
    } else if (tab === 'students') {
        const search = String(req.query.search || '');
        data.search = search;
        data.students_list = search
            ? await all(
                'SELECT u.id, s.full_name, s.student_number, s.section FROM users u JOIN students s ON u.id=s.user_id JOIN class_members cm ON cm.student_id=u.id WHERE cm.class_id=? AND s.full_name LIKE ? ORDER BY s.full_name',
                [class_id, `%${search}%`])
            : await all(
                'SELECT u.id, s.full_name, s.student_number, s.section FROM users u JOIN students s ON u.id=s.user_id JOIN class_members cm ON cm.student_id=u.id WHERE cm.class_id=? ORDER BY s.full_name',
                [class_id]);
    }
    return res.render('teacher/class', data);
}

// ---------------------------------------------------------------
// TERM GRADES - the gradebook (teacher_grades)
// ---------------------------------------------------------------
async function teacher_grades(req, res, class_id) {
    const uid = current_user_id(req);
    const cls = await get('SELECT * FROM classes WHERE id=? AND teacher_id=?', [class_id, uid]);
    const data = { page: 'grades', unread: 0, ...chip(req), cls: null, no_terms: false };
    if (!cls) return res.render('teacher/grades', data);
    const cid = Number(cls.id);

    const terms = await class_terms(client, cid);
    if (!terms.length) {
        data.cls = cls;
        data.class_id = cid;
        data.no_terms = true;
        return res.render('teacher/grades', data);
    }

    // The DO 009 year is Term 1 / 2 / 3. Older installs keep a legacy
    // whole-year row (number 0); hide it from the picker whenever real
    // numbered terms exist.
    const numbered = terms.filter((t) => Number(t.number) > 0);
    const visible = numbered.length ? numbered : terms;

    // Resolve which term is being graded. An explicit ?term= wins, then the
    // class's current term, then the first term in the year.
    const valid_ids = visible.map((t) => Number(t.id));
    let term_id = Number(req.query.term || 0);
    if (!valid_ids.includes(term_id)) term_id = Number(cls.current_term_id || 0);
    if (!valid_ids.includes(term_id)) term_id = valid_ids[0];

    const roster = await class_roster(client, cid);
    const rows = await term_grade_stamps(client, cid, term_id);
    const progress = await class_term_progress(client, cid, term_id);
    const term = visible.find((t) => Number(t.id) === term_id) || null;
    const term_label = term ? String(term.label) : 'Term';

    for (const t of visible) t.published = await class_is_published(client, cid, Number(t.id));

    // Existing cluster tag for the term being viewed (drives the picker).
    const tag = await get('SELECT cluster, subject FROM term_clusters WHERE class_id=? AND term_id=?', [cid, term_id]);
    const averages = class_grade_averages(rows);

    data.cls = cls;
    data.class_id = cid;
    data.terms = visible;
    data.term_id = term_id;
    data.term_label = term_label;
    data.roster = roster;
    data.rows = rows;
    data.progress = progress;
    data.term_tag = tag || null;
    data.averages = averages;
    data.clusters = cluster_subjects();
    data.passing_mark = PASSING_MARK;
    return res.render('teacher/grades', data);
}

// ---------------------------------------------------------------
// SF9 REPORT CARDS (teacher_sf9)
// ---------------------------------------------------------------
async function teacher_sf9(req, res, class_id) {
    const uid = current_user_id(req);
    const cls = await get(
        'SELECT c.*, ay.label AS year_label FROM classes c LEFT JOIN academic_years ay ON ay.id=c.academic_year_id WHERE c.id=? AND c.teacher_id=?',
        [class_id, uid]);
    const data = { page: 'sf9', unread: 0, ...chip(req), cls: null, error: '' };
    if (!cls) return res.render('teacher/sf9', data);
    data.cls = cls;
    data.class_id = Number(class_id);

    if (Number(cls.is_advisory || 0) === 0) {
        data.error = 'advisory';
        return res.render('teacher/sf9', data);
    }
    if (!cls.academic_year_id) {
        data.error = 'no_year';
        return res.render('teacher/sf9', data);
    }

    data.roster = await all(
        'SELECT u.id, s.full_name, s.student_number FROM users u JOIN students s ON u.id=s.user_id JOIN class_members cm ON cm.student_id=u.id WHERE cm.class_id=? ORDER BY s.full_name',
        [class_id]);
    return res.render('teacher/sf9', data);
}

// ---------------------------------------------------------------
// ATTENDANCE (teacher_attendance)
// ---------------------------------------------------------------
async function teacher_attendance(req, res, class_id) {
    const uid = current_user_id(req);
    const cls = await get('SELECT * FROM classes WHERE id=? AND teacher_id=?', [class_id, uid]);
    const data = { page: 'attendance', unread: 0, ...chip(req), cls: null };
    if (!cls) return res.render('teacher/attendance', data);
    data.cls = cls;
    data.class_id = Number(class_id);

    const date = String(req.query.date || today());
    data.date = date;

    data.students = await all(
        'SELECT u.id, s.full_name FROM users u JOIN students s ON u.id=s.user_id JOIN class_members cm ON cm.student_id=u.id WHERE cm.class_id=? ORDER BY s.full_name',
        [class_id]);

    const att_rows = await all('SELECT student_id, status FROM attendance WHERE class_id=? AND date=?', [class_id, date]);
    const att_map = {};
    for (const a of att_rows) att_map[Number(a.student_id)] = String(a.status);
    data.att_map = att_map;
    return res.render('teacher/attendance', data);
}

// ---------------------------------------------------------------
// CLASS SETTINGS (teacher_settings)
// ---------------------------------------------------------------
async function teacher_settings(req, res, class_id) {
    const uid = current_user_id(req);
    const cls = await get('SELECT * FROM classes WHERE id=? AND teacher_id=?', [class_id, uid]);
    const data = { page: 'settings', unread: 0, ...chip(req), cls: null };
    if (!cls) return res.render('teacher/settings', data);
    data.cls = cls;
    data.class_id = Number(class_id);

    data.terms = await class_terms(client, data.class_id);
    data.bands = await descriptor_rows_all(client);
    data.passing_mark = PASSING_MARK;
    return res.render('teacher/settings', data);
}

// ---------------------------------------------------------------
// SUBMISSIONS (teacher_submissions)
// ---------------------------------------------------------------
async function teacher_submissions(req, res, assignment_id) {
    const uid = current_user_id(req);
    const assign = await get(
        'SELECT a.*, c.subject, c.section FROM assignments a JOIN classes c ON a.class_id=c.id WHERE a.id=? AND c.teacher_id=?',
        [assignment_id, uid]);
    const data = { page: 'submissions', unread: 0, ...chip(req), assign: null };
    if (!assign) return res.render('teacher/submissions', data);
    data.assign = assign;
    data.assignment_id = Number(assignment_id);

    data.subs = await all(
        'SELECT sub.*, s.full_name, s.student_number FROM submissions sub JOIN students s ON sub.student_id = s.user_id WHERE sub.assignment_id=? ORDER BY s.full_name',
        [assignment_id]);

    // Not-yet-submitted roster (only if file submission is required)
    if (Number(assign.requires_file || 0) !== 0) {
        data.missing = await all(
            'SELECT s.full_name, s.student_number FROM students s JOIN class_members cm ON cm.student_id = s.user_id WHERE cm.class_id=? AND s.user_id NOT IN (SELECT student_id FROM submissions WHERE assignment_id=?) ORDER BY s.full_name',
            [assign.class_id, assignment_id]);
    }
    return res.render('teacher/submissions', data);
}

module.exports = {
    teacher_dashboard,
    teacher_create_class,
    teacher_class_detail,
    teacher_grades,
    teacher_sf9,
    teacher_attendance,
    teacher_settings,
    teacher_submissions,
};
