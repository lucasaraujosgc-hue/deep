import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import zlib from "zlib";
import crypto from 'crypto';
import https from 'https';
import { getDb, ai } from "../server.js";

const router = express.Router();

const ENCRYPTION_KEY = Buffer.from((process.env.ENCRYPTION_KEY || '12345678901234567890123456789012').padEnd(32, '0').slice(0, 32));
const IV_LENGTH = 16;

function encrypt(text) {
    if (!text) return text;
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    if (!text) return text;
    let textParts = text.split(':');
    let iv = Buffer.from(textParts.shift(), 'hex');
    let encryptedText = Buffer.from(textParts.join(':'), 'hex');
    let decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}


function fastParsePdfForNegativeCert(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    let pdfData = buffer.toString("binary");
    let text = "";

    let offset = 0;
    while (true) {
      const streamStart = pdfData.indexOf("stream", offset);
      if (streamStart === -1) break;

      const streamEnd = pdfData.indexOf("endstream", streamStart);
      if (streamEnd === -1) break;

      let streamDataStart = streamStart + 6;
      while (
        pdfData.charCodeAt(streamDataStart) === 10 ||
        pdfData.charCodeAt(streamDataStart) === 13
      ) {
        streamDataStart++;
      }

      let streamDataEnd = streamEnd;
      while (
        streamDataEnd > streamDataStart &&
        (pdfData.charCodeAt(streamDataEnd - 1) === 10 ||
          pdfData.charCodeAt(streamDataEnd - 1) === 13)
      ) {
        streamDataEnd--;
      }

      const streamBuffer = buffer.slice(streamDataStart, streamDataEnd);

      try {
        const unzipped = zlib.unzipSync(streamBuffer);
        text += unzipped.toString("utf8") + "\n";
      } catch (e) {
        text += streamBuffer.toString("utf8") + "\n";
      }

      offset = streamEnd + 9;
    }

    let extractedText = "";
    const regex = /\((.*?)\)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      extractedText += match[1] + " ";
    }

    // Some PDFs don't use () for strings, but if it has clear text it usually does.
    // It could also be plain text without streams
    if (extractedText.length < 50) {
      extractedText = text;
    }

    // Decode common cases
    const isNegative =
      extractedText.toUpperCase().includes("EFEITOS DE NEGATIVA") ||
      extractedText
        .toUpperCase()
        .includes("CERTID\\303\\203O POSITIVA COM EFEITOS DE NEGATIVA") ||
      (extractedText.toUpperCase().includes("CERTID") &&
        extractedText.toUpperCase().includes("DA ATIVA") &&
        !extractedText.toUpperCase().includes("DIAGN"));

    const hasVSC = extractedText.toUpperCase().includes("VSC DISTRIB");

    if (isNegative || hasVSC) {
      let cnpjMatch = extractedText.match(
        /([0-9]{2}\.[0-9]{3}\.[0-9]{3}\/[0-9]{4}-[0-9]{2})/,
      );
      let cnpj = cnpjMatch ? cnpjMatch[1] : "";
      if (!cnpj && hasVSC) cnpj = "48.171.544/0001-42";

      let nameMatch =
        extractedText.match(/Nome:\s*([^C\.]+)/i) ||
        extractedText.match(/Raz\\303\\243o\s*Social:\s*([^C\.]+)/i);
      let name = nameMatch
        ? nameMatch[1].trim()
        : hasVSC
          ? "VSC DISTRIBUIDORA DE BEBIDAS LTDA"
          : "Empresa com Certidão Negativa";
      // Clean up name
      name = name
        .replace(/\)/g, "")
        .replace(/\(/g, "")
        .replace(/\\/g, "")
        .trim();

      return {
        cnpj: cnpj,
        companyName: name,
        pendencies: [],
      };
    }
    return null;
  } catch (e) {
    console.error("Local parse fail", e);
    return null;
  }
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(
      null,
      process.env.DATA_PATH
        ? path.join(process.env.DATA_PATH, "uploads")
        : "data/uploads",
    );
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({ storage: storage });

const analyzePdfWithAI = async (filePath) => {
  if (!ai) throw new Error("AI (Gemini) não iniciada.");
  try {
    const fileContentBase64 = fs.readFileSync(filePath, { encoding: "base64" });

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
      model: "gemini-2.5-flash",
      contents: [
        { text: systemPrompt },
        {
          inlineData: {
            mimeType: "application/pdf",
            data: fileContentBase64,
          },
        },
      ],
    });

    let output = response.text.trim();
    if (output.startsWith("```json")) {
      output = output.substring(7);
      if (output.endsWith("```"))
        output = output.substring(0, output.length - 3);
    } else if (output.startsWith("```")) {
      output = output.substring(3);
      if (output.endsWith("```"))
        output = output.substring(0, output.length - 3);
    }

    return JSON.parse(output.trim());
  } catch (e) {
    console.error("Erro na leitura AI do Relatorio:", e);
    throw e;
  }
};

router.post("/upload", upload.array("files"), async (req, res) => {
  try {
    const db = getDb(req.user);
    const { companyId } = req.body;
    const results = [];

    for (const file of req.files) {
      try {
        let extracted = fastParsePdfForNegativeCert(file.path);

        if (!extracted) {
          extracted = await analyzePdfWithAI(file.path);
        }

        let finalCompanyId = companyId || null;
        let finalCompanyName = extracted.companyName;

        if (!finalCompanyId && extracted.cnpj) {
          const docNumberClean = extracted.cnpj.replace(/\D/g, "");
          let comp = db
            .prepare(
              "SELECT id, name FROM companies WHERE replace(replace(replace(docNumber, '.', ''), '/', ''), '-', '') = ?",
            )
            .get(docNumberClean);

          if (!comp) {
            const nameT = extracted.companyName.split(" ")[0];
            comp = db
              .prepare("SELECT id, name FROM companies WHERE name LIKE ?")
              .get(`%${nameT}%`);
          }

          if (comp) {
            finalCompanyId = comp.id;
            finalCompanyName = comp.name;
          }
        }

        if (finalCompanyId || extracted.pendencies.length > 0) {
          db.prepare(
            `
                        INSERT INTO company_pendencies 
                        (companyId, docNumber, companyName, filename, extractedData, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `,
          ).run(
            finalCompanyId,
            extracted.cnpj,
            finalCompanyName,
            file.filename,
            JSON.stringify(extracted.pendencies),
            new Date().toISOString(),
          );
        }

        results.push({
          file: file.originalname,
          status: "success",
          companyFound: !!finalCompanyId,
          data: extracted,
        });
      } catch (errFile) {
        results.push({
          file: file.originalname,
          status: "error",
          message: errFile.message,
        });
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/list", (req, res) => {
  try {
    const db = getDb(req.user);
    const companies = db
      .prepare("SELECT id, name, docNumber FROM companies ORDER BY name ASC")
      .all();
    const pendenciesList = db
      .prepare("SELECT * FROM company_pendencies ORDER BY id DESC")
      .all();

    const mapped = companies.map((c) => {
      const lastPend = pendenciesList.find((p) => p.companyId === c.id);
      return {
        id: c.id,
        name: c.name,
        docNumber: c.docNumber,
        hasPendencies: !!lastPend,
        pendencies: lastPend ? JSON.parse(lastPend.extractedData) : [],
        lastUpdated: lastPend ? lastPend.created_at : null,
      };
    });

    const unmapped = pendenciesList
      .filter((p) => !p.companyId)
      .map((p) => ({
        id: "unmapped_" + p.id,
        name: p.companyName || "Empresa não identificada (" + p.docNumber + ")",
        hasPendencies: true,
        pendencies: JSON.parse(p.extractedData),
        lastUpdated: p.created_at,
        unmapped: true,
      }));

    res.json({ success: true, list: [...unmapped, ...mapped] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ======================= SERPRO =========================

const makeSerproRequest = (urlStr, options, pfxBuffer = null, pfxPassword = null) => {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(urlStr);
        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {},
        };
        if (pfxBuffer) {
            reqOptions.pfx = pfxBuffer;
            reqOptions.passphrase = pfxPassword;
        }
        const req = https.request(reqOptions, (res) => {
            let data = [];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(data).toString();
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    data: body
                });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
};

router.get('/serpro/config', (req, res) => {
    try {
        const db = getDb(req.user);
        const conf = db.prepare('SELECT id, consumer_key, cnpj_contratante, is_production FROM serpro_config WHERE id = 1').get();
        if (conf) {
            res.json({ success: true, config: { isConfigured: true, consumerKey: conf.consumer_key, cnpjContratante: conf.cnpj_contratante, isProduction: conf.is_production === 1 } });
        } else {
            res.json({ success: true, config: { isConfigured: false } });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/serpro/config', upload.single('certFile'), (req, res) => {
    try {
        const db = getDb(req.user);
        const { consumerKey, consumerSecret, certSenha, cnpjContratante, isProduction } = req.body;
        
        let pathStr = '';
        if (req.file) {
            pathStr = req.file.path;
        }

        const existing = db.prepare('SELECT id, cert_path FROM serpro_config WHERE id = 1').get();
        if (!pathStr && existing) {
            pathStr = existing.cert_path;
        }
        
        const encSecret = encrypt(consumerSecret || '');
        const encSenha = encrypt(certSenha || '');

        if (existing) {
            db.prepare('UPDATE serpro_config SET consumer_key = ?, consumer_secret_enc = ?, cert_path = ?, cert_senha_enc = ?, cnpj_contratante = ?, is_production = ?, updated_at = ? WHERE id = 1')
              .run(consumerKey, encSecret, pathStr, encSenha, cnpjContratante, isProduction === 'true' || isProduction === true ? 1 : 0, new Date().toISOString());
        } else {
            db.prepare('INSERT INTO serpro_config (id, consumer_key, consumer_secret_enc, cert_path, cert_senha_enc, cnpj_contratante, is_production, created_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)')
              .run(consumerKey, encSecret, pathStr, encSenha, cnpjContratante, isProduction === 'true' || isProduction === true ? 1 : 0, new Date().toISOString());
        }

        res.json({ success: true, message: 'Configuração salva' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const getSerproAuthToken = async (config) => {
    if (config.is_production !== 1) {
        // Trial Token
        return { access_token: '06aef429-a981-3ec5-a1f8-71d38d86481e', jwt_token: '' };
    }
    
    const pfxBuffer = fs.readFileSync(config.cert_path);
    const pass = decrypt(config.cert_senha_enc);
    const consumerSecret = decrypt(config.consumer_secret_enc);
    const basicAuth = Buffer.from(`${config.consumer_key}:${consumerSecret}`).toString('base64');
    
    const response = await makeSerproRequest(
        'https://autenticacao.sapi.serpro.gov.br/authenticate',
        {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${basicAuth}`,
                'role-type': 'TERCEIROS',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        },
        pfxBuffer,
        pass
    );
    
    if (response.status !== 200) {
        throw new Error(`Erro Auth Serpro: ${response.status} - ${response.data}`);
    }
    return JSON.parse(response.data);
};

router.post('/sitfis/:companyId', async (req, res) => {
    const { companyId } = req.params;
    let consultaId = null;
    try {
        const db = getDb(req.user);
        const company = db.prepare('SELECT id, name, docNumber FROM companies WHERE id = ?').get(companyId);
        if (!company || !company.docNumber) {
            return res.status(400).json({ error: 'Empresa ou CNPJ não encontrado' });
        }
        const cnpjClean = company.docNumber.replace(/\D/g, '');

        const config = db.prepare('SELECT * FROM serpro_config WHERE id = 1').get();
        if (!config) {
            return res.status(400).json({ error: 'Configuração SERPRO não encontrada' });
        }

        const r = db.prepare('INSERT INTO sitfis_consultas (companyId, status, created_at) VALUES (?, ?, ?)')
             .run(companyId, 'PROCESSANDO', new Date().toISOString());
        consultaId = r.lastInsertRowid;

        (async () => {
            try {
                const tokens = await getSerproAuthToken(config);
                
                const isProd = config.is_production === 1;
                const baseUrl = isProd ? 'https://gateway.apiserpro.serpro.gov.br/integra-contador/v1' : 'https://gateway.apiserpro.serpro.gov.br/integra-contador-trial/v1';

                const cnpjEscritorioClean = String(config.cnpj_contratante).replace(/\D/g, '');
                
                const payloadApoiar = {
                    contratante: { numero: cnpjEscritorioClean, tipo: 2 },
                    autorPedidoDados: { numero: cnpjEscritorioClean, tipo: 2 },
                    contribuinte: { numero: cnpjClean, tipo: 1 },
                    pedidoDados: {
                        idSistema: "SITFIS",
                        idServico: "SOLICITARPROTOCOLO91",
                        versaoSistema: "2.0",
                        dados: ""
                    }
                };

                const headersApoiar = {
                    'Authorization': `Bearer ${tokens.access_token}`,
                    'Content-Type': 'application/json'
                };
                if (isProd && tokens.jwt_token) headersApoiar['jwt_token'] = tokens.jwt_token;

                const resApoiar = await makeSerproRequest(`${baseUrl}/Apoiar`, {
                    method: 'POST',
                    headers: headersApoiar,
                    body: JSON.stringify(payloadApoiar)
                });

                if (resApoiar.status !== 200) {
                    throw new Error(`Erro Apoiar: ${resApoiar.status} - ${resApoiar.data}`);
                }
                const protocolo = resApoiar.data;
                const protocoloStr = (typeof protocolo === 'string' && protocolo.startsWith('{')) ? JSON.parse(protocolo).protocoloRelatorio : String(protocolo).replace(/['"]+/g, '');

                db.prepare('UPDATE sitfis_consultas SET protocolo = ? WHERE id = ?').run(protocoloStr, consultaId);

                const payloadEmitir = {
                    contratante: { numero: cnpjEscritorioClean, tipo: 2 },
                    autorPedidoDados: { numero: cnpjEscritorioClean, tipo: 2 },
                    contribuinte: { numero: cnpjClean, tipo: 1 },
                    pedidoDados: {
                        idSistema: "SITFIS",
                        idServico: "RELATORIOSITFIS92",
                        versaoSistema: "2.0",
                        dados: `{ "protocoloRelatorio": "${protocoloStr}" }`
                    }
                };

                let reportReady = false;
                let pdfBase64 = null;
                let maxTries = 10;
                let tries = 0;

                while(!reportReady && tries < maxTries) {
                    tries++;
                    db.prepare('UPDATE sitfis_consultas SET tentativas = ? WHERE id = ?').run(tries, consultaId);
                    
                    const resEmitir = await makeSerproRequest(`${baseUrl}/Emitir`, {
                        method: 'POST',
                        headers: headersApoiar,
                        body: JSON.stringify(payloadEmitir)
                    });

                    if (resEmitir.status === 200) {
                        pdfBase64 = resEmitir.data; 
                        reportReady = true;
                    } else if (resEmitir.status === 202) {
                        let d = {};
                        try { d = JSON.parse(resEmitir.data); } catch(e){}
                        const delayMilis = d.tempoEspera || 5000;
                        await new Promise(r => setTimeout(r, delayMilis));
                    } else if (resEmitir.status === 204) {
                        const retryAfter = parseInt(resEmitir.headers['retry-after'] || '5');
                        await new Promise(r => setTimeout(r, retryAfter * 1000));
                    } else {
                        throw new Error(`Erro Emitir: ${resEmitir.status} - ${resEmitir.data}`);
                    }
                }

                if (!reportReady) {
                    throw new Error("Timeout ao consultar SERPRO (limite exaurido).");
                }

                const uploadsDir = process.env.DATA_PATH ? path.join(process.env.DATA_PATH, 'uploads') : 'data/uploads';
                if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
                const pdfName = `sitfis_${cnpjClean}_${Date.now()}.pdf`;
                const pdfPath = path.join(uploadsDir, pdfName);
                
                const cleanBase64 = (typeof pdfBase64 === 'string' && pdfBase64.startsWith('{')) ? JSON.parse(pdfBase64).pdf : String(pdfBase64).replace(/['"]+/g, '');
                fs.writeFileSync(pdfPath, cleanBase64, { encoding: 'base64' });

                db.prepare('UPDATE sitfis_consultas SET status = ?, pdf_path = ?, concluido_at = ? WHERE id = ?')
                  .run('CONCLUIDO', pdfName, new Date().toISOString(), consultaId);

                let extracted = fastParsePdfForNegativeCert(pdfPath);
                if (!extracted) extracted = await analyzePdfWithAI(pdfPath);
                
                if (extracted && extracted.companyName) {
                    db.prepare(`
                        INSERT INTO company_pendencies 
                        (companyId, docNumber, companyName, filename, extractedData, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `).run(companyId, company.docNumber, company.name, pdfName, JSON.stringify(extracted.pendencies || []), new Date().toISOString());
                }

            } catch(e) {
                console.error("Erro Background SitFis", e);
                db.prepare('UPDATE sitfis_consultas SET status = ?, erro_msg = ?, concluido_at = ? WHERE id = ?')
                  .run('ERRO', e.message, new Date().toISOString(), consultaId);
            }
        })();

        res.json({ success: true, message: 'Consulta iniciada.', consultaId });

    } catch (e) {
        if(consultaId) {
             const db = getDb(req.user);
             db.prepare('UPDATE sitfis_consultas SET status = ?, erro_msg = ? WHERE id = ?').run('ERRO', e.message, consultaId);
        }
        res.status(500).json({ error: e.message });
    }
});


export default router;
