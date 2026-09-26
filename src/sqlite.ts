import type { Database, SQLQueryBindings } from "bun:sqlite";

/*
 * The statement helpers of the stores that keep their state in SQLite: each
 * prepares its statement, runs it once and finalizes it, whether it succeeds
 * or throws.
 */
export function runSql(db: Database, sql: string, ...params: SQLQueryBindings[]): void {
  const statement = db.prepare(sql);
  try {
    statement.run(...params);
  } finally {
    statement.finalize();
  }
}

export function getSql<T>(db: Database, sql: string, ...params: SQLQueryBindings[]): T | undefined {
  const statement = db.prepare(sql);
  try {
    return statement.get(...params) as T | undefined;
  } finally {
    statement.finalize();
  }
}

export function allSql<T>(db: Database, sql: string, ...params: SQLQueryBindings[]): T[] {
  const statement = db.prepare(sql);
  try {
    return statement.all(...params) as T[];
  } finally {
    statement.finalize();
  }
}

/* A stored JSON payload; nothing when it is absent, empty or not JSON. */
export function parseJsonPayload<T>(payload: string | undefined): T | undefined {
  if (!payload) {
    return undefined;
  }

  try {
    return JSON.parse(payload) as T;
  } catch {
    return undefined;
  }
}
