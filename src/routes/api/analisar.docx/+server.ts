import type { RequestHandler } from './$types';
import { buildReport } from '$lib/report/buildReport';

function required(url: URL, key: string): string {
	const v = url.searchParams.get(key);
	if (!v) throw new Error(`Missing ${key}`);
	return v;
}

export const GET: RequestHandler = async ({ url, fetch, locals, platform }) => {
	try {
		const localQ = url.searchParams.get('local');
		const lat = url.searchParams.get('lat');
		const lon = url.searchParams.get('lon');
		const data_inicio = required(url, 'data_inicio');
		const data_fim = required(url, 'data_fim');
		const resolucao = required(url, 'resolucao');

		const apiUrl = new URL('/api/analisar', url);
		if (localQ) {
			apiUrl.searchParams.set('local', localQ);
		} else {
			if (!lat || !lon) throw new Error('Missing local or lat/lon');
			apiUrl.searchParams.set('lat', lat);
			apiUrl.searchParams.set('lon', lon);
		}
		apiUrl.searchParams.set('data_inicio', data_inicio);
		apiUrl.searchParams.set('data_fim', data_fim);
		apiUrl.searchParams.set('resolucao', resolucao);

		const analysisRes = await fetch(apiUrl.toString());
		if (!analysisRes.ok) {
			return new Response(await analysisRes.text(), { status: analysisRes.status });
		}
		const analysis = await analysisRes.json();
		if (!analysis?.ok) {
			return new Response(JSON.stringify(analysis), { status: 500 });
		}

		const startISO = `${data_inicio}T00:00:00Z`;
		const endISO = `${data_fim}T23:00:00Z`;

		const resolvedLat = lat ? Number(lat) : Number(analysis?.place?.lat ?? 0);
		const resolvedLon = lon ? Number(lon) : Number(analysis?.place?.lon ?? 0);
		const resolvedLabel = analysis?.place?.name ? `${analysis.place.name} — ${analysis.place.admin1 || ''}`.trim() : undefined;
		const { arrayBuffer } = await buildReport({
			local: { lat: resolvedLat, lon: resolvedLon, label: resolvedLabel },
			period: { startISO, endISO, tz: 'Europe/Lisbon' },
			series: analysis.series,
			warnings: analysis.warnings ?? [],
			sources_links: analysis.sources_links ?? {}
		});

		const yyyymmdd = (s: string) => s.slice(0, 10).replaceAll('-', '');
		const filename = `relatorio-meteo-${analysis?.place?.name || lat || 'local'}-${yyyymmdd(data_inicio)}-${yyyymmdd(data_fim)}.docx`;

		const headers: Record<string, string> = {
			'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			'Content-Disposition': `attachment; filename=${filename}`,
			'X-Report-Source': 'edge'
		};

		// Optional R2 upload if available
		const r2: any = (platform as any)?.env?.R2_REPORTS;
		if (r2 && typeof r2.put === 'function') {
			const key = `reports/relatorio-meteo-${lat}-${lon}-${data_inicio}-${data_fim}.docx`;
			await r2.put(key, new Uint8Array(arrayBuffer), {
				httpMetadata: { contentType: headers['Content-Type'] }
			});
			if (r2.publicUrl) headers['X-Report-URL'] = `${r2.publicUrl}/${key}`;
		}

		headers['X-Report-Size'] = String(arrayBuffer.byteLength);
		return new Response(new Uint8Array(arrayBuffer), { headers });
	} catch (err: any) {
		return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), { status: 400 });
	}
};
