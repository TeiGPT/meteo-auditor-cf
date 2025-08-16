export function toISOInTZ(epochMs: number, tz: string): string {
	const utc = new Date(epochMs);
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone: tz,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
	const parts = fmt.formatToParts(utc);
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
	const y = get('year');
	const m = get('month');
	const d = get('day');
	const H = get('hour');
	const Min = get('minute');
	const S = get('second');
	// Compute offset comparing the constructed local time (interpreted as UTC) with the actual UTC epoch
	const localEpoch = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(H), Number(Min), Number(S));
	const offsetMinutes = Math.round((localEpoch - utc.getTime()) / 60000);
	const sign = offsetMinutes >= 0 ? '+' : '-';
	const abs = Math.abs(offsetMinutes);
	const offH = String(Math.floor(abs / 60)).padStart(2, '0');
	const offM = String(abs % 60).padStart(2, '0');
	return `${y}-${m}-${d}T${H}:${Min}:${S}${sign}${offH}:${offM}`;
}

export function ymd(date: Date, tz: string): string {
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone: tz,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	const parts = fmt.formatToParts(date);
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
	const y = get('year');
	const m = get('month');
	const d = get('day');
	return `${y}-${m}-${d}`;
}



