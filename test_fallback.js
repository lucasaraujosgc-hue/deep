const db = require('better-sqlite3')('data/lucasdocarbono@gmail.com.db');
const chats = db.prepare(`
    SELECT chatId as id, contactName as name, MAX(timestamp) as timestamp 
    FROM whatsapp_messages 
    GROUP BY chatId 
    ORDER BY timestamp DESC
`).all();
console.log(chats);
