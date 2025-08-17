/* Utilities to fetch Meteostat and Open-Meteo hourly data and merge them */
/* Versão "dados reais": preferir observações Meteostat; fallback a estações ≤50 km */
import { toISOInTZ } from '$lib/time';

export type Source = 'meteostat' | 'open-meteo';

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

export function round1(v: number | null): number | null {
  if (v === null || Number.isNaN(v)) return null;
  return Math.round(v * 10) / 10;
}

function pad2(n: number) { return n < 10 ? `0${n}` : `${n}`; }
export function ymd(date: Date) {
  const y = date.getUTCFullYear(), m = pad2(date.getUTCMonth()+1), d = pad2(date.getUTCDate());
  return `${y}-${m}-${d}`;
}

export type MeteostatResult = {
  url: string;
  available: boolean;
  time: string[];              // "YYYY-MM-DD HH:00"
  ws: Array<number | null>;    // km/h
  wpgt: Array<number | null>;  // km/h
  prcp: Array<number | null>;  // mm
  size: number;
};

export type OpenMeteoItem = { epoch: number; wind_kmh: number | null; gust_kmh: number | null; precip_mm: number | null };
export type OpenMeteoResult = {
  url: string;
  available: boolean;
  items: OpenMeteoItem[];
  utc_offset_seconds: number;
  size: number;
  usedArchiveFallback: boolean;
};

/* =============== METEOSTAT (REAL DATA) ================= */

const MS_BASE = 'https://api.meteostat.net/v2';
function msHeaders(): Record<string,string> {
  const headers: Record<string,string> = {};
  const apiKey = (globalThis as any)?.process?.env?.METEOSTAT_API_KEY;
  if (apiKey) headers['X-Api-Key'] = String(apiKey);
  return headers;
}

/** 1) Tenta ponto (estação “melhor” segundo o Meteostat), SEM modelo */
async function fetchMeteostatPointHourlyRaw(
  fetchFn: typeof fetch, lat: number, lon: number, startISO: string, endISO: string
): Promise<MeteostatResult> {
  const params = new URLSearchParams({
    lat: String(lat), lon: String(lon),
    start: startISO, end: endISO,
    tz: 'Europe/Lisbon',
    model: 'false' // só observado
  });
  const url = `${MS_BASE}/point/hourly?${params.toString()}`;
  try {
    const res = await fetchFn(url, { headers: msHeaders() });
    if (!res.ok) return { url, available: false, time: [], ws: [], wpgt: [], prcp: [], size: 0 };
    const json = await res.json().catch(() => ({} as any));
    const data: any[] = json?.data ?? [];
    if (!data.length) return { url, available: false, time: [], ws: [], wpgt: [], prcp: [], size: 0 };
    const time: string[] = data.map(r => String(r.time ?? r.date ?? ''));
    const ws   = data.map(r => (r.ws   ?? r.wspd ?? null)) as (number|null)[];
    const wpgt = data.map(r => (r.wpgt ?? null))            as (number|null)[];
    const prcp = data.map(r => (r.prcp ?? null))            as (number|null)[];
    return { url, available: true, time, ws, wpgt, prcp, size: time.length };
  } catch {
    return { url, available: false, time: [], ws: [], wpgt: [], prcp: [], size: 0 };
  }
}

/** 2) Se o ponto falhar, procurar estações até 50 km e fundir hora-a-hora */
async function fetchMeteostatNearbyMergedHourly(
  fetchFn: typeof fetch, lat: number, lon: number, startISO: string, endISO: string
): Promise<MeteostatResult> {
  const nbUrl = `${MS_BASE}/stations/nearby?${new URLSearchParams({
    lat: String(lat), lon: String(lon), limit: '20'
  })}`;
  try {
    const nbRes = await fetchFn(nbUrl, { headers: msHeaders() });
    const nbJson = nbRes.ok ? await nbRes.json() : { data: [] };
    const stations: Array<{ id: string; distance?: number }> = nbJson?.data ?? [];
    const within50 = stations.filter(s => (s.distance ?? 1e9) <= 50);

    if (!within50.length) {
      return { url: nbUrl, available: false, time: [], ws: [], wpgt: [], prcp: [], size: 0 };
    }

    // Mapa local "time -> { ws, wpgt, prcp }", preenchido por ordem de proximidade
    const byTime = new Map<string, {ws:number|null; wpgt:number|null; prcp:number|null}>();
    let anyCount = 0;

    for (const st of within50) {
      const hUrl = `${MS_BASE}/stations/hourly?${new URLSearchParams({
        station: st.id, start: startISO, end: endISO, tz: 'Europe/Lisbon'
      })}`;
      const hRes = await fetchFn(hUrl, { headers: msHeaders() });
      if (!hRes.ok) continue;
      const hJson = await hRes.json().catch(() => ({} as any));
      const rows: any[] = hJson?.data ?? [];
      if (!rows.length) continue;

      for (const r of rows) {
        const t = String(r.time ?? r.date ?? '');
        const cur = byTime.get(t) ?? { ws: null, wpgt: null, prcp: null };
        // campos das estações: 'wspd' (km/h), 'wpgt' (km/h), 'prcp' (mm)
        if (cur.ws   == null && (r.ws   ?? r.wspd) != null) cur.ws   = Number(r.ws ?? r.wspd);
        if (cur.wpgt == null && r.wpgt != null)            cur.wpgt = Number(r.wpgt);
        if (cur.prcp == null && r.prcp != null)            cur.prcp = Number(r.prcp);
        byTime.set(t, cur);
      }
      anyCount += rows.length;
      // opcional: parar cedo se já temos muitas horas preenchidas
    }

    if (!byTime.size) {
      return { url: nbUrl, available: false, time: [], ws: [], wpgt: [], prcp: [], size: 0 };
    }

    const time = Array.from(byTime.keys()).sort();
    const ws   = time.map(t => byTime.get(t)!.ws);
    const wpgt = time.map(t => byTime.get(t)!.wpgt);
    const prcp = time.map(t => byTime.get(t)!.prcp);
    return { url: nbUrl, available: true, time, ws, wpgt, prcp, size: time.length };
  } catch {
    return { url: nbUrl, available: false, time: [], ws: [], wpgt: [], prcp: [], size: 0 };
  }
}

/** Função pública: tenta ponto; se vazio, tenta estações ≤50 km e devolve a série */
export async function fetchMeteostatHourly(
  fetchFn: typeof fetch, lat: number, lon: number, startISO: string, endISO: string
): Promise<MeteostatResult> {
  const point = await fetchMeteostatPointHourlyRaw(fetchFn, lat, lon, startISO, endISO);
  const haveSome =
    point.available &&
    point.size > 0 &&
    (point.ws.some(v => v != null) || point.wpgt.some(v => v != null) || point.prcp.some(v => v != null));

  if (haveSome) return point;
  return await fetchMeteostatNearbyMergedHourly(fetchFn, lat, lon, startISO, endISO);
}

/* =============== OPEN-METEO (opcional, reanálise) ================= */

function sanitize(arr: Array<number | string | null | undefined>, len: number): Array<number | null> {
  const out = new Array(len).fill(null) as Array<number|null>;
  for (let i=0;i<len;i++){
    const v = arr?.[i];
    if (v === null || v === undefined) continue;
    const n = typeof v === 'number' ? v : Number(v);
    out[i] = Number.isFinite(n) ? n : null;
  }
  return out;
}

export async function fetchOpenMeteoHourly(
  fetchFn: typeof fetch, lat: number, lon: number, startISODate: string, endISODate: string, tz = 'Europe/Lisbon'
): Promise<OpenMeteoResult> {
  const buildUrl = (base: string) => `${base}?${new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: ['wind_speed_10m','wind_gusts_10m','precipitation'].join(','),
    start_date: startISODate,
    end_date: endISODate,
    timezone: tz,
    windspeed_unit: 'kmh'
  })}`;

  const primaryUrl = buildUrl('https://reanalysis.open-meteo.com/v1/era5');
  let urlUsed = primaryUrl, usedArchiveFallback = false;

  try {
    let res = await fetchFn(primaryUrl);
    let json: any = res.ok ? await res.json() : null;

    let hourly = json?.hourly ?? {};
    let timeRaw: string[] = hourly?.time ?? [];
    let wspdRaw: any[] = hourly?.wind_speed_10m ?? [];
    let wgstRaw: any[] = hourly?.wind_gusts_10m ?? [];
    let prcpRaw: any[] = hourly?.precipitation ?? [];
    let offset: number = Number(json?.utc_offset_seconds ?? 0);

    let len = Math.min(timeRaw.length, wspdRaw.length, wgstRaw.length, prcpRaw.length);
    if (!len) {
      const fb = buildUrl('https://archive-api.open-meteo.com/v1/archive');
      urlUsed = fb; usedArchiveFallback = true;
      res = await fetchFn(fb);
      if (!res.ok) return { url: urlUsed, available: false, items: [], utc_offset_seconds: 0, size: 0, usedArchiveFallback };
      json = await res.json();
      hourly = json?.hourly ?? {};
      timeRaw = hourly?.time ?? [];
      wspdRaw = hourly?.wind_speed_10m ?? [];
      wgstRaw = hourly?.wind_gusts_10m ?? [];
      prcpRaw = hourly?.precipitation ?? [];
      offset = Number(json?.utc_offset_seconds ?? 0);
      len = Math.min(timeRaw.length, wspdRaw.length, wgstRaw.length, prcpRaw.length);
      if (!len) return { url: urlUsed, available: false, items: [], utc_offset_seconds: offset, size: 0, usedArchiveFallback };
    }

    const time = timeRaw.slice(0,len);
    const wspd = sanitize(wspdRaw,len), wgst = sanitize(wgstRaw,len), prcp = sanitize(prcpRaw,len);
    const epochs = toEpochsFromLocalTimes(time, offset);
    const items: OpenMeteoItem[] = epochs.map((epoch,i)=>({
      epoch,
      wind_kmh: wspd[i],
      gust_kmh: wgst[i],
      precip_mm: prcp[i]
    }));

    return { url: urlUsed, available: true, items, utc_offset_seconds: offset, size: items.length, usedArchiveFallback };
  } catch {
    return { url: urlUsed, available: false, items: [], utc_offset_seconds: 0, size: 0, usedArchiveFallback };
  }
}

/* =============== TIME HELPERS & MERGE ================= */

function parseLocalHourToEpoch(localHour: string, offsetSeconds: number): number {
  const s = localHour.replace(' ', 'T');
  const [datePart, timePart] = s.split('T');
  const [yy, mm, dd] = datePart.split('-').map(Number);
  const [HH, Min='00'] = timePart.split(':');
  const h = Number(HH), m = Number(Min);
  const epochUtc = Date.UTC(yy, mm-1, dd, h, m, 0);
  return epochUtc - offsetSeconds * 1000;
}
export function toEpochsFromLocalTimes(times: string[], offsetSeconds: number): number[] {
  return times.map(t => parseLocalHourToEpoch(t, offsetSeconds));
}
export function makeIndexMap(epochs: number[]): Map<number, number> {
  const m = new Map<number, number>(); epochs.forEach((e,i)=>m.set(e,i)); return m;
}
export function generateEpochsForLocalRange(startYMD: string, endYMD: string, offsetSeconds: number): number[] {
  const [ys,ms,ds] = startYMD.split('-').map(Number);
  const [ye,me,de] = endYMD.split('-').map(Number);
  const startEpoch = Date.UTC(ys,ms-1,ds,0,0,0) - offsetSeconds*1000;
  const endEpoch   = Date.UTC(ye,me-1,de,23,0,0) - offsetSeconds*1000;
  const out:number[] = []; for (let t=startEpoch; t<=endEpoch; t+=3600*1000) out.push(t); return out;
}

/**
 * Junta séries numa linha temporal. Por defeito NÃO usa reanálise (Open-Meteo).
 * Se quiseres permitir fallback de reanálise: opts.useOpenMeteoFallback = true.
 */
export function mergeByEpoch(
  timelineEpochs: number[],
  meteostatIdx: Map<number, number>,
  meteostat: { ws: (number|null)[]; wpgt: (number|null)[]; prcp: (number|null)[] },
  openMap: Map<number, OpenMeteoItem>,
  tz: string,
  opts?: { useOpenMeteoFallback?: boolean }
): HourlyMerged[] {
  const useOM = !!opts?.useOpenMeteoFallback;
  const out: HourlyMerged[] = [];

  for (const epoch of timelineEpochs) {
    const mi = meteostatIdx.get(epoch);
    const om = openMap.get(epoch);

    const ms_ws   = mi !== undefined ? meteostat.ws[mi]   ?? null : null;
    const ms_wpgt = mi !== undefined ? meteostat.wpgt[mi] ?? null : null;
    const ms_prcp = mi !== undefined ? meteostat.prcp[mi] ?? null : null;

    let wind_kmh: number | null = null;
    let gust_kmh: number | null = null;
    let precip_mm: number | null = null;
    const sources: SourceRecord = { wind: null, gust: null, precip: null };

    if (ms_ws != null) { wind_kmh = round1(ms_ws); sources.wind = 'meteostat'; }
    else if (useOM && om?.wind_kmh != null) { wind_kmh = round1(om.wind_kmh); sources.wind = 'open-meteo'; }

    if (ms_wpgt != null) { gust_kmh = round1(ms_wpgt); sources.gust = 'meteostat'; }
    else if (useOM && om?.gust_kmh != null) { gust_kmh = round1(om.gust_kmh); sources.gust = 'open-meteo'; }

    if (ms_prcp != null) { precip_mm = Number(ms_prcp); sources.precip = 'meteostat'; }
    else if (useOM && om?.precip_mm != null) { precip_mm = Number(om.precip_mm); sources.precip = 'open-meteo'; }

    out.push({ time: toISOInTZ(epoch, tz), wind_kmh, gust_kmh, precip_mm, sources });
  }
  return out;
}
