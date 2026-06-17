import express from 'express';

export default function pendenciesRouter(getDb, authenticateToken) {
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

    const MONTH_PATTERN = '(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)';
    const PERIOD_RE = new RegExp(`(\\d{4}\\s*[-–]\\s*${MONTH_PATTERN}(?:\\s+${MONTH_PATTERN})*)`, 'i');

    function normalizeExtractedPdfText(text) {
        if (!text) return '';

        let normalized = String(text)
            .replace(/\r\n?/g, '\n')
            .replace(/\u00a0/g, ' ');

        const meaningfulLines = normalized
            .split('\n')
            .filter(line => line.trim().length > 0).length;

        if (meaningfulLines <= 3 && /Pend[eê]ncia\s*[-–]/i.test(normalized)) {
            normalized = normalized
                .replace(/\s+_{5,}\s+/g, '\n')
                .replace(/\s+(Diagn[oó]stico Fiscal)/gi, '\n$1')
                .replace(/\s+(Pend[eê]ncia\s*[-–])/gi, '\n$1')
                .replace(/\s+(\(Per[ií]odo de Apura[cç][aã]o\))/gi, '\n$1')
                .replace(new RegExp(`\\s+(\\d{4}\\s*[-–]\\s*${MONTH_PATTERN}\\b)`, 'gi'), '\n$1')
                .replace(/\s+(\*[^*])/g, '\n$1')
                .replace(/\s+(\d{4}-\d{2}\s*[-–])/g, '\n$1')
                .replace(/\s+(Notifica[cç][aã]o de lan[cç]amento:)/gi, '\n$1')
                .replace(/\s+(50\.\d+\.\d+\.\d+-\d+)/g, '\n$1')
                .replace(/\s+(Situa[cç][aã]o:)/gi, '\n$1')
                .replace(/\s+(Final do Relat[oó]rio)/gi, '\n$1');
        }

        return normalized;
    }

    /**
     * Extrai todas as pendências de um Relatório de Situação Fiscal da Receita Federal.
     *
     * Estratégia genérica:
     *  1. Localiza TODOS os blocos que começam com "Pendência - <nome>" no texto.
     *  2. Para cada bloco, escolhe automaticamente um parser baseado no conteúdo:
     *     - Bloco com linhas de período (ex: "2025 - JAN SET NOV DEZ") → parser de omissão
     *     - Bloco com linhas de débito numérico (código receita + datas + valores) → parser de débito SIEF
     *     - Bloco com inscrições PGFN (ex: "50.4.XX...") → parser de inscrição SIDA
     *     - Qualquer outro bloco desconhecido → captura o conteúdo bruto como texto
     *
     * Assim o sistema funciona para qualquer tipo de pendência presente no relatório,
     * incluindo futuras variações, sem precisar conhecer o nome do bloco antecipadamente.
     *
     * @param {string} text - Texto extraído do PDF
     * @returns {string[]} Lista de strings descrevendo cada pendência encontrada
     */
    function extractPendencies(text) {
        const pendencies = [];

        // Divide o texto em linhas limpas
        const lines = normalizeExtractedPdfText(text)
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l.length > 0);

        // ── Localiza os índices de todos os blocos "Pendência - ..." ──────────
        // Também marca os "Diagnóstico Fiscal" como separadores de seção,
        // para não vazar conteúdo entre seções da Receita e da PGFN.
        const blockStarts = []; // { index, title }
        const sectionDividers = []; // índices de separadores

        for (let i = 0; i < lines.length; i++) {
            if (/^Pend[eê]ncia\s*[-–]/i.test(lines[i])) {
                // Extrai o nome limpo: remove asteriscos e underscores decorativos
                const title = lines[i]
                    .replace(/[_*]+/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                blockStarts.push({ index: i, title });
            }
            if (/Diagn[oó]stico Fiscal/i.test(lines[i])) {
                sectionDividers.push(i);
            }
        }

        if (blockStarts.length === 0) return pendencies;

        // ── Para cada bloco, delimita até o próximo bloco ou fim ──────────────
        for (let b = 0; b < blockStarts.length; b++) {
            const start = blockStarts[b].index + 1;
            const end = b + 1 < blockStarts.length
                ? blockStarts[b + 1].index
                : lines.length;

            const blockTitle = blockStarts[b].title;
            const blockLines = lines.slice(start, end).filter(l => {
                // Remove cabeçalhos de página, rodapés e separadores decorativos
                if (/Minist[eé]rio da Fazenda/i.test(l)) return false;
                if (/Secretaria Especial/i.test(l)) return false;
                if (/Procuradoria-Geral/i.test(l)) return false;
                if (/Informa[cç][oõ]es de Apoio/i.test(l)) return false;
                if (/P[aá]gina:\s*\d+/i.test(l)) return false;
                if (/^CNPJ:\s*[\d./-]/.test(l)) return false;
                if (/^_{5,}/.test(l)) return false;
                if (/Diagn[oó]stico Fiscal/i.test(l)) return false;
                if (/Final do Relat[oó]rio/i.test(l)) return false;
                if (/Por meio do Portal/i.test(l)) return false;
                if (/CNPJ do certificado/i.test(l)) return false;
                return true;
            });

            if (blockLines.length === 0) continue;

            // ── Escolhe o parser pelo conteúdo do bloco ─────────────────────
            const blockText = blockLines.join('\n');

            if (isOmissaoBlock(blockLines)) {
                parseOmissao(blockTitle, blockLines, pendencies);
            } else if (isDebitoBlock(blockLines)) {
                parseDebito(blockTitle, blockLines, pendencies);
            } else if (isInscricaoBlock(blockLines)) {
                parseInscricao(blockTitle, blockLines, pendencies);
            } else {
                // Parser genérico: captura o conteúdo bruto ignorando linhas de cabeçalho de tabela
                parseGenerico(blockTitle, blockLines, pendencies);
            }
        }

        return pendencies;
    }

    // ── Detecção de tipo de bloco ─────────────────────────────────────────────

    // Bloco de omissão: contém linhas de período "AAAA - MES MES MES"
    function isOmissaoBlock(lines) {
        return lines.some(l => PERIOD_RE.test(l));
    }

    // Bloco de débito SIEF: contém linhas com código de receita + data + valores monetários
    // Ex: "5440-01 - MAED - DCTFWEB   19/11/2024  10/01/2025  250,00  250,00  0,00  47,47  297,47  DEVEDOR"
    // Ex: "1082-01 - CP-SEGUR.  02/2025  20/03/2025  775,19  775,19  ..."
    function isDebitoBlock(lines) {
        return lines.some(l =>
            /^\d{4}-\d{2}\s*[-–]/.test(l) &&
            /\d{2}\/\d{4}|\d{2}\/\d{2}\/\d{4}/.test(l) &&
            /[\d.,]{4,}\s+[\d.,]{4,}/.test(l)
        );
    }

    // Bloco de inscrição PGFN: contém linhas com nº de inscrição "50.4.XX.XXXXXX-XX"
    function isInscricaoBlock(lines) {
        return lines.some(l => /^50\.\d+\.\d+\.\d+-\d+/.test(l));
    }

    // ── Parsers especializados ────────────────────────────────────────────────

    /**
     * Parser de Omissão (ex: DCTFWeb, DCTF, DIRPF, ECF, etc.)
     * Captura todas as linhas de período e gera uma única entrada descritiva.
     */
    function parseOmissao(title, lines, out) {
        const periodLines = lines
            .map(l => l.match(PERIOD_RE)?.[1]?.toUpperCase())
            .filter(Boolean);

        if (periodLines.length > 0) {
            out.push(`${title} — Períodos sem entrega: ${periodLines.join(' | ')}`);
        }
        // Captura notas explicativas (linhas começando com *)
        const notes = lines.filter(l => /^\*[^*]/.test(l));
        if (notes.length > 0) {
            out.push(`${title} — Observação: ${notes.join(' ')}`);
        }
    }

    /**
     * Parser de Débito SIEF (tabela de débitos com valores monetários).
     * Cada linha de débito vira uma pendência separada com todos os campos.
     *
     * Padrão real do documento (espaçamento variável):
     *   5440-01 - MAED - DCTFWEB   19/11/2024  10/01/2025  250,00  250,00  0,00  47,47  297,47  DEVEDOR
     *   1082-01 - CP-SEGUR.          02/2025   20/03/2025   775,19  775,19  155,03  132,09  1.062,31  DEVEDOR
     *   1082-21 - CP-SEGUR.            2025    19/12/2025   349,57  349,57  69,91   22,82   442,30    DEVEDOR
     */
    function parseDebito(title, lines, out) {
        // Regex flexível:
        // Grupo 1: código receita (ex: "5440-01 - MAED - DCTFWEB" ou "1082-01 - CP-SEGUR.")
        // Grupo 2: PA/Exerc (mm/aaaa, aaaa, ou data completa)
        // Grupo 3: data de vencimento dd/mm/aaaa
        // Grupos 4-8: valores numéricos (Vl.Original, Sdo.Devedor, Multa, Juros, Sdo.Dev.Cons.)
        // Grupo 9: situação (DEVEDOR...)
        const re = /^(\d{4}-\d{2}\s*[-–].+?)\s+(\d{2}\/\d{4}|\d{4}|\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+(\S+)/;

        for (const l of lines) {
            const m = l.match(re);
            if (m) {
                const [, receita, paExerc, dtVcto, vlOriginal, sdoDevedor, multa, juros, sdoDevCons, situacao] = m;
                out.push(
                    `${title} — Receita: ${receita.trim()} | PA/Exerc.: ${paExerc} | ` +
                    `Vencimento: ${dtVcto} | Valor Original: R$ ${vlOriginal} | ` +
                    `Saldo Devedor: R$ ${sdoDevedor} | Multa: R$ ${multa} | ` +
                    `Juros: R$ ${juros} | Saldo Consolidado: R$ ${sdoDevCons} | ` +
                    `Situação: ${situacao}`
                );
            }
        }
    }

    /**
     * Parser de Inscrição PGFN/SIDA.
     * Cada inscrição pode ocupar 2-3 linhas (nome da receita continua na linha seguinte,
     * e a situação fica numa terceira linha).
     *
     * Padrão real:
     *   50.4.23.112646-22   1507-SIMPLES       26/06/2023   12376.759.846/2023-75   DEVEDOR PRINCIPAL
     *                       NACIONAL
     *             Situação: ATIVA AJUIZADA
     */
    function parseInscricao(title, lines, out) {
        let i = 0;
        while (i < lines.length) {
            if (!/^50\.\d+\.\d+\.\d+-\d+/.test(lines[i])) {
                i++;
                continue;
            }

            const recordLines = [lines[i]];
            let j = i + 1;

            while (j < lines.length && !/^50\.\d+\.\d+\.\d+-\d+/.test(lines[j])) {
                recordLines.push(lines[j]);
                j++;

                if (/Situa[cç][aã]o:/i.test(recordLines[recordLines.length - 1])) {
                    break;
                }
            }

            const recordText = recordLines.join(' ').replace(/\s+/g, ' ').trim();
            const situacaoMatch = recordText.match(/\bSitua[cç][aã]o:\s*(.+)$/i);
            const situacao = situacaoMatch ? situacaoMatch[1].trim() : '';
            const dataText = recordText.replace(/\s+Situa[cç][aã]o:\s*.+$/i, '').trim();
            const m = dataText.match(/^(50\.\d+\.\d+\.\d+-\d+)\s+(.+?)\s+(\d{2}\/\d{2}\/\d{4})\s+(?:(\d{2}\/\d{2}\/\d{4})\s+)?([\d.\/\-]+)\s+(DEVEDOR\s+\S+)(?:\s+(.+))?$/i);

            if (m) {
                const [, inscricao, receitaInicio, inscritoEm, ajuizadoEm, processo, tipoDevedor, receitaFinal] = m;
                const receita = [receitaInicio, receitaFinal].filter(Boolean).join(' ').trim();

                out.push(
                    `${title} — Nº Inscrição: ${inscricao} | Receita: ${receita} | ` +
                    `Inscrito em: ${inscritoEm}` +
                    `${ajuizadoEm ? ` | Ajuizado em: ${ajuizadoEm}` : ''} | ` +
                    `Processo: ${processo} | Tipo: ${tipoDevedor}` +
                    `${situacao ? ` | Situação: ${situacao}` : ''}`
                );
            }

            i = j;
        }
    }

    /**
     * Parser genérico para blocos desconhecidos.
     * Ignora linhas de cabeçalho de tabela e captura o conteúdo útil como texto.
     */
    function parseGenerico(title, lines, out) {
        // Ignora linhas que parecem ser cabeçalho de tabela (só letras maiúsculas e espaços)
        const contentLines = lines.filter(l =>
            !/^[A-ZÁÉÍÓÚ\s\/\.]+$/.test(l) &&
            l.length > 5
        );
        if (contentLines.length > 0) {
            out.push(`${title} — ${contentLines.join(' | ')}`);
        }
    }

    // ── Rotas ─────────────────────────────────────────────────────────────────

    router.get('/', authenticateToken, (req, res) => {
        const db = getDb(req.user);
        if (!db) return res.status(500).json({ error: 'Database error' });
        ensureTable(db);
        try {
            const rows = db.prepare(`
                SELECT c.id, c.name, c.docNumber, p.pendenciesList, p.lastUpdate 
                FROM companies c
                LEFT JOIN pendencies p ON c.id = p.companyId
                ORDER BY c.name ASC
            `).all();

            const formatted = rows.map(r => {
                let list = [];
                if (r.pendenciesList) {
                    try { list = JSON.parse(r.pendenciesList); } catch (e) {}
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

    router.post('/extract', authenticateToken, async (req, res) => {
        const db = getDb(req.user);
        if (!db) return res.status(500).json({ error: 'Database error' });
        ensureTable(db);

        const { companyId, pdfText } = req.body;
        if (!companyId || !pdfText) {
            return res.status(400).json({ error: 'Faltam dados de empresa ou texto' });
        }

        try {
            const extractedList = extractPendencies(pdfText);
            const now = new Date().toISOString();

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
            console.error("Erro ao extrair pendências", err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
