import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	fetchMeteostatHourly,
	fetchOpenMeteoHourly,
	toEpochsFromLocalTimes,
	makeIndexMap,
	mergeByEpoch,
	buildOffsetStringFromSeconds,
	ymd,
	generateEpochsForLocalRange
} from '$lib/meteo/fetchers';

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
	const lat = url.searchParams.get('lat');
	const lon = url.searchParams.get('lon');
	const data_inicio = url.searchParams.get('data_inicio');
	const data_fim = url.searchParams.get('data_fim');
	const resolucao = url.searchParams.get('resolucao');

	if (!lat || !lon || !data_inicio || !data_fim || !resolucao) {
		return json({ ok: false, error: 'Todos os parâmetros são obrigatórios: lat, lon, data_inicio, data_fim, resolucao' }, { status: 400 });
	}
	if (resolucao !== 'hourly' && resolucao !== '10min') {
		return json({ ok: false, error: 'Resolução deve ser "hourly" ou "10min"' }, { status: 400 });
	}

	const latNum = parseFloat(lat);
	const lonNum = parseFloat(lon);
	if (isNaN(latNum) || latNum < -90 || latNum > 90) return json({ ok: false, error: 'Latitude deve ser um número entre -90 e 90' }, { status: 400 });
	if (isNaN(lonNum) || lonNum < -180 || lonNum > 180) return json({ ok: false, error: 'Longitude deve ser um número entre -180 e 180' }, { status: 400 });

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
		fetchMeteostatHourly(fetch, latNum, lonNum, startYMD, endYMD),
		fetchOpenMeteoHourly(fetch, latNum, lonNum, startYMD, endYMD, TZ)
	]);

	const offsetSeconds = openmeteo.utc_offset_seconds || estimateOffsetSecondsAtMidnightUTC(new Date(`${startYMD}T00:00:00Z`));
	const offsetStr = buildOffsetStringFromSeconds(offsetSeconds);

	const openEpochs = toEpochsFromLocalTimes(openmeteo.time, offsetSeconds);
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
	const omIndex = makeIndexMap(openEpochs);

	console.log('[analisar] meteostatAvailable=', meteostatAvailable, 'meteostat.size=', meteostat.size, 'open.size=', openmeteo.size);
	if (openEpochs.length) console.log('[analisar] open range', new Date(openEpochs[0]).toISOString(), '->', new Date(openEpochs[openEpochs.length - 1]).toISOString());
	if (msEpochs.length) console.log('[analisar] ms range', new Date(msEpochs[0]).toISOString(), '->', new Date(msEpochs[msEpochs.length - 1]).toISOString());

	const merged = mergeByEpoch(
		timelineEpochs,
		msIndex,
		{ ws: meteostat.ws, wpgt: meteostat.wpgt, prcp: meteostat.prcp },
		omIndex,
		{ wind_speed_10m: openmeteo.wind_speed_10m, wind_gusts_10m: openmeteo.wind_gusts_10m, precipitation: openmeteo.precipitation },
		offsetSeconds
	);

	return json({
		ok: true,
		resolution_requested,
		resolution_used,
		tz: TZ,
		series: merged,
		sources_links: { meteostat: meteostat.url, open_meteo: openmeteo.url },
		notes
	});
};
