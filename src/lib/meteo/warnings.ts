export type Warning = {
	start: string;
	end: string;
	fenomeno: string;
	nivel: string;
	link: string;
};

export async function fetchIpmaWarnings(
	fetchFn: typeof fetch,
	distrito: string,
	startUTC: Date,
	endUTC: Date
): Promise<{ url: string; warnings: Warning[] }> {
	// IPMA warnings feed; if unavailable, return empty
	const url = 'https://api.ipma.pt/open-data/forecast/warnings/warnings_isn.json';
	try {
		const res = await fetchFn(url);
		if (!res.ok) return { url, warnings: [] };
		const json = await res.json();
		const list: any[] = (json as any[]) || [];
		const out: Warning[] = [];
		const startMs = startUTC.getTime();
		const endMs = endUTC.getTime();
		for (const item of list) {
			const reg = String(item?.distrito ?? item?.region ?? '').toLowerCase();
			if (!reg.includes(distrito.toLowerCase())) continue;
			const ph = String(item?.phenomena ?? item?.fenomeno ?? '');
			if (!/(trovoada|thunder|precip|rain|vento|wind)/i.test(ph)) continue;
			const s = Date.parse(String(item?.start ?? item?.dataInicio ?? item?.startTime ?? ''));
			const e = Date.parse(String(item?.end ?? item?.dataFim ?? item?.endTime ?? ''));
			if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
			if (e < startMs || s > endMs) continue; // only intersecting
			out.push({
				start: new Date(Math.max(s, startMs)).toISOString(),
				end: new Date(Math.min(e, endMs)).toISOString(),
				fenomeno: ph || 'Aviso',
				nivel: String(item?.awareness_level ?? item?.nivel ?? item?.level ?? ''),
				link: String(item?.source ?? item?.link ?? 'https://www.ipma.pt/pt/')
			});
		}
		return { url, warnings: out };
	} catch {
		return { url, warnings: [] };
	}
}

// TODO: fetchMeteoalarm as optional complement

