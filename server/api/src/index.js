'use strict';
const { createServer } = require('./app');
const port = Number(process.env.PORT || 8080);
// Apply the small schema upgrades first; if the database is briefly unreachable, keep serving and retry.
require('./upgrade').run().then(() => console.log('schema up to date'), e => console.error('schema upgrade failed:', e.message));
createServer().listen(port, () => console.log(`portal api listening on :${port}`));
