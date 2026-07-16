const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.prepare('CREATE TABLE test (id INTEGER, val INTEGER, name TEXT)').run();
db.prepare("INSERT INTO test VALUES (1, 10, 'A'), (1, 20, 'B'), (2, 5, 'C')").run();
console.log(db.prepare('SELECT id, MAX(val), name FROM test GROUP BY id').all());
