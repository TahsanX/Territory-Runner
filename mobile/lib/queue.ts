import * as SQLite from 'expo-sqlite';

/**
 * Offline-first coordinate queue.
 *
 * A runner in a dead zone must not lose a territory. Every accepted GPS fix is
 * written to SQLite first and only then uploaded, so the source of truth lives
 * on the device until the server has confirmed receipt.
 *
 * SQLite rather than MMKV or AsyncStorage: a run is thousands of rows that need
 * ordering, range selection and a pending/sent flag. That is a query problem,
 * not a key-value one, and a 30-minute run serialised into one JSON blob would
 * be rewritten in full on every single fix.
 *
 * `seq` is a per-session monotonic counter that matches the
 * (running_session_id, seq) unique constraint in config/schema.sql, which is
 * what makes a replayed batch idempotent server-side. A reconnecting client
 * can therefore flush its whole backlog without any risk of double-counting
 * distance.
 */

let db: SQLite.SQLiteDatabase | null = null;

export type QueuedFix = {
  id?: number;
  sessionId: number;
  seq: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  isPauseMarker: boolean;
  recordedAt: string;
};

export async function open(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync('territory-runner.db');

  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS fixes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL,
      seq         INTEGER NOT NULL,
      latitude    REAL NOT NULL,
      longitude   REAL NOT NULL,
      accuracy    REAL,
      is_pause    INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL,
      sent        INTEGER NOT NULL DEFAULT 0,
      UNIQUE (session_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_fixes_pending
      ON fixes (session_id, sent, seq);

    -- Survives the app being killed mid-run, so a crash or a swipe-away does
    -- not orphan the session.
    CREATE TABLE IF NOT EXISTS active_run (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      session_id  INTEGER NOT NULL,
      started_at  TEXT NOT NULL,
      local_date  TEXT NOT NULL,
      tz_offset   INTEGER NOT NULL,
      next_seq    INTEGER NOT NULL DEFAULT 0,
      paused_ms   INTEGER NOT NULL DEFAULT 0,
      is_paused   INTEGER NOT NULL DEFAULT 0
    );
  `);

  return db;
}

export async function startRun(
  sessionId: number,
  localDate: string,
  tzOffset: number
): Promise<void> {
  const d = await open();
  await d.runAsync('DELETE FROM active_run');
  await d.runAsync(
    `INSERT INTO active_run (id, session_id, started_at, local_date, tz_offset, next_seq)
     VALUES (1, ?, ?, ?, ?, 0)`,
    [sessionId, new Date().toISOString(), localDate, tzOffset]
  );
}

export type ActiveRun = {
  sessionId: number;
  startedAt: string;
  localDate: string;
  tzOffset: number;
  nextSeq: number;
  pausedMs: number;
  isPaused: boolean;
};

export async function getActiveRun(): Promise<ActiveRun | null> {
  const d = await open();
  const row = await d.getFirstAsync<any>('SELECT * FROM active_run WHERE id = 1');
  if (!row) return null;
  return {
    sessionId: row.session_id,
    startedAt: row.started_at,
    localDate: row.local_date,
    tzOffset: row.tz_offset,
    nextSeq: row.next_seq,
    pausedMs: row.paused_ms,
    isPaused: Boolean(row.is_paused),
  };
}

export async function clearActiveRun(): Promise<void> {
  const d = await open();
  await d.runAsync('DELETE FROM active_run');
}

export async function setPaused(paused: boolean, pausedMs: number): Promise<void> {
  const d = await open();
  await d.runAsync(
    'UPDATE active_run SET is_paused = ?, paused_ms = ? WHERE id = 1',
    [paused ? 1 : 0, pausedMs]
  );
}

/**
 * Claim a block of sequence numbers atomically.
 *
 * The background task and the foreground UI can both append, so handing out
 * seq values has to be serialised — two concurrent writers picking the same
 * number would collide on the UNIQUE constraint and silently drop a fix.
 */
export async function reserveSeq(count: number): Promise<number> {
  const d = await open();
  let start = 0;
  await d.withExclusiveTransactionAsync(async (tx) => {
    const row = await tx.getFirstAsync<any>('SELECT next_seq FROM active_run WHERE id = 1');
    start = row ? row.next_seq : 0;
    await tx.runAsync('UPDATE active_run SET next_seq = ? WHERE id = 1', [start + count]);
  });
  return start;
}

export async function enqueue(fixes: QueuedFix[]): Promise<void> {
  if (!fixes.length) return;
  const d = await open();

  // One transaction for the batch: committing per row would fsync repeatedly
  // and is noticeably slow on a phone.
  await d.withTransactionAsync(async () => {
    for (const f of fixes) {
      await d!.runAsync(
        `INSERT OR IGNORE INTO fixes
           (session_id, seq, latitude, longitude, accuracy, is_pause, recorded_at, sent)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [f.sessionId, f.seq, f.latitude, f.longitude,
         f.accuracy, f.isPauseMarker ? 1 : 0, f.recordedAt]
      );
    }
  });
}

export async function pending(sessionId: number, limit = 200): Promise<QueuedFix[]> {
  const d = await open();
  const rows = await d.getAllAsync<any>(
    `SELECT id, session_id, seq, latitude, longitude, accuracy, is_pause, recorded_at
       FROM fixes
      WHERE session_id = ? AND sent = 0
      ORDER BY seq ASC
      LIMIT ?`,
    [sessionId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    latitude: r.latitude,
    longitude: r.longitude,
    accuracy: r.accuracy,
    isPauseMarker: Boolean(r.is_pause),
    recordedAt: r.recorded_at,
  }));
}

/** Only ever called after the server has acknowledged the batch. */
export async function markSent(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const d = await open();
  const marks = ids.map(() => '?').join(',');
  await d.runAsync(`UPDATE fixes SET sent = 1 WHERE id IN (${marks})`, ids);
}

export async function pendingCount(sessionId: number): Promise<number> {
  const d = await open();
  const row = await d.getFirstAsync<any>(
    'SELECT COUNT(*) AS n FROM fixes WHERE session_id = ? AND sent = 0',
    [sessionId]
  );
  return row?.n ?? 0;
}

/** The full recorded track, for drawing the route and measuring distance. */
export async function track(sessionId: number): Promise<QueuedFix[]> {
  const d = await open();
  const rows = await d.getAllAsync<any>(
    `SELECT seq, latitude, longitude, accuracy, is_pause, recorded_at
       FROM fixes WHERE session_id = ? ORDER BY seq ASC`,
    [sessionId]
  );
  return rows.map((r) => ({
    sessionId,
    seq: r.seq,
    latitude: r.latitude,
    longitude: r.longitude,
    accuracy: r.accuracy,
    isPauseMarker: Boolean(r.is_pause),
    recordedAt: r.recorded_at,
  }));
}

/**
 * Drop a finished session's fixes once everything has been acknowledged.
 * Deliberately refuses to delete anything still pending — losing an unsent
 * territory to a cleanup routine would be the worst possible bug here.
 */
export async function clearSession(sessionId: number): Promise<boolean> {
  const d = await open();
  const outstanding = await pendingCount(sessionId);
  if (outstanding > 0) return false;
  await d.runAsync('DELETE FROM fixes WHERE session_id = ?', [sessionId]);
  return true;
}

/** Any session with unsent fixes, so a backlog can be flushed on next launch. */
export async function sessionsWithBacklog(): Promise<number[]> {
  const d = await open();
  const rows = await d.getAllAsync<any>(
    'SELECT DISTINCT session_id FROM fixes WHERE sent = 0 ORDER BY session_id'
  );
  return rows.map((r) => r.session_id);
}
