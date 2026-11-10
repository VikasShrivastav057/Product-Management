import { randomUUID } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const migrationFiles = [
  readFileSync(new URL('../drizzle/0000_learning.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../drizzle/0001_portfolio.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../drizzle/0002_tutor.sql', import.meta.url), 'utf8'),
];
const snapshotLimit = 32 * 1024 * 1024;
const conflictAttempts = 6;
const operationHistory = 128;

function migrate(database) {
  const { user_version: version } = database.prepare('PRAGMA user_version').get();
  if (version > migrationFiles.length) throw new Error('Course database schema is newer than this deployment.');
  if (version === migrationFiles.length) return;

  const migrations = migrationFiles.slice(version);
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of migrations) database.exec(migration);
    database.exec(`CREATE TABLE IF NOT EXISTS blob_commits (id TEXT PRIMARY KEY NOT NULL);
      PRAGMA user_version = ${migrationFiles.length}; COMMIT;`);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

async function withDatabase(snapshot, use) {
  const directory = await mkdtemp(join(tmpdir(), 'pm-course-'));
  const file = join(directory, 'course.sqlite');
  try {
    if (snapshot) {
      if (snapshot.size > snapshotLimit) {
        await snapshot.stream.cancel().catch(() => {});
        throw new Error('Course database exceeds the storage limit.');
      }
      let size = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.byteLength;
        if (size > snapshotLimit) callback(new Error('Course database exceeds the storage limit.'));
        else callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(snapshot.stream), limit, createWriteStream(file, { mode: 0o600 }));
    } else {
      await writeFile(file, Buffer.alloc(0), { mode: 0o600 });
    }

    const database = new DatabaseSync(file);
    let outcome;
    try {
      database.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;');
      migrate(database);
      outcome = use(database);
    } finally {
      database.close();
    }

    if (outcome.save) {
      if ((await stat(file)).size > snapshotLimit) throw new Error('Course database exceeds the storage limit.');
      return { result: outcome.result, bytes: await readFile(file) };
    }
    return outcome;
  } finally {
    await Promise.all([file, `${file}-journal`, `${file}-shm`, `${file}-wal`].map((path) => rm(path, { force: true })));
    await rmdir(directory);
  }
}

function execute(database, sql, values, mode) {
  const statement = database.prepare(sql);
  if (mode === 'first') return statement.get(...values) ?? null;
  if (mode === 'all') return { results: statement.all(...values) };
  return { meta: { changes: Number(statement.run(...values).changes) } };
}

export function createVercelStorage(blob, { prefix = 'pm-learning-lab', token, storeId, oidcToken } = {}) {
  if (!/^[a-z\d]+(?:[-_/][a-z\d]+)*$/u.test(prefix)) throw new Error('Invalid course storage namespace.');

  const credentials = { token, storeId, oidcToken };
  const databaseKey = `${prefix}/course.sqlite`;
  const readOptions = { ...credentials, access: 'private', useCache: false };
  const writeOptions = { ...credentials, access: 'private', addRandomSuffix: false, allowOverwrite: false };

  async function readObject(path) {
    try {
      return await blob.get(path, readOptions);
    } catch (error) {
      if (blob.BlobNotFoundError && error instanceof blob.BlobNotFoundError) return null;
      throw error;
    }
  }

  async function readSnapshot() {
    const object = await readObject(databaseKey);
    if (!object) return null;
    if (object.statusCode !== 200 || !object.stream || !object.blob?.etag) {
      throw new Error('The course database snapshot could not be read.');
    }
    return { stream: object.stream, size: object.blob.size, etag: object.blob.etag };
  }

  async function writableSnapshot() {
    const existing = await readSnapshot();
    if (existing) return existing;

    // An initial write contains only the schema. A conflicting or interrupted
    // creation can therefore be resolved by reading the current object safely.
    const { bytes } = await withDatabase(null, () => ({ save: true }));
    try {
      const created = await blob.put(databaseKey, bytes, { ...writeOptions, contentType: 'application/x-sqlite3' });
      if (!created.etag) throw new Error('The course database was created without an ETag.');
      return { stream: new Blob([bytes]).stream(), size: bytes.length, etag: created.etag };
    } catch (error) {
      const concurrent = await readSnapshot();
      if (concurrent) return concurrent;
      throw error;
    }
  }

  async function query(sql, values, mode) {
    if (mode !== 'run' && /^\s*SELECT\b/iu.test(sql)) {
      const snapshot = await readSnapshot();
      const { result } = await withDatabase(snapshot, (database) => ({ result: execute(database, sql, values, mode) }));
      return result;
    }

    const commit = randomUUID();
    const wasCommitted = (database) => Boolean(database.prepare('SELECT id FROM blob_commits WHERE id = ?').get(commit));
    let lastResult;
    for (let attempt = 0; attempt < conflictAttempts; attempt++) {
      const snapshot = await writableSnapshot();
      const { result, bytes } = await withDatabase(snapshot, (database) => {
        if (attempt > 0 && wasCommitted(database)) return { result: lastResult };

        database.exec('BEGIN IMMEDIATE');
        try {
          const result = execute(database, sql, values, mode);
          const { changes } = database.prepare('SELECT changes() AS changes').get();
          if (changes === 0) {
            database.exec('ROLLBACK');
            return { result };
          }
          database.prepare('INSERT INTO blob_commits (id) VALUES (?)').run(commit);
          database.prepare(`DELETE FROM blob_commits WHERE rowid <= COALESCE(
            (SELECT rowid FROM blob_commits ORDER BY rowid DESC LIMIT 1 OFFSET ?), 0)`).run(operationHistory);
          database.exec('COMMIT');
          return { result, save: true };
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      });

      if (!bytes) return result;
      lastResult = result;
      try {
        await blob.put(databaseKey, bytes, {
          ...writeOptions, allowOverwrite: true, ifMatch: snapshot.etag, contentType: 'application/x-sqlite3',
        });
        return result;
      } catch (error) {
        const conflict = blob.BlobPreconditionFailedError && error instanceof blob.BlobPreconditionFailedError;
        if (conflict && attempt + 1 < conflictAttempts) {
          await delay(8 * (attempt + 1) + Math.floor(Math.random() * 10));
          continue;
        }
        // If a response was lost after the commit, recover the outcome without
        // replaying a mutation that might already have taken effect.
        const latest = await readSnapshot().catch(() => null);
        if (latest) {
          const recovered = await withDatabase(latest, (database) => ({ result: wasCommitted(database) })).catch(() => null);
          if (recovered?.result) return result;
        }
        throw error;
      }
    }
    throw new Error('The course database is busy. Please try again.');
  }

  function portfolioPath(key) {
    if (!/^portfolio\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(key)) {
      throw new Error('Invalid portfolio object key.');
    }
    return `${prefix}/${key}`;
  }

  return {
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: () => query(sql, values, 'first'),
              all: () => query(sql, values, 'all'),
              run: () => query(sql, values, 'run'),
            };
          },
        };
      },
    },
    BUCKET: {
      put(key, file) {
        return blob.put(portfolioPath(key), file, { ...writeOptions, contentType: 'application/octet-stream' });
      },
      async get(key) {
        const object = await readObject(portfolioPath(key));
        return object?.statusCode === 200 && object.stream ? { body: object.stream } : null;
      },
      delete(key) {
        return blob.del(portfolioPath(key), credentials);
      },
    },
  };
}
