# PORTING GUIDE — PHP → Node/Express

This project is a faithful port of the PHP portal in `..` (the parent folder).
The goal: **the same URLs, the same HTML output, the same behavior** — so
`public/script.js`, `public/style.css`, `public/theme.js` and every form work
unchanged. Read this whole file before writing any code.

## Source ↔ target map

| PHP source | Node target |
|---|---|
| `config.php` | `src/config.js` (DONE — read it) |
| `db.php` | `src/db.js` (DONE — read it) |
| `grade_engine.php` | `src/grade-engine.js` (DONE — read it) |
| `config.php` handle_upload | `src/storage.js` (DONE — read it) |
| `includes/teacher.php` | `src/actions/teacher_pages.js` + `src/views/teacher/*.ejs` |
| `includes/actions.php` (teacher actions) | `src/actions/teacher_actions.js` |
| `includes/student.php` | `src/actions/student_pages.js` + `src/views/student/*.ejs` |
| `includes/actions.php` (student actions) | `src/actions/student_actions.js` |
| `admin.php` + `includes/admin.php` | `src/routes/admin.js` + `src/views/admin/*.ejs` |
| `sf9_export.php` | `src/sf9_export.js` |
| `download.php` | `src/routes/download.js` |
| `grades_api.php` | `src/routes/grades_api.js` |
| `dashboard.php` + `includes/actions.php` dispatcher | `src/routes/dashboard.js` (built separately — do NOT create it) |
| `login/register/logout/index.php` | `src/routes/auth.js` (DONE) |

## Non-negotiables

1. **URLs are identical to PHP**, including the `.php` extension and query
   strings: `/dashboard.php?page=grades&id=3&term=2`, `/grades_api.php`,
   `/download.php?f=...`, `/admin.php?page=...`. Redirects must use these.
2. **HTML output must match the PHP output**: same classes, same ids, same
   structure, same text — `style.css` and `script.js` depend on them
   (`#gradebookGrid`, `.gb-input`, `data-sid`, `data-stamp`, `#gbSaveStatus`,
   `.gb-desc`, `.gb-result`, `tr.gb-row`, `form#gradebookForm`, meta
   csrf-token, etc.). Port the markup from the PHP `echo`/heredoc blocks as
   EJS templates, line by line. Do not "improve" the UI.
3. **CSRF, role and ownership checks are ported 1:1** — nothing is dropped.
4. **Same POST field names** as the PHP forms (`action`, `class_id`,
   `csrf_token`, `grade[<sid>]`, `stamp[<sid>]`, ...). `script.js` builds
   some of them; check it when porting the gradebook.
5. CommonJS (`require`), async/await. All handlers are async.

## Database API — `require('./db')` (from `src/`) or `require('../db')`

- `await all(sql, params)` → array of row objects
- `await get(sql, params)` → first row object or `null`
- `await run(sql, params)` → `{ lastId }` (PHP's `lastInsertId()`)
- `await client.execute(sql)` — raw libsql client (transactions:
  `const tx = await client.transaction('write')` ... `await tx.commit()`)
- Rows: property access (`row.full_name`); ids/values may already be numbers —
  still wrap with `Number(...)` for safety. `null` stays `null`.
- Do NOT cache query results at module level (serverless instances are
  long-lived; admin-editable data would go stale).

## Helpers — `require('./config')` (adjust relative path)

All take `req`/`res` where PHP used superglobals:

- `current_user_id(req)`, `current_role(req)`, `is_admin_user(req)`
- `csrf_ok(req)` → bool (checks `csrf_token` body field or `X-CSRF-Token` header)
- `require_login`, `require_admin` — Express middleware
- `flash(req, msg, type='success')` → then `res.redirect(...)`; the next
  rendered page shows it automatically (`res.locals.flash`, `flash_type`)
- `audit(db, req, action, target_type, target_id, old_value, new_value)`
- `setting(db, key, def)`, `set_setting(db, key, value)`
- `notify(db, user_id, message, link, type)`, `notify_class_students(db, class_id, message, link, type)`
- `unread_count(db, user_id)`, `teacher_owns_class(db, teacher_id, class_id)`,
  `student_in_class(db, student_id, class_id)`
- `esc(html)`, `rc_grade(g, has)`, `rc_label(d, has)`, `rc_result(passed, graded)` (RAW HTML),
  `rc_grade_class(g, graded)`, `icon(name, size)` (RAW HTML)
- `today()` → Manila-local `YYYY-MM-DD` (use for due-date comparisons; PHP
  ran `date_default_timezone_set('Asia/Manila')`)

## Grade engine — `require('./grade-engine')`

`trim_num, assignment_policy, descriptor_rows_all, descriptor_for, grade_passes,
direct_term_grade, term_grade_row, term_grade_stamps, validate_term_grade,
term_grade_now, save_term_grades, class_term_progress, class_terms,
class_is_published, final_grade_from_terms, class_grade_averages, class_roster`
— same signatures as the PHP functions (first arg is the db client; pass the
`client` export from `db.js`). `descriptor_for(grade, rows)` is SYNC and needs
`rows` from `descriptor_rows_all(db)`.

## Uploads — `require('./storage')`

`save_upload(file, prefix, allowed_exts?, max_mb?)` → `{ file, error }`.
`file` is a multer file object from `req.files` (the dashboard route mounts
`upload.any()` with memory storage — find them with
`req.files.find(f => f.fieldname === 'attachment')`). Store the returned key
in the DB exactly where PHP stored the filename. `read_stored(key)` returns a
Buffer (follows blob URLs). `MAX_SIZE_MB` caps uploads (4 on Vercel).

## Views (EJS)

- Live in `src/views/<area>/*.ejs`. Include partials with
  `<%- include('../partials/app_head', { title: '...' }) %>` — always
  `../partials/...` because every template sits one level deep.
- Partials available: `app_head` (charset/viewport/bootstrap/fonts/style.css +
  csrf meta — used by dashboard/admin pages), `navbar` (role-aware shell),
  `footer`. `auth_head` is for login/register only.
- **Always available in templates** (no need to pass): `session`, `user_id`,
  `role`, `is_admin`, `full_name`, `csrf`, `csrf_field` (pre-rendered hidden
  input HTML), `h` (the helper bundle: `h.esc`, `h.rc_grade`, `h.rc_label`,
  `h.rc_result`, `h.rc_grade_class`, `h.icon`, `h.trim_num`), `flash`,
  `flash_type`.
- Escaping: `<%= %>` escapes; use it for all user data (it equals `h.esc`).
  Use `<%- %>` ONLY for `h.rc_result(...)`, `h.icon(...)`, `csrf_field`, and
  trusted constants. PHP's `htmlspecialchars()` ≡ `<%= %>`.
- Arrays from the DB (libsql rows) support `.length`, `for...of`, `.map`.
- Page-specific data is passed as the render object: e.g.
  `res.render('teacher/grades', { cls, terms, roster, rows, progress, ... })`.

## POST action pattern (port of includes/actions.php)

```js
const express = require('express');
const { csrf_ok, flash, audit, teacher_owns_class } = require('../config');

async function handle(req, res, action) {
    if (!csrf_ok(req)) {
        flash(req, 'Your session expired. Please try again.', 'danger');
        res.redirect('/dashboard.php');
        return true;
    }
    if (action === 'create_class') {
        // ...exact port of the PHP branch: same queries, same checks,
        // same flash messages, same redirect...
        res.redirect('/dashboard.php');
        return true;
    }
    return false; // unknown action -> dispatcher redirects to /dashboard.php
}
module.exports = { handle };
```

- Every branch ends by sending a response (redirect / JSON / file stream) and
  returning `true`.
- Non-teacher/student actions falling through return `false`.

## Things that differ from PHP (already handled — don't re-invent)

- Sessions: signed cookie (`req.session`). On login the router sets
  `user_id/role/is_admin/full_name`; CSRF token persists across login.
- Uploads: `save_upload()` handles local disk vs Vercel Blob transparently.
- ` grades_api.php` responses must stay byte-compatible JSON shapes:
  `{ok, saved, conflicts, rows:{"<sid>":{grade,descriptor,descriptor_fil,passed,stamp}}, progress:{...}}`
  and errors `{ok:false, error}` with status codes 400/403/405/413/419.
- Zip downloads (`download_all_submissions`) use `jszip`:
  `const zip = new JSZip(); zip.file(name, buffer); const buf = await zip.generateAsync({type:'nodebuffer'});`
  then send with `Content-Disposition: attachment; filename="..."`.
- Excel export/import uses `exceljs` ( PhpSpreadsheet replacement):
  `const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Term Grades');`
  `ws.getCell('A1').value = 'Student No.';` ... `const buf = await wb.xlsx.writeBuffer();`
  Reading: `await wb.xlsx.load(buffer)`, `ws.getRow(1).values` (1-indexed).
- Timezone: use `today()` from config for "now" dates. DB
  `CURRENT_TIMESTAMP`/`datetime('now')` stay UTC exactly like PHP.
