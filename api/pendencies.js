import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDb, ai } from '../server.js';

const router = express.Router();

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, process.env.DATA_PATH ? path.join(process.env.DATA_PATH, 'uploads') : 'data/uploads')
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
        cb(null, file.fieldname + '-' + uniqueSuffix + '-' + file.originalname)
    }
});

const upload = multer({ storage: storage });

const analyzePdfWithAI = async (filePath) => {
    if (!ai) throw new Error("AI (Gemini) não iniciada.");
    try {
        const fileContentBase64 = fs.readFileSync(filePath, { encoding: 'base64' });
        
        const systemPrompt = `Você é um assistente super especializado em análise tributária brasileira.
Seu trabalho é extrair de um relatório da situação fiscal (Receita Federal, PGFN, SIEF, DCTFWeb, etc.) duas coisas principais:
1) O Nome ou Razão Social e CNPJ da empresa de quem o documento se refere.
2) Uma lista resumida e extremamente clara das pendências/débitos que estão marcados como "Devedor", "A ANALISAR", "Em Cobrança", "Exigibilidade Suspensa" ou "Omissão".
Retorne ESTRITAMENTE em formato JSON. Sem marcação markdown antes ou depois.
Formato JSON esperado:
{
  "cnpj": "XX.XXX.XXX/YYYY-ZZ",
  "companyName": "NOME DA EMPRESA LTDA",
  "pendencies": [
    { "type": "Débito Simples Nacional", "period": "10/2025", "value": "6.190,99" },
    { "type": "Omissão de DCTFWeb", "period": "2025 - JAN SET NOV DEZ", "value": "0,00" }
  ]
}
Se não houver débitos, pendencies deve ser [].`;
        
        const response = await ai.models.generateContent({
             model: 'gemini-2.5-flash',
             contents: [
                 { text: systemPrompt },
                 {
                     inlineData: {
                         mimeType: 'application/pdf',
                         data: fileContentBase64
                     }
                 }
             ],
        });

        let output = response.text.trim();
        if (output.startsWith('```json')) {
             output = output.substring(7);
             if (output.endsWith('```')) output = output.substring(0, output.length-3);
        } else if (output.startsWith('```')) {
             output = output.substring(3);
             if (output.endsWith('```')) output = output.substring(0, output.length-3);
        }

        return JSON.parse(output.trim());
    } catch(e) {
        console.error("Erro na leitura AI do Relatorio:", e);
        throw e;
    }
}

router.post('/upload', upload.array('files'), async (req, res) => {
    try {
        const db = getDb(req.user);
        const { companyId } = req.body; 
        const results = [];

        for (const file of req.files) {
            try {
                const extracted = await analyzePdfWithAI(file.path);
                
                let finalCompanyId = companyId || null;
                let finalCompanyName = extracted.companyName;

                if (!finalCompanyId && extracted.cnpj) {
                    const docNumberClean = extracted.cnpj.replace(/\D/g, '');
                    let comp = db.prepare("SELECT id, name FROM companies WHERE replace(replace(replace(docNumber, '.', ''), '/', ''), '-', '') = ?").get(docNumberClean);
                    
                    if (!comp) {
                        const nameT = extracted.companyName.split(' ')[0];
                        comp = db.prepare("SELECT id, name FROM companies WHERE name LIKE ?").get(`%${nameT}%`);
                    }

                    if (comp) {
                        finalCompanyId = comp.id;
                        finalCompanyName = comp.name;
                    }
                }

                if (finalCompanyId || extracted.pendencies.length > 0) {
                    db.prepare(`
                        INSERT INTO company_pendencies 
                        (companyId, docNumber, companyName, filename, extractedData, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `).run(
                        finalCompanyId, 
                        extracted.cnpj, 
                        finalCompanyName, 
                        file.filename,
                        JSON.stringify(extracted.pendencies),
                        new Date().toISOString()
                    );
                }

                results.push({
                    file: file.originalname,
                    status: 'success',
                    companyFound: !!finalCompanyId,
                    data: extracted
                });

            } catch (errFile) {
                results.push({
                    file: file.originalname,
                    status: 'error',
                    message: errFile.message
                });
            }
        }

        res.json({ success: true, results });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/list', (req, res) => {
    try {
        const db = getDb(req.user);
        const companies = db.prepare('SELECT id, name, docNumber FROM companies ORDER BY name ASC').all();
        const pendenciesList = db.prepare('SELECT * FROM company_pendencies ORDER BY id DESC').all();

        const mapped = companies.map(c => {
            const lastPend = pendenciesList.find(p => p.companyId === c.id);
            return {
                id: c.id,
                name: c.name,
                docNumber: c.docNumber,
                hasPendencies: !!lastPend,
                pendencies: lastPend ? JSON.parse(lastPend.extractedData) : [],
                lastUpdated: lastPend ? lastPend.created_at : null
            };
        });

        const unmapped = pendenciesList.filter(p => !p.companyId).map(p => ({
            id: 'unmapped_' + p.id,
            name: p.companyName || 'Empresa não identificada (' + p.docNumber + ')',
            hasPendencies: true,
            pendencies: JSON.parse(p.extractedData),
            lastUpdated: p.created_at,
            unmapped: true
        }));

        res.json({ success: true, list: [...unmapped, ...mapped] });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

export default router;
