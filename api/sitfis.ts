// ─────────────────────────────────────────────────────────────────────────────
// sitfis.ts  –  Lógica de negócio: solicitar protocolo, emitir relatório e poll
// ─────────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import https from "https";
import {
  SerproConfig,
  SerproToken,
  IntegraPayload,
  SitfisResultado,
  StatusConsulta,
} from "./sitfis.types.js";
import { getSerproToken, decrypt } from "./auth.js";

// ── URLs por ambiente ─────────────────────────────────────────────────────────
const URLS = {
  trial: {
    apoiar:
      "https://gateway.apiserpro.serpro.gov.br/integra-contador-trial/v1/Apoiar",
    emitir:
      "https://gateway.apiserpro.serpro.gov.br/integra-contador-trial/v1/Emitir",
  },
  producao: {
    apoiar:
      "https://gateway.apiserpro.serpro.gov.br/integra-contador/v1/Apoiar",
    emitir:
      "https://gateway.apiserpro.serpro.gov.br/integra-contador/v1/Emitir",
  },
};

const MAX_TENTATIVAS = 10;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

// ── Constrói https.Agent com mTLS (apenas produção) ──────────────────────────
function buildAgent(config: SerproConfig): https.Agent | undefined {
  if (config.ambiente === "trial") return undefined;
  const certBuffer = fs.readFileSync(config.cert_path);
  const passphrase = decrypt(config.cert_senha_enc);
  return new https.Agent({ pfx: certBuffer, passphrase, rejectUnauthorized: true });
}

// ── Utilitário de fetch com mTLS opcional ────────────────────────────────────
async function serproFetch(
  url: string,
  token: SerproToken,
  body: object,
  agent?: https.Agent
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token.access_token}`,
  };
  // jwt_token é obrigatório apenas em produção
  if (token.jwt_token) {
    headers["jwt_token"] = token.jwt_token;
  }

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    // @ts-ignore
    ...(agent ? { agent } : {}),
  });
}

// ── Monta payload padrão ──────────────────────────────────────────────────────
function buildPayload(
  config: SerproConfig,
  cnpjCliente: string,
  idServico: string,
  dadosExtras: string = ""
): IntegraPayload {
  const contratante = {
    numero: config.cnpj_contratante,
    tipo: 2 as const,
  };
  const contribuinte = {
    numero: cnpjCliente.replace(/\D/g, ""),
    tipo: 2 as const, // assumir CNPJ; ajustar para CPF (tipo:1) se necessário
  };
  return {
    contratante,
    autorPedidoDados: contratante,
    contribuinte,
    pedidoDados: {
      idSistema: "SITFIS",
      idServico,
      versaoSistema: "2.0",
      dados: dadosExtras,
    },
  };
}

// ── Etapa 2: solicitar protocolo ──────────────────────────────────────────────
async function solicitarProtocolo(
  config: SerproConfig,
  token: SerproToken,
  cnpjCliente: string
): Promise<string> {
  const url = URLS[config.ambiente].apoiar;
  const payload = buildPayload(config, cnpjCliente, "SOLICITARPROTOCOLO91");
  const agent = buildAgent(config);

  const res = await serproFetch(url, token, payload, agent);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SERPRO Apoiar ${res.status}: ${text}`);
  }
  const data = await res.json() as { protocoloRelatorio?: string };
  if (!data.protocoloRelatorio) {
    throw new Error("SERPRO não retornou protocoloRelatorio.");
  }
  return data.protocoloRelatorio;
}

// ── Etapa 3: emitir relatório com poll ───────────────────────────────────────
async function emitirComPoll(
  config: SerproConfig,
  token: SerproToken,
  cnpjCliente: string,
  protocolo: string,
  onProgress: (tentativa: number) => void
): Promise<string> {
  const url = URLS[config.ambiente].emitir;
  const agent = buildAgent(config);
  const dadosExtras = JSON.stringify({ protocoloRelatorio: protocolo });
  const payload = buildPayload(
    config,
    cnpjCliente,
    "RELATORIOSITFIS92",
    dadosExtras
  );

  const deadline = Date.now() + TIMEOUT_MS;
  let tentativa = 0;

  while (tentativa < MAX_TENTATIVAS && Date.now() < deadline) {
    tentativa++;
    onProgress(tentativa);

    const res = await serproFetch(url, token, payload, agent);

    if (res.status === 200) {
      const data = await res.json() as { pdf?: string };
      if (data.pdf) return data.pdf; // base64 do PDF
      throw new Error("SERPRO retornou 200 mas sem campo pdf.");
    }

    if (res.status === 202) {
      const data = await res.json() as { tempoEspera?: number };
      const wait = data.tempoEspera ?? 5000;
      await sleep(wait);
      continue;
    }

    if (res.status === 204) {
      const retryAfter = res.headers.get("Retry-After");
      const wait = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
      await sleep(wait);
      continue;
    }

    // 4xx / 5xx
    const text = await res.text();
    throw new Error(`SERPRO Emitir ${res.status}: ${text}`);
  }

  throw new Error(
    "Timeout: a consulta excedeu o tempo limite de 5 minutos. Tente novamente."
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Salva PDF em disco e registra no banco ────────────────────────────────────
function savePdf(
  db: any,
  consultaId: number,
  pdfBase64: string,
  clienteId: number,
  storagePath: string
): string {
  const filename = `sitfis_${clienteId}_${Date.now()}.pdf`;
  const fullPath = path.join(storagePath, filename);
  fs.mkdirSync(storagePath, { recursive: true });
  fs.writeFileSync(fullPath, Buffer.from(pdfBase64, "base64"));

  db.prepare(
    `UPDATE sitfis_consultas
     SET status = 'CONCLUIDO', pdf_path = ?, concluido_at = datetime('now')
     WHERE id = ?`
  ).run(fullPath, consultaId);

  return fullPath;
}

// ── Ponto de entrada principal ────────────────────────────────────────────────
export async function executarSitfis(
  db: any,
  config: SerproConfig,
  clienteId: number,
  usuarioId: number,
  cnpjCliente: string
): Promise<SitfisResultado> {
  // Cria registro no histórico
  const insertResult = db
    .prepare(
      `INSERT INTO sitfis_consultas
       (cliente_id, usuario_id, status, tentativas, created_at)
       VALUES (?, ?, 'SOLICITADO', 0, datetime('now'))`
    )
    .run(clienteId, usuarioId);
  const consultaId: number = insertResult.lastInsertRowid as number;

  const log = (msg: string) => {
    db.prepare(
      `UPDATE sitfis_consultas SET tentativas = tentativas + 0 WHERE id = ?`
    ).run(consultaId); // mantém alive; log real vai ao console
    console.log(`[SitFis consulta=${consultaId}] ${msg}`);
  };

  try {
    // Etapa 1: token
    log("Obtendo token SERPRO...");
    const token = await getSerproToken(config);

    // Etapa 2: protocolo
    log("Solicitando protocolo de emissão...");
    const protocolo = await solicitarProtocolo(config, token, cnpjCliente);
    db.prepare(
      `UPDATE sitfis_consultas SET protocolo = ?, status = 'PROCESSANDO' WHERE id = ?`
    ).run(protocolo, consultaId);

    // Etapa 3: emissão com poll
    log("Emitindo relatório (com polling)...");
    const pdfBase64 = await emitirComPoll(
      config,
      token,
      cnpjCliente,
      protocolo,
      (tentativa) => {
        db.prepare(
          `UPDATE sitfis_consultas SET tentativas = ? WHERE id = ?`
        ).run(tentativa, consultaId);
        log(`Tentativa ${tentativa}...`);
      }
    );

    // Salva PDF
    const storagePath = process.env.DATA_PATH
      ? path.join(process.env.DATA_PATH, "sitfis_pdfs")
      : "data/sitfis_pdfs";
    savePdf(db, consultaId, pdfBase64, clienteId, storagePath);

    log("Concluído com sucesso.");
    return { status: "CONCLUIDO", pdfBase64, consultaId };
  } catch (err: any) {
    const msg: string = err.message ?? String(err);
    db.prepare(
      `UPDATE sitfis_consultas SET status = 'ERRO', erro_msg = ? WHERE id = ?`
    ).run(msg, consultaId);
    console.error(`[SitFis consulta=${consultaId}] ERRO: ${msg}`);

    // Classifica o erro para retorno amigável ao frontend
    if (msg.includes("401"))
      return {
        status: "ERRO",
        codigo: "AUTH",
        mensagem:
          "Erro de autenticação com SERPRO. Verifique as credenciais na aba de Configurações.",
        consultaId,
      };
    if (msg.includes("403"))
      return {
        status: "ERRO",
        codigo: "FORBIDDEN",
        mensagem: "Contribuinte não autorizado ou contrato SERPRO inativo.",
        consultaId,
      };
    if (msg.includes("Timeout") || msg.includes("tempo limite"))
      return {
        status: "ERRO",
        codigo: "TIMEOUT",
        mensagem:
          "A consulta excedeu o tempo limite. Tente novamente em alguns minutos.",
        consultaId,
      };
    if (msg.includes("cert") || msg.includes("pfx") || msg.includes("passphrase"))
      return {
        status: "ERRO",
        codigo: "CERT",
        mensagem:
          "Certificado digital inválido. Verifique o arquivo e a senha nas Configurações.",
        consultaId,
      };

    return {
      status: "ERRO",
      codigo: "DESCONHECIDO",
      mensagem: msg,
      consultaId,
    };
  }
}

// ── Busca histórico de consultas de um cliente ────────────────────────────────
export function getHistoricoConsultas(db: any, clienteId: number) {
  return db
    .prepare(
      `SELECT id, status, tentativas, created_at, concluido_at, erro_msg, pdf_path
       FROM sitfis_consultas
       WHERE cliente_id = ?
       ORDER BY id DESC
       LIMIT 10`
    )
    .all(clienteId);
}
