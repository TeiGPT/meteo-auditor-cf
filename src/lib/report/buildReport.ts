import {
	Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun,
	AlignmentType, WidthType, SectionType
} from 'docx';

export type SeriesItem = {
	time: string; // ISO preferencial; aceitamos “YYYY-MM-DDTHH:MM” ou semelhante
	wind_kmh: number | null;
	gust_kmh: number | null;
	precip_mm: number | null;
	sources: { wind: string | null; gust: string | null; precip: string | null };
	thunder?: { type: 'count' | 'flag'; value: number | 'TS' | 'VCTS' | null; source: string };
};

export type WarningItem = { start: string; end: string; fenomeno: string; nivel: string; link: string };
export type SourcesLinks = Record<string, string | undefined>;

type Mode = 'daily' | 'hourly';

function fmtNum(v: number | null): string {
	return typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '—';
}
function para(text: string) { return new Paragraph({ text }); }
function bold(text: string) { return new TextRun({ text, bold: true }); }

function dayFromTimeStr(ts: string): string {
	// tenta apanhar YYYY-MM-DD logo no início
	const m = /^(\d{4}-\d{2}-\d{2})/.exec(ts);
	if (m) return m[1];
	const d = new Date(ts);
	if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
	return ts.slice(0, 10); // fallback bruto
}

function buildHourlyTable(series: SeriesItem[]): Table {
	// Sem coluna “Fonte”
	const header = new TableRow({
		children: ['Data-Hora', 'Vento (km/h)', 'Rajada (km/h)', 'Precipitação (mm)', 'Trovoada']
			.map((t) => new TableCell({ children: [new Paragraph({ text: t })] }))
	});
	const rows = series.map((it) => {
		const thunderStr = it.thunder
			? (it.thunder.type === 'flag' ? String(it.thunder.value ?? '') : String(it.thunder.value ?? 0))
			: '';
		return new TableRow({
			children: [
				new TableCell({ children: [new Paragraph({ text: it.time || '—' })] }),
				new TableCell({ children: [new Paragraph({ text: fmtNum(it.wind_kmh) })] }),
				new TableCell({ children: [new Paragraph({ text: fmtNum(it.gust_kmh) })] }),
				new TableCell({ children: [new Paragraph({ text: fmtNum(it.precip_mm) })] }),
				new TableCell({ children: [new Paragraph({ text: thunderStr })] })
			]
		});
	});
	return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...rows] });
}

function buildDailyTable(series: SeriesItem[]): Table {
	type Acc = { n: number; windSum: number; gustMax: number; precipMax: number; thunderCount: number; };
	const byDay = new Map<string, Acc>();

	for (const it of series) {
		const day = dayFromTimeStr(it.time);
		const acc = byDay.get(day) ?? { n: 0, windSum: 0, gustMax: Number.NEGATIVE_INFINITY, precipMax: Number.NEGATIVE_INFINITY, thunderCount: 0 };
		if (typeof it.wind_kmh === 'number') { acc.windSum += it.wind_kmh; acc.n += 1; }
		if (typeof it.gust_kmh === 'number') acc.gustMax = Math.max(acc.gustMax, it.gust_kmh);
		if (typeof it.precip_mm === 'number') acc.precipMax = Math.max(acc.precipMax, it.precip_mm);
		if (it.thunder) {
			if (it.thunder.type === 'flag' && (it.thunder.value === 'TS' || it.thunder.value === 'VCTS')) acc.thunderCount += 1;
			if (it.thunder.type === 'count' && typeof it.thunder.value === 'number' && it.thunder.value > 0) acc.thunderCount += 1;
		}
		byDay.set(day, acc);
	}

	const header = new TableRow({
		children: ['Data', 'Vento médio (km/h)', 'Rajada (km/h)', 'Precipitação máx. (mm/h)', 'Trovoadas (h)']
			.map((t) => new TableCell({ children: [new Paragraph({ text: t })] }))
	});

	const days = [...byDay.keys()].sort();
	const rows = days.map((day) => {
		const acc = byDay.get(day)!;
		const windAvg = acc.n > 0 ? acc.windSum / acc.n : null;
		return new TableRow({
			children: [
				new TableCell({ children: [new Paragraph({ text: day })] }),
				new TableCell({ children: [new Paragraph({ text: fmtNum(windAvg) })] }),
				new TableCell({ children: [new Paragraph({ text: isFinite(acc.gustMax) ? acc.gustMax.toFixed(1) : '—' })] }),
				new TableCell({ children: [new Paragraph({ text: isFinite(acc.precipMax) ? acc.precipMax.toFixed(1) : '—' })] }),
				new TableCell({ children: [new Paragraph({ text: acc.thunderCount ? String(acc.thunderCount) : '—' })] })
			]
		});
	});

	return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...rows] });
}

function extremes(series: SeriesItem[]) {
	let gustMax: { v: number; t: string } | null = null;
	let precipMax: { v: number; t: string } | null = null;

	for (const it of series) {
		if (typeof it.gust_kmh === 'number' && (gustMax == null || it.gust_kmh > gustMax.v)) gustMax = { v: it.gust_kmh, t: it.time };
		if (typeof it.precip_mm === 'number' && (precipMax == null || it.precip_mm > precipMax.v)) precipMax = { v: it.precip_mm, t: it.time };
	}
	return { gustMax, precipMax };
}

export async function buildReport(input: {
	local: { lat: number; lon: number; label?: string };
	period: { startISO: string; endISO: string; tz: 'Europe/Lisbon' };
	series: SeriesItem[];
	warnings: WarningItem[];
	sources_links: SourcesLinks;
	mode?: Mode; // 'daily' (default quando vier daily do UI) ou 'hourly'
}): Promise<{ blob: Blob; arrayBuffer: ArrayBuffer; document: Document }> {
	const { local, period, series, warnings, sources_links } = input;
	const mode: Mode = input.mode ?? 'hourly';

	const title = 'Relatório Meteorológico — Portugal Continental';
	const subtitle = local.label ? `${local.label} (${local.lat.toFixed(3)}, ${local.lon.toFixed(3)})` : `${local.lat.toFixed(3)}, ${local.lon.toFixed(3)}`;
	const rangeStr = `${period.startISO} — ${period.endISO}`;

	const { gustMax, precipMax } = extremes(series);

	const doc = new Document({
		sections: [{
			properties: { type: SectionType.CONTINUOUS },
			children: [
				new Paragraph({ text: title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
				new Paragraph({ text: subtitle, alignment: AlignmentType.CENTER }),
				new Paragraph({ text: rangeStr, alignment: AlignmentType.CENTER }),
				para(''),
				new Paragraph({ text: 'Resumo', heading: HeadingLevel.HEADING_2 }),
				new Paragraph({
					children: [
						bold('Enquadramento: '),
						new TextRun(`Análise ${mode === 'daily' ? 'diária' : 'horária'} do vento a 10 m, rajada e precipitação, no período indicado (fuso ${period.tz}). `),
						new TextRun('Os dados base são horários; quando selecionado "Daily", os valores são agregados por dia (média do vento, rajada máxima diária e precipitação máxima horária por dia).')
					]
				}),
				new Paragraph({
					children: [
						bold('Extremos no intervalo: '),
						new TextRun(`${gustMax ? `rajada máxima ${gustMax.v.toFixed(1)} km/h em ${gustMax.t}` : '—'}; `),
						new TextRun(`${precipMax ? `precipitação máxima horária ${precipMax.v.toFixed(1)} mm em ${precipMax.t}` : '—'}.`)
					]
				}),
				new Paragraph({
					children: [
						bold('Qualidade de dados: '),
						new TextRun('Quando faltaram observações locais, a série foi complementada com reanálises/arquivos históricos. Valores extremos podem refletir picos muito localizados. ')
					]
				}),
				new Paragraph({
					children: [
						bold('Utilização: '),
						new TextRun('Este relatório destina-se a suporte operacional e auditoria; copiar e colar os links listados abaixo diretamente no browser para consulta das fontes.')
					]
				}),
				para(''),

				new Paragraph({ text: `Tabela ${mode === 'daily' ? 'Diária' : 'Horária'}`, heading: HeadingLevel.HEADING_2 }),
				mode === 'daily' ? buildDailyTable(series) : buildHourlyTable(series),

				para(''),
				new Paragraph({ text: 'Avisos IPMA/Meteoalarm', heading: HeadingLevel.HEADING_2 }),
				...(warnings?.length
					? warnings.map((w) => para(`${w.fenomeno} — ${w.nivel} — ${w.start} → ${w.end} — ${w.link || ''}`))
					: [para('Sem avisos no período.')]),
				para(''),

				new Paragraph({ text: 'Fontes e Links', heading: HeadingLevel.HEADING_2 }),
				...buildSourcesLinksPlain(sources_links)
			]
		}]
	});

	const blob = await Packer.toBlob(doc);
	const arrayBuffer = await blob.arrayBuffer();
	return { blob, arrayBuffer, document: doc };
}

function buildSourcesLinksPlain(links: SourcesLinks): Paragraph[] {
	const out: Paragraph[] = [];
	for (const [k, v] of Object.entries(links || {})) {
		if (!v) continue;
		out.push(para(`${k.replace(/_/g, ' ')}: ${v}`)); // texto simples, fácil de copiar/colar
	}
	return out.length ? out : [para('Sem links de fontes.')];
}
