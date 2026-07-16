const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const oldContact = `        if(contactId) {
            const chat = await wrapper.client.getChatById(contactId._serialized);
            return res.json({ id: chat.id ? chat.id._serialized : contactId._serialized, name: chat.name, isGroup: chat.isGroup });
        }
        res.status(404).json({error: 'Contact not found on WhatsApp'});
    } catch(e) { res.status(500).json({error: e.message}); }
});`;

const newContact = `        if(contactId) {
            try {
                const chat = await wrapper.client.getChatById(contactId._serialized);
                return res.json({ id: chat.id ? chat.id._serialized : contactId._serialized, name: chat.name, isGroup: chat.isGroup });
            } catch (err) {
                return res.json({ id: contactId._serialized, name: '', isGroup: false });
            }
        }
        res.status(404).json({error: 'Contact not found on WhatsApp'});
    } catch(e) { res.status(500).json({error: e.message}); }
});`;

code = code.replace(oldContact, newContact);
fs.writeFileSync('server.js', code);
console.log("Patched contact-info");
