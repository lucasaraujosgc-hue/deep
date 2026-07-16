const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const oldChatInfo = `app.get('/api/whatsapp/chat-info/:chatId', authenticateToken, async (req, res) => {
    try {
        const wrapper = getWaClientWrapper(req.user);
        if (!wrapper || wrapper.status !== 'connected') return res.status(400).json({error: 'Not connected'});
        
        const chatId = req.params.chatId;
        const profilePicUrl = await wrapper.client.getProfilePicUrl(chatId).catch(() => null);
        const contact = await wrapper.client.getContactById(chatId).catch(() => null);
        
        let lastMessage = '';
        let lastMessageFromMe = false;
        try {
            const chat = await wrapper.client.getChatById(chatId);
            const msgs = await chat.fetchMessages({limit: 1});
            if (msgs && msgs.length > 0) {
                lastMessage = msgs[0].body || (msgs[0].hasMedia ? '[Mídia]' : '');
                lastMessageFromMe = msgs[0].fromMe;
            }
        } catch(e) {}
        
        res.json({
            profilePicUrl,
            pushname: contact ? (contact.pushname || contact.name) : null,
            number: contact ? contact.number : null,
            lastMessage,
            lastMessageFromMe
        });
    } catch(e) {
        res.status(500).json({error: e.message});
    }
});`;

const newChatInfo = `app.get('/api/whatsapp/chat-info/:chatId', authenticateToken, async (req, res) => {
    try {
        const wrapper = getWaClientWrapper(req.user);
        if (!wrapper || wrapper.status !== 'connected') return res.status(400).json({error: 'Not connected'});
        
        const chatId = req.params.chatId;
        const db = getDb(req.user);
        
        let profilePicUrl = null;
        let contact = null;
        try {
            profilePicUrl = await wrapper.client.getProfilePicUrl(chatId).catch(() => null);
            contact = await wrapper.client.getContactById(chatId).catch(() => null);
        } catch (err) {
            log(\`[WhatsApp API] Erro ao buscar profile pic/contact para \${chatId}: \${err.message}\`);
        }
        
        if (!contact && db) {
            try {
                const row = db.prepare("SELECT name FROM whatsapp_contacts WHERE contact_id = ?").get(chatId);
                if (row && row.name) contact = { name: row.name, number: chatId.split('@')[0] };
            } catch(e) {}
        }
        
        let lastMessage = '';
        let lastMessageFromMe = false;
        try {
            const chat = await wrapper.client.getChatById(chatId);
            const msgs = await chat.fetchMessages({limit: 1});
            if (msgs && msgs.length > 0) {
                lastMessage = msgs[0].body || (msgs[0].hasMedia ? '[Mídia]' : '');
                lastMessageFromMe = msgs[0].fromMe;
            } else {
                throw new Error("Empty messages array");
            }
        } catch(e) {
            log(\`[WhatsApp API] fetchMessages falhou em chat-info para \${chatId}: \${e.message}\`);
            if (db) {
                try {
                    const dbMsg = db.prepare(
                        'SELECT body, hasMedia, fromMe FROM whatsapp_messages WHERE chatId = ? ORDER BY timestamp DESC LIMIT 1'
                    ).get(chatId);
                    if (dbMsg) {
                        lastMessage = dbMsg.body || (dbMsg.hasMedia === 1 ? '[Mídia]' : '');
                        lastMessageFromMe = dbMsg.fromMe === 1;
                    }
                } catch(dbErr) {}
            }
        }
        
        res.json({
            profilePicUrl,
            pushname: contact ? (contact.pushname || contact.name) : null,
            number: contact ? contact.number : null,
            lastMessage,
            lastMessageFromMe
        });
    } catch(e) {
        res.status(500).json({error: e.message});
    }
});`;

code = code.replace(oldChatInfo, newChatInfo);

const oldChatsFallback = `            try {
                const dbChats = db.prepare(\`
                    SELECT chatId as id, contactName as name, MAX(timestamp) as timestamp 
                    FROM whatsapp_messages 
                    GROUP BY chatId 
                    ORDER BY timestamp DESC
                \`).all();
                
                const simplifiedChats = dbChats.map(c => ({
                    id: c.id,
                    name: c.name || c.id.replace('@c.us', ''),
                    unreadCount: 0,
                    timestamp: c.timestamp,
                    isGroup: c.id.includes('@g.us'),
                    profilePicUrl: null,
                    lastMessage: '',
                    lastMessageFromMe: false
                })).filter(c => !c.isGroup && (kanbanCards.includes(c.id) || (c.timestamp && ((Date.now()/1000) - c.timestamp) < 86400 * 7)));
                
                const existingIds = new Set(simplifiedChats.map(c => c.id));
                for (const kId of kanbanCards) {
                    if (!existingIds.has(kId) && !kId.includes('@g.us')) {
                        let cName = kId.replace('@c.us', '');
                        try {
                            const cRow = db.prepare("SELECT name FROM whatsapp_contacts WHERE contact_id = ?").get(kId);
                            if (cRow && cRow.name) cName = cRow.name;
                        } catch(ce) {}
                        
                        simplifiedChats.push({
                            id: kId,
                            name: cName,
                            unreadCount: 0,
                            timestamp: Date.now() / 1000,
                            isGroup: false,
                            profilePicUrl: null,
                            lastMessage: '',
                            lastMessageFromMe: false
                        });
                    }
                }
                
                simplifiedChats.sort((a, b) => b.timestamp - a.timestamp);
                
                res.json(simplifiedChats);
            } catch (dbErr) {`;

const newChatsFallback = `            try {
                const dbChats = db.prepare(\`
                    SELECT chatId as id, contactName as name, MAX(timestamp) as timestamp, body as lastMessage, fromMe as lastMessageFromMe
                    FROM whatsapp_messages 
                    GROUP BY chatId 
                    ORDER BY timestamp DESC
                \`).all();
                
                const simplifiedChats = dbChats.map(c => ({
                    id: c.id,
                    name: c.name || c.id.replace(/@(c\\.us|lid|s\\.whatsapp\\.net)$/, ''),
                    unreadCount: 0,
                    timestamp: c.timestamp,
                    isGroup: c.id.includes('@g.us'),
                    profilePicUrl: null,
                    lastMessage: c.lastMessage || '',
                    lastMessageFromMe: c.lastMessageFromMe === 1
                })).filter(c => !c.isGroup && (kanbanCards.includes(c.id) || (c.timestamp && ((Date.now()/1000) - c.timestamp) < 86400 * 7)));
                
                const existingIds = new Set(simplifiedChats.map(c => c.id));
                for (const kId of kanbanCards) {
                    if (!existingIds.has(kId) && !kId.includes('@g.us')) {
                        let cName = kId.replace(/@(c\\.us|lid|s\\.whatsapp\\.net)$/, '');
                        try {
                            const cRow = db.prepare("SELECT name FROM whatsapp_contacts WHERE contact_id = ?").get(kId);
                            if (cRow && cRow.name) cName = cRow.name;
                        } catch(ce) {}
                        
                        let kLastMessage = '';
                        let kLastFromMe = false;
                        try {
                             const kMsg = db.prepare("SELECT body, hasMedia, fromMe FROM whatsapp_messages WHERE chatId = ? ORDER BY timestamp DESC LIMIT 1").get(kId);
                             if (kMsg) { 
                                 kLastMessage = kMsg.body || (kMsg.hasMedia === 1 ? '[Mídia]' : ''); 
                                 kLastFromMe = kMsg.fromMe === 1; 
                             }
                        } catch(ke) {}

                        simplifiedChats.push({
                            id: kId,
                            name: cName,
                            unreadCount: 0,
                            timestamp: Date.now() / 1000,
                            isGroup: false,
                            profilePicUrl: null,
                            lastMessage: kLastMessage,
                            lastMessageFromMe: kLastFromMe
                        });
                    }
                }
                
                simplifiedChats.sort((a, b) => b.timestamp - a.timestamp);
                
                res.json(simplifiedChats);
            } catch (dbErr) {`;

code = code.replace(oldChatsFallback, newChatsFallback);
fs.writeFileSync('server.js', code);
console.log("Patched server.js");
