import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HistoryPoint } from "@/lib/bmp280/model";

export function ScopeChart({ data }: { data: HistoryPoint[] }) {
  return (
    <div className="h-64 w-full min-w-0 sm:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" />
          <XAxis
            dataKey="t"
            tickFormatter={(v: number) => `${v.toFixed(0)}s`}
            stroke="var(--color-muted)"
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            minTickGap={28}
          />
          <YAxis
            yAxisId="t"
            stroke="var(--color-signal)"
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            width={40}
            domain={["auto", "auto"]}
          />
          <YAxis
            yAxisId="p"
            orientation="right"
            stroke="var(--color-amber)"
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            width={48}
            domain={["auto", "auto"]}
          />
          <Tooltip
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-line)",
              borderRadius: 8,
              color: "var(--color-fg)",
              fontSize: 12,
            }}
            formatter={(value, name) => {
              const n = typeof value === "number" ? value : Number(value);
              const digits = String(name).includes("hPa") ? 2 : 3;
              return [Number.isFinite(n) ? n.toFixed(digits) : "—", String(name)];
            }}
            labelFormatter={(label) => `${Number(label).toFixed(1)} s`}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: "var(--color-muted)" }} />
          <Line
            yAxisId="t"
            type="monotone"
            dataKey="injT"
            name="Injected °C"
            stroke="var(--color-signal)"
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
          <Line
            yAxisId="t"
            type="monotone"
            dataKey="repT"
            name="Driver °C"
            stroke="var(--color-signal)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="p"
            type="monotone"
            dataKey="injP"
            name="Injected hPa"
            stroke="var(--color-amber)"
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
          <Line
            yAxisId="p"
            type="monotone"
            dataKey="repP"
            name="Driver hPa"
            stroke="var(--color-amber)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
