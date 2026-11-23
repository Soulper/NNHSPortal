// ================================================================
// CLOUDFLARE WORKERS ENTRY
// ================================================================
// Runs the exact same Express app as server.js / Vercel (api/index.js)
// through Cloudflare's official node:http bridge (cloudflare:node).
// Config lives in wrangler.jsonc; static files in /public are served by
// Cloudflare's static-assets feature before this worker runs.
// Deploy:  npx wrangler deploy     Dev:  npx wrangler dev
// ================================================================
import { httpServerHandler } from 'cloudflare:node';
import app from './api/index.js';

const PORT = 3000;
app.listen(PORT);

export default httpServerHandler({ port: PORT });
