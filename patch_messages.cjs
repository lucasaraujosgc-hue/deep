const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const oldMessages = `app.get('/api/whatsapp/messages/:chatId', authenticateToken, async (req, res) => {
    try {
        const wrapper = getWaClientWrapper(req.user);
        if (!wrapper || wrapper.status !== 'connected') return res.status(400).json({error: 'Not connected'});
        const chat = await wrapper.client.getChatById(req.params.chatId);
        const limitParam = parseInt(req.query.limit) || 50;
        
        let mapped = [];
        let messages = [];
        try {
            messages = await chat.fetchMessages({limit: Math.min(limitParam, 300)});
            mapped = messages.map(m => ({
                id: m.id._serialized,
                from: m.from,
                to: m.to,
                body: m.body,
                timestamp: m.timestamp,
                hasMedia: m.hasMedia,
                type: m.type,
                fromMe: m.fromMe
            }));
        } catch(e) {
            log(\`[WhatsApp API] Erro ao carregar fetchMessages, usando DB: \${e.message}\`);
            const db = getDb(req.user);
            if (db) {
                try {
                    const dbMsgs = db.prepare('SELECT * FROM whatsapp_messages WHERE chatId = ? ORDER BY timestamp DESC LIMIT ?').all(req.params.chatId, limitParam);
                    mapped = dbMsgs.map(m => ({
                        id: m.id,
                        from: m.sender,
                        to: m.fromMe ? m.chatId : m.sender,
                        body: m.body,
                        timestamp: m.timestamp,
                        hasMedia: m.hasMedia === 1,
                        type: m.type || 'chat',
                        fromMe: m.fromMe === 1
                    })).reverse();
                } catch(dbe) {}
            }
            return res.json(mapped);
        }`;

const newMessages = `app.get('/api/whatsapp/messages/:chatId', authenticateToken, async (req, res) => {
    try {
        const wrapper = getWaClientWrapper(req.user);
        if (!wrapper || wrapper.status !== 'connected') return res.status(400).json({error: 'Not connected'});
        const limitParam = parseInt(req.query.limit) || 50;
        
        let mapped = [];
        let messages = [];
        try {
            const chat = await wrapper.client.getChatById(req.params.chatId);
            messages = await chat.fetchMessages({limit: Math.min(limitParam, 300)});
            mapped = messages.map(m => ({
                id: m.id._serialized,
                from: m.from,
                to: m.to,
                body: m.body,
                timestamp: m.timestamp,
                hasMedia: m.hasMedia,
                type: m.type,
                fromMe: m.fromMe
            }));
        } catch(e) {
            log(\`[WhatsApp API] Erro ao carregar fetchMessages, usando DB: \${e.message}\`);
            const db = getDb(req.user);
            if (db) {
                try {
                    const dbMsgs = db.prepare('SELECT * FROM whatsapp_messages WHERE chatId = ? ORDER BY timestamp DESC LIMIT ?').all(req.params.chatId, limitParam);
                    mapped = dbMsgs.map(m => ({
                        id: m.id,
                        from: m.sender,
                        to: m.fromMe ? m.chatId : m.sender,
                        body: m.body,
                        timestamp: m.timestamp,
                        hasMedia: m.hasMedia === 1,
                        type: m.type || 'chat',
                        fromMe: m.fromMe === 1
                    })).reverse();
                } catch(dbe) {}
            }
            return res.json(mapped);
        }`;

code = code.replace(oldMessages, newMessages);
fs.writeFileSync('server.js', code);
console.log("Patched messages fallback");
