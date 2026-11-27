// One MongoClient per warm function instance. Serverless instances are reused
// between requests, so the connection (and its pool) is cached at module scope
// rather than opened per request.

import { MongoClient } from 'mongodb';

let clientPromise;
let indexesReady;

export async function collections() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  clientPromise ??= new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
  }).connect();
  const client = await clientPromise.catch((e) => {
    clientPromise = undefined; // retry on the next request instead of caching the failure
    throw e;
  });
  const db = client.db(process.env.MONGODB_DB || 'minarrador');
  const docs = db.collection('docs');
  const users = db.collection('users');
  // _id is "<google sub>:<kind>", so it is unique by construction; this index
  // serves "everything of one user".
  indexesReady ??= docs.createIndex({ userId: 1 }).catch(() => (indexesReady = undefined));
  await indexesReady;
  return { docs, users };
}
