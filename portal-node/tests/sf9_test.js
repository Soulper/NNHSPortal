// ================================================================
// SF9 EXPORT ASSERTIONS (port of tests/sf9_test.php)
// Run: node tests/sf9_test.js
//
// The SF9 is the printed form of the report card: only released terms
// may appear, unreleased/ungraded cells must stay blank, and none of
// the template's sample learner data may survive the fill.
// ================================================================
const path = require('path');
const fs = require('fs');
const os = require('os');

const scratch = path.join(os.tmpdir(), 'portal-sf9-test.db');
process.env.DATABASE_URL = 'file:' + scratch.replace(/\\/g, '/');
delete process.env.DATABASE_TOKEN;
if (fs.existsSync(scratch)) fs.unlinkSync(scratch);

const { initDb, client, get, run } = require('../src/db');
const sf9 = require('../src/sf9_export');
const ExcelJS = require('exceljs');

let pass = 0, fail = 0;
function check_str(label, got, want) {
    if (got === want) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label} = ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`); }
}
function check_num(label, got, want) {
    if (Math.abs(Number(got) - Number(want)) < 0.011) { pass++; console.log(`  PASS  ${label} = ${got}`); }
    else { fail++; console.log(`  FAIL  ${label} = ${JSON.stringify(got)} (expected ${want})`); }
}
function check(label, got, want) { check_num(label, got, want); }

// ExcelJS: does any cell on the sheet still hold a formula?
function count_formulas(wb) {
    let n = 0;
    for (const ws of wb.worksheets) {
        for (let r = 1; r <= ws.rowCount; r++) {
            for (let c = 1; c <= ws.columnCount; c++) {
                const cell = ws.getRow(r).getCell(c);
                if (cell.type === ExcelJS.ValueType.Formula) n++;
            }
        }
    }
    return n;
}

async function main() {
    await initDb();
    const db = client;

    // ---------------------------------------------------------------
    // Fixture: one throwaway class, two students, three terms.
    // Term 1 + 2 released (one grade failing for student B), Term 3 recorded
    // but NOT released - it must not appear anywhere on the SF9.
    // ---------------------------------------------------------------
    const teacher_id = Number((await get("SELECT user_id FROM teachers WHERE employee_number='TCH-001'")).user_id);
    const studentRows = (await require('../src/db').all('SELECT s.user_id, s.full_name, s.section FROM students s ORDER BY s.user_id LIMIT 2'));
    const [stuA, stuB] = studentRows;

    const year_id = Number((await get('SELECT id FROM academic_years WHERE is_active=1 LIMIT 1')).id);
    const terms = {};
    for (const t of await require('../src/db').all('SELECT id, number FROM terms WHERE academic_year_id=? AND number>0 ORDER BY number', [year_id])) {
        terms[Number(t.number)] = Number(t.id);
    }
    const [t1, t2, t3] = [terms[1], terms[2], terms[3]];

    const code = 'SF9TEST1';
    await run('DELETE FROM classes WHERE join_code=?', [code]);
    let r = await run(
        'INSERT INTO classes (teacher_id, subject, section, school_year, description, join_code, academic_year_id) VALUES (?,?,?,?,?,?,?)',
        [teacher_id, 'Research I', 'SF9-SEC', '2099-2100', 'sf9 fixture', code, year_id]);
    const cid = r.lastId;
    await run('INSERT OR IGNORE INTO class_members (class_id, student_id) VALUES (?,?)', [cid, stuA.user_id]);
    await run('INSERT OR IGNORE INTO class_members (class_id, student_id) VALUES (?,?)', [cid, stuB.user_id]);
    const g = [
        [cid, t1, stuA.user_id, 90],
        [cid, t2, stuA.user_id, 94],
        [cid, t3, stuA.user_id, 96], // recorded but NOT released
        [cid, t1, stuB.user_id, 60],
        [cid, t2, stuB.user_id, 70],
    ];
    for (const row of g) await run('INSERT OR IGNORE INTO term_grades (class_id, term_id, student_id, grade) VALUES (?,?,?,?)', row);
    await run('INSERT OR IGNORE INTO class_term_status (class_id, term_id) VALUES (?,?)', [cid, t1]);
    await run('INSERT OR IGNORE INTO class_term_status (class_id, term_id) VALUES (?,?)', [cid, t2]);

    async function sf9_fixture_build(student_id) {
        const y = await get('SELECT academic_year_id AS y FROM classes WHERE id=?', [cid]);
        return sf9.sf9_build(db, student_id, Number(y.y), 'TEST ADVISER');
    }

    try {
        const ssA = await sf9_fixture_build(stuA.user_id);
        const sh = ssA.getWorksheet('SF9 FRONT');

        // ---------------------------------------------------------------
        console.log('== learner info ==');
        // ---------------------------------------------------------------
        check_str('name block 1 (B13)', sh.getCell('B13').value, stuA.full_name);
        check_str('name block 2 (L13)', sh.getCell('L13').value, stuA.full_name);
        check_str('name block 3 (V13)', sh.getCell('V13').value, stuA.full_name);
        check_str('section (C14)', sh.getCell('C14').value, String(stuA.section));
        check_str('adviser (D22)', sh.getCell('D22').value, 'TEST ADVISER');
        check_str('adviser block 3 (X22)', sh.getCell('X22').value, 'TEST ADVISER');

        // ---------------------------------------------------------------
        console.log('\n== learning areas (from the student\'s real enrolment) ==');
        // ---------------------------------------------------------------
        const year_id_f = Number((await get('SELECT academic_year_id AS y FROM classes WHERE id=?', [cid])).y);
        const expected = await sf9.sf9_subject_classes(db, stuA.user_id, year_id_f);
        const rowOf = {};
        expected.forEach((ec, i) => { rowOf[ec.subject] = sf9.SF9_ROW_FIRST_SUBJECT + i; });
        check_str('first slot = first enrolled subject (A30)', sh.getCell('A30').value, String(expected[0].subject));
        check_str('fixture subject present', rowOf['Research I'] !== undefined ? 'yes' : 'no', 'yes');
        const empty_slot = sf9.SF9_ROW_FIRST_SUBJECT + expected.length;
        check_str(`first unused slot cleared (A${empty_slot})`, sh.getCell('A' + empty_slot).value, '');

        // ---------------------------------------------------------------
        console.log('\n== grades: released terms only ==');
        // ---------------------------------------------------------------
        const rr = rowOf['Research I'];
        check_num(`Term 1 grade (D${rr})`, sh.getCell('D' + rr).value, 90);
        check_num(`Term 2 grade (E${rr})`, sh.getCell('E' + rr).value, 94);
        check_str(`unreleased Term 3 is blank (F${rr})`, sh.getCell('F' + rr).value, '');
        check_num(`final = avg of released (H${rr})`, sh.getCell('H' + rr).value, 92);
        check_str(`remarks Passed (I${rr})`, sh.getCell('I' + rr).value, 'Passed');

        // Expected general average, computed straight from the DB using the
        // SAME rule as sf9_build: only released terms contribute. (The PHP
        // original's expectation loop omitted the release gate — a latent
        // inconsistency in tests/sf9_test.php; the implementation gates.)
        const ge = require('../src/grade-engine');
        const exp_finals = [];
        for (const ec of expected) {
            const vals = [];
            for (const tid of [t1, t2]) {
                if (!(await ge.class_is_published(db, ec.id, tid))) continue;
                const q = await get('SELECT grade FROM term_grades WHERE class_id=? AND term_id=? AND student_id=?',
                    [ec.id, tid, stuA.user_id]);
                if (q && q.grade !== null && q.grade !== undefined) vals.push(Number(q.grade));
            }
            if (vals.length) exp_finals.push(Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100);
        }
        const exp_general = exp_finals.length ? Math.round((exp_finals.reduce((a, b) => a + b, 0) / exp_finals.length) * 100) / 100 : null;
        check_num('general average block 1 (H42)', sh.getCell('H42').value, exp_general);
        check_num('general average block 2 (R42)', sh.getCell('R42').value, exp_general);
        check_num('general average block 3 (AB42)', sh.getCell('AB42').value, exp_general);

        // Failing student: 60 + 70 -> final 65 -> Failed.
        const ssB = await sf9_fixture_build(stuB.user_id);
        const shB = ssB.getWorksheet('SF9 FRONT');
        const expectedB = await sf9.sf9_subject_classes(db, stuB.user_id, year_id_f);
        let rowB = sf9.SF9_ROW_FIRST_SUBJECT + expectedB.length; // default: not found
        for (let i = 0; i < expectedB.length; i++) {
            if (expectedB[i].subject === 'Research I') { rowB = sf9.SF9_ROW_FIRST_SUBJECT + i; break; }
        }
        check_num(`failing final (H${rowB})`, shB.getCell('H' + rowB).value, 65);
        check_str(`remarks Failed (I${rowB})`, shB.getCell('I' + rowB).value, 'Failed');

        // ---------------------------------------------------------------
        console.log('\n== no template sample data survives ==');
        // ---------------------------------------------------------------
        let flat = '';
        sh.eachRow((row) => {
            row.eachCell({ includeEmpty: false }, (cell) => { flat += String(cell.value ?? '') + '\n'; });
        });
        check_str('no sample adviser', !flat.includes('JUAN A. DELA CRUZ') ? 'absent' : 'present', 'absent');
        check_str('no sample section', !flat.includes('12-ACAD ANATOMY') ? 'absent' : 'present', 'absent');

        // ---------------------------------------------------------------
        console.log('\n== workbook is fully static (no formulas -> no Excel repair) ==');
        // ---------------------------------------------------------------
        check('formula cells remaining', count_formulas(ssA), 0);

        const back = ssA.getWorksheet('SF9 BACK');
        check_str('BACK learner name (A1)', back.getCell('A1').value, stuA.full_name);
        check_str('BACK adviser (G41)', back.getCell('G41').value, 'TEST ADVISER');
        check_str('BACK sample comment cleared (P10)', back.getCell('P10').value, '');
        check_str('BACK attendance present blank (B6)', back.getCell('B6').value, '');
        check_num('BACK school days kept (B5)', back.getCell('B5').value, 16);

        // ---------------------------------------------------------------
        console.log('\n== adviser designation (advisory class) ==');
        // ---------------------------------------------------------------
        // Make the test self-contained: clear any pre-existing advisory flags in
        // this year, then restore them at the end.
        const preAdvisory = (await require('../src/db').all('SELECT id FROM classes WHERE academic_year_id=? AND is_advisory=1', [year_id_f]))
            .map((x) => Number(x.id));
        await run('UPDATE classes SET is_advisory=0 WHERE academic_year_id=?', [year_id_f]);
        // No advisory class anywhere -> no adviser.
        check_str('no advisory class -> blank adviser', await sf9.sf9_default_adviser(db, stuA.user_id, year_id_f), '');
        // Flag the fixture class as the advisory class -> its teacher is the adviser.
        await run('UPDATE classes SET is_advisory=1 WHERE id=?', [cid]);
        const adv_name = String((await get('SELECT full_name FROM teachers WHERE user_id=?', [teacher_id])).full_name);
        check_str('advisory class teacher is the adviser', await sf9.sf9_default_adviser(db, stuA.user_id, year_id_f), adv_name);
        // The SF9 build uses it when no adviser name is passed.
        const ssAdv = await sf9.sf9_build(db, stuA.user_id, year_id_f);
        check_str('SF9 adviser cell from designation', ssAdv.getWorksheet('SF9 FRONT').getCell('D22').value, adv_name);
        // Revoking the flag takes the right away again.
        await run('UPDATE classes SET is_advisory=0 WHERE id=?', [cid]);
        check_str('revoked flag -> blank adviser again', await sf9.sf9_default_adviser(db, stuA.user_id, year_id_f), '');

        // Restore any advisory designations the test cleared.
        for (const pid of preAdvisory) await run('UPDATE classes SET is_advisory=1 WHERE id=?', [pid]);

        // Round-trip: the workbook must actually save and reopen cleanly.
        const out = path.join(os.tmpdir(), 'sf9_roundtrip.xlsx');
        const buf = Buffer.from(await ssA.xlsx.writeBuffer());
        fs.writeFileSync(out, buf);
        const re = new ExcelJS.Workbook();
        await re.xlsx.load(buf);
        check_str('round-trip name', re.getWorksheet('SF9 FRONT').getCell('B13').value, stuA.full_name);
        fs.unlinkSync(out);
    } finally {
        await run('DELETE FROM classes WHERE id=?', [cid]);
    }

    console.log('\n----------------------------------------------');
    console.log(`sf9_test: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
