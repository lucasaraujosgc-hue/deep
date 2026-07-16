const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const ensureFunc = `
async function ensureWaInjection(client) {
    if (!client || !client.pupPage) return;
    try {
        await client.pupPage.evaluate(() => {
            if (window.WWebJS && !window.WWebJS.getChat) {
                window.WWebJS.getChats = async () => {
                    const chats = window.require('WAWebCollections').Chat.getModelsArray();
                    const chatPromises = chats.map(async (chat) => {
                        try { return await window.WWebJS.getChatModel(chat); } catch(e) { return null; }
                    });
                    const resolved = await Promise.all(chatPromises);
                    return resolved.filter(c => c !== null);
                };

                window.WWebJS.getChat = async (chatId, { getAsModel = true } = {}) => {
                    const isChannel = /@\\w*newsletter\\b/.test(chatId);
                    const chatWid = window.require('WAWebWidFactory').createWid(chatId);
                    let chat;
                    if (isChannel) {
                        try {
                            chat = window.require('WAWebCollections').WAWebNewsletterCollection.get(chatId);
                            if (!chat) {
                                await window.require('WAWebLoadNewsletterPreviewChatAction').loadNewsletterPreviewChat(chatId);
                                chat = await window.require('WAWebCollections').WAWebNewsletterCollection.find(chatWid);
                            }
                        } catch (e) { chat = null; }
                    } else {
                        chat = window.require('WAWebCollections').Chat.get(chatWid);
                        if (!chat) {
                            try {
                                const res = await window.require('WAWebFindChatAction').findOrCreateLatestChat(chatWid);
                                chat = res ? res.chat : null;
                            } catch(e) { chat = null; }
                        }
                    }
                    return getAsModel && chat ? await window.WWebJS.getChatModel(chat, { isChannel }) : chat;
                };
            }
        });
    } catch (e) {}
}

function getWaClientWrapper(username) {`;

code = code.replace('function getWaClientWrapper(username) {', ensureFunc);

const oldSend = `        try {
            const chat = await client.getChatById(finalChatId);
            const msg = await chat.sendMessage(content, safeOptions);
            return msg;
        } catch (chatError) {
            const msg = await client.sendMessage(finalChatId, content, safeOptions);
            return msg;
        }`;

const newSend = `        await ensureWaInjection(client);
        try {
            const chat = await client.getChatById(finalChatId);
            const msg = await chat.sendMessage(content, safeOptions);
            return msg;
        } catch (chatError) {
            const msg = await client.sendMessage(finalChatId, content, safeOptions);
            return msg;
        }`;

code = code.replace(oldSend, newSend);
fs.writeFileSync('server.js', code);
console.log("Patched ensure injection");
