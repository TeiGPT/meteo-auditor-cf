/* Utilities to fetch Meteostat and Open-Meteo hourly data and merge them */

export type Source = 'meteostat' | 'open-meteo';

export type HourlyRecord = {
	wind_ms: number | null;
	gust_ms: number | null;
	precip_mm: number | null;
};

export type SourceRecord = {
	wind: Source | null;
	gust: Source | null;
	precip: Source | null;
};

export type HourlyMerged = {
	time: string;
	wind_kmh: number | null;
	gust_kmh: number | null;
	precip_mm: number | null;
	sources: SourceRecord;
};

export function toKmH(ms: number | null | undefined): number | null {
	if (ms === null || ms === undefined) return null;
	return ms * 3.6;
}

export function round1(v: number | null): number | null {
	if (v === null || Number.isNaN(v)) return null;
	return Math.round(v * 10) / 10;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}

export function ymd(date: Date): string {
	const y = date.getUTCFullYear();
	const m = pad2(date.getUTCMonth() + 1);
	const d = pad2(date.getUTCDate());
	return `${y}-${m}-${d}`;
}

export function buildOffsetStringFromSeconds(offsetSeconds: number): string {
	const sign = offsetSeconds >= 0 ? '+' : '-';
	const abs = Math.abs(offsetSeconds);
	const hh = pad2(Math.floor(abs / 3600));
	const mm = pad2(Math.floor((abs % 3600) / 60));
	return `${sign}${hh}:${mm}`;
}

export function toLisbonIsoWithOffset(epochMs: number, offsetSeconds: number): string {
	const local = new Date(epochMs + offsetSeconds * 1000);
	const y = local.getUTCFullYear();
	const m = pad2(local.getUTCMonth() + 1);
	const d = pad2(local.getUTCDate());
	const h = pad2(local.getUTCHours());
	const offset = buildOffsetStringFromSeconds(offsetSeconds);
	return `${y}-${m}-${d}T${h}:00:00${offset}`;
}

export type MeteostatResult = {
	url: string;
	available: boolean;
	time: string[];
	ws: Array<number | null>;
	wpgt: Array<number | null>;
	prcp: Array<number | null>;
	size: number;
};

export type OpenMeteoResult = {
	url: string;
	available: boolean;
	time: string[];
	wind_speed_10m: Array<number | null>;
	wind_gusts_10m: Array<number | null>;
	precipitation: Array<number | null>;
	utc_offset_seconds: number;
	size: number;
};

export async function fetchMeteostatHourly(
	fetchFn: typeof fetch,
	lat: number,
	lon: number,
	startISODate: string,
	endISODate: string
): Promise<MeteostatResult> {
	const base = 'https://api.meteostat.net/v2/point/hourly';
	const params = new URLSearchParams({
		lat: String(lat),
		lon: String(lon),
		start: startISODate,
		end: endISODate,
		tz: 'Europe/Lisbon',
		model: 'true'
	});
	const url = `${base}?${params.toString()}`;
	try {
		const headers: Record<string, string> = {};
		const apiKey = (globalThis as any)?.process?.env?.METEOSTAT_API_KEY;
		if (apiKey) headers['X-Api-Key'] = String(apiKey);
		const res = await fetchFn(url, { headers });
		if (!res.ok) {
			return { url, available: false, time: [], ws: [], wpgt: [], prcp: [], size: 0 };
		}
		const json = await res.json().catch(() => ({} as any));
		const data: Array<any> = (json?.data as any[]) || [];
		if (!data.length) return { url, available: false, time: [], ws: [], wpgt: [], prcp: [], size: 0 };
		const time: string[] = data.map((r) => String(r.time ?? r.date ?? ''));
		const ws = data.map((r) => (r.ws ?? r.wspd ?? null));
		const wpgt = data.map((r) => (r.wpgt ?? null));
		const prcp = data.map((r) => (r.prcp ?? null));
		return { url, available: true, time, ws, wpgt, prcp, size: time.length };
	} catch {
		return { url, available: false, time: [], ws: [], wpgt: [], prcp: [], size: 0 };
	}
}

export async function fetchOpenMeteoHourly(
	fetchFn: typeof fetch,
	lat: number,
	lon: number,
	startISODate: string,
	endISODate: string,
	tz = 'Europe/Lisbon'
): Promise<OpenMeteoResult> {
	const base = 'https://reanalysis.open-meteo.com/v1/era5';
	const params = new URLSearchParams({
		latitude: String(lat),
		longitude: String(lon),
		hourly: ['wind_speed_10m', 'wind_gusts_10m', 'precipitation'].join(','),
		start_date: startISODate,
		end_date: endISODate,
		timezone: tz
	});
	const url = `${base}?${params.toString()}`;
	try {
		const res = await fetchFn(url);
		if (!res.ok) return { url, available: false, time: [], wind_speed_10m: [], wind_gusts_10m: [], precipitation: [], utc_offset_seconds: 0, size: 0 };
		const json = await res.json();
		const hourly = json?.hourly ?? {};
		const time: string[] = (hourly?.time as string[]) ?? [];
		const wind_speed_10m = (hourly?.wind_speed_10m as Array<number | null>) ?? [];
		const wind_gusts_10m = (hourly?.wind_gusts_10m as Array<number | null>) ?? [];
		const precipitation = (hourly?.precipitation as Array<number | null>) ?? [];
		const utc_offset_seconds: number = Number(json?.utc_offset_seconds ?? 0);
		const size = time.length;
		if (!size) return { url, available: false, time: [], wind_speed_10m: [], wind_gusts_10m: [], precipitation: [], utc_offset_seconds, size: 0 };
		return { url, available: true, time, wind_speed_10m, wind_gusts_10m, precipitation, utc_offset_seconds, size };
	} catch {
		return { url, available: false, time: [], wind_speed_10m: [], wind_gusts_10m: [], precipitation: [], utc_offset_seconds: 0, size: 0 };
	}
}

function parseLocalHourToEpoch(localHour: string, offsetSeconds: number): number {
	const s = localHour.replace(' ', 'T');
	const [datePart, timePart] = s.split('T');
	const [yy, mm, dd] = datePart.split('-').map((x) => Number(x));
	const [HH, Min = '00'] = timePart.split(':');
	const h = Number(HH);
	const m = Number(Min);
	const epochUtc = Date.UTC(yy, mm - 1, dd, h, m, 0);
	return epochUtc - offsetSeconds * 1000;
}

export function toEpochsFromLocalTimes(times: string[], offsetSeconds: number): number[] {
	return times.map((t) => parseLocalHourToEpoch(t, offsetSeconds));
}

export function makeIndexMap(epochs: number[]): Map<number, number> {
	const m = new Map<number, number>();
	epochs.forEach((e, i) => m.set(e, i));
	return m;
}

export function generateEpochsForLocalRange(startYMD: string, endYMD: string, offsetSeconds: number): number[] {
	const [ys, ms, ds] = startYMD.split('-').map((x) => Number(x));
	const [ye, me, de] = endYMD.split('-').map((x) => Number(x));
	const startEpoch = Date.UTC(ys, ms - 1, ds, 0, 0, 0) - offsetSeconds * 1000;
	const endEpoch = Date.UTC(ye, me - 1, de, 23, 0, 0) - offsetSeconds * 1000;
	const out: number[] = [];
	for (let t = startEpoch; t <= endEpoch; t += 3600 * 1000) out.push(t);
	return out;
}

export function mergeByEpoch(
	timelineEpochs: number[],
	meteostatIdx: Map<number, number>,
	meteostat: { ws: (number | null)[]; wpgt: (number | null)[]; prcp: (number | null)[] },
	openIdx: Map<number, number>,
	open: { wind_speed_10m: (number | null)[]; wind_gusts_10m: (number | null)[]; precipitation: (number | null)[] },
	offsetSeconds: number
): HourlyMerged[] {
	const out: HourlyMerged[] = [];
	for (const epoch of timelineEpochs) {
		const mi = meteostatIdx.get(epoch);
		const oi = openIdx.get(epoch);

		const ms_ws = mi !== undefined ? meteostat.ws[mi] ?? null : null;
		const om_ws = oi !== undefined ? open.wind_speed_10m[oi] ?? null : null;
		const ms_wpgt = mi !== undefined ? meteostat.wpgt[mi] ?? null : null;
		const om_wpgt = oi !== undefined ? open.wind_gusts_10m[oi] ?? null : null;
		const ms_prcp = mi !== undefined ? meteostat.prcp[mi] ?? null : null;
		const om_prcp = oi !== undefined ? open.precipitation[oi] ?? null : null;

		let wind_kmh: number | null = null;
		let gust_kmh: number | null = null;
		let precip_mm: number | null = null;
		const sources: SourceRecord = { wind: null, gust: null, precip: null };

		if (ms_ws != null) {
			wind_kmh = round1(toKmH(ms_ws));
			sources.wind = 'meteostat';
		} else if (om_ws != null) {
			wind_kmh = round1(toKmH(om_ws));
			sources.wind = 'open-meteo';
		}

		if (ms_wpgt != null) {
			gust_kmh = round1(toKmH(ms_wpgt));
			sources.gust = 'meteostat';
		} else if (om_wpgt != null) {
			gust_kmh = round1(toKmH(om_wpgt));
			sources.gust = 'open-meteo';
		}

		if (ms_prcp != null) {
			precip_mm = Number(ms_prcp);
			sources.precip = 'meteostat';
		} else if (om_prcp != null) {
			precip_mm = Number(om_prcp);
			sources.precip = 'open-meteo';
		}

		out.push({
			time: toLisbonIsoWithOffset(epoch, offsetSeconds),
			wind_kmh,
			gust_kmh,
			precip_mm,
			sources
		});
	}
	return out;
}
