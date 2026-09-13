import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { scanRoutes } from '../../src/worker/routes/scans';
import { signJwt } from '../../src/worker/utils/jwt';
import type { AuthContext, Env } from '../../src/worker/types';

const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
app.use('*', authMiddleware);
app.route('/', scanRoutes);

class SqliteD1 {
  private readonly sqlite = new DatabaseSync(':memory:');

  exec(sql: string): void {
    this.sqlite.exec(sql);
  }

  prepare(sql: string) {
    const sqlite = this.sqlite;
    let values: any[] = [];
    return {
      bind(...nextValues: any[]) {
        values = nextValues;
        return this;
      },
      async first<T = unknown>(): Promise<T | null> {
        return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null;
      },
      async all<T = unknown>() {
        return { results: sqlite.prepare(sql).all(...values) as T[], success: true, meta: {} };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...values);
        return {
          success: true,
          meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
        };
      },
    };
  }

  async batch(statements: Array<{ run: () => Promise<{ success: boolean }> }>) {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  query<T = Record<string, unknown>>(sql: string, ...values: any[]): T[] {
    return this.sqlite.prepare(sql).all(...values) as T[];
  }
}

const USER_ID = 'itest_user_scan_async';
const HOUSEHOLD_ID = `hh_${USER_ID}`;
const JWT_SECRET = 'integration-test-secret-that-is-long-enough';

function applyMigrations(db: SqliteD1): void {
  const migrationDir = path.resolve(process.cwd(), 'migrations');
  for (const file of fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
  }
}

async function authHeader(): Promise<string> {
  const token = await signJwt(
    {
      sub: USER_ID,
      hid: HOUSEHOLD_ID,
      typ: 'access',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    JWT_SECRET
  );
  return `Bearer ${token}`;
}

describe('Fridge scan async canary (in-memory D1)', () => {
  let db: SqliteD1;
  let sentMessages: unknown[];

  beforeEach(() => {
    db = new SqliteD1();
    applyMigrations(db);
    db.exec(`
      INSERT INTO users (id, email, is_guest) VALUES ('${USER_ID}', 'scan-async@frigo.local', 0);
      INSERT INTO households (id, name, created_by) VALUES ('${HOUSEHOLD_ID}', 'Scan async integration', '${USER_ID}');
      INSERT INTO household_members (id, household_id, user_id, role)
        VALUES ('hm_${USER_ID}', '${HOUSEHOLD_ID}', '${USER_ID}', 'owner');
    `);
    sentMessages = [];
  });

  it('returns 202, persists a pending scan, and enqueues a tenant-scoped job', async () => {
    const queue = {
      send: async (message: unknown) => {
        sentMessages.push(message);
      },
    };
    const response = await app.fetch(
      new Request('https://itest.local/scans/fridge', {
        method: 'POST',
        headers: {
          Authorization: await authHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ imageBase64: 'aGVsbG8=' }),
      }),
      {
        DB: db as any,
        JWT_SECRET,
        SCAN_QUEUE_MODE: 'async',
        SCAN_QUEUE: queue as any,
        ENVIRONMENT: 'test',
      } as any
    );

    expect(response.status).toBe(202);
    const payload = await response.json<{ scan: { id: string } }>();
    expect(payload).toMatchObject({ success: true, queued: true, scan: { status: 'pending' } });

    const [message] = sentMessages as any[];
    expect(message).toMatchObject({
      type: 'scan.process.v1',
      scanId: payload.scan.id,
      jobId: `scan_job_${payload.scan.id}`,
      userId: USER_ID,
      householdId: HOUSEHOLD_ID,
      scanType: 'fridge',
      imageBase64: 'aGVsbG8=',
      idempotencyKey: `scan:${payload.scan.id}:v1`,
      mimeType: 'image/jpeg',
    });

    expect(db.query('SELECT id, user_id, household_id, status, scan_type FROM scans')).toEqual([
      {
        id: payload.scan.id,
        user_id: USER_ID,
        household_id: HOUSEHOLD_ID,
        status: 'pending',
        scan_type: 'fridge',
      },
    ]);
    expect(db.query('SELECT id, scan_id, status, idempotency_key FROM scan_queue_jobs')).toEqual([
      {
        id: `scan_job_${payload.scan.id}`,
        scan_id: payload.scan.id,
        status: 'pending',
        idempotency_key: `scan:${payload.scan.id}:v1`,
      },
    ]);
  });
});
