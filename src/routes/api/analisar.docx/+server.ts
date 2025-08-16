import type { RequestHandler } from '@sveltejs/kit';
import { buildReport } from '$lib/report/buildReport';

// Este endpoint volta a chamar o /api/analisar internamente.
// Se o utilizador escolher "daily", pedimos "hourly" ao analisador
// e o buildReport agrega para diário.

export const GET: RequestHandler = async ({ url, fetch }) => {
	try {
		const qp = new URLSearchParams(url.searchParams);

		// Normalizar resolução: para o analisador pedimos sempre hourly
		const resolucaoUser = (qp.get('resolucao') || 'hourly').toLowerCase();
		qp.set('resolucao', 'hourly'); // evitar erros "Invalid time value"

		// Obter o JSON do analisador
		const apiUrl = new URL('/api/analisar', url);
		apiUrl.search = qp.toString();

		const r = await fetch(apiUrl.toString());
		const data = await r.json();

		if (!r.ok) {
			return new Response(JSON.stringify({ ok: false, error: data?.error || 'Falha na análise' }), {
				status: 500,
				headers: { 'content-type': 'application/json' }
			});
		}

		// Preparar contexto para o DOCX
		const tz = 'Europe/Lisbon';
		const start = url.searchParams.get('data_inicio') || data?.period?.startISO?.slice(0, 10) || '';
		const end = url.searchParams.get('data_fim') || data?.period?.endISO?.slice(0, 10) || '';

		const ctx = {
			tz,
			place: data?.place,
			startISO: start ? `${start}T00:00:00` : undefined,
			endISO: end ? `${end}T23:00:00` : undefined,
			items: data?.series || [],              // série horária
			thunderDaily: data?.thunder_daily,      // se existir
			sources_links: data?.links || data?.sources_links || {}
		};

		// Geração do DOCX (o buildReport agrega para diário internamente)
		const blob = await buildReport(ctx);

		const fnameLocal = (data?.place?.name || 'Local')
			.replace(/[^\p{L}\p{N}\-_.]+/gu, '_');

		return new Response(blob, {
			headers: {
				'content-type':
					'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				'content-disposition':
					`attachment; filename="Relatorio-Meteo-${fnameLocal}-${start?.replaceAll('-', '')}-${end?.replaceAll('-', '')}.docx"`,
				// opcional: expor um URL de referência das fontes usadas
				'X-Report-URL': data?.links?.open_meteo_archive || ''
			}
		});
	} catch (e: any) {
		return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), {
			status: 500,
			headers: { 'content-type': 'application/json' }
		});
	}
};
