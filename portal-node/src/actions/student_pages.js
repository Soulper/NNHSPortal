// ================================================================
// STUDENT PAGE RENDERERS (port of includes/student.php)
// ================================================================
// One async renderer per PHP function. Each renders 'student/<name>' with
// the full shell (app_head + navbar + container + footer) that dashboard.php
// wrapped around these functions in the PHP original. The navbar unread
// badge shows the real unread notification count for students (dashboard.php
// computed it once in the shell: $unread = $role == 'student' ? ... : 0).
// ================================================================
const { all, get, run, client } = require('../db');
const {
    current_user_id, current_role, is_admin_user, unread_count, today, esc, rc_grade_class,
} = require('../config');
const {
    PASSING_MARK, trim_num, assignment_policy, descriptor_rows_all, descriptor_for,
    grade_passes, direct_term_grade, class_terms, class_is_published,
} = require('../grade-engine');

// ---------------------------------------------------------------
// LOCAL HELPERS (small pieces of PHP stdlib / student.php internals)
// ---------------------------------------------------------------

// PHP (int) cast: "3.7" -> 3, "abc"/""/null -> 0.
function to_int(v) {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? 0 : n;
}

// PHP round($x, 2) for the averages (same expression the grade engine uses).
function round2(v) {
    return Math.round(Number(v) * 100) / 100;
}

// PHP ucfirst().
function ucfirst(s) {
    s = String(s ?? '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// PHP rawurlencode() (RFC 3986; encodeURIComponent leaves !'()* unescaped).
function rawurlencode(s) {
    return encodeURIComponent(String(s ?? '')).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// PHP nl2br(htmlspecialchars($x)): escape first, then '<br />' before each newline.
function nl2br(s) {
    return esc(s).replace(/(\r\n|\r|\n)/g, '<br />$1');
}

// Navbar identity chip (dashboard.php computes these inline; the same logic
// lives in the dashboard router, which this module cannot import).
function chip(req) {
    const name = (req.session && req.session.full_name) || 'User';
    let chip_role = current_role(req) === 'teacher' ? 'Teacher' : 'Student';
    if (is_admin_user(req)) chip_role += ' · Admin';
    const parts = String(name).replace(/[^A-Za-z ]/g, '').trim().split(/\s+/).filter(Boolean);
    const chip_ini = (((parts[0] || 'U')[0] || 'U') + (parts[1] ? parts[1][0] : '')).toUpperCase();
    return { chip_role, chip_ini };
}

// dashboard.php: $unread = $role == 'student' ? unread_count($db, $user_id) : 0;
async function navbar_unread(req) {
    return current_role(req) === 'student' ? await unread_count(client, current_user_id(req)) : 0;
}

// Shell locals shared by every student page.
function shell(req, unread) {
    return { title: 'School Portal', unread, ...chip(req) };
}

// ---------------------------------------------------------------
// stu_latest_grade($db, $class_id, $student_id)
// Latest released grade for one class (null when nothing is out yet).
// ---------------------------------------------------------------
async function stu_latest_grade(db, class_id, student_id) {
    let best = null;
    for (const t of await class_terms(db, class_id)) {
        if (!(await class_is_published(db, class_id, t.id))) continue;
        const g = await direct_term_grade(db, class_id, student_id, t.id);
        if (g !== null) best = g; // terms come in order, so the last one wins
    }
    return best;
}

// ---------------------------------------------------------------
// stu_due_chip($due_date)
// Friendly due-date chip: Due today / Due tomorrow / Due in N days.
// PHP compared two local midnights (strtotime vs date('Y-m-d')), which is a
// plain calendar-day difference for 'YYYY-MM-DD' values.
// ---------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function stu_due_chip(due_date) {
    const due = String(due_date).slice(0, 10);
    const days = Math.floor((Date.parse(due + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86400000);
    if (days <= 0) return ['Due today', 'is-soon'];
    if (days === 1) return ['Due tomorrow', ''];
    if (days <= 7) return ['Due in ' + days + ' days', ''];
    return ['Due ' + MONTHS[Number(due.slice(5, 7)) - 1] + ' ' + Number(due.slice(8, 10)), ''];
}

// ================================================================
// student_dashboard()
// ================================================================
async function student_dashboard(req, res) {
    const user_id = current_user_id(req);
    const unread = await navbar_unread(req);
    const full_name = (req.session && req.session.full_name) || 'student';
    const first = String(full_name).trim().split(' ')[0];
    const syRow = await get('SELECT label FROM academic_years WHERE is_active=1 LIMIT 1');
    const sy = syRow && syRow.label != null ? String(syRow.label) : '';

    const enrolledRows = await all(
        "SELECT c.* FROM classes c JOIN class_members cm ON cm.class_id=c.id WHERE cm.student_id=? AND c.status='active' ORDER BY c.subject",
        [user_id]);
    const drows = await descriptor_rows_all(client);

    // Per-class details, set-based. Workers caps every invocation at ~50
    // subrequests and each query is one, so the old per-class/per-term loops
    // (teacher + terms + published + grades per class) blew the cap on a
    // populated dashboard. Four IN (...) queries replace them; the semantics
    // of class_terms / class_is_published / direct_term_grade are mirrored.
    const classIds = enrolledRows.map((c) => Number(c.id));
    const inPh = classIds.map(() => '?').join(',');
    const teacherMap = new Map();
    const termsByClass = new Map();
    const publishedSet = new Set();
    const gradeMap = new Map();
    if (classIds.length) {
        for (const t of await all(`SELECT user_id, full_name FROM teachers WHERE user_id IN (${inPh})`, classIds)) {
            teacherMap.set(Number(t.user_id), t.full_name == null ? '' : String(t.full_name));
        }
        for (const t of await all(`SELECT c.id AS class_id, t.* FROM terms t JOIN classes c ON c.academic_year_id = t.academic_year_id WHERE c.id IN (${inPh}) ORDER BY t.number`, classIds)) {
            const k = Number(t.class_id);
            if (!termsByClass.has(k)) termsByClass.set(k, []);
            termsByClass.get(k).push(t);
        }
        for (const r of await all(`SELECT class_id, term_id FROM class_term_status WHERE class_id IN (${inPh})`, classIds)) {
            publishedSet.add(Number(r.class_id) + ':' + Number(r.term_id));
        }
        for (const g of await all(`SELECT class_id, term_id, grade FROM term_grades WHERE student_id = ? AND class_id IN (${inPh})`, [user_id, ...classIds])) {
            gradeMap.set(Number(g.class_id) + ':' + Number(g.term_id),
                g.grade === null || g.grade === undefined ? null : Number(g.grade));
        }
    }

    // Per-class details: teacher + released count + latest released grade chip.
    const enrolled = [];
    for (const c of enrolledRows) {
        const cid = Number(c.id);
        const teacher = teacherMap.get(Number(c.teacher_id)) || '';
        const all_terms = termsByClass.get(cid) || [];
        let released = 0;
        let latest = null;
        for (const t of all_terms) {
            const pub = publishedSet.has(cid + ':' + Number(t.id));
            if (pub) released++;
            if (pub) {
                const g = gradeMap.get(cid + ':' + Number(t.id));
                if (g !== null && g !== undefined) latest = g; // terms in order, last one wins
            }
        }
        enrolled.push({
            id: cid,
            subject: c.subject,
            section: c.section == null ? '' : String(c.section),
            teacher,
            released,
            terms: all_terms.length,
            latest,
            latest_desc: latest !== null ? descriptor_for(latest, drows).label_en : null,
            accent: enrolled.length % 6,
        });
    }

    const upcomingRows = await all(
        "SELECT a.*, c.subject FROM assignments a JOIN classes c ON a.class_id=c.id JOIN class_members cm ON cm.class_id=a.class_id WHERE cm.student_id=? AND a.due_date >= date('now') ORDER BY a.due_date LIMIT 5",
        [user_id]);
    const upcoming = upcomingRows.map((a) => {
        const [due_chip, soon] = stu_due_chip(a.due_date);
        return { title: a.title, subject: a.subject, chip: due_chip, soon };
    });

    const annRow = await get(
        'SELECT a.*, c.subject FROM announcements a JOIN classes c ON a.class_id=c.id JOIN class_members cm ON cm.class_id=a.class_id WHERE cm.student_id=? ORDER BY a.posted_at DESC LIMIT 1',
        [user_id]);
    const latest_ann = annRow ? {
        title: annRow.title,
        content_html: nl2br(annRow.content),
        subject: annRow.subject,
        posted_at: annRow.posted_at,
    } : null;

    const attRows = await all('SELECT status, COUNT(*) as cnt FROM attendance WHERE student_id=? GROUP BY status', [user_id]);
    let att_total = 0;
    let att_present = 0;
    for (const r of attRows) {
        att_total += Number(r.cnt);
        if (r.status === 'present' || r.status === 'late') att_present += Number(r.cnt);
    }
    const att_rate = att_total > 0 ? Math.round((att_present / att_total) * 100) : null;

    // Overall average across released terms + needs-attention classes
    // (reuses the set-based maps above — no extra queries).
    let overall = null;
    const published_tgs = [];
    const need_attention_parts = [];
    for (const c of enrolledRows) {
        const cid = Number(c.id);
        const terms = termsByClass.get(cid) || [];
        for (const t of terms) {
            if (!publishedSet.has(cid + ':' + Number(t.id))) continue;
            const g = gradeMap.get(cid + ':' + Number(t.id));
            if (g !== null && g !== undefined) {
                published_tgs.push(g);
                if (g < PASSING_MARK) {
                    need_attention_parts.push(esc(c.subject) + ' (' + esc(t.label) + '): ' + trim_num(g));
                }
            }
        }
    }
    if (published_tgs.length) overall = round2(published_tgs.reduce((a, b) => a + b, 0) / published_tgs.length);

    res.render('student/dashboard', {
        ...shell(req, unread),
        page: 'dashboard',
        first,
        sy,
        enrolled_count: enrolled.length,
        upcoming_count: upcoming.length,
        att: {
            value: att_rate === null ? '--' : att_rate + '%',
            cls: att_rate === null ? '' : (att_rate >= 95 ? 'text-good' : (att_rate < 90 ? 'text-bad' : '')),
        },
        overall: {
            value: overall === null ? '--' : String(overall),
            cls: overall === null ? '' : (overall < 75 ? 'text-bad' : 'text-good'),
            // PHP printed the raw ' &middot; ' + descriptor label here (unescaped).
            desc: overall === null ? '' : ' &middot; ' + descriptor_for(overall, drows).label_en,
        },
        need_attention_parts,
        enrolled,
        upcoming,
        latest_ann,
    });
}

// ================================================================
// student_classes()
// ================================================================
async function student_classes(req, res) {
    const user_id = current_user_id(req);
    const unread = await navbar_unread(req);
    const rows = await all(
        'SELECT c.*, t.full_name AS teacher FROM classes c LEFT JOIN teachers t ON t.user_id=c.teacher_id JOIN class_members cm ON cm.class_id=c.id WHERE cm.student_id=? ORDER BY c.subject',
        [user_id]);
    const drows = await descriptor_rows_all(client);
    const list = [];
    for (const c of rows) {
        const latest = await stu_latest_grade(client, c.id, user_id);
        list.push({
            id: Number(c.id),
            subject: c.subject,
            section: c.section == null ? '' : String(c.section),
            school_year: c.school_year == null ? '' : String(c.school_year),
            teacher: c.teacher != null ? String(c.teacher) : '',
            latest,
            latest_desc: latest !== null ? descriptor_for(latest, drows).label_en : null,
            accent: list.length % 6,
        });
    }
    res.render('student/classes', { ...shell(req, unread), page: 'classes', list });
}

// ================================================================
// student_class_detail($class_id)
// ================================================================
async function student_class_detail(req, res, class_id) {
    const user_id = current_user_id(req);
    const unread = await navbar_unread(req);
    class_id = Number(class_id);
    const c = await get("SELECT * FROM classes WHERE id=? AND status='active'", [class_id]);
    if (!c) {
        res.render('student/class', { ...shell(req, unread), page: 'class', error: 'Class not found or inactive.' });
        return;
    }
    const member = await get('SELECT COUNT(*) AS n FROM class_members WHERE class_id=? AND student_id=?', [class_id, user_id]);
    if (Number(member.n) === 0) {
        res.render('student/class', { ...shell(req, unread), page: 'class', error: 'You are not enrolled in this class.' });
        return;
    }

    const tab = req.query.tab ?? 'stream';
    const drows = await descriptor_rows_all(client);

    let anns = [];
    let grades_summary = [];
    let att_summary = [];
    let assigns = [];

    if (tab === 'stream') {
        const annRows = await all('SELECT * FROM announcements WHERE class_id=? ORDER BY posted_at DESC', [class_id]);
        anns = annRows.map((a) => ({
            title: a.title,
            content_html: nl2br(a.content),
            attachment: a.attachment || null,
            attachment_href: a.attachment ? rawurlencode(a.attachment) : '',
            posted_at: a.posted_at,
        }));

        // Grade summary: published terms only
        const terms = await class_terms(client, class_id);
        const published = [];
        for (const t of terms) {
            if (await class_is_published(client, class_id, t.id)) published.push(t);
        }
        for (const t of published) {
            const g = await direct_term_grade(client, class_id, user_id, t.id);
            grades_summary.push({
                label: t.label,
                grade: g,
                descriptor: g !== null ? descriptor_for(g, drows).label_en : null,
                passed: grade_passes(g),
            });
        }

        // Attendance summary
        const attRows = await all('SELECT status, COUNT(*) as cnt FROM attendance WHERE class_id=? AND student_id=? GROUP BY status', [class_id, user_id]);
        if (attRows.length) {
            const total_att = attRows.reduce((s, r) => s + Number(r.cnt), 0);
            for (const r of attRows) {
                att_summary.push({
                    status_uc: ucfirst(r.status),
                    color: r.status === 'present' ? 'success' : (r.status === 'late' ? 'warning' : (r.status === 'excused' ? 'info' : 'danger')),
                    cnt: Number(r.cnt),
                    pct: Math.round((Number(r.cnt) / total_att) * 100),
                });
            }
        }
    } else if (tab === 'assignments') {
        const assignRows = await all('SELECT * FROM assignments WHERE class_id=? ORDER BY due_date DESC', [class_id]);
        for (const a of assignRows) {
            const pol = await assignment_policy(client, a.id);
            const now = today();
            const closed = !!(pol && !pol.allow_late && pol.cutoff_date && now > pol.cutoff_date);
            const sub = await get('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?', [a.id, user_id]);
            let status;
            if (sub && sub.score !== null && sub.score !== undefined) status = 'Graded: ' + sub.score;
            else if (sub && sub.is_late) status = 'Submitted (Late)';
            else if (sub) status = 'Submitted';
            else status = 'Pending';
            let status_color;
            if (sub && sub.score !== null && sub.score !== undefined) status_color = 'success';
            else if (sub) status_color = 'warning';
            else status_color = 'secondary';
            assigns.push({
                id: Number(a.id),
                title: a.title,
                due_date: a.due_date,
                attachment: a.attachment || null,
                attachment_href: a.attachment ? rawurlencode(a.attachment) : '',
                description_html: a.description ? nl2br(a.description) : '',
                requires_file: pol ? pol.requires_file : false,
                exts_csv: pol ? pol.allowed_exts.join(', ') : '',
                accept_attr: pol ? pol.allowed_exts.map((e) => '.' + e).join(',') : '',
                max_size_mb: pol ? pol.max_size_mb : '',
                late_label: pol ? (pol.allow_late ? 'Late allowed' : (closed ? 'Closed for submissions' : 'Late not allowed')) : '',
                existing: sub || null,
                submitted_at: sub ? sub.submitted_at : null,
                feedback: sub && sub.feedback ? sub.feedback : null,
                status,
                status_color,
                can_submit: (!sub || sub.score === null || sub.score === undefined) && !closed,
                button: sub ? 'Resubmit' : 'Submit',
            });
        }
    }

    res.render('student/class', {
        ...shell(req, unread),
        page: 'class',
        error: null,
        c: {
            subject: c.subject,
            section: c.section == null ? '' : String(c.section),
            school_year: c.school_year == null ? '' : String(c.school_year),
        },
        class_id,
        tab,
        anns,
        grades_summary,
        att_summary,
        assigns,
    });
}

// ================================================================
// student_grades()
// The student's report card: one row per subject, one column per term, plus a
// Final column that averages the released terms. Unreleased terms are hidden
// entirely - a student must never see an unreleased term's grades.
// ================================================================
async function student_grades(req, res) {
    const user_id = current_user_id(req);
    const unread = await navbar_unread(req);

    const enrolled = await all(
        `SELECT c.*, ay.label AS year_label
         FROM classes c
         LEFT JOIN academic_years ay ON ay.id = c.academic_year_id
         JOIN class_members cm ON cm.class_id = c.id
         WHERE cm.student_id=?
         ORDER BY ay.start_date DESC, c.subject`,
        [user_id]);
    if (!enrolled.length) {
        res.render('student/grades', { ...shell(req, unread), page: 'grades', info: 'You are not enrolled in any classes.' });
        return;
    }

    // Which terms appear as columns? Every term of the school year that has
    // at least one released grade for this student. A school year with no
    // released grades at all is skipped rather than shown as an empty table.
    const years = new Map();
    for (const c of enrolled) {
        const yid = Number(c.academic_year_id ?? 0);
        if (!yid) continue;
        if (!years.has(yid)) years.set(yid, c.year_label != null ? String(c.year_label) : 'Year ' + yid);
    }
    if (!years.size) {
        res.render('student/grades', { ...shell(req, unread), page: 'grades', info: 'No released grades yet.' });
        return;
    }
    let year_id = to_int(req.query.year ?? 0);
    if (!year_id || !years.has(year_id)) year_id = years.keys().next().value;

    const subjects_rows = enrolled.filter((c) => Number(c.academic_year_id ?? 0) === year_id);

    // term columns for this year
    const all_terms = await all('SELECT id, number, label FROM terms WHERE academic_year_id=? ORDER BY number', [year_id]);
    // The DO 009 year is Term 1 / 2 / 3; skip the legacy whole-year row
    // (number 0) whenever numbered terms exist.
    const numbered = all_terms.filter((t) => Number(t.number) > 0);
    const year_terms = numbered.length ? numbered : all_terms;

    // A term column is shown only if at least one subject has released it.
    const terms = [];
    for (const t of year_terms) {
        for (const c of subjects_rows) {
            if (await class_is_published(client, c.id, t.id)) { terms.push(t); break; }
        }
    }
    if (!terms.length) {
        res.render('student/grades', {
            ...shell(req, unread), page: 'grades',
            info: 'No grades have been released for ' + years.get(year_id) + ' yet.',
        });
        return;
    }

    // Learner strip: the printed-SF9 feel on screen.
    const meRow = await get('SELECT full_name, student_number, section FROM students WHERE user_id=?', [user_id]);
    const me = {
        full_name: meRow && meRow.full_name != null ? String(meRow.full_name) : '',
        student_number: meRow && meRow.student_number != null ? String(meRow.student_number) : '',
        section: meRow && meRow.section != null ? String(meRow.section) : '',
    };

    const drows = await descriptor_rows_all(client);
    let grand_sum = 0.0;
    let grand_n = 0;
    const grand_finals = [];
    const subjects = [];
    for (const c of subjects_rows) {
        const cid = Number(c.id);
        const finals = new Map();
        let any = false;
        // Cluster tag shown to the student: the latest released, graded term
        // that the teacher labelled in the gradebook.
        const tagRows = await all('SELECT term_id, cluster FROM term_clusters WHERE class_id=?', [cid]);
        const term_tags = new Map();
        for (const tg of tagRows) term_tags.set(Number(tg.term_id), tg.cluster);
        let shown_cluster = '';
        for (const t of terms) {
            const pub = await class_is_published(client, cid, t.id);
            const g = pub ? await direct_term_grade(client, cid, user_id, t.id) : null;
            finals.set(Number(t.id), { grade: g, shown: pub });
            if (pub && g !== null && term_tags.has(Number(t.id))) shown_cluster = String(term_tags.get(Number(t.id)) ?? '');
            if (pub && g !== null) { any = true; grand_sum += g; grand_n++; }
        }
        // Subject final = average of that subject's released terms.
        const vals = [...finals.values()].map((f) => f.grade).filter((g) => g !== null);
        const sub_final = vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
        if (sub_final !== null) grand_finals.push(sub_final);
        subjects.push({
            subject: c.subject,
            section: c.section == null ? '' : String(c.section),
            shown_cluster,
            any,
            cells: terms.map((t) => {
                const f = finals.get(Number(t.id));
                return {
                    shown: f.shown,
                    grade: f.grade,
                    desc: f.shown ? descriptor_for(f.grade, drows).label_en : null,
                };
            }),
            sub_final,
            passed: grade_passes(sub_final),
        });
    }

    const general = grand_finals.length ? round2(grand_finals.reduce((a, b) => a + b, 0) / grand_finals.length) : null;
    const general_obj = general === null ? null : {
        value: general,
        desc: descriptor_for(general, drows).label_en,
        passed: grade_passes(general),
    };

    res.render('student/grades', {
        ...shell(req, unread),
        page: 'grades',
        info: null,
        me,
        years: [...years.entries()].map(([yid, label]) => ({ yid, label, active: yid === year_id })),
        year_label: years.get(year_id),
        terms: terms.map((t) => ({ id: Number(t.id), label: t.label })),
        subjects,
        general: general_obj,
        legend: drows.map((b) => ({ cls: rc_grade_class(b.min_grade, true), label: b.label_en })),
        passing_mark: Number(PASSING_MARK),
    });
}

// ================================================================
// student_attendance()
// ================================================================
async function student_attendance(req, res) {
    const user_id = current_user_id(req);
    const unread = await navbar_unread(req);
    const records = await all(
        'SELECT at.*, c.subject, c.section FROM attendance at JOIN classes c ON at.class_id=c.id WHERE at.student_id=? ORDER BY at.date DESC LIMIT 50',
        [user_id]);

    const rows = records.map((r) => ({
        date: r.date,
        subject: r.subject,
        section: r.section == null ? '' : String(r.section),
        status_uc: ucfirst(r.status),
        color: r.status === 'present' ? 'success' : (r.status === 'late' ? 'warning' : (r.status === 'excused' ? 'info' : 'danger')),
    }));

    // Summary strip: present/late/absent/excused counts + rate.
    const counts = { present: 0, late: 0, absent: 0, excused: 0 };
    for (const r of records) if (Object.prototype.hasOwnProperty.call(counts, r.status)) counts[r.status]++;
    const total = counts.present + counts.late + counts.absent + counts.excused;
    const rate = total ? Math.round(((counts.present + counts.late) / total) * 100) : 0;
    const rate_cls = rate >= 95 ? 'text-good' : (rate < 90 ? 'text-bad' : '');

    res.render('student/attendance', {
        ...shell(req, unread),
        page: 'attendance',
        records: rows,
        has_records: records.length > 0,
        counts,
        rate,
        rate_cls,
    });
}

// ================================================================
// student_notifications()
// ================================================================
async function student_notifications(req, res) {
    const user_id = current_user_id(req);
    // dashboard.php renders the navbar (and its unread badge) before the page
    // body marks everything read, so the badge shows the pre-read count here.
    const unread = await navbar_unread(req);
    await run('UPDATE notifications SET is_read=1 WHERE user_id=?', [user_id]);
    const notifs = await all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC', [user_id]);
    const list = notifs.map((n) => ({
        link: n.link == null ? '' : String(n.link),
        message: n.message,
        created_at: n.created_at,
    }));
    res.render('student/notifications', { ...shell(req, unread), page: 'notifications', list });
}

module.exports = {
    student_dashboard,
    student_classes,
    student_class_detail,
    student_grades,
    student_attendance,
    student_notifications,
};
