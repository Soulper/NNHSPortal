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

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // real client IP behind Vercel's proxy

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'src', 'views'));

// ---- sessions (signed cookies; survives serverless) ----
const isProd = !!process.env.VERCEL;
app.use(cookieSession({
    name: 'portal.sid',
    keys: [process.env.SESSION_SECRET || 'dev-insecure-secret-change-me'],
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
    secure: isProd,
}));

// ---- body parsers (uploads use multer, see routes) ----
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

// ---- static assets (served from /public on Vercel too) ----
app.use(express.static(path.join(__dirname, '..', 'public')));

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
