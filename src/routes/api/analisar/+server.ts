import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	fetchMeteostatHourly,
	fetchOpenMeteoHourly,
	toEpochsFromLocalTimes,
	makeIndexMap,
	mergeByEpoch,
	generateEpochsForLocalRange
} from '$lib/meteo/fetchers';
import { ymd } from '$lib/time';
import {
	fetchIpmaDeaLast24h,
	fetchNoaaMetarRange,
	fetchOgimetMetarRange,
	metarHoursMap
} from '$lib/meteo/thunder';
import { fetchIpmaWarnings } from '$lib/meteo/warnings';
import { resolvePlace } from '$lib/geocode';
import { nearestIcao } from '$lib/meteo/airports';

const TZ = 'Europe/Lisbon';

function clampToDateRangeInclusive(start: Date, end: Date): { startYMD: string; endYMD: string } {
	const startYMD = ymd(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())));
	const endYMD = ymd(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())));
	return { startYMD, endYMD };
}

function estimateOffsetSecondsAtMidnightUTC(dateUTC: Date): number {
	const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false });
	const parts = fmt.formatToParts(dateUTC);
	const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
	return h * 3600;
}


export const GET: RequestHandler = async ({ url, fetch }) => {
	const localQ = url.searchParams.get('local');
	const lat = url.searchParams.get('lat');
	const lon = url.searchParams.get('lon');
	const data_inicio = url.searchParams.get('data_inicio');
	const data_fim = url.searchParams.get('data_fim');
	const resolucao = url.searchParams.get('resolucao');

	if ((!localQ && (!lat || !lon)) || !data_inicio || !data_fim || !resolucao) {
		return json({ ok: false, error: 'Parâmetros obrigatórios: (local OU lat+lon), data_inicio, data_fim, resolucao' }, { status: 400 });
	}
	if (resolucao !== 'hourly' && resolucao !== '10min') {
		return json({ ok: false, error: 'Resolução deve ser "hourly" ou "10min"' }, { status: 400 });
	}

	let place: { name: string; lat: number; lon: number; admin1?: string };
	if (localQ) {
		const resolved = await resolvePlace(localQ);
		place = { name: resolved.name, lat: resolved.lat, lon: resolved.lon, admin1: resolved.admin1 };
	} else {
		const latNum = parseFloat(lat);
		const lonNum = parseFloat(lon);
		if (isNaN(latNum) || latNum < -90 || latNum > 90) return json({ ok: false, error: 'Latitude deve ser um número entre -90 e 90' }, { status: 400 });
		if (isNaN(lonNum) || lonNum < -180 || lonNum > 180) return json({ ok: false, error: 'Longitude deve ser um número entre -180 e 180' }, { status: 400 });
		place = { name: `${latNum},${lonNum}` , lat: latNum, lon: lonNum };
	}

	const dataInicio = new Date(`${data_inicio}T00:00:00Z`);
	const dataFim = new Date(`${data_fim}T23:00:00Z`);
	if (isNaN(dataInicio.getTime()) || isNaN(dataFim.getTime())) return json({ ok: false, error: 'Formato de data inválido. Use YYYY-MM-DD' }, { status: 400 });
	if (dataInicio > dataFim) return json({ ok: false, error: 'Data de início deve ser anterior ou igual à data de fim' }, { status: 400 });

	const resolution_requested = resolucao as 'hourly' | '10min';
	const resolution_used = 'hourly';
	const notes: string[] = [];
	if (resolution_requested === '10min') notes.push('Sem suporte 10-min nesta fase; usar horário.');

	const { startYMD, endYMD } = clampToDateRangeInclusive(dataInicio, dataFim);

	const [meteostat, openmeteo] = await Promise.all([
		fetchMeteostatHourly(fetch, place.lat, place.lon, startYMD, endYMD),
		fetchOpenMeteoHourly(fetch, place.lat, place.lon, startYMD, endYMD, TZ)
	]);

	const offsetSeconds = openmeteo.utc_offset_seconds || estimateOffsetSecondsAtMidnightUTC(new Date(`${startYMD}T00:00:00Z`));

	const openEpochs = openmeteo.items.map((it) => it.epoch);
	const msEpochs = toEpochsFromLocalTimes(meteostat.time.map((t) => t.replace(' ', 'T')), offsetSeconds);

	const meteostatAvailable = meteostat.available && meteostat.size > 0;

	let timelineEpochs: number[] = [];
	if (openEpochs.length > 0) {
		timelineEpochs = openEpochs;
	} else if (meteostatAvailable) {
		timelineEpochs = msEpochs;
	} else {
		timelineEpochs = generateEpochsForLocalRange(startYMD, endYMD, offsetSeconds);
	}

	const msIndex = makeIndexMap(msEpochs);
	const openMap = new Map<number, { epoch: number; wind_kmh: number | null; gust_kmh: number | null; precip_mm: number | null }>();
	for (const it of openmeteo.items) openMap.set(it.epoch, it);

	const icao = nearestIcao(place.lat, place.lon);
	console.log(`[analisar] place=${place.name} lat=${place.lat} lon=${place.lon} icao=${icao}  open.size=${openmeteo.size} meteostat.size=${meteostat.size}`);

	const merged = mergeByEpoch(
		timelineEpochs,
		msIndex,
		{ ws: meteostat.ws, wpgt: meteostat.wpgt, prcp: meteostat.prcp },
		openMap,
		TZ
	);

	if (openmeteo.usedArchiveFallback) notes.push('Open-Meteo: fallback archive-api');

	// Thunder integration
	const nowLocal = new Date();
	const nowUTC = new Date();
	const dayMs = 24 * 3600 * 1000;
	const intervalStartMs = timelineEpochs[0] ?? dataInicio.getTime();
	const intervalEndMs = (timelineEpochs[timelineEpochs.length - 1] ?? dataFim.getTime()) + 3600 * 1000 - 1;
	const last24h = nowUTC.getTime() - intervalEndMs <= dayMs;

	let thunderUrls: Record<string, string | undefined> = {};
	if (last24h) {
		const { url: ipmaDeaUrl, counts } = await fetchIpmaDeaLast24h(fetch);
		thunderUrls.ipma_dea = ipmaDeaUrl;
		const countByHour = counts;
		for (let i = 0; i < merged.length; i++) {
			const epochHour = timelineEpochs[i];
			const c = countByHour.get(epochHour) ?? 0;
			merged[i] = {
				...merged[i],
				thunder: { type: 'count', value: Math.max(0, Math.trunc(c)), source: 'ipma-dea' }
			} as any;
		}
	} else {
		const ogStart = new Date(intervalStartMs);
		const ogEnd = new Date(intervalEndMs);
		const { url: ogimetUrl, metars } = await fetchOgimetMetarRange(fetch, icao, ogStart, ogEnd);
		thunderUrls.ogimet = ogimetUrl;
		let byHour = new Map<number, import('$lib/meteo/thunder').ThunderFlag>();
		if (metars.length > 0) {
			const entries = metars.map((raw) => {
				// Try to infer time from DDHHMMZ token; otherwise fallback to interval edge
				const m = raw.match(/\s(\d{2})(\d{2})(\d{2})Z/);
				let when = intervalStartMs;
				if (m) {
					const dd = Number(m[1]);
					const hh = Number(m[2]);
					const MM = Number(m[3]);
					const base = new Date(ogStart.getUTCFullYear(), ogStart.getUTCMonth(), dd, hh, MM, 0);
					when = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), base.getUTCHours(), base.getUTCMinutes(), 0);
				}
				return { raw, epochMs: when };
			});
			byHour = metarHoursMap(entries);
		} else {
			const { url: addsUrl, metars: adds } = await fetchNoaaMetarRange(fetch, icao, ogStart, ogEnd);
			thunderUrls.noaa_adds = addsUrl;
			const entries = adds.map((a) => ({ raw: a.raw, epochMs: Date.parse(a.time) }));
			byHour = metarHoursMap(entries);
		}
		for (let i = 0; i < merged.length; i++) {
			const epochHour = timelineEpochs[i];
			const flag = byHour.get(epochHour) ?? null;
			merged[i] = {
				...merged[i],
				thunder: { type: 'flag', value: flag, source: thunderUrls.noaa_adds ? 'noaa-adds' : 'ogimet' }
			} as any;
		}
	}

	// Warnings integration — distrito por admin1 ou heurística simples
	const distrito = place.admin1 || inferDistritoFromLatLon(place.lat, place.lon) || 'Porto';
	const { url: ipmaWarningsUrl, warnings } = await fetchIpmaWarnings(fetch, distrito, new Date(intervalStartMs), new Date(intervalEndMs));

	return json({
		ok: true,
		resolution_requested,
		resolution_used,
		tz: TZ,
		series: merged,
		place,
		icao,
		warnings,
		sources_links: {
			meteostat: meteostat.url,
			open_meteo: openmeteo.url,
			ogimet: thunderUrls.ogimet,
			noaa_adds: thunderUrls.noaa_adds,
			ipma_dea: thunderUrls.ipma_dea,
			ipma_warnings: ipmaWarningsUrl
		},
		notes
	});
};

function inferDistritoFromLatLon(lat: number, lon: number): string | null {
    if (lat > 40.95 && lat < 41.05 && lon > -8.8 && lon < -8.5) return 'Aveiro';
    if (lat > 41.1 && lat < 41.3 && lon > -8.75 && lon < -8.45) return 'Porto';
    if (lat > 38.6 && lat < 38.9 && lon > -9.3 && lon < -9.0) return 'Lisboa';
    if (lat > 36.9 && lat < 37.2 && lon > -8.1 && lon < -7.8) return 'Faro';
    return null;
}
