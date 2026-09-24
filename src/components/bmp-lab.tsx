import { useEffect, useState, type ReactNode } from "react";
import { ScopeChart } from "@/components/scope-chart";
import { datasheetSelfTest, FILTER_COEFF, FILTER_STEP, OSRS_LABEL, T_SB_MS, hex20, hex8 } from "@/lib/bmp280/math";
import {
  DEFAULT_CONTROLS,
  REG,
  USE_CASES,
  boot,
  describeConfig,
  describeCtrl,
  odrLabel,
  probe,
  retarget,
  setHold,
  softReset,
  tick,
  triggerSample,
  type Controls,
  type LabState,
  type PowerMode,
} from "@/lib/bmp280/model";
import readme from "../../firmware/README.md?raw";
import qemuSrc from "../../firmware/qemu/bmp280_sim.c?raw";
import mathSrc from "../../firmware/qemu/bmp280_math.h?raw";
import kernelSrc from "../../firmware/kernel/bmp280.c?raw";
import dtsSrc from "../../firmware/dts/bmp280-versatile.dtsi?raw";

const SELF = datasheetSelfTest();

const PRESETS = [
  { label: "Datasheet", tempC: 25.08, pressHpa: 1006.53 },
  { label: "Room", tempC: 22, pressHpa: 1013.25 },
  { label: "Cold", tempC: -10, pressHpa: 1008 },
  { label: "Summit", tempC: 5, pressHpa: 898.7 },
  { label: "Hot lid", tempC: 45, pressHpa: 1002 },
] as const;

const SOURCES = [
  { id: "readme", label: "Build notes", body: readme },
  { id: "qemu", label: "QEMU slave", body: qemuSrc },
  { id: "math", label: "Compensation", body: mathSrc },
  { id: "kernel", label: "Kernel driver", body: kernelSrc },
  { id: "dts", label: "Device tree", body: dtsSrc },
] as const;

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium tracking-widest text-muted uppercase">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function selectClass(): string {
  return "min-h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg";
}

function signed(n: number, digits: number): string {
  const body = Math.abs(n).toFixed(digits);
  if (n > 0) return `+${body}`;
  if (n < 0) return `-${body}`;
  return body;
}

export function BmpLab() {
  const [lab, setLab] = useState<LabState>(() => boot({ ...DEFAULT_CONTROLS, noise: false }, 0));
  const [chartOn, setChartOn] = useState(false);
  const [source, setSource] = useState<(typeof SOURCES)[number]["id"]>("readme");

  useEffect(() => {
    const now = performance.now();
    setLab(boot(DEFAULT_CONTROLS, now));
    setChartOn(true);
    const id = window.setInterval(() => {
      setLab((current) => (current ? tick(current, performance.now()) : current));
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  const controls = lab.controls;
  const reading = lab.reading;
  const now = () => performance.now();

  function commit(next: Controls) {
    setLab((current) => (current ? retarget(current, next, now()) : current));
  }

  function patch(partial: Partial<Controls>, keepCase = false) {
    const hw = ["mode", "osrsT", "osrsP", "filter", "tSb"] as const;
    const touches = hw.some((key) => partial[key] !== undefined);
    commit({
      ...controls,
      ...partial,
      useCase: partial.useCase ?? (touches && !keepCase ? "custom" : controls.useCase),
    });
  }

  const dT = reading?.tempC != null ? reading.tempC - lab.injected.tempC : null;
  const dP = reading?.pressPa != null ? reading.pressPa - lab.injected.pressHpa * 100 : null;
  const ctrl = lab.regs[REG.ctrl] ?? 0;
  const config = lab.regs[REG.config] ?? 0;
  const status = lab.regs[REG.status] ?? 0;
  const adcT = ((lab.regs[REG.temp] ?? 0) << 12) | ((lab.regs[REG.temp + 1] ?? 0) << 4) | ((lab.regs[REG.temp + 2] ?? 0) >> 4);
  const adcP =
    ((lab.regs[REG.press] ?? 0) << 12) | ((lab.regs[REG.press + 1] ?? 0) << 4) | ((lab.regs[REG.press + 2] ?? 0) >> 4);
  const activeSource = SOURCES.find((item) => item.id === source) ?? SOURCES[0];

  return (
    <main className="min-h-screen bg-bg text-fg">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <svg viewBox="0 0 48 40" className="size-11 shrink-0" aria-hidden>
              <rect x="4" y="6" width="40" height="28" rx="3" className="fill-muted" />
              <circle cx="32" cy="20" r="4" className="fill-bg" />
              <circle cx="12" cy="14" r="1.7" className="fill-signal" />
            </svg>
            <div>
              <h1 className="text-2xl font-medium tracking-tight text-balance">BMP280 I²C lab</h1>
              <p className="text-sm text-pretty text-muted">
                Setpoint, raw ADC, kernel compensation, IIO sysfs. Same formulas as the QEMU slave.
              </p>
            </div>
          </div>
          <p className="font-mono text-xs text-muted tabular-nums">
            chip 0x58 · strap 0x{hex8(controls.strap)} · {lab.driverUp ? "probed" : "not probed"}
          </p>
        </header>

        <p
          className={`rounded-lg border px-3 py-2 font-mono text-xs ${SELF.pass ? "border-line text-muted" : "border-fault text-fault"}`}
        >
          §3.12 UT 519888 → {(SELF.tCenti / 100).toFixed(2)} °C, t_fine {SELF.tFine} · UP 415148 →{" "}
          {SELF.pPa.toFixed(2)} Pa · Q24.8 {SELF.pQ} · {SELF.pass ? "self-test pass" : "self-test failed"}
        </p>

        <div className="flex gap-2 overflow-x-auto pb-1">
          <Stage
            n="1 Stimulus"
            ok
            lines={[
              `${lab.injected.tempC.toFixed(2)} °C`,
              `${lab.injected.pressHpa.toFixed(2)} hPa`,
              controls.stimulus === "live" ? "sine + noise" : "bench hold",
            ]}
          />
          <Stage
            n="2 QEMU slave"
            ok
            lines={[`T 0x${hex20(adcT)}`, `P 0x${hex20(adcP)}`, `ctrl 0x${hex8(ctrl)}`]}
          />
          <Stage
            n="3 Device tree"
            ok={lab.driverUp}
            lines={[`reg 0x${hex8(controls.dtReg)}`, "bosch,bmp280", lab.driverUp ? "matched" : "NACK"]}
          />
          <Stage
            n="4 Driver"
            ok={lab.driverUp}
            lines={[
              reading?.tFine != null ? `t_fine ${reading.tFine}` : "no t_fine",
              describeCtrl(ctrl),
              `${lab.sampleCount} samples`,
            ]}
          />
          <Stage
            n="5 IIO sysfs"
            ok={lab.driverUp && reading?.tempMilliC != null}
            lines={[
              reading?.tempMilliC != null ? `${reading.tempMilliC} m°C` : "in_temp —",
              reading?.pressSysfs != null ? `${reading.pressSysfs} kPa` : "in_pressure —",
              "processed",
            ]}
          />
          <Stage
            n="6 Scope"
            ok={lab.driverUp}
            lines={[lab.hold ? "hold" : "running", odrLabel(controls), dT == null ? "no delta" : `${signed(dT, 3)} °C`]}
          />
        </div>

        {!lab.driverUp ? (
          <p className="rounded-lg border border-fault px-3 py-3 text-sm text-fault">{lab.probeReason}</p>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-12">
          <div className="flex flex-col gap-4 lg:col-span-4">
            <Panel title="Stimulus">
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-1">
                {(["live", "bench"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`min-h-11 rounded-md text-sm ${controls.stimulus === mode ? "bg-surface text-fg" : "text-muted"}`}
                    onClick={() =>
                      patch({
                        stimulus: mode,
                        noise: mode === "live" ? true : controls.noise,
                      })
                    }
                  >
                    {mode === "live" ? "Live drift" : "Bench"}
                  </button>
                ))}
              </div>
              <Slider
                label="Temperature"
                unit="°C"
                min={-40}
                max={85}
                step={0.01}
                digits={2}
                value={controls.stimulus === "bench" ? controls.tempC : lab.injected.tempC}
                disabled={controls.stimulus !== "bench"}
                onChange={(tempC) => patch({ tempC })}
              />
              <Slider
                label="Pressure"
                unit="hPa"
                min={300}
                max={1100}
                step={0.01}
                digits={2}
                value={controls.stimulus === "bench" ? controls.pressHpa : lab.injected.pressHpa}
                disabled={controls.stimulus !== "bench"}
                onChange={(pressHpa) => patch({ pressHpa })}
              />
              <button
                type="button"
                aria-pressed={controls.noise}
                className={`min-h-11 rounded-md border px-3 text-sm ${controls.noise ? "border-signal text-signal" : "border-line text-muted"}`}
                onClick={() => patch({ noise: !controls.noise })}
              >
                {controls.noise ? "Unfiltered ADC noise on" : "ADC noise off"}
              </button>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="min-h-11 rounded-md border border-line bg-bg px-3 text-sm"
                    onClick={() =>
                      patch({
                        stimulus: "bench",
                        noise: false,
                        tempC: preset.tempC,
                        pressHpa: preset.pressHpa,
                      })
                    }
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <p className="font-mono text-xs break-all text-muted">
                {`echo "${lab.injected.tempC.toFixed(2)} ${lab.injected.pressHpa.toFixed(2)}" > /tmp/bmp280_sim_input`}
              </p>
            </Panel>

            <Panel title="Driver and strap">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted">Datasheet use case</span>
                <select
                  className={selectClass()}
                  value={controls.useCase}
                  onChange={(event) => {
                    const found = USE_CASES.find((item) => item.id === event.target.value);
                    if (!found || found.id === "custom") {
                      patch({ useCase: "custom" }, true);
                      return;
                    }
                    commit({
                      ...controls,
                      useCase: found.id,
                      mode: found.mode ?? controls.mode,
                      osrsP: found.osrsP ?? controls.osrsP,
                      osrsT: found.osrsT ?? controls.osrsT,
                      filter: found.filter ?? controls.filter,
                      tSb: found.tSb ?? controls.tSb,
                    });
                  }}
                >
                  {USE_CASES.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-bg p-1">
                {(["sleep", "forced", "normal"] as const satisfies readonly PowerMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`min-h-11 rounded-md text-sm capitalize ${controls.mode === mode ? "bg-surface text-fg" : "text-muted"}`}
                    onClick={() => patch({ mode })}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              {controls.mode === "forced" ? (
                <button
                  type="button"
                  className="min-h-11 rounded-md bg-signal px-3 text-sm font-medium text-bg disabled:opacity-50"
                  disabled={!lab.driverUp}
                  onClick={() => setLab((current) => (current ? triggerSample(current, now()) : current))}
                >
                  Trigger one conversion
                </button>
              ) : null}
              <div className="grid grid-cols-2 gap-3">
                <SelectNum
                  label="osrs_t"
                  value={controls.osrsT}
                  options={[0, 1, 2, 3, 4, 5].map((value) => ({
                    value,
                    label: OSRS_LABEL[value] ?? "×16",
                  }))}
                  onChange={(osrsT) => patch({ osrsT })}
                />
                <SelectNum
                  label="osrs_p"
                  value={controls.osrsP}
                  options={[0, 1, 2, 3, 4, 5].map((value) => ({
                    value,
                    label: OSRS_LABEL[value] ?? "×16",
                  }))}
                  onChange={(osrsP) => patch({ osrsP })}
                />
                <SelectNum
                  label="IIR filter"
                  value={controls.filter}
                  options={FILTER_COEFF.map((coeff, value) => ({
                    value,
                    label: coeff === 0 ? "off" : `×${coeff} · ${FILTER_STEP[value]} smp`,
                  }))}
                  onChange={(filter) => patch({ filter })}
                />
                <SelectNum
                  label="Standby"
                  value={controls.tSb}
                  options={T_SB_MS.map((ms, value) => ({ value, label: `${ms} ms` }))}
                  onChange={(tSb) => patch({ tSb })}
                />
              </div>
              <p className="text-xs text-pretty text-muted">
                {describeConfig(config)}. {odrLabel(controls)}.
                {controls.mode === "forced"
                  ? " A forced write converts once, then the mode bits read back as sleep."
                  : ""}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Addr
                  label="SDO strap"
                  value={controls.strap}
                  onChange={(strap) => patch({ strap })}
                />
                <Addr
                  label="DT reg"
                  value={controls.dtReg}
                  onChange={(dtReg) => patch({ dtReg })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="min-h-11 rounded-md border border-line bg-bg text-sm"
                  onClick={() => setLab((current) => (current ? probe(current, now()) : current))}
                >
                  Reprobe
                </button>
                <button
                  type="button"
                  className="min-h-11 rounded-md border border-line bg-bg text-sm"
                  onClick={() => setLab((current) => (current ? softReset(current, now()) : current))}
                >
                  Soft reset
                </button>
              </div>
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-4 lg:col-span-8">
            <Panel
              title="Scope"
              action={
                <button
                  type="button"
                  className="min-h-11 rounded-md border border-line px-3 text-sm"
                  onClick={() => setLab((current) => (current ? setHold(current, !current.hold) : current))}
                >
                  {lab.hold ? "Run" : "Hold"}
                </button>
              }
            >
              {chartOn ? (
                <ScopeChart data={lab.history} />
              ) : (
                <div className="flex h-64 items-center justify-center text-sm text-muted sm:h-72">
                  Scope fills as samples arrive.
                </div>
              )}
              <p className="text-xs text-pretty text-muted">
                Dashed is the host setpoint. Solid is the compensated register value. Noise is applied before the
                inverse ADC; the IIR then lags a moving setpoint and settles on a still one.
              </p>
            </Panel>

            <Panel title="Round trip">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Metric label="Injected" value={`${lab.injected.tempC.toFixed(3)} °C`} />
                <Metric
                  label="in_temp_input"
                  value={reading?.tempMilliC != null ? String(reading.tempMilliC) : "—"}
                  hint="millidegree C"
                />
                <Metric label="Driver" value={reading?.tempC != null ? `${reading.tempC.toFixed(3)} °C` : "—"} />
                <Metric label="Δ temperature" value={dT == null ? "—" : `${signed(dT, 3)} °C`} tone={deltaTone(dT)} />
                <Metric label="Injected" value={`${lab.injected.pressHpa.toFixed(2)} hPa`} />
                <Metric label="in_pressure_input" value={reading?.pressSysfs ?? "—"} hint="kilopascal" />
                <Metric label="Driver" value={reading?.pressHpa != null ? `${reading.pressHpa.toFixed(3)} hPa` : "—"} />
                <Metric label="Δ pressure" value={dP == null ? "—" : `${signed(dP, 2)} Pa`} tone={deltaTone(dP, 0.5)} />
              </div>
              <div className="grid gap-2 font-mono text-xs text-muted sm:grid-cols-2">
                <p>
                  float var1 {reading?.var1?.toFixed(2) ?? "—"} · var2 {reading?.var2?.toFixed(2) ?? "—"}
                </p>
                <p>
                  float T {reading?.floatTempC?.toFixed(5) ?? "—"} °C · float P{" "}
                  {reading?.floatPressPa?.toFixed(2) ?? "—"} Pa
                </p>
              </div>
              <p className="text-xs text-pretty text-muted">{lab.probeReason}</p>
            </Panel>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Registers">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-xs tabular-nums">
              <Reg k="0xD0 id" v={`0x${hex8(lab.regs[REG.id] ?? 0)}`} />
              <Reg k="0xF3 status" v={`0x${hex8(status)} ${status & 0x08 ? "measuring" : "ready"}`} />
              <Reg k="0xF4 ctrl_meas" v={`0x${hex8(ctrl)}`} />
              <Reg k="0xF5 config" v={`0x${hex8(config)}`} />
              <Reg k="0xF7 press" v={`0x${hex20(adcP)} ${adcP === 0x80000 ? "skipped" : ""}`} />
              <Reg k="0xFA temp" v={`0x${hex20(adcT)} ${adcT === 0x80000 ? "skipped" : ""}`} />
              <Reg k="dig_T1 T2 T3" v={`${lab.calib.T1} ${lab.calib.T2} ${lab.calib.T3}`} />
              <Reg k="dig_P1 P2 P3" v={`${lab.calib.P1} ${lab.calib.P2} ${lab.calib.P3}`} />
            </dl>
            <p className="text-xs text-pretty text-muted">
              Burst is 0xF7 through 0xFC. The top nibble of each XLSB holds the low 4 bits of the 20-bit code.
            </p>
          </Panel>
          <Panel title="I²C trace · newest first">
            <ol className="flex max-h-64 flex-col gap-1 overflow-auto font-mono text-xs">
              {lab.trace.map((entry) => (
                <li
                  key={entry.id}
                  className={entry.kind === "nack" ? "text-fault" : entry.kind === "info" ? "text-amber" : "text-fg"}
                >
                  {entry.text}
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <details className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface p-4">
          <summary className="min-h-11 cursor-pointer text-sm font-medium">Firmware sources and build notes</summary>
          <div className="mt-3 flex flex-wrap gap-2">
            {SOURCES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`min-h-11 rounded-md border px-3 text-sm ${source === item.id ? "border-signal text-signal" : "border-line text-muted"}`}
                onClick={() => setSource(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <pre className="mt-3 max-h-96 max-w-full overflow-auto rounded-md bg-bg p-3 font-mono text-xs leading-relaxed text-fg">
            {activeSource.body}
          </pre>
        </details>
      </div>
    </main>
  );
}

function Stage({ n, ok, lines }: { n: string; ok: boolean; lines: string[] }) {
  return (
    <article className="min-w-40 flex-1 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${ok ? "bg-signal" : "bg-fault"} ${ok ? "live-dot" : ""}`} />
        <h2 className="text-xs text-muted">{n}</h2>
      </div>
      {lines.map((line, index) => (
        <p key={`${n}-${index}`} className="mt-1 font-mono text-xs text-fg tabular-nums">
          {line}
        </p>
      ))}
    </article>
  );
}

function Slider({
  label,
  unit,
  min,
  max,
  step,
  digits,
  value,
  disabled,
  onChange,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  digits: number;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className={disabled ? "opacity-60" : undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <span className="font-mono text-sm tabular-nums">
          {value.toFixed(digits)} {unit}
        </span>
      </div>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function SelectNum({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: { value: number; label: string }[];
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted">{label}</span>
      <select className={selectClass()} value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Addr({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-1">
        {[0x76, 0x77].map((addr) => (
          <button
            key={addr}
            type="button"
            className={`min-h-11 rounded-md font-mono text-sm ${value === addr ? "bg-surface text-fg" : "text-muted"}`}
            onClick={() => onChange(addr)}
          >
            0x{hex8(addr)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "ok" | "warn" }) {
  const color = tone === "warn" ? "text-amber" : tone === "ok" ? "text-signal" : "text-fg";
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <p className={`truncate font-mono text-sm tabular-nums ${color}`}>{value}</p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function deltaTone(delta: number | null, tol = 0.02): "ok" | "warn" | undefined {
  if (delta == null) return undefined;
  return Math.abs(delta) <= tol ? "ok" : "warn";
}

function Reg({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="text-right text-fg">{v}</dd>
    </>
  );
}
