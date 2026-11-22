// Test runner: executes every tests/*_test.js suite in its own process
// (each suite picks its own scratch database) and reports totals.
// Run: node tests/run_all.js   (or npm test)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const suites = fs.readdirSync(dir)
    .filter((f) => f.endsWith('_test.js'))
    // smoke_test.js drives a LIVE server (npm run dev in another terminal).
    // Opt in with RUN_SMOKE=1 once the server is up on :8000.
    .filter((f) => f !== 'smoke_test.js' || process.env.RUN_SMOKE === '1')
    .sort();

console.log(`Running ${suites.length} suite(s): ${suites.join(', ')}\n`);

let totalPass = 0, totalFail = 0, failedSuites = [];

for (const suite of suites) {
    console.log('='.repeat(60));
    console.log(`SUITE ${suite}`);
    console.log('='.repeat(60));
    const res = spawnSync(process.execPath, [path.join(dir, suite)], {
        encoding: 'utf8',
        timeout: 120000,
        env: process.env,
    });
    const out = (res.stdout || '') + (res.stderr || '');
    process.stdout.write(out.endsWith('\n') ? out : out + '\n');
    const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
    if (res.status === 0 && m) {
        totalPass += Number(m[1]);
        totalFail += Number(m[2]);
    } else {
        failedSuites.push(suite);
        totalFail += 1;
        console.log(`  !! suite ${suite} did not complete cleanly (exit ${res.status})`);
    }
    console.log('');
}

console.log('='.repeat(60));
console.log(`TOTAL: ${totalPass} passed, ${totalFail} failed` +
    (failedSuites.length ? ` | failed suites: ${failedSuites.join(', ')}` : ''));
console.log('='.repeat(60));
process.exit(totalFail === 0 ? 0 : 1);
