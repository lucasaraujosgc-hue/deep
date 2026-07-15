const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const target = `            try {
                const db = getDb(username);
                if (db) {
                    const chats = await client.getChats();
                    let seeded = 0;
                    for (const chat of chats) {
                        if (chat.isGroup) continue;
                        const chatId = chat.id ? chat.id._serialized : null;
                        if (!chatId) continue;

                        const isLid = chatId.includes('@lid');
                        let resolvedId = chatId;
                        let phone = isLid ? null : chatId.replace('@c.us', '').replace(/\\D/g, '');

                        if (!isLid && phone) {
                            try {
                                const numberId = await client.getNumberId(phone);
                                if (numberId && numberId._serialized) {
                                    resolvedId = numberId._serialized;
                                }
                            } catch (_) {}
                        }

                        const contactName = chat.name || (chat.id && chat.id.user) || resolvedId;
                        upsertContactCache(db, resolvedId, contactName, phone);
                        seeded++;
                    }
                    log(\`[WhatsApp Cache] \${seeded} contatos populados no cache ao conectar.\`);
                }
            } catch (e) {
                log(\`[WhatsApp Cache] Erro ao popular cache na inicialização: \${JSON.stringify(e, Object.getOwnPropertyNames(e))} - \${String(e)}\`);
            }`;

const replacement = `            try {
                const db = getDb(username);
                if (db) {
                    try {
                        const contacts = await client.getContacts();
                        let seeded = 0;
                        for (const contact of contacts) {
                            if (contact.isGroup) continue;
                            const contactId = contact.id ? contact.id._serialized : null;
                            if (!contactId) continue;
                            
                            const isLid = contactId.includes('@lid');
                            let resolvedId = contactId;
                            let phone = isLid ? null : contact.number || contactId.replace('@c.us', '').replace(/\\D/g, '');
                            
                            if (!isLid && phone) {
                                try {
                                    const numberId = await client.getNumberId(phone);
                                    if (numberId && numberId._serialized) {
                                        resolvedId = numberId._serialized;
                                    }
                                } catch (_) {}
                            }
                            
                            const contactName = contact.name || contact.pushname || (contact.id && contact.id.user) || resolvedId;
                            upsertContactCache(db, resolvedId, contactName, phone);
                            seeded++;
                        }
                        log(\`[WhatsApp Cache] \${seeded} contatos populados no cache ao conectar (via getContacts).\`);
                    } catch (contactErr) {
                        log(\`[WhatsApp Cache] Erro ao buscar contatos: \${contactErr.message}\`);
                    }
                }
            } catch (e) {
                log(\`[WhatsApp Cache] Erro ao popular cache na inicialização: \${JSON.stringify(e, Object.getOwnPropertyNames(e))} - \${String(e)}\`);
            }`;

if (code.includes(target)) {
    code = code.replace(target, replacement);
    fs.writeFileSync('server.js', code);
    console.log("Success");
} else {
    // If exact string doesn't match, try a more robust regex replacement
    console.log("Failed exact match, trying regex...");
    const regex = /try\s*{\s*const db = getDb\(username\);\s*if \(db\) {\s*const chats = await client\.getChats\(\);[\s\S]*?\}\s*\}\s*catch\s*\(e\)\s*{\s*log\(`\[WhatsApp Cache\] Erro ao popular cache na inicialização:[^`]+`\);\s*\}/;
    if (regex.test(code)) {
        code = code.replace(regex, replacement);
        fs.writeFileSync('server.js', code);
        console.log("Success with Regex");
    } else {
        console.log("Regex also failed");
    }
}
