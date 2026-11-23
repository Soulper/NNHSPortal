// ================================================================
// SF9 (F138 / REPORT CARD) EXPORT — port of sf9_export.php
// ================================================================
// Fills the official school template with a student's released Term
// Grades and streams the workbook, ready to print in Excel.
// ExcelJS replaces PhpSpreadsheet; the cell layout is identical.
// ================================================================
//
// Template layout (SF9 FRONT sheet is triplicate - three identical
// blocks side by side for the three printed copies per learner).
// Column offsets per block: block 1 starts at A (offset 0), block 2
// at K (offset 10), block 3 at U (offset 20).
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const { get, all } = require('./db');
const { class_is_published, direct_term_grade, PASSING_MARK } = require('./grade-engine');

const SF9_TEMPLATE = path.join(__dirname, '..', 'templates', 'G12-ACADEMIC_MANUAL_SF9-SY-2026-2027.xlsx');

// Rows (identical in every block)
const SF9_ROW_NAME = 13;
const SF9_ROW_SECTION = 14;
const SF9_ROW_LRN = 15;
const SF9_ROW_AGE = 14;
const SF9_ROW_SEX = 15;
const SF9_ROW_ADVISER = 22;
const SF9_ROW_FIRST_SUBJECT = 30;
const SF9_SUBJECT_SLOTS = 12;
const SF9_ROW_GENERAL_AVG = 42;

// Column positions within a block (1-based as PhpSpreadsheet expected;
// block 1 adds offset 0, block 2 offset 10, block 3 offset 20).
const SF9_COL = {
    name: 2,        // B
    section: 3,     // C
    lrn: 2,         // B
    age: 9,         // I
    sex: 9,         // I
    adviser: 4,     // D
    subject: 1,     // A
    term1: 4,       // D
    term2: 5,       // E
    term3: 6,       // F
    units: 7,       // G
    final: 8,       // H
    remarks: 9,     // I
    genavg: 8,      // H
};

// PhpSpreadsheet's setCellValueByColumnAndRow($col, $row, $value) — ExcelJS
// addresses cells as (row, column), so the arguments are swapped here on
// purpose. Writing to a merged slave routes to its master (same as PHP).
function set_cell(sheet, col, row, value) {
    sheet.getCell(row, col).value = value;
}

// Load the template fresh for every export so the master copy is never touched.
// On Workers there is no filesystem: scripts/build_views.js also bundles the
// template as base64 (src/sf9-template-b64.js), which is read here instead.
function sf9_template_buffer() {
    if (process.env.WORKER_MODE === '1') {
        return Buffer.from(require('./sf9-template-b64').data, 'base64');
    }
    if (!fs.existsSync(SF9_TEMPLATE)) {
        throw new Error('SF9 template is missing: ' + SF9_TEMPLATE);
    }
    return fs.readFileSync(SF9_TEMPLATE);
}

async function sf9_load_template() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(sf9_template_buffer());
    return wb;
}

// Replace every formula with its cached result. The template ships with
// formulas that reference an external workbook (e.g. =[1]INFO!D58 on the BACK
// sheet); saved without that workbook they make Excel "repair" the file and
// strip the formulas. The portal computes finals and averages itself, so a
// fully static workbook is both safe and print-stable.
// (ExcelJS exposes the cached value of a formula cell as `cell.result`;
// shared-formula slaves resolve through the translated formula.)
function sf9_flatten_formulas(sheet) {
    sheet.eachRow((row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
            if (cell && cell.formula) {
                const old = cell.result;
                cell.value = (old === null || old === undefined) ? '' : old;
            }
        });
    });
}

// The student's enrolled classes for one academic year, ordered like the
// on-screen report card (by subject name), capped at the template's slots.
async function sf9_subject_classes(db, student_id, year_id) {
    const rows = await all(
        `SELECT c.* FROM classes c
         JOIN class_members cm ON cm.class_id = c.id
         WHERE cm.student_id=? AND c.academic_year_id=?
         ORDER BY c.subject`, [Number(student_id), Number(year_id)]);
    return rows.slice(0, SF9_SUBJECT_SLOTS);
}

// The school year's numbered terms (Term 1 / 2 / 3), legacy whole-year rows excluded.
async function sf9_year_terms(db, year_id) {
    return all('SELECT * FROM terms WHERE academic_year_id=? AND number>0 ORDER BY number', [Number(year_id)]);
}

// The adviser for one student: the teacher of the student's ADVISORY class
// (classes.is_advisory) in that school year. Blank when nobody is designated.
async function sf9_default_adviser(db, student_id, year_id) {
    const r = await get(
        `SELECT t.full_name FROM classes c
         JOIN teachers t ON t.user_id = c.teacher_id
         JOIN class_members cm ON cm.class_id = c.id
         WHERE cm.student_id=? AND c.academic_year_id=? AND c.is_advisory=1
         ORDER BY c.subject LIMIT 1`, [Number(student_id), Number(year_id)]);
    return r ? String(r.full_name ?? '') : '';
}

// Build the filled workbook. Only RELEASED terms are written - the SF9 is
// the printed form of the report card, so it obeys the same privacy rule.
async function sf9_build(db, student_id, year_id, adviser_name = null) {
    student_id = Number(student_id);
    year_id = Number(year_id);

    const student = await get('SELECT * FROM students WHERE user_id=?', [student_id]);
    if (!student) throw new Error('Student not found.');

    const classes = await sf9_subject_classes(db, student_id, year_id);
    if (!classes.length) throw new Error('The student has no classes in this school year.');

    const terms = await sf9_year_terms(db, year_id);
    if (!terms.length) throw new Error('This school year has no terms.');

    if (adviser_name === null || String(adviser_name ?? '').trim() === '') {
        adviser_name = await sf9_default_adviser(db, student_id, year_id);
    }

    // Per class: released term grades -> [term_id => grade], plus the final.
    const rows = {};
    const finals = [];
    for (const c of classes) {
        const cid = Number(c.id);
        const per_term = {};
        for (const t of terms) {
            const tid = Number(t.id);
            per_term[tid] = (await class_is_published(db, cid, tid))
                ? await direct_term_grade(db, cid, student_id, tid)
                : null;
        }
        const vals = Object.values(per_term).filter((g) => g !== null);
        rows[cid] = {
            subject: String(c.subject),
            per_term,
            final: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null,
        };
        if (rows[cid].final !== null) finals.push(rows[cid].final);
    }
    const general = finals.length ? Math.round((finals.reduce((a, b) => a + b, 0) / finals.length) * 100) / 100 : null;

    const ss = await sf9_load_template();
    const sheet = ss.getWorksheet('SF9 FRONT');
    if (!sheet) throw new Error('SF9 FRONT sheet is missing from the template.');

    const term_ids = terms.map((t) => Number(t.id));
    const term_cols = [SF9_COL.term1, SF9_COL.term2, SF9_COL.term3];

    // The template ships with sample learner data; every fillable cell is
    // written (or explicitly cleared) so nothing sample ever survives.
    for (const off of [0, 10, 20]) {
        set_cell(sheet, SF9_COL.name + off, SF9_ROW_NAME, String(student.full_name ?? ''));
        set_cell(sheet, SF9_COL.section + off, SF9_ROW_SECTION, String(student.section ?? ''));
        set_cell(sheet, SF9_COL.lrn + off, SF9_ROW_LRN, '');
        set_cell(sheet, SF9_COL.age + off, SF9_ROW_AGE, '');
        set_cell(sheet, SF9_COL.sex + off, SF9_ROW_SEX, '');
        set_cell(sheet, SF9_COL.adviser + off, SF9_ROW_ADVISER, String(adviser_name ?? ''));

        for (let i = 0; i < SF9_SUBJECT_SLOTS; i++) {
            const row = SF9_ROW_FIRST_SUBJECT + i;
            if (i < classes.length) {
                const cid = Number(classes[i].id);
                set_cell(sheet, SF9_COL.subject + off, row, rows[cid].subject);
                for (let ti = 0; ti < term_ids.length; ti++) {
                    if (ti >= term_cols.length) break;
                    const g = rows[cid].per_term[term_ids[ti]];
                    set_cell(sheet, term_cols[ti] + off, row, g === null ? '' : Number(g));
                }
                set_cell(sheet, SF9_COL.final + off, row, rows[cid].final === null ? '' : Number(rows[cid].final));
                set_cell(sheet, SF9_COL.remarks + off, row, rows[cid].final === null ? '' : (rows[cid].final >= PASSING_MARK ? 'Passed' : 'Failed'));
            } else {
                // Empty slot: wipe the subject name and every grade cell.
                for (const col of [SF9_COL.subject, SF9_COL.term1, SF9_COL.term2, SF9_COL.term3,
                    SF9_COL.units, SF9_COL.final, SF9_COL.remarks]) {
                    set_cell(sheet, col + off, row, '');
                }
            }
        }

        set_cell(sheet, SF9_COL.genavg + off, SF9_ROW_GENERAL_AVG, general === null ? '' : Number(general));
    }

    // --- SF9 BACK sheet: learner name, adviser, and sample cleanup ---
    // Block offsets on the BACK sheet are wider (A..M, O..AA, AC..AO).
    const back = ss.getWorksheet('SF9 BACK');
    if (back) {
        for (const off of [0, 14, 28]) {
            set_cell(back, 1 + off, 1, String(student.full_name ?? ''));  // learner name
            set_cell(back, 7 + off, 41, String(adviser_name ?? ''));      // adviser (kills the external-link formula)
            set_cell(back, 2 + off, 10, '');                              // sample teacher comment
        }
        // Attendance is not tracked per month yet: blank the present/absent
        // rows and totals so the school can fill them in by hand. The
        // "No. of school days" row is the school's own calendar data and stays.
        for (const off of [0, 14, 28]) {
            for (let col = 2; col <= 12; col++) {
                set_cell(back, col + off, 6, '');
                set_cell(back, col + off, 7, '');
            }
            set_cell(back, 13 + off, 6, '');
            set_cell(back, 13 + off, 7, '');
        }
        sf9_flatten_formulas(back);
    }

    // FRONT leftovers (the =C14 / =E15 copy chains) become static too.
    sf9_flatten_formulas(sheet);

    return ss;
}

// Stream the workbook as a download. Must run before any other output.
async function sf9_stream(workbook, res, filename) {
    const safe = String(filename ?? '').replace(/[^A-Za-z0-9_-]+/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safe + '.xlsx"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
}

// Shared filename builder so teacher and student exports look the same.
// (PHP applies the character sanitization in sf9_stream(), so this returns
// the pre-sanitized format exactly like sf9_filename() did.)
function sf9_filename(student_name, year_label = '') {
    return 'SF9_' + String(student_name ?? '').trim() + (year_label !== '' ? '_' + (year_label ?? '') : '');
}

module.exports = { sf9_build, sf9_filename, sf9_stream, sf9_subject_classes, sf9_default_adviser, SF9_ROW_FIRST_SUBJECT };
