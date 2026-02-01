import crypto from 'node:crypto';

import pdfParse from 'pdf-parse';

import { createWorker, type Worker } from 'tesseract.js';

export type ExtractedInvoice = {
  extractedText: string;
  utilityGuess: string | null;
  valorPagarEur: number | null;
  consumptionKwhPeriod: number | null;
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
  // Apenas os comercializadores pedidos
  if (/gold\s*energy|goldenergy/.test(t)) return 'Goldenergy';
  if (/\bsu\b\s*eletricidade|su\s*electricity|su\s*electricidade/.test(t)) return 'SU Eletricidade';
  if (/\bendesa\b/.test(t)) return 'Endesa';
  if (/\biberdrola\b/.test(t)) return 'Iberdrola';
  if (/\bedp\b|edp\s*comercial/.test(t)) return 'EDP';
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

function findPeriodDays(text: string) {
  // Preferir cálculo a partir de "Período de faturação: 14 nov 2025 até 13 dez 2025"
  const monthMap: Record<string, number> = {
    jan: 0,
    fev: 1,
    mar: 2,
    abr: 3,
    mai: 4,
    jun: 5,
    jul: 6,
    ago: 7,
    set: 8,
    out: 9,
    nov: 10,
    dez: 11
  };

  const periodRe = /per[ií]odo\s*de\s*fatur[aã]ç[aã]o\s*:\s*(\d{1,2})\s*(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\s*(\d{4})\s*at[eé]\s*(\d{1,2})\s*(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\s*(\d{4})/i;
  const pm = text.match(periodRe);
  if (pm) {
    const d1 = Number(pm[1]);
    const m1 = monthMap[String(pm[2]).toLowerCase()];
    const y1 = Number(pm[3]);
    const d2 = Number(pm[4]);
    const m2 = monthMap[String(pm[5]).toLowerCase()];
    const y2 = Number(pm[6]);
    if ([d1, m1, y1, d2, m2, y2].every((v) => Number.isFinite(v))) {
      const start = new Date(Date.UTC(y1, m1, d1));
      const end = new Date(Date.UTC(y2, m2, d2));
      const diffDays = Math.floor((end.getTime() - start.getTime()) / 86400000);
      // faturas costumam ser inclusivas (ex: 14 nov a 13 dez = 30 dias)
      const inclusive = diffDays + 1;
      if (Number.isFinite(inclusive) && inclusive >= 1 && inclusive <= 62) return inclusive;
    }
  }

  // fallback: capturar "durante 30 dias" em contexto
  const ctx = text.match(/(?:durante|por)\s*(\d{1,2})\s*dias?\b/i);
  if (ctx) {
    const n = Number(ctx[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 62) return n;
  }

  // fallback genérico: qualquer "30 dias" (último recurso)
  const m = text.match(/\b(\d{1,2})\s*dias?\b/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 62) return n;
  }

  return null;
}

function findTotalKwh(text: string) {
  // kWh do período (mês): pode ser inteiro, com separadores, ou decimal (ex: 367,2 kWh)
  const num = '((?:\\d{1,3}(?:[\\s.]\\d{3})*|\\d+)(?:[,\\.]\\d{1,2})?)';

  const patterns: Array<{ re: RegExp; weight: number }> = [
    { re: new RegExp(`consumo[^0-9]{0,80}${num}\\s*kwh\\b`, 'i'), weight: 4 },
    { re: new RegExp(`consumo\\s*de\\s*energia[^0-9]{0,120}${num}\\s*kwh\\b`, 'i'), weight: 4 },
    { re: new RegExp(`energia\\s*ativa[^0-9]{0,80}${num}\\s*kwh\\b`, 'i'), weight: 3 },
    { re: new RegExp(`energia\\s*consumida[^0-9]{0,80}${num}\\s*kwh\\b`, 'i'), weight: 3 },
    { re: new RegExp(`\\btotal\\b[^0-9]{0,80}${num}\\s*kwh\\b`, 'i'), weight: 5 },
    { re: new RegExp(`${num}\\s*kwh\\b[^\\n]{0,60}(?:total|consumo)`, 'i'), weight: 2 }
  ];

  for (const { re } of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const n = toNumberPt(String(m[1]));
    if (Number.isFinite(n) && n >= 1 && n <= 20000) return n;
  }

  // fallback: varrer todos os "N kWh" e escolher o mais provável
  const candidates: Array<{ kwh: number; weight: number; ctx: string }> = [];
  const all = text.matchAll(new RegExp(`${num}\\s*kwh\\b`, 'gi'));
  for (const m of all) {
    const kwh = toNumberPt(String(m[1]));
    if (!Number.isFinite(kwh)) continue;
    // faixa mensal típica (evitar leituras/IDs enormes)
    if (kwh < 5 || kwh > 5000) continue;
    const idx = m.index ?? 0;
    const ctx = text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + 60)).toLowerCase();
    let weight = 1;
    if (ctx.includes('total')) weight += 4;
    if (ctx.includes('consumo')) weight += 3;
    if (ctx.includes('energia')) weight += 2;
    if (ctx.includes('vazio') || ctx.includes('cheia') || ctx.includes('ponta') || ctx.includes('fora')) weight -= 1;
    candidates.push({ kwh, weight, ctx });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.weight - a.weight) || (b.kwh - a.kwh));
  return candidates[0].kwh;
}

function findLastMoneyAfterLabel(text: string, labelRe: RegExp, opts?: { maxChars?: number; rejectValues?: number[] }) {
  const maxChars = Math.max(60, Math.min(600, opts?.maxChars ?? 260));
  const reject = new Set<number>((opts?.rejectValues ?? []).filter((x) => Number.isFinite(x)));

  const m = text.match(labelRe);
  if (!m || m.index == null) return null;

  const start = m.index;
  const slice = text.slice(start, start + maxChars);
  const money = Array.from(slice.matchAll(MONEY_RE))
    .map((mm) => toMoneyFromMatch(String(mm[1]), String(mm[2])))
    .filter((n) => Number.isFinite(n)) as number[];

  // Escolhe o último valor plausível (normalmente o total € está no fim do trecho)
  for (let i = money.length - 1; i >= 0; i -= 1) {
    const v = money[i];
    if (reject.has(Number(v.toFixed(4)))) continue;
    if (v >= 0.01 && v <= 5000) return v;
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
  const kwhTableMatches = text.matchAll(/(\d+(?:[,\.]\d{1,2})?)\s*kwh\s*(?:x|\*)?\s*(\d[,\.]\d{3,4})\s*€?/gi);
  for (const m of kwhTableMatches) {
    const kwh = toNumberPt(String(m[1]));
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
  const dailyTableMatches = text.matchAll(/(\d+)\s*dias?\s*(?:x|\*)?\s*(\d[,\.]\d{3,4})\s*€?/gi);
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

    // Classificar candidatos pelo contexto mais próximo (kWh vs dia)
    const ctxCandidates: Array<{ value: number; kind: 'kwh' | 'day' | 'unknown'; hint: string }> = [];
    for (const v of candidates) {
      const vv = Number(v.toFixed(4));

      // tenta achar ocorrências do valor (com , ou .) e ler janela de contexto
      const valDot = String(vv).replace('.', '\\.');
      const valComma = String(vv).replace('.', ',').replace(',', '\\,');
      const re = new RegExp(`(?:${valDot}|${valComma})`, 'g');
      let bestKind: 'kwh' | 'day' | 'unknown' = 'unknown';
      let bestHint = 'fallback';
      for (const mm of text.matchAll(re)) {
        const idx = mm.index ?? 0;
        const window = text.slice(Math.max(0, idx - 25), Math.min(text.length, idx + 35)).toLowerCase();
        const isKwh = window.includes('kwh') || window.includes('/kwh') || window.includes('€/kwh');
        const isDay = window.includes('dia') || window.includes('dias') || window.includes('/dia') || window.includes('€/dia');
        if (isKwh && !isDay) {
          bestKind = 'kwh';
          bestHint = window.trim();
          break;
        }
        if (isDay && !isKwh) {
          bestKind = 'day';
          bestHint = window.trim();
          // não faz break: pode existir outro match mais forte
        }
      }
      ctxCandidates.push({ value: vv, kind: bestKind, hint: bestHint });
    }

    const uniq = Array.from(new Set(ctxCandidates.map((c) => c.value))).sort((a, b) => b - a);

    for (const p of uniq) {
      // Ignorar valores muito pequenos ou irrelevantes
      if (p < 0.01 || Math.abs(p - 0.06) < 1e-6 || Math.abs(p - 0.07) < 1e-6) {
        continue;
      }

      const ctx = ctxCandidates.find((c) => c.value === p);
      const kind = ctx?.kind ?? 'unknown';
      const hint = ctx?.hint ?? 'fallback';

      // Se o contexto indicar claramente "dia", priorizar taxa diária
      if (!fixedDaily && kind === 'day' && p >= 0.05 && p <= 2.50) {
        fixedDaily = p;
        debug.fixedDailyMethod = 'heuristic-context-day';
        debug.allCandidates.push({ value: p, context: hint || 'fallback-day' });
        continue;
      }

      // Se o contexto indicar claramente "kWh", priorizar preço kWh
      if (!priceKwh && kind === 'kwh' && p >= 0.05 && p <= 0.60) {
        priceKwh = p;
        debug.priceKwhMethod = 'heuristic-context-kwh';
        debug.allCandidates.push({ value: p, context: hint || 'fallback-kwh' });
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

async function extractTextFromSingleFile(opts: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  ocrLang: string;
}): Promise<{ text: string; usedOcr: boolean }> {
  const { buffer, filename, mimeType, ocrLang } = opts;

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

  return { text: extractedText, usedOcr };
}

export async function extractInvoiceFromFiles(opts: {
  files: Array<{ buffer: Buffer; filename: string; mimeType: string }>;
  ocrLang?: string;
}): Promise<ExtractedInvoice> {
  const files = Array.isArray(opts.files) ? opts.files : [];
  const ocrLang = String(opts.ocrLang ?? process.env.KYNEX_TESSERACT_LANG ?? 'por').trim() || 'por';

  let usedOcr = false;
  const parts: string[] = [];

  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const r = await extractTextFromSingleFile({ buffer: f.buffer, filename: f.filename, mimeType: f.mimeType, ocrLang });
    if (r.usedOcr) usedOcr = true;
    const t = String(r.text ?? '').trim();
    if (!t) continue;
    parts.push(`--- ANEXO ${i + 1}: ${f.filename} ---\n${t}`);
  }

  const extractedText = parts.join('\n\n');
  const normalizedText = extractedText.replace(/\u00a0/g, ' ');

  const utilityGuess = guessUtility(normalizedText);

  const valorPagar = findLikelyInvoiceTotal(normalizedText);

  const potenciaKva = findPowerKva(normalizedText);

  const periodDays = findPeriodDays(normalizedText);
  const totalKwh = findTotalKwh(normalizedText);

  const termoEnergia =
    findByLabelMoney(normalizedText, [
      'termo\\s*de\\s*energia',
      'energia\\s*ativa',
      'energia\\s*consumida',
      'consumo\\s*de\\s*energia',
      'eletricidade\\s*\\(s\\/iva\\)'
    ]) ?? null;

  const termoEnergiaAltReduced = findByLabelMoney(normalizedText, ['taxa\\s*reduzida']) ?? null;
  const termoEnergiaAltNormal = findByLabelMoney(normalizedText, ['taxa\\s*normal']) ?? null;
  const termoEnergiaFinal =
    termoEnergia ??
    (typeof termoEnergiaAltReduced === 'number' && typeof termoEnergiaAltNormal === 'number'
      ? Number((termoEnergiaAltReduced + termoEnergiaAltNormal).toFixed(2))
      : null);

  const rejectKva = typeof potenciaKva === 'number' && Number.isFinite(potenciaKva) ? [Number(potenciaKva.toFixed(2)), Number(potenciaKva.toFixed(1))] : [];
  const termoPotenciaCandidate =
    findLastMoneyAfterLabel(normalizedText, /termo\s*de\s*pot[eê]ncia/i, { rejectValues: rejectKva }) ??
    findLastMoneyAfterLabel(normalizedText, /potência\s*contratada/i, { rejectValues: rejectKva }) ??
    null;

  const termoPotencia =
    typeof termoPotenciaCandidate === 'number' && termoPotenciaCandidate >= 0.01 && termoPotenciaCandidate <= 200
      ? termoPotenciaCandidate
      : null;

  const priceResult = pickUnitPrices(normalizedText);

  const inferredFixedDaily =
    !priceResult.fixedDaily && typeof termoPotencia === 'number' && Number.isFinite(termoPotencia) && typeof periodDays === 'number' && periodDays > 0
      ? Number((termoPotencia / periodDays).toFixed(4))
      : null;

  const inferredPriceKwh =
    !priceResult.priceKwh && typeof termoEnergiaFinal === 'number' && Number.isFinite(termoEnergiaFinal) && typeof totalKwh === 'number' && totalKwh > 0
      ? Number((termoEnergiaFinal / totalKwh).toFixed(4))
      : null;

  const minKwh = Number(process.env.KYNEX_PRICE_KWH_MIN ?? 0.05);
  const maxKwh = Number(process.env.KYNEX_PRICE_KWH_MAX ?? 0.60);
  const minDaily = Number(process.env.KYNEX_FIXED_DAILY_MIN ?? 0.05);
  const maxDaily = Number(process.env.KYNEX_FIXED_DAILY_MAX ?? 2.50);

  const sanitize = (v: number | null, min: number, max: number) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (v < min || v > max) return null;
    return v;
  };

  const inferredFixedDailySafe = sanitize(inferredFixedDaily, minDaily, maxDaily);
  const inferredPriceKwhSafe = sanitize(inferredPriceKwh, minKwh, maxKwh);

  if (inferredFixedDailySafe) {
    (priceResult.debug as any).fixedDailyMethod = (priceResult.debug as any).fixedDailyMethod ?? 'inferred-termoPotencia/days';
    (priceResult.debug as any).allCandidates = (priceResult.debug as any).allCandidates ?? [];
    (priceResult.debug as any).allCandidates.push({ value: inferredFixedDailySafe, context: 'inferred-fixedDaily' });
  } else if (inferredFixedDaily) {
    (priceResult.debug as any).fixedDailyMethod = (priceResult.debug as any).fixedDailyMethod ?? 'inferred-termoPotencia/days-rejected';
  }

  if (inferredPriceKwhSafe) {
    (priceResult.debug as any).priceKwhMethod = (priceResult.debug as any).priceKwhMethod ?? 'inferred-termoEnergia/kwh';
    (priceResult.debug as any).allCandidates = (priceResult.debug as any).allCandidates ?? [];
    (priceResult.debug as any).allCandidates.push({ value: inferredPriceKwhSafe, context: 'inferred-priceKwh' });
  } else if (inferredPriceKwh) {
    (priceResult.debug as any).priceKwhMethod = (priceResult.debug as any).priceKwhMethod ?? 'inferred-termoEnergia/kwh-rejected';
  }

  const finalPriceKwh = sanitize(priceResult.priceKwh ?? inferredPriceKwhSafe, minKwh, maxKwh);
  const finalFixedDaily = sanitize(priceResult.fixedDaily ?? inferredFixedDailySafe, minDaily, maxDaily);

  return {
    extractedText: normalizedText,
    utilityGuess,
    valorPagarEur: valorPagar,
    consumptionKwhPeriod: typeof totalKwh === 'number' && Number.isFinite(totalKwh) ? totalKwh : null,
    potenciaContratadaKva: potenciaKva,
    termoEnergiaEur: termoEnergiaFinal,
    termoPotenciaEur: termoPotencia,
    priceKwhEur: finalPriceKwh,
    fixedDailyFeeEur: finalFixedDaily,
    debug: {
      usedOcr,
      detectionDetails: priceResult.debug
    }
  };
}

export async function extractInvoiceFromFile(opts: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  ocrLang?: string;
}): Promise<ExtractedInvoice> {
  const { buffer, filename, mimeType } = opts;
  const ocrLang = String(opts.ocrLang ?? process.env.KYNEX_TESSERACT_LANG ?? 'por').trim() || 'por';

  const single = await extractTextFromSingleFile({ buffer, filename, mimeType, ocrLang });
  const normalizedText = String(single.text ?? '').trim().replace(/\u00a0/g, ' ');

  const utilityGuess = guessUtility(normalizedText);

  const valorPagar = findLikelyInvoiceTotal(normalizedText);

  const potenciaKva = findPowerKva(normalizedText);

  const periodDays = findPeriodDays(normalizedText);
  const totalKwh = findTotalKwh(normalizedText);

  const termoEnergia =
    findByLabelMoney(normalizedText, [
      'termo\\s*de\\s*energia',
      'energia\\s*ativa',
      'energia\\s*consumida',
      'consumo\\s*de\\s*energia',
      'eletricidade\\s*\\(s\\/iva\\)'
    ]) ?? null;

  const termoEnergiaAltReduced = findByLabelMoney(normalizedText, ['taxa\\s*reduzida']) ?? null;
  const termoEnergiaAltNormal = findByLabelMoney(normalizedText, ['taxa\\s*normal']) ?? null;
  const termoEnergiaFinal =
    termoEnergia ??
    (typeof termoEnergiaAltReduced === 'number' && typeof termoEnergiaAltNormal === 'number'
      ? Number((termoEnergiaAltReduced + termoEnergiaAltNormal).toFixed(2))
      : null);

  // Termo de potência: não pode capturar o valor em kVA (ex: "6,9 kVA") como se fosse €.
  // Pegamos o ÚLTIMO valor monetário numa janela após o label.
  const rejectKva = typeof potenciaKva === 'number' && Number.isFinite(potenciaKva) ? [Number(potenciaKva.toFixed(2)), Number(potenciaKva.toFixed(1))] : [];
  const termoPotenciaCandidate =
    findLastMoneyAfterLabel(normalizedText, /termo\s*de\s*pot[eê]ncia/i, { rejectValues: rejectKva }) ??
    findLastMoneyAfterLabel(normalizedText, /potência\s*contratada/i, { rejectValues: rejectKva }) ??
    null;

  const termoPotencia =
    typeof termoPotenciaCandidate === 'number' && termoPotenciaCandidate >= 0.01 && termoPotenciaCandidate <= 200
      ? termoPotenciaCandidate
      : null;

  const priceResult = pickUnitPrices(normalizedText);

  // Se não houver taxa diária explícita, inferir a partir do termo de potência e nº de dias.
  const inferredFixedDaily =
    !priceResult.fixedDaily && typeof termoPotencia === 'number' && Number.isFinite(termoPotencia) && typeof periodDays === 'number' && periodDays > 0
      ? Number((termoPotencia / periodDays).toFixed(4))
      : null;

  // Se não houver preço unitário explícito, inferir como preço médio de energia (sem potência) = termoEnergia / kWh.
  const inferredPriceKwh =
    !priceResult.priceKwh && typeof termoEnergiaFinal === 'number' && Number.isFinite(termoEnergiaFinal) && typeof totalKwh === 'number' && totalKwh > 0
      ? Number((termoEnergiaFinal / totalKwh).toFixed(4))
      : null;

  // Guardrails (principalmente para OCR): impedir valores fora de escala
  // - preço kWh típico: ~0.08-0.35 (podendo ir um pouco acima em casos extremos)
  // - termo fixo/dia típico: ~0.20-1.50
  const minKwh = Number(process.env.KYNEX_PRICE_KWH_MIN ?? 0.05);
  const maxKwh = Number(process.env.KYNEX_PRICE_KWH_MAX ?? 0.60);
  const minDaily = Number(process.env.KYNEX_FIXED_DAILY_MIN ?? 0.05);
  const maxDaily = Number(process.env.KYNEX_FIXED_DAILY_MAX ?? 2.50);

  const sanitize = (v: number | null, min: number, max: number) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (v < min || v > max) return null;
    return v;
  };

  const inferredFixedDailySafe = sanitize(inferredFixedDaily, minDaily, maxDaily);
  const inferredPriceKwhSafe = sanitize(inferredPriceKwh, minKwh, maxKwh);

  if (inferredFixedDailySafe) {
    (priceResult.debug as any).fixedDailyMethod = (priceResult.debug as any).fixedDailyMethod ?? 'inferred-termoPotencia/days';
    (priceResult.debug as any).allCandidates = (priceResult.debug as any).allCandidates ?? [];
    (priceResult.debug as any).allCandidates.push({ value: inferredFixedDailySafe, context: 'inferred-fixedDaily' });
  } else if (inferredFixedDaily) {
    (priceResult.debug as any).fixedDailyMethod = (priceResult.debug as any).fixedDailyMethod ?? 'inferred-termoPotencia/days-rejected';
  }

  if (inferredPriceKwhSafe) {
    (priceResult.debug as any).priceKwhMethod = (priceResult.debug as any).priceKwhMethod ?? 'inferred-termoEnergia/kwh';
    (priceResult.debug as any).allCandidates = (priceResult.debug as any).allCandidates ?? [];
    (priceResult.debug as any).allCandidates.push({ value: inferredPriceKwhSafe, context: 'inferred-priceKwh' });
  } else if (inferredPriceKwh) {
    (priceResult.debug as any).priceKwhMethod = (priceResult.debug as any).priceKwhMethod ?? 'inferred-termoEnergia/kwh-rejected';
  }

  const finalPriceKwh = sanitize(priceResult.priceKwh ?? inferredPriceKwhSafe, minKwh, maxKwh);
  const finalFixedDaily = sanitize(priceResult.fixedDaily ?? inferredFixedDailySafe, minDaily, maxDaily);

  return {
    extractedText: normalizedText,
    utilityGuess,
    valorPagarEur: valorPagar,
    consumptionKwhPeriod: typeof totalKwh === 'number' && Number.isFinite(totalKwh) ? totalKwh : null,
    potenciaContratadaKva: potenciaKva,
    termoEnergiaEur: termoEnergiaFinal,
    termoPotenciaEur: termoPotencia,
    priceKwhEur: finalPriceKwh,
    fixedDailyFeeEur: finalFixedDaily,
    debug: {
      usedOcr: single.usedOcr,
      detectionDetails: priceResult.debug
    }
  };
}

export function newInvoiceId() {
  return crypto.randomUUID();
}