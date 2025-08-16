export type ThunderCount = Map<number, number>; // epochHour -> count
export type ThunderFlag = 'TS' | 'VCTS' | null;

export async function fetchIpmaDeaLast24h(fetchFn: typeof fetch): Promise<{ url: string; counts: ThunderCount }> {
	// Best-effort endpoint guess; if it fails, return empty map
	const candidates = [
		'https://api.ipma.pt/open-data/lightning/last24h.json',
		'https://api.ipma.pt/open-data/lightning/observations/last24h.json'
	];
	for (const url of candidates) {
		try {
			const res = await fetchFn(url);
			if (!res.ok) continue;
			const json = await res.json();
			const counts: ThunderCount = new Map();
			const items: Array<any> = (json?.data as any[]) || (json as any[]);
			if (!items || !Array.isArray(items) || items.length === 0) return { url, counts };
			for (const item of items) {
				// Expect entries per 10-min with timestamp (ISO) and count
				const ts = item?.time ?? item?.t ?? item?.date ?? null;
				const c = item?.count ?? item?.n ?? item?.value ?? 0;
				if (!ts) continue;
				const epoch = Date.parse(String(ts));
				if (Number.isNaN(epoch)) continue;
				const epochHour = Math.floor(epoch / (3600 * 1000)) * 3600 * 1000;
				const prev = counts.get(epochHour) ?? 0;
				counts.set(epochHour, prev + (Number.isFinite(Number(c)) ? Number(c) : 0));
			}
			return { url, counts };
		} catch {
			continue;
		}
	}
	return { url: candidates[candidates.length - 1], counts: new Map() };
}

export async function fetchOgimetMetarRange(
	fetchFn: typeof fetch,
	icao: string,
	startUTC: Date,
	endUTC: Date
): Promise<{ url: string; metars: string[] }> {
	const y1 = startUTC.getUTCFullYear();
	const m1 = String(startUTC.getUTCMonth() + 1).padStart(2, '0');
	const d1 = String(startUTC.getUTCDate()).padStart(2, '0');
	const h1 = String(startUTC.getUTCHours()).padStart(2, '0');
	const y2 = endUTC.getUTCFullYear();
	const m2 = String(endUTC.getUTCMonth() + 1).padStart(2, '0');
	const d2 = String(endUTC.getUTCDate()).padStart(2, '0');
	const h2 = String(endUTC.getUTCHours()).padStart(2, '0');
	const url = `https://www.ogimet.com/display_metars2.php?lang=en&lugar=${encodeURIComponent(
		icao
	)}&tipo=SA&ord=REV&nil=SI&fmt=txt&ano=${y1}&mes=${m1}&day=${d1}&hora=${h1}&anof=${y2}&mesf=${m2}&dayf=${d2}&horaf=${h2}&minf=59&send=send`;
	try {
		const res = await fetchFn(url);
		if (!res.ok) return { url, metars: [] };
		const txt = await res.text();
		const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		// Ogimet includes headers; keep lines that look like METAR/SPECI with station code
		const metars = lines.filter((l) => /^(METAR|SPECI)?\s*([A-Z]{4})\s/.test(l) || /^[A-Z]{4}\s\d{6}Z/.test(l));
		return { url, metars };
	} catch {
		return { url, metars: [] };
	}
}

export async function fetchNoaaMetarRange(
	fetchFn: typeof fetch,
	icao: string,
	startUTC: Date,
	endUTC: Date
): Promise<{ url: string; metars: { raw: string; time: string }[] }> {
	const startStr = `${startUTC.getUTCFullYear()}${String(startUTC.getUTCMonth() + 1).padStart(2, '0')}${String(
		startUTC.getUTCDate()
	).padStart(2, '0')}T${String(startUTC.getUTCHours()).padStart(2, '0')}00`;
	const endStr = `${endUTC.getUTCFullYear()}${String(endUTC.getUTCMonth() + 1).padStart(2, '0')}${String(
		endUTC.getUTCDate()
	).padStart(2, '0')}T${String(endUTC.getUTCHours()).padStart(2, '0')}59`;
	const url = `https://aviationweather.gov/adds/dataserver_current/httpparam?datasource=metars&requestType=retrieve&format=xml&stationString=${encodeURIComponent(
		icao
	)}&startTime=${startStr}&endTime=${endStr}`;
	try {
		const res = await fetchFn(url);
		if (!res.ok) return { url, metars: [] };
		const xml = await res.text();
		const raws = Array.from(xml.matchAll(/<raw_text>(.*?)<\/raw_text>/g)).map((m) => m[1]);
		const times = Array.from(xml.matchAll(/<observation_time>(.*?)<\/observation_time>/g)).map((m) => m[1]);
		const metars = raws.map((raw, i) => ({ raw, time: times[i] ?? '' }));
		return { url, metars };
	} catch {
		return { url, metars: [] };
	}
}

export function parseMetarForThunder(metarTxt: string): ThunderFlag {
	if (!metarTxt) return null;
	if (/\bVCTS\b/.test(metarTxt)) {
		if (/\bTS(GR|RA|\+TS|TS|\-TS)\b/.test(metarTxt) || /\b\+?TS\b/.test(metarTxt)) return 'TS';
		return 'VCTS';
	}
	if (/\bTS(GR|RA|\+TS|TS|\-TS)\b/.test(metarTxt) || /\b\+?TS\b/.test(metarTxt)) return 'TS';
	return null;
}

export function metarHoursMap(
	entries: Array<{ raw: string; epochMs: number }>
): Map<number, ThunderFlag> {
	const map = new Map<number, ThunderFlag>();
	for (const e of entries) {
		const flag = parseMetarForThunder(e.raw);
		const epochHour = Math.floor(e.epochMs / (3600 * 1000)) * 3600 * 1000;
		const prev = map.get(epochHour);
		if (flag === 'TS') {
			map.set(epochHour, 'TS');
		} else if (flag === 'VCTS' && prev !== 'TS') {
			map.set(epochHour, 'VCTS');
		} else if (!prev) {
			map.set(epochHour, null);
		}
	}
	return map;
}

