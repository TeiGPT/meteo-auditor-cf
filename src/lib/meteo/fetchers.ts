/* Utilities to fetch Meteostat and Open-Meteo hourly data and merge them */
/* Versão "dados reais": Meteostat model=false; nada de reanálise por defeito */
import { toISOInTZ } from '$lib/time';

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

/**
 * ATENÇÃO:
 * Nesta versão, tratamos os valores já como km/h quando vêm da API.
 * Mantemos a função por compatibilidade – identidade.
 */
export function toKmH(ms: number | null | undefined): number | null {
  if (ms === null || ms === undefined) return null;
  return ms; // já em km/h
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

/* ===================== FETCHERS ===================== */

export type MeteostatResult = {
  url: string;
  available: boolean;
  time: string[];
  ws: Array<number | null>;   // km/h
  wpgt: Array<number | null>; // km/h
  prcp: Array<number | null>;
  size: number;
};

export type OpenMeteoItem = {
  epoch: number;
  wind_kmh: number | null;
  gust_kmh: number | null;
  precip_mm: number | null;
};
export type OpenMeteoResult = {
  url: string;
  available: boolean;
  items: OpenMeteoItem[];
  utc_offset_seconds: number;
  size: number;
  usedArchiveFallback: boolean;
};

/**
 * Meteostat (observações reais apenas) — model=false
 * ws/wpgt assumidos em km/h (ver nota no teu pipeline).
 */
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
    // 👇 Só dados medidos; sem preenchimento por modelo
    model: 'false'
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
    // Assumimos que a API devolve ws/wpgt em km/h no teu ambiente
    const ws   = data.map((r) => (r.ws   ?? r.wspd ?? null)) as Array<number | null>;
    const wpgt = data.map((r) => (r.wpgt ?? null)) as Array<number | null>;
    const prcp = data.map((r) => (r.prcp ?? null)) as Array<number | null>;

    return { url, available: true, time, ws, wpgt, prcp, size: time.length };
  } catch {
    return { url, available: false, time: [], ws: [], wpgt: [], prcp: [], size: 0 };
  }
}

/**
 * Open-Meteo ERA5/Archive — reanálise (opcional).
 * km/h forçados para evitar conversões.
 */
function sanitizeNumericArray(arr: Array<number | string | null | undefined>, len: number): Array<number | null> {
  const out: Array<number | null> = new Array(len);
  for (let i = 0; i < len; i++) {
    const v = arr?.[i];
    if (v === null || v === undefined) {
      out[i] = null;
      continue;
    }
    const n = typeof v === 'number' ? v : Number(v);
    out[i] = Number.isFinite(n) ? n : null;
  }
  return out;
}

export async function fetchOpenMeteoHourly(
  fetchFn: typeof fetch,
  lat: number,
  lon: number,
  startISODate: string,
  endISODate: string,
  tz = 'Europe/Lisbon'
): Promise<OpenMeteoResult> {
  const buildUrl = (base: string) => {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      hourly: ['wind_speed_10m', 'wind_gusts_10m', 'precipitation'].join(','),
      start_date: startISODate,
      end_date: endISODate,
      timezone: tz,
      windspeed_unit: 'kmh' // km/h para evitar multiplicações
    });
    return `${base}?${params.toString()}`;
  };

  const primaryUrl = buildUrl('https://reanalysis.open-meteo.com/v1/era5');
  let urlUsed = primaryUrl;
  let usedArchiveFallback = false;

  try {
    let res = await fetchFn(primaryUrl);
    let json: any = null;
    if (res.ok) json = await res.json();

    let hourly = json?.hourly ?? {};
    let timeRaw: string[] = (hourly?.time as string[]) ?? [];
    let wspdRaw: Array<number | null | undefined> = (hourly?.wind_speed_10m as any[]) ?? [];
    let wgstRaw: Array<number | null | undefined> = (hourly?.wind_gusts_10m as any[]) ?? [];
    let prcpRaw: Array<number | null | undefined> = (hourly?.precipitation as any[]) ?? [];
    let utc_offset_seconds: number = Number(json?.utc_offset_seconds ?? 0);

    let len = Math.min(timeRaw.length, wspdRaw.length, wgstRaw.length, prcpRaw.length);
    if (!len) {
      const fallbackUrl = buildUrl('https://archive-api.open-meteo.com/v1/archive');
      urlUsed = fallbackUrl;
      usedArchiveFallback = true;
      res = await fetchFn(fallbackUrl);
      if (!res.ok) return { url: urlUsed, available: false, items: [], utc_offset_seconds: 0, size: 0, usedArchiveFallback };
      json = await res.json();

      hourly = json?.hourly ?? {};
      timeRaw = (hourly?.time as string[]) ?? [];
      wspdRaw = (hourly?.wind_speed_10m as any[]) ?? [];
      wgstRaw = (hourly?.wind_gusts_10m as any[]) ?? [];
      prcpRaw = (hourly?.precipitation as any[]) ?? [];
      utc_offset_seconds = Number(json?.utc_offset_seconds ?? 0);
      len = Math.min(timeRaw.length, wspdRaw.length, wgstRaw.length, prcpRaw.length);
      if (!len) return { url: urlUsed, available: false, items: [], utc_offset_seconds, size: 0, usedArchiveFallback };
    }

    const time = timeRaw.slice(0, len);
    const wind_speed_10m = sanitizeNumericArray(wspdRaw, len); // km/h
    const wind_gusts_10m = sanitizeNumericArray(wgstRaw, len); // km/h
    const precipitation = sanitizeNumericArray(prcpRaw, len);

    const epochs = toEpochsFromLocalTimes(time, utc_offset_seconds);
    const items: OpenMeteoItem[] = epochs.map((epoch, i) => ({
      epoch,
      wind_kmh: wind_speed_10m[i] == null ? null : wind_speed_10m[i]!,
      gust_kmh: wind_gusts_10m[i] == null ? null : wind_gusts_10m[i]!,
      precip_mm: precipitation[i] == null ? null : precipitation[i]!
    }));

    return { url: urlUsed, available: true, items, utc_offset_seconds, size: items.length, usedArchiveFallback };
  } catch {
    return { url: urlUsed, available: false, items: [], utc_offset_seconds: 0, size: 0, usedArchiveFallback };
  }
}

/* ===================== TIME HELPERS ===================== */

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

/* ===================== MERGE ===================== */

/**
 * Junta as séries por época (hora). Por defeito **NÃO** usa reanálise.
 * Para permitir fallback, passa { useOpenMeteoFallback: true }.
 */
export function mergeByEpoch(
  timelineEpochs: number[],
  meteostatIdx: Map<number, number>,
  meteostat: { ws: (number | null)[]; wpgt: (number | null)[]; prcp: (number | null)[] },
  openMap: Map<number, OpenMeteoItem>,
  tz: string,
  opts?: { useOpenMeteoFallback?: boolean }
): HourlyMerged[] {
  const useOM = !!opts?.useOpenMeteoFallback;
  const out: HourlyMerged[] = [];

  for (const epoch of timelineEpochs) {
    const mi = meteostatIdx.get(epoch);
    const om = openMap.get(epoch); // só usado se useOM=true

    const ms_ws   = mi !== undefined ? meteostat.ws[mi]   ?? null : null; // km/h
    const ms_wpgt = mi !== undefined ? meteostat.wpgt[mi] ?? null : null; // km/h
    const ms_prcp = mi !== undefined ? meteostat.prcp[mi] ?? null : null;

    let wind_kmh: number | null = null;
    let gust_kmh: number | null = null;
    let precip_mm: number | null = null;
    const sources: SourceRecord = { wind: null, gust: null, precip: null };

    // 1) Preferir sempre Meteostat (observado)
    if (ms_ws != null) {
      wind_kmh = round1(ms_ws);
      sources.wind = 'meteostat';
    } else if (useOM && om && om.wind_kmh != null) {
      wind_kmh = round1(om.wind_kmh);
      sources.wind = 'open-meteo';
    }

    if (ms_wpgt != null) {
      gust_kmh = round1(ms_wpgt);
      sources.gust = 'meteostat';
    } else if (useOM && om && om.gust_kmh != null) {
      gust_kmh = round1(om.gust_kmh);
      sources.gust = 'open-meteo';
    }

    if (ms_prcp != null) {
      precip_mm = Number(ms_prcp);
      sources.precip = 'meteostat';
    } else if (useOM && om && om.precip_mm != null) {
      precip_mm = Number(om.precip_mm);
      sources.precip = 'open-meteo';
    }

    out.push({
      time: toISOInTZ(epoch, tz),
      wind_kmh,
      gust_kmh,
      precip_mm,
      sources
    });
  }
  return out;
}
