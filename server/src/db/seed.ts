/**
 * Seed dev/demo/E2E data. Usage:
 *   npm run seed             # seeds if the DB has no users
 *   npm run seed -- --force  # wipes the DB file and reseeds
 *
 * Known credentials (dev/E2E only — production creates a random admin at first boot):
 *   admin / Admin@123 · operator / Operator@123 · owner / Owner@123
 *   fresh / Fresh@123 (must change password at first sign-in)
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { closeDb, getDb } from './connection';
import { migrate } from './migrate';
import { hashPassword } from '../services/auth.service';

const force = process.argv.includes('--force');
const dbFile = path.join(config.dataDir, 'app.db');

if (force) {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
}

fs.mkdirSync(config.dataDir, { recursive: true });
const db = getDb();
migrate(db, dbFile);

const userCount = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
if (userCount > 0) {
  console.log('[seed] database already has users — pass --force to wipe and reseed');
  process.exit(0);
}

const seedAll = db.transaction(() => {
  // ---- users ----
  const insertUser = db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, must_change_password)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insertUser.run('admin', hashPassword('Admin@123'), 'Admin', 'admin', 0);
  insertUser.run('operator', hashPassword('Operator@123'), 'Om Prakash', 'operator', 0);
  insertUser.run('owner', hashPassword('Owner@123'), 'Bharti Owner', 'owner', 0);
  // one force-password-change user per Playwright project (desktop/mobile share the DB)
  insertUser.run('fresh-desktop', hashPassword('Fresh@123'), 'New Staff D', 'operator', 1);
  insertUser.run('fresh-mobile', hashPassword('Fresh@123'), 'New Staff M', 'operator', 1);

  // ---- masters ----
  const insertModel = db.prepare(
    'INSERT INTO models (code, name, description, created_by) VALUES (?, ?, ?, 1)',
  );
  insertModel.run('SCR-VEL', 'Velvet Scrunchie', 'Classic velvet, medium band');
  insertModel.run('SCR-SAT', 'Satin Scrunchie', 'Glossy satin, thin band');
  insertModel.run('SCR-COT', 'Cotton Scrunchie', 'Printed cotton, everyday wear');

  const insertColor = db.prepare('INSERT INTO colors (name, color_code, created_by) VALUES (?, ?, 1)');
  for (const [name, code] of [
    ['Black', '#111111'],
    ['Maroon', '#800000'],
    ['Navy Blue', '#000080'],
    ['Baby Pink', '#F4C2C2'],
    ['White', '#FFFFFF'],
    ['Emerald', '#046307'],
  ] as const) {
    insertColor.run(name, code);
  }

  const insertSize = db.prepare(
    'INSERT INTO sizes (code, description, sort_order, created_by) VALUES (?, ?, ?, 1)',
  );
  for (const [i, [code, desc]] of (
    [
      ['XS', 'Extra small'],
      ['S1', 'Small type 1'],
      ['S2', 'Small type 2'],
      ['L1', 'Large type 1'],
      ['XL', 'Extra large'],
    ] as const
  ).entries()) {
    insertSize.run(code, desc, i + 1);
  }

  const insertVendor = db.prepare(
    `INSERT INTO vendors (name, contact_person, mobile, address, gstin, created_by)
     VALUES (?, ?, ?, ?, ?, 1)`,
  );
  insertVendor.run('Sharma Textiles', 'Rakesh Sharma', '9812345678', 'Chandni Chowk, Delhi', '07AAACS1234A1Z5');
  insertVendor.run('Gupta Fabrics', 'Anil Gupta', '9823456789', 'Surat, Gujarat', '24AAACG5678B1Z3');

  const insertContractor = db.prepare(
    `INSERT INTO contractors (name, contact_person, mobile, address, default_rate_paise_per_dozen, created_by)
     VALUES (?, ?, ?, ?, ?, 1)`,
  );
  insertContractor.run('Meena Stitching Works', 'Meena Devi', '9834567890', 'Karol Bagh, Delhi', 3000);
  insertContractor.run('Rafiq Tailors', 'Rafiq Ahmed', '9845678901', 'Seelampur, Delhi', 2800);
  insertContractor.run('Sunita Job Work', 'Sunita Kumari', '9856789012', 'Uttam Nagar, Delhi', 3200);

  const insertStaff = db.prepare(
    'INSERT INTO staff (name, mobile, role, created_by) VALUES (?, ?, ?, 1)',
  );
  insertStaff.run('Pooja', '9867890123', 'checker');
  insertStaff.run('Ravi', '9878901234', 'packer');
  insertStaff.run('Kavita', '9889012345', 'both');

  // This is a configured, ready-to-use business — past the first-run setup wizard.
  db.prepare("INSERT INTO settings (key, value, updated_by) VALUES ('setup_complete', '1', 1)").run();
});

seedAll();
console.log('[seed] done: 4 users, 3 models, 6 colors, 5 sizes, 2 vendors, 3 contractors, 3 staff');
console.log('[seed] sign in with admin / Admin@123');
closeDb();
