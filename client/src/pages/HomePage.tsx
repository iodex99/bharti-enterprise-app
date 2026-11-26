import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatLen, formatPaise, formatPieces } from '@shared';
import { api } from '../api/client';
import { useAuth } from '../lib/auth';
import { Spinner } from '../components/ui';

/**
 * Owner dashboard. Chart colors follow the dataviz reference palette (validated:
 * blue/aqua/yellow, worst adjacent CVD ΔE 47.2). Aqua & yellow sit below 3:1 on the
 * light surface → relief rule: series carry a legend AND visible direct end-labels,
 * and every figure also exists as text in the KPI tiles.
 */
const SERIES = { blue: '#2a78d6', aqua: '#1baf7a', yellow: '#eda100' };
const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9' };
const STATUS = { warning: '#fab219', serious: '#ec835a' };

/** Recharts formatter helpers matching the library's exact signatures. */
type TooltipValue = number | string | ReadonlyArray<number | string> | undefined;
const pcsTooltip =
  (label: string) =>
  (v: TooltipValue): [string, string] => [formatPieces(Number(v ?? 0)), label];
const pcsTooltipNamed = (v: TooltipValue, name: number | string | undefined): [string, string] => [
  formatPieces(Number(v ?? 0)),
  String(name ?? ''),
];
// LabelFormatter is (label: RenderableText) => RenderableText
const pcsLabel = (v: React.ReactNode): string => formatPieces(Number(v ?? 0));

type Dashboard = {
  kpis: {
    rawLen: number;
    cutPcs: number;
    wipPcs: number;
    checkingPcs: number;
    packingPcs: number;
    fgPcs: number;
    rejectedPcs: number;
    openJobs: number;
    completedJobs: number;
    delayedJobs: number;
    pendingReceiptsPcs: number;
    unresolvedDiscrepancies: number;
    duesPaise: number;
    delayedThresholdDays: number;
  };
  trends: Array<{ month: string; cutPcs: number; receivedPcs: number; packedPcs: number }>;
  contractorBars: Array<{ name: string; receivedPcs: number }>;
  rejectionReasons: Array<{ reason: string; qtyPcs: number }>;
  fgByModel: Array<{ model: string; qtyPcs: number }>;
};

type AlertItem = {
  severity: 'info' | 'warning' | 'serious';
  title: string;
  detail: string;
  link: string;
};

export default function HomePage() {
  const { user } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<Dashboard>('/api/dashboard'),
    refetchInterval: 60_000,
  });
  const { data: alertData } = useQuery({
    queryKey: ['dashboard', 'alerts'],
    queryFn: () => api.get<{ items: AlertItem[] }>('/api/dashboard/alerts'),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const { kpis } = data;
  const dzTick = (pcs: number) => `${Math.round(pcs / 12)}dz`;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Welcome, {user?.displayName ?? ''}</h1>
        <p className="text-sm text-gray-500">Live view of the whole business</p>
      </div>

      {/* inventory pipeline tiles */}
      <section
        aria-label="Inventory by stage"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
      >
        <Tile label="Raw cloth" value={formatLen(kpis.rawLen)} to="/stock/raw" />
        <Tile label="Cut pieces" value={formatPieces(kpis.cutPcs)} to="/stock/cut" />
        <Tile label="With contractors" value={formatPieces(kpis.wipPcs)} to="/stock/wip" />
        <Tile label="In checking" value={formatPieces(kpis.checkingPcs)} to="/stock/checking" />
        <Tile label="In packing" value={formatPieces(kpis.packingPcs)} to="/stock/packing" />
        <Tile label="Finished goods" value={formatPieces(kpis.fgPcs)} to="/stock/fg" emphasize />
      </section>

      {/* business pulse tiles */}
      <section
        aria-label="Business pulse"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        <Tile label="Open jobs" value={String(kpis.openJobs)} to="/jobs" />
        <Tile
          label={`Delayed jobs (>${kpis.delayedThresholdDays}d)`}
          value={String(kpis.delayedJobs)}
          to="/jobs"
          tone={kpis.delayedJobs > 0 ? 'serious' : undefined}
        />
        <Tile
          label="Pending from contractors"
          value={formatPieces(kpis.pendingReceiptsPcs)}
          to="/jobs"
        />
        <Tile
          label="Unresolved discrepancies"
          value={String(kpis.unresolvedDiscrepancies)}
          to="/discrepancies"
          tone={kpis.unresolvedDiscrepancies > 0 ? 'warning' : undefined}
        />
        <Tile label="Contractor dues" value={formatPaise(kpis.duesPaise)} to="/dues" />
      </section>

      {/* alerts */}
      {alertData && alertData.items.length > 0 && (
        <section aria-label="Alerts" className="rounded-2xl border border-gray-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-bold text-gray-900">
            Alerts <span className="font-normal text-gray-400">({alertData.items.length})</span>
          </h2>
          <ul className="space-y-2">
            {alertData.items.map((alert, i) => (
              <li key={i}>
                <Link
                  to={alert.link}
                  className="flex items-start gap-2 rounded-lg p-1.5 hover:bg-gray-50"
                >
                  <span
                    aria-label={alert.severity}
                    className="mt-0.5 text-sm"
                    style={{
                      color:
                        alert.severity === 'serious'
                          ? STATUS.serious
                          : alert.severity === 'warning'
                            ? STATUS.warning
                            : INK.muted,
                    }}
                  >
                    {alert.severity === 'serious'
                      ? '⛔'
                      : alert.severity === 'warning'
                        ? '⚠️'
                        : 'ℹ️'}
                  </span>
                  <span className="min-w-0 text-sm">
                    <span className="font-medium text-gray-900">{alert.title}</span>{' '}
                    <span className="text-gray-500">{alert.detail}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* charts */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard title="Production trend" subtitle="Pieces per month through the pipeline">
          {data.trends.length === 0 ? (
            <ChartEmpty />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={data.trends} margin={{ top: 8, right: 56, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={INK.grid} vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fill: INK.muted, fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: INK.grid }}
                />
                <YAxis
                  tickFormatter={dzTick}
                  tick={{ fill: INK.muted, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <Tooltip formatter={pcsTooltipNamed} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="cutPcs"
                  name="Cut"
                  stroke={SERIES.blue}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  label={<EndLabel data={data.trends} color={INK.secondary} />}
                />
                <Line
                  type="monotone"
                  dataKey="receivedPcs"
                  name="Received"
                  stroke={SERIES.aqua}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  label={<EndLabel data={data.trends} color={INK.secondary} />}
                />
                <Line
                  type="monotone"
                  dataKey="packedPcs"
                  name="Packed"
                  stroke={SERIES.yellow}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  label={<EndLabel data={data.trends} color={INK.secondary} />}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Stitched pieces received per contractor" subtitle="All time">
          {data.contractorBars.length === 0 ? (
            <ChartEmpty />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart
                data={data.contractorBars}
                layout="vertical"
                margin={{ top: 4, right: 56, bottom: 0, left: 8 }}
              >
                <CartesianGrid stroke={INK.grid} horizontal={false} />
                <XAxis
                  type="number"
                  tickFormatter={dzTick}
                  tick={{ fill: INK.muted, fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: INK.grid }}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={110}
                  tick={{ fill: INK.secondary, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip formatter={pcsTooltip('Received')} />
                <Bar
                  dataKey="receivedPcs"
                  fill={SERIES.blue}
                  radius={[0, 4, 4, 0]}
                  barSize={18}
                  label={{
                    position: 'right',
                    fill: INK.secondary,
                    fontSize: 12,
                    formatter: pcsLabel,
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Why pieces fail checking" subtitle="Rejection reasons, all time">
          {data.rejectionReasons.length === 0 ? (
            <ChartEmpty note="No rejections recorded — good sign." />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={data.rejectionReasons}
                layout="vertical"
                margin={{ top: 4, right: 56, bottom: 0, left: 8 }}
              >
                <CartesianGrid stroke={INK.grid} horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: INK.muted, fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: INK.grid }}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="reason"
                  width={110}
                  tick={{ fill: INK.secondary, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip formatter={pcsTooltip('Rejected')} />
                <Bar
                  dataKey="qtyPcs"
                  fill={SERIES.blue}
                  radius={[0, 4, 4, 0]}
                  barSize={18}
                  label={{
                    position: 'right',
                    fill: INK.secondary,
                    fontSize: 12,
                    formatter: pcsLabel,
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Finished goods by model" subtitle="Ready for sale now">
          {data.fgByModel.length === 0 ? (
            <ChartEmpty />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.fgByModel} margin={{ top: 20, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={INK.grid} vertical={false} />
                <XAxis
                  dataKey="model"
                  tick={{ fill: INK.secondary, fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: INK.grid }}
                />
                <YAxis
                  tickFormatter={dzTick}
                  tick={{ fill: INK.muted, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <Tooltip formatter={pcsTooltip('In stock')} />
                <Bar
                  dataKey="qtyPcs"
                  fill={SERIES.blue}
                  radius={[4, 4, 0, 0]}
                  barSize={36}
                  label={{
                    position: 'top',
                    fill: INK.secondary,
                    fontSize: 12,
                    formatter: pcsLabel,
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      <p className="text-xs text-gray-400">
        Numbers update live from recorded transactions. For detail and Excel downloads, open{' '}
        <Link to="/reports" className="text-violet-600 hover:underline">
          Reports
        </Link>
        .
      </p>
    </div>
  );
}

function Tile({
  label,
  value,
  to,
  emphasize,
  tone,
}: {
  label: string;
  value: string;
  to: string;
  emphasize?: boolean;
  tone?: 'warning' | 'serious';
}) {
  return (
    <Link
      to={to}
      className={`rounded-2xl border p-3 transition-colors hover:border-violet-300 ${
        emphasize ? 'border-violet-200 bg-violet-50' : 'border-gray-200 bg-white'
      }`}
    >
      <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        {label}
      </p>
      <p
        className="mt-1 text-lg font-bold leading-tight text-gray-900"
        style={tone ? { color: tone === 'serious' ? '#d03b3b' : '#8a5a00' } : undefined}
      >
        {value}
      </p>
    </Link>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-2xl border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-bold text-gray-900">{title}</h2>
      <p className="mb-3 text-xs text-gray-400">{subtitle}</p>
      {children}
    </section>
  );
}

function ChartEmpty({ note }: { note?: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-xl bg-gray-50 text-sm text-gray-400">
      {note ?? 'No data yet'}
    </div>
  );
}

/** Direct label on each series' LAST point — the relief for sub-3:1 series hues. */
function EndLabel(props: Record<string, unknown> & { data: unknown[]; color: string }) {
  const { x, y, value, index, data, color } = props as {
    x?: number;
    y?: number;
    value?: number;
    index?: number;
    data: unknown[];
    color: string;
  };
  if (index !== data.length - 1 || x == null || y == null || value == null) return null;
  return (
    <text x={x + 6} y={y + 4} fill={color} fontSize={12} fontWeight={600}>
      {formatPieces(value)}
    </text>
  );
}
