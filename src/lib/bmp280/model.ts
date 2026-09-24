/**
 * In-browser stand-in for the six-stage pipeline:
 * stimulus → I²C slave → device-tree probe → driver compensation → IIO sysfs → scope.
 * Register behavior follows BST-BMP280-DS001-11 §§3–5 (I²C, not SPI).
 */

import {
  FILTER_COEFF,
  OSRS_LABEL,
  SAMPLE_CALIB,
  T_SB_MS,
  adcForCenti,
  adcForPa,
  compensateFloat,
  compensateP,
  compensateT,
  datasheetOdr,
  formatPressureSysfs,
  gauss,
  hex20,
  hex8,
  pack20,
  pressureNoisePa,
  q24ToPa,
  storeCalib,
  temperatureNoiseC,
  unpack20,
  type Calib,
} from "./math.ts";

export type PowerMode = "sleep" | "forced" | "normal";
export type StimulusMode = "live" | "bench";

export interface Controls {
  stimulus: StimulusMode;
  tempC: number;
  pressHpa: number;
  noise: boolean;
  /** SDO strap. 0x76 when SDO is grounded, 0x77 when pulled up. */
  strap: number;
  /** Device-tree `reg` the driver probes. */
  dtReg: number;
  mode: PowerMode;
  osrsT: number;
  osrsP: number;
  /** filter[2:0]: 0 off, 1 → 2, 2 → 4, 3 → 8, 4 → 16. */
  filter: number;
  tSb: number;
  useCase: string;
}

export interface TraceEntry {
  id: number;
  kind: "ok" | "nack" | "info";
  text: string;
}

export interface HistoryPoint {
  t: number;
  injT: number;
  repT: number | null;
  injP: number;
  repP: number | null;
}

export interface Reading {
  tempMilliC: number | null;
  pressSysfs: string | null;
  tempC: number | null;
  pressHpa: number | null;
  pressPa: number | null;
  tFine: number | null;
  floatTempC: number | null;
  floatPressPa: number | null;
  var1: number | null;
  var2: number | null;
  skippedT: boolean;
  skippedP: boolean;
}

export interface LabState {
  controls: Controls;
  regs: Uint8Array;
  filterMemT: number | null;
  filterMemP: number | null;
  driverUp: boolean;
  probeReason: string;
  trace: TraceEntry[];
  traceSeq: number;
  history: HistoryPoint[];
  t0: number;
  lastMeasure: number;
  hold: boolean;
  reading: Reading | null;
  injected: { tempC: number; pressHpa: number };
  adcT: number;
  adcP: number;
  sampleCount: number;
  calib: Calib;
}

export const REG = {
  calib: 0x88,
  id: 0xd0,
  reset: 0xe0,
  status: 0xf3,
  ctrl: 0xf4,
  config: 0xf5,
  press: 0xf7,
  temp: 0xfa,
} as const;

export const USE_CASES: readonly {
  id: string;
  label: string;
  mode?: PowerMode;
  osrsP?: number;
  osrsT?: number;
  filter?: number;
  tSb?: number;
}[] = [
  { id: "custom", label: "Custom" },
  { id: "handheld-lp", label: "Handheld low-power", mode: "normal", osrsP: 5, osrsT: 2, filter: 2, tSb: 1 },
  { id: "handheld-dyn", label: "Handheld dynamic", mode: "normal", osrsP: 3, osrsT: 1, filter: 4, tSb: 0 },
  { id: "weather", label: "Weather, lowest power", mode: "forced", osrsP: 1, osrsT: 1, filter: 0, tSb: 0 },
  { id: "elevator", label: "Elevator / floor", mode: "normal", osrsP: 3, osrsT: 1, filter: 2, tSb: 2 },
  { id: "drop", label: "Drop detection", mode: "normal", osrsP: 2, osrsT: 1, filter: 0, tSb: 0 },
  { id: "indoor", label: "Indoor navigation", mode: "normal", osrsP: 5, osrsT: 2, filter: 4, tSb: 0 },
];

export const DEFAULT_CONTROLS: Controls = {
  stimulus: "live",
  tempC: 25.08,
  pressHpa: 1006.53,
  noise: true,
  strap: 0x76,
  dtReg: 0x76,
  mode: "normal",
  osrsT: 2,
  osrsP: 5,
  filter: 2,
  tSb: 1,
  useCase: "handheld-lp",
};

const MODE_BITS: Record<PowerMode, number> = { sleep: 0, forced: 1, normal: 3 };

function ctrlByte(c: Controls): number {
  return ((c.osrsT & 7) << 5) | ((c.osrsP & 7) << 2) | MODE_BITS[c.mode];
}

function configByte(c: Controls): number {
  return ((c.tSb & 7) << 5) | ((c.filter & 7) << 2);
}

function modeFromBits(bits: number): PowerMode {
  if (bits === 3) return "normal";
  if (bits === 1 || bits === 2) return "forced";
  return "sleep";
}

export function describeCtrl(byte: number): string {
  const osrsT = (byte >> 5) & 7;
  const osrsP = (byte >> 2) & 7;
  const mode = modeFromBits(byte & 3);
  return `osrs_t ${OSRS_LABEL[osrsT]} · osrs_p ${OSRS_LABEL[osrsP]} · ${mode}`;
}

export function describeConfig(byte: number): string {
  const tSb = (byte >> 5) & 7;
  const filter = (byte >> 2) & 7;
  const coeff = FILTER_COEFF[Math.min(filter, 4)] ?? 16;
  return `t_sb ${T_SB_MS[tSb]} ms · IIR ${coeff === 0 ? "off" : `×${coeff}`}`;
}

function push(state: LabState, kind: TraceEntry["kind"], text: string): LabState {
  const id = state.traceSeq + 1;
  const entry: TraceEntry = { id, kind, text };
  return { ...state, traceSeq: id, trace: [entry, ...state.trace].slice(0, 16) };
}

function freshRegs(calib: Calib): Uint8Array {
  const regs = new Uint8Array(256);
  regs[REG.id] = 0x58;
  regs[REG.press] = 0x80;
  regs[REG.temp] = 0x80;
  storeCalib(regs, calib);
  return regs;
}

function cloneRegs(regs: Uint8Array): Uint8Array {
  return new Uint8Array(regs);
}

/** I²C write of pointer + payload. Returns null on NACK (wrong address). */
function i2cWrite(state: LabState, addr: number, pointer: number, data: number[]): LabState {
  if (addr !== state.controls.strap) {
    return push(state, "nack", `NACK  addr 0x${hex8(addr)}  (SDO strap is 0x${hex8(state.controls.strap)})`);
  }
  const regs = cloneRegs(state.regs);
  let next: LabState = { ...state, regs };
  const wrote: string[] = [];
  let fired = false;
  for (let i = 0; i < data.length; i++) {
    const reg = (pointer + i) & 0xff;
    const value = data[i]! & 0xff;
    wrote.push(`${hex8(reg)}=${hex8(value)}`);
    if (reg === REG.reset) {
      if (value === 0xb6) {
        const id = regs[REG.id]!;
        const calib = regs.slice(0x88, 0xa2);
        regs.fill(0);
        regs.set(calib, 0x88);
        regs[REG.id] = id;
        regs[REG.press] = 0x80;
        regs[REG.temp] = 0x80;
        next = {
          ...next,
          regs,
          filterMemT: null,
          filterMemP: null,
          driverUp: false,
          probeReason: "Device accepted soft reset 0xB6 and returned to sleep. Driver must probe again.",
        };
      }
      continue;
    }
    if (reg === REG.ctrl || reg === REG.config) {
      const prevFilter = (regs[REG.config]! >> 2) & 7;
      regs[reg] = value;
      if (reg === REG.config && ((value >> 2) & 7) !== prevFilter) {
        next = { ...next, regs, filterMemT: null, filterMemP: null };
      }
      if (reg === REG.ctrl && ((value & 3) === 1 || (value & 3) === 2)) {
        next = measureInto({ ...next, regs }, next.injected, true);
        next.regs[REG.ctrl] = value & 0xfc;
        fired = true;
      }
    }
  }
  next = push(next, "ok", `W 0x${hex8(addr)}  ${wrote.join(" ")}`);
  if (fired) {
    const burst = i2cRead(next, addr, REG.press, 6);
    next = burst.state;
  }
  return next;
}

function i2cRead(state: LabState, addr: number, pointer: number, len: number): { state: LabState; bytes: number[] | null } {
  if (addr !== state.controls.strap) {
    return {
      state: push(state, "nack", `NACK  addr 0x${hex8(addr)}  (SDO strap is 0x${hex8(state.controls.strap)})`),
      bytes: null,
    };
  }
  const bytes: number[] = [];
  for (let i = 0; i < len; i++) {
    bytes.push(state.regs[(pointer + i) & 0xff]!);
  }
  const preview = bytes.map(hex8).join(" ");
  const state2 = push(state, "ok", `R 0x${hex8(addr)}  @${hex8(pointer)} [${len}]  ${preview}`);
  return { state: state2, bytes };
}

function applyIir(prev: number | null, adc: number, coeff: number): { value: number; mem: number } {
  if (coeff <= 1 || prev === null) return { value: adc, mem: adc };
  const value = Math.trunc((prev * (coeff - 1) + adc) / coeff);
  return { value, mem: value };
}

function measureInto(state: LabState, injected: { tempC: number; pressHpa: number }, force: boolean): LabState {
  const modeBits = state.regs[REG.ctrl]! & 3;
  const mode = modeFromBits(modeBits);
  if (!force && mode !== "normal") return { ...state, injected };

  const osrsT = (state.regs[REG.ctrl]! >> 5) & 7;
  const osrsP = (state.regs[REG.ctrl]! >> 2) & 7;
  const filterReg = (state.regs[REG.config]! >> 2) & 7;
  const coeff = FILTER_COEFF[Math.min(filterReg, 4)] ?? 16;

  let tempC = injected.tempC;
  let pressPa = injected.pressHpa * 100;
  if (state.controls.noise) {
    if (osrsT !== 0) tempC += gauss() * temperatureNoiseC(osrsT);
    if (osrsP !== 0) pressPa += gauss() * pressureNoisePa(osrsP);
  }

  const regs = cloneRegs(state.regs);
  let memT = state.filterMemT;
  let memP = state.filterMemP;
  let adcT = 0x80000;
  let adcP = 0x80000;
  let rawT = adcForCenti(Math.round(tempC * 100), state.calib);

  if (osrsT === 0) {
    const packed = pack20(0x80000);
    regs[REG.temp] = packed[0];
    regs[REG.temp + 1] = packed[1];
    regs[REG.temp + 2] = packed[2];
  } else {
    const filtered = applyIir(memT, rawT, coeff);
    adcT = filtered.value;
    memT = filtered.mem;
    const packed = pack20(adcT);
    regs[REG.temp] = packed[0];
    regs[REG.temp + 1] = packed[1];
    regs[REG.temp + 2] = packed[2];
  }

  if (osrsP === 0) {
    const packed = pack20(0x80000);
    regs[REG.press] = packed[0];
    regs[REG.press + 1] = packed[1];
    regs[REG.press + 2] = packed[2];
  } else {
    const tFine = compensateT(rawT, state.calib).tFine;
    const rawP = adcForPa(pressPa, tFine, state.calib);
    const filtered = applyIir(memP, rawP, coeff);
    adcP = filtered.value;
    memP = filtered.mem;
    const packed = pack20(adcP);
    regs[REG.press] = packed[0];
    regs[REG.press + 1] = packed[1];
    regs[REG.press + 2] = packed[2];
  }

  regs[REG.status] = 0x00;
  return {
    ...state,
    regs,
    filterMemT: memT,
    filterMemP: memP,
    injected,
    adcT,
    adcP,
    lastMeasure: state.lastMeasure,
    sampleCount: state.sampleCount + 1,
  };
}

function readDriver(state: LabState): Reading {
  const empty: Reading = {
    tempMilliC: null,
    pressSysfs: null,
    tempC: null,
    pressHpa: null,
    pressPa: null,
    tFine: null,
    floatTempC: null,
    floatPressPa: null,
    var1: null,
    var2: null,
    skippedT: false,
    skippedP: false,
  };
  if (!state.driverUp) return empty;
  const adcP = unpack20(state.regs[REG.press]!, state.regs[REG.press + 1]!, state.regs[REG.press + 2]!);
  const adcT = unpack20(state.regs[REG.temp]!, state.regs[REG.temp + 1]!, state.regs[REG.temp + 2]!);
  const skippedT = adcT === 0x80000;
  const skippedP = adcP === 0x80000;
  const temp = skippedT ? null : compensateT(adcT, state.calib);
  const tFine = temp ? temp.tFine : 0;
  const q = skippedP || !temp ? null : compensateP(adcP, tFine, state.calib);
  const floatC = compensateFloat(adcT, adcP, state.calib);
  const pressPa = q === null ? null : q24ToPa(q);
  return {
    tempMilliC: temp ? temp.tCenti * 10 : null,
    pressSysfs: q === null ? null : formatPressureSysfs(q),
    tempC: temp ? temp.tCenti / 100 : null,
    pressHpa: pressPa === null ? null : pressPa / 100,
    pressPa,
    tFine: temp ? temp.tFine : null,
    floatTempC: skippedT ? null : floatC.tempC,
    floatPressPa: skippedP ? null : floatC.pressPa,
    var1: skippedT ? null : floatC.var1,
    var2: skippedT ? null : floatC.var2,
    skippedT,
    skippedP,
  };
}

function stimulusAt(controls: Controls, now: number, t0: number): { tempC: number; pressHpa: number } {
  if (controls.stimulus === "bench") {
    return { tempC: controls.tempC, pressHpa: controls.pressHpa };
  }
  const sec = (now - t0) / 1000;
  const tempC = 24.6 + 1.7 * Math.sin(sec / 7.5) + 0.45 * Math.sin(sec / 2.1);
  const pressHpa = 1013.25 + 1.35 * Math.sin(sec / 13) + 0.35 * Math.sin(sec / 3.4);
  return { tempC, pressHpa };
}

function periodMs(tSb: number): number {
  const ms = T_SB_MS[tSb] ?? 0.5;
  return Math.max(250, ms);
}

function withReading(state: LabState, now: number, appendHistory: boolean): LabState {
  const injected = stimulusAt(state.controls, now, state.t0);
  const reading = readDriver(state);
  if (!appendHistory || state.hold) {
    return { ...state, injected, reading };
  }
  const point: HistoryPoint = {
    t: (now - state.t0) / 1000,
    injT: injected.tempC,
    repT: reading.tempC,
    injP: injected.pressHpa,
    repP: reading.pressHpa,
  };
  return { ...state, injected, reading, history: [...state.history, point].slice(-90) };
}

export function boot(controls: Controls, now: number): LabState {
  let state: LabState = {
    controls,
    regs: freshRegs(SAMPLE_CALIB),
    filterMemT: null,
    filterMemP: null,
    driverUp: false,
    probeReason: "",
    trace: [],
    traceSeq: 0,
    history: [],
    t0: now,
    lastMeasure: now - periodMs(controls.tSb),
    hold: false,
    reading: null,
    injected: { tempC: controls.tempC, pressHpa: controls.pressHpa },
    adcT: 0x80000,
    adcP: 0x80000,
    sampleCount: 0,
    calib: SAMPLE_CALIB,
  };
  state = push(state, "info", "POR  sleep, chip id 0x58, NVM image copied (im_update 1→0)");
  state = probe(state, now);
  return state;
}

export function probe(state: LabState, now: number): LabState {
  let next = push(state, "info", `probe  compatible "bosch,bmp280"  reg <0x${hex8(state.controls.dtReg)}>`);
  const id = i2cRead(next, next.controls.dtReg, REG.id, 1);
  next = id.state;
  if (!id.bytes) {
    return withReading(
      {
        ...next,
        driverUp: false,
        probeReason: `No acknowledge at 0x${hex8(next.controls.dtReg)}. The device-tree reg does not match the SDO strap.`,
      },
      now,
      false,
    );
  }
  if (id.bytes[0] !== 0x58) {
    return withReading(
      { ...next, driverUp: false, probeReason: `Chip id 0x${hex8(id.bytes[0]!)} is not BMP280 (0x58).` },
      now,
      false,
    );
  }
  const calib = i2cRead(next, next.controls.dtReg, REG.calib, 24);
  next = calib.state;
  if (!calib.bytes) {
    return withReading({ ...next, driverUp: false, probeReason: "Calibration burst was NACKed." }, now, false);
  }
  next = i2cWrite(next, next.controls.dtReg, REG.config, [configByte(next.controls)]);
  next = i2cWrite(next, next.controls.dtReg, REG.ctrl, [ctrlByte(next.controls)]);
  if (!next.driverUp && next.probeReason.startsWith("Device accepted soft reset")) {
    return withReading(next, now, false);
  }
  next = {
    ...next,
    driverUp: true,
    probeReason: `Probed at 0x${hex8(next.controls.dtReg)}. ID 0x58. dig_T1 ${SAMPLE_CALIB.T1}, dig_P1 ${SAMPLE_CALIB.P1}.`,
  };
  if (next.controls.mode === "normal") {
    next = measureInto(next, stimulusAt(next.controls, now, next.t0), true);
    next = { ...next, lastMeasure: now };
    const burst = i2cRead(next, next.controls.dtReg, REG.press, 6);
    next = burst.state;
  }
  return withReading(next, now, true);
}

export function tick(state: LabState, now: number): LabState {
  if (state.hold) return state;
  const injected = stimulusAt(state.controls, now, state.t0);
  let next = { ...state, injected };
  const mode = modeFromBits(next.regs[REG.ctrl]! & 3);
  if (next.driverUp && mode === "normal" && now - next.lastMeasure >= periodMs(next.controls.tSb)) {
    next = measureInto(next, injected, true);
    next = { ...next, lastMeasure: now };
    const burst = i2cRead(next, next.controls.dtReg, REG.press, 6);
    next = burst.state;
  }
  return withReading(next, now, true);
}

export function retarget(state: LabState, controls: Controls, now: number): LabState {
  const addrChanged = controls.strap !== state.controls.strap || controls.dtReg !== state.controls.dtReg;
  const hwChanged =
    controls.mode !== state.controls.mode ||
    controls.osrsT !== state.controls.osrsT ||
    controls.osrsP !== state.controls.osrsP ||
    controls.filter !== state.controls.filter ||
    controls.tSb !== state.controls.tSb;
  const injected = stimulusAt(controls, now, state.t0);
  let next: LabState = { ...state, controls, injected };
  if (addrChanged) return probe(next, now);
  if (hwChanged && next.driverUp) {
    next = i2cWrite(next, controls.dtReg, REG.config, [configByte(controls)]);
    next = i2cWrite(next, controls.dtReg, REG.ctrl, [ctrlByte(controls)]);
    if (controls.mode === "normal") {
      next = measureInto(next, stimulusAt(controls, now, next.t0), true);
      next = { ...next, lastMeasure: now };
    }
  }
  return withReading(next, now, false);
}

export function triggerSample(state: LabState, now: number): LabState {
  if (!state.driverUp) return state;
  const injected = stimulusAt(state.controls, now, state.t0);
  const controls = { ...state.controls, mode: "forced" as const, useCase: state.controls.useCase };
  let next: LabState = { ...state, controls, injected };
  next = i2cWrite(next, controls.dtReg, REG.ctrl, [ctrlByte(controls)]);
  return withReading({ ...next, lastMeasure: now }, now, true);
}

export function softReset(state: LabState, now: number): LabState {
  const next = i2cWrite(state, state.controls.strap, REG.reset, [0xb6]);
  return withReading(next, now, false);
}

export function setHold(state: LabState, hold: boolean): LabState {
  return { ...state, hold };
}

export function odrLabel(controls: Controls): string {
  const odr = datasheetOdr(controls.osrsP, controls.tSb);
  if (odr === null) return "pressure skipped";
  const lab = 1000 / periodMs(controls.tSb);
  return `datasheet ODR ${odr.toFixed(odr >= 10 ? 1 : 2)} Hz · lab ${lab.toFixed(lab >= 1 ? 0 : 2)} Hz`;
}
