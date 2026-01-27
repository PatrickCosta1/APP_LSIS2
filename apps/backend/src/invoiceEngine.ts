import crypto from 'node:crypto';
import pdfParse from 'pdf-parse';
import { createWorker, type Worker } from 'tesseract.js';

export type ExtractedInvoice = {
  extractedText: string;
  valorPagarEur: number | null;
  potenciaContratadaKva: number | null;
  termoEnergiaEur: number | null;
  termoPotenciaEur: number | null;
  priceKwhEur: number | null;
  fixedDailyFeeEur: number | null;
  debug: {
    usedOcr: boolean;
  };
};

function toNumberPt(s: string) {
  const cleaned = s.replace(/\s+/g, '').replace('.', '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

const MONEY_RE = /([0-9]{1,3}(?:[\s.]\d{3})*|[0-9]+)[,\.]([0-9]{2})/g;

function findLargestMoney(text: string) {
  let best = NaN;
  let bestRaw: string | null = null;
  for (const m of text.matchAll(MONEY_RE)) {
    const raw = `${m[1]},${m[2]}`;
    const n = toNumberPt(raw);
    if (Number.isFinite(n) && (Number.isNaN(best) || n > best)) {
      best = n;
      bestRaw = raw;
    }
  }
  return { value: Number.isFinite(best) ? best : null, raw: bestRaw };
}

function findByLabelMoney(text: string, labels: string[]) {
  for (const label of labels) {
    const re = new RegExp(`${label}[^\d]{0,40}([0-9]{1,3}(?:[\\s.]\\d{3})*|[0-9]+)[,\\.]([0-9]{2})`, 'i');
    const m = text.match(re);
    if (m) {
      const n = toNumberPt(`${m[1]},${m[2]}`);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function findPowerKva(text: string) {
  const m = text.match(/\b(\d+(?:[\.,]\d+)?)\s*kva\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function pickUnitPrices(text: string) {
  // Captura candidatos com 4 casas (padrão comum nas faturas PT)
  const candidates = Array.from(text.matchAll(/(\d[\.,]\d{4})/g))
    .map((m) => Number(String(m[1]).replace(',', '.')))
    .filter((n) => Number.isFinite(n));

  const uniq = Array.from(new Set(candidates)).sort((a, b) => b - a);

  let priceKwh: number | null = null;
  let fixedDaily: number | null = null;

  for (const p of uniq) {
    if (p < 0.01 || Math.abs(p - 0.06) < 1e-6) continue;

    // Zona típica do custo diário potência total (0.30-0.48)
    if (!fixedDaily && p >= 0.30 && p <= 0.48) {
      fixedDaily = p;
      continue;
    }

    // Zona típica do preço kWh (0.12-0.26)
    if (!priceKwh && p >= 0.12 && p <= 0.26) {
      priceKwh = p;
    }
  }

  // Caso especial: alguns tarifários somam 0.3174 + 0.0222
  if (fixedDaily != null && fixedDaily >= 0.31 && fixedDaily <= 0.32) {
    const termoFixo = uniq.find((p) => p >= 0.02 && p <= 0.03);
    if (termoFixo) fixedDaily = Number((fixedDaily + termoFixo).toFixed(4));
  }

  return { priceKwh, fixedDaily };
}

let workerPromise: Promise<Worker> | null = null;
async function getOcrWorker(lang: string) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const w = await createWorker(lang);
      return w;
    })();
  }
  return workerPromise;
}

export async function extractInvoiceFromFile(opts: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  ocrLang?: string;
}): Promise<ExtractedInvoice> {
  const { buffer, filename, mimeType } = opts;
  const ocrLang = String(opts.ocrLang ?? process.env.KYNEX_TESSERACT_LANG ?? 'por').trim() || 'por';

  let extractedText = '';
  let usedOcr = false;

  if (mimeType.includes('pdf') || filename.toLowerCase().endsWith('.pdf')) {
    const parsed = await pdfParse(buffer);
    extractedText = String(parsed.text ?? '').trim();
  } else if (mimeType.startsWith('image/')) {
    usedOcr = true;
    const worker = await getOcrWorker(ocrLang);
    const { data } = await worker.recognize(buffer);
    extractedText = String(data?.text ?? '').trim();
  } else {
    // tentativa: pdf por extensão
    if (filename.toLowerCase().endsWith('.pdf')) {
      const parsed = await pdfParse(buffer);
      extractedText = String(parsed.text ?? '').trim();
    }
  }

  const normalizedText = extractedText.replace(/\u00a0/g, ' ');

  const valorPagar =
    findByLabelMoney(normalizedText, [
      'valor\\s*a\\s*pagar',
      'total\\s*a\\s*pagar',
      'total\\s*a\\s*liquidar',
      'montante',
      'total\\s*da\\s*fatura'
    ]) ?? findLargestMoney(normalizedText).value;

  const potenciaKva = findPowerKva(normalizedText);

  const termoEnergia =
    findByLabelMoney(normalizedText, ['termo\\s*de\\s*energia', 'energia\\s*ativa', 'energia\\s*consumida']) ?? null;

  const termoPotencia =
    findByLabelMoney(normalizedText, ['termo\\s*de\\s*pot[eê]ncia', 'pot[eê]ncia\\s*contratada']) ?? null;

  const { priceKwh, fixedDaily } = pickUnitPrices(normalizedText);

  return {
    extractedText: normalizedText,
    valorPagarEur: valorPagar,
    potenciaContratadaKva: potenciaKva,
    termoEnergiaEur: termoEnergia,
    termoPotenciaEur: termoPotencia,
    priceKwhEur: priceKwh,
    fixedDailyFeeEur: fixedDaily,
    debug: { usedOcr }
  };
}

export function newInvoiceId() {
  return crypto.randomUUID();
}
