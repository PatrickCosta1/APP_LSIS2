import crypto from 'node:crypto';

import pdfParse from 'pdf-parse';

import { createWorker, type Worker } from 'tesseract.js';

export type ExtractedInvoice = {
  extractedText: string;
  utilityGuess: string | null;
  valorPagarEur: number | null;
  potenciaContratadaKva: number | null;
  termoEnergiaEur: number | null;
  termoPotenciaEur: number | null;
  priceKwhEur: number | null;
  fixedDailyFeeEur: number | null;
  debug: {
    usedOcr: boolean;
    detectionDetails?: {
      valorPagarMethod?: string;
      priceKwhMethod?: string;
      fixedDailyMethod?: string;
      allCandidates?: Array<{ value: number; context: string }>;
    };
  };
};

function guessUtility(text: string) {
  const t = String(text ?? '').toLowerCase();
  if (!t) return null;
  if (/gold\s*energy|goldenergy/.test(t)) return 'Goldenergy';
  if (/su\s*eletricidade|su\s*electricity/.test(t)) return 'SU Eletricidade';
  if (/endesa/.test(t)) return 'Endesa';
  if (/iberdrola/.test(t)) return 'Iberdrola';
  if (/\bedp\b|edp\s*comercial/.test(t)) return 'EDP Comercial';
  return null;
}

function toNumberPt(s: string) {
  const cleaned = s.replace(/\s+/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

const MONEY_RE = /([0-9]{1,3}(?:[\s.]\d{3})*|[0-9]+)[,\.]([0-9]{1,2})/g;

function toMoneyFromMatch(intPart: string, decPart: string) {
  const dec = String(decPart ?? '').padEnd(2, '0').slice(0, 2);
  return toNumberPt(`${intPart},${dec}`);
}

function findByLabelMoney(text: string, labels: string[]) {
  for (const label of labels) {
    const re = new RegExp(
      `${label}[^0-9]{0,80}([0-9]{1,3}(?:[\\s.]\\d{3})*|[0-9]+)[,\\.]([0-9]{1,2})`,
      'i'
    );
    const m = text.match(re);
    if (m) {
      const n = toMoneyFromMatch(String(m[1]), String(m[2]));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function findLikelyInvoiceTotal(text: string) {
  const byLabel =
    findByLabelMoney(text, [
      'total\\s*a\\s*pagar',
      'valor\\s*a\\s*pagar',
      'total\\s*a\\s*liquidar',
      'total\\s*da\\s*fatura',
      'total\\s*factura',
      'total\\s*da\\s*conta',
      'montante\\s*a\\s*pagar',
      'valor\\s*da\\s*fatura'
    ]) ?? null;
  
  if (typeof byLabel === 'number' && byLabel >= 5 && byLabel <= 5000) {
    return byLabel;
  }

  const all = Array.from(text.matchAll(MONEY_RE))
    .map((m) => {
      const intPart = String(m[1]).replace(/\D/g, '');
      if (intPart.length > 5) return null;
      return toMoneyFromMatch(String(m[1]), String(m[2]));
    })
    .filter((n) => Number.isFinite(n)) as number[];

  const candidates = all.filter((n) => n >= 5 && n <= 2000);
  if (candidates.length) return Math.max(...candidates);

  const broad = all.filter((n) => n >= 5 && n <= 5000);
  if (broad.length) return Math.max(...broad);

  return null;
}

export function extractLikelyInvoiceTotalEur(extractedText: string) {
  const normalizedText = String(extractedText ?? '').replace(/\u00a0/g, ' ');
  return findLikelyInvoiceTotal(normalizedText);
}

function findPowerKva(text: string) {
  const patterns = [
    /\b(\d+[,\.]\d+)\s*kva\b/i,
    /\b(\d+)\s*kva\b/i,
    /potência\s*contratada[^0-9]{0,20}(\d+[,\.]\d+)\s*kva/i,
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      const n = Number(m[1].replace(',', '.'));
      if (Number.isFinite(n) && n > 0 && n < 100) return n;
    }
  }
  return null;
}

function pickUnitPrices(text: string) {
  const debug: any = { allCandidates: [] };

  let priceKwh: number | null = null;
  let fixedDaily: number | null = null;

  // ESTRATÉGIA 1: Detecção por contexto explícito (Iberdrola)
  // Padrão: "0,1595 €/kWh" ou "0,5332 €/dia"
  const kwhExplicitMatch = text.match(/(\d[,\.]\d{3,4})\s*€\s*\/\s*kwh/i);
  if (kwhExplicitMatch) {
    const n = Number(kwhExplicitMatch[1].replace(',', '.'));
    if (Number.isFinite(n) && n >= 0.08 && n <= 0.35) {
      priceKwh = n;
      debug.priceKwhMethod = 'explicit-kwh';
      debug.allCandidates.push({ value: n, context: kwhExplicitMatch[0] });
    }
  }

  const dailyExplicitMatch = text.match(/(\d[,\.]\d{3,4})\s*€\s*\/\s*dia/i);
  if (dailyExplicitMatch) {
    const n = Number(dailyExplicitMatch[1].replace(',', '.'));
    if (Number.isFinite(n) && n >= 0.20 && n <= 1.50) {
      fixedDaily = n;
      debug.fixedDailyMethod = 'explicit-day';
      debug.allCandidates.push({ value: n, context: dailyExplicitMatch[0] });
    }
  }

  // ESTRATÉGIA 2: Detecção por contexto de tabela (SU Eletricidade)
  // Padrão: "200 kWh 0,1658 €" ou "30 dias 0,3396 €"
  
  // Buscar preço kWh em contexto de consumo
  // Padrão: números antes, "kWh", espaços, valor com 4 casas
  const kwhTableMatches = text.matchAll(/(\d+)\s*kwh\s+(\d[,\.]\d{3,4})\s*€/gi);
  for (const m of kwhTableMatches) {
    const kwh = Number(m[1]);
    const price = Number(m[2].replace(',', '.'));
    
    // Validar se faz sentido: consumo razoável (> 10 kWh) e preço na faixa esperada
    if (kwh >= 10 && Number.isFinite(price) && price >= 0.08 && price <= 0.35) {
      if (!priceKwh) {
        priceKwh = price;
        debug.priceKwhMethod = 'table-kwh-context';
        debug.allCandidates.push({ value: price, context: m[0] });
      }
    }
  }

  // Buscar taxa diária em contexto de potência
  // Padrão: "30 dias", espaços, valor com 4 casas
  const dailyTableMatches = text.matchAll(/(\d+)\s*dias?\s+(\d[,\.]\d{3,4})\s*€/gi);
  for (const m of dailyTableMatches) {
    const days = Number(m[1]);
    const price = Number(m[2].replace(',', '.'));
    
    // Validar se faz sentido: período razoável (20-31 dias) e preço na faixa esperada
    if (days >= 20 && days <= 31 && Number.isFinite(price) && price >= 0.20 && price <= 1.50) {
      if (!fixedDaily) {
        fixedDaily = price;
        debug.fixedDailyMethod = 'table-days-context';
        debug.allCandidates.push({ value: price, context: m[0] });
      }
    }
  }

  // ESTRATÉGIA 3: Heurística por faixas (fallback)
  if (!priceKwh || !fixedDaily) {
    const allPricePatterns = [
      ...text.matchAll(/(\d[,\.]\d{4})\s*€/g),
      ...text.matchAll(/(\d[,\.]\d{3})\s*€/g),
    ];

    const candidates: number[] = [];
    for (const m of allPricePatterns) {
      const n = Number(String(m[1]).replace(',', '.'));
      if (Number.isFinite(n) && n >= 0.05) {
        candidates.push(n);
      }
    }

    const uniq = Array.from(new Set(candidates)).sort((a, b) => b - a);

    for (const p of uniq) {
      // Ignorar valores muito pequenos ou irrelevantes
      if (p < 0.01 || Math.abs(p - 0.06) < 1e-6 || Math.abs(p - 0.07) < 1e-6) {
        continue;
      }

      // Taxa diária: 0.20-1.50
      if (!fixedDaily && p >= 0.20 && p <= 1.50) {
        // Garantir que não é o preço kWh
        if (!(p >= 0.08 && p <= 0.35)) {
          fixedDaily = p;
          debug.fixedDailyMethod = 'heuristic-range';
          debug.allCandidates.push({ value: p, context: 'fallback' });
          continue;
        }
      }

      // Preço kWh: 0.08-0.35
      if (!priceKwh && p >= 0.08 && p <= 0.35) {
        priceKwh = p;
        debug.priceKwhMethod = 'heuristic-range';
        debug.allCandidates.push({ value: p, context: 'fallback' });
      }
    }
  }

  // VALIDAÇÃO CRUZADA: garantir que não trocamos os valores
  if (priceKwh && fixedDaily && priceKwh > fixedDaily) {
    // Se o "preço kWh" for maior que a "taxa diária", provavelmente estão trocados
    // Isto acontece porque a taxa diária costuma ser maior que o preço kWh
    // Exemplo: 0,3396 €/dia vs 0,1658 €/kWh
    const temp = priceKwh;
    priceKwh = fixedDaily;
    fixedDaily = temp;
    debug.priceKwhMethod = (debug.priceKwhMethod || '') + '-swapped';
    debug.fixedDailyMethod = (debug.fixedDailyMethod || '') + '-swapped';
  }

  return { priceKwh, fixedDaily, debug };
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
    if (filename.toLowerCase().endsWith('.pdf')) {
      const parsed = await pdfParse(buffer);
      extractedText = String(parsed.text ?? '').trim();
    }
  }

  const normalizedText = extractedText.replace(/\u00a0/g, ' ');

  const utilityGuess = guessUtility(normalizedText);

  const valorPagar = findLikelyInvoiceTotal(normalizedText);

  const potenciaKva = findPowerKva(normalizedText);

  const termoEnergia =
    findByLabelMoney(normalizedText, [
      'termo\\s*de\\s*energia',
      'energia\\s*ativa',
      'energia\\s*consumida',
      'consumo\\s*de\\s*energia',
      'eletricidade\\s*\\(s\\/iva\\)'
    ]) ?? null;

  const termoPotenciaCandidate = findByLabelMoney(normalizedText, [
    'termo\\s*de\\s*pot[eê]ncia',
    'potência\\s*contratada[^k][^v][^a]'
  ]) ?? null;
  
  const termoPotencia =
    typeof termoPotenciaCandidate === 'number' &&
    termoPotenciaCandidate >= 0.01 &&
    termoPotenciaCandidate <= 50
      ? termoPotenciaCandidate
      : null;

  const priceResult = pickUnitPrices(normalizedText);

  return {
    extractedText: normalizedText,
    utilityGuess,
    valorPagarEur: valorPagar,
    potenciaContratadaKva: potenciaKva,
    termoEnergiaEur: termoEnergia,
    termoPotenciaEur: termoPotencia,
    priceKwhEur: priceResult.priceKwh,
    fixedDailyFeeEur: priceResult.fixedDaily,
    debug: {
      usedOcr,
      detectionDetails: priceResult.debug
    }
  };
}

export function newInvoiceId() {
  return crypto.randomUUID();
}