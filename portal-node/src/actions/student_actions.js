// ================================================================
// STUDENT POST ACTIONS (port of the student branch of includes/actions.php)
// ================================================================
// Exports handle(req, res, action) -> true when the action was handled and a
// response sent, false when the action is unknown (the dispatcher then
// redirects to /dashboard.php exactly like the PHP fall-through).
// Uploaded files arrive via multer memory storage on req.files (array).
// ================================================================
const { get, run, client } = require('../db');
const { csrf_ok, flash, current_user_id, today, notify } = require('../config');
const { assignment_policy } = require('../grade-engine');
const { save_upload } = require('../storage');

// PHP (int) cast: "3.7" -> 3, "abc"/""/null -> 0.
function to_int(v) {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? 0 : n;
}

async function handle(req, res, action) {
    // -- CSRF PROTECTION (first, before any action — includes/actions.php) --
    if (!csrf_ok(req)) {
        flash(req, 'Your session expired. Please try again.', 'danger');
        res.redirect('/dashboard.php');
        return true;
    }

    const user_id = current_user_id(req);

    // ================= STUDENT ACTIONS =================

    // JOIN CLASS
    if (action === 'join_class') {
        const code = String((req.body && req.body.join_code) ?? '').trim().toUpperCase();
        const c = await get('SELECT id, status FROM classes WHERE join_code=?', [code]);
        if (!c || c.status !== 'active') {
            flash(req, 'Invalid or inactive join code.', 'danger');
        } else {
            const check = await get('SELECT COUNT(*) AS n FROM class_members WHERE class_id=? AND student_id=?', [c.id, user_id]);
            if (Number(check.n) > 0) {
                flash(req, 'You are already in this class.');
            } else {
                await run('INSERT INTO class_members (class_id, student_id) VALUES (?, ?)', [c.id, user_id]);
                flash(req, 'Joined class successfully!');
            }
        }
        res.redirect('/dashboard.php?page=classes');
        return true;
    }

    // SUBMIT ASSIGNMENT
    if (action === 'submit_assignment') {
        const assignment_id = to_int((req.body && req.body.assignment_id) ?? 0);
        const class_id = to_int((req.body && req.body.class_id) ?? 0);
        const member = await get('SELECT COUNT(*) AS n FROM class_members WHERE class_id=? AND student_id=?', [class_id, user_id]);
        const valid = await get('SELECT COUNT(*) AS n FROM assignments WHERE id=? AND class_id=?', [assignment_id, class_id]);
        if (Number(member.n) === 0 || Number(valid.n) === 0) {
            flash(req, 'You are not enrolled in this class.', 'danger');
            res.redirect('/dashboard.php?page=classes');
            return true;
        }
        const policy = await assignment_policy(client, assignment_id);
        if (!policy) {
            flash(req, 'Assignment not found.', 'danger');
            res.redirect('/dashboard.php?page=classes');
            return true;
        }
        // Late / cutoff enforcement (server time, due date inclusive)
        const now = today(); // Asia/Manila 'YYYY-MM-DD', like PHP's date('Y-m-d')
        if (!policy.allow_late && policy.cutoff_date && now > policy.cutoff_date) {
            flash(req, 'This assignment is closed for submissions.', 'danger');
            res.redirect('/dashboard.php?page=class&id=' + class_id);
            return true;
        }
        const file = (Array.isArray(req.files) ? req.files : []).find((f) => f.fieldname === 'file') || null;
        const up = await save_upload(file, 'sub_' + user_id + '_' + assignment_id, policy.allowed_exts, policy.max_size_mb);
        if (up.error) {
            flash(req, up.error, 'danger');
        } else if (policy.requires_file && !up.file) {
            flash(req, 'A file is required for this assignment.', 'danger');
        } else if (!up.file) {
            flash(req, 'Please select a file to upload.', 'danger');
        } else {
            const is_late = now > policy.due_date ? 1 : 0;
            // PHP: trim((string)$_FILES['file']['name']) then substr(0, 255).
            const original_name = String((file && file.originalname) || '').trim().slice(0, 255);
            const existing = await get('SELECT COUNT(*) AS n FROM submissions WHERE assignment_id=? AND student_id=?', [assignment_id, user_id]);
            if (Number(existing.n) > 0) {
                await run(
                    'UPDATE submissions SET file_url=?, original_name=?, is_late=?, submitted_at=CURRENT_TIMESTAMP WHERE assignment_id=? AND student_id=?',
                    [up.file, original_name, is_late, assignment_id, user_id]);
            } else {
                await run(
                    'INSERT INTO submissions (assignment_id, student_id, file_url, original_name, is_late) VALUES (?, ?, ?, ?, ?)',
                    [assignment_id, user_id, up.file, original_name, is_late]);
                // Notify the class teacher (new submissions only, like the PHP)
                const t = await get('SELECT c.teacher_id, c.subject, a.title FROM classes c JOIN assignments a ON a.class_id=c.id WHERE a.id=?', [assignment_id]);
                if (t) {
                    const sn = await get('SELECT full_name FROM students WHERE user_id=?', [user_id]);
                    const student_name = sn && sn.full_name != null ? String(sn.full_name) : '';
                    await notify(client, t.teacher_id,
                        (is_late ? 'Late submission: ' : 'New submission: ') + t.title + ' (' + t.subject + ') by ' + student_name,
                        'dashboard.php?page=submissions&id=' + assignment_id, 'submission');
                }
            }
            flash(req, is_late ? 'Assignment submitted (late).' : 'Assignment submitted.');
        }
        res.redirect('/dashboard.php?page=class&id=' + class_id);
        return true;
    }

    // UPDATE PROFILE (student)
    if (action === 'update_profile') {
        const phone = String((req.body && req.body.phone) ?? '').trim();
        const photo = (Array.isArray(req.files) ? req.files : []).find((f) => f.fieldname === 'photo') || null;
        const up = await save_upload(photo, 'student_' + user_id, ['jpg', 'jpeg', 'png', 'gif', 'webp']);
        if (up.error) {
            flash(req, up.error, 'danger');
            res.redirect('/dashboard.php?page=profile');
            return true;
        }
        if (up.file) {
            await run('UPDATE students SET profile_photo=? WHERE user_id=?', [up.file, user_id]);
        }
        await run('UPDATE students SET phone=? WHERE user_id=?', [phone, user_id]);
        flash(req, 'Profile updated.');
        res.redirect('/dashboard.php?page=profile');
        return true;
    }

    // No action matched (change_password and teacher actions are handled
    // elsewhere; the dispatcher redirects to /dashboard.php on false).
    return false;
}

module.exports = { handle };
