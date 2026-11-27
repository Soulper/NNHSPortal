// ================================================================
// ENROLLMENT HELPERS — shared by Admin Users, Enrollments, Classes
// ================================================================

const { all, get, run, client } = require('./db');
const { setting } = require('./config');
const crypto = require('crypto');

// Parse CSV upload (handles quoted fields, commas, newlines)
function parse_enrollment_csv(file) {
    if (!file || file.error !== 0) {
        return { rows: [], error: 'No file uploaded or upload error.' };
    }
    if (file.size > 2 * 1024 * 1024) {
        return { rows: [], error: 'File too large (max 2MB).' };
    }
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (ext !== 'csv') {
        return { rows: [], error: 'File must be a .csv' };
    }

    const content = file.buffer.toString('utf8');
    const lines = content.trim().split('\n');
    if (lines.length < 1) {
        return { rows: [], error: 'Empty CSV.' };
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        // Simple CSV parse (handles basic cases)
        const values = line.split(',').map(v => v.trim());
        if (values.length !== headers.length) continue;
        const row = {};
        headers.forEach((h, i) => { row[h] = values[i]; });
        row._line = i;
        rows.push(row);
    }
    return { rows, error: '' };
}

// Generate secure random password (12 chars: upper, lower, digit, symbol)
function generate_password(length = 12) {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const digits = '23456789';
    const symbols = '!@#$%^&*';
    const all = upper + lower + digits + symbols;
    let pwd = '';
    pwd += upper[Math.floor(Math.random() * upper.length)];
    pwd += lower[Math.floor(Math.random() * lower.length)];
    pwd += digits[Math.floor(Math.random() * digits.length)];
    pwd += symbols[Math.floor(Math.random() * symbols.length)];
    for (let i = 4; i < length; i++) {
        pwd += all[Math.floor(Math.random() * all.length)];
    }
    // Fisher-Yates shuffle
    const arr = pwd.split('');
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.join('');
}

// Validate student CSV row
async function validate_student_row(db, row, active_year_id, seen_numbers, seen_emails) {
    const errors = [];

    const student_number = String(row.student_number ?? '').trim();
    const full_name = String(row.full_name ?? '').trim();
    const email = String(row.email ?? '').trim();
    const section = String(row.section ?? '').trim();
    const password = String(row.password ?? '').trim();

    if (!student_number) errors.push('Missing student_number');
    else if (!/^[A-Za-z0-9\-]{1,50}$/.test(student_number)) errors.push('Invalid student_number format');
    else if (seen_numbers[student_number]) errors.push('Duplicate student_number in CSV');
    else if (Number(await get('SELECT COUNT(*) AS n FROM students WHERE student_number=?', [student_number]).then(r => r.n)) > 0) errors.push('student_number already exists');

    if (!full_name) errors.push('Missing full_name');
    else if (full_name.length > 100) errors.push('full_name too long');

    if (email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Invalid email');
        else if (seen_emails[email]) errors.push('Duplicate email in CSV');
        else if (Number(await get('SELECT COUNT(*) AS n FROM users WHERE email=?', [email]).then(r => r.n)) > 0) errors.push('Email already registered');
    }

    if (!section) errors.push('Missing section');
    else if (!/^[A-Za-z0-9\-]{1,20}$/.test(section)) errors.push('Invalid section format');

    // Check section has classes in active academic year
    if (section && active_year_id) {
        const cls = await get('SELECT COUNT(*) AS n FROM classes WHERE section=? AND academic_year_id=? AND status=\'active\'', [section, active_year_id]);
        if (Number(cls.n) === 0) {
            errors.push("Section '" + section + "' has no active classes in the current academic year");
        }
    }

    if (password && password.length < 8) errors.push('Password must be at least 8 characters');

    return errors;
}

// Validate teacher CSV row
async function validate_teacher_row(db, row, seen_numbers, seen_emails) {
    const errors = [];

    const employee_number = String(row.employee_number ?? '').trim();
    const full_name = String(row.full_name ?? '').trim();
    const email = String(row.email ?? '').trim();
    const department = String(row.department ?? '').trim();
    const password = String(row.password ?? '').trim();

    if (!employee_number) errors.push('Missing employee_number');
    else if (!/^[A-Za-z0-9\-]{1,30}$/.test(employee_number)) errors.push('Invalid employee_number format');
    else if (seen_numbers[employee_number]) errors.push('Duplicate employee_number in CSV');
    else if (Number(await get('SELECT COUNT(*) AS n FROM teachers WHERE employee_number=?', [employee_number]).then(r => r.n)) > 0) errors.push('employee_number already exists');

    if (!full_name) errors.push('Missing full_name');
    else if (full_name.length > 100) errors.push('full_name too long');

    if (!email) errors.push('Missing email');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Invalid email');
    else if (seen_emails[email]) errors.push('Duplicate email in CSV');
    else if (Number(await get('SELECT COUNT(*) AS n FROM users WHERE email=?', [email]).then(r => r.n)) > 0) errors.push('Email already registered');

    if (password && password.length < 8) errors.push('Password must be at least 8 characters');

    return errors;
}

// Create student account (user + student profile)
async function create_student_account(db, student_number, full_name, email, section, password = '') {
    const pwd = password || generate_password();
    const hashed = await require('bcryptjs').hash(pwd, 10);
    const regMode = await setting(client, 'registration_mode', 'open');
    const status = regMode === 'approval' ? 'pending' : 'active';

    const r = await run('INSERT INTO users (role, email, password, status) VALUES (\'student\', ?, ?, ?)', [email || null, hashed, status]);
    const user_id = Number(r.lastId);

    await run('INSERT INTO students (user_id, student_number, full_name, section) VALUES (?, ?, ?, ?)',
        [user_id, student_number, full_name, section]);

    return { user_id, password: pwd, status };
}

// Create teacher account (user + teacher profile)
async function create_teacher_account(db, employee_number, full_name, email, department, password = '') {
    const pwd = password || generate_password();
    const hashed = await require('bcryptjs').hash(pwd, 10);

    const r = await run('INSERT INTO users (role, email, password, status) VALUES (\'teacher\', ?, ?, \'active\')', [email, hashed]);
    const user_id = Number(r.lastId);

    await run('INSERT INTO teachers (user_id, employee_number, full_name, department, contact_email) VALUES (?, ?, ?, ?, ?)',
        [user_id, employee_number, full_name, department, email]);

    return { user_id, password: pwd };
}

// Enroll student in all active classes of their section for the active academic year
async function enroll_student_in_section(db, student_user_id, section, active_year_id) {
    const class_ids = await all('SELECT id FROM classes WHERE section=? AND academic_year_id=? AND status=\'active\'', [section, active_year_id]);
    const ids = class_ids.map(c => Number(c.id));

    let enrolled = 0;
    for (const cid of ids) {
        const existing = await get('SELECT COUNT(*) AS n FROM class_members WHERE class_id=? AND student_id=?', [cid, student_user_id]);
        if (Number(existing.n) === 0) {
            await run('INSERT INTO class_members (class_id, student_id) VALUES (?, ?)', [cid, student_user_id]);
            enrolled++;
        }
    }
    return enrolled;
}

// Get active academic year ID
async function get_active_year_id(db) {
    const yid = Number(await setting(client, 'active_academic_year_id', ''));
    if (yid) return yid;
    const row = await get('SELECT id FROM academic_years WHERE is_active=1 LIMIT 1');
    return row ? Number(row.id) : 0;
}

// Find policy ID by name
async function find_policy_id(db, policy_name) {
    const row = await get('SELECT id FROM grading_policies WHERE name=? AND is_active=1', [policy_name]);
    return row ? Number(row.id) : 0;
}

// Find teacher ID by email
async function find_teacher_id_by_email(db, email) {
    const row = await get('SELECT t.user_id FROM teachers t JOIN users u ON u.id=t.user_id WHERE u.email=? AND u.status=\'active\'', [email]);
    return row ? Number(row.user_id) : 0;
}

// Get all active classes for a section/year
async function get_classes_for_section(db, section, year_id) {
    return all('SELECT id, subject FROM classes WHERE section=? AND academic_year_id=? AND status=\'active\' ORDER BY subject', [section, year_id]);
}

// Get students in a section not yet enrolled in any class of that section/year
async function get_unenrolled_students_in_section(db, section, year_id) {
    // Students with this section
    const stu = await all('SELECT s.user_id, s.full_name, s.student_number FROM students s JOIN users u ON u.id=s.user_id WHERE s.section=? AND u.status=\'active\'', [section]);

    // Classes for this section/year
    const class_ids = await all('SELECT id FROM classes WHERE section=? AND academic_year_id=? AND status=\'active\'', [section, year_id]);
    const cids = class_ids.map(c => Number(c.id));
    if (!cids.length) return [];

    // Already enrolled
    const placeholders = cids.map(() => '?').join(',');
    const enr = await all('SELECT DISTINCT student_id FROM class_members WHERE class_id IN (' + placeholders + ')', cids);
    const enrolled_ids = new Set(enr.map(e => Number(e.student_id)));

    // Return unenrolled
    return stu.filter(s => !enrolled_ids.has(Number(s.user_id)));
}

// Build enrollment CSV template
function build_student_csv_template() {
    return 'student_number,full_name,email,section,password\n2027-00001,"Dela Cruz, Juan",juan.dc@school.edu,G11-A,\n2027-00002,"Garcia, Maria",maria.g@school.edu,G11-A,\n';
}

function build_teacher_csv_template() {
    return 'employee_number,full_name,email,department,password\nTCH-001,"Reyes, Ana",ana.reyes@school.edu,Mathematics,\nTCH-002,"Santos, Carlo",carlo.s@school.edu,Language,\n';
}

function build_class_csv_template() {
    return 'subject,sections,teacher_email,policy_name\nGeneral Mathematics,"G11-A,G11-B",ana.reyes@school.edu,"DO 015 SHS Academic Core"\nFilipino,"G11-A,G11-B",carlo.s@school.edu,"DO 015 SHS Academic Core"\n';
}

module.exports = {
    parse_enrollment_csv,
    validate_student_row,
    validate_teacher_row,
    create_student_account,
    create_teacher_account,
    enroll_student_in_section,
    get_active_year_id,
    find_policy_id,
    find_teacher_id_by_email,
    get_classes_for_section,
    get_unenrolled_students_in_section,
    build_student_csv_template,
    build_teacher_csv_template,
    build_class_csv_template,
};