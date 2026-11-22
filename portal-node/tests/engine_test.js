// ================================================================
// GRADE ENGINE ASSERTIONS - direct Term Grades + DO 015 descriptors
// Port of tests/engine_test.php. Run: node tests/engine_test.js
// Uses its own scratch database; never touches data/school_portal.db.
// ================================================================
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Scratch DB must be selected BEFORE src/db.js is required.
const scratch = process.env.DB_SCRATCH || path.join(os.tmpdir(), 'portal-engine-test.db');
process.env.DATABASE_URL = 'file:' + scratch.replace(/\\/g, '/');
delete process.env.DATABASE_TOKEN;
if (fs.existsSync(scratch)) fs.unlinkSync(scratch);

const { initDb, client, all, get, run } = require('../src/db');
const ge = require('../src/grade-engine');

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
    console.log('== DO 015 descriptor bands ==');
    // ---------------------------------------------------------------
    const bands = await ge.descriptor_rows_all(db);
    check('descriptor band count', bands.length, 5);
    check_str('Advancing label', bands[0].label_en, 'Advancing');
    check_str('Benchmarking label', bands[1].label_en, 'Benchmarking');
    check_str('Connecting label', bands[2].label_en, 'Connecting');
    check_str('Developing label', bands[3].label_en, 'Developing');
    check_str('Emerging label', bands[4].label_en, 'Emerging');

    // Every band must carry a Filipino label too.
    for (const b of bands) check_str('FIL label for ' + b.label_en, String(b.label_fil) !== '', true);

    // ---------------------------------------------------------------
    console.log('\n== descriptor_for: band edges ==');
    // ---------------------------------------------------------------
    const edges = [
        [0, 'Emerging'], [64.99, 'Emerging'], [65, 'Developing'], [74.99, 'Developing'],
        [75, 'Connecting'], [79.99, 'Connecting'], [80, 'Benchmarking'], [89.99, 'Benchmarking'],
        [90, 'Advancing'], [100, 'Advancing'],
    ];
    for (const [g, want] of edges) check_str(`descriptor_for(${g})`, ge.descriptor_for(g, bands).label_en, want);

    // ---------------------------------------------------------------
    console.log('\n== descriptor_for: ungraded is NOT the lowest band ==');
    // ---------------------------------------------------------------
    check_str('null grade', ge.descriptor_for(null, bands).label_en, 'Not Graded');
    check_str('empty string', ge.descriptor_for('', bands).label_en, 'Not Graded');
    check_str('zero IS Emerging', ge.descriptor_for(0, bands).label_en, 'Emerging');
    check_str('null FIL label', ge.descriptor_for(null, bands).label_fil, 'Hindi pa Naitala');

    // ---------------------------------------------------------------
    console.log('\n== descriptor_for: gaps and overlaps ==');
    // ---------------------------------------------------------------
    check_str('out-of-band high is Invalid', ge.descriptor_for(101, bands).label_en, 'Invalid');
    check_str('out-of-band low is Invalid', ge.descriptor_for(-5, bands).label_en, 'Invalid');

    // ---------------------------------------------------------------
    console.log('\n== passing mark ==');
    // ---------------------------------------------------------------
    check_str('PASSING_MARK', ge.PASSING_MARK, 75.0);
    check('75 passes', ge.grade_passes(75) ? 1 : 0, 1);
    check('74.99 fails', ge.grade_passes(74.99) ? 1 : 0, 0);
    check('90 passes', ge.grade_passes(90) ? 1 : 0, 1);
    check('0 fails', ge.grade_passes(0) ? 1 : 0, 0);
    check('null fails', ge.grade_passes(null) ? 1 : 0, 0);

    // ---------------------------------------------------------------
    console.log('\n== validate_term_grade ==');
    // ---------------------------------------------------------------
    let [ok, v] = ge.validate_term_grade('87');
    check_str('valid 87 ok', ok, true); check('valid 87 value', v, 87);

    [ok, v] = ge.validate_term_grade('');
    check_str('blank is ok', ok, true); check_str('blank is null', v, null);

    [ok, v] = ge.validate_term_grade('   ');
    check_str('whitespace is ok', ok, true); check_str('whitespace is null', v, null);

    [ok, v] = ge.validate_term_grade(null);
    check_str('null is ok', ok, true); check_str('null is null', v, null);

    [ok] = ge.validate_term_grade('100'); check_str('100 allowed', ok, true);
    [ok] = ge.validate_term_grade('0'); check_str('0 allowed', ok, true);
    [ok] = ge.validate_term_grade('75.5'); check_str('decimal allowed', ok, true);

    [ok] = ge.validate_term_grade('100.1'); check_str('100.1 rejected', ok, false);
    [ok] = ge.validate_term_grade('-1'); check_str('-1 rejected', ok, false);
    [ok] = ge.validate_term_grade('abc'); check_str('abc rejected', ok, false);
    [ok] = ge.validate_term_grade('8 7'); check_str('internal space rejected', ok, false);
    [ok] = ge.validate_term_grade('1e2'); check_str('scientific notation rejected', ok, false);

    // ---------------------------------------------------------------
    console.log('\n== trim_num ==');
    // ---------------------------------------------------------------
    check_str('20 stays 20', ge.trim_num(20), '20');
    check_str('50 stays 50', ge.trim_num(50), '50');
    check_str('87.00 -> 87', ge.trim_num('87.00'), '87');
    check_str('85.50 stays', ge.trim_num('85.50'), '85.5');
    check_str('0 stays 0', ge.trim_num(0), '0');
    check_str('-0 becomes 0', ge.trim_num('-0.00'), '0');

    // ---------------------------------------------------------------
    console.log('\n== fixture: throwaway class ==');
    // ---------------------------------------------------------------
    const suffix = crypto.randomBytes(3).toString('hex');
    const tidRow = await get('SELECT id FROM terms WHERE number=1 ORDER BY academic_year_id DESC LIMIT 1');
    const tid = Number(tidRow.id);
    const year = Number((await get('SELECT academic_year_id AS y FROM terms WHERE id=?', [tid])).y);
    const teacher = Number((await get('SELECT user_id FROM teachers ORDER BY user_id LIMIT 1')).user_id);

    let r = await run(
        'INSERT INTO classes (teacher_id, subject, section, school_year, description, join_code, academic_year_id, current_term_id) VALUES (?,?,?,?,?,?,?,?)',
        [teacher, 'ZZ Test', 'ZZ' + suffix, '2026-2027', 'engine test fixture', 'ZZ' + suffix, year, tid]);
    const cid = r.lastId;

    const sids = [];
    for (let i = 0; i < 3; i++) {
        const no = `AAA-00${i + 1}`;
        const mail = `zz${i}.${suffix}@test.local`;
        r = await run("INSERT INTO users (role, email, password) VALUES ('student', ?, 'x')", [mail]);
        const uid = r.lastId;
        await run('INSERT INTO students (user_id, student_number, full_name) VALUES (?,?,?)', [uid, no, `Zoe ${no}`]);
        await run('INSERT INTO class_members (class_id, student_id) VALUES (?,?)', [cid, uid]);
        sids.push(uid);
    }
    check('roster size', (await ge.class_roster(db, cid)).length, 3);

    // ---------------------------------------------------------------
    console.log('\n== save_term_grades: happy path ==');
    // ---------------------------------------------------------------
    let res;
    [ok, , res] = await ge.save_term_grades(db, cid, tid, { [sids[0]]: 90, [sids[1]]: 85 });
    check_str('save ok', ok, true);
    check_str('no error', res && ok ? null : undefined, null);
    check('two saved', res.saved.length, 2);
    check('no conflicts', res.conflicts.length, 0);
    check('stamp returned', res.stamps[sids[0]] !== undefined ? 1 : 0, 1);

    check('stored 90', await ge.direct_term_grade(db, cid, sids[0], tid), 90);
    check('stored 85', await ge.direct_term_grade(db, cid, sids[1], tid), 85);
    check_str('ungraded reads null', await ge.direct_term_grade(db, cid, sids[2], tid), null);

    // ---------------------------------------------------------------
    console.log('\n== save_term_grades: validation ==');
    // ---------------------------------------------------------------
    [ok, v] = [null, null];
    let err;
    [ok, err] = (await ge.save_term_grades(db, cid, tid, { [sids[0]]: 101 })).slice(0, 2);
    check_str('over 100 rejected', ok, false);
    check_str('error mentions range', String(err).includes('0 and 100'), true);
    check('value untouched after reject', await ge.direct_term_grade(db, cid, sids[0], tid), 90);

    [ok] = (await ge.save_term_grades(db, cid, tid, { [sids[0]]: -5 })).slice(0, 1);
    check_str('negative rejected', ok, false);
    check('value still untouched', await ge.direct_term_grade(db, cid, sids[0], tid), 90);

    [ok] = (await ge.save_term_grades(db, cid, tid, { [sids[0]]: 'nope' })).slice(0, 1);
    check_str('text rejected', ok, false);

    // A bad cell anywhere aborts the WHOLE batch: no half-applied writes.
    [ok] = (await ge.save_term_grades(db, cid, tid, { [sids[1]]: 60, [sids[2]]: 999 })).slice(0, 1);
    check_str('batch aborted on one bad cell', ok, false);
    check('good cell in aborted batch NOT written', await ge.direct_term_grade(db, cid, sids[1], tid), 85);
    check_str('blank cell in aborted batch NOT written', await ge.direct_term_grade(db, cid, sids[2], tid), null);

    // ---------------------------------------------------------------
    console.log('\n== save_term_grades: blank clears to NULL ==');
    // ---------------------------------------------------------------
    [ok, , res] = await ge.save_term_grades(db, cid, tid, { [sids[0]]: '' });
    check_str('blank accepted', ok, true);
    check('one saved', res.saved.length, 1);
    check_str('now null', await ge.direct_term_grade(db, cid, sids[0], tid), null);
    const raw = await get('SELECT COUNT(*) AS n FROM term_grades WHERE class_id=? AND term_id=? AND student_id=? AND grade IS NULL', [cid, tid, sids[0]]);
    check('row kept with NULL grade (not deleted)', Number(raw.n), 1);

    // ---------------------------------------------------------------
    console.log('\n== save_term_grades: roster guard ==');
    // ---------------------------------------------------------------
    const outsiderRow = await get("SELECT id FROM users WHERE role='student' AND id NOT IN (SELECT student_id FROM class_members) LIMIT 1");
    if (outsiderRow) {
        const outsider = Number(outsiderRow.id);
        [ok, , res] = await ge.save_term_grades(db, cid, tid, { [outsider]: 99 });
        check_str('non-member is not an error', ok, true);
        check('non-member not saved', res.saved.length, 0);
        check_str('non-member not written', await ge.direct_term_grade(db, cid, outsider, tid), null);
    }

    // ---------------------------------------------------------------
    console.log('\n== save_term_grades: optimistic concurrency ==');
    // ---------------------------------------------------------------
    await ge.save_term_grades(db, cid, tid, { [sids[0]]: 70 });
    let st = await ge.term_grade_stamps(db, cid, tid);
    const stamp_now = st[sids[0]].stamp;

    // Correct stamp -> writes.
    [ok, , res] = await ge.save_term_grades(db, cid, tid, { [sids[0]]: 71 }, { [sids[0]]: stamp_now });
    check_str('matching stamp writes', ok, true);
    check('no conflicts', res.conflicts.length, 0);
    check('value applied', await ge.direct_term_grade(db, cid, sids[0], tid), 71);

    // Stale stamp -> refused, value preserved.
    const stale = stamp_now;
    [ok, , res] = await ge.save_term_grades(db, cid, tid, { [sids[0]]: 99 }, { [sids[0]]: stale });
    check_str('stale stamp is not a hard error', ok, true);
    check('reported as conflict', res.conflicts.length, 1);
    check('conflicting value NOT applied', await ge.direct_term_grade(db, cid, sids[0], tid), 71);

    // A stamp for a row that does not exist yet is stale, not a free pass.
    [ok, , res] = await ge.save_term_grades(db, cid, tid, { [sids[2]]: 50 }, { [sids[2]]: '2000-01-01 00:00:00' });
    check('ghost row flagged as conflict', res.conflicts.length, 1);
    check_str('ghost row not written', await ge.direct_term_grade(db, cid, sids[2], tid), null);

    // Mixed batch: only the conflicting student is held back.
    await ge.save_term_grades(db, cid, tid, { [sids[1]]: 88 });
    st = await ge.term_grade_stamps(db, cid, tid);
    [ok, , res] = await ge.save_term_grades(
        db, cid, tid,
        { [sids[0]]: 66, [sids[1]]: 77 },
        { [sids[0]]: '2000-01-01 00:00:00', [sids[1]]: st[sids[1]].stamp }
    );
    check('one saved', res.saved.length, 1);
    check('one conflict', res.conflicts.length, 1);
    check('non-conflicting write applied', await ge.direct_term_grade(db, cid, sids[1], tid), 77);
    check('conflicting write skipped', await ge.direct_term_grade(db, cid, sids[0], tid), 71);

    // ---------------------------------------------------------------
    console.log('\n== term_grade_stamps / term_grade_row ==');
    // ---------------------------------------------------------------
    await ge.save_term_grades(db, cid, tid, { [sids[0]]: 82, [sids[1]]: 64, [sids[2]]: null });
    let rows = await ge.term_grade_stamps(db, cid, tid);
    check('rows for whole roster', Object.keys(rows).length, 3);
    check_str('82 descriptor', rows[sids[0]].descriptor, 'Benchmarking');
    check_str('64 descriptor', rows[sids[1]].descriptor, 'Emerging');
    check_str('null descriptor', rows[sids[2]].descriptor, 'Not Graded');
    check_str('82 passes', rows[sids[0]].passed, true);
    check_str('64 fails', rows[sids[1]].passed, false);
    check_str('null fails', rows[sids[2]].passed, false);
    check('stamp present', rows[sids[0]].stamp !== undefined && rows[sids[0]].stamp !== null ? 1 : 0, 1);

    const one = await ge.term_grade_row(db, cid, sids[0], tid);
    check_str('term_grade_row grade', String(one.grade), '82');
    check_str('term_grade_row descriptor', one.descriptor, 'Benchmarking');

    // ---------------------------------------------------------------
    console.log('\n== class_term_progress ==');
    // ---------------------------------------------------------------
    let p = await ge.class_term_progress(db, cid, tid);
    check('total', p.total, 3);
    check('graded', p.graded, 2);          // 82 and 64; sids[2] is NULL
    check('ungraded', p.ungraded, 1);
    check('not complete', p.complete ? 1 : 0, 0);
    check('average excludes NULL', p.average, 73);   // (82+64)/2
    check_str('descriptor of average', p.descriptor, 'Developing');
    check('below passing', p.below_passing, 1);      // only 64
    check('not published', p.published ? 1 : 0, 0);

    // NULL must never drag the average down like a zero would.
    const p0 = p.average;
    await ge.save_term_grades(db, cid, tid, { [sids[2]]: 0 });
    const pz = await ge.class_term_progress(db, cid, tid);
    check('a real 0 changes the average', pz.average !== p0 ? 1 : 0, 1);
    check('  0 counted as graded', pz.graded, 3);
    check_str('  0 is Emerging', ge.descriptor_for(0, bands).label_en, 'Emerging');

    await ge.save_term_grades(db, cid, tid, { [sids[2]]: null });
    check('NULL excluded from average', (await ge.class_term_progress(db, cid, tid)).average, p0);

    // Empty class
    r = await run(
        'INSERT INTO classes (teacher_id, subject, section, school_year, join_code, academic_year_id, current_term_id) VALUES (?,?,?,?,?,?,?)',
        [teacher, 'ZZ Empty', 'ZZE' + suffix, '2026-2027', 'ZZE' + suffix, year, tid]);
    const eid = r.lastId;
    const pe = await ge.class_term_progress(db, eid, tid);
    check('empty total', pe.total, 0);
    check('empty graded', pe.graded, 0);
    check_str('empty is never complete', pe.complete, false);
    check_str('empty average is null', pe.average, null);
    await run('DELETE FROM classes WHERE id=?', [eid]);

    // ---------------------------------------------------------------
    console.log('\n== class_grade_averages ==');
    // ---------------------------------------------------------------
    let a = ge.class_grade_averages(rows);
    check('average of 82,64', a.tg, 73);
    check('counts only graded', a.n, 2);
    const a0 = ge.class_grade_averages({});
    check_str('empty average null', a0.tg, null);

    // ---------------------------------------------------------------
    console.log('\n== final_grade_from_terms (published only) ==');
    // ---------------------------------------------------------------
    const t1 = tid;
    const t2 = Number((await get('SELECT id FROM terms WHERE academic_year_id=? AND number=2', [year])).id);
    await ge.save_term_grades(db, cid, t2, { [sids[0]]: 90 });

    // Nothing published yet -> null, regardless of stored grades.
    check_str('no published terms -> null', await ge.final_grade_from_terms(db, cid, sids[0]), null);

    // Release term 1 only -> 82.
    await run('INSERT OR IGNORE INTO class_term_status (class_id, term_id) VALUES (?,?)', [cid, t1]);
    check('one released term', await ge.final_grade_from_terms(db, cid, sids[0]), 82);

    // Release term 2 too -> (82+90)/2.
    await run('INSERT OR IGNORE INTO class_term_status (class_id, term_id) VALUES (?,?)', [cid, t2]);
    check('two released terms averaged', await ge.final_grade_from_terms(db, cid, sids[0]), 86);

    // A student with no grade in the released term is skipped, not counted as 0.
    check_str('student with no grades -> null', await ge.final_grade_from_terms(db, cid, sids[2]), null);

    // ---------------------------------------------------------------
    console.log('\n== class_is_published ==');
    // ---------------------------------------------------------------
    check_str('term 1 published', await ge.class_is_published(db, cid, t1), true);
    const t3 = Number((await get('SELECT id FROM terms WHERE academic_year_id=? AND number=3', [year])).id);
    check_str('term 3 not published', await ge.class_is_published(db, cid, t3), false);

    // ---------------------------------------------------------------
    console.log('\n== descriptor_rows_all survives a re-read ==');
    // (PHP memoized per request and exposed grade_cache_flush(); the port
    // re-queries per call, so there is no cache to flush.)
    // ---------------------------------------------------------------
    const b2 = await ge.descriptor_rows_all(db);
    check('same band count after flush', b2.length, 5);
    check_str('same Advancing label', ge.descriptor_for(95, b2).label_en, 'Advancing');

    // ---------------------------------------------------------------
    // teardown
    // ---------------------------------------------------------------
    await run('DELETE FROM term_grades WHERE class_id=?', [cid]);
    await run('DELETE FROM class_term_status WHERE class_id=?', [cid]);
    await run('DELETE FROM class_members WHERE class_id=?', [cid]);
    await run('DELETE FROM classes WHERE id=?', [cid]);
    await all("DELETE FROM users WHERE email LIKE ?", [`%.${suffix}@test.local`]);

    console.log('\n' + '-'.repeat(46));
    console.log(`engine_test: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
