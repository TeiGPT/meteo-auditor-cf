export type Airport = { icao: string; name: string; lat: number; lon: number };

export const AIRPORTS_PT: Airport[] = [
	{ icao: 'LPPR', name: 'Porto', lat: 41.235, lon: -8.678 },
	{ icao: 'LPPT', name: 'Lisboa', lat: 38.781, lon: -9.135 },
	{ icao: 'LPFR', name: 'Faro', lat: 37.015, lon: -7.971 },
	{ icao: 'LPBJ', name: 'Beja', lat: 38.078, lon: -7.932 },
	{ icao: 'LPOV', name: 'Covilhã', lat: 40.272, lon: -7.479 }
];

function toRad(deg: number): number { return (deg * Math.PI) / 180; }

export function nearestIcao(lat: number, lon: number): string {
	let best = AIRPORTS_PT[0];
	let bestD = Infinity;
	for (const ap of AIRPORTS_PT) {
		const d = haversine(lat, lon, ap.lat, ap.lon);
		if (d < bestD) { bestD = d; best = ap; }
	}
	return best.icao;
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371; // km
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
	return R * c;
}



