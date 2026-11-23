// ================================================================
// EXPRESS APP (the "config.php + web server" of the Node port)
// ================================================================
// One app object is exported: server.js listens on it locally, and Vercel
// runs it as the serverless function named in vercel.json.
// ================================================================
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const { initDb } = require('../src/db');
const { session_middleware, flash_middleware } = require('../src/config');

// WORKER_MODE: running on Cloudflare Workers (see wrangler.jsonc). Defined
// before any filesystem touch — Workers has no disk, so all path uses are
// skipped there and __dirname is not even defined in the ESM bundle.
const WORKER_MODE = process.env.WORKER_MODE === '1';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // real client IP behind Vercel's/Cloudflare's proxy

app.set('view engine', 'ejs');
// Workers renders from the generated views bundle (src/worker_shim.js), which
// bypasses Express's fs-based view resolution entirely.
if (!WORKER_MODE) {
    app.set('views', path.join(__dirname, '..', 'src', 'views'));
}

// ---- sessions (signed cookies; survives serverless) ----
// HTTPS terminates at the edge on both Vercel and Cloudflare, so the session
// cookie is marked Secure in production (per-request override below for Workers).
const isProd = !!process.env.VERCEL || WORKER_MODE;
app.use(cookieSession({
    name: 'portal.sid',
    keys: [process.env.SESSION_SECRET || 'dev-insecure-secret-change-me'],
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
    secure: isProd,
}));

// WORKER_MODE: workers.dev / custom domains are always HTTPS at the edge
// (X-Forwarded-Proto: https), but local `wrangler dev` is plain HTTP. The
// cookies package throws on Secure-over-HTTP and cookie-session swallows it,
// which silently kills sessions — so apply the PHP original's rule instead:
// mark the cookie Secure only when the request itself arrived over HTTPS.
if (WORKER_MODE) {
    app.use((req, res, next) => {
        req.sessionOptions.secure = req.secure; // trust proxy → X-Forwarded-Proto
        next();
    });
}

// ---- body parsers (uploads use multer, see routes) ----
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

// ---- static assets ----
// On Workers, Cloudflare's static-assets feature serves /public before the
// worker runs (wrangler.jsonc) and there is no disk for express.static, so
// the middleware is local/Vercel-only; worker mode installs the render shim
// (res.render without a filesystem — see src/worker_shim.js).
if (!WORKER_MODE) {
    app.use(express.static(path.join(__dirname, '..', 'public')));
} else {
    require('../src/worker_shim').apply_worker_view_shim(app);
}

// ---- database boot (schema + seed + migrations, once per instance) ----
app.use(async (req, res, next) => {
    try { await initDb(); next(); } catch (e) { next(e); }
});

// ---- session defaults + template helpers ----
app.use(session_middleware);
app.use(flash_middleware);

// ---- routes (same URLs as the PHP original) ----
app.use('/', require('../src/routes/auth'));
app.use('/', require('../src/routes/dashboard'));
app.use('/', require('../src/routes/grades_api'));
app.use('/', require('../src/routes/admin'));
app.use('/', require('../src/routes/download'));

// 404
app.use((req, res) => {
    res.status(404).send('Not found');
});

// Malformed JSON bodies: the PHP grades_api.php answered a 400 JSON error,
// so keep that shape instead of the generic 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400))) {
        return res.status(400).json({ ok: false, error: 'Invalid request body.' });
    }
    console.error(err);
    res.status(500).send('Server error. Please try again later.');
});

module.exports = app;
