import { MongoClient } from 'mongodb';
import { config } from './config.js';
import { logger } from './logger.js';

let client = null;
let database = null;
let memoryFallback = null;

class InMemoryCollection {
  constructor() {
    this.byLink = new Map();
    this.byUrl = new Map();
  }
  async findOne(query) {
    if (query.link) return this.byLink.get(query.link) ?? null;
    if (query.url) return this.byUrl.get(query.url) ?? null;
    return null;
  }
  async insertOne(doc) {
    const stored = { ...doc, _id: `${doc.link ?? Date.now()}` };
    if (doc.link) this.byLink.set(doc.link, stored);
    if (doc.url) this.byUrl.set(doc.url, stored);
    return { acknowledged: true, insertedId: stored._id };
  }
}

class InMemoryDb {
  constructor() {
    this.collections = new Map();
  }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new InMemoryCollection());
    return this.collections.get(name);
  }
}

export async function connectDb() {
  try {
    client = new MongoClient(config.DATABASE, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    });
    await client.connect();
    database = client.db(config.DATABASE_NAME);
    await database.command({ ping: 1 });
    logger.info({ db: config.DATABASE_NAME }, 'database connected');
    return database;
  } catch (err) {
    logger.warn({ err: err.message }, 'database unavailable — falling back to in-memory store');
    memoryFallback = new InMemoryDb();
    return memoryFallback;
  }
}

export function getDb() {
  if (database) return database;
  if (memoryFallback) return memoryFallback;
  throw new Error('db not initialized — call connectDb() first');
}

export async function closeDb() {
  if (client) {
    try {
      await client.close();
      logger.info('database closed');
    } catch (err) {
      logger.warn({ err: err.message }, 'error closing database');
    }
  }
}
