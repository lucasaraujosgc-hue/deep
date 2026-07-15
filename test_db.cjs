const db = require('better-sqlite3')('data/lucas.db');
const row = db.prepare('SELECT timestamp FROM whatsapp_messages LIMIT 1').get();
console.log(row);
