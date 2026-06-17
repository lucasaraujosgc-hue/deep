/**
 * documentProcessor.js — Backend (Node.js)
 *
 * Utilitários de identificação de empresa e normalização de texto.
 * Compatível com CommonJS e ES Modules (exporta via named exports).
 *
 * NÃO depende de pdfjs-dist nem de APIs de browser.
 * O texto do PDF já chega pré-extraído pelo frontend (via documentProcessor.ts).
 */

/**
 * Normaliza texto: remove acentos, converte para minúsculo e limpa espaços extras.
 * @param {string} text
 * @returns {string}
 */
export function removeAccents(text) {
    if (!text) return '';
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

/**
 * Verifica se uma palavra-chave existe no texto normalizado.
 * Para palavras curtas (<= 3 chars) exige limite de palavra (evita falsos positivos).
 * Ex: "das" não dá match em "vendas".
 *
 * @param {string} text       — Texto já normalizado (sem acentos, minúsculo)
 * @param {string} keyword    — Palavra-chave já normalizada
 * @returns {boolean}
 */
export function containsKeyword(text, keyword) {
    if (!keyword || keyword.length < 2) return false;

    if (keyword.length <= 3) {
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
        return regex.test(text);
    }

    return text.includes(keyword);
}

/**
 * Identifica a categoria do documento com base em um mapa de palavras-chave ponderadas.
 * Categorias com prioridade recebem bônus massivo de pontuação.
 *
 * @param {string}                    textNormalized     — Texto já normalizado
 * @param {Record<string, string[]>}  keywordMap         — { categoria: [keywords] }
 * @param {string[]}                  priorityCategories — Categorias com prioridade
 * @returns {string|null}
 */
export function identifyCategory(textNormalized, keywordMap = {}, priorityCategories = []) {
    if (!textNormalized || !keywordMap) return null;

    const scores = {};

    for (const [category, keywords] of Object.entries(keywordMap)) {
        if (!Array.isArray(keywords)) continue;

        let categoryScore = 0;

        for (const keyword of keywords) {
            if (!keyword) continue;
            const kwNormalized = removeAccents(keyword);

            if (containsKeyword(textNormalized, kwNormalized)) {
                // Palavras maiores são mais específicas → valem mais
                categoryScore += kwNormalized.length * 2;
            }
        }

        if (categoryScore > 0) {
            if (priorityCategories.includes(category)) {
                categoryScore += 1000; // bônus de prioridade
            }
            scores[category] = categoryScore;
        }
    }

    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    return sorted.length > 0 ? sorted[0][0] : null;
}

/**
 * Identifica a empresa no texto usando duas estratégias em cascata:
 *
 *  1. Match por documento (CNPJ/CPF) — alta precisão.
 *     Compara dígitos numéricos do texto com os da empresa.
 *     Aceita match nos 8 primeiros dígitos do CNPJ (raiz).
 *
 *  2. Match por nome — menor precisão, baseado em pontuação por tamanho.
 *     Remove termos comuns (ltda, s.a, eireli…) antes de comparar.
 *
 * @param {string}    textNormalized — Texto já normalizado (sem acentos, minúsculo)
 * @param {Array<{ id: number, name: string, docNumber: string }>} companies
 * @returns {{ id: number, name: string, docNumber: string }|null}
 */
export function identifyCompany(textNormalized, companies = []) {
    if (!textNormalized || !companies.length) return null;

    // ── Estratégia 1: por CNPJ/CPF ──────────────────────────────────────────
    const textOnlyNumbers = textNormalized.replace(/\D/g, '');

    for (const company of companies) {
        const docClean = (company.docNumber || '').replace(/\D/g, '');
        if (docClean.length < 5) continue;

        const matchFull = textOnlyNumbers.includes(docClean);
        const matchRoot = docClean.length >= 8 && textOnlyNumbers.includes(docClean.substring(0, 8));

        if (matchFull || matchRoot) return company;
    }

    // ── Estratégia 2: por nome ───────────────────────────────────────────────
    const COMMON_TERMS = ['ltda', 'sa', 's.a', 'me', 'epp', 'eireli', 'limitada', 'cnpj', 'cpf'];

    let bestMatch = null;
    let maxScore = 0;

    for (const company of companies) {
        let nameClean = removeAccents(company.name || '');

        for (const term of COMMON_TERMS) {
            nameClean = nameClean.replace(new RegExp(`\\b${term}\\b`, 'g'), '').trim();
        }

        if (nameClean.length < 3) continue;

        if (textNormalized.includes(nameClean)) {
            const score = nameClean.length;
            if (score > maxScore) {
                maxScore = score;
                bestMatch = company;
            }
        }
    }

    return bestMatch;
}
