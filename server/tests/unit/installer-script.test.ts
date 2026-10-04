import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The office installs with ONE line:
 *
 *   irm https://github.com/iodex99/bharti-releases/releases/latest/download/install.ps1 | iex
 *
 * That only works while install.ps1 obeys rules nothing else would catch until the day
 * someone sits at the client's PC (ADR-045). There is no PowerShell in CI's test step,
 * so these are checked as text.
 */

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts');
const ps1 = fs.readFileSync(path.join(scripts, 'install.ps1'));
const cmd = fs.readFileSync(path.join(scripts, 'install.cmd'), 'utf8');

/** The script with whole-line comments removed — prose is allowed to say "exit". */
const code = ps1
  .toString('utf8')
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

describe('install.ps1 survives `irm | iex`', () => {
  it('is pure ASCII — Windows PowerShell 5.1 mangles anything else in transit', () => {
    const bad = ps1.findIndex(
      (b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09),
    );
    expect(bad, `non-ASCII byte at offset ${bad}`).toBe(-1);
  });

  it('never calls exit — under iex that closes the user’s own PowerShell window', () => {
    expect(code).not.toMatch(/(^|[;{}\s])exit(\s|;|$)/im);
    expect(code).not.toMatch(/\[Environment\]::Exit/i);
  });

  it('does not rely on $PSScriptRoot — it is empty when the script arrives as a string', () => {
    expect(code).not.toMatch(/\$PSScriptRoot/i);
  });

  it('forces TLS 1.2 for its own downloads (older Windows 10 does not default to it)', () => {
    expect(code).toMatch(/Tls12/);
  });
});

describe('install.cmd (double-click / offline)', () => {
  it('runs the install.ps1 sitting next to it, and keeps its window open at the end', () => {
    expect(cmd).toMatch(/%~dp0install\.ps1/);
    expect(cmd).toMatch(/-ExecutionPolicy Bypass/);
    expect(cmd).toMatch(/-PauseAtEnd/);
  });
});
