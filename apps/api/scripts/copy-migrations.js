// Copies SQL migrations next to the compiled migrate.js so `node dist/main.js` can apply them.
const fs = require("node:fs");
const path = require("node:path");

const src = path.join(__dirname, "..", "src", "db", "migrations");
const dest = path.join(__dirname, "..", "dist", "db", "migrations");
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
