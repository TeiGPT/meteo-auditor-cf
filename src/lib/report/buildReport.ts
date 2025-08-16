// DOCX builder — versão diária + resumo expandido + links clicáveis
// Gera tabela diária: Data | Vento médio (km/h) | Rajada (km/h) | Precipitação (mm/h) | Trovoadas
// Remove a coluna "Fonte" e melhora o resumo.
// Aceita ctx flexível (mantém compatibilidade com o endpoint actual).

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";

import { toISOInTZ } from "../time";

type SeriesItem = {
  epoch?: number; // segundos OU ms (opcional)
  date?: string;  // "YYYY-MM-DD" (opcional)
  time?: string;  // ISO (opcional)
  datetime?: string; // ISO (opcional)

  wind_kmh?: number | null;
  gust_kmh?: number | null;
  precip_mm?: number | null; // valor horário (se vier diário pode já estar agregado)
  thunder?: number | boolean | null; // nº de horas com trovoada (hourly) ou bandeira
};

// ---------- Helpers de tempo/dados ----------

function msFromEpoch(e: number) {
  // aceita epoch em segundos ou ms
  return e < 2e10 ? e * 1000 : e;
}

function dateFromItem(it: SeriesItem): Date | null {
  if (it == null) return null;
  if (typeof it.epoch === "number" && Number.isFinite(it.epoch)) {
    return new Date(msFromEpoch(it.epoch));
  }
  if (typeof it.time === "string") {
    const d = new Date(it.time);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof it.datetime === "string") {
    const d = new Date(it.datetime);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof it.date === "string") {
    const d = new Date(it.date + "T00:00:00");
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function dayKey(d: Date, tz: string) {
  // YYYY-MM-DD na timezone desejada
  const iso = toISOInTZ(d, tz);
  return iso.slice(0, 10);
}

function fmt1(x: number | null | undefined, unit = "") {
  if (x == null || Number.isNaN(x)) return "—";
  return `${x.toFixed(1)}${unit}`;
}

function cell(text: string, bold = false, align: AlignmentType = AlignmentType.CENTER) {
  return new TableCell({
    children: [
      new Paragraph({
        alignment: align,
        children: [new TextRun({ text, bold })]
      })
    ]
  });
}

function headerCell(text: string) {
  return cell(text, true, AlignmentType.CENTER);
}

function strong(text: string) {
  return new TextRun({ text, bold: true });
}

function para(text: string) {
  return new Paragraph(text);
}

function linkPara(title: string, url: string) {
  const text = title || url;
  return new Paragraph({
    children: [
      new ExternalHyperlink({
        link: url,
        children: [new TextRun({ text, style: "Hyperlink" })]
      })
    ]
  });
}

// ---------- Agregações ----------

// Agrega série HORÁRIA (ou mistura) -> DIÁRIA
function aggregateDaily(items: SeriesItem[], tz: string, thunderDaily?: Record<string, number>) {
  type Acc = {
    windSum: number; windN: number;
    gustMax: number | null;
    precipHourMax: number | null;
    thunderCount: number; // horas com TS (se vier hourly) quando não existir thunderDaily
  };
  const byDay = new Map<string, Acc>();

  for (const it of items || []) {
    const d = dateFromItem(it);
    if (!d || Number.isNaN(d.getTime())) continue;

    const day = dayKey(d, tz);
    const acc = byDay.get(day) || {
      windSum: 0, windN: 0,
      gustMax: null,
      precipHourMax: null,
      thunderCount: 0
    };

    if (it.wind_kmh != null && !Number.isNaN(it.wind_kmh)) {
      acc.windSum += it.wind_kmh;
      acc.windN += 1;
    }
    if (it.gust_kmh != null && !Number.isNaN(it.gust_kmh)) {
      acc.gustMax = acc.gustMax == null ? it.gust_kmh : Math.max(acc.gustMax, it.gust_kmh);
    }
    if (it.precip_mm != null && !Number.isNaN(it.precip_mm)) {
      // queremos o pico horário do dia
      acc.precipHourMax = acc.precipHourMax == null ? it.precip_mm : Math.max(acc.precipHourMax, it.precip_mm);
    }
    if (it.thunder) acc.thunderCount += Number(it.thunder) || 1;

    byDay.set(day, acc);
  }

  const rows = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, acc]) => {
      const windAvg = acc.windN > 0 ? acc.windSum / acc.windN : null;
      const gust = acc.gustMax ?? null;
      const precipMax = acc.precipHourMax ?? null;
      let thunderVal: number | string = "—";
      if (thunderDaily && thunderDaily[day] != null) {
        thunderVal = thunderDaily[day];
      } else {
        thunderVal = acc.thunderCount > 0 ? acc.thunderCount : "—";
      }
      return { day, windAvg, gust, precipMax, thunder: thunderVal };
    });

  return rows;
}

// Procura extremos na série horária (para o resumo)
function findExtremes(items: SeriesItem[], tz: string) {
  let gustMax: { v: number, iso: string } | null = null;
  let precipMax: { v: number, iso: string } | null = null;

  for (const it of items || []) {
    if (it == null) continue;
    const d = dateFromItem(it);
    if (!d || Number.isNaN(d.getTime())) continue;

    const iso = toISOInTZ(d, tz);
    if (it.gust_kmh != null && !Number.isNaN(it.gust_kmh)) {
      if (!gustMax || it.gust_kmh > gustMax.v) gustMax = { v: it.gust_kmh, iso };
    }
    if (it.precip_mm != null && !Number.isNaN(it.precip_mm)) {
      if (!precipMax || it.precip_mm > precipMax.v) precipMax = { v: it.precip_mm, iso };
    }
  }
  return { gustMax, precipMax };
}

// ---------- Builder principal ----------

export async function buildReport(ctx: any) {
  const tz: string = ctx?.tz || "Europe/Lisbon";

  const place = ctx?.place || ctx?.location || {};
  const placeName: string = place?.name || "—";
  const admin1: string = place?.admin1 || "—";
  const lat = place?.lat ?? place?.latitude ?? 0;
  const lon = place?.lon ?? place?.longitude ?? 0;

  const startISO: string =
    ctx?.startISO || ctx?.start || ctx?.period?.startISO || ctx?.range?.startISO || ctx?.data_inicio_iso || ctx?.inicio_iso || "—";
  const endISO: string =
    ctx?.endISO || ctx?.end || ctx?.period?.endISO || ctx?.range?.endISO || ctx?.data_fim_iso || ctx?.fim_iso || "—";

  const items: SeriesItem[] = ctx?.items || ctx?.series || [];
  const thunderDaily: Record<string, number> | undefined =
    ctx?.thunderDaily || ctx?.thunder_daily || ctx?.ipma_dea_daily;

  // Links e avisos
  const sources_links: Record<string, string> = ctx?.sources_links || ctx?.links || {};
  const warnList: Array<any> = ctx?.warnings || ctx?.ipma_warnings || [];
  const newsList: Array<{ title?: string; url: string; date?: string }> = ctx?.news || ctx?.news_links || [];

  // Agregações e métricas
  const daily = aggregateDaily(items, tz, thunderDaily);
  const daysWithThunder = daily.filter(r => (typeof r.thunder === "number" ? r.thunder > 0 : r.thunder !== "—")).length;
  const totalThunderHours = daily.reduce((a, r) => a + (typeof r.thunder === "number" ? r.thunder : 0), 0);
  const { gustMax, precipMax } = findExtremes(items, tz);

  // ========= Documento =========
  const sections: Paragraph[] | any[] = [];

  // Título
  sections.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun("Relatório Meteorológico — Portugal Continental")]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun(`${placeName} — ${admin1} (${lat.toFixed(3)}, ${lon.toFixed(3)})`)]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun(`${startISO} — ${endISO}`)]
    }),
    new Paragraph({ text: "" })
  );

  // Resumo
  const resumoParas: Paragraph[] = [];
  resumoParas.push(
    para("Resumo"),
    new Paragraph({
      children: [
        strong("Enquadramento: "),
        new TextRun(
          `Análise histórica diária para o período indicado (fuso ${tz}). Os valores apresentados correspondem à média diária do vento a 10 m, rajada máxima diária e precipitação máxima horária por dia.`
        )
      ]
    }),
    new Paragraph({
      children: [
        strong("Extremos do intervalo: "),
        new TextRun(
          `$
