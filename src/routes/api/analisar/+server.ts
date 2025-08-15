import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const lat = url.searchParams.get('lat');
	const lon = url.searchParams.get('lon');
	const data_inicio = url.searchParams.get('data_inicio');
	const data_fim = url.searchParams.get('data_fim');
	const resolucao = url.searchParams.get('resolucao');

	// Validação dos parâmetros
	if (!lat || !lon || !data_inicio || !data_fim || !resolucao) {
		return json(
			{ 
				ok: false, 
				error: 'Todos os parâmetros são obrigatórios: lat, lon, data_inicio, data_fim, resolucao' 
			},
			{ status: 400 }
		);
	}

	// Validação da resolução
	if (resolucao !== 'hourly' && resolucao !== '10min') {
		return json(
			{ 
				ok: false, 
				error: 'Resolução deve ser "hourly" ou "10min"' 
			},
			{ status: 400 }
		);
	}

	// Validação de latitude e longitude (valores básicos)
	const latNum = parseFloat(lat);
	const lonNum = parseFloat(lon);
	
	if (isNaN(latNum) || latNum < -90 || latNum > 90) {
		return json(
			{ 
				ok: false, 
				error: 'Latitude deve ser um número entre -90 e 90' 
			},
			{ status: 400 }
		);
	}

	if (isNaN(lonNum) || lonNum < -180 || lonNum > 180) {
		return json(
			{ 
				ok: false, 
				error: 'Longitude deve ser um número entre -180 e 180' 
			},
			{ status: 400 }
		);
	}

	// Validação das datas
	const dataInicio = new Date(data_inicio);
	const dataFim = new Date(data_fim);
	
	if (isNaN(dataInicio.getTime()) || isNaN(dataFim.getTime())) {
		return json(
			{ 
				ok: false, 
				error: 'Formato de data inválido. Use YYYY-MM-DD' 
			},
			{ status: 400 }
		);
	}

	if (dataInicio >= dataFim) {
		return json(
			{ 
				ok: false, 
				error: 'Data de início deve ser anterior à data de fim' 
			},
			{ status: 400 }
		);
	}

	// Retorna sucesso com echo dos parâmetros
	return json({
		ok: true,
		echo: {
			lat: latNum,
			lon: lonNum,
			data_inicio,
			data_fim,
			resolucao
		}
	});
};
