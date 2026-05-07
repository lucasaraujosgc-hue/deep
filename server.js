import 'dotenv/config';
import express from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import QRCode from 'qrcode';
import fs from 'fs';
import sqlite3 from 'sqlite3';
import multer from 'multer';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Configuração de diretórios
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const LOG_FILE = path.join(DATA_DIR, 'debug_whatsapp.log');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// --- SYSTEM: Logger ---
const log = (message, error = null) => {
    const timestamp = new Date().toISOString();
    let errorDetail = '';
    
    if (error) {
        errorDetail = `\nERROR: ${error.message}`;
        if (error.stack) errorDetail += `\nSTACK: ${error.stack}`;
    }

    const logMessage = `[${timestamp}] ${message}${errorDetail}\n`;
    console.log(`[APP] ${message}`);
    if (error) console.error(error);

    try {
        fs.appendFileSync(LOG_FILE, logMessage);
    } catch (e) {
        console.error("Falha crítica ao escrever no arquivo de log:", e);
    }
};

log("Servidor iniciando...");
log(`Diretório de dados: ${DATA_DIR}`);

// --- AI CONFIGURATION ---
let ai = null;
if (process.env.GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    log("AI: Google GenAI (v3 Flash Preview) inicializado.");
} else {
    log("AI: GEMINI_API_KEY não encontrada. O assistente inteligente estará desativado.");
}

// --- CONFIGURAÇÃO DO EXPRESS ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Servir arquivos estáticos do frontend (pasta dist criada pelo Vite)
app.use(express.static(path.join(__dirname, 'dist')));

// --- HELPER: Puppeteer Lock Cleaner ---
const cleanPuppeteerLocks = (dir) => {
    const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    if (fs.existsSync(dir)) {
        locks.forEach(lock => {
            const lockPath = path.join(dir, lock);
            if (fs.existsSync(lockPath)) {
                try {
                    fs.unlinkSync(lockPath);
                    log(`[Puppeteer Fix] Trava removida: ${lockPath}`);
                } catch (e) {}
            }
        });
        const defaultDir = path.join(dir, 'Default');
        if (fs.existsSync(defaultDir)) {
             locks.forEach(lock => {
                const lockPath = path.join(defaultDir, lock);
                if (fs.existsSync(lockPath)) {
                    try { fs.unlinkSync(lockPath); } catch (e) {}
                }
            });
        }
    }
};

// --- HELPER: Robust WhatsApp Send ---
const safeSendMessage = async (client, chatId, content, options = {}) => {
    log(`[WhatsApp] Tentando enviar mensagem para: ${chatId}`);
    try {
        if (!client) throw new Error("Client é null");

        const safeOptions = { 
            ...options, 
            sendSeen: false 
        };

        let finalChatId = chatId;
        
        if (!finalChatId.includes('@')) {
             if (/^\d+$/.test(finalChatId)) {
                 finalChatId = `${finalChatId}@c.us`;
             } else {
                 throw new Error("ChatId mal formatado: " + chatId);
             }
        }

        try {
            if (finalChatId.endsWith('@c.us')) {
                const numberPart = finalChatId.replace('@c.us', '').replace(/\D/g, '');
                const contactId = await client.getNumberId(numberPart);
                
                if (contactId && contactId._serialized) {
                    finalChatId = contactId._serialized;
                }
            }
        } catch (idErr) {
            log(`[WhatsApp] Erro não bloqueante ao resolver getNumberId: ${idErr.message}`);
        }

        try {
            const chat = await client.getChatById(finalChatId);
            const msg = await chat.sendMessage(content, safeOptions);
            return msg;
        } catch (chatError) {
            const msg = await client.sendMessage(finalChatId, content, safeOptions);
            return msg;
        }

    } catch (error) {
        log(`[WhatsApp] FALHA CRÍTICA NO ENVIO para ${chatId}`, error);
        throw error;
    }
};

// ============================================================
// SEÇÃO 1 — HELPER: Salvar mensagem no banco
// ============================================================

const saveMessageToDb = (db, { id, chatId, sender, timestamp, body, fromMe, hasMedia, type }) => {
    if (!db || !id || !chatId) return;
    db.run(
        `INSERT OR IGNORE INTO whatsapp_messages
         (id, chatId, sender, timestamp, body, fromMe, hasMedia, type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, chatId, sender || '', timestamp || 0, body || '', fromMe ? 1 : 0, hasMedia ? 1 : 0, type || 'chat'],
        (err) => { if (err) log(`[DB] Erro ao salvar mensagem ${id}: ${err.message}`); }
    );
};

const saveMessagesToDb = (db, messages) => {
    if (!db || !messages?.length) return Promise.resolve();
    return new Promise((resolve) => {
        db.serialize(() => {
            const stmt = db.prepare(
                `INSERT OR IGNORE INTO whatsapp_messages
                 (id, chatId, sender, timestamp, body, fromMe, hasMedia, type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
            messages.forEach(m => {
                stmt.run([
                    m.id, m.chatId, m.sender || '', m.timestamp || 0,
                    m.body || '', m.fromMe ? 1 : 0, m.hasMedia ? 1 : 0, m.type || 'chat'
                ]);
            });
            stmt.finalize(resolve);
        });
    });
};

// --- MULTI-TENANCY: Database Management ---
const dbInstances = {};

const getDb = (username) => {
    if (!username) return null;
    if (dbInstances[username]) return dbInstances[username];

    const userDbPath = path.join(DATA_DIR, `${username}.db`);
    const db = new sqlite3.Database(userDbPath);
    
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, docNumber TEXT, type TEXT, email TEXT, whatsapp TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, status TEXT, priority TEXT, color TEXT, dueDate TEXT, companyId INTEGER, recurrence TEXT, dayOfWeek TEXT, recurrenceDate TEXT, targetCompanyType TEXT, createdAt TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS document_status (id INTEGER PRIMARY KEY AUTOINCREMENT, companyId INTEGER, category TEXT, competence TEXT, status TEXT, UNIQUE(companyId, category, competence))`);
        db.run(`CREATE TABLE IF NOT EXISTS sent_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, companyName TEXT, docName TEXT, category TEXT, sentAt TEXT, channels TEXT, status TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS user_settings (id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS scheduled_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, message TEXT, nextRun TEXT, recurrence TEXT, active INTEGER, type TEXT, channels TEXT, targetType TEXT, selectedCompanyIds TEXT, attachmentFilename TEXT, attachmentOriginalName TEXT, documentsPayload TEXT, createdBy TEXT)`);
        
        // Tabelas para RAG e Histórico do Assistente
        db.run(`CREATE TABLE IF NOT EXISTS chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, timestamp TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS file_gallery (id INTEGER PRIMARY KEY AUTOINCREMENT, serverFilename TEXT, originalName TEXT, mimeType TEXT, size INTEGER, contact TEXT, channel TEXT, direction TEXT, timestamp TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS personal_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT, content TEXT, created_at TEXT, updated_at TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS whatsapp_messages (id TEXT PRIMARY KEY, chatId TEXT NOT NULL, sender TEXT, timestamp INTEGER, body TEXT, fromMe INTEGER, hasMedia INTEGER, type TEXT, transcription TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS whatsapp_sync (chatId TEXT PRIMARY KEY, lastSyncTimestamp INTEGER)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_chatId ON whatsapp_messages(chatId)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_timestamp ON whatsapp_messages(timestamp)`);

        db.all("PRAGMA table_info(companies)", [], (err, rows) => {
            if (rows && !rows.some(col => col.name === 'categories')) {
                db.run("ALTER TABLE companies ADD COLUMN categories TEXT", () => {});
            }
            if (rows && !rows.some(col => col.name === 'observation')) {
                db.run("ALTER TABLE companies ADD COLUMN observation TEXT", () => {});
            }
        });

        db.all("PRAGMA table_info(scheduled_messages)", [], (err, rows) => {
            if (rows && !rows.some(col => col.name === 'documentsPayload')) {
                db.run("ALTER TABLE scheduled_messages ADD COLUMN documentsPayload TEXT", () => {});
            }
        });
        db.all("PRAGMA table_info(tasks)", [], (err, rows) => {
            if (rows && !rows.some(col => col.name === 'createdAt')) {
                const today = new Date().toISOString().split('T')[0];
                db.run("ALTER TABLE tasks ADD COLUMN createdAt TEXT", () => db.run("UPDATE tasks SET createdAt = ?", [today]));
            }
        });
    });

    dbInstances[username] = db;
    return db;
};

// --- EMAIL CONFIGURATION ---
const emailPort = parseInt(process.env.EMAIL_PORT || '465');
const emailTransporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: emailPort,
    secure: emailPort === 465,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

const pickOrCreateSentMailbox = async (imap) => {
    if (process.env.SENT_FOLDER) {
        log(`[IMAP] Usando pasta configurada: ${process.env.SENT_FOLDER}`);
        return process.env.SENT_FOLDER;
    }

    const candidates = [
        'INBOX.Sent',
    ];

    const findMailbox = async () => {
        for await (const box of imap.list()) {
            if (candidates.includes(box.path) || candidates.includes(box.name)) {
                return box.path;
            }
        }
        return null;
    };

    let folder = await findMailbox();
    if (folder) return folder;

    for (const name of ['Sent', 'Enviados']) {
        try {
            await imap.mailboxCreate(name);
            folder = await findMailbox();
            if (folder) return folder;
        } catch (e) {
            // tenta o próximo nome
        }
    }

    return 'Sent';
};

const saveToImapSentFolder = async (mailOptions) => {
    let imap;
    try {
        const emailUser = process.env.EMAIL_USER;
        const emailPass = process.env.EMAIL_PASS;

        if (!emailUser || !emailPass) {
            log('[IMAP] EMAIL_USER e EMAIL_PASS não configurados. Ignorando IMAP.');
            return;
        }

        const imapHost = process.env.IMAP_HOST || 'imap.hostinger.com';
        const imapPort = parseInt(process.env.IMAP_PORT || '993');
        const imapSecure = process.env.IMAP_SECURE !== 'false';

        const mimePreview = nodemailer.createTransport({
            streamTransport: true,
            buffer: true,
            newline: 'unix',
        });

        const mime = await mimePreview.sendMail({
            ...mailOptions,
            from: mailOptions.from || emailUser,
            date: new Date(),
            text: mailOptions.text || ' ',
            html: mailOptions.html || '<p></p>',
        });

        imap = new ImapFlow({
            host: imapHost,
            port: imapPort,
            secure: imapSecure,
            auth: {
                user: emailUser,
                pass: emailPass,
            },
            tls: { rejectUnauthorized: false },
            logger: false,
        });

        await imap.connect();

        const sentFolder = await pickOrCreateSentMailbox(imap);
        const rawMessage = Buffer.from(mime.message.toString(), 'utf-8');
        await imap.append(sentFolder, rawMessage);

        log(`[IMAP] Email salvo na pasta ${sentFolder} com sucesso.`);
    } catch (err) {
        log(`[IMAP Error] ${err.message}`, err);
    } finally {
        if (imap) await imap.logout().catch(() => {});
    }
};

// --- AI LOGIC: Tools & Handler ---

const assistantTools = [
    {
        name: "consult_tasks",
        description: "Lista as tarefas cadastradas.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                status: { type: Type.STRING, enum: ["pendente", "em_andamento", "concluida", "todas"], description: "Filtro. Use 'todas' se o usuario pedir 'todas'." }
            }
        }
    },
    {
        name: "update_task_status",
        description: "Marca uma tarefa como concluída ou muda status.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                task_id_or_title: { type: Type.STRING, description: "ID numérico ou Título aproximado da tarefa." },
                new_status: { type: Type.STRING, enum: ["pendente", "em_andamento", "concluida"], description: "Novo status." }
            },
            required: ["task_id_or_title", "new_status"]
        }
    },
    {
        name: "add_task",
        description: "Cria uma nova tarefa.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                title: { type: Type.STRING, description: "Título da tarefa" },
                description: { type: Type.STRING },
                priority: { type: Type.STRING, enum: ["alta", "media", "baixa"] }
            },
            required: ["title"]
        }
    },
    {
        name: "set_personal_reminder",
        description: "Define um lembrete pessoal para o usuário. Use para 'me lembre de X em Y minutos/horas' ou 'todo dia X'. IMPORTANTE: Calcule o datetime ISO 8601 correto somando o tempo relativo à hora atual fornecida no system prompt.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                message: { type: Type.STRING, description: "O que deve ser lembrado." },
                datetime: { type: Type.STRING, description: "Data e hora exata ISO 8601 (ex: 2026-05-10T14:30:00). Calcule baseando-se na hora atual informada no system prompt." },
                recurrence: { type: Type.STRING, enum: ["unico", "diaria", "semanal", "mensal", "anual"], description: "Padrão: unico." }
            },
            required: ["message", "datetime"]
        }
    },
    {
        name: "send_message_to_company",
        description: "ENVIA uma mensagem REAL (Email e/ou WhatsApp) para uma empresa cadastrada. Use SEMPRE que o usuário pedir para enviar/mandar mensagem para uma empresa.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                company_name_search: { type: Type.STRING, description: "Nome aproximado da empresa para buscar." },
                message_body: { type: Type.STRING, description: "Conteúdo da mensagem a ser enviada." },
                channels: { 
                    type: Type.OBJECT, 
                    properties: {
                        whatsapp: { type: Type.BOOLEAN },
                        email: { type: Type.BOOLEAN }
                    }
                }
            },
            required: ["company_name_search", "message_body"]
        }
    },
    {
        name: "send_message_to_phone",
        description: "Envia mensagem WhatsApp para um número de telefone específico (não necessariamente uma empresa cadastrada).",
        parameters: {
            type: Type.OBJECT,
            properties: {
                phone: { type: Type.STRING, description: "Número com DDI+DDD, ex: 5575999999999" },
                message: { type: Type.STRING, description: "Texto da mensagem." }
            },
            required: ["phone", "message"]
        }
    },
    {
        name: "search_company",
        description: "Consulta dados de uma empresa (email, whatsapp, tipo, documentos).",
        parameters: {
            type: Type.OBJECT,
            properties: {
                name_or_doc: { type: Type.STRING }
            },
            required: ["name_or_doc"]
        }
    },
    {
        name: "list_companies",
        description: "Lista todas as empresas cadastradas, com opção de filtro por tipo.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                type_filter: { type: Type.STRING, enum: ["MEI", "Simples", "Lucro Presumido", "todas"], description: "Filtro por tipo. Use 'todas' se não especificado." }
            }
        }
    },
    {
        name: "create_kanban_tag",
        description: "Cria uma nova tag no Kanban WhatsApp.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                name: { type: Type.STRING, description: "Nome da tag." },
                color: { type: Type.STRING, description: "Cor hex opcional, ex: #FF5733. Se não informado, será gerada automaticamente." }
            },
            required: ["name"]
        }
    },
    {
        name: "add_tag_to_contact",
        description: "Adiciona uma tag existente a um contato/chat no Kanban.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                phone: { type: Type.STRING, description: "Número do contato com DDI+DDD, ex: 5575999999999" },
                tag_name: { type: Type.STRING, description: "Nome da tag a adicionar." }
            },
            required: ["phone", "tag_name"]
        }
    },
    {
        name: "consult_sent_history",
        description: "Consulta o histórico de envios de documentos recentes.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                limit: { type: Type.NUMBER, description: "Quantidade de registros. Padrão: 10." }
            }
        }
    },
    {
        name: "manage_memory",
        description: "Salva ou busca informações duradouras na memória do assistente (anotações, preferências, dados importantes).",
        parameters: {
            type: Type.OBJECT,
            properties: {
                action: { type: Type.STRING, enum: ["save", "search"] },
                topic: { type: Type.STRING, description: "Tema ou título da memória." },
                content: { type: Type.STRING, description: "Conteúdo a salvar (obrigatório em 'save')." }
            },
            required: ["action", "topic"]
        }
    },
    {
        name: "search_whatsapp_contact",
        description: "Busca um contato/conversa do WhatsApp por nome ou número. Use quando o usuário mencionar um nome de pessoa (não empresa cadastrada) ou número de telefone para enviar mensagem. Retorna o chatId correto para uso em send_message_to_contact.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                query: { type: Type.STRING, description: "Nome parcial ou número do contato a buscar." }
            },
            required: ["query"]
        }
    },
    {
        name: "send_message_to_contact",
        description: "Envia mensagem WhatsApp para um contato da lista de conversas (não necessariamente empresa cadastrada). Use o chatId retornado por search_whatsapp_contact.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                chat_id: { type: Type.STRING, description: "chatId do contato (ex: 5575999999999@c.us ou LID@lid). Obtido via search_whatsapp_contact." },
                message: { type: Type.STRING, description: "Texto da mensagem." }
            },
            required: ["chat_id", "message"]
        }
    },
    {
        name: "search_whatsapp_messages",
        description: "Busca e resume mensagens do WhatsApp de um contato ou de um período. Use para: 'resuma as mensagens de ontem', 'o que fulano me enviou hoje?', 'mensagens recentes de [contato]'.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                contact_query: { type: Type.STRING, description: "Nome ou número do contato (opcional, deixe vazio para todos)." },
                period: { type: Type.STRING, enum: ["hoje", "ontem", "ultimas24h", "semana"], description: "Período das mensagens." },
                limit: { type: Type.NUMBER, description: "Número máximo de mensagens a retornar. Padrão: 20." }
            }
        }
    }
];

// --- EXECUÇÃO DAS TOOLS ---
const executeTool = async (name, args, db, username) => {
    log(`[AI Tool] Executando ${name} com args: ${JSON.stringify(args)}`);
    
    // 1. Consultar Tarefas
    if (name === "consult_tasks") {
        return new Promise((resolve) => {
            let sql = "SELECT id, title, priority, status, dueDate FROM tasks";
            const params = [];
            
            if (args.status && args.status !== 'todas') {
                sql += " WHERE status = ?";
                params.push(args.status);
            } else {
                sql += " ORDER BY CASE WHEN status = 'pendente' THEN 1 WHEN status = 'em_andamento' THEN 2 ELSE 3 END, id DESC";
            }
            
            db.all(sql, params, (err, rows) => {
                if (err) resolve("Erro ao listar: " + err.message);
                if (!rows || rows.length === 0) resolve("Nenhuma tarefa encontrada.");
                else resolve(JSON.stringify(rows));
            });
        });
    }

    // 2. Atualizar Status
    if (name === "update_task_status") {
        return new Promise((resolve) => {
            const isId = /^\d+$/.test(args.task_id_or_title);
            const sqlCheck = isId ? "SELECT id FROM tasks WHERE id = ?" : "SELECT id FROM tasks WHERE title LIKE ?";
            const paramCheck = isId ? args.task_id_or_title : `%${args.task_id_or_title}%`;

            db.all(sqlCheck, [paramCheck], (err, rows) => {
                if (err || !rows || rows.length === 0) {
                    resolve(`Tarefa "${args.task_id_or_title}" não encontrada.`);
                    return;
                }
                
                const ids = rows.map(r => r.id);
                const placeholders = ids.map(() => '?').join(',');
                
                db.run(`UPDATE tasks SET status = ? WHERE id IN (${placeholders})`, [args.new_status, ...ids], function(err2) {
                    if (err2) resolve("Erro ao atualizar.");
                    else resolve(`Atualizado ${this.changes} tarefa(s) para '${args.new_status}'.`);
                });
            });
        });
    }

    // 3. Adicionar Tarefa
    if (name === "add_task") {
        const today = new Date().toISOString().split('T')[0];
        return new Promise(resolve => {
            db.run(`INSERT INTO tasks (title, description, status, priority, color, recurrence, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [args.title, args.description || '', 'pendente', args.priority || 'media', '#45B7D1', 'nenhuma', today], 
            function(err) { resolve(err ? "Erro: " + err.message : `Tarefa criada (ID ${this.lastID}).`); });
        });
    }

    // 4. Lembrete Pessoal
    if (name === "set_personal_reminder") {
        return new Promise(resolve => {
            db.run(`INSERT INTO scheduled_messages (title, message, nextRun, recurrence, active, type, channels, targetType, createdBy) VALUES (?, ?, ?, ?, 1, 'message', ?, 'personal', ?)`,
            ["Lembrete Pessoal", args.message, args.datetime, args.recurrence || 'unico', JSON.stringify({whatsapp: true, email: false}), username],
            function(err) { 
                resolve(err ? "Erro ao agendar lembrete: " + err.message : `Lembrete agendado para ${args.datetime}. O sistema enviará automaticamente.`); 
            });
        });
    }

    // 5. Enviar Mensagem para Empresa
    if (name === "send_message_to_company") {
        return new Promise(async (resolve) => {
            db.all("SELECT * FROM companies WHERE name LIKE ? LIMIT 5", [`%${args.company_name_search}%`], async (err, rows) => {
                if (err) { resolve("Erro no banco de dados."); return; }
                if (!rows || rows.length === 0) { resolve(`Empresa com nome similar a "${args.company_name_search}" não encontrada.`); return; }
                if (rows.length > 1) { 
                    const names = rows.map(r => r.name).join(", ");
                    resolve(`Encontrei várias empresas: ${names}. Seja mais específico no nome.`); 
                    return; 
                }

                const company = rows[0];
                const channels = args.channels || { whatsapp: true, email: true };
                let logMsg = [];

                if (channels.email && company.email) {
                    try {
                        const emailList = company.email.split(',').map(e => e.trim());
                        const mailOptions = {
                            from: process.env.EMAIL_USER,
                            to: emailList[0],
                            cc: emailList.slice(1),
                            subject: "Comunicado Contabilidade",
                            text: args.message_body, 
                            html: buildEmailHtml(args.message_body, [], "Atenciosamente,\nContabilidade")
                        };
                        await emailTransporter.sendMail(mailOptions);
                        await saveToImapSentFolder(mailOptions).catch(err => 
                            log('[send-documents] Falha ao salvar no IMAP', err)
                        );
                        logMsg.push("E-mail enviado");
                    } catch (e) { logMsg.push("Falha no E-mail"); }
                }

                if (channels.whatsapp && company.whatsapp) {
                    const waWrapper = getWaClientWrapper(username);
                    if (waWrapper && waWrapper.status === 'connected') {
                        try {
                            let number = company.whatsapp.replace(/\D/g, '');
                            if (!number.startsWith('55')) number = '55' + number;
                            const chatId = `${number}@c.us`;
                            await safeSendMessage(waWrapper.client, chatId, args.message_body);
                            logMsg.push("WhatsApp enviado");
                        } catch (e) { logMsg.push("Falha no WhatsApp"); }
                    } else {
                        logMsg.push("WhatsApp desconectado");
                    }
                }

                resolve(`Ação executada para ${company.name}: ${logMsg.join(", ")}.`);
            });
        });
    }

    if (name === "search_company") {
        return new Promise(resolve => {
            db.all("SELECT id, name, docNumber, email, whatsapp, type FROM companies WHERE name LIKE ? OR docNumber LIKE ? LIMIT 5",
            [`%${args.name_or_doc}%`, `%${args.name_or_doc}%`], (err, rows) => {
                if(err) resolve("Erro na busca.");
                else resolve(rows.length ? JSON.stringify(rows) : "Nenhuma empresa encontrada.");
            });
        });
    }

    // Enviar mensagem para número de telefone direto
    if (name === "send_message_to_phone") {
        const waWrapper = getWaClientWrapper(username);
        if (!waWrapper || waWrapper.status !== 'connected') {
            return "WhatsApp não está conectado. Impossível enviar a mensagem.";
        }
        try {
            let phone = (args.phone || '').replace(/\D/g, '');
            if (!phone.startsWith('55')) phone = '55' + phone;
            const chatId = `${phone}@c.us`;
            await safeSendMessage(waWrapper.client, chatId, args.message);
            return `✅ Mensagem enviada para ${args.phone}.`;
        } catch (e) {
            return `❌ Erro ao enviar mensagem: ${e.message}`;
        }
    }

    // Listar empresas
    if (name === "list_companies") {
        return new Promise(resolve => {
            let sql = "SELECT id, name, docNumber, type, email, whatsapp FROM companies";
            const params = [];
            if (args.type_filter && args.type_filter !== 'todas') {
                sql += " WHERE type = ?";
                params.push(args.type_filter);
            }
            sql += " ORDER BY name ASC LIMIT 30";
            db.all(sql, params, (err, rows) => {
                if (err) resolve("Erro ao listar empresas: " + err.message);
                else if (!rows || rows.length === 0) resolve("Nenhuma empresa encontrada com esse filtro.");
                else resolve(`${rows.length} empresa(s) encontrada(s):\n` + rows.map(r => `• ${r.name} (${r.type || 'N/A'}) | WA: ${r.whatsapp || '-'} | Email: ${r.email || '-'}`).join('\n'));
            });
        });
    }

    // Criar tag no Kanban
    if (name === "create_kanban_tag") {
        return new Promise((resolve) => {
            const tagId = `tag-${Date.now()}`;
            const color = args.color || ('#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0'));
            db.run("INSERT INTO tags (id, name, color) VALUES (?, ?, ?)", [tagId, args.name, color], function(err) {
                if (err) resolve("Erro ao criar tag: " + err.message);
                else {
                    resolve(`✅ Tag "${args.name}" criada com cor ${color}.`);
                }
            });
        });
    }

    // Adicionar tag a contato
    if (name === "add_tag_to_contact") {
        return new Promise((resolve) => {
            let phone = (args.phone || '').replace(/\D/g, '');
            if (!phone.startsWith('55')) phone = '55' + phone;
            const chatId = `${phone}@c.us`;

            db.get("SELECT id FROM chats WHERE phone = ? OR id = ?", [phone, chatId], (err, chat) => {
                if (!chat) { resolve(`❌ Contato com número ${args.phone} não encontrado no Kanban.`); return; }
                db.get("SELECT id FROM tags WHERE name LIKE ?", [`%${args.tag_name}%`], (err2, tag) => {
                    if (!tag) { resolve(`❌ Tag "${args.tag_name}" não encontrada. Use 'criar tag' primeiro.`); return; }
                    db.run("INSERT OR IGNORE INTO chat_tags (chat_id, tag_id) VALUES (?, ?)", [chat.id, tag.id], function(err3) {
                        if (err3) resolve("Erro ao adicionar tag: " + err3.message);
                        else resolve(`✅ Tag "${args.tag_name}" adicionada ao contato ${args.phone}.`);
                    });
                });
            });
        });
    }

    // Consultar histórico de envios
    if (name === "consult_sent_history") {
        const limit = args.limit || 10;
        return new Promise(resolve => {
            db.all("SELECT companyName, docName, category, sentAt, channels, status FROM sent_logs ORDER BY id DESC LIMIT ?", [limit], (err, rows) => {
                if (err) resolve("Erro ao consultar histórico.");
                else if (!rows || rows.length === 0) resolve("Nenhum envio registrado ainda.");
                else resolve(`Últimos ${rows.length} envio(s):\n` + rows.map(r => `• ${r.sentAt} | ${r.companyName} | ${r.docName} (${r.category}) | ${r.status}`).join('\n'));
            });
        });
    }

    if (name === "manage_memory") {
        if (args.action === "save") {
            const now = new Date().toISOString();
            return new Promise(resolve => {
                db.run("INSERT INTO personal_notes (topic, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
                [args.topic, args.content, now, now], (err) => resolve(err ? "Erro." : "Memória salva."));
            });
        }
        if (args.action === "search") {
            return new Promise(resolve => {
                const term = args.content || args.topic || "";
                db.all("SELECT topic, content FROM personal_notes WHERE topic LIKE ? OR content LIKE ? LIMIT 3",
                [`%${term}%`, `%${term}%`], (err, rows) => resolve(JSON.stringify(rows)));
            });
        }
    }

    // Buscar contato do WhatsApp (agenda + lista de conversas)
    if (name === "search_whatsapp_contact") {
        const query = (args.query || "").toLowerCase().trim();
        const waWrapper = getWaClientWrapper(username);
        if (!waWrapper || waWrapper.status !== "connected") {
            return "WhatsApp não conectado. Não é possível buscar contatos.";
        }
        try {
            const chats = await waWrapper.client.getChats();
            const results = [];
            for (const chat of chats) {
                if (chat.isGroup) continue;
                const chatId = chat.id._serialized || "";
                const chatName = (chat.name || "").toLowerCase();
                const phone = chatId.replace("@c.us", "").replace("@lid", "");
                if (chatName.includes(query) || phone.includes(query.replace(/\D/g, ""))) {
                    const isPhone = /^55\d+@c\.us$/.test(chatId);
                    results.push({ chatId, name: chat.name || chatId, displayId: isPhone ? "+" + phone : chat.name || chatId });
                }
                if (results.length >= 5) break;
            }
            if (results.length === 0) {
                const contacts = await waWrapper.client.getContacts();
                for (const c of contacts) {
                    if (!c.id || c.id.server === "g.us") continue;
                    const cname = (c.name || c.pushname || "").toLowerCase();
                    const cphone = (c.number || "").replace(/\D/g, "");
                    if (cname.includes(query) || cphone.includes(query.replace(/\D/g, ""))) {
                        const cId = c.id._serialized;
                        const isPhone = /^55\d+@c\.us$/.test(cId);
                        results.push({ chatId: cId, name: c.name || c.pushname || cId, displayId: isPhone ? "+" + c.number : cId });
                        if (results.length >= 5) break;
                    }
                }
            }
            if (results.length === 0) return `Nenhum contato encontrado para "${args.query}".`;
            return "Contatos encontrados:\n" + results.map((r, i) => `${i+1}. ${r.name} (${r.displayId}) — chatId: ${r.chatId}`).join("\n") + "\n\nUse o chatId correto para enviar mensagem.";
        } catch (e) {
            log("[AI Tool] search_whatsapp_contact error", e);
            return "Erro ao buscar contatos: " + e.message;
        }
    }

    if (name === "send_message_to_contact") {
        const waWrapper = getWaClientWrapper(username);
        if (!waWrapper || waWrapper.status !== "connected") return "WhatsApp não conectado.";
        try {
            await safeSendMessage(waWrapper.client, args.chat_id, args.message);
            return `✅ Mensagem enviada para ${args.chat_id}.`;
        } catch (e) {
            return `❌ Erro ao enviar: ${e.message}`;
        }
    }

    if (name === "search_whatsapp_messages") {
        const now = new Date();
        const brNow = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) - 3600000 * 3);
        const period = args.period || "hoje";
        const limit = args.limit || 20;
        const contactQ = (args.contact_query || "").trim();
        let fromTs = 0, toTs = Math.floor(brNow.getTime() / 1000);
        if (period === "hoje") {
            const s = new Date(brNow); s.setHours(0,0,0,0); fromTs = Math.floor(s.getTime() / 1000);
        } else if (period === "ontem") {
            const s = new Date(brNow); s.setDate(s.getDate()-1); s.setHours(0,0,0,0); fromTs = Math.floor(s.getTime()/1000);
            const e2 = new Date(s); e2.setHours(23,59,59,999); toTs = Math.floor(e2.getTime()/1000);
        } else if (period === "ultimas24h") {
            fromTs = Math.floor((brNow.getTime() - 86400000) / 1000);
        } else if (period === "semana") {
            fromTs = Math.floor((brNow.getTime() - 7 * 86400000) / 1000);
        }
        return new Promise(resolve => {
            let sql = "SELECT m.chatId, m.body, m.timestamp, m.fromMe FROM whatsapp_messages m WHERE m.timestamp >= ? AND m.timestamp <= ? AND m.body != ''";
            const params = [fromTs, toTs];
            if (contactQ) { sql += " AND (m.chatId LIKE ? OR m.sender LIKE ?)"; params.push("%" + contactQ.replace(/\D/g,"") + "%", "%" + contactQ + "%"); }
            sql += " ORDER BY m.timestamp ASC LIMIT ?"; params.push(limit);
            db.all(sql, params, (err, rows) => {
                if (err || !rows || rows.length === 0) { resolve("Nenhuma mensagem encontrada no período solicitado."); return; }
                const summary = rows.map(r => {
                    const t = new Date(r.timestamp * 1000).toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
                    const who = r.fromMe ? "Você" : r.chatId.replace("@c.us","").replace("@lid","");
                    return `[${t}] ${who}: ${r.body.slice(0,200)}`;
                }).join("\n");
                resolve(`Mensagens ${period} (${rows.length}):\n\n${summary}`);
            });
        });
    }

    return "Ferramenta desconhecida.";
};

// --- HELPER: Retry Logic for 429 Errors ---
const runWithRetry = async (fn, retries = 3, delay = 2000) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            const isRateLimit = error.message?.includes('429') || error.status === 429;
            if (!isRateLimit || i === retries - 1) throw error;
            const waitTime = delay * Math.pow(2, i);
            log(`[AI Retry] Aguardando ${waitTime/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
};

// --- AI PROCESSOR ---
const processAI = async (username, userMessage, mediaPart = null) => {
    const db = getDb(username);
    if (!db || !ai) return "Sistema de IA indisponível.";

    const greetingRegex = /^(oi|ola|olá|bom dia|boa tarde|boa noite|opa|eai|tudo bem|ajuda)\??$/i;
    if (!mediaPart && greetingRegex.test(userMessage.trim())) {
        return "Olá! Sou seu assistente. Posso consultar empresas, anotar tarefas, enviar mensagens e lembrar você de coisas. Como ajudo?";
    }

    const history = await new Promise(resolve => {
        db.all("SELECT role, content FROM chat_history ORDER BY id DESC LIMIT 6", (err, rows) => {
            resolve(rows ? rows.reverse().map(r => ({ role: r.role === 'user' ? 'user' : 'model', parts: [{ text: r.content }] })) : []);
        });
    });

    const now = new Date();
    const currentTimeStr = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const currentISO = now.toISOString();

    const systemInstruction = `Você é o **Contábil Bot**, copiloto interno do escritório contábil de Lucas Araújo (CRC-BA 046968/O). Você NÃO é um atendente do cliente final — você é um assistente operacional interno.

DATA/HORA ATUAL: ${currentTimeStr} (ISO: ${currentISO}).
Use essa data para calcular vencimentos ou agendamentos relativos (ex: "daqui a 20 min" = somar 20 min ao ISO atual).

COMPORTAMENTO GERAL:
- Identifique o tipo de pedido: CONSULTA, RESUMO, AÇÃO, SUGESTÃO DE RESPOSTA, CLASSIFICAÇÃO, FOLLOW-UP, TRIAGEM ou COMANDO OPERACIONAL.
- Responda de forma objetiva, clara, profissional e operacional.
- Priorize: clareza, precisão, segurança, utilidade prática no contexto de escritório contábil.
- Para destacar, use **negrito** (dois asteriscos). NÃO use um único asterisco.

REGRA MAIS IMPORTANTE — NUNCA ADIVINHE:
- Se o pedido depende de dados do sistema que você ainda não tem, USE A TOOL CORRESPONDENTE para buscar. Não invente resultados.
- Se os dados já foram retornados pela tool, responda em linguagem natural útil.

REGRAS DE OURO:
1. **Tarefas:** Se pedir "todas" as tarefas, use 'consult_tasks' com status='todas'. Para concluir/mudar status, use 'update_task_status'.
2. **Envio para Empresa Cadastrada:** Se o usuário pedir para enviar mensagem para uma empresa cadastrada no sistema, use SEMPRE 'send_message_to_company'. NUNCA apenas sugira o texto.
3. **Envio para Contato da Conversa (pessoa/número não empresa):** Se o usuário citar um nome de pessoa ou número que pode ser da lista de conversas do WhatsApp, use PRIMEIRO 'search_whatsapp_contact' para encontrar o chatId correto, depois 'send_message_to_contact'. Nunca adivinhe o número.
4. **Envio por Número Direto:** Se o usuário fornecer um número explícito, use 'send_message_to_phone' diretamente.
5. **Lembretes Pessoais:** "me lembre de X", "lembrete em Y horas" → use 'set_personal_reminder'. Calcule o datetime ISO correto com base na hora atual do system prompt. O sistema envia automaticamente para o número configurado.
6. **Resumo de Mensagens WhatsApp:** "resuma mensagens de ontem", "o que fulano me enviou hoje?" → use 'search_whatsapp_messages' com o period e contact_query corretos.
7. **Memória:** Use 'manage_memory' para guardar informações duradouras ou buscar informações passadas.
8. **Tags Kanban:** Para criar tag use 'create_kanban_tag'. Para adicionar tag a contato use 'add_tag_to_contact'.
9. **Histórico de Envios:** "quantos documentos enviei", "últimos envios" → use 'consult_sent_history'.
10. **Saída:** Após usar tool de envio, confirme apenas o envio sem repetir o texto. Após lembretes, confirme data/hora calculada.

SEGURANÇA:
- NUNCA execute automaticamente ações críticas sem confirmação explícita do usuário.
- NÃO recomende respostas automáticas livres para: cálculo de imposto, interpretação tributária, demissão, rescisão, admissão, multa, enquadramento fiscal, obrigações legais específicas.
- Você é um copiloto interno, não um chatbot de atendimento ao cliente.`;

    const currentParts = [];
    if (mediaPart) currentParts.push(mediaPart);
    if (userMessage) currentParts.push({ text: userMessage });

    try {
        const chat = ai.chats.create({ 
            model: "gemini-2.5-flash", 
            config: {
                systemInstruction: systemInstruction,
                tools: [{ functionDeclarations: assistantTools }]
            },
            history: history
        });

        let response = await runWithRetry(() => chat.sendMessage({ message: currentParts }));
        let functionCalls = response.functionCalls;
        let loopCount = 0;

        while (functionCalls && functionCalls.length > 0 && loopCount < 5) {
            loopCount++;
            const call = functionCalls[0];
            const result = await executeTool(call.name, call.args, db, username);
            response = await runWithRetry(() => chat.sendMessage({
                message: [{ functionResponse: { name: call.name, response: { result: result } } }]
            }));
            functionCalls = response.functionCalls;
        }

        const finalText = response.text || "Comando processado.";
        db.run("INSERT INTO chat_history (role, content, timestamp) VALUES (?, ?, ?)", ['user', userMessage, new Date().toISOString()]);
        db.run("INSERT INTO chat_history (role, content, timestamp) VALUES (?, ?, ?)", ['model', finalText, new Date().toISOString()]);

        return finalText;

    } catch (e) {
        log("[AI Error]", e);
        if (e.message?.includes('404')) return "Erro: Modelo de IA não encontrado. Verifique as configurações do servidor.";
        if (e.message?.includes('429')) return "Muitas requisições à IA no momento. Aguarde alguns segundos e tente novamente.";
        return `Desculpe, ocorreu um erro interno (${e.message?.slice(0,80) || 'desconhecido'}). Tente novamente.`;
    }
};

// --- MULTI-TENANCY: WhatsApp Management ---
const waClients = {}; 

const broadcastWaEvent = (username, eventType, data) => {
    if (waClients[username] && waClients[username].sseClients) {
        waClients[username].sseClients.forEach(res => {
            try {
                res.write(`data: ${JSON.stringify({ type: eventType, payload: data })}\n\n`);
            } catch (e) {}
        });
    }
};

const getWaClientWrapper = (username) => {
    if (!username) return null;
    
    if (!waClients[username]) {
        log(`[WhatsApp Init] Inicializando cliente para usuário: ${username}`);
        
        waClients[username] = {
            client: null,
            qr: null,
            status: 'disconnected',
            info: null,
            sseClients: []
        };

        const authPath = path.join(DATA_DIR, `whatsapp_auth_${username}`);
        if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

        const sessionPath = path.join(authPath, `session-${username}`);
        cleanPuppeteerLocks(sessionPath);

        const puppeteerExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
        
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: username, dataPath: authPath }), 
            puppeteer: {
                headless: true,
                executablePath: puppeteerExecutablePath,
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox', 
                    '--disable-dev-shm-usage', 
                    '--disable-accelerated-2d-canvas', 
                    '--no-first-run', 
                    '--no-zygote', 
                    '--disable-gpu', 
                    '--disable-software-rasterizer',
                    '--single-process'
                ],
            }
        });

        // ============================================================
        // SEÇÃO 2 — CORRIGIR handler 'message' (mensagens RECEBIDAS)
        // ============================================================
        client.on('message', async (msg) => {
            if (msg.from.includes('@g.us') || msg.to.includes('@g.us') || msg.isStatus || (msg.id && msg.id.remote && msg.id.remote.includes('@g.us'))) {
                return;
            }

            const sender = msg.from;
            const chatId = msg.from;
            log(`[WhatsApp Inbound] Mensagem recebida de: ${sender} | Body: ${msg.body?.substring(0, 30)}...`);

            // ✅ CORRIGIDO: tipo agora é 'whatsapp_message' (era 'message')
            // ✅ NOVO: chatId e fromMe incluídos no payload
            const msgPayload = {
                id: msg.id._serialized,
                from: msg.from,
                to: msg.to,
                body: msg.body,
                timestamp: msg.timestamp,
                hasMedia: msg.hasMedia,
                type: msg.type,
                fromMe: false,
                chatId: chatId
            };
            broadcastWaEvent(username, 'whatsapp_message', msgPayload);

            // ✅ NOVO: Persistir no banco imediatamente
            const db = getDb(username);
            if (db) {
                saveMessageToDb(db, {
                    id: msg.id._serialized,
                    chatId,
                    sender: msg.from,
                    timestamp: msg.timestamp,
                    body: msg.body || '',
                    fromMe: false,
                    hasMedia: msg.hasMedia,
                    type: msg.type
                });
            }

            if (msg.hasMedia) {
                try {
                    const media = await msg.downloadMedia();
                    if (media) {
                        const originalName = media.filename || ('whatsapp_media_' + msg.timestamp + '.' + (media.mimetype.split('/')[1] || '').split(';')[0] || 'bin');
                        const serverFilename = Date.now() + '-' + originalName.replace(/[^a-zA-Z0-9.]/g, '_');
                        const buffer = Buffer.from(media.data, 'base64');
                        fs.writeFileSync(path.join(UPLOADS_DIR, serverFilename), buffer);
                        
                        const db = getDb(username);
                        if(db) {
                            db.run('INSERT INTO file_gallery (serverFilename, originalName, mimeType, size, contact, channel, direction, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                                [serverFilename, originalName, media.mimetype, buffer.length, msg.from, 'whatsapp', 'received', new Date().toISOString()]);
                        }
                    }
                } catch(e) {
                    log(`[WhatsApp Inbound] Erro ao baixar media auto: ${e.message}`);
                }
            }

            try {
                const db = getDb(username);
                const settings = await new Promise(resolve => {
                    db.get("SELECT settings FROM user_settings WHERE id = 1", (e, r) => resolve(r ? JSON.parse(r.settings) : null));
                });

                // Números/LIDs autorizados para acionar a IA
                const FALLBACK_AUTHORIZED_NUMBER = '557591167094';
                const FALLBACK_AUTHORIZED_LID = '105403295727623@lid';
                const LEGACY_LID = '140368205074641@lid';

                const isLid = msg.from.endsWith('@lid');
                let isAuthorized = false;

                if (isLid) {
                    // Aceita o LID do fallback ou o LID legado
                    isAuthorized = (msg.from === FALLBACK_AUTHORIZED_LID || msg.from === LEGACY_LID);
                    // Também aceita LID configurado nas settings
                    if (!isAuthorized && settings?.authorizedLid) {
                        isAuthorized = (msg.from === settings.authorizedLid);
                    }
                } else {
                    const senderNumber = msg.from.replace('@c.us', '').replace(/\D/g, '');
                    // Aceita o número do fallback
                    if (senderNumber === FALLBACK_AUTHORIZED_NUMBER.replace(/\D/g, '')) {
                        isAuthorized = true;
                    }
                    // Aceita número configurado nas settings
                    if (!isAuthorized && settings?.dailySummaryNumber) {
                        const authorizedNumber = settings.dailySummaryNumber.replace(/\D/g, '');
                        isAuthorized = senderNumber.endsWith(authorizedNumber);
                    }
                }

                if (!isAuthorized) {
                    log(`[AI Trigger] Acesso negado para: ${msg.from}`);
                    return;
                }

                if (settings.aiEnabled === false) {
                    log(`[AI Trigger] IA está desativada nas configurações.`);
                    return;
                }

                log(`[AI Trigger] ACESSO PERMITIDO! Iniciando processamento IA...`);

                let mediaPart = null;
                let textContent = msg.body;

                if (msg.hasMedia) {
                    try {
                        const media = await msg.downloadMedia();
                        if (media) {
                            mediaPart = {
                                inlineData: {
                                    mimeType: media.mimetype,
                                    data: media.data
                                }
                            };
                            if (media.mimetype.startsWith('audio/')) {
                                textContent = "Por favor, analise este áudio. " + (msg.body || "");
                            } else {
                                textContent += " [Mídia anexa]";
                            }
                        }
                    } catch (mediaErr) {
                        log("Erro download media", mediaErr);
                    }
                }

                const response = await processAI(username, textContent, mediaPart);
                await safeSendMessage(client, msg.from, response);

            } catch (e) {
                log("Erro no handler de mensagem IA", e);
            }
        });

        // ============================================================
        // SEÇÃO 3 — CORRIGIR handler 'message_create' (mensagens ENVIADAS)
        // ============================================================
        client.on('message_create', async (msg) => {
            if (msg.fromMe) {
                const chatId = msg.to;

                // ✅ CORRIGIDO: tipo 'whatsapp_message' + chatId + fromMe no payload
                broadcastWaEvent(username, 'whatsapp_message', {
                    id: msg.id._serialized,
                    from: msg.from,
                    to: msg.to,
                    body: msg.body,
                    timestamp: msg.timestamp,
                    hasMedia: msg.hasMedia,
                    type: msg.type,
                    fromMe: true,
                    chatId: chatId
                });

                // ✅ NOVO: Persistir mensagem enviada no banco
                const db = getDb(username);
                if (db) {
                    saveMessageToDb(db, {
                        id: msg.id._serialized,
                        chatId,
                        sender: msg.from,
                        timestamp: msg.timestamp,
                        body: msg.body || '',
                        fromMe: true,
                        hasMedia: msg.hasMedia,
                        type: msg.type
                    });
                }
            }
        });

        client.on('qr', (qr) => { 
            log(`[WhatsApp Event] QR Code gerado para ${username}`);
            QRCode.toDataURL(qr, (err, url) => { 
                if (err) log(`[WhatsApp Event] Erro QR`, err);
                waClients[username].qr = url; 
                waClients[username].status = 'generating_qr';
            }); 
        });
        
        client.on('ready', () => { 
            log(`[WhatsApp Event] CLIENTE PRONTO (${username})`);
            waClients[username].status = 'connected';
            waClients[username].qr = null;
            waClients[username].info = client.info;
        });
        
        client.on('authenticated', () => {
            log(`[WhatsApp Event] Autenticado (${username})`);
        });

        client.on('auth_failure', (msg) => {
            log(`[WhatsApp Event] FALHA DE AUTENTICAÇÃO (${username}): ${msg}`);
            waClients[username].status = 'error';
        });
        
        client.on('disconnected', (reason) => { 
            log(`[WhatsApp Event] Desconectado (${username}). Razão: ${reason}`);
            waClients[username].status = 'disconnected';
            waClients[username].info = null;
        });

        client.initialize().catch((err) => {
            log(`[WhatsApp Init] ERRO FATAL (${username})`, err);
            waClients[username].status = 'error';
        });
        
        waClients[username].client = client;
    }

    return waClients[username];
};

// --- LOGIC: Send Daily Summary Helper ---
const sendDailySummaryToUser = async (user) => {
    const db = getDb(user);
    if (!db) return;

    const waWrapper = getWaClientWrapper(user);
    if (waWrapper.status !== 'connected') {
        return { success: false, message: 'WhatsApp desconectado' };
    }

    return new Promise((resolve, reject) => {
        db.get("SELECT settings FROM user_settings WHERE id = 1", (e, r) => {
            if (e || !r) { resolve({ success: false, message: 'Configurações não encontradas' }); return; }
            
            const settings = JSON.parse(r.settings);
            if (!settings.dailySummaryNumber) { resolve({ success: false, message: 'Número para resumo não configurado' }); return; }

            const sql = `SELECT t.*, c.name as companyName FROM tasks t LEFT JOIN companies c ON t.companyId = c.id WHERE t.status != 'concluida'`;

            db.all(sql, [], async (err, tasks) => {
                if (err) { resolve({ success: false, message: 'Erro ao buscar tarefas' }); return; }
                if (!tasks || tasks.length === 0) { resolve({ success: true, message: 'Nenhuma tarefa pendente' }); return; }

                const priorityMap = { 'alta': 1, 'media': 2, 'baixa': 3 };
                const sortedTasks = tasks.sort((a, b) => (priorityMap[a.priority] || 99) - (priorityMap[b.priority] || 99));

                let message = `*📅 Resumo Diário de Tarefas*\n\nVocê tem *${sortedTasks.length}* tarefas pendentes.\n\n`;
                sortedTasks.forEach(task => {
                    let icon = task.priority === 'alta' ? '🔴' : task.priority === 'media' ? '🟡' : '🔵';
                    message += `${icon} *${task.title}*\n`;
                    if (task.companyName) message += `   🏢 ${task.companyName}\n`;
                    if (task.dueDate) message += `   📅 Vence: ${task.dueDate}\n`;
                    message += `\n`;
                });
                message += `_Gerado automaticamente pelo Contábil Manager Pro_`;

                try {
                    let number = settings.dailySummaryNumber.replace(/\D/g, '');
                    if (!number.startsWith('55')) number = '55' + number;
                    const chatId = `${number}@c.us`;
                    
                    await safeSendMessage(waWrapper.client, chatId, message);
                    resolve({ success: true, message: 'Enviado com sucesso' });
                } catch (sendErr) {
                    log(`[Summary] Erro envio`, sendErr);
                    resolve({ success: false, message: 'Erro no envio do WhatsApp' });
                }
            });
        });
    });
};

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const headerToken = authHeader && authHeader.split(' ')[1]; 
    const token = headerToken || req.query.token;
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });
    const parts = token.split('-');
    if (parts.length < 3) return res.status(403).json({ error: 'Token inválido' });
    const user = parts.slice(2).join('-'); 
    const envUsers = (process.env.USERS || '').split(',');
    if (!envUsers.includes(user)) return res.status(403).json({ error: 'Usuário não autorizado' });
    req.user = user;
    next();
};

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, UPLOADS_DIR) },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    cb(null, uniqueSuffix + '-' + cleanName)
  }
})
const upload = multer({ storage: storage });

// --- HTML Builder Helper ---
const buildEmailHtml = (messageBody, documents, emailSignature) => {
    let docsTable = '';
    if (documents && documents.length > 0) {
        const sortedDocs = [...documents].sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
        let rows = '';
        sortedDocs.forEach(doc => {
            rows += `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #333;">${doc.docName}</td><td style="padding: 10px; color: #555;">${doc.category}</td><td style="padding: 10px; color: #555;">${doc.dueDate || 'N/A'}</td><td style="padding: 10px; color: #555;">${doc.competence}</td></tr>`;
        });
        docsTable = `<h3 style="color: #2c3e50; border-bottom: 2px solid #eff6ff; padding-bottom: 10px; margin-top: 30px; font-size: 16px;">Documentos em Anexo:</h3><table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px;"><thead><tr style="background-color: #f8fafc; color: #64748b;"><th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Documento</th><th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Categoria</th><th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Vencimento</th><th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Competência</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    return `<html><body style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 20px;"><div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);"><div style="background-color: #f8f9fa; padding: 20px; border-radius: 6px; border-left: 4px solid #2563eb; margin-bottom: 25px;">${messageBody.replace(/\n/g, '<br>')}</div>${docsTable}<div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 14px; color: #64748b;">${emailSignature || ''}</div></div></body></html>`;
};

// --- ROUTES ---

app.post('/api/ai/chat', authenticateToken, async (req, res) => {
    try {
        const username = req.user;
        const msg = req.body.message;
        const historyContext = req.body.historyContext || '';
        // Prepend local history context to the message for better AI continuity
        const enrichedMsg = historyContext
            ? `[Contexto do histórico local de conversas com a IA:\n${historyContext}\n---\nMensagem atual:]\n${msg}`
            : msg;
        const reply = await processAI(username, enrichedMsg);
        res.json({ reply });
    } catch (e) {
        log("[AI Route Error]", e);
        res.status(500).json({ error: "Erro na IA" });
    }
});

app.post('/api/login', (req, res) => {
    const { user, password } = req.body;
    const envUsers = (process.env.USERS || 'admin').split(',');
    const envPasss = (process.env.PASSWORDS || 'admin').split(',');
    const userIndex = envUsers.indexOf(user);

    if (userIndex !== -1 && envPasss[userIndex] === password) {
        getWaClientWrapper(user);
        res.json({ success: true, token: `session-${Date.now()}-${user}` });
    } else {
        res.status(401).json({ error: 'Credenciais inválidas' });
    }
});

app.use('/api', authenticateToken);

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo' });
    res.json({ filename: req.file.filename, originalName: req.file.originalname });
});

app.get('/api/settings', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.get("SELECT settings FROM user_settings WHERE id = 1", (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row ? JSON.parse(row.settings) : null);
    });
});

app.post('/api/settings', (req, res) => {
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    const settingsJson = JSON.stringify(req.body);
    db.run("INSERT INTO user_settings (id, settings) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings", [settingsJson], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post('/api/trigger-daily-summary', async (req, res) => {
    try {
        const result = await sendDailySummaryToUser(req.user);
        if (result && result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({ error: result ? result.message : "Falha desconhecida" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/companies', (req, res) => { 
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.all('SELECT * FROM companies ORDER BY name ASC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => ({...r, categories: r.categories ? JSON.parse(r.categories) : []})) || []);
    }); 
});

app.post('/api/companies', (req, res) => {
    const { id, name, docNumber, type, email, whatsapp, categories, observation } = req.body;
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    
    const catStr = JSON.stringify(categories || []);

    if (id) {
        db.run(`UPDATE companies SET name=?, docNumber=?, type=?, email=?, whatsapp=?, categories=?, observation=? WHERE id=?`, 
            [name, docNumber, type, email, whatsapp, catStr, observation || '', id], 
            function(err) { 
                if (err) return res.status(500).json({ error: err.message });
                res.json({success: true, id});
            });
    } else {
        db.run(`INSERT INTO companies (name, docNumber, type, email, whatsapp, categories, observation) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [name, docNumber, type, email, whatsapp, catStr, observation || ''], 
            function(err) { 
                if (err) return res.status(500).json({ error: err.message });
                res.json({success: true, id: this.lastID});
            });
    }
});

app.delete('/api/companies/:id', (req, res) => { 
    const db = getDb(req.user);
    if (!db) return res.status(500).json({ error: 'Database error' });
    db.run('DELETE FROM companies WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/tasks', (req, res) => {
    getDb(req.user).all('SELECT * FROM tasks', (err, rows) => res.json(rows || []));
});
app.post('/api/tasks', (req, res) => {
    const t = req.body;
    const db = getDb(req.user);
    const today = new Date().toISOString().split('T')[0];
    const createdAt = t.createdAt || today;

    if (t.id && t.id < 1000000000000) {
        db.run(`UPDATE tasks SET title=?, description=?, status=?, priority=?, color=?, dueDate=?, companyId=?, recurrence=?, dayOfWeek=?, recurrenceDate=?, targetCompanyType=?, createdAt=? WHERE id=?`, 
        [t.title, t.description, t.status, t.priority, t.color, t.dueDate, t.companyId, t.recurrence, t.dayOfWeek, t.recurrenceDate, t.targetCompanyType, createdAt, t.id], 
        function(err) { res.json({ success: !err, id: t.id }); });
    } else {
        db.run(`INSERT INTO tasks (title, description, status, priority, color, dueDate, companyId, recurrence, dayOfWeek, recurrenceDate, targetCompanyType, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
        [t.title, t.description, t.status, t.priority, t.color, t.dueDate, t.companyId, t.recurrence, t.dayOfWeek, t.recurrenceDate, t.targetCompanyType, createdAt], 
        function(err) { res.json({ success: !err, id: this.lastID }); });
    }
});
app.delete('/api/tasks/:id', (req, res) => { getDb(req.user).run('DELETE FROM tasks WHERE id = ?', [req.params.id], (err) => res.json({ success: !err })); });

app.get('/api/documents/status', (req, res) => {
    const sql = req.query.competence ? 'SELECT * FROM document_status WHERE competence = ?' : 'SELECT * FROM document_status';
    getDb(req.user).all(sql, req.query.competence ? [req.query.competence] : [], (err, rows) => res.json(rows || []));
});
app.post('/api/documents/status', (req, res) => {
    const { companyId, category, competence, status } = req.body;
    getDb(req.user).run(`INSERT INTO document_status (companyId, category, competence, status) VALUES (?, ?, ?, ?) ON CONFLICT(companyId, category, competence) DO UPDATE SET status = excluded.status`, [companyId, category, competence, status], (err) => res.json({ success: !err }));
});

// --- Scheduled Messages Routes ---
app.get('/api/scheduled', (req, res) => {
    getDb(req.user).all("SELECT * FROM scheduled_messages", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(row => ({
            ...row, 
            active: !!row.active, 
            channels: JSON.parse(row.channels || '{}'),
            selectedCompanyIds: row.selectedCompanyIds ? JSON.parse(row.selectedCompanyIds) : [],
            documentsPayload: row.documentsPayload || null
        })) || []);
    });
});

app.post('/api/scheduled', (req, res) => {
    const { id, title, message, nextRun, recurrence, active, type, channels, targetType, selectedCompanyIds, attachmentFilename, attachmentOriginalName, documentsPayload } = req.body;
    const db = getDb(req.user);
    const channelsStr = JSON.stringify(channels);
    const companyIdsStr = JSON.stringify(selectedCompanyIds || []);

    if (id) {
        db.run(`UPDATE scheduled_messages SET title=?, message=?, nextRun=?, recurrence=?, active=?, type=?, channels=?, targetType=?, selectedCompanyIds=?, attachmentFilename=?, attachmentOriginalName=?, documentsPayload=? WHERE id=?`,
        [title, message, nextRun, recurrence, active ? 1 : 0, type, channelsStr, targetType, companyIdsStr, attachmentFilename, attachmentOriginalName, documentsPayload, id],
        function(err) { if (err) return res.status(500).json({error: err.message}); res.json({success: true, id}); });
    } else {
        db.run(`INSERT INTO scheduled_messages (title, message, nextRun, recurrence, active, type, channels, targetType, selectedCompanyIds, attachmentFilename, attachmentOriginalName, documentsPayload, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [title, message, nextRun, recurrence, active ? 1 : 0, type, channelsStr, targetType, companyIdsStr, attachmentFilename, attachmentOriginalName, documentsPayload, req.user],
        function(err) { if (err) return res.status(500).json({error: err.message}); res.json({success: true, id: this.lastID}); });
    }
});

app.delete('/api/scheduled/:id', (req, res) => {
    getDb(req.user).run('DELETE FROM scheduled_messages WHERE id = ?', [req.params.id], (err) => res.json({ success: !err }));
});

app.get('/api/whatsapp/status', (req, res) => { 
    const wrapper = getWaClientWrapper(req.user);
    res.json({ 
        status: wrapper.status, 
        qr: wrapper.qr, 
        info: wrapper.info 
    }); 
});
app.post('/api/whatsapp/disconnect', async (req, res) => { 
    try { 
        const wrapper = getWaClientWrapper(req.user);
        if (wrapper.client) {
            await wrapper.client.logout(); 
            wrapper.status = 'disconnected';
            wrapper.qr = null;
        }
        res.json({ success: true }); 
    } catch (e) { res.status(500).json({ error: e.message }); } 
});

app.get('/api/whatsapp/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const username = req.user;
    const wrapper = getWaClientWrapper(username);
    if (!wrapper) return res.end();
    wrapper.sseClients.push(res);
    req.on('close', () => {
        wrapper.sseClients = wrapper.sseClients.filter(c => c !== res);
    });
});

app.get('/api/whatsapp/messages/:chatId', authenticateToken, async (req, res) => {
    try {
        const wrapper = getWaClientWrapper(req.user);
        if (!wrapper || wrapper.status !== 'connected') return res.status(400).json({error: 'Not connected'});
        const chat = await wrapper.client.getChatById(req.params.chatId);
        const limitParam = parseInt(req.query.limit) || 50;
        const messages = await chat.fetchMessages({limit: Math.min(limitParam, 300)});

        const mapped = messages.map(m => ({
            id: m.id._serialized,
            from: m.from,
            to: m.to,
            body: m.body,
            timestamp: m.timestamp,
            hasMedia: m.hasMedia,
            type: m.type,
            fromMe: m.fromMe
        }));

        // ✅ NOVO: Persistir no banco as mensagens trazidas pelo scroll
        const db = getDb(req.user);
        if (db) {
            const chatId = req.params.chatId;
            const FORTY_FIVE_DAYS_AGO = Math.floor(Date.now() / 1000) - (45 * 24 * 3600);
            const toSave = messages
                .filter(m => m.timestamp >= FORTY_FIVE_DAYS_AGO)
                .map(m => ({
                    id: m.id._serialized,
                    chatId,
                    sender: m.from,
                    timestamp: m.timestamp,
                    body: m.body || '',
                    fromMe: m.fromMe,
                    hasMedia: m.hasMedia,
                    type: m.type
                }));
            saveMessagesToDb(db, toSave);
        }

        res.json(mapped.map(m => ({
            id: { _serialized: m.id, id: m.id },
            from: m.from,
            to: m.to,
            body: m.body,
            timestamp: m.timestamp,
            hasMedia: m.hasMedia,
            type: m.type,
            fromMe: m.fromMe
        })));
    } catch(e) { res.status(500).json({error: e.message}); }
});

// ============================================================
// SEÇÃO 4 — NOVA ROTA: GET /api/whatsapp/messages-db/:chatId
// ============================================================
app.get('/api/whatsapp/messages-db/:chatId', authenticateToken, async (req, res) => {
    try {
        const db = getDb(req.user);
        if (!db) return res.status(500).json({ error: 'DB não encontrado' });

        const chatId = req.params.chatId;
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const before = req.query.before ? parseInt(req.query.before) : null;

        let sql = `SELECT * FROM whatsapp_messages WHERE chatId = ?`;
        const params = [chatId];

        if (before) {
            sql += ` AND timestamp < ?`;
            params.push(before);
        }

        sql += ` ORDER BY timestamp DESC LIMIT ?`;
        params.push(limit);

        db.all(sql, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });

            const messages = rows.reverse().map(row => ({
                id: { _serialized: row.id, id: row.id },
                from: row.fromMe ? undefined : row.sender,
                to: row.fromMe ? row.chatId : undefined,
                body: row.body,
                timestamp: row.timestamp,
                hasMedia: !!row.hasMedia,
                type: row.type || 'chat',
                fromMe: !!row.fromMe,
                chatId: row.chatId,
                _fromDb: true
            }));

            res.json(messages);
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// SEÇÃO 5 — NOVA ROTA: GET /api/whatsapp/sync-status/:chatId
// ============================================================
app.get('/api/whatsapp/sync-status/:chatId', authenticateToken, async (req, res) => {
    try {
        const db = getDb(req.user);
        if (!db) return res.status(500).json({ error: 'DB não encontrado' });

        const chatId = req.params.chatId;

        db.get(`SELECT lastSyncTimestamp FROM whatsapp_sync WHERE chatId = ?`, [chatId], (err, syncRow) => {
            if (err) return res.status(500).json({ error: err.message });

            db.get(`SELECT COUNT(*) as count FROM whatsapp_messages WHERE chatId = ?`, [chatId], (err2, countRow) => {
                res.json({
                    synced: !!syncRow,
                    lastSync: syncRow ? syncRow.lastSyncTimestamp : null,
                    messageCount: countRow ? countRow.count : 0
                });
            });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// SEÇÃO 6 — NOVA ROTA: POST /api/whatsapp/load-history/:chatId
// ============================================================
app.post('/api/whatsapp/load-history/:chatId', authenticateToken, async (req, res) => {
    try {
        const wrapper = getWaClientWrapper(req.user);
        if (!wrapper || wrapper.status !== 'connected') {
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        const db = getDb(req.user);
        if (!db) return res.status(500).json({ error: 'DB não encontrado' });

        const chatId = req.params.chatId;
        const forceRefresh = req.query.force === 'true';

        const syncRow = await new Promise(resolve => {
            db.get(`SELECT lastSyncTimestamp FROM whatsapp_sync WHERE chatId = ?`, [chatId], (e, r) => resolve(r));
        });

        if (syncRow && !forceRefresh) {
            const sinceHours = (Date.now() / 1000 - syncRow.lastSyncTimestamp) / 3600;
            if (sinceHours < 1) {
                return res.json({
                    already_synced: true,
                    lastSync: syncRow.lastSyncTimestamp,
                    message: 'Histórico já carregado recentemente. Use ?force=true para forçar.'
                });
            }
        }

        log(`[History] Iniciando busca de histórico 45 dias para: ${chatId}`);

        const FORTY_FIVE_DAYS_AGO = Math.floor(Date.now() / 1000) - (45 * 24 * 3600);
        const chat = await wrapper.client.getChatById(chatId);

        let allMessages = [];
        let seenIds = new Set();
        let reachedLimit = false;

        // Busca inicial
        let fetchedBatch = await chat.fetchMessages({ limit: 100 });
        let lastOldestId = null;

        while (fetchedBatch && fetchedBatch.length > 0 && !reachedLimit) {
            // Detecta loop infinito: msg mais antiga igual ao batch anterior
            const currentOldest = fetchedBatch.reduce((o, m) => m.timestamp < o.timestamp ? m : o, fetchedBatch[0]);
            if (lastOldestId && currentOldest.id._serialized === lastOldestId) {
                log('[History] Loop detectado (API sem suporte a cursor before). Parando.');
                break;
            }
            lastOldestId = currentOldest.id._serialized;

            // Filtra duplicatas e msgs fora do período
            const inPeriod = fetchedBatch.filter(m => {
                if (seenIds.has(m.id._serialized)) return false;
                seenIds.add(m.id._serialized);
                return m.timestamp >= FORTY_FIVE_DAYS_AGO;
            });

            allMessages = [...allMessages, ...inPeriod];
            log(`[History] Batch: ${fetchedBatch.length} msgs | No período: ${inPeriod.length} | Acumulado: ${allMessages.length}`);

            // Chegou antes do período de 45 dias
            if (fetchedBatch.some(m => m.timestamp < FORTY_FIVE_DAYS_AGO)) {
                reachedLimit = true;
                break;
            }

            // Menos mensagens que o limite: sem mais histórico
            if (fetchedBatch.length < 100) break;

            // Limite de segurança
            if (allMessages.length >= 3000) break;

            // Próximo batch usando cursor before na msg mais antiga
            try {
                fetchedBatch = await chat.fetchMessages({
                    limit: 100,
                    before: currentOldest.id._serialized
                });
            } catch (cursorErr) {
                log('[History] Cursor before não suportado, parando paginação.', cursorErr);
                break;
            }
        }

        const toSave = allMessages.map(m => ({
            id: m.id._serialized,
            chatId,
            sender: m.from,
            timestamp: m.timestamp,
            body: m.body || '',
            fromMe: m.fromMe,
            hasMedia: m.hasMedia,
            type: m.type
        }));

        await saveMessagesToDb(db, toSave);

        const now = Math.floor(Date.now() / 1000);
        db.run(
            `INSERT OR REPLACE INTO whatsapp_sync (chatId, lastSyncTimestamp) VALUES (?, ?)`,
            [chatId, now]
        );

        log(`[History] Concluído: ${allMessages.length} mensagens salvas para ${chatId}`);

        res.json({
            success: true,
            count: allMessages.length,
            reachedLimit,
            sinceDays: 45
        });

    } catch (e) {
        log(`[History] ERRO ao carregar histórico`, e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/whatsapp/send-chat', upload.single('media'), async (req, res) => {
    try {
        const { chatId, message } = req.body;
        const wrapper = getWaClientWrapper(req.user);
        if (!wrapper || wrapper.status !== 'connected') return res.status(400).json({error: 'Not connected'});
        
        let content = message || '';
        let options = {};
        if (req.file) {
            const fileData = fs.readFileSync(req.file.path).toString('base64');
            const media = new MessageMedia(req.file.mimetype, fileData, req.file.originalname);
            await safeSendMessage(wrapper.client, chatId, content ? media : media, content ? {caption: content} : {});
            const db = getDb(req.user);
            if(db) {
                db.run('INSERT INTO file_gallery (serverFilename, originalName, mimeType, size, contact, channel, direction, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, chatId, 'whatsapp', 'sent', new Date().toISOString()]);
            }
        } else {
            if(content) await safeSendMessage(wrapper.client, chatId, content);
        }
        res.json({success: true});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/whatsapp/media/:msgId', authenticateToken, async (req, res) => {
    try {
        const wrapper = getWaClientWrapper(req.user);
        if (!wrapper || wrapper.status !== 'connected') return res.status(400).json({error: 'Not connected'});
        const msg = await wrapper.client.getMessageById(req.params.msgId);
        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            if(media) {
                const buffer = Buffer.from(media.data, 'base64');
                res.setHeader('Content-Type', media.mimetype);
                res.send(buffer);
                return;
            }
        }
        res.status(404).json({error: 'No media'});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/whatsapp/transcribe/:msgId', authenticateToken, async (req, res) => {
    try {
        if (!ai) return res.status(400).json({error: 'AI is not enabled'});
        const wrapper = getWaClientWrapper(req.user);
        if (!wrapper || wrapper.status !== 'connected') return res.status(400).json({error: 'Not connected'});
        const msg = await wrapper.client.getMessageById(req.params.msgId);
        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            if(media && media.mimetype.startsWith('audio/')) {
                 const result = await processAI(req.user, 'Por favor, transcreva este áudio ignorando ruídos e focando apenas na voz da maneira mais clara possível, com pontuação correta.', {
                    inlineData: {
                        mimeType: media.mimetype,
                        data: media.data
                    }
                 });
                 return res.json({transcription: result});
            }
        }
        res.status(404).json({error: 'No audio media found'});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/whatsapp/contact', async (req, res) => {
    try {
        const { number } = req.body;
        const wrapper = getWaClientWrapper(req.user);
        if (!wrapper || wrapper.status !== 'connected') return res.status(400).json({error: 'Not connected'});
        let cleanNumber = number.replace(/\D/g, '');
        if(!cleanNumber.startsWith('55')) cleanNumber = '55' + cleanNumber;
        const contactId = await wrapper.client.getNumberId(cleanNumber);
        if(contactId) {
            const chat = await wrapper.client.getChatById(contactId._serialized);
            return res.json({ id: chat.id._serialized, name: chat.name, isGroup: chat.isGroup });
        }
        res.status(404).json({error: 'Contact not found on WhatsApp'});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/whatsapp/chat-info/:chatId', authenticateToken, async (req, res) => {
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
});

app.get('/api/whatsapp/chats', authenticateToken, async (req, res) => {
    try {
        const wrapper = getWaClientWrapper(req.user);
        if (!wrapper || wrapper.status !== 'connected') return res.status(400).json({error: 'Not connected'});
        
        const db = getDb(req.user);
        db.get("SELECT settings FROM user_settings WHERE id = 1", async (err, row) => {
            try {
                let kanbanCards = [];
                if (row && row.settings) {
                    try {
                        const settings = JSON.parse(row.settings);
                        kanbanCards = (settings.waKanban?.cards || []).map(c => c.id);
                    } catch(e) {}
                }
                
                const chats = await wrapper.client.getChats();
                const now = Date.now() / 1000;
                const filteredChats = chats.filter(c => !c.isGroup).filter(c => {
                    if (kanbanCards.includes(c.id._serialized)) return true;
                    if (c.unreadCount > 0) return true;
                    if (c.timestamp && (now - c.timestamp) < 86400 * 7) return true;
                    return false;
                });

                const simplifiedChats = filteredChats.map(c => {
                    return {
                        id: c.id._serialized,
                        name: c.name || c.id.user,
                        unreadCount: c.unreadCount,
                        timestamp: c.timestamp,
                        isGroup: c.isGroup,
                        profilePicUrl: null,
                        lastMessage: '',
                        lastMessageFromMe: false
                    };
                });
                
                simplifiedChats.sort((a, b) => b.timestamp - a.timestamp);

                res.json(simplifiedChats);
            } catch(e) {
                res.status(500).json({error: e.message});
            }
        });
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/whatsapp/reset', async (req, res) => {
    try {
        const username = req.user;
        log(`[WhatsApp Reset] Solicitado reset forçado para: ${username}`);
        
        if (waClients[username] && waClients[username].client) {
            try {
                await waClients[username].client.destroy();
                log(`[WhatsApp Reset] Cliente destruído.`);
            } catch (e) {
                log(`[WhatsApp Reset] Erro ao destruir cliente (ignorado): ${e.message}`);
            }
            delete waClients[username];
        }

        const authPath = path.join(DATA_DIR, `whatsapp_auth_${username}`);
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
                log(`[WhatsApp Reset] Pasta de autenticação removida: ${authPath}`);
            } catch (e) {
                log(`[WhatsApp Reset] Erro ao remover pasta: ${e.message}`);
                return res.status(500).json({ error: "Falha ao limpar arquivos de sessão. Tente reiniciar o servidor." });
            }
        }

        getWaClientWrapper(username);

        res.json({ success: true, message: "Sessão resetada. Aguarde o novo QR Code." });

    } catch (e) {
        log(`[WhatsApp Reset] Erro fatal: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/send-documents', async (req, res) => {
    const { documents, subject, messageBody, channels, emailSignature, whatsappTemplate } = req.body;
    
    log(`[API send-documents] Iniciando envio de ${documents.length} documentos. Channels: ${JSON.stringify(channels)}`);
    
    const db = getDb(req.user);
    const waWrapper = getWaClientWrapper(req.user);
    const client = waWrapper.client;
    const clientReady = waWrapper.status === 'connected';

    if (channels.whatsapp && !clientReady) {
        log(`[API send-documents] AVISO: Tentativa de envio via WhatsApp, mas cliente não está conectado.`);
    }

    let successCount = 0;
    let errors = [];
    let sentIds = [];

    const docsByCompany = documents.reduce((acc, doc) => {
        if (!acc[doc.companyId]) acc[doc.companyId] = [];
        acc[doc.companyId].push(doc);
        return acc;
    }, {});

    const companyIds = Object.keys(docsByCompany);

    for (const companyId of companyIds) {
        const companyDocs = docsByCompany[companyId];
        
        try {
            const company = await new Promise((resolve, reject) => {
                db.get("SELECT * FROM companies WHERE id = ?", [companyId], (err, row) => {
                    if (err) reject(err); else resolve(row);
                });
            });

            if (!company) { errors.push(`Empresa ID ${companyId} não encontrada.`); continue; }

            const sortedDocs = [...companyDocs].sort((a, b) => {
                const dateA = a.dueDate ? a.dueDate.split('/').reverse().join('') : '99999999';
                const dateB = b.dueDate ? b.dueDate.split('/').reverse().join('') : '99999999';
                return dateA.localeCompare(dateB);
            });

            const validAttachments = [];
            for (const doc of sortedDocs) {
                if (doc.serverFilename) {
                    const filePath = path.join(UPLOADS_DIR, doc.serverFilename);
                    if (fs.existsSync(filePath)) {
                        validAttachments.push({
                            filename: doc.docName,
                            path: filePath,
                            contentType: 'application/pdf',
                            docData: doc
                        });
                    } else {
                        log(`[API send-documents] Arquivo físico não encontrado: ${filePath}`);
                        errors.push(`Arquivo sumiu do servidor: ${doc.docName}`);
                    }
                }
            }

            if (channels.email && company.email) {
                try {
                    const finalHtml = buildEmailHtml(messageBody, companyDocs, emailSignature);
                    const finalSubject = `${subject} - Competência: ${companyDocs[0].competence || 'N/A'}`; 
                    
                    const emailList = company.email.split(',').map(e => e.trim()).filter(e => e);
                    const mainEmail = emailList[0];
                    const ccEmails = emailList.slice(1).join(', ');

                    if (mainEmail) {
                        const senderName = process.env.EMAIL_FROM_NAME || 'Contabilidade';
                        const senderEmail = process.env.EMAIL_FROM_EMAIL || process.env.EMAIL_USER;
                        const fromAddress = `"${senderName}" <${senderEmail}>`;

                        const mailOptions = {
                            from: fromAddress,
                            to: mainEmail,
                            cc: ccEmails, 
                            subject: finalSubject,
                            html: finalHtml,
                            attachments: validAttachments.map(a => ({ filename: a.filename, path: a.path, contentType: a.contentType }))
                        };
                        await emailTransporter.sendMail(mailOptions);
                        await saveToImapSentFolder(mailOptions).catch(err => 
                            log('[Email] Falha ao salvar no IMAP', err)
                        );
                        log(`[Email] Enviado para ${company.name} (${mainEmail})`);
                    }
                } catch (e) { 
                    log(`[Email] Erro envio ${company.name}`, e);
                    errors.push(`Erro Email ${company.name}: ${e.message}`); 
                }
            }

            if (channels.whatsapp && company.whatsapp && clientReady) {
                try {
                    let number = company.whatsapp.replace(/\D/g, '');
                    if (!number.startsWith('55')) number = '55' + number;
                    const chatId = `${number}@c.us`;

                    const listaArquivos = validAttachments.map(att => 
                        `• ${att.docData.docName} (${att.docData.category || 'Anexo'}, Venc: ${att.docData.dueDate || 'N/A'})`
                    ).join('\n');
                    
                    const whatsappSignature = whatsappTemplate || "_Esses arquivos também foram enviados por e-mail_\n\nAtenciosamente,\nContabilidade";
                    let mensagemCompleta = `*📄 Olá!* \n\n${messageBody}`;
                    
                    if (listaArquivos) {
                        mensagemCompleta += `\n\n*Arquivos enviados:*\n${listaArquivos}`;
                    }
                    
                    mensagemCompleta += `\n\n${whatsappSignature}`;

                    await safeSendMessage(client, chatId, mensagemCompleta);
                    
                    for (const att of validAttachments) {
                        try {
                            const fileData = fs.readFileSync(att.path).toString('base64');
                            const media = new MessageMedia(att.contentType, fileData, att.filename);
                            
                            await safeSendMessage(client, chatId, media);
                            
                            await new Promise(r => setTimeout(r, 3000));
                        } catch (mediaErr) {
                            log(`[WhatsApp] Erro envio mídia ${att.filename}`, mediaErr);
                            errors.push(`Erro mídia WhatsApp (${att.filename}): ${mediaErr.message}`);
                        }
                    }
                } catch (e) { 
                    log(`[WhatsApp] Erro envio ${company.name}`, e);
                    errors.push(`Erro Zap ${company.name}: ${e.message}`); 
                }
            } else if (channels.whatsapp && !clientReady) {
                 errors.push(`WhatsApp não conectado. Não foi possível enviar para ${company.name}`);
            }

            for (const doc of companyDocs) {
                if (doc.category) { 
                    db.run(`INSERT INTO sent_logs (companyName, docName, category, sentAt, channels, status) VALUES (?, ?, ?, datetime('now', 'localtime'), ?, 'success')`, 
                        [company.name, doc.docName, doc.category, JSON.stringify(channels)]);
                    
                    db.run(`INSERT INTO document_status (companyId, category, competence, status) VALUES (?, ?, ?, 'sent') ON CONFLICT(companyId, category, competence) DO UPDATE SET status='sent'`, 
                        [doc.companyId, doc.category, doc.competence]);
                }
                
                if (doc.serverFilename) {
                    try {
                        const filePath = path.join(UPLOADS_DIR, doc.serverFilename);
                        if (fs.existsSync(filePath)) {
                            const stat = fs.statSync(filePath);
                            db.run(`INSERT INTO file_gallery (serverFilename, originalName, mimeType, size, contact, channel, direction, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                [doc.serverFilename, doc.docName, 'application/pdf', stat.size, company.name, channels.whatsapp ? (channels.email ? 'Email/WhatsApp' : 'WhatsApp') : 'Email', 'sent', new Date().toISOString()]);
                        }
                    } catch (e) {}
                }

                if (doc.id) sentIds.push(doc.id);
                successCount++;
            }
        } catch (e) { 
            log(`[API send-documents] Falha geral empresa ${companyId}`, e);
            errors.push(`Falha geral empresa ${companyId}: ${e.message}`); 
        }
    }
    
    res.json({ success: true, sent: successCount, sentIds, errors });
});

app.get('/api/recent-sends', (req, res) => {
    getDb(req.user).all("SELECT * FROM sent_logs ORDER BY id DESC LIMIT 3", (err, rows) => res.json(rows || []));
});

app.get('/api/file-gallery', authenticateToken, (req, res) => {
    getDb(req.user).all("SELECT * FROM file_gallery ORDER BY timestamp DESC", (err, rows) => {
        if(err) return res.status(500).json({error: err.message});
        res.json(rows || []);
    });
});

app.delete('/api/file-gallery/:id', authenticateToken, (req, res) => {
    const db = getDb(req.user);
    db.get("SELECT serverFilename FROM file_gallery WHERE id = ?", [req.params.id], (err, row) => {
        if (row && row.serverFilename) {
            try {
                fs.unlinkSync(path.join(UPLOADS_DIR, row.serverFilename));
            } catch(e) {}
        }
        db.run("DELETE FROM file_gallery WHERE id = ?", [req.params.id], (err) => {
            if(err) return res.status(500).json({error: err.message});
            res.json({success: true});
        });
    });
});

app.get('/api/file-gallery/download/:id', authenticateToken, (req, res) => {
    const db = getDb(req.user);
    db.get("SELECT serverFilename, originalName, mimeType FROM file_gallery WHERE id = ?", [req.params.id], (err, row) => {
        if (!row || !row.serverFilename) return res.status(404).send('Not found');
        const file = path.join(UPLOADS_DIR, row.serverFilename);
        if(!fs.existsSync(file)) return res.status(404).send('File not found on disk');
        res.download(file, row.originalName);
    });
});

// ============================================================
// SEÇÃO 7 — NOVA ROTA: GET /api/file-gallery/view/:id
// ============================================================
app.get('/api/file-gallery/view/:id', authenticateToken, (req, res) => {
    const db = getDb(req.user);
    db.get(`SELECT serverFilename, originalName, mimeType FROM file_gallery WHERE id = ?`, [req.params.id], (err, row) => {
        if (err || !row || !row.serverFilename) return res.status(404).send('Not found');

        const filePath = path.join(UPLOADS_DIR, row.serverFilename);
        if (!fs.existsSync(filePath)) return res.status(404).send('File not found on disk');

        res.setHeader('Content-Type', row.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.originalName)}"`);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        fs.createReadStream(filePath).pipe(res);
    });
});

// --- Rota Catch-All para servir o React corretamente ---
app.get(/.*/, (req, res) => {
    if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- CRON JOB ---
setInterval(() => {
    const envUsers = (process.env.USERS || '').split(',');
    envUsers.forEach(user => {
        const db = getDb(user);
        if (!db) return;

        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const brazilTime = new Date(utc - (3600000 * 3)); 
        const nowStr = brazilTime.toISOString().slice(0, 16); 

        db.all("SELECT * FROM scheduled_messages WHERE active = 1 AND nextRun <= ?", [nowStr], async (err, rows) => {
            if (err || !rows || rows.length === 0) return;

            log(`[CRON ${user}] Executando ${rows.length} tarefas. Hora: ${nowStr}`);
            
            const waWrapper = getWaClientWrapper(user);
            const clientReady = waWrapper.status === 'connected';

            const settings = await new Promise(resolve => {
                db.get("SELECT settings FROM user_settings WHERE id = 1", (e, r) => resolve(r ? JSON.parse(r.settings) : null));
            });

            for (const msg of rows) {
                try {
                    if (msg.targetType === 'personal') {
                        if (clientReady) {
                            // Use configured number, or fallback to 557591167094
                            const FALLBACK_REMINDER_NUMBER = '557591167094';
                            const FALLBACK_REMINDER_LID = '105403295727623@lid';
                            let chatId;
                            if (settings?.dailySummaryNumber) {
                                let number = settings.dailySummaryNumber.replace(/\D/g, '');
                                if (!number.startsWith('55')) number = '55' + number;
                                chatId = `${number}@c.us`;
                            } else {
                                chatId = FALLBACK_REMINDER_LID;
                            }
                            try {
                                await safeSendMessage(waWrapper.client, chatId, `⏰ *Lembrete:* ${msg.message}`);
                                log(`[CRON] Lembrete pessoal enviado para ${chatId}`);
                            } catch (lidErr) {
                                // If LID fails, try phone number
                                log(`[CRON] Falha com LID, tentando número: ${lidErr.message}`);
                                const fallbackPhone = `${FALLBACK_REMINDER_NUMBER}@c.us`;
                                await safeSendMessage(waWrapper.client, fallbackPhone, `⏰ *Lembrete:* ${msg.message}`);
                                log(`[CRON] Lembrete enviado via telefone para ${fallbackPhone}`);
                            }
                        } else {
                            log(`[CRON] WhatsApp não conectado, lembrete pendente: ${msg.message}`);
                        }
                    } 
                    else {
                        const channels = JSON.parse(msg.channels || '{}');
                        const selectedIds = JSON.parse(msg.selectedCompanyIds || '[]');
                        
                        let targetCompanies = [];
                        if (msg.targetType === 'selected' && selectedIds.length > 0) {
                            const placeholders = selectedIds.map(() => '?').join(',');
                            targetCompanies = await new Promise(resolve => db.all(`SELECT * FROM companies WHERE id IN (${placeholders})`, selectedIds, (e, r) => resolve(r || [])));
                        } else if (msg.targetType !== 'selected') {
                            const operator = msg.targetType === 'mei' ? '=' : '!=';
                            targetCompanies = await new Promise(resolve => db.all(`SELECT * FROM companies WHERE type ${operator} 'MEI'`, (e, r) => resolve(r || [])));
                        }
                        
                        let specificDocs = [];
                        if (msg.documentsPayload) {
                            try { specificDocs = JSON.parse(msg.documentsPayload); } catch(e) { log('[CRON] Erro parse docs payload', e); }
                        }

                        for (const company of targetCompanies) {
                            let attachmentsToSend = [];
                            let companySpecificDocs = [];

                            if (specificDocs.length > 0) {
                                companySpecificDocs = specificDocs.filter(d => d.companyId === company.id);
                                if (companySpecificDocs.length === 0) continue;
                                
                                for (const doc of companySpecificDocs) {
                                     if (doc.serverFilename) {
                                         const p = path.join(UPLOADS_DIR, doc.serverFilename);
                                         if (fs.existsSync(p)) {
                                             attachmentsToSend.push({ filename: doc.docName, path: p, contentType: 'application/pdf', docData: doc });
                                         }
                                     }
                                }
                            } else if (msg.attachmentFilename) {
                                const p = path.join(UPLOADS_DIR, msg.attachmentFilename);
                                if (fs.existsSync(p)) {
                                    attachmentsToSend.push({ filename: msg.attachmentOriginalName, path: p, contentType: 'application/pdf' });
                                }
                            }

                            if (channels.email && company.email) {
                               try {
                                    const htmlContent = specificDocs.length > 0 
                                    ? buildEmailHtml(msg.message, companySpecificDocs, settings?.emailSignature)
                                    : buildEmailHtml(msg.message, [], settings?.emailSignature);

                                    const emailList = company.email.split(',').map(e => e.trim()).filter(e => e);
                                    const mainEmail = emailList[0];
                                    const ccEmails = emailList.slice(1).join(', ');

                                    if (mainEmail) {
                                        const senderName = process.env.EMAIL_FROM_NAME || 'Contabilidade';
                                        const senderEmail = process.env.EMAIL_FROM_EMAIL || process.env.EMAIL_USER;
                                        const fromAddress = `"${senderName}" <${senderEmail}>`;

                                        const mailOptions = {
                                            from: fromAddress,
                                            to: mainEmail,
                                            cc: ccEmails,
                                            subject: msg.title,
                                            html: htmlContent,
                                            attachments: attachmentsToSend.map(a => ({ filename: a.filename, path: a.path, contentType: a.contentType }))
                                        };
                                        await emailTransporter.sendMail(mailOptions);
                                        await saveToImapSentFolder(mailOptions).catch(err => 
                                            log('[CRON] Falha ao salvar no IMAP', err)
                                        );
                                    }
                               } catch(e) { log(`[CRON] Erro email ${company.name}`, e); }
                            }

                            if (channels.whatsapp && company.whatsapp && clientReady) {
                                try {
                                    let number = company.whatsapp.replace(/\D/g, '');
                                    if (!number.startsWith('55')) number = '55' + number;
                                    const chatId = `${number}@c.us`;
                                    
                                    let waBody = `*${msg.title}*\n\n${msg.message}`;

                                    if (specificDocs.length > 0) {
                                        waBody = `*📄 Olá!* \n\n${msg.message}\n\n*Arquivos enviados:*`;
                                        const listaArquivos = attachmentsToSend.map(att => 
                                            `• ${att.docData?.docName || att.filename} (${att.docData?.category || 'Anexo'}, Venc: ${att.docData?.dueDate || 'N/A'})`
                                        ).join('\n');
                                        waBody += `\n${listaArquivos}`;
                                    } else if (attachmentsToSend.length > 0) {
                                        waBody += `\n\n*Arquivo enviado:* ${attachmentsToSend[0].filename}`;
                                    }
                                    
                                    waBody += `\n\n${settings?.whatsappTemplate || ''}`;

                                    await safeSendMessage(waWrapper.client, chatId, waBody);
                                    
                                    for (const att of attachmentsToSend) {
                                        try {
                                            const fileData = fs.readFileSync(att.path).toString('base64');
                                            const media = new MessageMedia(att.contentType, fileData, att.filename);
                                            await safeSendMessage(waWrapper.client, chatId, media);
                                            await new Promise(r => setTimeout(r, 3000));
                                        } catch (err) {
                                            log(`[CRON] Erro media zap ${att.filename}`, err);
                                        }
                                    }
                                } catch(e) { log(`[CRON] Erro zap ${company.name}`, e); }
                            }
                            
                            if (companySpecificDocs.length > 0) {
                                for (const doc of companySpecificDocs) {
                                    if (doc.category) {
                                        db.run(`INSERT INTO sent_logs (companyName, docName, category, sentAt, channels, status) VALUES (?, ?, ?, datetime('now', 'localtime'), ?, 'success')`, 
                                            [company.name, doc.docName, doc.category, JSON.stringify(channels)]);
                                        
                                        db.run(`INSERT INTO document_status (companyId, category, competence, status) VALUES (?, ?, ?, 'sent') ON CONFLICT(companyId, category, competence) DO UPDATE SET status='sent'`, 
                                            [doc.companyId, doc.category, doc.competence]);
                                    }
                                }
                            }
                        } 
                    }

                    if (msg.recurrence === 'unico') {
                        db.run("UPDATE scheduled_messages SET active = 0 WHERE id = ?", [msg.id]);
                    } else {
                        const nextDate = new Date(msg.nextRun);
                        if (msg.recurrence === 'diaria') nextDate.setDate(nextDate.getDate() + 1);
                        else if (msg.recurrence === 'semanal') nextDate.setDate(nextDate.getDate() + 7);
                        else if (msg.recurrence === 'mensal') nextDate.setMonth(nextDate.getMonth() + 1);
                        else if (msg.recurrence === 'trimestral') nextDate.setMonth(nextDate.getMonth() + 3);
                        else if (msg.recurrence === 'anual') nextDate.setFullYear(nextDate.getFullYear() + 1);
                        
                        const nextRunStr = nextDate.toISOString().slice(0, 16);
                        db.run("UPDATE scheduled_messages SET nextRun = ? WHERE id = ?", [nextRunStr, msg.id]);
                    }
                } catch(e) {
                    log(`[CRON] Erro crítico processando msg ID ${msg.id}`, e);
                }
            } 
        });
    });
}, 60000); 

app.listen(port, () => log(`Server running at http://localhost:${port}`));
