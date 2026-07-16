const Database = require('better-sqlite3');
const db = new Database('./data/lucasdocarbono@gmail.com.db');
const chats = db.prepare("SELECT DISTINCT chatId FROM whatsapp_messages LIMIT 10").all();
console.log('Chat IDs:', chats);
