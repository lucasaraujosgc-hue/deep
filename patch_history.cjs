const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const oldSync = `        const FORTY_FIVE_DAYS_AGO = Math.floor(Date.now() / 1000) - (45 * 24 * 3600);
        const chat = await wrapper.client.getChatById(chatId);

        let allMessages = [];
        let seenIds = new Set();
        let reachedLimit = false;

        let fetchedBatch = [];
        try {
            fetchedBatch = await chat.fetchMessages({ limit: 100 });
        } catch (e) {
            log(\`[History] fetchMessages error: \${e.message}\`);
            return res.json({ already_synced: false, synced_count: 0, message: 'Erro ao buscar no WhatsApp Web API, fallback ativo.' });
        }`;

const newSync = `        const FORTY_FIVE_DAYS_AGO = Math.floor(Date.now() / 1000) - (45 * 24 * 3600);
        
        let allMessages = [];
        let seenIds = new Set();
        let reachedLimit = false;

        let fetchedBatch = [];
        try {
            const chat = await wrapper.client.getChatById(chatId);
            fetchedBatch = await chat.fetchMessages({ limit: 100 });
        } catch (e) {
            log(\`[History] getChatById / fetchMessages error: \${e.message}\`);
            return res.json({ already_synced: false, synced_count: 0, message: 'Erro ao buscar no WhatsApp Web API, fallback ativo.' });
        }`;

code = code.replace(oldSync, newSync);
fs.writeFileSync('server.js', code);
console.log("Patched sync-history");
