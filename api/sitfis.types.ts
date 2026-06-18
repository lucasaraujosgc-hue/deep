// ─────────────────────────────────────────────────────────────────────────────
// sitfis.types.ts  –  Tipos TypeScript para integração SERPRO Integra-SitFis
// ─────────────────────────────────────────────────────────────────────────────

export type AmbienteSerpro = "trial" | "producao";

// ── Credenciais armazenadas no banco (serpro_config) ─────────────────────────
export interface SerproConfig {
  id: number;
  usuario_id: number;
  consumer_key: string;
  consumer_secret_enc: string; // criptografado AES-256
  cert_path: string;           // caminho no servidor
  cert_senha_enc: string;      // criptografado AES-256
  cnpj_contratante: string;
  ambiente: AmbienteSerpro;
  created_at: string;
  updated_at: string;
}

// ── Token em cache (memória ou banco) ────────────────────────────────────────
export interface SerproToken {
  access_token: string;
  jwt_token: string;
  expires_at: number; // timestamp ms (Date.now() + expires_in*1000 - 30s)
}

// ── Payloads das chamadas à API SERPRO ───────────────────────────────────────
export interface ContribuintePayload {
  numero: string; // CPF ou CNPJ sem pontuação
  tipo: 1 | 2;    // 1 = CPF, 2 = CNPJ
}

export interface PedidoDados {
  idSistema: string;
  idServico: string;
  versaoSistema: string;
  dados: string;
}

export interface IntegraPayload {
  contratante: ContribuintePayload;
  autorPedidoDados: ContribuintePayload;
  contribuinte: ContribuintePayload;
  pedidoDados: PedidoDados;
}

// ── Respostas da API SERPRO ───────────────────────────────────────────────────
export interface SerproAuthResponse {
  access_token: string;
  jwt_token: string;
  expires_in: number;
  token_type: string;
}

export interface ApoiarResponse {
  protocoloRelatorio: string;
}

export interface EmitirResponse {
  // HTTP 200 → base64 do PDF; HTTP 202 → tempoEspera
  pdf?: string;          // base64 quando concluído
  tempoEspera?: number;  // ms para aguardar antes de nova tentativa (202)
}

// ── Histórico de consultas (sitfis_consultas) ─────────────────────────────────
export type StatusConsulta =
  | "SOLICITADO"
  | "PROCESSANDO"
  | "CONCLUIDO"
  | "ERRO";

export interface SitfisConsulta {
  id: number;
  cliente_id: number;
  usuario_id: number;
  protocolo: string | null;
  status: StatusConsulta;
  pdf_path: string | null;
  erro_msg: string | null;
  tentativas: number;
  created_at: string;
  concluido_at: string | null;
}

// ── Resposta padronizada do endpoint interno ──────────────────────────────────
export type SitfisResultado =
  | { status: "CONCLUIDO"; pdfBase64: string; consultaId: number }
  | { status: "PROCESSANDO"; mensagem: string; consultaId: number }
  | { status: "ERRO"; codigo: string; mensagem: string; consultaId?: number };
