// ================================================================
// GRADING ENGINE - direct Term Grade entry (DO 015 s.2026 descriptors)
// Port of grade_engine.php.
// ================================================================
// A teacher types one final grade per student per term. There are no
// categories, activities, weights or transmutation tables: the number they
// type IS the Term Grade. The only grading rule left is the official DO 015
// reporting scale, which lives in descriptor_rows and is applied by
// descriptor_for().
// ================================================================
const { all, get, run } = require('./db');

// The DepEd passing mark. 75 is the floor of the "Connecting" band, so a
// grade at or above this passes.
const PASSING_MARK = 75.0;
const TERM_GRADE_MIN = 0.0;
const TERM_GRADE_MAX = 100.0;

// Format a number for display without trailing zeros after a decimal point.
function trim_num(n) {
    if (n === null || n === undefined) return '';
    let s = String(n).trim();
    if (s === '' || s === '-') return s;
    if (s.includes('.')) {
        s = s.replace(/0+$/, '').replace(/\.$/, '');
    }
    return s === '-0' ? '0' : s;
}

// ---------- Assignment submission policy (unrelated to grades) ----------
const DEFAULT_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'jpg', 'png', 'zip'];

async function assignment_policy(db, assignment_id) {
    const a = await get(
        'SELECT requires_file, allowed_exts, max_size_mb, allow_late, cutoff_date, due_date FROM assignments WHERE id=?',
        [assignment_id]);
    if (!a) return null;
    const exts = String(a.allowed_exts || '').trim();
    return {
        requires_file: Number(a.requires_file) === 1,
        allowed_exts: exts !== ''
            ? exts.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
            : DEFAULT_EXTS.slice(),
        max_size_mb: Math.max(0.1, Number(a.max_size_mb)),
        allow_late: Number(a.allow_late) === 1,
        cutoff_date: a.cutoff_date,
        due_date: a.due_date,
    };
}

// ---------- Descriptors ----------
// Queried fresh per call (serverless-safe): the gradebook renders every
// student on each request and the rows are shared by all of them.
async function descriptor_rows_all(db) {
    const rows = await all('SELECT min_grade, max_grade, label_en, label_fil FROM descriptor_rows ORDER BY min_grade DESC');
    return rows || [];
}

// Label a numeric grade using the DO 015 scale. A null grade is "Not Graded",
// never zero and never the lowest band.
function descriptor_for(grade, rows) {
    if (grade === null || grade === undefined || grade === '') {
        return { label_en: 'Not Graded', label_fil: 'Hindi pa Naitala' };
    }
    const g = Number(grade);
    for (const r of rows) {
        if (g >= Number(r.min_grade) && g <= Number(r.max_grade)) {
            return { label_en: r.label_en, label_fil: r.label_fil };
        }
    }
    // Out-of-band value: label it by where it sits rather than silently
    // falling back to "Not Graded", which would read as "no grade entered".
    return { label_en: 'Invalid', label_fil: 'Hindi wasto' };
}

function grade_passes(grade) {
    return grade !== null && grade !== undefined && Number(grade) >= PASSING_MARK;
}

// ---------- Term grade lookup ----------
// Returns the stored Term Grade for one student, or null when ungraded.
async function direct_term_grade(db, class_id, student_id, term_id) {
    const row = await get(
        'SELECT grade FROM term_grades WHERE class_id=? AND term_id=? AND student_id=?',
        [class_id, term_id, student_id]);
    return row && row.grade !== null && row.grade !== undefined ? Number(row.grade) : null;
}

// Row payload for one student, shaped the way the grid and the API return it.
async function term_grade_row(db, class_id, student_id, term_id, stamp = null) {
    const g = await direct_term_grade(db, class_id, student_id, term_id);
    const d = descriptor_for(g, await descriptor_rows_all(db));
    return {
        grade: g,
        descriptor: d.label_en,
        descriptor_fil: d.label_fil,
        passed: grade_passes(g),
        stamp,
    };
}

// Batch lookup: grade + updated_at for every member of a class in one term.
// Two queries total instead of two per student.
async function term_grade_stamps(db, class_id, term_id, only_students = null) {
    let ids;
    if (only_students === null) {
        const rows = await all(
            'SELECT u.id FROM users u JOIN class_members cm ON cm.student_id = u.id WHERE cm.class_id=? ORDER BY u.id',
            [class_id]);
        ids = rows.map((r) => Number(r.id));
    } else {
        ids = [...new Set((Array.isArray(only_students) ? only_students : [only_students]).map(Number))];
    }

    const q = await all('SELECT student_id, grade, updated_at FROM term_grades WHERE class_id=? AND term_id=?',
        [class_id, term_id]);
    const by = new Map();
    for (const r of q) by.set(Number(r.student_id), r);

    const rows = await descriptor_rows_all(db);
    const out = {};
    for (const sid of ids) {
        const row = by.get(Number(sid)) || null;
        const g = row && row.grade !== null && row.grade !== undefined ? Number(row.grade) : null;
        const d = descriptor_for(g, rows);
        out[sid] = {
            grade: g,
            descriptor: d.label_en,
            descriptor_fil: d.label_fil,
            passed: grade_passes(g),
            stamp: row ? row.updated_at : null,
        };
    }
    return out;
}

// ---------- Saving ----------
// Validate one raw input into a storable value.
// Returns [ok, value, error]. A blank cell is valid and means "ungraded",
// which is stored as SQL NULL and excluded from every average.
function validate_term_grade(raw) {
    const s = typeof raw === 'string' ? raw.trim() : raw;
    if (s === '' || s === null || s === undefined) return [true, null, null];
    // A plain decimal only, so the server accepts exactly what the browser's
    // input validation accepts ("1e2" and "0x1A" are not grades).
    const str = String(s);
    if (!/^-?\d+(\.\d+)?$/.test(str)) return [false, null, 'must be a number between 0 and 100'];
    const v = Number(str);
    if (v < TERM_GRADE_MIN || v > TERM_GRADE_MAX) return [false, null, 'must be between 0 and 100'];
    return [true, v, null];
}

// Timestamp used for the concurrency stamp.
// UTC, microsecond-width so stamps stay string-comparable with rows written
// by the PHP original ('YYYY-MM-DD HH:MM:SS.SSSSSS').
function term_grade_now() {
    const t = Date.now();
    const sec = Math.floor(t / 1000);
    const ms = t % 1000;
    const usec = ms * 1000 + Math.floor(Math.random() * 1000);
    const iso = new Date(sec * 1000).toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
    return iso.replace('T', ' ').slice(0, 19) + '.' + String(usec).padStart(6, '0');
}

// Save a set of {student_id => raw} grades for one class+term.
//
// expected_stamps maps student_id => the updated_at the client last saw.
// When a stamp is supplied and does not match the stored row, that student is
// skipped and reported in 'conflicts' rather than silently overwritten: two
// teachers with the gradebook open would otherwise lose each other's edits.
//
// Returns:
//   [ ok, error, {saved: [...], conflicts: [ids], stamps: {id => updated_at}} ]
async function save_term_grades(db, class_id, term_id, changes, expected_stamps = {}, user_id = null) {
    class_id = Number(class_id);
    term_id = Number(term_id);

    // Never accept a student who is not on the roster.
    const rm = await all('SELECT student_id FROM class_members WHERE class_id=?', [class_id]);
    const roster = new Set(rm.map((r) => Number(r.student_id)));

    // Validate everything up front so a bad cell cannot leave a half-applied
    // batch behind.
    const validated = new Map();
    for (const [sidRaw, raw] of Object.entries(changes || {})) {
        const sid = Number(sidRaw);
        if (!roster.has(sid)) continue; // silently ignore non-members
        const [ok, val, err] = validate_term_grade(raw);
        if (!ok) return [false, `Student ${sid}: grade ${err}`, []];
        validated.set(sid, val);
    }
    if (validated.size === 0) return [true, null, { saved: [], conflicts: [], stamps: {} }];

    const saved = [];
    const conflicts = [];
    const stamps = {};

    const tx = await db.transaction('write');
    try {
        for (const [sid, val] of validated) {
            const expected = expected_stamps ? expected_stamps[sid] : undefined;
            if (expected !== undefined && expected !== null && expected !== '') {
                const cur = await tx.execute({
                    sql: 'SELECT updated_at FROM term_grades WHERE class_id=? AND term_id=? AND student_id=?',
                    args: [class_id, term_id, sid],
                });
                const curVal = cur.rows.length ? cur.rows[0].updated_at : null; // absent -> client stamp is stale
                if (String(curVal ?? '') !== String(expected)) {
                    conflicts.push(sid);
                    continue;
                }
            }
            const now = term_grade_now();
            await tx.execute({
                sql: `INSERT INTO term_grades (class_id, term_id, student_id, grade, updated_at)
                      VALUES (?,?,?,?,?)
                      ON CONFLICT (class_id, term_id, student_id)
                      DO UPDATE SET grade = excluded.grade, updated_at = excluded.updated_at`,
                args: [class_id, term_id, sid, val, now],
            });
            stamps[sid] = now;
            saved.push(sid);
        }
        await tx.commit();
    } catch (e) {
        await tx.rollback().catch(() => {});
        return [false, 'Could not save: ' + e.message, []];
    }

    return [true, null, { saved, conflicts, stamps }];
}

// ---------- Progress ----------
// What the progress strip and the publish gate need, in one pass.
async function class_term_progress(db, class_id, term_id) {
    const rm = await get('SELECT COUNT(*) AS n FROM class_members WHERE class_id=?', [class_id]);
    const total = Number(rm.n);

    const r = (await get(
        `SELECT COUNT(grade) AS graded, AVG(grade) AS avg,
                SUM(CASE WHEN grade < ${PASSING_MARK} THEN 1 ELSE 0 END) AS below
         FROM term_grades WHERE class_id=? AND term_id=?`, [class_id, term_id])) || {};

    // COUNT(grade) ignores NULLs, so an ungraded student is never counted as 0.
    const graded = Number(r.graded || 0);
    const avg = r.avg !== null && r.avg !== undefined ? Math.round(Number(r.avg) * 100) / 100 : null;

    const d = avg === null ? { label_en: null, label_fil: null } : descriptor_for(avg, await descriptor_rows_all(db));

    return {
        total,
        graded,
        ungraded: Math.max(0, total - graded),
        complete: total > 0 && graded >= total,
        average: avg,
        descriptor: d.label_en,
        descriptor_fil: d.label_fil,
        below_passing: Number(r.below || 0),
        published: await class_is_published(db, class_id, term_id),
    };
}

// ---------- Terms for a class ----------
async function class_terms(db, class_id) {
    return all(
        'SELECT t.* FROM terms t JOIN classes c ON c.academic_year_id = t.academic_year_id WHERE c.id=? ORDER BY t.number',
        [class_id]);
}

async function class_is_published(db, class_id, term_id) {
    const r = await get('SELECT COUNT(*) AS n FROM class_term_status WHERE class_id=? AND term_id=?', [class_id, term_id]);
    return Number(r.n) > 0;
}

// ---------- Final grade (average of published term grades) ----------
async function final_grade_from_terms(db, class_id, student_id, only_published = true) {
    const terms = await class_terms(db, class_id);
    let sum = 0.0, w = 0.0, count = 0;
    for (const t of terms) {
        if (only_published && !(await class_is_published(db, class_id, t.id))) continue;
        const g = await direct_term_grade(db, class_id, student_id, t.id);
        if (g !== null) {
            sum += g * Number(t.weight);
            w += Number(t.weight);
            count++;
        }
    }
    if (count === 0 || w <= 0) return null;
    return Math.round((sum / w) * 100) / 100;
}

// Mean Term Grade across the class from a batch of term_grade_stamps() rows.
// Kept as a function because the grid footer and the progress strip both need
// it and they must agree.
function class_grade_averages(rows) {
    let s = 0.0, n = 0;
    for (const r of Object.values(rows)) {
        if (r.grade !== null && r.grade !== undefined) { s += Number(r.grade); n++; }
    }
    return { tg: n ? Math.round((s / n) * 100) / 100 : null, n };
}

// ---------- Roster ----------
async function class_roster(db, class_id) {
    return all(
        `SELECT s.user_id, s.student_number, s.full_name
         FROM students s JOIN class_members cm ON cm.student_id = s.user_id
         WHERE cm.class_id=? ORDER BY s.full_name`, [class_id]);
}

module.exports = {
    PASSING_MARK, TERM_GRADE_MIN, TERM_GRADE_MAX, DEFAULT_EXTS,
    trim_num, assignment_policy, descriptor_rows_all, descriptor_for, grade_passes,
    direct_term_grade, term_grade_row, term_grade_stamps,
    validate_term_grade, term_grade_now, save_term_grades,
    class_term_progress, class_terms, class_is_published,
    final_grade_from_terms, class_grade_averages, class_roster,
};
