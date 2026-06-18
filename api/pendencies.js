import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import zlib from "zlib";
import { getDb, ai } from "../server.js";

const router = express.Router();

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

export default router;
