import { useState, type ReactNode } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { activeOfficeId, api, switchOffice } from '../api/client';
import { useAuth } from '../lib/auth';
import { useHealth } from '../api/health';
import { UpdateBanner } from './UpdateBanner';
import { Badge } from './ui';

type NavItem = {
  to: string;
  label: string;
  icon: string;
  roles?: Array<'admin' | 'operator' | 'owner'>;
};
type NavSection = { title: string; items: NavItem[] };

/** Grows with each phase; only list routes that exist. */
const NAV: NavSection[] = [
  {
    title: '',
    items: [
      { to: '/', label: 'Home', icon: '🏠' },
      { to: '/stock/raw', label: 'Inventory', icon: '📦' },
      { to: '/reports', label: 'Reports', icon: '📊' },
      { to: '/trace', label: 'Traceability', icon: '🧭' },
    ],
  },
  {
    title: 'Production',
    items: [
      { to: '/purchases', label: 'Purchases', icon: '🧾' },
      { to: '/cutting', label: 'Cutting', icon: '✂️' },
      { to: '/jobs', label: 'Job Work', icon: '🧵' },
      { to: '/checking', label: 'Checking & Packing', icon: '🔍' },
      { to: '/dispatches', label: 'Dispatches', icon: '🚚' },
      // contractors' performance and everyone's ledgers live under Pending Dues
      { to: '/dues', label: 'Pending Dues', icon: '💰' },
      { to: '/discrepancies', label: 'Discrepancies', icon: '⚖️' },
    ],
  },
  {
    title: 'Masters',
    items: [
      { to: '/masters/colors', label: 'Colors', icon: '🎨' },
      { to: '/masters/sizes', label: 'Sizes', icon: '📏' },
      { to: '/masters/vendors', label: 'Vendors', icon: '🏬' },
      { to: '/masters/contractors', label: 'Contractors', icon: '🧵' },
      { to: '/masters/staff', label: 'Checkers & Packers', icon: '🧍' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/admin/offices', label: 'Offices', icon: '🏢', roles: ['admin'] },
      { to: '/admin/opening-balances', label: 'Opening Balances', icon: '🧮', roles: ['admin'] },
      { to: '/admin/users', label: 'Users', icon: '👥', roles: ['admin'] },
      { to: '/admin/audit', label: 'Audit Log', icon: '📜', roles: ['admin'] },
      { to: '/admin/backups', label: 'Backups', icon: '💾', roles: ['admin'] },
      { to: '/admin/system', label: 'System Health', icon: '🩺', roles: ['admin'] },
    ],
  },
];

const ROLE_TONE = { admin: 'violet', operator: 'blue', owner: 'green' } as const;

type OfficeRow = { id: number; code: string; name: string };

/**
 * The office this session works in (ADR-028). Admin/owner switch offices here; the
 * whole app reloads so every number on screen belongs to one office. Operators are
 * pinned server-side and do not see a picker.
 */
function OfficeSwitcher({ role }: { role: 'admin' | 'operator' | 'owner' }) {
  const { data } = useQuery({
    queryKey: ['offices'],
    queryFn: () => api.get<{ items: OfficeRow[] }>('/api/offices'),
    staleTime: 60_000,
  });
  if (role === 'operator') return null;
  const offices = data?.items ?? [];
  if (offices.length <= 1) return null;
  const current = activeOfficeId();
  return (
    <select
      aria-label="Office"
      value={current}
      onChange={(e) => switchOffice(Number(e.target.value))}
      className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm font-medium text-gray-700"
    >
      {offices.map((o) => (
        <option key={o.id} value={o.id}>
          🏢 {o.name}
        </option>
      ))}
    </select>
  );
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const { data: health } = useHealth();
  const { data: setup } = useQuery({
    queryKey: ['setup-state'],
    queryFn: () => api.get<{ needsSetup: boolean }>('/api/system/setup-state'),
    staleTime: 60_000,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  if (!user) return null;

  // Brand-new install with no data yet → one-time setup wizard (admin only, real data only).
  if (user.role === 'admin' && !health?.demoMode && setup?.needsSetup) {
    return <Navigate to="/setup" replace />;
  }

  const visibleSections = NAV.map((s) => ({
    ...s,
    items: s.items.filter((i) => !i.roles || i.roles.includes(user.role)),
  })).filter((s) => s.items.length > 0);

  const doLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const nav = (onNavigate?: () => void) => (
    <nav className="space-y-5 p-4">
      {visibleSections.map((section) => (
        <div key={section.title}>
          {section.title && (
            <p className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              {section.title}
            </p>
          )}
          <ul className="space-y-0.5">
            {section.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium',
                      isActive
                        ? 'bg-violet-100 text-violet-800'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                    )
                  }
                >
                  <span aria-hidden>{item.icon}</span>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {health?.demoMode && (
        <div
          role="status"
          className="border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-center text-sm font-semibold text-amber-900"
        >
          🎭 DEMO MODE — sample data only. Real records are untouched.
          {user.role === 'admin' && (
            <button className="ml-2 underline" onClick={() => navigate('/admin/system')}>
              Exit from System Health
            </button>
          )}
        </div>
      )}
      <UpdateBanner canUpdate={user.role === 'admin'} />
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-gray-200 bg-white px-4">
        <button
          className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 lg:hidden"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        {/* shrink-0: without it the office switcher squashes the logo to a sliver on a phone */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-600 font-bold text-white">
          B
        </div>
        {/* the wordmark is the first thing to go when the bar gets tight */}
        <div className="hidden min-w-0 sm:block">
          <p className="truncate text-sm font-bold leading-tight text-gray-900">
            Bharti Enterprises
          </p>
          <p className="hidden text-[11px] leading-tight text-gray-400 sm:block">
            Production &amp; Inventory
          </p>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <OfficeSwitcher role={user.role} />
          <span className="hidden sm:inline">
            <Badge tone={ROLE_TONE[user.role]}>{user.role}</Badge>
          </span>
          <div className="group relative">
            <button
              aria-label={`User menu: ${user.displayName}`}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-200 text-xs font-bold text-gray-600">
                {user.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden max-w-[10rem] truncate sm:block">{user.displayName}</span>
            </button>
            <div className="invisible absolute right-0 z-50 mt-1 w-44 rounded-xl border border-gray-200 bg-white py-1 opacity-0 shadow-lg transition-all group-focus-within:visible group-focus-within:opacity-100">
              <MenuLink onClick={() => navigate('/account/password')}>Change password</MenuLink>
              <MenuLink onClick={() => void doLogout()}>Sign out</MenuLink>
            </div>
          </div>
        </div>
      </header>

      <div className="flex">
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 overflow-y-auto border-r border-gray-200 bg-white lg:block">
          {nav()}
        </aside>

        {menuOpen && (
          <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setMenuOpen(false)}>
            <div className="absolute inset-0 bg-black/40" />
            <div
              className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-white shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex h-14 items-center justify-between border-b border-gray-200 px-4">
                <p className="font-bold text-gray-900">Menu</p>
                <button
                  onClick={() => setMenuOpen(false)}
                  className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"
                  aria-label="Close menu"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {nav(() => setMenuOpen(false))}
            </div>
          </div>
        )}

        {/* pb: room for the phone tab bar so it never covers the last row */}
        <main className="min-w-0 flex-1 pb-20 lg:pb-0">
          <Outlet />
        </main>
      </div>

      <BottomBar onMenu={() => setMenuOpen(true)} />
    </div>
  );
}

const BOTTOM: Array<{ to: string; label: string; icon: string; match: (path: string) => boolean }> =
  [
    { to: '/', label: 'Home', icon: '🏠', match: (p) => p === '/' },
    { to: '/jobs', label: 'Jobs', icon: '🧵', match: (p) => p.startsWith('/jobs') },
    { to: '/checking', label: 'Checking', icon: '🔍', match: (p) => p.startsWith('/checking') },
    {
      to: '/dues',
      label: 'Dues',
      icon: '💰',
      match: (p) => p.startsWith('/dues') || p.startsWith('/contractors'),
    },
  ];

/**
 * Phone tab bar: the four places operators go all day, one thumb away; everything else
 * is behind "Menu". Hidden on laptops, where the sidebar is always open.
 */
function BottomBar({ onMenu }: { onMenu: () => void }) {
  const { pathname } = useLocation();
  return (
    <nav
      aria-label="Quick navigation"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-gray-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      {BOTTOM.map((item) => {
        const active = item.match(pathname);
        return (
          <NavLink
            key={item.to}
            to={item.to}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              'flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-semibold',
              active ? 'text-violet-700' : 'text-gray-500',
            )}
          >
            <span aria-hidden className="text-lg leading-none">
              {item.icon}
            </span>
            {item.label}
          </NavLink>
        );
      })}
      <button
        onClick={onMenu}
        className="flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-semibold text-gray-500"
      >
        <span aria-hidden className="text-lg leading-none">
          ☰
        </span>
        Menu
      </button>
    </nav>
  );
}

function MenuLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="block w-full px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
    >
      {children}
    </button>
  );
}
