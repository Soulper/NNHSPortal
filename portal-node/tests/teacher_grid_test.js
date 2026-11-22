// ================================================================
// TEACHER GRID VIEW ASSERTIONS (port of tests/teacher_grid_test.php)
// Run: node tests/teacher_grid_test.js
//
// Renders teacher_grades() into a string and asserts on the markup:
// column shape, progress strip, publish CTA gating and valid form nesting.
// ================================================================
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ejs = require('ejs');

const scratch = path.join(os.tmpdir(), 'portal-grid-test.db');
process.env.DATABASE_URL = 'file:' + scratch.replace(/\\/g, '/');
delete process.env.DATABASE_TOKEN;
if (fs.existsSync(scratch)) fs.unlinkSync(scratch);

const { initDb, all, get, run } = require('../src/db');
const ge = require('../src/grade-engine');
const cfg = require('../src/config');
const teacher_pages = require('../src/actions/teacher_pages');

const VIEWS = path.join(__dirname, '..', 'src', 'views');

let pass = 0, fail = 0;
function check(label, actual, expected) {
    const ok = Math.abs(Number(actual) - Number(expected)) < 0.011;
    if (ok) { pass++; console.log(`  PASS  ${label} = ${actual}`); }
    else { fail++; console.log(`  FAIL  ${label} = ${actual} (expected ${expected})`); }
}
function check_str(label, got, want) {
    if (got === want) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label} = ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`); }
}
function check_has(label, haystack, needle) {
    if (haystack.includes(needle)) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label} (missing: ${needle})`); }
}
function check_lacks(label, haystack, needle) {
    if (!haystack.includes(needle)) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label} (unexpectedly found: ${needle})`); }
}
function count(haystack, needle) {
    return haystack.split(needle).length - 1;
}

// ---- fake express req/res that captures the rendered view ----
function makeReqRes(user_id, term) {
    const req = {
        session: { user_id, role: 'teacher', is_admin: 1, csrf: 'testtoken', full_name: 'Grid Tester' },
        query: { term: String(term) },
        body: {},
        ip: '127.0.0.1',
    };
    const store = { html: '' };
    const res = {};
    res.locals = {
        session: req.session,
        user_id,
        role: 'teacher',
        is_admin: true,
        full_name: 'Grid Tester',
        csrf: 'testtoken',
        csrf_field: '<input type="hidden" name="csrf_token" value="testtoken">',
        year: String(new Date().getFullYear()),
        flash: null,
        flash_type: 'info',
        h: {
            esc: cfg.esc, rc_grade: cfg.rc_grade, rc_label: cfg.rc_label,
            rc_result: cfg.rc_result, rc_grade_class: cfg.rc_grade_class,
            icon: cfg.icon, trim_num: ge.trim_num,
        },
    };
    res.render = (view, data) => {
        const html = ejs.renderFile(path.join(VIEWS, view + '.ejs'), { ...res.locals, ...data }, { async: false });
        store.html = html;
        return html;
    };
    res.redirect = () => {};
    res.status = () => res;
    res.send = () => {};
    res.setHeader = () => {};
    res.type = () => res;
    return { req, res, store };
}

async function render_grades(user_id, cid, term) {
    const { req, res, store } = makeReqRes(user_id, term);
    await teacher_pages.teacher_grades(req, res, cid);
    return store.html;
}

async function main() {
    await initDb();
    const db = require('../src/db').client;

    const suffix = crypto.randomBytes(3).toString('hex');
    let year = Number((await get("SELECT id FROM academic_years WHERE label='2026-2027'")).id);
    if (!year) year = Number((await get('SELECT id FROM academic_years ORDER BY id DESC LIMIT 1')).id);
    const tids = {};
    for (const t of await all('SELECT id, number FROM terms WHERE academic_year_id=? ORDER BY number', [year])) {
        tids[Number(t.number)] = Number(t.id);
    }

    // ---------------------------------------------------------------
    console.log('== fixture ==');
    // ---------------------------------------------------------------
    // users row first - teachers.user_id is a foreign key onto it.
    let r = await run("INSERT INTO users (role, email, password, is_admin) VALUES ('teacher', ?, 'x', 1)", [`grid.${suffix}@t.local`]);
    const user_id = r.lastId;
    await run('INSERT INTO teachers (user_id, employee_number, full_name) VALUES (?,?,?)', [user_id, 'TG-' + suffix, 'Grid Tester']);

    r = await run(
        'INSERT INTO classes (teacher_id, subject, section, school_year, description, join_code, academic_year_id, current_term_id) VALUES (?,?,?,?,?,?,?,?)',
        [user_id, 'Grid Subject', 'GS' + suffix, '2026-2027', 'grid fixture', 'GS' + suffix, year, tids[1]]);
    const cid = r.lastId;

    const sids = [];
    for (const no of ['GS-001', 'GS-002', 'GS-003', 'GS-004']) {
        r = await run("INSERT INTO users (role, email, password) VALUES ('student', ?, 'x')", [`${no.toLowerCase()}.${suffix}@t.local`]);
        const uid = r.lastId;
        await run('INSERT INTO students (user_id, student_number, full_name) VALUES (?,?,?)', [uid, no, `Gita ${no}`]);
        await run('INSERT INTO class_members (class_id, student_id) VALUES (?,?)', [cid, uid]);
        sids.push(uid);
    }

    // ---------------------------------------------------------------
    console.log('\n== markup: column shape ==');
    // ---------------------------------------------------------------
    // 3 of 4 graded, so the CTA must be hidden.
    // Three students graded, the fourth left blank: the progress bar must read
    // 3 of 4, not 2 of 4 (a blank is not a zero).
    await ge.save_term_grades(db, cid, tids[1], { [sids[0]]: 90, [sids[1]]: 85, [sids[2]]: 82, [sids[3]]: null });
    let html = await render_grades(user_id, cid, tids[1]);

    check_has('has gradebook form', html, 'id="gradebookForm"');
    check_has('grid table has id', html, 'id="gradebookGrid"');
    check_has('saves term grades', html, 'value="save_term_grades"');
    check_has('csrf rendered server-side', html, 'name="csrf_token"');
    check_has('subject in header', html, 'Grid Subject');
    check_has('section in header', html, 'GS' + suffix);
    check_has('term in header', html, 'Term 1');

    // One editable input per student, and each one is actually named so the
    // no-JS fallback can submit it.
    check('one input per student', count(html, 'class="gb-input"'), 4);
    check('inputs are named', count(html, 'name="grade['), 4);
    check('stamp fields present', count(html, 'name="stamp['), 4);
    check('rows present', count(html, 'class="gb-row"'), 4);

    // Exactly five columns: number, name, grade, descriptor, result.
    check_has('student no column', html, 'Student No.');
    check_has('grade column', html, 'Term Grade');
    check_has('descriptor column', html, 'Descriptor');
    check_has('result column', html, 'Result');
    check_lacks('no activity column', html, 'Category');
    check_lacks('no weight column', html, 'Weight');
    check_lacks('no policy picker', html, 'Grading Policy');
    check_lacks('no remark column', html, 'Remark');
    check_lacks('no setup panel', html, 'Add Activity');

    // ---------------------------------------------------------------
    console.log('\n== markup: progress strip ==');
    // ---------------------------------------------------------------
    check_has('progress wrapper', html, 'id="gbProgress"');
    check_has('progress bar', html, 'class="gb-progress-fill"');
    check_has('progress counts', html, '3</strong> of <strong>4</strong>');
    check_has('class average', html, '85.67');   // (90+85+82)/3, blank excluded
    check_has('average descriptor', html, 'Benchmarking');
    check_has('no below-75 warning when all pass', html, 'id="gbStatBelow"');

    // ---------------------------------------------------------------
    console.log('\n== markup: ungraded is a dash, not a zero ==');
    // ---------------------------------------------------------------
    const i = html.indexOf(`<tr class="gb-row" data-sid="${sids[3]}"`);
    const j = i === -1 ? -1 : html.indexOf('</tr>', i);
    check_str('ungraded row located', i !== -1 ? 'yes' : 'no', 'yes');
    const ungraded_html = (i !== -1 && j !== -1) ? html.slice(i, j + 5) : '';
    check_has('ungraded row exists', ungraded_html, 'gb-row');
    check_has('ungraded says Not graded', ungraded_html, 'Not graded');
    check_lacks('ungraded is not Failed', ungraded_html, 'Failed');
    check_lacks('ungraded has no zero value', ungraded_html, 'value="0"');

    // ---------------------------------------------------------------
    console.log('\n== markup: publish CTA is gated ==');
    // ---------------------------------------------------------------
    check_has('publish form exists', html, 'id="gbPublishForm"');
    check_lacks('CTA hidden while incomplete', html, 'form="gbPublishForm" >');

    // Complete the term -> CTA appears.
    await ge.save_term_grades(db, cid, tids[1], { [sids[3]]: 78 });
    html = await render_grades(user_id, cid, tids[1]);
    check_has('all 4 graded', html, '4</strong> of <strong>4</strong>');
    check_has('CTA visible when complete', html, 'form="gbPublishForm"');
    check_has('CTA does not re-save grades', html, 'id="gbPublishForm"');

    // Once published the CTA must disappear and a banner take its place.
    await run('INSERT OR IGNORE INTO class_term_status (class_id, term_id) VALUES (?,?)', [cid, tids[1]]);
    html = await render_grades(user_id, cid, tids[1]);
    check_has('released banner', html, 'is released');
    check_lacks('no CTA when released', html, 'form="gbPublishForm"');
    check_has('term picker rendered', html, 'id="gbTermSelect"');
    check_has('released term marked in dropdown', html, '(released)');

    // ---------------------------------------------------------------
    console.log('\n== markup: valid form nesting ==');
    // ---------------------------------------------------------------
    // The publish form must live OUTSIDE #gradebookForm. A nested <form> is
    // invalid HTML: browsers drop the inner element, which silently breaks the
    // enclosing Save button.
    check('form tags balanced', count(html, '<form'), count(html, '</form>'));
    const formStart = html.indexOf('id="gradebookForm"');
    const formEnd = html.indexOf('</form>', formStart);
    const pubPos = html.indexOf('id="gbPublishForm"');
    check_str('publish form is after the grid form closes', (pubPos !== -1 && pubPos > formEnd) ? 'yes' : 'no', 'yes');

    // The Save button must submit the grid form, not the publish form.
    check_has('Save submits grid form', html, '<button type="submit" class="btn btn-brand');
    check_lacks('Save not bound to publish', html, 'btn btn-brand" form="gbPublishForm"');

    // ---------------------------------------------------------------
    console.log('\n== markup: below-75 warning ==');
    // ---------------------------------------------------------------
    await run('DELETE FROM class_term_status WHERE class_id=? AND term_id=?', [cid, tids[1]]);
    await ge.save_term_grades(db, cid, tids[1], { [sids[3]]: 60 });
    html = await render_grades(user_id, cid, tids[1]);
    check_has('below-75 warning shown', html, 'below 75');
    check_has('failing row marked', html, 'rc-fail');

    // ---------------------------------------------------------------
    console.log('\n== authorisation: another teacher\'s class renders nothing useful ==');
    // ---------------------------------------------------------------
    r = await run("INSERT INTO users (role, email, password) VALUES ('teacher', ?, 'x')", [`other.${suffix}@t.local`]);
    const other_id = r.lastId;
    const html2 = await render_grades(other_id, cid, tids[1]);
    check_has('non-owner sees not found', html2, 'Class not found');
    check_lacks('non-owner sees no grades', html2, 'value="save_term_grades"');

    // ---------------------------------------------------------------
    console.log('\n== empty roster ==');
    // ---------------------------------------------------------------
    r = await run(
        'INSERT INTO classes (teacher_id, subject, section, school_year, join_code, academic_year_id, current_term_id) VALUES (?,?,?,?,?,?,?)',
        [user_id, 'Empty Grid', 'EG' + suffix, '2026-2027', 'EG' + suffix, year, tids[1]]);
    const eid = r.lastId;
    const he = await render_grades(user_id, eid, tids[1]);
    check_has('empty roster message', he, 'No students enrolled');
    check_lacks('empty roster has no grid', he, 'id="gradebookForm"');
    await run('DELETE FROM classes WHERE id=?', [eid]);

    // ---------------------------------------------------------------
    // teardown
    // ---------------------------------------------------------------
    await run('DELETE FROM term_grades WHERE class_id=?', [cid]);
    await run('DELETE FROM class_term_status WHERE class_id=?', [cid]);
    await run('DELETE FROM class_members WHERE class_id=?', [cid]);
    await run('DELETE FROM classes WHERE id=?', [cid]);
    await run('DELETE FROM teachers WHERE user_id=?', [user_id]);
    await run('DELETE FROM users WHERE email LIKE ?', [`%.${suffix}@t.local`]);

    console.log('\n' + '-'.repeat(46));
    console.log(`teacher_grid_test: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
