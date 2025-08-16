export type Place = {
	name: string;
	lat: number;
	lon: number;
	admin1?: string;
	admin2?: string;
	country_code?: string;
};

const staticFallbacks: Record<string, Place> = {
	espinho: { name: 'Espinho', lat: 41.007, lon: -8.641, admin1: 'Aveiro', country_code: 'PT' },
	guetim: { name: 'Guetim', lat: 40.984, lon: -8.631, admin1: 'Aveiro', country_code: 'PT' },
	porto: { name: 'Porto', lat: 41.149, lon: -8.61, admin1: 'Porto', country_code: 'PT' },
	lisboa: { name: 'Lisboa', lat: 38.722, lon: -9.139, admin1: 'Lisboa', country_code: 'PT' }
};

export async function resolvePlace(q: string): Promise<Place> {
	const key = q.trim().toLowerCase();
	if (staticFallbacks[key]) return staticFallbacks[key];
	const base = 'https://geocoding-api.open-meteo.com/v1/search';
	const params = new URLSearchParams({ name: q, count: '5', language: 'pt', format: 'json' });
	const url = `${base}?${params.toString()}`;
	try {
		const res = await fetch(url);
		if (!res.ok) return tryFallback(q);
		const json = await res.json();
		const results: any[] = json?.results || [];
		const pt = results.filter((r) => r?.country_code === 'PT');
		if (!pt.length) return tryFallback(q);
		// Prefer Portugal, Continental
		const continental = pt.filter((r) => /continental/i.test(String(r?.admin1) || '') || /portugal,? continental/i.test(String(r?.country) || ''));
		const pool = continental.length ? continental : pt;
		// Choose by population desc
		pool.sort((a, b) => (Number(b?.population || 0) - Number(a?.population || 0)));
		const r = pool[0];
		return {
			name: String(r?.name || q),
			lat: Number(r?.latitude),
			lon: Number(r?.longitude),
			admin1: r?.admin1 ? String(r.admin1) : undefined,
			admin2: r?.admin2 ? String(r.admin2) : undefined,
			country_code: 'PT'
		};
	} catch {
		return tryFallback(q);
	}
}

function tryFallback(q: string): Place {
	const key = q.trim().toLowerCase();
	if (staticFallbacks[key]) return staticFallbacks[key];
	// Fallback to Porto by default
	return staticFallbacks['porto'];
}



