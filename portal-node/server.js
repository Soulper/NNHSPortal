// Local development server (the ./start.sh / start.bat equivalent).
// Vercel does not use this file - it runs api/index.js directly.
const app = require('./api/index');

const port = Number(process.env.PORT || 8000);
app.listen(port, () => {
    console.log(`Research Student Portal (Node) running at http://localhost:${port}`);
});
