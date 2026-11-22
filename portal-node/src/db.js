// ================================================================
// DATABASE (port of db.php)
// ================================================================
// SQLite via @libsql/client. The same SQL runs against a local file
// (development) and a Turso database (Vercel production) - only the
// DATABASE_URL / DATABASE_TOKEN env vars change.
//
//   local dev : DATABASE_URL=file:./data/school_portal.db
//   production: DATABASE_URL=libsql://xxx.turso.io  DATABASE_TOKEN=eyJ...
// ================================================================
const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

function defaultDbUrl() {
    const dir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return 'file:' + path.join(dir, 'school_portal.db').replace(/\\/g, '/');
}

const client = createClient({
    url: process.env.DATABASE_URL || defaultDbUrl(),
    authToken: process.env.DATABASE_TOKEN || undefined,
});

// ---------------------------------------------------------------
// QUERY HELPERS (the shape the rest of the app uses)
// ---------------------------------------------------------------
async function all(sql, params = []) {
    const rs = await client.execute({ sql, args: params });
    return rs.rows;
}

// First row or null.
async function get(sql, params = []) {
    const rows = await all(sql, params);
    return rows.length ? rows[0] : null;
}

// Run + return { lastId } for convenience (PHP's lastInsertId()).
async function run(sql, params = []) {
    const rs = await client.execute({ sql, args: params });
    return { lastId: rs.lastInsertRowid != null ? Number(rs.lastInsertRowid) : 0 };
}

async function exec(sql) {
    return client.execute(sql);
}

// ---------------------------------------------------------------
// SCHEMA HELPERS
// ---------------------------------------------------------------
async function db_column_exists(table, col) {
    const cols = await all(`PRAGMA table_info(${table})`);
    return cols.some((c) => c.name === col);
}

async function add_column(table, col, def) {
    if (!(await db_column_exists(table, col))) {
        await client.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
}

async function db_table_exists(table) {
    const r = await get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='${table}'`);
    return Number(r.n) > 0;
}

async function db_index_exists(table, index) {
    const r = await get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='${index}'`);
    return Number(r.n) > 0;
}

// ---------------------------------------------------------------
// REFERENCE DATA
// ---------------------------------------------------------------
// Subject clusters (strands). Each class belongs to one cluster and its
// subject must come from that cluster's list. Only STEM is populated for now;
// the other strands appear in the picker but stay disabled ("coming soon")
// until their subject lists arrive.
function cluster_subjects() {
    return {
        STEM: [
            'Physics I', 'Physics II', 'Physics III', 'Physics IV',
            'Chemistry I', 'Chemistry II', 'Chemistry III', 'Chemistry IV',
            'Biology I', 'Biology II', 'Biology III', 'Biology IV',
            'Empowerment Technology', 'Pre-calculus', 'Earth and Space', 'Research',
        ],
        ABM: [
            'Fundamentals of Accountancy, Business and Economics',
            'Business Mathematics',
            'Business Finance',
            'Principles of Marketing',
            'Principles of Management',
            'Organization and Management',
            'Entrepreneurship',
            'Applied Economics',
            'Basic Accounting',
        ],
        HUMSS: [
            'Philippine History',
            'World History',
            'Sociology',
            'Anthropology',
            'Economics',
            'Psychology',
            'Ethics',
            'Philippine Literature',
            'Contemporary Philippine Arts',
            'Philosophy of Man',
        ],
        GAS: [
            'General Mathematics',
            'General Science',
            'Oral Communication',
            'Reading and Writing',
            'Critical Thinking',
            'Logic',
            'Speaking and Listening',
            'Digital Literacy',
        ],
        TVL: [
            'ICT',
            'Computer Programming',
            'Basic Animation',
            'Contact Center Services',
            'Home Economics',
            'Cookery',
            'Bread and Pastry Production',
            'Electrical Installation and Maintenance',
            'Civil Works',
            'Agriculture Crop Production',
        ],
    };
}

// The DO 015, s. 2026 reporting scale. These five bands are the only
// descriptors in the system: teachers type a grade and the portal labels it.
function descriptor_bands_do015() {
    return [
        [90, 100.0, 'Advancing', 'Namumukod-tangi'],
        [80, 89.99, 'Benchmarking', 'Napamamalas'],
        [75, 79.99, 'Connecting', 'Natutungo'],
        [65, 74.99, 'Developing', 'Napauunlad'],
        [0, 64.99, 'Emerging', 'Nagsisimula'],
    ];
}

// ---------------------------------------------------------------
// SCHEMA (identical SQL to the PHP original)
// ---------------------------------------------------------------
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK(role IN ('student','teacher')),
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS students (
    user_id INTEGER PRIMARY KEY,
    student_number TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    section TEXT,
    profile_photo TEXT DEFAULT 'default.png',
    phone TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS teachers (
    user_id INTEGER PRIMARY KEY,
    employee_number TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    department TEXT,
    profile_photo TEXT DEFAULT 'default.png',
    office_hours TEXT,
    contact_email TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    section TEXT NOT NULL,
    school_year TEXT NOT NULL,
    description TEXT,
    join_code TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (teacher_id) REFERENCES teachers(user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS class_members (
    class_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (class_id, student_id),
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    due_date DATE NOT NULL,
    attachment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    file_url TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    score NUMERIC(5,2),
    feedback TEXT,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    date DATE NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('present','late','absent','excused')),
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attendance_unique ON attendance(class_id, student_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_class_date ON attendance(class_id, date);
CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    attachment TEXT,
    posted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    link TEXT DEFAULT '#',
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);
CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip);
CREATE TABLE IF NOT EXISTS academic_years (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL UNIQUE,
    start_date DATE,
    end_date DATE,
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    academic_year_id INTEGER NOT NULL,
    number INTEGER NOT NULL,
    label TEXT NOT NULL,
    start_date DATE,
    end_date DATE,
    weight NUMERIC(5,2) NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
    FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS descriptor_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    min_grade NUMERIC(5,2) NOT NULL,
    max_grade NUMERIC(5,2) NOT NULL,
    label_en TEXT NOT NULL,
    label_fil TEXT
);
CREATE TABLE IF NOT EXISTS term_clusters (
    class_id INTEGER NOT NULL,
    term_id INTEGER NOT NULL,
    cluster TEXT NOT NULL,
    subject TEXT NOT NULL,
    PRIMARY KEY (class_id, term_id),
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS term_grades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL,
    term_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    grade NUMERIC(5,2),
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (class_id, term_id, student_id),
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_term_grades_lookup ON term_grades (class_id, term_id);
CREATE TABLE IF NOT EXISTS class_term_status (
    class_id INTEGER NOT NULL,
    term_id INTEGER NOT NULL,
    published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (class_id, term_id),
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    old_value TEXT,
    new_value TEXT,
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    event_date DATE NOT NULL,
    end_date DATE,
    event_type TEXT NOT NULL DEFAULT 'event' CHECK(event_type IN ('holiday','exam','event','deadline','term_start','term_end','suspension')),
    term_id INTEGER,
    description TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_date ON calendar_events(event_date);
CREATE TABLE IF NOT EXISTS school_announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'all' CHECK(audience IN ('all','students','teachers')),
    posted_by INTEGER,
    posted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
`;

// Columns added after a table's first release (the PHP add_column() calls).
const EXTRA_COLUMNS = [
    ['users', 'status', "TEXT NOT NULL DEFAULT 'active'"],
    ['users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0'],
    ['classes', 'academic_year_id', 'INTEGER'],
    ['classes', 'current_term_id', 'INTEGER'],
    ['classes', 'cluster', 'TEXT'],
    // Advisory flag: exactly the class whose teacher is the SECTION adviser for
    // that school year. Only advisory classes may generate SF9 report cards.
    ['classes', 'is_advisory', 'INTEGER NOT NULL DEFAULT 0'],
    // Assignment submission policy (per-assignment file rules)
    ['assignments', 'requires_file', 'INTEGER NOT NULL DEFAULT 1'],
    ['assignments', 'allowed_exts', 'TEXT'],
    ['assignments', 'max_size_mb', 'NUMERIC(5,2) NOT NULL DEFAULT 10'],
    ['assignments', 'allow_late', 'INTEGER NOT NULL DEFAULT 1'],
    ['assignments', 'cutoff_date', 'DATE'],
    // Submission provenance
    ['submissions', 'original_name', 'TEXT'],
    ['submissions', 'is_late', 'INTEGER NOT NULL DEFAULT 0'],
    ['notifications', 'type', "TEXT DEFAULT 'general'"],
    ['login_attempts', 'email', 'TEXT'],
];

// ---------------------------------------------------------------
// MIGRATION: weighted gradebook -> per-term direct grades (schema v3)
// ---------------------------------------------------------------
// Existing activity scores are deliberately discarded rather than converted.
// A converted average would silently inherit the old category weights and
// present itself as a teacher-entered grade, which is not what it was.
async function migrate_to_direct_grading() {
    if (await db_column_exists('descriptor_rows', 'policy_id')) return;

    // Child tables first: the policies and categories cascade into these.
    for (const t of ['grade_scores', 'category_scores', 'grade_items', 'grade_categories',
        'transmutation_rows', 'grading_components', 'grading_policies']) {
        if (await db_table_exists(t)) await client.execute(`DROP TABLE IF EXISTS ${t}`);
    }

    // classes.grading_policy_id / grading_system become meaningless once there
    // is one grading model. Neither carries a foreign key, so DROP COLUMN works.
    for (const col of ['grading_policy_id', 'grading_system']) {
        if (await db_column_exists('classes', col)) {
            await client.execute(`ALTER TABLE classes DROP COLUMN ${col}`);
        }
    }
}

// ---------------------------------------------------------------
// MIGRATION: every academic year gets the DO 009 three-term calendar
// ---------------------------------------------------------------
async function ensure_three_terms() {
    const years = await all('SELECT id FROM academic_years');
    if (!years.length) return;
    for (const y of years) {
        const q = await all('SELECT number FROM terms WHERE academic_year_id=?', [y.id]);
        const have = q.map((r) => Number(r.number));
        for (const n of [1, 2, 3]) {
            if (!have.includes(n)) {
                await run("INSERT INTO terms (academic_year_id, number, label, weight, status) VALUES (?, ?, ?, 1, 'open')",
                    [y.id, n, 'Term ' + n]);
            }
        }
    }
}

// Legacy descriptor_rows.policy_id rebuild: collapse per-policy rows down to
// the single DO 015 scale.
async function rebuild_descriptors_if_legacy() {
    if (!(await db_table_exists('descriptor_rows'))) return;
    if (!(await db_column_exists('descriptor_rows', 'policy_id'))) return;
    await client.execute('PRAGMA foreign_keys=OFF');
    await client.execute('BEGIN');
    try {
        await client.execute('ALTER TABLE descriptor_rows RENAME TO descriptor_rows_old');
        await client.execute(`CREATE TABLE descriptor_rows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            min_grade NUMERIC(5,2) NOT NULL,
            max_grade NUMERIC(5,2) NOT NULL,
            label_en TEXT NOT NULL,
            label_fil TEXT
        )`);
        // Keep only rows on the DO 015 scale. The legacy DO 8 scale (Fairly
        // Satisfactory / Very Satisfactory / Outstanding) is intentionally dropped.
        await client.execute(`INSERT INTO descriptor_rows (min_grade, max_grade, label_en, label_fil)
            SELECT DISTINCT min_grade, max_grade, label_en, label_fil
            FROM descriptor_rows_old
            WHERE label_en IN ('Emerging','Developing','Connecting','Benchmarking','Advancing')
            ORDER BY min_grade`);
        await client.execute('DROP TABLE descriptor_rows_old');
        await client.execute('COMMIT');
    } catch (e) {
        await client.execute('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        await client.execute('PRAGMA foreign_keys=ON').catch(() => {});
    }
}

// ---------------------------------------------------------------
// SEEDING (runs once; idempotent per account like the PHP seed)
// ---------------------------------------------------------------
async function seed_once() {
    const c = await get('SELECT COUNT(*) AS n FROM academic_years');
    if (Number(c.n) > 0) return; // already seeded

    // ---- Legacy SY 2025-2026 (historical data holder) ----
    let r = await run("INSERT INTO academic_years (label, start_date, end_date, is_active) VALUES (?, ?, ?, 0)",
        ['2025-2026', '2025-06-09', '2026-04-10']);
    const legacy_year = r.lastId;
    r = await run("INSERT INTO terms (academic_year_id, number, label, start_date, end_date, status) VALUES (?, 0, 'SY 2025-2026', '2025-06-09', '2026-04-10', 'closed')",
        [legacy_year]);
    const legacy_term = r.lastId;

    // ---- Active SY 2026-2027 (three-term calendar, DO 009 s.2026) ----
    r = await run("INSERT INTO academic_years (label, start_date, end_date, is_active) VALUES (?, ?, ?, 1)",
        ['2026-2027', '2026-06-08', '2027-04-08']);
    const new_year = r.lastId;
    const term_defs = [
        [1, 'Term 1', '2026-06-08', '2026-09-04'],
        [2, 'Term 2', '2026-09-07', '2026-12-11'],
        [3, 'Term 3', '2027-01-04', '2027-04-08'],
    ];
    for (const t of term_defs) {
        await run("INSERT INTO terms (academic_year_id, number, label, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, 'open')",
            [new_year, t[0], t[1], t[2], t[3]]);
    }
    const tid = {};
    for (const n of [1, 2, 3]) {
        const row = await get('SELECT id FROM terms WHERE academic_year_id=? AND number=?', [new_year, n]);
        tid[n] = Number(row.id);
    }

    // ---- Settings ----
    const set = [
        ['school_name', 'School Portal'],
        ['registration_mode', 'open'],
        ['active_academic_year_id', String(new_year)],
        ['schema_version', '4'],
    ];
    for (const [k, v] of set) await run('INSERT INTO settings (key, value) VALUES (?,?)', [k, v]);

    // ---- Demo accounts ----
    const pass = bcrypt.hashSync('password123', 10);

    async function mkuser(email, role, admin = 0) {
        const chk = await get('SELECT id FROM users WHERE email=?', [email]);
        if (chk) return Number(chk.id);
        const ins = await run('INSERT INTO users (role, email, password, is_admin) VALUES (?,?,?,?)',
            [role, email, pass, admin]);
        return ins.lastId;
    }

    const admin_id = await mkuser('admin@school.com', 'teacher', 1);
    if (!Number((await get('SELECT COUNT(*) AS n FROM teachers WHERE user_id=?', [admin_id])).n)) {
        await run('INSERT INTO teachers (user_id, employee_number, full_name, department, contact_email) VALUES (?,?,?,?,?)',
            [admin_id, 'ADM-001', 'School Administrator', 'Administration', 'admin@school.com']);
    }

    const teacher_id = await mkuser('teacher@school.com', 'teacher');
    if (!Number((await get('SELECT COUNT(*) AS n FROM teachers WHERE user_id=?', [teacher_id])).n)) {
        await run('INSERT INTO teachers (user_id, employee_number, full_name, department, contact_email) VALUES (?,?,?,?,?)',
            [teacher_id, 'TCH-001', 'Juan Dela Cruz', 'Mathematics', 'teacher@school.com']);
    }

    const students = [
        ['student@school.com', 'STU-001', 'Alex Johnson', 'G11-FILO-A26'],
        ['student2@school.com', 'STU-002', 'Maria Garcia', 'G11-FILO-A26'],
        ['student3@school.com', 'STU-003', 'John Smith', 'G11-FILO-A26'],
        ['student4@school.com', 'STU-004', 'Sofia Reyes', 'G11-FILO-A26'],
    ];
    const sids = {};
    for (const s of students) {
        const uid = await mkuser(s[0], 'student');
        if (!Number((await get('SELECT COUNT(*) AS n FROM students WHERE user_id=?', [uid])).n)) {
            await run('INSERT INTO students (user_id, student_number, full_name, section) VALUES (?,?,?,?)',
                [uid, s[1], s[2], s[3]]);
        }
        sids[s[1]] = uid;
    }

    // ---- Demo classes ----
    async function mkclass(subject, section, year_label, year_id, term_id, desc, code) {
        const chk = await get('SELECT id FROM classes WHERE join_code=?', [code]);
        if (chk) return Number(chk.id);
        const ins = await run(
            'INSERT INTO classes (teacher_id, subject, section, school_year, description, join_code, academic_year_id, current_term_id) VALUES (?,?,?,?,?,?,?,?)',
            [teacher_id, subject, section, year_label, desc, code, year_id, term_id]);
        const cid = ins.lastId;
        for (const uid of Object.values(sids)) {
            await run('INSERT OR IGNORE INTO class_members (class_id, student_id) VALUES (?,?)', [cid, uid]);
        }
        return cid;
    }

    const filo = await mkclass('Filipino', 'FILO11A26', '2026-2027', new_year, tid[2], 'Filipino for Grade 11 - SY 2026-2027', 'FILO11A26');
    const gm = await mkclass('General Mathematics', 'G11MATH27', '2026-2027', new_year, tid[1], 'General Mathematics for Grade 11 STEM', 'G11MATH27');
    await mkclass('Science', '12-Organic', '2025-2026', legacy_year, legacy_term, 'Organic Chemistry - SY 2025-2026', '12ORGANIC');
    await mkclass('Mathematics', 'G11-MATH-A26', '2025-2026', legacy_year, legacy_term, 'Mathematics - SY 2025-2026', 'G11MATH26');

    // ---- Demo Term Grades ----
    // Filipino Term 2 is mid-entry on purpose: it shows the progress bar, the
    // "not yet published" state and a NULL grade in the same screen. Term 1 is
    // complete and published so the student report card has real content.
    const t1_grades = { STU_001: 89, STU_002: 84, STU_003: 77, STU_004: 92 };
    for (const [num, val] of Object.entries(t1_grades)) {
        await run('INSERT OR IGNORE INTO term_grades (class_id, term_id, student_id, grade) VALUES (?,?,?,?)',
            [filo, tid[1], sids[num.replace('_', '-')], val]);
    }
    await run('INSERT OR IGNORE INTO term_grades (class_id, term_id, student_id, grade) VALUES (?,?,?,?)', [filo, tid[2], sids['STU-001'], 87]);
    await run('INSERT OR IGNORE INTO term_grades (class_id, term_id, student_id, grade) VALUES (?,?,?,?)', [filo, tid[2], sids['STU-002'], 78]);
    await run('INSERT OR IGNORE INTO term_grades (class_id, term_id, student_id, grade) VALUES (?,?,?,?)', [filo, tid[2], sids['STU-004'], 91]);
    // STU-003 is deliberately left NULL: ungraded must render as a dash and
    // must never be counted as zero in the class average.

    const gm_grades = { STU_001: 94, STU_002: 88, STU_003: 91, STU_004: 86 };
    for (const [num, val] of Object.entries(gm_grades)) {
        await run('INSERT OR IGNORE INTO term_grades (class_id, term_id, student_id, grade) VALUES (?,?,?,?)',
            [gm, tid[1], sids[num.replace('_', '-')], val]);
    }

    // Term 1 of Filipino and General Mathematics is released to students.
    await run('INSERT OR IGNORE INTO class_term_status (class_id, term_id) VALUES (?,?)', [filo, tid[1]]);
    await run('INSERT OR IGNORE INTO class_term_status (class_id, term_id) VALUES (?,?)', [gm, tid[1]]);

    // ---- Seed calendar events (DO 009 s.2026 key dates) ----
    const evs = [
        ['Opening of Classes', '2026-06-08', 'term_start', tid[1], 'First day of Term 1, SY 2026-2027 (DO 009 s.2026)'],
        ['Term 1 Examination', '2026-08-28', 'exam', tid[1], 'Term 1 examination week (Aug 28 - Sep 1, 2026)'],
        ['Year-end Break', '2026-12-19', 'holiday', null, 'December 19 - 31, 2026'],
        ['Term 2 Examination', '2026-12-03', 'exam', null, 'Term 2 examinations (Dec 3-4, 2026)'],
        ['Resumption of Classes', '2027-01-04', 'term_start', null, 'Classes resume for Term 3'],
        ['Term 3 Examination', '2027-03-22', 'exam', null, 'Term 3 examinations (Mar 22-23, 2027)'],
        ['End of School Year Rites', '2027-04-06', 'event', null, 'EOSY rites (Apr 6-7, 2027)'],
    ];
    for (const e of evs) {
        await run('INSERT INTO calendar_events (title, event_date, event_type, term_id, description) VALUES (?,?,?,?,?)', e);
    }

    // ---- Demo notifications (one unread per demo user) ----
    const notifs = [
        [teacher_id, 'Filipino Term 2 is not yet published - one student is still ungraded.', 'dashboard.php?page=gradebook&class=1&term=2', 'grade'],
        [admin_id, 'School Portal is running schema v3 (direct Term Grades).', 'dashboard.php', 'system'],
    ];
    for (const uid of Object.values(sids)) {
        notifs.push([uid, 'Your Filipino Term 1 grades are now available.', 'dashboard.php?page=grades', 'grade']);
    }
    for (const n of notifs) {
        await run('INSERT INTO notifications (user_id, message, link, type) VALUES (?,?,?,?)', n);
    }
}

// ---------------------------------------------------------------
// BOOT (runs schema + seed + migrations exactly once per process)
// ---------------------------------------------------------------
let bootPromise = null;
function initDb() {
    if (!bootPromise) {
        bootPromise = (async () => {
            // Connection pragmas. Harmless if the remote engine declines them.
            for (const pragma of ['PRAGMA foreign_keys = ON', 'PRAGMA journal_mode = WAL']) {
                try { await client.execute(pragma); } catch (_) { /* remote may reject */ }
            }
            for (const stmt of SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
                await client.execute(stmt);
            }
            for (const [table, col, def] of EXTRA_COLUMNS) await add_column(table, col, def);
            // login_attempts.email is added by EXTRA_COLUMNS above, so its
            // index has to be created after that (the PHP original ordered it
            // the same way).
            await client.execute('CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email)');
            await rebuild_descriptors_if_legacy();
            // Empty descriptor table -> install the DO 015 scale.
            const dc = await get('SELECT COUNT(*) AS n FROM descriptor_rows');
            if (Number(dc.n) === 0) {
                for (const row of descriptor_bands_do015()) {
                    await run('INSERT INTO descriptor_rows (min_grade, max_grade, label_en, label_fil) VALUES (?,?,?,?)', row);
                }
            }
            await seed_once();
            await migrate_to_direct_grading();
            await ensure_three_terms();
        })();
    }
    return bootPromise;
}

module.exports = { client, all, get, run, exec, initDb, cluster_subjects, descriptor_bands_do015 };
