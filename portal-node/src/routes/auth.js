// ================================================================
// AUTH ROUTES (ports of index.php, login.php, register.php, logout.php)
// ================================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run } = require('../db');
const {
    current_user_id, csrf_ok, setting, audit, flash,
} = require('../config');

const router = express.Router();

// ---------------------------------------------------------------
// / - front door (index.php)
// ---------------------------------------------------------------
router.get('/', (req, res) => {
    res.redirect(current_user_id(req) ? '/dashboard.php' : '/login.php');
});

// ---------------------------------------------------------------
// LOGIN (login.php)
// ---------------------------------------------------------------
router.get('/login.php', (req, res) => {
    if (current_user_id(req)) return res.redirect('/dashboard.php');
    res.render('auth/login', { error: '' });
});

router.post('/login.php', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim();
    const password = String((req.body && req.body.password) || '');
    let error = '';

    if (!csrf_ok(req)) {
        error = 'Your session expired. Please try again.';
    } else {
        const ip = req.ip || '';
        try {
            // Throttle: per-IP AND per-email (5 failures in 15 minutes)
            const attempts = await get(
                "SELECT COUNT(*) AS n FROM login_attempts WHERE (ip=? OR email=?) AND attempted_at >= datetime('now', '-15 minutes')",
                [ip, email]);
            if (Number(attempts.n) >= 5) {
                error = 'Too many failed attempts. Please try again in 15 minutes.';
            } else if (email && password) {
                const user = await get('SELECT * FROM users WHERE email = ?', [email]);
                if (user && bcrypt.compareSync(password, String(user.password || ''))) {
                    const status = user.status || 'active';
                    if (status === 'disabled') {
                        error = 'This account has been disabled. Contact the administrator.';
                    } else if (status === 'pending') {
                        error = 'Your account is pending approval. Please wait for the administrator to activate it.';
                    } else {
                        await run('DELETE FROM login_attempts WHERE ip=? OR email=?', [ip, email]);
                        // PHP called session_regenerate_id(true) here; the cookie
                        // session keeps its CSRF token and gains the user identity.
                        req.session.user_id = user.id;
                        req.session.role = user.role;
                        req.session.is_admin = Number(user.is_admin || 0);

                        const info = user.role === 'teacher'
                            ? await get('SELECT full_name FROM teachers WHERE user_id = ?', [user.id])
                            : await get('SELECT full_name FROM students WHERE user_id = ?', [user.id]);
                        req.session.full_name = (info && info.full_name) || 'User';

                        await audit(null, req, 'login', 'users', user.id);
                        return res.redirect(req.session.is_admin ? '/admin.php' : '/dashboard.php');
                    }
                } else {
                    await run('INSERT INTO login_attempts (ip, email) VALUES (?, ?)', [ip, email]);
                    error = 'Invalid email or password.';
                }
            } else {
                error = 'Please fill in all fields.';
            }
        } catch (e) {
            console.error(e);
            error = 'Something went wrong. Please try again.';
        }
    }
    res.render('auth/login', { error });
});

// ---------------------------------------------------------------
// REGISTER (register.php)
// ---------------------------------------------------------------
router.get('/register.php', async (req, res) => {
    if (current_user_id(req)) return res.redirect('/dashboard.php');
    const registration_mode = await setting(null, 'registration_mode', 'open');
    res.render('auth/register', { error: '', success: '', registration_mode });
});

router.post('/register.php', async (req, res) => {
    const registration_mode = await setting(null, 'registration_mode', 'open');
    const full_name = String((req.body && req.body.full_name) || '').trim();
    const email = String((req.body && req.body.email) || '').trim();
    const id_number = String((req.body && req.body.id_number) || '').trim();
    const password = String((req.body && req.body.password) || '');
    let error = '';
    let success = '';

    if (!csrf_ok(req)) {
        error = 'Your session expired. Please try again.';
    } else if (full_name && email && id_number && password) {
        if (password.length < 8) {
            error = 'Password must be at least 8 characters.';
        } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            error = 'Please enter a valid email address.';
        } else {
            const dupEmail = await get('SELECT COUNT(*) AS n FROM users WHERE email = ?', [email]);
            if (Number(dupEmail.n) > 0) {
                error = 'Email already registered.';
            } else {
                const dupNum = await get('SELECT COUNT(*) AS n FROM students WHERE student_number = ?', [id_number]);
                if (Number(dupNum.n) > 0) {
                    error = 'That student number is already registered.';
                } else {
                    const hashed = bcrypt.hashSync(password, 10);
                    const status = registration_mode === 'approval' ? 'pending' : 'active';
                    const ins = await run("INSERT INTO users (role, email, password, status) VALUES ('student', ?, ?, ?)",
                        [email, hashed, status]);
                    await run('INSERT INTO students (user_id, student_number, full_name) VALUES (?, ?, ?)',
                        [ins.lastId, id_number, full_name]);
                    success = status === 'pending'
                        ? 'Account created! An administrator must approve it before you can sign in.'
                        : 'Account created successfully! You can now log in.';
                }
            }
        }
    } else {
        error = 'Please fill in all fields.';
    }

    res.render('auth/register', { error, success, registration_mode });
});

// ---------------------------------------------------------------
// LOGOUT (logout.php) - POST-only with CSRF validation
// ---------------------------------------------------------------
router.post('/logout.php', (req, res) => {
    if (!csrf_ok(req)) return res.redirect('/login.php');
    req.session = null;
    res.redirect('/login.php');
});

router.get('/logout.php', (req, res) => {
    res.redirect('/login.php');
});

module.exports = router;
