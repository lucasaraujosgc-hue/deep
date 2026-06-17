import express from 'express';

export default function pendenciesRouter(getDb, authenticateToken, ai) {
    const router = express.Router();

    const ensureTable = (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS pendencies (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                companyId INTEGER UNIQUE, 
                pdfText TEXT, 
                pendenciesList TEXT, 
                status TEXT DEFAULT 'pending',
                lastUpdate TEXT
            );
        `);
    };

    // Obter empresas com pendências (todas empresas que têm pendenciesList salvo, ou podemos listar todas as empresas e fazer left join)
    router.get('/', authenticateToken, (req, res) => {
        const db = getDb(req.user);
        if (!db) return res.status(500).json({ error: 'Database error' });
        ensureTable(db);
        try {
            // Buscamos todas as empresas, e fazemos join com as pendências
            const rows = db.prepare(`
                SELECT c.id, c.name, c.docNumber, p.pendenciesList, p.lastUpdate 
                FROM companies c
                LEFT JOIN pendencies p ON c.id = p.companyId
                ORDER BY c.name ASC
            `).all();
            
            // Formatamos pendenciesList (está como string JSON) -> array
            const formatted = rows.map(r => {
                let list = [];
                if (r.pendenciesList) {
                    try { list = JSON.parse(r.pendenciesList); } catch(e) {}
                }
                return {
                    id: r.id,
                    name: r.name,
                    docNumber: r.docNumber,
                    pendencies: list,
                    lastUpdate: r.lastUpdate,
                    hasPendencies: list.length > 0
                };
            });
            res.json(formatted);
        } catch (err) {
            console.error("Erro ao carregar pendências", err);
            res.status(500).json({ error: err.message });
        }
    });

    // Rota que faz o RAG da extração de texto
    router.post('/extract', authenticateToken, async (req, res) => {
        const db = getDb(req.user);
        if (!db) return res.status(500).json({ error: 'Database error' });
        ensureTable(db);

        const { companyId, pdfText } = req.body;
        if (!companyId || !pdfText) {
            return res.status(400).json({ error: 'Faltam dados de empresa ou texto' });
        }

        try {
            let extractedList = [];

            if (ai) {
                // Passar para a IA estruturar
                const prompt = `
Você é um assistente de extração contábil. A seguir está o texto extraído de um Relatório de Pendências da Receita Federal.
Por favor, identifique e extraia a lista exata de "pendências" descritas no documento. 
Cuidado para não incluir textos genéricos. Retorne APENAS um JSON Array de strings contendo cada uma das pendências identificadas.
Se não houver nenhuma, retorne [].
Lembre-se: NÃO retorne formatação markdown, retorne a lista diretamente na estrutura JSON.

TEXTO DO RELATÓRIO:
${pdfText}
`;
                const result = await ai.models.generateContent({
                    model: 'gemini-3-flash-preview',
                    contents: prompt,
                    config: {
                        responseMimeType: "application/json"
                    }
                });
                
                try {
                    const txt = result.text.trim();
                    extractedList = JSON.parse(txt);
                    if (!Array.isArray(extractedList)) extractedList = [txt];
                } catch (e) {
                    // se falhar tenta fazer fall-back
                    extractedList = ["Não foi possível formatar as pendências. Análise bruta falhou."];
                }
            } else {
                extractedList = ["IA Indisponível - Salva apenas como registro."];
            }

            const now = new Date().toISOString();
            
            // Salvar no BD
            db.prepare(`
                INSERT INTO pendencies (companyId, pdfText, pendenciesList, status, lastUpdate)
                VALUES (?, ?, ?, 'pending', ?)
                ON CONFLICT(companyId) DO UPDATE SET
                pdfText = excluded.pdfText,
                pendenciesList = excluded.pendenciesList,
                lastUpdate = excluded.lastUpdate
            `).run(companyId, pdfText, JSON.stringify(extractedList), now);

            res.json({ success: true, pendencies: extractedList });
        } catch (err) {
            console.error("Erro ai extrair", err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
