import re

with open('server.js', 'r') as f:
    content = f.read()

correct_code = """app.get('/api/whatsapp/chats', authenticateToken, async (req, res) => {
    try {
        const wrapper = getWaClientWrapper(req.user);
        const db = getDb(req.user);
        
        let kanbanCards = [];
        try {
            const row = db.prepare("SELECT settings FROM user_settings WHERE id = 1").get();
            if (row && row.settings) {
                const settings = JSON.parse(row.settings);
                kanbanCards = (settings.waKanban?.cards || []).map(c => c.id);
            }
        } catch(e) {}
        
        if (wrapper && wrapper.status === 'connected') {
            try {
                const chats = await wrapper.client.getChats();
                const filteredChats = chats.filter(c => !c.isGroup);
                
                filteredChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                
                const limitChats = [];
                let count = 0;
                for (const c of filteredChats) {
                    if (kanbanCards.includes(c.id._serialized)) {
                        limitChats.push(c);
                    } else if (count < 50) {
                        limitChats.push(c);
                        count++;
                    }
                }

                const simplifiedChats = limitChats.map(c => {
                    return {
                        id: c.id._serialized,
                        name: c.name || c.id.user,
                        unreadCount: c.unreadCount,
                        timestamp: c.timestamp || 0,
                        isGroup: c.isGroup,
                        profilePicUrl: null,
                        lastMessage: '',
                        lastMessageFromMe: false
                    };
                });
                
                return res.json(simplifiedChats);
            } catch(e) {
                return res.status(500).json({error: e.message});
            }
        } else {
            try {
                let dbChats = [];
                if (kanbanCards.length > 0) {
                    const placeholders = kanbanCards.map(() => '?').join(',');
                    const contacts = db.prepare(`SELECT contact_id, name FROM whatsapp_contacts WHERE contact_id IN (${placeholders})`).all(...kanbanCards);
                    
                    dbChats = kanbanCards.map(id => {
                        const contact = contacts.find(c => c.contact_id === id);
                        return {
                            id: id,
                            name: contact ? contact.name : id.split('@')[0],
                            unreadCount: 0,
                            timestamp: 0,
                            isGroup: id.includes('@g.us'),
                            profilePicUrl: null,
                            lastMessage: '',
                            lastMessageFromMe: false
                        };
                    });
                }
                return res.json(dbChats);
            } catch (e) {
                return res.json([]);
            }
        }
    } catch(e) { res.status(500).json({error: e.message}); }
});
"""

pattern = re.compile(r"app\.get\('/api/whatsapp/chats',.*?\}\);\n", re.DOTALL)
new_content = pattern.sub(correct_code, content)

with open('server.js', 'w') as f:
    f.write(new_content)

