import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';
import { parse as parseCsv } from 'csv-parse/sync';
import { getCollections, initDb, type ErseTariffDoc } from './db';

function normalizeHeader(s: string) {
  return String(s ?? '').replace(/^\uFEFF/, '').replace(/ï»¿/g, '').trim();
}

function toNumberPt(raw: unknown) {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  const n = Number(s.replace(/\s+/g, '').replace(',', '.'));
  return n;
}

function findEntry(zip: AdmZip, wantedNameEndsWith: string) {
  const entries = zip.getEntries();
  const match = entries.find((e: AdmZip.IZipEntry) => e.entryName.toLowerCase().endsWith(wantedNameEndsWith.toLowerCase()));
  return match ?? null;
}

export type ErseRefreshResult = {
  ok: boolean;
  importedAt: Date;
  sourceUrl: string;
  sha256: string;
  rowCount: number;
  error?: string;
};

export async function refreshErseTariffsFromZipUrl(url: string): Promise<ErseRefreshResult> {
  const importedAt = new Date();

  const res = await fetch(url, { headers: { 'User-Agent': 'Kynex/1.0' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, importedAt, sourceUrl: url, sha256: '', rowCount: 0, error: `HTTP ${res.status} ao descarregar ZIP. ${text.slice(0, 200)}` };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  const db = await initDb();
  const cols = getCollections(db);
  const importId = crypto.randomUUID();

  try {
    const zip = new AdmZip(buf);

    const condEntry = findEntry(zip, 'CondComerciais.csv');
    const precosEntry = findEntry(zip, 'Precos_ELEGN.csv');

    if (!condEntry || !precosEntry) {
      const names = zip.getEntries().map((e: AdmZip.IZipEntry) => e.entryName).slice(0, 30);
      throw new Error(`ZIP não contém CSVs esperados. Entradas: ${names.join(', ')}`);
    }

    const condCsv = iconv.decode(condEntry.getData(), 'latin1');
    const precosCsv = iconv.decode(precosEntry.getData(), 'latin1');

    const condRows = parseCsv(condCsv, { columns: true, delimiter: ';', relax_quotes: true, skip_empty_lines: true });
    const precosRows = parseCsv(precosCsv, { columns: true, delimiter: ';', relax_quotes: true, skip_empty_lines: true });

    const cond = (condRows as any[]).map((r) => {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(r)) out[normalizeHeader(k)] = v;
      // garantir col Comercializador
      if (out.COM && !out.Comercializador) out.Comercializador = out.COM;
      return out;
    });

    const precos = (precosRows as any[]).map((r) => {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(r)) out[normalizeHeader(k)] = v;
      if (out.COD_Prop && !out.COD_Proposta) out.COD_Proposta = out.COD_Prop;
      return out;
    });

    // índice rápido de catálogo por proposta
    const catalogByProposta = new Map<string, { Comercializador: string; NomeProposta: string; TxTModalidade?: string }>();
    for (const r of cond) {
      const cod = String(r.COD_Proposta ?? '').trim();
      if (!cod) continue;
      catalogByProposta.set(cod, {
        Comercializador: String(r.Comercializador ?? '').trim(),
        NomeProposta: String(r.NomeProposta ?? '').trim(),
        TxTModalidade: r.TxTModalidade ? String(r.TxTModalidade).trim() : undefined
      });
    }

    // coluna de energia varia: tentamos detetar
    const example = precos[0] ?? {};
    const energyCol = Object.keys(example).find((c) => c.includes('TV|TVFV|T') || c.includes('TVV|TVC') || c.toLowerCase().includes('tv|'));
    if (!energyCol) {
      throw new Error('Não foi possível detetar a coluna de preço energia (kWh) no CSV Precos_ELEGN.csv');
    }

    const docs: ErseTariffDoc[] = [];
    for (const r of precos) {
      const cod = String(r.COD_Proposta ?? '').trim();
      if (!cod) continue;
      const cat = catalogByProposta.get(cod);
      if (!cat) continue;

      const potCont = toNumberPt(r.Pot_Cont);
      const fixed = toNumberPt(r.TF);
      const kwh = toNumberPt((r as any)[energyCol]);

      if (!Number.isFinite(potCont) || !Number.isFinite(fixed) || !Number.isFinite(kwh)) continue;
      if (kwh <= 0 || fixed <= 0) continue;

      const key = `${cod}:${potCont}`;
      docs.push({
        key,
        cod_proposta: cod,
        comercializador: cat.Comercializador || 'Desconhecido',
        nome_proposta: cat.NomeProposta || 'Proposta',
        modalidade: cat.TxTModalidade,
        pot_cont: potCont,
        price_kwh_eur: kwh,
        fixed_daily_fee_eur: fixed,
        imported_at: importedAt,
        source_url: url,
        raw: r
      });
    }

    // upsert em bulk
    if (docs.length) {
      await cols.erseTariffs.bulkWrite(
        docs.map((d) => ({
          updateOne: {
            filter: { key: d.key },
            update: { $set: d },
            upsert: true
          }
        })),
        { ordered: false }
      );
    }

    await cols.erseTariffImports.insertOne({
      id: importId,
      source_url: url,
      fetched_at: importedAt,
      sha256,
      status: 'ok',
      row_count: docs.length
    });

    return { ok: true, importedAt, sourceUrl: url, sha256, rowCount: docs.length };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    await cols.erseTariffImports.insertOne({
      id: importId,
      source_url: url,
      fetched_at: importedAt,
      sha256,
      status: 'error',
      error: msg
    });

    return { ok: false, importedAt, sourceUrl: url, sha256, rowCount: 0, error: msg };
  }
}
