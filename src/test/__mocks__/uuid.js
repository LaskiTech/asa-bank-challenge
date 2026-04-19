// CJS shim for uuid — replaces the ESM-only uuid@13 in Jest's CommonJS environment.
// Uses Node's built-in crypto.randomUUID() which provides the same RFC 4122 v4 UUIDs.
const { randomUUID } = require('crypto');
module.exports = { v4: () => randomUUID() };
