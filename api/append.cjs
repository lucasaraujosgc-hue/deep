const fs = require('fs');

const appendText = `
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
    const basicAuth = Buffer.from(\`\${config.consumer_key}:\${consumerSecret}\`).toString('base64');
    
    const response = await makeSerproRequest(
        'https://autenticacao.sapi.serpro.gov.br/authenticate',
        {
            method: 'POST',
            headers: {
                'Authorization': \`Basic \${basicAuth}\`,
                'role-type': 'TERCEIROS',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        },
        pfxBuffer,
        pass
    );
    
    if (response.status !== 200) {
        throw new Error(\`Erro Auth Serpro: \${response.status} - \${response.data}\`);
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
        const cnpjClean = company.docNumber.replace(/\\D/g, '');

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

                const cnpjEscritorioClean = String(config.cnpj_contratante).replace(/\\D/g, '');
                
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
                    'Authorization': \`Bearer \${tokens.access_token}\`,
                    'Content-Type': 'application/json'
                };
                if (isProd && tokens.jwt_token) headersApoiar['jwt_token'] = tokens.jwt_token;

                const resApoiar = await makeSerproRequest(\`\${baseUrl}/Apoiar\`, {
                    method: 'POST',
                    headers: headersApoiar,
                    body: JSON.stringify(payloadApoiar)
                });

                if (resApoiar.status !== 200) {
                    throw new Error(\`Erro Apoiar: \${resApoiar.status} - \${resApoiar.data}\`);
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
                        dados: \`{ "protocoloRelatorio": "\${protocoloStr}" }\`
                    }
                };

                let reportReady = false;
                let pdfBase64 = null;
                let maxTries = 10;
                let tries = 0;

                while(!reportReady && tries < maxTries) {
                    tries++;
                    db.prepare('UPDATE sitfis_consultas SET tentativas = ? WHERE id = ?').run(tries, consultaId);
                    
                    const resEmitir = await makeSerproRequest(\`\${baseUrl}/Emitir\`, {
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
                        throw new Error(\`Erro Emitir: \${resEmitir.status} - \${resEmitir.data}\`);
                    }
                }

                if (!reportReady) {
                    throw new Error("Timeout ao consultar SERPRO (limite exaurido).");
                }

                const uploadsDir = process.env.DATA_PATH ? path.join(process.env.DATA_PATH, 'uploads') : 'data/uploads';
                if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
                const pdfName = \`sitfis_\${cnpjClean}_\${Date.now()}.pdf\`;
                const pdfPath = path.join(uploadsDir, pdfName);
                
                const cleanBase64 = (typeof pdfBase64 === 'string' && pdfBase64.startsWith('{')) ? JSON.parse(pdfBase64).pdf : String(pdfBase64).replace(/['"]+/g, '');
                fs.writeFileSync(pdfPath, cleanBase64, { encoding: 'base64' });

                db.prepare('UPDATE sitfis_consultas SET status = ?, pdf_path = ?, concluido_at = ? WHERE id = ?')
                  .run('CONCLUIDO', pdfName, new Date().toISOString(), consultaId);

                let extracted = fastParsePdfForNegativeCert(pdfPath);
                if (!extracted) extracted = await analyzePdfWithAI(pdfPath);
                
                if (extracted && extracted.companyName) {
                    db.prepare(\`
                        INSERT INTO company_pendencies 
                        (companyId, docNumber, companyName, filename, extractedData, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                    \`).run(companyId, company.docNumber, company.name, pdfName, JSON.stringify(extracted.pendencies || []), new Date().toISOString());
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
`;

let content = fs.readFileSync('./api/pendencies.js', 'utf8');
content = content.replace('export default router;', appendText + '\n\nexport default router;');
fs.writeFileSync('./api/pendencies.js', content, 'utf8');
