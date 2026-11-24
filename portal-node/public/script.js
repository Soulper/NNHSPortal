document.addEventListener('DOMContentLoaded', function() {
    var token = document.querySelector('meta[name="csrf-token"]');
    if (token) {
        document.querySelectorAll('form[method="post"], form[method="POST"]').forEach(function(f) {
            // Forms that render their token server-side (logout must work
            // without JS) already carry one. A second field would submit
            // duplicate csrf_token values - tolerated by PHP's $_POST only
            // because the last duplicate wins.
            if (f.querySelector('input[name="csrf_token"]')) return;
            var inp = document.createElement('input');
            inp.type = 'hidden';
            inp.name = 'csrf_token';
            inp.value = token.content;
            f.appendChild(inp);
        });
    }
    setTimeout(function() {
        document.querySelectorAll('.alert:not(.alert-permanent)').forEach(function(el) {
            var bs = new bootstrap.Alert(el);
            bs.close();
        });
    }, 6000);

    // ---- Gradebook grid: keyboard-first Term Grade entry with autosave ----
    var gb = document.getElementById('gradebookGrid');
    if (gb) initGradebook(gb);
});

// Mirrors rc_result() in config.php so a patched row is identical to a
// server-rendered one.
function rcResultMarkup(passed, graded) {
    if (!graded) return '<span class="rc-chip rc-none">Not graded</span>';
    if (passed) return '<span class="rc-chip rc-pass">Passed</span>';
    return '<span class="rc-chip rc-fail">Failed</span>';
}

// ------------------------------------------------------------------
// TERM GRADE GRID
// ------------------------------------------------------------------
// One editable Term Grade per student. Keyboard-first (Enter/Down moves to
// the next student, like a real register), autosaves after a short pause,
// and patches descriptor / result / progress in place from the server
// response so the page never reloads mid-session.
//
// Degrades cleanly: with JS off the same inputs are inside the form and the
// Save button posts them normally.
function initGradebook(gb) {
    var form = document.getElementById('gradebookForm');
    if (!form || !gb) return;

    var inputs = Array.prototype.slice.call(gb.querySelectorAll('input.gb-input'));
    if (!inputs.length) return;

    var statusEl  = document.getElementById('gbSaveStatus');
    var progress  = document.getElementById('gbProgress');
    var countEl   = document.getElementById('gbStatCount');
    var avgEl     = document.getElementById('gbStatAvg');
    var descEl    = document.getElementById('gbStatDesc');
    var belowEl   = document.getElementById('gbStatBelow');
    var avgCell   = document.getElementById('gbAvgCell');
    var avgDesc   = document.getElementById('gbAvgDesc');
    var bar       = progress ? progress.querySelector('.gb-progress') : null;
    var barFill   = progress ? progress.querySelector('.gb-progress-fill') : null;

    // What the server last told us for each row. Used for dirty checks and
    // for the conflict path.
    var committed = {};
    var dirty = {};        // key -> true
    var undoStack = [];

    function key(inp) { return inp.dataset.sid; }
    function trOf(inp) { return inp.closest('tr.gb-row'); }

    function committedVal(sid) {
        return Object.prototype.hasOwnProperty.call(committed, sid) ? committed[sid] : '';
    }

    // ---- status line ----
    var statusTimer = null;
    function setStatus(text, cls, hold) {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = 'gb-save-status' + (cls ? ' ' + cls : '');
        if (statusTimer) clearTimeout(statusTimer);
        if (hold) {
            statusTimer = setTimeout(function() {
                statusEl.textContent = '';
                statusEl.className = 'gb-save-status';
            }, 4000);
        }
    }

    // ---- validation, client side ----
    // Mirrors validate_term_grade() in grade_engine.php. The server re-checks
    // everything; this only stops obviously bad input from being sent.
    function parseGrade(raw) {
        var s = String(raw).trim();
        if (s === '') return { ok: true, value: null, blank: true };
        if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, error: 'Not a number' };
        var v = parseFloat(s);
        if (v < 0 || v > 100) return { ok: false, error: 'Must be 0-100' };
        return { ok: true, value: v, blank: false };
    }

    function validateInput(inp) {
        var p = parseGrade(inp.value);
        var td = inp.parentNode;
        var bad = !p.ok;
        inp.classList.toggle('cell-over', bad);
        td.classList.toggle('cell-over', bad);
        inp.setAttribute('aria-invalid', bad ? 'true' : 'false');
        return p;
    }

    // ---- cursor ----
    function focusAt(i) {
        if (i < 0 || i >= inputs.length) return;
        inputs[i].focus();
        inputs[i].select();
    }
    function indexOf(inp) { return inputs.indexOf(inp); }

    function setCursor(inp) {
        inputs.forEach(function(x) {
            x.classList.remove('gb-active');
            var tr = trOf(x);
            if (tr) tr.classList.remove('gb-hi-row');
        });
        if (!inp) return;
        inp.classList.add('gb-active');
        var tr = trOf(inp);
        if (tr) tr.classList.add('gb-hi-row');
    }

    // ---- dirty tracking ----
    function isDirty(inp) { return inp.value !== committedVal(key(inp)); }
    function dirtyList() { return inputs.filter(isDirty); }

    function markDirty(inp) {
        var p = validateInput(inp);
        if (!p.ok) {
            dirty[key(inp)] = true;
            setStatus('Not saved: ' + p.error, 'is-error', true);
            return false;
        }
        if (isDirty(inp)) dirty[key(inp)] = true;
        else delete dirty[key(inp)];
        return true;
    }

    function refreshDirty() {
        var n = dirtyList().length;
        if (!n) setStatus('');
    }

    // ---- undo ----
    function pushUndo(snap, label) {
        undoStack.push({ snap: snap, label: label });
        if (undoStack.length > 50) undoStack.shift();
    }
    function snapshot(list) {
        var m = {};
        list.forEach(function(i) { m[key(i)] = i.value; });
        return m;
    }
    function applyValues(map) {
        var first = null;
        Object.keys(map).forEach(function(sid) {
            var inp = gb.querySelector('input.gb-input[data-sid="' + sid + '"]');
            if (!inp) return;
            inp.value = map[sid];
            validateInput(inp);
            if (isDirty(inp)) dirty[sid] = true; else delete dirty[sid];
            if (!first) first = inp;
        });
        if (first) { setCursor(first); first.focus(); first.select(); }
        refreshDirty();
        scheduleFlush();
    }

    // ---- paste: one grade per line ----
    function pasteValues(text) {
        var vals = String(text).split(/[\r\n\t,;]+/).map(function(s) { return s.trim(); })
                  .filter(function(s) { return s !== ''; });
        if (!vals.length) return false;
        var start = indexOf(document.activeElement);
        if (start < 0) start = 0;
        var map = {};
        var n = Math.min(vals.length, inputs.length - start);
        for (var i = 0; i < n; i++) map[key(inputs[start + i])] = vals[i];
        pushUndo(snapshot(inputs.slice(start, start + n)), 'Paste');
        applyValues(map);
        setStatus('Pasted ' + n + ' grade(s).', '', true);
        return true;
    }

    // ---- network ----
    var flushTimer = null;
    var inflight = false;

    function scheduleFlush() {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, 600);
    }

    function flush() {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (inflight) return;
        var list = dirtyList();
        if (!list.length) return;

        var changes = {}, stamps = {};
        list.forEach(function(inp) {
            var p = parseGrade(inp.value);
            if (!p.ok) return; // skip invalid; status already shows why
            changes[key(inp)] = inp.value.trim();
            var tr = trOf(inp);
            if (tr) stamps[key(inp)] = tr.dataset.stamp || '';
        });
        if (!Object.keys(changes).length) return;

        inflight = true;
        setStatus('Saving…', 'is-busy');

        var body = {
            class_id: form.querySelector('[name="class_id"]').value,
            term_id:  form.querySelector('[name="term_id"]').value,
            changes: changes,
            stamps: stamps
        };

        fetch('grades_api.php', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken()
            },
            body: JSON.stringify(body)
        })
        .then(function(r) { return r.json().then(function(j) { return { status: r.status, json: j }; }); })
        .then(function(res) {
            inflight = false;
            var j = res.json || {};
            if (!j.ok) {
                setStatus('Not saved: ' + (j.error || 'server error'), 'is-error', true);
                return;
            }
            applyServer(j);
            var conflicts = j.conflicts || [];
            if (conflicts.length) {
                setStatus('Saved, but ' + conflicts.length +
                    ' row(s) were changed elsewhere and were NOT overwritten. Reload to see the current value.',
                    'is-error', true);
            } else {
                setStatus('Saved ' + Object.keys(changes).length + ' grade(s).', 'is-ok', true);
            }
        })
        .catch(function(err) {
            inflight = false;
            setStatus('Could not reach the server. Your edits are still here — press Save.', 'is-error', true);
        });
    }

    // Adopt the server's version of each row. This is what removes the need to
    // reload: descriptors, pass/fail and the whole progress strip update here.
    function applyServer(j) {
        var rows = j.rows || {};

        Object.keys(rows).forEach(function(sid) {
            var row = rows[sid];
            var inp = gb.querySelector('input.gb-input[data-sid="' + sid + '"]');
            var tr = gb.querySelector('tr.gb-row[data-sid="' + sid + '"]');
            if (tr) tr.dataset.stamp = row.stamp || '';
            if (!inp || !tr) return;

            // Server normalised the value (e.g. "87.0" -> "87").
            committed[sid] = row.grade === null || row.grade === undefined
                ? '' : String(row.grade).replace(/\.0+$/, '');
            if (document.activeElement !== inp) inp.value = committed[sid];
            else if (parseFloat(inp.value) === row.grade) committed[sid] = inp.value;

            if (!isDirty(inp)) delete dirty[sid];

            var desc = tr.querySelector('.gb-desc');
            if (desc) desc.textContent = row.descriptor || '';
            var res = tr.querySelector('.gb-result');
            if (res) res.innerHTML = rcResultMarkup(
                !!row.passed,
                row.grade !== null && row.grade !== undefined
            );
            tr.classList.toggle('gb-row-pass', !!row.passed);
            tr.classList.toggle('gb-row-fail', row.grade !== null && row.grade !== undefined && !row.passed);
            tr.classList.toggle('gb-row-none', row.grade === null || row.grade === undefined);
        });

        updateProgress(j.progress);
    }

    function updateProgress(p) {
        if (!p) return;
        var total = p.total || 0;
        var pct = total ? Math.round(p.graded / total * 100) : 0;
        if (barFill) barFill.style.width = pct + '%';
        if (bar) bar.setAttribute('aria-valuenow', String(pct));
        if (countEl) countEl.innerHTML = '<strong>' + p.graded + '</strong> of <strong>' + total + '</strong> students graded';
        if (avgEl) avgEl.textContent = (p.average === null || p.average === undefined) ? '—' : String(p.average);
        if (avgCell) avgCell.textContent = (p.average === null || p.average === undefined) ? '—' : String(p.average);
        if (descEl) descEl.textContent = p.descriptor || '';
        if (avgDesc) avgDesc.textContent = p.descriptor || '';
        if (belowEl) {
            belowEl.textContent = p.below_passing > 0 ? (p.below_passing + ' below 75') : '';
            belowEl.hidden = !p.below_passing;
        }

        // Reveal the release CTA the moment the last student is graded, and
        // hide it again if an edit reopens a gap. The server re-checks
        // completeness on submit, so this is only a hint.
        var cta = document.querySelector('button[form="gbPublishForm"]');
        if (cta) {
            var shouldShow = !!(p.complete && !p.published);
            cta.hidden = !shouldShow;
            var saveBtn = form.querySelector('button[type="submit"]:not([form])');
            if (saveBtn) {
                // Keep exactly one button pushed right when both are visible.
                saveBtn.classList.toggle('ms-auto', !shouldShow);
                cta.classList.toggle('ms-auto', false);
            }
        }
    }

    // ---- events ----
    inputs.forEach(function(inp) {
        committed[key(inp)] = inp.value;

        inp.addEventListener('focus', function() { setCursor(inp); });

        inp.addEventListener('input', function() {
            if (markDirty(inp)) scheduleFlush();
        });

        inp.addEventListener('blur', function() {
            if (isDirty(inp)) flush();
        });

        inp.addEventListener('keydown', function(e) {
            var i = indexOf(inp);
            switch (e.key) {
                case 'Enter':
                case 'ArrowDown':
                    e.preventDefault();
                    focusAt(i + 1);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    focusAt(i - 1);
                    break;
                case 'Home':
                    e.preventDefault();
                    focusAt(0);
                    break;
                case 'End':
                    e.preventDefault();
                    focusAt(inputs.length - 1);
                    break;
                case 'Escape':
                    inp.value = committedVal(key(inp));
                    validateInput(inp);
                    if (!isDirty(inp)) delete dirty[key(inp)];
                    setStatus('');
                    e.preventDefault();
                    break;
            }
        });

        inp.addEventListener('paste', function(e) {
            var text = (e.clipboardData || window.clipboardData).getData('text');
            if (text && /[\r\n,;\t]/.test(text)) {
                e.preventDefault();
                pasteValues(text);
            }
        });
    });

    document.addEventListener('keydown', function(e) {
        var tag = (e.target.tagName || '').toLowerCase();
        var inGrid = inputs.indexOf(document.activeElement) !== -1;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && inGrid) {
            e.preventDefault();
            var u = undoStack.pop();
            if (u) applyValues(u.snap);
        }
    });

    // Submitting by keyboard must flush first, or the last keystrokes race the
    // POST. The form still carries every value, so this only avoids a stale UI.
    form.addEventListener('submit', function() {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    });

    inputs[0].focus();
}

function csrfToken() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.content : '';
}
