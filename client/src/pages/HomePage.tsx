import { useAuth } from '../lib/auth';

export default function HomePage() {
  const { user } = useAuth();
  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-xl font-bold text-gray-900">
        Welcome, {user?.displayName ?? ''}
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        The production modules are being built phase by phase. The dashboard will appear here.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          ['Raw material', 'Purchases & cloth stock', 'Phase 4'],
          ['Cutting', 'Plans, actuals & variance', 'Phase 5'],
          ['Job work', 'Contractors, receipts & payments', 'Phase 6'],
          ['Checking & packing', 'Quality and finished goods', 'Phase 7'],
          ['Reports', 'Excel exports & traceability', 'Phase 8'],
          ['Dashboard', 'KPIs, charts & alerts', 'Phase 9'],
        ].map(([title, desc, phase]) => (
          <div key={title} className="rounded-2xl border border-gray-200 bg-white p-4">
            <p className="font-semibold text-gray-800">{title}</p>
            <p className="mt-0.5 text-sm text-gray-500">{desc}</p>
            <p className="mt-2 text-xs font-medium text-violet-500">{phase}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
