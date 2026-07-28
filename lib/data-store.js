/**
 * Tiny persistent collection store.
 *
 * Records live in memory and are mirrored to a JSON file on disk (default
 * `.data/<name>.json`, git-ignored) so a local `npm start` restart does not
 * lose initialized payments or queued webhook deliveries.
 *
 * On a read-only/serverless filesystem the disk mirror silently degrades to
 * memory-only and says so once in the logs. That is acceptable for the
 * short-lived records here (access codes, delivery attempts) but a real
 * deployment should point DATA_DIR at a durable volume, or swap the two
 * `readFileSync`/`writeFileSync` calls for Postgres.
 *
 * Writes are synchronous and whole-file: these collections are small (one
 * merchant, hundreds of payments) and correctness beats throughput here.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.VALMONTPAY_DATA_DIR || path.join(__dirname, '..', '.data');

let diskWarningLogged = false;

class Collection {
  /**
   * @param {string} name file name (without extension)
   * @param {{persist?:boolean}} [options]
   */
  constructor(name, options = {}) {
    this.name = name;
    this.persist = options.persist !== false;
    /** @type {Map<string, object>} */
    this.records = new Map();
    this.file = path.join(DATA_DIR, `${name}.json`);
    this._load();
  }

  _load() {
    if (!this.persist) return;
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) this.records.set(key, value);
      }
    } catch (error) {
      console.warn(`[STORE] Could not read ${this.file}: ${error.message}. Starting empty.`);
    }
  }

  _flush() {
    if (!this.persist) return;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.records), null, 2));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      if (!diskWarningLogged) {
        console.warn(
          `[STORE] Filesystem is not writable (${error.code || error.message}). ` +
            'Running memory-only — set VALMONTPAY_DATA_DIR to a writable path for durability.'
        );
        diskWarningLogged = true;
      }
    }
  }

  get(id) {
    return this.records.get(String(id)) || null;
  }

  has(id) {
    return this.records.has(String(id));
  }

  set(id, record) {
    this.records.set(String(id), record);
    this._flush();
    return record;
  }

  /** Shallow-merge a patch into an existing record. No-op when absent. */
  update(id, patch) {
    const existing = this.get(id);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    return this.set(id, next);
  }

  delete(id) {
    const deleted = this.records.delete(String(id));
    if (deleted) this._flush();
    return deleted;
  }

  all() {
    return [...this.records.values()];
  }

  find(predicate) {
    for (const record of this.records.values()) if (predicate(record)) return record;
    return null;
  }

  filter(predicate) {
    return this.all().filter(predicate);
  }

  size() {
    return this.records.size;
  }

  /** Test helper. */
  clear() {
    this.records.clear();
    this._flush();
  }
}

const collections = new Map();

/** Get (and memoise) a named collection. */
function collection(name, options) {
  if (!collections.has(name)) collections.set(name, new Collection(name, options));
  return collections.get(name);
}

module.exports = { DATA_DIR, Collection, collection };
