<script lang="ts">
	let lat = '41.0';
	let lon = '-8.63';
	let data_inicio = '2025-05-02';
	let data_fim = '2025-05-10';
	let resolucao = 'hourly';
	let resultado: any = null;
	let loading = false;
	let error = '';

	async function analisar() {
		loading = true;
		error = '';
		resultado = null;

		try {
			const params = new URLSearchParams({
				lat,
				lon,
				data_inicio,
				data_fim,
				resolucao
			});

			const response = await fetch(`/api/analisar?${params}`);
			const data = await response.json();

			if (response.ok) {
				resultado = data;
			} else {
				error = data.error || 'Erro desconhecido';
			}
		} catch (err) {
			error = 'Erro de conexão: ' + (err instanceof Error ? err.message : String(err));
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Meteo Auditor - Análise Meteorológica</title>
</svelte:head>

<main class="container">
	<h1>🌤️ Meteo Auditor</h1>
	<p class="subtitle">Análise de dados meteorológicos</p>

	<form on:submit|preventDefault={analisar} class="form">
		<div class="form-group">
			<label for="lat">Latitude:</label>
			<input 
				id="lat" 
				type="number" 
				step="0.000001" 
				bind:value={lat} 
				required 
				placeholder="41.0"
			/>
		</div>

		<div class="form-group">
			<label for="lon">Longitude:</label>
			<input 
				id="lon" 
				type="number" 
				step="0.000001" 
				bind:value={lon} 
				required 
				placeholder="-8.63"
			/>
		</div>

		<div class="form-group">
			<label for="data_inicio">Data de Início:</label>
			<input 
				id="data_inicio" 
				type="date" 
				bind:value={data_inicio} 
				required
			/>
		</div>

		<div class="form-group">
			<label for="data_fim">Data de Fim:</label>
			<input 
				id="data_fim" 
				type="date" 
				bind:value={data_fim} 
				required
			/>
		</div>

		<div class="form-group">
			<label for="resolucao">Resolução:</label>
			<select id="resolucao" bind:value={resolucao} required>
				<option value="hourly">Hourly</option>
				<option value="10min">10 minutos</option>
			</select>
		</div>

		<button type="submit" disabled={loading} class="btn">
			{loading ? 'Analisando...' : 'Analisar'}
		</button>
	</form>

	{#if error}
		<div class="error">
			❌ {error}
		</div>
	{/if}

	{#if resultado}
		<div class="result">
			<h3>Resultado da Análise:</h3>
			<pre>{JSON.stringify(resultado, null, 2)}</pre>
		</div>
	{/if}
</main>

<style>
	.container {
		max-width: 800px;
		margin: 0 auto;
		padding: 2rem;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	}

	h1 {
		text-align: center;
		color: #2563eb;
		margin-bottom: 0.5rem;
	}

	.subtitle {
		text-align: center;
		color: #6b7280;
		margin-bottom: 2rem;
		font-size: 1.1rem;
	}

	.form {
		background: #f8fafc;
		padding: 2rem;
		border-radius: 12px;
		box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
		margin-bottom: 2rem;
	}

	.form-group {
		margin-bottom: 1.5rem;
	}

	label {
		display: block;
		margin-bottom: 0.5rem;
		font-weight: 600;
		color: #374151;
	}

	input, select {
		width: 100%;
		padding: 0.75rem;
		border: 2px solid #e5e7eb;
		border-radius: 8px;
		font-size: 1rem;
		transition: border-color 0.2s;
	}

	input:focus, select:focus {
		outline: none;
		border-color: #2563eb;
		box-shadow: 0 0 0 3px rgb(37 99 235 / 0.1);
	}

	.btn {
		width: 100%;
		background: #2563eb;
		color: white;
		border: none;
		padding: 1rem;
		border-radius: 8px;
		font-size: 1.1rem;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.btn:hover:not(:disabled) {
		background: #1d4ed8;
	}

	.btn:disabled {
		background: #9ca3af;
		cursor: not-allowed;
	}

	.error {
		background: #fef2f2;
		color: #dc2626;
		padding: 1rem;
		border-radius: 8px;
		border: 1px solid #fecaca;
		margin-bottom: 1rem;
	}

	.result {
		background: #f0f9ff;
		padding: 1.5rem;
		border-radius: 8px;
		border: 1px solid #bae6fd;
	}

	.result h3 {
		margin-top: 0;
		color: #0369a1;
	}

	pre {
		background: #1e293b;
		color: #e2e8f0;
		padding: 1rem;
		border-radius: 6px;
		overflow-x: auto;
		font-size: 0.9rem;
		line-height: 1.5;
	}
</style>
