// ================================================================
// HTTP SMOKE TEST — drives the real running server end to end.
// Point it at a throwaway copy of the database; the dev database is
// never touched. Run: node tests/smoke_test.js  (server must be up)
// ================================================================
const BASE = process.env.SMOKE_URL || 'http://localhost:8000';

let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
    if (cond) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
}

// Minimal cookie jar across requests.
const jar = new Map();
async function req(method, path, { form, json, rawBody, headers = {}, redirect = 'manual' } = {}) {
    const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { method, redirect, headers: { ...headers } };
    if (cookieHeader) opts.headers.Cookie = cookieHeader;
    if (json !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(json);
    } else if (rawBody !== undefined) {
        // Pre-encoded body, for shapes URLSearchParams can't express (e.g.
        // the same field name submitted twice, like a real browser can).
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.body = rawBody;
    } else if (form !== undefined) {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.body = new URLSearchParams(form).toString();
    }
    const res = await fetch(BASE + path, opts);
    for (const sc of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [pair] = sc.split(';');
        const idx = pair.indexOf('=');
        jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    return res;
}

async function login(email, password) {
    jar.clear();
    const page = await req('GET', '/login.php');
    const html = await page.text();
    const csrf = (html.match(/name="csrf_token" value="([a-f0-9]{64})"/) || [])[1];
    ok(`login page (${email})`, page.status === 200 && !!csrf);
    const res = await req('POST', '/login.php', { form: { email, password, csrf_token: csrf } });
    return { status: res.status, location: res.headers.get('location') || '' };
}

async function main() {
    console.log('== front door ==');
    const root = await req('GET', '/');
    ok('/ redirects', root.status === 302 && /login\.php$/.test(root.headers.get('location') || ''));

    console.log('== teacher flow ==');
    const t = await login('teacher@school.com', 'password123');
    ok('teacher login redirects to dashboard', t.status === 302 && /dashboard\.php$/.test(t.location), `got ${t.status} ${t.location}`);

    const dash = await req('GET', '/dashboard.php');
    const dashHtml = await dash.text();
    ok('teacher dashboard renders', dash.status === 200 && dashHtml.includes('Juan Dela Cruz'));

    // Find a class id from the dashboard links.
    const classId = (dashHtml.match(/dashboard\.php\?page=class&id=(\d+)/) || [])[1];
    ok('teacher sees class links', !!classId);

    const grades = await req('GET', `/dashboard.php?page=grades&id=${classId}&term=1`);
    const gradesHtml = await grades.text();
    ok('gradebook renders', grades.status === 200 && gradesHtml.includes('id="gradebookForm"'));
    ok('gradebook has grid + inputs', gradesHtml.includes('id="gradebookGrid"') && gradesHtml.includes('class="gb-input"'));
    // The page may fall back to the class's current term when the requested
    // term is not one of the class's terms - always use the rendered one.
    const termId = (gradesHtml.match(/name="term_id" value="(\d+)"/) || [])[1];
    ok('term id resolved from the page', !!termId);
    const csrfMeta = (gradesHtml.match(/name="csrf-token" content="([a-f0-9]{64})"/) || [])[1];
    ok('csrf meta present', !!csrfMeta);
    const firstSid = (gradesHtml.match(/<tr class="gb-row" data-sid="(\d+)"/) || [])[1];
    ok('grade input found', !!firstSid && gradesHtml.includes(`name="grade[${firstSid}]"`));
    const stamp = (gradesHtml.match(new RegExp(`<tr class="gb-row" data-sid="${firstSid}" data-stamp="([^"]*)"`)) || [])[1];

    // Autosave API: save a new grade for one student.
    const api = await req('POST', '/grades_api.php', {
        headers: { 'X-CSRF-Token': csrfMeta },
        json: { class_id: Number(classId), term_id: Number(termId), changes: { [firstSid]: '91' }, stamps: { [firstSid]: stamp } },
    });
    const apiJson = await api.json();
    ok('autosave returns ok', api.status === 200 && apiJson.ok === true, `status ${api.status}`);
    ok('autosave row payload', apiJson.rows && apiJson.rows[firstSid] && apiJson.rows[firstSid].grade === 91);
    ok('autosave progress payload', apiJson.progress && typeof apiJson.progress.total === 'number');

    // No-JS fallback POST.
    const stamp2 = apiJson.rows[firstSid].stamp || '';
    const fallback = await req('POST', '/dashboard.php', {
        form: { action: 'save_term_grades', class_id: classId, term_id: termId, csrf_token: csrfMeta, [`grade[${firstSid}]`]: '93', [`stamp[${firstSid}]`]: stamp2 },
    });
    ok('no-JS save redirects back to gradebook', fallback.status === 302 && /page=grades/.test(fallback.headers.get('location') || ''), `got ${fallback.status}`);

    // Publish gate: expect refusal (demo term 2 has an ungraded student) or a
    // clean redirect; either way the action must answer and gate.
    const unpub = await req('POST', '/dashboard.php', {
        form: { action: 'publish_term', class_id: classId, term_id: termId, csrf_token: csrfMeta },
    });
    const unpubLoc = unpub.headers.get('location') || '';
    ok('publish gate responds', unpub.status === 302 && unpubLoc.includes('page=grades'));

    // CSRF must be enforced on POSTs.
    const noCsrf = await req('POST', '/dashboard.php', {
        form: { action: 'save_term_grades', class_id: classId, term_id: '1', grade: {} },
    });
    const flashPage = noCsrf.status === 302 ? await (await req('GET', '/dashboard.php')).text() : '';
    ok('CSRF failure does not save', noCsrf.status === 302 && flashPage.includes('Your session expired'), `status ${noCsrf.status}`);

    // SF9 gate: non-advisory class refused.
    const sf9 = await req('POST', '/dashboard.php', {
        form: { action: 'export_sf9', class_id: classId, student_id: firstSid, csrf_token: csrfMeta },
    });
    ok('SF9 advisory gate', sf9.status === 302, `status ${sf9.status}`);

    // Profile + change password page renders.
    const prof = await req('GET', '/dashboard.php?page=profile');
    ok('profile renders', prof.status === 200 && (await prof.text()).includes('Change Password'));

    // Logout (POST-only).
    const logout = await req('POST', '/logout.php', { form: { csrf_token: csrfMeta } });
    ok('logout redirects to login', logout.status === 302 && /login\.php$/.test(logout.headers.get('location') || ''));
    const after = await req('GET', '/dashboard.php');
    ok('session gone after logout', after.status === 302 && /login\.php$/.test(after.headers.get('location') || ''));

    console.log('== student flow ==');
    const s = await login('student@school.com', 'password123');
    ok('student login redirects to dashboard', s.status === 302 && /dashboard\.php$/.test(s.location), `got ${s.status} ${s.location}`);
    const sdash = await req('GET', '/dashboard.php');
    const sdashHtml = await sdash.text();
    ok('student dashboard renders', sdash.status === 200 && sdashHtml.includes('Alex Johnson'));
    const card = await req('GET', '/dashboard.php?page=grades');
    const cardHtml = await card.text();
    ok('report card renders', card.status === 200 && cardHtml.includes('General Average'));
    ok('released term visible on card', cardHtml.includes('Term 1'));
    const sprof = await req('GET', '/dashboard.php?page=profile');
    ok('student profile renders', sprof.status === 200 && (await sprof.text()).includes('Update Profile'));

    // Regression: browsers used to POST csrf_token twice (the navbar renders
    // one for no-JS support and script.js injected a second), which the
    // urlencoded parser hands over as an array. PHP's $_POST keeps the last
    // duplicate; the port must too, or CSRF "fails" and logout silently
    // keeps the session - the user could never log out.
    const sToken = (sdashHtml.match(/name="csrf-token" content="([a-f0-9]{64})"/) || [])[1];
    ok('student dashboard csrf meta present', !!sToken);
    const dupLogout = await req('POST', '/logout.php', { rawBody: `csrf_token=${sToken}&csrf_token=${sToken}` });
    ok('logout survives duplicate csrf fields', dupLogout.status === 302 && /login\.php$/.test(dupLogout.headers.get('location') || ''));
    const dupAfter = await req('GET', '/dashboard.php');
    ok('session gone after duplicate-csrf logout', dupAfter.status === 302 && /login\.php$/.test(dupAfter.headers.get('location') || ''));

    console.log('== admin flow ==');
    const a = await login('admin@school.com', 'password123');
    ok('admin login redirects to admin panel', a.status === 302 && /admin\.php$/.test(a.location), `got ${a.status} ${a.location}`);
    for (const p of ['overview', 'users', 'advisers', 'years', 'policies', 'calendar', 'announcements', 'audit', 'settings']) {
        const page = await req('GET', `/admin.php?page=${p}`);
        ok(`admin page ${p}`, page.status === 200);
    }
    // Downloads (while admin): upload a photo through the app, then fetch it.
    // 1x1 transparent PNG (valid magic bytes for the MIME sniff).
    const adminCsrf = ((await (await req('GET', '/dashboard.php?page=profile')).text())
        .match(/name="csrf-token" content="([a-f0-9]{64})"/) || [])[1];
    ok('admin session csrf scraped', !!adminCsrf);
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
        '1f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
    const fd = new FormData();
    fd.append('action', 'update_profile');
    fd.append('csrf_token', adminCsrf);
    fd.append('office_hours', '');
    fd.append('contact_email', 'admin@school.com');
    fd.append('photo', new Blob([png], { type: 'image/png' }), 'me.png');
    const up = await fetch(BASE + '/dashboard.php', {
        method: 'POST', redirect: 'manual',
        headers: { Cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
        body: fd,
    });
    for (const sc of (up.headers.getSetCookie ? up.headers.getSetCookie() : [])) {
        const p = sc.split(';')[0];
        const i = p.indexOf('=');
        jar.set(p.slice(0, i), p.slice(i + 1));
    }
    ok('photo upload redirects cleanly', up.status === 302, `status ${up.status}`);

    const aprof = await req('GET', '/dashboard.php?page=profile');
    const aprofHtml = await aprof.text();
    const photo = (aprofHtml.match(/download\.php\?f=([^"&]+)/) || [])[1];
    ok('uploaded photo linked on profile', !!photo && photo.endsWith('.png'), photo);
    if (photo) {
        const dl = await req('GET', `/download.php?f=${photo}`, { redirect: 'manual' });
        const dlBuf = dl.status === 200 ? Buffer.from(await dl.arrayBuffer()) : null;
        ok('authorised download serves the file', dl.status === 200 && dlBuf && dlBuf.slice(0, 4).equals(png.slice(0, 4)), `status ${dl.status}`);
    }

    // Admin guard: student cannot reach admin.php
    await req('POST', '/logout.php', { form: { csrf_token: csrfMeta } });
    await login('student@school.com', 'password123');
    const guard = await req('GET', '/admin.php');
    ok('student blocked from admin panel', guard.status === 302 && /dashboard\.php$/.test(guard.headers.get('location') || ''), `got ${guard.status}`);

    // The same photo must be refused for the student session.
    if (photo) {
        const dl2 = await req('GET', `/download.php?f=${photo}`, { redirect: 'manual' });
        ok('unauthorised download refused', dl2.status === 403 || dl2.status === 404 || dl2.status === 302, `status ${dl2.status}`);
    }

    console.log('\n' + '-'.repeat(46));
    console.log(`smoke_test: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
