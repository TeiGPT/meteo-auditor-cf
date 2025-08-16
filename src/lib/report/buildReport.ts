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

// Usa o helper de tempo que já tens no projecto
import { toISOInTZ } from "../time";

type SeriesItem = {
  epoch: number; // segundos ou ms
  wind_kmh?: number | null;
  gust_kmh?: number | null;
  precip_mm?: number | null; // valor horario
  thunder?: number | boolean | null; // opcional
};

function msFromEpoch(e: number) {
  return e < 2e10 ? e * 1000 : e;
}

function dayKey(d: Date, tz: string) {
  // YYYY-MM-DD
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

// Agrega série HORÁRIA -> DIÁRIA
function aggregateDaily(items: SeriesItem[], tz: string, thunderDaily?: Record<string, number>) {
  type Acc = {
    windSum: number; windN: number;
    gustMax: number | null;
    precipHourMax: number | null;
    thunderCount: number; // horas com TS (se vier hourly) quando não existir thunderDaily
  };
  const byDay = new Map<string, Acc>();

  for (const it of items || []) {
    const d = new Date(msFromEpoch(it.epoch));
    const day = dayKey(d, tz);
    const acc = byDay.get(day) || { windSum: 0, windN: 0, gustMax: null, precipHourMax: null, thunderCount: 0 };
    if (it.wind_kmh != null && !Number.isNaN(it.wind_kmh)) {
      acc.windSum += it.wind_kmh;
      acc.windN += 1;
    }
    if (it.gust_kmh != null && !Number.isNaN(it.gust_kmh)) {
      acc.gustMax = acc.gustMax == null ? it.gust_kmh : Math.max(acc.gustMax, it.gust_kmh);
    }
    if (it.precip_mm != null && !Number.isNaN(it.precip_mm)) {
      acc.precipHourMax = acc.precipHourMax == null ? it.precip_mm : Math.max(acc.precipHourMax, it.precip_mm);
    }
    if (it.thunder) acc.thunderCount += 1;
    byDay.set(day, acc);
  }

  const rows = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([day, acc]) => {
    const windAvg = acc.windN > 0 ? acc.windSum / acc.windN : null;
    const gust = acc.gustMax ?? null;
    const precipMax = acc.precipHourMax ?? null;
    let thunderVal: number | string = "—";
    if (thunderDaily && thunderDaily[day] != null) {
      thunderVal = thunderDaily[day];
    } else {
      thunderVal = acc.thunderCount > 0 ? acc.thunderCount : "—";
    }
    return {
      day,
      windAvg,
      gust,
      precipMax,
      thunder: thunderVal
    };
  });

  return rows;
}

// Procura extremos na série horária (para o resumo)
function findExtremes(items: SeriesItem[], tz: string) {
  let gustMax: { v: number, iso: string } | null = null;
  let precipMax: { v: number, iso: string } | null = null;

  for (const it of items || []) {
    const iso = toISOInTZ(new Date(msFromEpoch(it.epoch)), tz);
    if (it.gust_kmh != null && !Number.isNaN(it.gust_kmh)) {
      if (!gustMax || it.gust_kmh > gustMax.v) gustMax = { v: it.gust_kmh, iso };
    }
    if (it.precip_mm != null && !Number.isNaN(it.precip_mm)) {
      if (!precipMax || it.precip_mm > precipMax.v) precipMax = { v: it.precip_mm, iso };
    }
  }
  return { gustMax, precipMax };
}

export async function buildReport(ctx: any) {
  // Inputs tolerantes a variações do endpoint
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

  // Agregações
  const daily = aggregateDaily(items, tz, thunderDaily);
  const daysWithThunder = daily.filter(r => (typeof r.thunder === "number" ? r.thunder > 0 : r.thunder !== "—")).length;
  const totalThunderHours = daily.reduce((a, r) => a + (typeof r.thunder === "number" ? r.thunder : 0), 0);
  const { gustMax, precipMax } = findExtremes(items, tz);

  // ========= Document =========
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
      children: [
        new TextRun(`${placeName} — ${admin1} (${lat.toFixed(3)}, ${lon.toFixed(3)})`)
      ]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun(`${startISO} — ${endISO}`)]
    }),
    new Paragraph({ text: "" })
  );

  // Resumo (mais completo)
  const resumoParas: Paragraph[] = [];
  resumoParas.push(
    para("Resumo"),
    new Paragraph({
      children: [
        strong("Enquadramento: "),
        new TextRun(
          `Análise histórica diária para o período indicado (fuso ${tz}). Os valores apresentados correspondem a média diária do vento a 10 m, rajada máxima diária e precipitação máxima horária por dia.`
        )
      ]
    }),
    new Paragraph({
      children: [
        strong("Extremos do intervalo: "),
        new TextRun(
          `${gustMax ? `rajada máxima ${gustMax.v.toFixed(1)} km/h em ${gustMax.iso}` : "—"}; `
        ),
        new TextRun(
          `${precipMax ? `precipitação máxima horária ${precipMax.v.toFixed(1)} mm/h em ${precipMax.iso}` : "—"}`
        )
      ]
    }),
    new Paragraph({
      children: [
        strong("Trovoadas: "),
        new TextRun(
          `${daysWithThunder} dia(s) com trovoada${totalThunderHours ? ` (${totalThunderHours} h no total)` : ""}.`
        )
      ]
    }),
    new Paragraph({
      children: [
        strong("Qualidade de dados: "),
        new TextRun(
          `valores agregados a partir de séries horárias. Quando faltaram observações locais, foi utilizada reanálise (Open-Meteo ERA5/Archive) e/ou estação de referência próxima.`
        )
      ]
    }),
    para("") // espaço
  );
  sections.push(...resumoParas);

  // Tabela diária (SEM coluna Fonte)
  const tableRows: TableRow[] = [];
  tableRows.push(
    new TableRow({
      cantSplit: true,
      children: [
        headerCell("Data"),
        headerCell("Vento médio (km/h)"),
        headerCell("Rajada (km/h)"),
        headerCell("Precipitação (mm/h)"),
        headerCell("Trovoadas")
      ]
    })
  );

  for (const r of daily) {
    tableRows.push(
      new TableRow({
        cantSplit: true,
        children: [
          cell(r.day, false, AlignmentType.LEFT),
          cell(fmt1(r.windAvg)),
          cell(fmt1(r.gust)),
          cell(fmt1(r.precipMax)),
          cell(typeof r.thunder === "number" ? String(r.thunder) : String(r.thunder))
        ]
      })
    );
  }

  sections.push(
    new Paragraph({ text: "Tabela Diária", heading: HeadingLevel.HEADING_2 }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: tableRows,
      borders: {
        top: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
        bottom: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
        left: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
        right: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "DDDDDD" },
        insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "DDDDDD" }
      }
    }),
    para("")
  );

  // Avisos (se houver)
  if (Array.isArray(warnList) && warnList.length) {
    sections.push(new Paragraph({ text: "Avisos Oficiais", heading: HeadingLevel.HEADING_2 }));
    for (const w of warnList) {
      const line =
        `${w?.source ?? "IPMA"} — ${w?.phenomenon ?? "Fenómeno"} (${w?.level ?? "Nível"}): ${w?.start ?? ""} → ${w?.end ?? ""}`;
      sections.push(new Paragraph(line));
      if (w?.url && /^https?:\/\//i.test(w.url)) {
        sections.push(linkPara("→ abrir aviso", w.url));
      }
    }
    sections.push(para(""));
  }

  // Fontes e Links (clicáveis)
  const linkPairs: Array<{ title: string; url: string }> = [];

  for (const [k, v] of Object.entries(sources_links || {})) {
    if (v && /^https?:\/\//i.test(v)) {
      linkPairs.push({ title: k.replace(/_/g, " "), url: v });
    }
  }
  // Notícias (se houver)
  for (const n of newsList || []) {
    if (n?.url && /^https?:\/\//i.test(n.url)) {
      linkPairs.push({ title: n.title ? `Notícia — ${n.title}` : "Notícia", url: n.url });
    }
  }

  if (linkPairs.length) {
    sections.push(new Paragraph({ text: "Fontes e Links", heading: HeadingLevel.HEADING_2 }));
    for (const p of linkPairs) sections.push(linkPara(p.title, p.url));
  }

  const doc = new Document({
    sections: [{ children: sections }]
  });

  // Mantém comportamento actual (retorna Blob; o endpoint converte se precisar)
  const blob = await Packer.toBlob(doc);
  return blob;
}
