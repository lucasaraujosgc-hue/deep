// ─────────────────────────────────────────────────────────────────────────────
// auth.ts  –  Autenticação OAuth2 + mTLS para SERPRO Integra Contador
// ─────────────────────────────────────────────────────────────────────────────
import fs from "fs";
import https from "https";
import crypto from "crypto";
import { SerproConfig, SerproToken, AmbienteSerpro } from "./sitfis.types.js";

// ── Constantes de URL ─────────────────────────────────────────────────────────
const AUTH_URL =
  "https://autenticacao.sapi.serpro.gov.br/authenticate";

// Token trial fixo (não requer mTLS nem OAuth no ambiente trial)
const TRIAL_FIXED_TOKEN = "06aef429-a981-3ec5-a1f8-71d38d86481e";

// ── Criptografia AES-256-CBC ──────────────────────────────────────────────────
const ENCRYPTION_KEY = process.env.SERPRO_ENCRYPTION_KEY || "";
// SERPRO_ENCRYPTION_KEY deve ser hex de 64 chars (32 bytes) definido no .env

function getEncryptionKey(): Buffer {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 64) {
    throw new Error(
      "SERPRO_ENCRYPTION_KEY não definida ou inválida no ambiente."
    );
  }
  return Buffer.from(ENCRYPTION_KEY, "hex");
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const [ivHex, encHex] = ciphertext.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(enc), decipher.final()]);
  return decrypted.toString("utf8");
}

// ── Cache de tokens em memória (por usuario_id) ───────────────────────────────
const tokenCache = new Map<number, SerproToken>();

function getCachedToken(usuarioId: number): SerproToken | null {
  const cached = tokenCache.get(usuarioId);
  if (!cached) return null;
  // Considera expirado se já passou do prazo (já tem margem de 30s embutida)
  if (Date.now() >= cached.expires_at) {
    tokenCache.delete(usuarioId);
    return null;
  }
  return cached;
}

function setCachedToken(usuarioId: number, token: SerproToken): void {
  tokenCache.set(usuarioId, token);
}

// ── Busca token para ambiente trial (sem mTLS) ────────────────────────────────
function getTrialToken(): SerproToken {
  return {
    access_token: TRIAL_FIXED_TOKEN,
    jwt_token: "",
    expires_at: Date.now() + 24 * 60 * 60 * 1000, // 24h (trial não expira)
  };
}

// ── Busca token OAuth2 com mTLS (produção) ────────────────────────────────────
async function fetchProductionToken(
  config: SerproConfig
): Promise<SerproToken> {
  const consumerSecret = decrypt(config.consumer_secret_enc);
  const certSenha = decrypt(config.cert_senha_enc);
  const certBuffer = fs.readFileSync(config.cert_path);

  const credentials = Buffer.from(
    `${config.consumer_key}:${consumerSecret}`
  ).toString("base64");

  const body = "grant_type=client_credentials";

  const agent = new https.Agent({
    pfx: certBuffer,
    passphrase: certSenha,
    rejectUnauthorized: true,
  });

  const response = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "role-type": "TERCEIROS",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    // @ts-ignore – node-fetch / native fetch aceita agent
    agent,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Falha na autenticação SERPRO (${response.status}): ${errText}`
    );
  }

  const data = await response.json() as {
    access_token: string;
    jwt_token: string;
    expires_in: number;
  };

  return {
    access_token: data.access_token,
    jwt_token: data.jwt_token,
    // Margem de segurança: expira 30s antes do prazo real
    expires_at: Date.now() + (data.expires_in - 30) * 1000,
  };
}

// ── Ponto de entrada: obtém token válido (cache → renovação) ──────────────────
export async function getSerproToken(
  config: SerproConfig
): Promise<SerproToken> {
  if (config.ambiente === "trial") {
    return getTrialToken();
  }

  const cached = getCachedToken(config.usuario_id);
  if (cached) return cached;

  const token = await fetchProductionToken(config);
  setCachedToken(config.usuario_id, token);
  return token;
}

// ── Helpers para salvar/buscar config no banco ────────────────────────────────
/**
 * Persiste as credenciais SERPRO do usuário.
 * Campos sensíveis são criptografados antes de gravar.
 */
export function upsertSerproConfig(
  db: any, // better-sqlite3 Database
  usuarioId: number,
  payload: {
    consumer_key: string;
    consumer_secret: string; // plain text → será criptografado
    cert_path: string;
    cert_senha: string;       // plain text → será criptografado
    cnpj_contratante: string;
    ambiente: AmbienteSerpro;
  }
): void {
  const existing = db
    .prepare("SELECT id FROM serpro_config WHERE usuario_id = ?")
    .get(usuarioId);

  const consumer_secret_enc = encrypt(payload.consumer_secret);
  const cert_senha_enc = encrypt(payload.cert_senha);

  if (existing) {
    db.prepare(
      `UPDATE serpro_config
       SET consumer_key = ?, consumer_secret_enc = ?, cert_path = ?,
           cert_senha_enc = ?, cnpj_contratante = ?, ambiente = ?,
           updated_at = datetime('now')
       WHERE usuario_id = ?`
    ).run(
      payload.consumer_key,
      consumer_secret_enc,
      payload.cert_path,
      cert_senha_enc,
      payload.cnpj_contratante.replace(/\D/g, ""),
      payload.ambiente,
      usuarioId
    );
  } else {
    db.prepare(
      `INSERT INTO serpro_config
       (usuario_id, consumer_key, consumer_secret_enc, cert_path,
        cert_senha_enc, cnpj_contratante, ambiente)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      usuarioId,
      payload.consumer_key,
      consumer_secret_enc,
      payload.cert_path,
      cert_senha_enc,
      payload.cnpj_contratante.replace(/\D/g, ""),
      payload.ambiente
    );
  }

  // Invalida cache ao alterar credenciais
  tokenCache.delete(usuarioId);
}

export function getSerproConfig(
  db: any,
  usuarioId: number
): SerproConfig | null {
  return (
    db
      .prepare("SELECT * FROM serpro_config WHERE usuario_id = ?")
      .get(usuarioId) ?? null
  );
}

export function hasSerproConfig(db: any, usuarioId: number): boolean {
  const row = db
    .prepare(
      "SELECT id FROM serpro_config WHERE usuario_id = ? AND consumer_key != ''"
    )
    .get(usuarioId);
  return !!row;
}
