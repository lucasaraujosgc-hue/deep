// ─────────────────────────────────────────────────────────────────────────────
// sitfis.routes.ts  –  Endpoints Express para Integra Contador SitFis
// ─────────────────────────────────────────────────────────────────────────────
import express, { Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { getDb } from "../server.js";
import {
  getSerproConfig,
  upsertSerproConfig,
  hasSerproConfig,
} from "./auth.js";
import { executarSitfis, getHistoricoConsultas } from "./sitfis.js";
import type { AmbienteSerpro } from "./sitfis.types.js";

const router = express.Router();

// ── Multer para upload do certificado .pfx/.p12 ───────────────────────────────
const certStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dest = process.env.DATA_PATH
      ? path.join(process.env.DATA_PATH, "certs")
      : "data/certs";
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (_req, file, cb) => {
    // Prefixo com timestamp para evitar colisões
    cb(null, `cert_${Date.now()}_${file.originalname}`);
  },
});
const uploadCert = multer({
  storage: certStorage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".pfx" || ext === ".p12") {
      cb(null, true);
    } else {
      cb(new Error("Apenas arquivos .pfx ou .p12 são aceitos."));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// ── Cria as tabelas caso ainda não existam ────────────────────────────────────
export function initSitfisDb(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS serpro_config (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id           INTEGER NOT NULL,
      consumer_key         TEXT    NOT NULL DEFAULT '',
      consumer_secret_enc  TEXT    NOT NULL DEFAULT '',
      cert_path            TEXT    NOT NULL DEFAULT '',
      cert_senha_enc       TEXT    NOT NULL DEFAULT '',
      cnpj_contratante     TEXT    NOT NULL DEFAULT '',
      ambiente             TEXT    NOT NULL DEFAULT 'trial',
      created_at           TEXT    DEFAULT (datetime('now')),
      updated_at           TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sitfis_consultas (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id    INTEGER NOT NULL,
      usuario_id    INTEGER NOT NULL,
      protocolo     TEXT,
      status        TEXT    NOT NULL DEFAULT 'SOLICITADO',
      pdf_path      TEXT,
      erro_msg      TEXT,
      tentativas    INTEGER DEFAULT 0,
      created_at    TEXT    DEFAULT (datetime('now')),
      concluido_at  TEXT
    );
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sitfis/config
// Retorna se a configuração está presente (sem expor dados sensíveis)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/config", (req: Request, res: Response) => {
  try {
    const db = getDb(req.user);
    const usuarioId: number = (req.user as any).id;
    const configured = hasSerproConfig(db, usuarioId);

    if (!configured) {
      return res.json({ success: true, configured: false });
    }

    const cfg = getSerproConfig(db, usuarioId)!;
    res.json({
      success: true,
      configured: true,
      consumer_key: cfg.consumer_key,
      cnpj_contratante: cfg.cnpj_contratante,
      ambiente: cfg.ambiente,
      // Nunca expor consumer_secret, cert_senha ou cert_path
      cert_configurado: !!cfg.cert_path && fs.existsSync(cfg.cert_path),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sitfis/config
// Salva/atualiza as credenciais SERPRO do usuário
// Body (multipart/form-data):
//   consumer_key, consumer_secret, cert_senha, cnpj_contratante, ambiente
//   certificado (arquivo .pfx/.p12)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/config",
  uploadCert.single("certificado"),
  async (req: Request, res: Response) => {
    try {
      const db = getDb(req.user);
      const usuarioId: number = (req.user as any).id;

      const {
        consumer_key,
        consumer_secret,
        cert_senha,
        cnpj_contratante,
        ambiente,
      } = req.body as Record<string, string>;

      if (!consumer_key || !consumer_secret || !cnpj_contratante) {
        return res
          .status(400)
          .json({ error: "consumer_key, consumer_secret e cnpj_contratante são obrigatórios." });
      }

      // Obtém caminho do certificado: novo upload ou mantém o existente
      let certPath = "";
      if (req.file) {
        // Aplica permissões restritas ao arquivo do certificado
        fs.chmodSync(req.file.path, 0o600);
        certPath = req.file.path;
      } else {
        // Mantém certificado anterior se não foi reenviado
        const existing = getSerproConfig(db, usuarioId);
        certPath = existing?.cert_path ?? "";
      }

      if (!certPath) {
        return res
          .status(400)
          .json({ error: "Certificado digital (.pfx/.p12) é obrigatório no primeiro cadastro." });
      }

      upsertSerproConfig(db, usuarioId, {
        consumer_key,
        consumer_secret,
        cert_path: certPath,
        cert_senha: cert_senha || "",
        cnpj_contratante,
        ambiente: (ambiente as AmbienteSerpro) || "trial",
      });

      // Log de auditoria
      console.log(
        `[AUDIT] Usuário ${usuarioId} atualizou credenciais SERPRO em ${new Date().toISOString()}`
      );

      res.json({ success: true, message: "Credenciais SERPRO salvas com sucesso." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sitfis/:clienteId
// Dispara a consulta de Situação Fiscal para um cliente
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:clienteId", async (req: Request, res: Response) => {
  try {
    const db = getDb(req.user);
    const usuarioId: number = (req.user as any).id;
    const clienteId = parseInt(req.params.clienteId, 10);

    if (isNaN(clienteId)) {
      return res.status(400).json({ error: "clienteId inválido." });
    }

    // Valida configuração SERPRO
    const config = getSerproConfig(db, usuarioId);
    if (!config || !config.consumer_key) {
      return res.status(400).json({
        error:
          "Credenciais SERPRO não configuradas. Acesse Configurações → Integra Contador.",
      });
    }

    // Busca CPF/CNPJ do cliente
    const cliente = db
      .prepare("SELECT id, name, docNumber FROM companies WHERE id = ?")
      .get(clienteId) as { id: number; name: string; docNumber: string } | undefined;

    if (!cliente) {
      return res.status(404).json({ error: "Cliente não encontrado." });
    }

    const cnpjCliente = cliente.docNumber?.replace(/\D/g, "");
    if (!cnpjCliente) {
      return res
        .status(400)
        .json({ error: "O cliente não possui CNPJ/CPF cadastrado." });
    }

    // Log de auditoria
    console.log(
      `[AUDIT] Usuário ${usuarioId} consultou SitFis do cliente ${clienteId} (${cnpjCliente}) em ${new Date().toISOString()}`
    );

    // Executa o fluxo (pode levar alguns minutos)
    const resultado = await executarSitfis(
      db,
      config,
      clienteId,
      usuarioId,
      cnpjCliente
    );

    res.json(resultado);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sitfis/:clienteId/historico
// Retorna as últimas consultas de um cliente
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:clienteId/historico", (req: Request, res: Response) => {
  try {
    const db = getDb(req.user);
    const clienteId = parseInt(req.params.clienteId, 10);
    const historico = getHistoricoConsultas(db, clienteId);
    res.json({ success: true, historico });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sitfis/:clienteId/pdf/:consultaId
// Serve o PDF de uma consulta concluída
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:clienteId/pdf/:consultaId", (req: Request, res: Response) => {
  try {
    const db = getDb(req.user);
    const consultaId = parseInt(req.params.consultaId, 10);
    const usuarioId: number = (req.user as any).id;

    const consulta = db
      .prepare(
        "SELECT pdf_path, usuario_id FROM sitfis_consultas WHERE id = ? AND status = 'CONCLUIDO'"
      )
      .get(consultaId) as { pdf_path: string; usuario_id: number } | undefined;

    if (!consulta) {
      return res.status(404).json({ error: "Consulta não encontrada ou ainda em processamento." });
    }

    // Verifica se o usuário tem acesso (mesmo usuário ou admin poderiam ter acesso)
    if (consulta.usuario_id !== usuarioId) {
      return res.status(403).json({ error: "Acesso negado." });
    }

    if (!fs.existsSync(consulta.pdf_path)) {
      return res.status(404).json({ error: "Arquivo PDF não encontrado no servidor." });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="sitfis_${req.params.clienteId}_${consultaId}.pdf"`
    );
    fs.createReadStream(consulta.pdf_path).pipe(res);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
