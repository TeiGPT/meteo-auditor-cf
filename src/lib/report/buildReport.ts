import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, AlignmentType, WidthType, SectionType } from 'docx';
import { toISOInTZ } from '$lib/time';

export type SeriesItem = {
	time: string;
	wind_kmh: number | null;
	gust_kmh: number | null;
	precip_mm: number | null;
	sources: { wind: string | null; gust: string | null; precip: string | null };
	thunder?: { type: 'count' | 'flag'; value: number | 'TS' | 'VCTS' | null; source: string };
};

export type WarningItem = { start: string; end: string; fenomeno: string; nivel: string; link: string };

export type SourcesLinks = Record<string, string | undefined>;

export async function buildReport(input: {
	local: { lat: number; lon: number; label?: string };
	period: { startISO: string; endISO: string; tz: 'Europe/Lisbon' };
	series: SeriesItem[];
	warnings: WarningItem[];
	sources_links: SourcesLinks;
}): Promise<{ blob: Blob; arrayBuffer: ArrayBuffer; document: Document }> {
	const { local, period, series, warnings, sources_links } = input;
	const title = 'Relatório Meteorológico — Portugal Continental';
	const subtitle = local.label ? `${local.label} (${local.lat}, ${local.lon})` : `${local.lat}, ${local.lon}`;
	const tz = period.tz;

	const start = new Date(period.startISO);
	const end = new Date(period.endISO);
	const startStr = toISOInTZ(start.getTime(), tz);
	const endStr = toISOInTZ(end.getTime(), tz);
	const rangeStr = `${startStr} — ${endStr}`;

	// Summary stats
	let maxGust = { value: -Infinity as number, time: '' };
	let maxPrecip = { value: -Infinity as number, time: '' };
	let thunderHours = 0;
	let usedReanalysis = false;
	for (const it of series) {
		if (typeof it.gust_kmh === 'number' && it.gust_kmh > maxGust.value) {
			maxGust = { value: it.gust_kmh, time: it.time };
		}
		if (typeof it.precip_mm === 'number' && it.precip_mm > maxPrecip.value) {
			maxPrecip = { value: it.precip_mm, time: it.time };
		}
		if (it.thunder) {
			if (it.thunder.type === 'flag' && (it.thunder.value === 'TS' || it.thunder.value === 'VCTS')) thunderHours += 1;
			if (it.thunder.type === 'count' && typeof it.thunder.value === 'number' && it.thunder.value > 0) thunderHours += 1;
		}
		if (it.sources.wind === 'open-meteo' || it.sources.gust === 'open-meteo' || it.sources.precip === 'open-meteo') usedReanalysis = true;
	}

	const doc = new Document({
		sections: [
			{
				properties: { type: SectionType.CONTINUOUS },
				children: [
					new Paragraph({ text: title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
					new Paragraph({ text: subtitle, alignment: AlignmentType.CENTER }),
					new Paragraph({ text: rangeStr, alignment: AlignmentType.CENTER }),
					new Paragraph({ text: '' }),
					...(series.length === 0 || series.filter((s) => s.wind_kmh != null || s.gust_kmh != null || s.precip_mm != null).length < Math.max(1, Math.floor(series.length * 0.2))
						? [new Paragraph({ text: 'Sem dados suficientes para o intervalo' }), new Paragraph({ text: '' })]
						: []),
					new Paragraph({ text: 'Resumo', heading: HeadingLevel.HEADING_2 }),
					new Paragraph({ text: `Pico de rajada: ${isFinite(maxGust.value) ? maxGust.value.toFixed(1) + ' km/h' : '—'} em ${maxGust.time || '—'}` }),
					new Paragraph({ text: `Prec. máxima/hora: ${isFinite(maxPrecip.value) ? maxPrecip.value.toFixed(1) + ' mm' : '—'} em ${maxPrecip.time || '—'}` }),
					new Paragraph({ text: `Horas com trovoada: ${thunderHours}` }),
					new Paragraph({ text: usedReanalysis ? 'Observação: dados parcialmente preenchidos por reanálise (Open-Meteo).' : 'Observação: dados observacionais predominantes.' }),
					new Paragraph({ text: '' }),
					new Paragraph({ text: 'Tabela Horária', heading: HeadingLevel.HEADING_2 }),
					buildTable(series, tz),
					new Paragraph({ text: '' }),
					new Paragraph({ text: 'Avisos IPMA/Meteoalarm', heading: HeadingLevel.HEADING_2 }),
					...buildWarnings(warnings, tz),
					new Paragraph({ text: '' }),
					new Paragraph({ text: 'Fontes e Links', heading: HeadingLevel.HEADING_2 }),
					...buildSourcesLinks(sources_links)
				]
			}
		]
	});

	const blob = await Packer.toBlob(doc);
	const arrayBuffer = await blob.arrayBuffer();
	return { blob, arrayBuffer, document: doc };
}

function buildTable(series: SeriesItem[], tz: string): Table {
	const header = new TableRow({
		children: ['Data-Hora', 'Vento (km/h)', 'Rajada (km/h)', 'Precipitação (mm)', 'Trovoada', 'Fonte'].map((t) =>
			new TableCell({ children: [new Paragraph({ text: t })] })
		)
	});
	const rows = series.map((it) => {
		const thunderStr = it.thunder ? (it.thunder.type === 'flag' ? String(it.thunder.value ?? '') : String(it.thunder.value ?? 0)) : '';
		const fonteParts: string[] = [];
		if (it.sources.wind) fonteParts.push(`${it.sources.wind === 'meteostat' ? 'M' : 'OM'}:W`);
		if (it.sources.gust) fonteParts.push(`${it.sources.gust === 'meteostat' ? 'M' : 'OM'}:G`);
		if (it.sources.precip) fonteParts.push(`${it.sources.precip === 'meteostat' ? 'M' : 'OM'}:P`);
		if (it.thunder) fonteParts.push(it.thunder.source.toUpperCase());
		const fonte = fonteParts.join(' / ');
		return new TableRow({
			children: [
				new TableCell({ children: [new Paragraph({ text: it.time || '—' })] }),
				new TableCell({ children: [new Paragraph({ text: fmtNum(it.wind_kmh) })] }),
				new TableCell({ children: [new Paragraph({ text: fmtNum(it.gust_kmh) })] }),
				new TableCell({ children: [new Paragraph({ text: fmtNum(it.precip_mm) })] }),
				new TableCell({ children: [new Paragraph({ text: thunderStr })] }),
				new TableCell({ children: [new Paragraph({ text: fonte })] })
			]
		});
	});
	return new Table({
		width: { size: 100, type: WidthType.PERCENTAGE },
		rows: [header, ...rows]
	});
}

function fmtNum(v: number | null): string {
	return typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '—';
}

function buildWarnings(list: WarningItem[], tz: string): Paragraph[] {
	if (!list || list.length === 0) return [new Paragraph({ text: 'Sem avisos no período.' })];
	return list.map((w) => new Paragraph({ text: `${w.fenomeno} — ${w.nivel} — ${w.start} → ${w.end} — ${w.link}` }));
}

function buildSourcesLinks(links: SourcesLinks): Paragraph[] {
	const out: Paragraph[] = [];
	for (const [k, v] of Object.entries(links)) {
		if (!v) continue;
		out.push(new Paragraph({ text: `${k}: ${v}` }));
	}
	return out.length ? out : [new Paragraph({ text: 'Sem links de fontes.' })];
}
