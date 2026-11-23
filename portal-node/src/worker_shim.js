// ================================================================
// WORKERS RENDER SHIM — rendering without a filesystem and without eval
// ================================================================
// Cloudflare Workers has no disk AND forbids code generation at runtime
// (no eval / new Function), so neither Express's res.render() (fs view
// resolution) nor EJS's runtime compiler can run. This shim pairs with the
// precompiled src/views-compiled.js (scripts/build_views.js):
//   - res.render merges locals in Express's own order (app.locals ->
//     res.locals -> route options) and calls the precompiled function
//   - includes are resolved at runtime exactly like EJS's wrapper: relative
//     to the calling template's virtual filename, with the caller's locals
//     shallow-copied plus the include's own data
// ================================================================
const ejs = require('ejs');
const path = require('path');
const COMPILED = require('./views-compiled');

const escapeXML = ejs.escapeXML;
const VROOT = '/__views__/';

// Map a resolved (possibly Windows-flavoured) path back to its bundle key.
function to_key(resolved) {
    const p = String(resolved).replace(/\\/g, '/');
    const at = p.indexOf(VROOT);
    return at >= 0 ? p.slice(at + VROOT.length) : p;
}

// EJS's resolveInclude: append .ejs when missing, resolve relative to the
// calling template's directory on the virtual root.
function include_key(from_key, name) {
    let p = String(name);
    if (!/\.[A-Za-z0-9]+$/.test(p)) p += '.ejs';
    const resolved = path.resolve(path.dirname(VROOT + from_key), p);
    return to_key(resolved);
}

// Render a precompiled template, providing the include closure EJS's
// runtime wrapper would (locals propagate into includes; includeData
// overrides them, like shallowCopy({}, data) + shallowCopy(d, includeData)).
function render_view(key, data) {
    const fn = COMPILED[key];
    if (typeof fn !== 'function') {
        throw new Error('Failed to lookup view "' + key + '" in the compiled views bundle');
    }
    const include = function (name, includeData) {
        let d = Object.assign(Object.create(null), data);
        if (includeData) d = Object.assign(d, includeData);
        return render_view(include_key(key, name), d);
    };
    return fn(data || Object.create(null), escapeXML, include, function (e) { throw e; });
}

function apply_worker_view_shim(app) {
    app.use((req, res, next) => {
        res.render = function (name, options, callback) {
            let opts = options || {};
            let cb = callback;
            if (typeof opts === 'function') { cb = opts; opts = {}; }

            const key = name.endsWith('.ejs') ? name : name + '.ejs';

            // Express's res.render done(): with a callback the caller sends;
            // without one the html is sent here and errors go to next(err).
            const done = (err, html) => {
                if (typeof cb === 'function') return cb(err, html);
                if (err) return next(err);
                res.send(html);
            };

            // Express merges in this exact order (app.render): app.locals,
            // then res.locals (via opts._locals), then the route's options
            // last — so explicit render options win over middleware locals.
            const locals = Object.assign(Object.create(null), app.locals, res.locals, opts);
            try {
                done(null, render_view(key, locals));
            } catch (err) {
                done(err);
            }
        };
        next();
    });
}

module.exports = { apply_worker_view_shim };
