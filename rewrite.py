import re

with open('server.js', 'r') as f:
    content = f.read()

correct_code = """app.get('/api/whatsapp/chats', authenticateToken, async (req, res) => {
    try {
        const wrapper = getWaClientWrapper(req.user);
        if (!wrapper || wrapper.status !== 'connected') return res.status(400).json({error: 'Not connected'});
        
        const db = getDb(req.user);
        let kanbanCards = [];
        try {
            const row = db.prepare("SELECT settings FROM user_settings WHERE id = 1").get();
            if (row && row.settings) {
                const settings = JSON.parse(row.settings);
                kanbanCards = (settings.waKanban?.cards || []).map(c => c.id);
            }
        } catch(e) {}
        
        try {
            const chats = await wrapper.client.getChats();
            const filteredChats = chats.filter(c => !c.isGroup);
            
            // Sort before slice to get most recent
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
            
            res.json(simplifiedChats);
        } catch(e) {
            res.status(500).json({error: e.message});
        }
    } catch(e) { res.status(500).json({error: e.message}); }
});
"""

# We'll use regex to replace from app.get('/api/whatsapp/chats'... to the end of it
pattern = re.compile(r"app\.get\('/api/whatsapp/chats',.*?\}\);\n", re.DOTALL)
new_content = pattern.sub(correct_code, content)

with open('server.js', 'w') as f:
    f.write(new_content)

