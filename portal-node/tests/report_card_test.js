// ================================================================
// STUDENT REPORT CARD ASSERTIONS (port of tests/report_card_test.php)
// Run: node tests/report_card_test.js
//
// The card is the privacy boundary of the whole app: a term the teacher
// has not released must not appear on it at all, and a blank grade must
// never render as a zero.
// ================================================================
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const scratch = path.join(os.tmpdir(), 'portal-report-card-test.db');
process.env.DATABASE_URL = 'file:' + scratch.replace(/\\/g, '/');
delete process.env.DATABASE_TOKEN;
if (fs.existsSync(scratch)) fs.unlinkSync(scratch);

const { initDb, client, all, get, run } = require('../src/db');
const ge = require('../src/grade-engine');
const { rc_grade, rc_label, rc_result, rc_grade_class } = require('../src/config');

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

async function main() {
    await initDb();
    const db = client;

    // ---------------------------------------------------------------
    console.log('== rc_grade: a blank grade is a dash, a zero is a zero ==');
    // ---------------------------------------------------------------
    check_str('grade 87', rc_grade(87), '87');
    check_str('grade 0', rc_grade(0), '0');
    check_str('grade 87.50', rc_grade('87.50'), '87.5');
    check_str('null grade', rc_grade(null), '&mdash;');
    check_str('null + has=0', rc_grade(87, false), '&mdash;');
    check_str('zero + has=0', rc_grade(0, false), '&mdash;');

    // ---------------------------------------------------------------
    console.log('\n== rc_result: \'not graded\' is distinct from \'failed\' ==');
    // ---------------------------------------------------------------
    check_str('graded 60 -> Failed', rc_result(false, true), '<span class="rc-chip rc-fail">Failed</span>');
    check_str('graded 80 -> Passed', rc_result(true, true), '<span class="rc-chip rc-pass">Passed</span>');
    check_str('ungraded -> Not graded', rc_result(false, false), '<span class="rc-chip rc-none">Not graded</span>');
    // A passing flag with no grade must still say "not graded".
    check_str('ungraded never Passed', rc_result(true, false), '<span class="rc-chip rc-none">Not graded</span>');

    // (rc_label is exercised lightly: it renders a dash for null.)
    check_str('rc_label null dash', rc_label(null), '&mdash;');

    // ---------------------------------------------------------------
    console.log('\n== rc_grade_class: band tinting ==');
    // ---------------------------------------------------------------
    check_str('95 advancing', rc_grade_class(95), 'rc-g-advancing');
    check_str('90 advancing', rc_grade_class(90), 'rc-g-advancing');
    check_str('89.99 benchmark', rc_grade_class(89.99), 'rc-g-benchmarking');
    check_str('80 benchmark', rc_grade_class(80), 'rc-g-benchmarking');
    check_str('79.99 connect', rc_grade_class(79.99), 'rc-g-connecting');
    check_str('75 connect', rc_grade_class(75), 'rc-g-connecting');
    check_str('74.99 develop', rc_grade_class(74.99), 'rc-g-developing');
    check_str('65 develop', rc_grade_class(65), 'rc-g-developing');
    check_str('64.99 emerging', rc_grade_class(64.99), 'rc-g-emerging');
    check_str('0 emerging', rc_grade_class(0), 'rc-g-emerging');
    check_str('null none', rc_grade_class(null), 'rc-g-none');
    check_str('ungraded none', rc_grade_class(0, false), 'rc-g-none');

    // Tint and label must never disagree: the same number is the same word
    // everywhere it appears.
    const bands = await ge.descriptor_rows_all(db);
    for (const g of [0, 64.99, 65, 74.99, 75, 79.99, 80, 89.99, 90, 100]) {
        const label = rc_grade_class(g).replace('rc-g-', '');
        check_str(`tint matches descriptor at ${g}`, label.toLowerCase(), ge.descriptor_for(g, bands).label_en.toLowerCase());
    }

    // ---------------------------------------------------------------
    console.log('\n== report card maths over a fixture ==');
    // ---------------------------------------------------------------
    const suffix = crypto.randomBytes(3).toString('hex');
    let year = Number((await get("SELECT id FROM academic_years WHERE label='2026-2027'")).id);
    if (!year) year = Number((await get('SELECT id FROM academic_years ORDER BY id DESC LIMIT 1')).id);
    const tids = {};
    const q = await all('SELECT id, number FROM terms WHERE academic_year_id=? ORDER BY number', [year]);
    for (const t of q) tids[Number(t.number)] = Number(t.id);
    const teacher = Number((await get('SELECT user_id FROM teachers ORDER BY user_id LIMIT 1')).user_id);

    let r = await run(
        'INSERT INTO classes (teacher_id, subject, section, school_year, join_code, academic_year_id, current_term_id) VALUES (?,?,?,?,?,?,?)',
        [teacher, 'RC Test', 'RC' + suffix, '2026-2027', 'RC' + suffix, year, tids[1]]);
    const cid = r.lastId;

    const sids = [];
    for (const no of ['RC-001', 'RC-002', 'RC-003']) {
        r = await run("INSERT INTO users (role, email, password) VALUES ('student', ?, 'x')", [`${no.toLowerCase()}.${suffix}@t.local`]);
        const uid = r.lastId;
        await run('INSERT INTO students (user_id, student_number, full_name) VALUES (?,?,?)', [uid, no, `Rita ${no}`]);
        await run('INSERT INTO class_members (class_id, student_id) VALUES (?,?)', [cid, uid]);
        sids.push(uid);
    }

    // Term 1 grades; term 2 stays empty and unreleased.
    await ge.save_term_grades(db, cid, tids[1], { [sids[0]]: 88, [sids[1]]: 74, [sids[2]]: null });
    await run('INSERT OR IGNORE INTO class_term_status (class_id, term_id) VALUES (?,?)', [cid, tids[1]]);

    // The exact average maths the card renders.
    const rows = await ge.term_grade_stamps(db, cid, tids[1]);
    const vals = Object.values(rows).filter((x) => x.grade !== null).map((x) => x.grade);
    const general = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;

    check('general average', general, 81);                       // (88+74)/2
    check('subject final', await ge.final_grade_from_terms(db, cid, sids[0]), 88);
    check_str('88 is Benchmarking', ge.descriptor_for(88, bands).label_en, 'Benchmarking');
    check_str('74 is Developing', ge.descriptor_for(74, bands).label_en, 'Developing');
    check_str('81 passes', ge.grade_passes(general), true);
    // A general average below the passing mark must read as a failure.
    const below = Math.round(((60 + 70) / 2) * 100) / 100;
    check('below-passing general', below, 65);
    check_str('65 fails', ge.grade_passes(below), false);
    check_str('65 is Developing', ge.descriptor_for(below, bands).label_en, 'Developing');
    check_str('ungraded student has no final', await ge.final_grade_from_terms(db, cid, sids[2]), null);

    // ---------------------------------------------------------------
    console.log('\n== privacy: an unreleased term contributes nothing ==');
    // ---------------------------------------------------------------
    await ge.save_term_grades(db, cid, tids[2], { [sids[0]]: 100, [sids[1]]: 100, [sids[2]]: 100 });
    check('term 2 stored', await ge.direct_term_grade(db, cid, sids[0], tids[2]), 100);
    // ...but final_grade_from_terms() defaults to published terms only.
    check('unreleased term ignored', await ge.final_grade_from_terms(db, cid, sids[0]), 88);
    check('still only 88', await ge.final_grade_from_terms(db, cid, sids[0], false), 94);   // (88+100)/2

    // Release it -> now it counts.
    await run('INSERT OR IGNORE INTO class_term_status (class_id, term_id) VALUES (?,?)', [cid, tids[2]]);
    check('released term now counts', await ge.final_grade_from_terms(db, cid, sids[0]), 94);
    check_str('term 2 is published', await ge.class_is_published(db, cid, tids[2]), true);

    // Withdraw it again -> back to hidden.
    await run('DELETE FROM class_term_status WHERE class_id=? AND term_id=?', [cid, tids[2]]);
    check('withdrawn term hidden again', await ge.final_grade_from_terms(db, cid, sids[0]), 88);

    // ---------------------------------------------------------------
    console.log('\n== year scoping ==');
    // ---------------------------------------------------------------
    const otherRow = await get('SELECT id FROM academic_years WHERE id<>? ORDER BY id LIMIT 1', [year]);
    if (otherRow) {
        const other = Number(otherRow.id);
        const ot = Number((await get('SELECT id FROM terms WHERE academic_year_id=? ORDER BY number LIMIT 1', [other])).id);
        if (ot) {
            r = await run(
                'INSERT INTO classes (teacher_id, subject, section, school_year, join_code, academic_year_id, current_term_id) VALUES (?,?,?,?,?,?,?)',
                [teacher, 'RC Old', 'RCO' + suffix, '2025-2026', 'RCO' + suffix, other, ot]);
            const ocid = r.lastId;
            await run('INSERT INTO class_members (class_id, student_id) VALUES (?,?)', [ocid, sids[0]]);
            await ge.save_term_grades(db, ocid, ot, { [sids[0]]: 55 });
            await run('INSERT OR IGNORE INTO class_term_status (class_id, term_id) VALUES (?,?)', [ocid, ot]);
            // The other year's grade must not leak into this year's card.
            check('other year is a separate class', await ge.direct_term_grade(db, ocid, sids[0], ot), 55);
            check('this year unaffected', await ge.direct_term_grade(db, cid, sids[0], tids[1]), 88);
            await run('DELETE FROM term_grades WHERE class_id=?', [ocid]);
            await run('DELETE FROM class_term_status WHERE class_id=?', [ocid]);
            await run('DELETE FROM class_members WHERE class_id=?', [ocid]);
            await run('DELETE FROM classes WHERE id=?', [ocid]);
        }
    }

    // ---------------------------------------------------------------
    // teardown
    // ---------------------------------------------------------------
    await run('DELETE FROM term_grades WHERE class_id=?', [cid]);
    await run('DELETE FROM class_term_status WHERE class_id=?', [cid]);
    await run('DELETE FROM class_members WHERE class_id=?', [cid]);
    await run('DELETE FROM classes WHERE id=?', [cid]);
    await run('DELETE FROM users WHERE email LIKE ?', [`%.${suffix}@t.local`]);

    console.log('\n' + '-'.repeat(46));
    console.log(`report_card_test: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
