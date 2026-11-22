// ================================================================
// SUBMISSION POLICY ASSERTIONS (port of tests/submission_test.php)
// Run: node tests/submission_test.js
// ================================================================
const path = require('path');
const fs = require('fs');
const os = require('os');

const scratch = path.join(os.tmpdir(), 'portal-submission-test.db');
process.env.DATABASE_URL = 'file:' + scratch.replace(/\\/g, '/');
delete process.env.DATABASE_TOKEN;
if (fs.existsSync(scratch)) fs.unlinkSync(scratch);

const { initDb, client, get, run } = require('../src/db');
const ge = require('../src/grade-engine');
const { save_upload } = require('../src/storage');

let pass = 0, fail = 0;
function check(label, got, want) {
    const ok = got === want;
    if (ok) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label} = ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`); }
}
// PHP's === on arrays is element-wise + order; JSON compare is the JS stand-in.
function check_arr(label, got, want) {
    check(label, JSON.stringify(got), JSON.stringify(want));
}

async function main() {
    await initDb();
    const db = client;

    // ---- Create a throwaway assignment to test policies ----
    await run("DELETE FROM assignments WHERE title = 'POLICY_TEST'");
    let r = await run(
        "INSERT INTO assignments (class_id, title, due_date, requires_file, allowed_exts, max_size_mb, allow_late, cutoff_date) VALUES (1, 'POLICY_TEST', date('now','+1 day'), 1, 'PDF, Docx', 5, 0, date('now','+2 day'))");
    const aid = r.lastId;

    console.log('== assignment_policy: defaults & parsing ==');
    const pol = await ge.assignment_policy(db, aid);
    check('requires_file on', pol.requires_file, true);
    check_arr('custom exts lowercased+trimmed', pol.allowed_exts, ['pdf', 'docx']);
    check('max size 5', pol.max_size_mb, 5.0);
    check('allow_late off', pol.allow_late, false);
    check('cutoff set', pol.cutoff_date !== null, true);

    r = await run("INSERT INTO assignments (class_id, title, due_date) VALUES (1, 'POLICY_TEST_DEFAULT', date('now','+1 day'))");
    const did = r.lastId;
    const dpol = await ge.assignment_policy(db, did);
    check('default requires_file', dpol.requires_file, true);
    check('default allowed_exts non-empty', dpol.allowed_exts.length > 0, true);
    check('default max 10', dpol.max_size_mb, 10.0);
    check('default allow_late', dpol.allow_late, true);
    check('default cutoff null', dpol.cutoff_date, null);

    console.log('== handle_upload: enforcement ==');
    // No file given -> empty (action layer turns this into "A file is required")
    const no = await save_upload(null, 't');
    check_arr('no file -> empty', no, { file: '', error: '' });
    // Reject extension not in the allowed list
    const fake = { error: 0, size: 100, originalname: 'evil.php', buffer: Buffer.from('<?php echo 1;') };
    const bad_ext = await save_upload(fake, 't', ['pdf', 'txt'], 10);
    check('disallowed ext rejected', bad_ext.error !== '', true);
    // Reject oversize (real buffer)
    const big = { error: 0, size: 6000000, originalname: 'big.txt', buffer: Buffer.alloc(2048, 'x') };
    const big_r = await save_upload(big, 't', ['txt'], 5);
    check('oversize rejected (5MB cap)', big_r.error !== '', true);
    // (valid-file happy path is covered by the HTTP smoke test)

    // cleanup
    await run('DELETE FROM assignments WHERE id IN (?, ?)', [aid, did]);

    console.log('\n-------------------------------------');
    console.log(`RESULT: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
