import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { loginAs, makeTestContext, type TestContext } from '../helpers';

/**
 * Resilient daily backup: scheduled for 13:00 IST, but the office PC may be off —
 * ensureDailyBackup() is idempotent and retried hourly/at boot until it succeeds.
 */
let ctx: TestContext;
let admin: string;
let backup: typeof import('../../src/services/backup.service');

beforeAll(async () => {
  ctx = await makeTestContext();
  admin = await loginAs(ctx.app, 'admin', 'Admin@123');
  backup = await import('../../src/services/backup.service');
});
afterAll(() => ctx.cleanup());

const dailyFiles = () => {
  const dir = path.join(ctx.dir, 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('daily-')) : [];
};

describe('daily backup scheduling with catch-up', () => {
  it('does nothing before 1 PM', async () => {
    const result = await backup.ensureDailyBackup(ctx.db, { date: '2026-07-11', hour: 9 });
    expect(result).toBe('too_early');
    expect(dailyFiles()).toHaveLength(0);
    expect(backup.lastDailyBackupDate(ctx.db)).toBeNull();
  });

  it('runs at/after 1 PM and records the date', async () => {
    const result = await backup.ensureDailyBackup(ctx.db, { date: '2026-07-11', hour: 13 });
    expect(result).toBe('ran');
    expect(dailyFiles()).toHaveLength(1);
    expect(backup.lastDailyBackupDate(ctx.db)).toBe('2026-07-11');
  });

  it('is idempotent: hourly retries no-op once done', async () => {
    for (const hour of [14, 18, 23]) {
      expect(await backup.ensureDailyBackup(ctx.db, { date: '2026-07-11', hour })).toBe(
        'already_done',
      );
    }
    expect(dailyFiles()).toHaveLength(1);
  });

  it('a PC switched on late in the evening still gets its backup (boot catch-up)', async () => {
    const result = await backup.ensureDailyBackup(ctx.db, { date: '2026-07-12', hour: 20 });
    expect(result).toBe('ran');
    expect(dailyFiles()).toHaveLength(2);
    expect(backup.lastDailyBackupDate(ctx.db)).toBe('2026-07-12');
  });

  it('a failure does not advance the marker, so the next tick retries', async () => {
    // sabotage: make the backups dir path un-writable by occupying it with a file
    const dir = path.join(ctx.dir, 'backups');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not a directory');
    const result = await backup.ensureDailyBackup(ctx.db, { date: '2026-07-13', hour: 13 });
    expect(result).toBe('failed');
    expect(backup.lastDailyBackupDate(ctx.db)).toBe('2026-07-12'); // unchanged

    // repair and retry — the next hourly tick succeeds
    fs.rmSync(dir, { force: true });
    const retry = await backup.ensureDailyBackup(ctx.db, { date: '2026-07-13', hour: 14 });
    expect(retry).toBe('ran');
    expect(backup.lastDailyBackupDate(ctx.db)).toBe('2026-07-13');
  });

  it('manual backups do not mark the daily as done', async () => {
    await request(ctx.app).post('/api/system/backups').set('Cookie', admin);
    expect(backup.lastDailyBackupDate(ctx.db)).toBe('2026-07-13'); // still yesterday's marker

    const listing = await request(ctx.app).get('/api/system/backups').set('Cookie', admin);
    expect(listing.body.lastDailyBackupDate).toBe('2026-07-13');
  });
});
