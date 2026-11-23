// ================================================================
// WORKERS RENDER SHIM — rendering without a filesystem
// ================================================================
// Cloudflare Workers has no disk: Express's res.render() resolves view
// files with fs.stat and EJS reads templates with fs.readFileSync, so both
// must be redirected to the generated views-bundle.js. This shim:
//   1. overrides ejs.fileLoader so include() reads partials from the bundle
//   2. replaces res.render with a version that compiles straight from the
//      bundle (bypassing Express's fs-based view resolution)
// Locals are merged in Express's own order: app.locals -> options -> res.locals.
// ================================================================
const ejs = require('ejs');
const fs = require('fs');
const VIEWS = require('./views-bundle');

// Virtual root under which template filenames live. Includes are resolved
// relative to it (ejs resolves include paths with path.resolve), so
// include('../partials/app_head') from 'auth/login.ejs' lands on
// '/__views__/partials/app_head.ejs' and fileLoader strips the prefix.
const VROOT = '/__views__/';

// Map a resolved (possibly Windows-flavoured) path back to its bundle key,
// or null when the path is not a bundled template.
function bundle_key(filePath) {
    const p = String(filePath).replace(/\\/g, '/');
    const at = p.indexOf(VROOT);
    if (at < 0) return null;
    const key = p.slice(at + VROOT.length);
    return key in VIEWS ? key : null;
}

ejs.fileLoader = function (filePath) {
    const key = bundle_key(filePath);
    if (key === null) throw new Error('View not found: ' + filePath);
    return VIEWS[key];
};

// ejs's getIncludePath probes fs.existsSync on the resolved include path
// before ever calling fileLoader, so the virtual tree must answer there too.
// (Everything else still delegates to the real fs.)
const orig_exists = fs.existsSync;
fs.existsSync = function (filePath) {
    if (bundle_key(filePath) !== null) return true;
    return orig_exists.call(fs, filePath);
};

function apply_worker_view_shim(app) {
    app.use((req, res, next) => {
        res.render = function (name, options, callback) {
            let opts = options || {};
            let cb = callback;
            if (typeof opts === 'function') { cb = opts; opts = {}; }

            const key = name.endsWith('.ejs') ? name : name + '.ejs';
            const tpl = VIEWS[key];

            // Express's res.render done(): with a callback the caller sends;
            // without one the html is sent here and errors go to next(err).
            const done = (err, html) => {
                if (typeof cb === 'function') return cb(err, html);
                if (err) return next(err);
                res.send(html);
            };

            if (tpl === undefined) {
                return done(new Error('Failed to lookup view "' + name + '" in views bundle'));
            }

            // Express merges in this exact order (app.render): app.locals,
            // then res.locals (via opts._locals), then the route's options
            // last — so explicit render options win over middleware locals.
            const locals = Object.assign({}, app.locals, res.locals, opts);
            try {
                const html = ejs.render(tpl, locals, {
                    filename: VROOT + key,
                    cache: true,          // compiled per virtual filename; locals stay dynamic
                    ...opts,
                });
                done(null, html);
            } catch (err) {
                done(err);
            }
        };
        next();
    });
}

module.exports = { apply_worker_view_shim };
