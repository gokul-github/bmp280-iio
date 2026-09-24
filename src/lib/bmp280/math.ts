/**
 * BMP280 compensation and the inverse used by the simulated ADC.
 * Integer formulas: datasheet BST-BMP280-DS001-11 §3.11.3 rev 1.1.
 * Sample calibration and the bench vector: §3.12.
 * Must stay in lockstep with firmware/qemu/bmp280_math.h.
 */

export interface Calib {
  T1: number;
  T2: number;
  T3: number;
  P1: number;
  P2: number;
  P3: number;
  P4: number;
  P5: number;
  P6: number;
  P7: number;
  P8: number;
  P9: number;
}

export const SAMPLE_CALIB: Calib = {
  T1: 27504,
  T2: 26435,
  T3: -1000,
  P1: 36477,
  P2: -10685,
  P3: 3024,
  P4: 2855,
  P5: 140,
  P6: -7,
  P7: 15500,
  P8: -14600,
  P9: 6000,
};

/** §3.12 uncompensated sample. */
export const DATASHEET_ADC_T = 519888;
export const DATASHEET_ADC_P = 415148;

export interface TempOut {
  tFine: number;
  /** 0.01 °C. 2508 means 25.08 °C. */
  tCenti: number;
}

function i32(n: bigint): number {
  const x = BigInt.asIntN(32, n);
  return Number(x);
}

export function compensateT(adcT: number, c: Calib = SAMPLE_CALIB): TempOut {
  const adc = BigInt(adcT);
  const t1 = BigInt(c.T1);
  const t2 = BigInt(c.T2);
  const t3 = BigInt(c.T3);
  const var1 = ((((adc >> 3n) - (t1 << 1n)) * t2) >> 11n);
  const var2 = (((((adc >> 4n) - t1) * ((adc >> 4n) - t1)) >> 12n) * t3) >> 14n;
  const tFine = var1 + var2;
  const tCenti = (tFine * 5n + 128n) >> 8n;
  return { tFine: i32(tFine), tCenti: i32(tCenti) };
}

/** Pressure as Q24.8 Pa (divide by 256 for pascals). */
export function compensateP(adcP: number, tFine: number, c: Calib = SAMPLE_CALIB): bigint {
  let var1 = BigInt(tFine) - 128000n;
  let var2 = var1 * var1 * BigInt(c.P6);
  var2 = var2 + ((var1 * BigInt(c.P5)) << 17n);
  var2 = var2 + (BigInt(c.P4) << 35n);
  var1 = ((var1 * var1 * BigInt(c.P3)) >> 8n) + ((var1 * BigInt(c.P2)) << 12n);
  var1 = ((((1n << 47n) + var1) * BigInt(c.P1)) >> 33n);
  if (var1 === 0n) return 0n;
  let p = 1048576n - BigInt(adcP);
  p = (((p << 31n) - var2) * 3125n) / var1;
  var1 = ((BigInt(c.P9) * (p >> 13n) * (p >> 13n)) >> 25n);
  var2 = ((BigInt(c.P8) * p) >> 19n);
  p = ((p + var1 + var2) >> 8n) + (BigInt(c.P7) << 4n);
  return p < 0n ? 0n : p;
}

export function q24ToPa(q: bigint): number {
  return Number(q) / 256;
}

export interface FloatComp {
  var1: number;
  var2: number;
  tFine: number;
  tempC: number;
  pressPa: number;
}

/** Appendix 8.1, temperature var2 squared so it matches §3.12. */
export function compensateFloat(adcT: number, adcP: number, c: Calib = SAMPLE_CALIB): FloatComp {
  const var1 = (adcT / 16384.0 - c.T1 / 1024.0) * c.T2;
  const diff = adcT / 131072.0 - c.T1 / 8192.0;
  const var2 = diff * diff * c.T3;
  const tFine = (var1 + var2) | 0;
  const tempC = (var1 + var2) / 5120.0;

  let v1 = tFine / 2.0 - 64000.0;
  let v2 = (v1 * v1 * c.P6) / 32768.0;
  v2 = v2 + v1 * c.P5 * 2.0;
  v2 = v2 / 4.0 + c.P4 * 65536.0;
  v1 = ((c.P3 * v1 * v1) / 524288.0 + c.P2 * v1) / 524288.0;
  v1 = (1.0 + v1 / 32768.0) * c.P1;
  let p = 1048576.0 - adcP;
  if (v1 === 0) {
    return { var1, var2, tFine, tempC, pressPa: 0 };
  }
  p = ((p - v2 / 4096.0) * 6250.0) / v1;
  const pVar1 = (c.P9 * p * p) / 2147483648.0;
  const pVar2 = (p * c.P8) / 32768.0;
  p = p + (pVar1 + pVar2 + c.P7) / 16.0;
  return { var1, var2, tFine, tempC, pressPa: p };
}

export function adcForCenti(target: number, c: Calib = SAMPLE_CALIB): number {
  let lo = 0;
  let hi = 0xfffff;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compensateT(mid, c).tCenti < target) lo = mid + 1;
    else hi = mid;
  }
  let best = lo;
  let bestErr = Math.abs(compensateT(lo, c).tCenti - target);
  if (lo > 0) {
    const err = Math.abs(compensateT(lo - 1, c).tCenti - target);
    if (err < bestErr) {
      best = lo - 1;
      bestErr = err;
    }
  }
  return best;
}

export function adcForPa(targetPa: number, tFine: number, c: Calib = SAMPLE_CALIB): number {
  const targetQ = BigInt(Math.round(targetPa * 256));
  let lo = 0;
  let hi = 0xfffff;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const q = compensateP(mid, tFine, c);
    if (q > targetQ) lo = mid + 1;
    else hi = mid;
  }
  const err = (a: number) => {
    const d = compensateP(a, tFine, c) - targetQ;
    return d < 0n ? -d : d;
  };
  let best = lo;
  if (lo > 0 && err(lo - 1) < err(lo)) best = lo - 1;
  return best;
}

export function pack20(adc: number): [number, number, number] {
  const v = adc & 0xfffff;
  return [(v >> 12) & 0xff, (v >> 4) & 0xff, (v & 0xf) << 4];
}

export function unpack20(b0: number, b1: number, b2: number): number {
  return ((b0 & 0xff) << 12) | ((b1 & 0xff) << 4) | ((b2 & 0xff) >> 4);
}

export function storeCalib(regs: Uint8Array, c: Calib = SAMPLE_CALIB): void {
  const words = [c.T1, c.T2, c.T3, c.P1, c.P2, c.P3, c.P4, c.P5, c.P6, c.P7, c.P8, c.P9];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]! & 0xffff;
    regs[0x88 + 2 * i] = w & 0xff;
    regs[0x88 + 2 * i + 1] = (w >> 8) & 0xff;
  }
}

export function formatPressureSysfs(q: bigint): string {
  const scale = 256000n;
  const intPart = q / scale;
  const rem = q % scale;
  const micro = (rem * 1000000n) / scale;
  return `${intPart}.${micro.toString().padStart(6, "0")}`;
}

export function hex8(n: number): string {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

export function hex20(n: number): string {
  return (n & 0xfffff).toString(16).toUpperCase().padStart(5, "0");
}

export interface SelfTest {
  pass: boolean;
  tCenti: number;
  tFine: number;
  pQ: string;
  pPa: number;
  floatT: number;
  floatP: number;
  tempRoundtrip: boolean;
  pressRoundtripPa: number;
}

export function datasheetSelfTest(): SelfTest {
  const t = compensateT(DATASHEET_ADC_T);
  const q = compensateP(DATASHEET_ADC_P, t.tFine);
  const f = compensateFloat(DATASHEET_ADC_T, DATASHEET_ADC_P);
  const adcT = adcForCenti(2508);
  const backT = compensateT(adcT);
  const adcP = adcForPa(100653.25390625, backT.tFine);
  const backQ = compensateP(adcP, backT.tFine);
  const pressErr = Math.abs(q24ToPa(backQ) - 100653.25390625);
  const pass =
    t.tCenti === 2508 &&
    t.tFine === 128422 &&
    q === 25767233n &&
    backT.tCenti === 2508 &&
    pressErr < 0.25 &&
    Math.abs(f.tempC - 25.082) < 0.001 &&
    Math.abs(f.var2 - -370.891705) < 0.001;
  return {
    pass,
    tCenti: t.tCenti,
    tFine: t.tFine,
    pQ: q.toString(),
    pPa: q24ToPa(q),
    floatT: f.tempC,
    floatP: f.pressPa,
    tempRoundtrip: backT.tCenti === 2508,
    pressRoundtripPa: pressErr,
  };
}

/** Unfiltered RMS pressure noise (Pa), datasheet table 8, filter off. */
export function pressureNoisePa(osrsP: number): number {
  switch (osrsP) {
    case 1:
      return 3.3;
    case 2:
      return 2.6;
    case 3:
      return 2.1;
    case 4:
      return 1.6;
    default:
      return osrsP === 0 ? 0 : 1.3;
  }
}

/** Table 9, IIR off. */
export function temperatureNoiseC(osrsT: number): number {
  switch (osrsT) {
    case 1:
      return 0.005;
    case 2:
      return 0.004;
    case 3:
    case 4:
      return 0.003;
    default:
      return osrsT === 0 ? 0 : 0.002;
  }
}

export const OSRS_LABEL = ["skipped", "×1", "×2", "×4", "×8", "×16", "×16", "×16"] as const;

export const FILTER_COEFF = [0, 2, 4, 8, 16] as const;

/** Samples to reach ≥75% of a step. Table 6. */
export const FILTER_STEP = [1, 2, 5, 11, 22] as const;

export const T_SB_MS = [0.5, 62.5, 125, 250, 500, 1000, 2000, 4000] as const;

/** Table 14 typical ODR (Hz) for osrs row × t_sb column. Row 0 is ultra-low (×1). */
const ODR_TABLE: readonly (readonly number[])[] = [
  [166.67, 14.71, 7.66, 3.91, 1.98, 0.99, 0.5, 0.25],
  [125, 14.29, 7.55, 3.88, 1.97, 0.99, 0.5, 0.25],
  [83.33, 13.51, 7.33, 3.82, 1.96, 0.99, 0.5, 0.25],
  [50, 12.2, 6.92, 3.71, 1.92, 0.98, 0.5, 0.25],
  [26.32, 10, 6.15, 3.48, 1.86, 0.96, 0.49, 0.25],
];

export function datasheetOdr(osrsP: number, tSb: number): number | null {
  if (osrsP <= 0) return null;
  const row = Math.min(osrsP, 5) - 1;
  return ODR_TABLE[row]?.[tSb] ?? null;
}

export function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
