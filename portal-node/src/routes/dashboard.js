// ================================================================
// DASHBOARD ROUTER (port of dashboard.php + includes/actions.php)
// ================================================================
// GET  /dashboard.php?page=...  → page renderers (teacher_pages / student_pages)
// POST /dashboard.php           → the action dispatcher (teacher_actions /
//                                 student_actions + shared change_password)
// ================================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const { get, run, client } = require('../db');
const {
    require_login, current_role, current_user_id, is_admin_user,
    csrf_ok, flash, audit,
} = require('../config');

const teacher_pages = require('../actions/teacher_pages');
const teacher_actions = require('../actions/teacher_actions');
const student_pages = require('../actions/student_pages');
const student_actions = require('../actions/student_actions');

const router = express.Router();

// Assignment/announcement/submission/profile uploads are multipart.
// Memory storage: save_upload() decides where the bytes go (disk or Vercel Blob).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });

// ---- navbar identity chip (dashboard.php computes these inline) ----
function chip(req) {
    const name = (req.session && req.session.full_name) || 'User';
    let chip_role = current_role(req) === 'teacher' ? 'Teacher' : 'Student';
    if (is_admin_user(req)) chip_role += ' · Admin';
    const parts = String(name).replace(/[^A-Za-z ]/g, '').trim().split(/\s+/).filter(Boolean);
    const chip_ini = (((parts[0] || 'U')[0] || 'U') + (parts[1] ? parts[1][0] : '')).toUpperCase();
    return { chip_role, chip_ini };
}

function no_id(res, message) {
    res.status(200).render('error_page', { page: '', unread: 0, message });
}

// ================================================================
// SHARED: PROFILE PAGE (both roles)
// ================================================================
async function profile_page(req, res) {
    const uid = current_user_id(req);
    const role = current_role(req);
    const data = role === 'teacher'
        ? await get('SELECT * FROM teachers WHERE user_id=?', [uid])
        : await get('SELECT * FROM students WHERE user_id=?', [uid]);
    const u = await get('SELECT email FROM users WHERE id=?', [uid]);
    const photo = (data && data.profile_photo) || 'default.png';
    const { chip_role, chip_ini } = chip(req);
    res.render('profile', { page: 'profile', unread: 0, chip_role, chip_ini, data, email: u ? u.email : '', photo, role });
}

// ================================================================
// SHARED: CHANGE PASSWORD (both roles - port of the actions.php tail)
// ================================================================
async function change_password(req, res) {
    const uid = current_user_id(req);
    const current = (req.body && req.body.current_password) || '';
    const nw = (req.body && req.body.new_password) || '';
    const confirm = (req.body && req.body.confirm_password) || '';
    const u = await get('SELECT password FROM users WHERE id=?', [uid]);
    if (!u || !bcrypt.compareSync(current, String(u.password || ''))) {
        flash(req, 'Current password is incorrect.', 'danger');
    } else if (nw !== confirm) {
        flash(req, 'New passwords do not match.', 'danger');
    } else if (String(nw).length < 8) {
        flash(req, 'Password must be at least 8 characters.', 'danger');
    } else {
        await run('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(nw, 10), uid]);
        await audit(client, req, 'change_password', 'users', uid);
        flash(req, 'Password changed.');
    }
    res.redirect('/dashboard.php?page=profile');
}

// ================================================================
// GET DISPATCH (dashboard.php page routing)
// ================================================================
router.get('/dashboard.php', require_login, async (req, res, next) => {
    const role = current_role(req);
    const page = (req.query.page) || 'dashboard';
    try {
        if (role === 'teacher') {
            const class_id = Number(req.query.id || 0);
            switch (page) {
                case 'create_class': return await teacher_pages.teacher_create_class(req, res);
                case 'class': return class_id
                    ? await teacher_pages.teacher_class_detail(req, res, class_id)
                    : no_id(res, 'No class ID provided.');
                case 'grades': return class_id
                    ? await teacher_pages.teacher_grades(req, res, class_id)
                    : no_id(res, 'No class ID provided.');
                case 'sf9': return class_id
                    ? await teacher_pages.teacher_sf9(req, res, class_id)
                    : no_id(res, 'No class ID provided.');
                case 'attendance': return class_id
                    ? await teacher_pages.teacher_attendance(req, res, class_id)
                    : no_id(res, 'No class ID provided.');
                case 'settings': return class_id
                    ? await teacher_pages.teacher_settings(req, res, class_id)
                    : no_id(res, 'No class ID provided.');
                case 'submissions': return class_id
                    ? await teacher_pages.teacher_submissions(req, res, class_id)
                    : no_id(res, 'No assignment ID provided.');
                case 'profile': return await profile_page(req, res);
                default: return await teacher_pages.teacher_dashboard(req, res);
            }
        }
        const class_id = Number(req.query.id || 0);
        switch (page) {
            case 'classes': return await student_pages.student_classes(req, res);
            case 'class': return class_id
                ? await student_pages.student_class_detail(req, res, class_id)
                : no_id(res, 'No class ID provided.');
            case 'grades': return await student_pages.student_grades(req, res);
            case 'attendance': return await student_pages.student_attendance(req, res);
            case 'notifications': return await student_pages.student_notifications(req, res);
            case 'profile': return await profile_page(req, res);
            default: return await student_pages.student_dashboard(req, res);
        }
    } catch (e) { next(e); }
});

// ================================================================
// POST DISPATCH (includes/actions.php)
// ================================================================
router.post('/dashboard.php', require_login, upload.any(), async (req, res, next) => {
    const role = current_role(req);
    const action = (req.body && req.body.action) || '';
    try {
        // Shared: change password (both roles)
        if (action === 'change_password') return await change_password(req, res);

        let handled = false;
        if (role === 'teacher') {
            handled = await teacher_actions.handle(req, res, action);
        } else if (role === 'student') {
            handled = await student_actions.handle(req, res, action);
        }
        if (!handled) res.redirect('/dashboard.php');
    } catch (e) { next(e); }
});

module.exports = router;
