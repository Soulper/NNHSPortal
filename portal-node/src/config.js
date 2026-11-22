// ================================================================
// SESSION / AUTH / SHARED HELPERS (port of config.php)
// ================================================================
// PHP's $_SESSION is a signed cookie session here (cookie-session). The
// session payload is tiny - user id, role, name, CSRF token, flash message -
// which is what makes it survive Vercel's serverless model.
// ================================================================
const crypto = require('crypto');
const { all, get, run } = require('./db');
const { trim_num } = require('./grade-engine');

// ---------------------------------------------------------------
// ESCAPING + GRADE DISPLAY HELPERS (shared by teacher grid + student card)
// ---------------------------------------------------------------
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// The numeric grade, or a dash when the student has not been graded.
// Callers pass `has` so that a grade of 0 renders as "0", not as a dash.
// Returns an already-escaped string (templates use <%- %> or <%= %> freely).
function rc_grade(grade, has = true) {
    if (!has || grade === null || grade === undefined || grade === '') return '&mdash;';
    return esc(trim_num(grade));
}

// The DO 015 descriptor word for a grade.
function rc_label(descriptor, has = true) {
    if (!has || descriptor === null || descriptor === undefined || descriptor === '') return '&mdash;';
    return esc(String(descriptor));
}

// Pass/fail chip. `graded` distinguishes "not graded yet" from "graded 60",
// because both are a failure but only one is a student who still owes work.
// Returns raw HTML (templates must print it with <%- %>).
function rc_result(passed, graded = true) {
    if (!graded) return '<span class="rc-chip rc-none">Not graded</span>';
    if (passed) return '<span class="rc-chip rc-pass">Passed</span>';
    return '<span class="rc-chip rc-fail">Failed</span>';
}

// Colour a grade cell by its descriptor band. Returns a CSS class.
function rc_grade_class(grade, graded = true) {
    if (!graded || grade === null || grade === undefined || grade === '') return 'rc-g-none';
    const g = Number(grade);
    if (g >= 90) return 'rc-g-advancing';
    if (g >= 80) return 'rc-g-benchmarking';
    if (g >= 75) return 'rc-g-connecting';
    if (g >= 65) return 'rc-g-developing';
    return 'rc-g-emerging';
}

// ---------------------------------------------------------------
// UI HELPER — clean inline stroke icons (feather-style, 24x24)
// ---------------------------------------------------------------
const ICONS = {
    school: '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/>',
    book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    award: '<circle cx="12" cy="8" r="6"/><path d="M15.5 13l1.5 9-5-3-5 3 1.5-9"/>',
    clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
};

function icon(name, size = 22) {
    const d = ICONS[name] || ICONS.book;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + Number(size) + '" height="' + Number(size)
        + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'
        + ' stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
}

// ---------------------------------------------------------------
// SESSION HELPERS (the $_SESSION accessors)
// ---------------------------------------------------------------
function current_user_id(req) { return (req.session && req.session.user_id) || 0; }
function current_role(req) { return (req.session && req.session.role) || ''; }
function is_admin_user(req) { return !!(req.session && req.session.is_admin); }

function csrf_token(req) {
    return (req.session && req.session.csrf) || '';
}

// Emits the CSRF hidden field. Rendered server-side so a form still submits
// when JavaScript is unavailable - script.js injects the same token into every
// other form, but anything that must work without JS has to render it here.
function csrf_field(req) {
    return '<input type="hidden" name="csrf_token" value="' + esc(csrf_token(req)) + '">';
}

// hash_equals() equivalent - constant-time compare.
function hash_equals(a, b) {
    const ba = Buffer.from(String(a ?? ''));
    const bb = Buffer.from(String(b ?? ''));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

// Per-route CSRF verification (the PHP app checks it in each context so the
// failure behaviour can differ: inline error on auth pages, flash+redirect on
// dashboard actions, 419 JSON on the autosave endpoint).
function csrf_ok(req) {
    const sent = (req.body && req.body.csrf_token) || req.get('X-CSRF-Token') || '';
    return hash_equals(csrf_token(req), sent);
}

// ---------------------------------------------------------------
// ACCESS MIDDLEWARE
// ---------------------------------------------------------------
function require_login(req, res, next) {
    if (!req.session || !req.session.user_id) return res.redirect('/login.php');
    next();
}

function require_admin(req, res, next) {
    if (!req.session || !req.session.user_id) return res.redirect('/login.php');
    if (!req.session.is_admin) return res.redirect('/dashboard.php');
    next();
}

// ---------------------------------------------------------------
// FLASH
// ---------------------------------------------------------------
function flash(req, msg, type = 'success') {
    const allowed = ['success', 'danger', 'info', 'warning'];
    if (!allowed.includes(type)) type = 'info';
    req.session.flash = msg;
    req.session.flash_type = type;
}

// Middleware that pops the flash into res.locals once, then clears it.
function flash_middleware(req, res, next) {
    res.locals.flash = (req.session && req.session.flash) || null;
    res.locals.flash_type = (req.session && req.session.flash_type) || 'info';
    if (req.session) { delete req.session.flash; delete req.session.flash_type; }
    next();
}

// ---------------------------------------------------------------
// SESSION BOOTSTRAP MIDDLEWARE
// ---------------------------------------------------------------
function session_middleware(req, res, next) {
    if (!req.session) req.session = {};
    if (!req.session.csrf) {
        req.session.csrf = crypto.randomBytes(32).toString('hex');
    }
    // Convenience accessors for templates and handlers.
    res.locals.session = req.session;
    res.locals.user_id = current_user_id(req);
    res.locals.role = current_role(req);
    res.locals.is_admin = is_admin_user(req);
    res.locals.full_name = (req.session && req.session.full_name) || 'User';
    res.locals.csrf = csrf_token(req);
    res.locals.csrf_field = csrf_field(req);
    res.locals.year = current_year();
    res.locals.h = {
        esc, rc_grade, rc_label, rc_result, rc_grade_class, icon, trim_num,
    };
    next();
}

// ---------------------------------------------------------------
// SETTINGS / NOTIFICATIONS / AUDIT (db-backed, like config.php)
// ---------------------------------------------------------------
async function setting(db, key, def = '') {
    const row = await get('SELECT value FROM settings WHERE key=?', [key]);
    return row ? row.value : def;
}

async function set_setting(db, key, value) {
    await run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        [key, value]);
}

async function notify(db, user_id, message, link = '#', type = 'general') {
    await run('INSERT INTO notifications (user_id, message, link, type) VALUES (?, ?, ?, ?)',
        [user_id, message, link, type]);
}

async function notify_class_students(db, class_id, message, link = '#', type = 'general') {
    const m = await all('SELECT student_id FROM class_members WHERE class_id=?', [class_id]);
    for (const r of m) await notify(db, r.student_id, message, link, type);
}

async function audit(db, req, action, target_type = null, target_id = null, old_value = null, new_value = null) {
    await run(
        'INSERT INTO audit_logs (user_id, action, target_type, target_id, old_value, new_value, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [current_user_id(req) || null, action, target_type, target_id, old_value, new_value,
         req.ip || req.socket?.remoteAddress || '']);
}

async function unread_count(db, user_id) {
    const r = await get('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND is_read=0', [user_id]);
    return Number(r.n);
}

// ---------------------------------------------------------------
// ACCESS CHECKS
// ---------------------------------------------------------------
async function teacher_owns_class(db, teacher_id, class_id) {
    const r = await get('SELECT COUNT(*) AS n FROM classes WHERE id=? AND teacher_id=?', [class_id, teacher_id]);
    return Number(r.n) > 0;
}

async function student_in_class(db, student_id, class_id) {
    const r = await get('SELECT COUNT(*) AS n FROM class_members WHERE class_id=? AND student_id=?', [class_id, student_id]);
    return Number(r.n) > 0;
}

// ---------------------------------------------------------------
// DEPLOYMENT PATHS
// ---------------------------------------------------------------
// Absolute URL of the deployment, used to build links. Optional.
function app_base_url() {
    const b = process.env.APP_URL || '';
    return b.replace(/\/+$/, '');
}

// The app clock runs on school time (Asia/Manila) so due-date / cutoff /
// is-late comparisons match the dates teachers enter. PHP set this with
// date_default_timezone_set(); here the same zone is applied to the few
// places that compare "today" against a date column.
function today(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date); // YYYY-MM-DD
}

function current_year() {
    return new Intl.DateTimeFormat('en', { timeZone: 'Asia/Manila', year: 'numeric' }).format(new Date());
}

module.exports = {
    esc, rc_grade, rc_label, rc_result, rc_grade_class, icon,
    current_user_id, current_role, is_admin_user,
    csrf_token, csrf_field, csrf_ok, hash_equals,
    require_login, require_admin, flash, flash_middleware, session_middleware,
    setting, set_setting, notify, notify_class_students, audit, unread_count,
    teacher_owns_class, student_in_class,
    app_base_url, today, current_year,
};
