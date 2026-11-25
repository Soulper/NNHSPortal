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
-- Uploaded file bytes (Cloudflare Workers mode, DB_STORAGE=1). PHP and local
-- Node keep files on disk. On Workers they live here and are served through
-- the same access-controlled download route.
CREATE TABLE IF NOT EXISTS files (
    name TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
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

// ================================================================
// BOOT — gated + batched for Cloudflare Workers
// ================================================================
// Workers caps every invocation at 50 subrequests, and each remote libsql
// query is one subrequest. A naive boot (one query per statement) needs
// ~180 of them and dies on the free tier. The boot is therefore:
//
//   1. GATED: a warm isolate reads one settings row and skips everything.
//   2. SCHEMA: one write batch (all CREATE IF NOT EXISTS are idempotent).
//   3. INTROSPECTION: one client.batch('read') answers every existence
//      question (columns, indexes, seed rows) in a single subrequest.
//   4. SEED + MIGRATE: ONE write batch, made idempotent with
//      WHERE NOT EXISTS / INSERT OR IGNORE and natural-key subselects
//      (parent ids resolve server-side, so no read-back between inserts).
//      The boot_gate row is written last, inside the same transaction, so
//      a crashed boot is simply retried by the next cold isolate.
//
// Bump BOOT_VERSION whenever the schema/seed logic changes: established
// databases then re-run the full path exactly once.
// ================================================================
const BOOT_VERSION = '4';

// Tables from the pre-"direct grading" era; dropped once descriptor_rows
// lost its policy_id column (the SCHEMA_SQL above is the direct-grading
// shape). Children first, then parents.
const LEGACY_POLICY_TABLES = ['grade_scores', 'category_scores', 'grade_items',
    'grade_categories', 'transmutation_rows', 'grading_components', 'grading_policies'];

let bootPromise = null;
function initDb() {
    if (!bootPromise) bootPromise = boot();
    return bootPromise;
}

async function boot() {
    try {
        // ---- 0. gate: warm isolates stop here (1 subrequest) ----
        try {
            const gate = await get("SELECT value FROM settings WHERE key='boot_gate'");
            if (gate && gate.value === BOOT_VERSION) return;
        } catch (_) { /* settings table missing on a brand-new database */ }

        // ---- 1. connection pragmas (full boot only; remote may decline) ----
        for (const pragma of ['PRAGMA foreign_keys = ON', 'PRAGMA journal_mode = WAL']) {
            try { await client.execute(pragma); } catch (_) { /* remote may reject */ }
        }

        // ---- 2. schema (all idempotent, one write batch) ----
        // NOTE: the HTTP client's batch() requires every statement to carry an
        // args ARRAY (a missing/null args crashes stmtToHrana), so always pass
        // args: [] even for statements without parameters.
        await client.batch(
            SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean).map((sql) => ({ sql, args: [] })),
            'write');

        // ---- 3. introspection (one read batch) ----
        const probeSql = [];
        const probeKey = [];
        const P = (key, sql, args = []) => { probeKey.push(key); probeSql.push({ sql, args }); };
        const extraTables = [...new Set(EXTRA_COLUMNS.map(([t]) => t))];
        for (const t of extraTables) P('cols:' + t, `SELECT name FROM pragma_table_info('${t}')`);
        P('legacy_descriptor', "SELECT COUNT(*) AS n FROM pragma_table_info('descriptor_rows') WHERE name = 'policy_id'");
        for (const t of LEGACY_POLICY_TABLES) {
            P('table:' + t, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '" + t + "'");
        }
        P('idx_lae', "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_login_attempts_email'");
        P('descriptor_count', 'SELECT COUNT(*) AS n FROM descriptor_rows');
        const probeRes = await client.batch(probeSql, 'read');
        const R = {};
        probeKey.forEach((k, i) => { R[k] = probeRes[i]; });
        const cols = (t) => R['cols:' + t].rows.map((r) => String(r.name));

        // ---- 4. legacy rebuild: per-policy descriptor table -> single scale ----
        const legacyDescriptor = Number(R.legacy_descriptor.rows[0].n) > 0;
        if (legacyDescriptor) await rebuild_descriptors_if_legacy();

        // ---- 5. one idempotent write batch: migrate + seed + gate ----
        const B = [];
        const add = (sql, args = []) => B.push({ sql, args });

        // Columns added after a table's first release.
        for (const [table, col, def] of EXTRA_COLUMNS) {
            if (!cols(table).includes(col)) add(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
        }
        if (Number(R.idx_lae.rows[0].n) === 0) {
            add('CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email)');
        }
        // Legacy policy-era tables: children first, then parents; then the
        // now-meaningless class columns (neither carries a foreign key).
        for (const t of LEGACY_POLICY_TABLES) {
            if (Number(R['table:' + t].rows[0].n) > 0) add(`DROP TABLE IF EXISTS ${t}`);
        }
        if (cols('classes').includes('grading_policy_id')) add('ALTER TABLE classes DROP COLUMN grading_policy_id');
        if (cols('classes').includes('grading_system')) add('ALTER TABLE classes DROP COLUMN grading_system');
        // DO 015 descriptor scale for an empty (or just-rebuilt) table.
        if (Number(R.descriptor_count.rows[0].n) === 0 || legacyDescriptor) {
            for (const row of descriptor_bands_do015()) {
                add('INSERT INTO descriptor_rows (min_grade, max_grade, label_en, label_fil) VALUES (?,?,?,?)', row);
            }
        }

        // ---- academic years + terms (idempotent) ----
        add("INSERT INTO academic_years (label, start_date, end_date, is_active) SELECT '2025-2026', '2025-06-09', '2026-04-10', 0 WHERE NOT EXISTS (SELECT 1 FROM academic_years WHERE label = '2025-2026')");
        add("INSERT INTO terms (academic_year_id, number, label, start_date, end_date, status) SELECT id, 0, 'SY 2025-2026', '2025-06-09', '2026-04-10', 'closed' FROM academic_years WHERE label = '2025-2026' AND NOT EXISTS (SELECT 1 FROM terms WHERE academic_year_id = academic_years.id AND number = 0)");
        add("INSERT INTO academic_years (label, start_date, end_date, is_active) SELECT '2026-2027', '2026-06-08', '2027-04-08', 1 WHERE NOT EXISTS (SELECT 1 FROM academic_years WHERE label = '2026-2027')");
        for (const [num, label, start, end] of [
            [1, 'Term 1', '2026-06-08', '2026-09-04'],
            [2, 'Term 2', '2026-09-07', '2026-12-11'],
            [3, 'Term 3', '2027-01-04', '2027-04-08'],
        ]) {
            add("INSERT INTO terms (academic_year_id, number, label, start_date, end_date, status) SELECT id, ?, ?, ?, ?, 'open' FROM academic_years WHERE label = '2026-2027' AND NOT EXISTS (SELECT 1 FROM terms WHERE academic_year_id = academic_years.id AND number = ?)",
                [num, label, start, end, num]);
        }
        // DO 009 three-term calendar for every year still missing terms.
        for (const label of ['2025-2026', '2026-2027']) {
            for (const n of [1, 2, 3]) {
                add("INSERT INTO terms (academic_year_id, number, label, weight, status) SELECT id, ?, 'Term ' || ?, 1, 'open' FROM academic_years WHERE label = ? AND NOT EXISTS (SELECT 1 FROM terms WHERE academic_year_id = academic_years.id AND number = ?)",
                    [n, n, label, n]);
            }
        }

        // ---- settings ----
        add("INSERT INTO settings (key, value) VALUES ('school_name', 'School Portal') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
        add("INSERT INTO settings (key, value) VALUES ('registration_mode', 'open') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
        add("INSERT INTO settings (key, value) VALUES ('active_academic_year_id', (SELECT CAST(id AS TEXT) FROM academic_years WHERE label = '2026-2027')) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
        add("INSERT INTO settings (key, value) VALUES ('schema_version', '4') ON CONFLICT(key) DO UPDATE SET value = excluded.value");

        // ---- demo accounts (idempotent per email) ----
        const pass = bcrypt.hashSync('password123', 10);
        const mkuser = (email, role, admin) => add(
            'INSERT INTO users (role, email, password, is_admin) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ?)',
            [role, email, pass, admin, email]);
        mkuser('admin@school.com', 'teacher', 1);
        mkuser('teacher@school.com', 'teacher', 0);
        add("INSERT INTO teachers (user_id, employee_number, full_name, department, contact_email) SELECT u.id, 'ADM-001', 'School Administrator', 'Administration', 'admin@school.com' FROM users u WHERE u.email = 'admin@school.com' AND NOT EXISTS (SELECT 1 FROM teachers t WHERE t.user_id = u.id)");
        add("INSERT INTO teachers (user_id, employee_number, full_name, department, contact_email) SELECT u.id, 'TCH-001', 'Juan Dela Cruz', 'Mathematics', 'teacher@school.com' FROM users u WHERE u.email = 'teacher@school.com' AND NOT EXISTS (SELECT 1 FROM teachers t WHERE t.user_id = u.id)");
        const demo_students = [
            ['student@school.com', 'STU-001', 'Alex Johnson', 'G11-FILO-A26'],
            ['student2@school.com', 'STU-002', 'Maria Garcia', 'G11-FILO-A26'],
            ['student3@school.com', 'STU-003', 'John Smith', 'G11-FILO-A26'],
            ['student4@school.com', 'STU-004', 'Sofia Reyes', 'G11-FILO-A26'],
        ];
        for (const [email, number, name, section] of demo_students) {
            mkuser(email, 'student', 0);
            add('INSERT INTO students (user_id, student_number, full_name, section) SELECT u.id, ?, ?, ? FROM users u WHERE u.email = ? AND NOT EXISTS (SELECT 1 FROM students s WHERE s.user_id = u.id)',
                [number, name, section, email]);
        }

        // ---- demo classes (idempotent per join code) ----
        const mkclass = (subject, section, yearLabel, termNum, desc, code) => add(
            'INSERT INTO classes (teacher_id, subject, section, school_year, description, join_code, academic_year_id, current_term_id) ' +
            "SELECT (SELECT t.user_id FROM teachers t JOIN users u ON u.id = t.user_id WHERE u.email = 'teacher@school.com'), ?, ?, ?, ?, ?, " +
            '(SELECT id FROM academic_years WHERE label = ?), ' +
            '(SELECT id FROM terms WHERE academic_year_id = (SELECT id FROM academic_years WHERE label = ?) AND number = ?) ' +
            'WHERE NOT EXISTS (SELECT 1 FROM classes WHERE join_code = ?)',
            [subject, section, yearLabel, desc, code, yearLabel, yearLabel, termNum, code]);
        mkclass('Filipino', 'FILO11A26', '2026-2027', 2, 'Filipino for Grade 11 - SY 2026-2027', 'FILO11A26');
        mkclass('General Mathematics', 'G11MATH27', '2026-2027', 1, 'General Mathematics for Grade 11 STEM', 'G11MATH27');
        mkclass('Science', '12-Organic', '2025-2026', 0, 'Organic Chemistry - SY 2025-2026', '12ORGANIC');
        mkclass('Mathematics', 'G11-MATH-A26', '2025-2026', 0, 'Mathematics - SY 2025-2026', 'G11MATH26');
        for (const code of ['FILO11A26', 'G11MATH27', '12ORGANIC', 'G11MATH26']) {
            add("INSERT OR IGNORE INTO class_members (class_id, student_id) SELECT c.id, u.id FROM classes c JOIN users u ON u.role = 'student' WHERE c.join_code = ?", [code]);
        }

        // ---- demo term grades ----
        // Filipino Term 2 is mid-entry on purpose (progress bar + one NULL);
        // Term 1 is complete and published so report cards have content.
        const tg = (code, termNum, email, grade) => add(
            'INSERT OR IGNORE INTO term_grades (class_id, term_id, student_id, grade) ' +
            'SELECT c.id, t.id, u.id, ? FROM classes c JOIN terms t ON t.academic_year_id = c.academic_year_id AND t.number = ? ' +
            'JOIN users u ON u.email = ? WHERE c.join_code = ?',
            [grade, termNum, email, code]);
        tg('FILO11A26', 1, 'student@school.com', 89);
        tg('FILO11A26', 1, 'student2@school.com', 84);
        tg('FILO11A26', 1, 'student3@school.com', 77);
        tg('FILO11A26', 1, 'student4@school.com', 92);
        tg('FILO11A26', 2, 'student@school.com', 87);
        tg('FILO11A26', 2, 'student2@school.com', 78);
        // student3 is deliberately left NULL for Filipino Term 2: ungraded must
        // render as a dash and never count as zero in the class average.
        tg('FILO11A26', 2, 'student4@school.com', 91);
        tg('G11MATH27', 1, 'student@school.com', 94);
        tg('G11MATH27', 1, 'student2@school.com', 88);
        tg('G11MATH27', 1, 'student3@school.com', 91);
        tg('G11MATH27', 1, 'student4@school.com', 86);
        // Term 1 of Filipino and General Mathematics is released to students.
        add("INSERT OR IGNORE INTO class_term_status (class_id, term_id) SELECT c.id, t.id FROM classes c JOIN terms t ON t.academic_year_id = c.academic_year_id AND t.number = 1 WHERE c.join_code IN ('FILO11A26', 'G11MATH27')");

        // ---- calendar events (DO 009 s.2026 key dates) ----
        const ev = (title, date, type, termNum, desc) => add(
            'INSERT INTO calendar_events (title, event_date, event_type, term_id, description) ' +
            "SELECT ?, ?, ?, " + (termNum ? "(SELECT id FROM terms WHERE academic_year_id = (SELECT id FROM academic_years WHERE label = '2026-2027') AND number = ?)" : 'NULL') + ", ? " +
            'WHERE NOT EXISTS (SELECT 1 FROM calendar_events WHERE title = ? AND event_date = ?)',
            termNum ? [title, date, type, termNum, desc, title, date] : [title, date, type, desc, title, date]);
        ev('Opening of Classes', '2026-06-08', 'term_start', 1, 'First day of Term 1, SY 2026-2027 (DO 009 s.2026)');
        ev('Term 1 Examination', '2026-08-28', 'exam', 1, 'Term 1 examination week (Aug 28 - Sep 1, 2026)');
        ev('Year-end Break', '2026-12-19', 'holiday', null, 'December 19 - 31, 2026');
        ev('Term 2 Examination', '2026-12-03', 'exam', null, 'Term 2 examinations (Dec 3-4, 2026)');
        ev('Resumption of Classes', '2027-01-04', 'term_start', null, 'Classes resume for Term 3');
        ev('Term 3 Examination', '2027-03-22', 'exam', null, 'Term 3 examinations (Mar 22-23, 2027)');
        ev('End of School Year Rites', '2027-04-06', 'event', null, 'EOSY rites (Apr 6-7, 2027)');

        // ---- demo notifications (one unread per demo user) ----
        const notif = (email, message, link, type) => add(
            'INSERT INTO notifications (user_id, message, link, type) ' +
            'SELECT u.id, ?, ?, ? FROM users u WHERE u.email = ? AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.message = ?)',
            [message, link, type, email, message]);
        notif('teacher@school.com', 'Filipino Term 2 is not yet published - one student is still ungraded.', 'dashboard.php?page=gradebook&class=1&term=2', 'grade');
        notif('admin@school.com', 'School Portal is running schema v3 (direct Term Grades).', 'dashboard.php', 'system');
        for (const [email] of demo_students) {
            notif(email, 'Your Filipino Term 1 grades are now available.', 'dashboard.php?page=grades', 'grade');
        }

        // ---- gate LAST, inside the same transaction ----
        add("INSERT INTO settings (key, value) VALUES ('boot_gate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [BOOT_VERSION]);

        await client.batch(B, 'write');
    } catch (e) {
        // Two cold isolates can race this boot on a brand-new remote database;
        // UNIQUE constraints let exactly one win. If the winner finished, its
        // gate is set and the loser can simply move on.
        const gate = await get("SELECT value FROM settings WHERE key='boot_gate'").catch(() => null);
        if (gate && gate.value === BOOT_VERSION) return;
        throw e;
    }
}

// Legacy descriptor_rows.policy_id rebuild: collapse per-policy rows down to
// the single DO 015 scale. Rare path (pre-direct-grading databases only).
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

module.exports = { client, all, get, run, exec, initDb, cluster_subjects, descriptor_bands_do015 };
