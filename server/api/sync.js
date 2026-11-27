// GET  /api/sync             → { docs: { <kind>: { data, updatedAt } } }
// PUT  /api/sync?kind=<kind>   { data, updatedAt } → { applied, doc }
//
// One document per user per kind. A write lands only if it is newer than what
// is stored (last write wins, decided atomically by the filter); otherwise the
// stored, newer document comes back and the app adopts it.
//
// Only light data: the app never sends audio, transcripts or notes, and this
// endpoint refuses anything but the four kinds and anything over MAX_BYTES.

import { collections } from '../lib/db.js';
import { userFrom } from '../lib/auth.js';

const KINDS = new Set(['settings', 'snippets', 'todos', 'dictations']);
const MAX_BYTES = 4 * 1024 * 1024;
/** A client clock running ahead may not pin a document for ever. */
const MAX_SKEW_MS = 5 * 60 * 1000;

const plain = (doc) => ({ data: doc.data, updatedAt: doc.updatedAt });

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const { docs, users } = await collections();

    if (req.method === 'GET') {
      await users.updateOne(
        { _id: user.sub },
        { $set: { email: user.email, name: user.name, lastSeenAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );
      const out = {};
      for (const doc of await docs.find({ userId: user.sub }).toArray()) out[doc.kind] = plain(doc);
      return res.status(200).json({ docs: out });
    }

    if (req.method === 'PUT') {
      const kind = String(req.query.kind ?? '');
      if (!KINDS.has(kind)) return res.status(400).json({ error: 'unknown kind' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const data = body?.data;
      const shapeOk = kind === 'settings' ? data && typeof data === 'object' && !Array.isArray(data) : Array.isArray(data);
      if (!shapeOk) return res.status(400).json({ error: 'bad data' });
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES) return res.status(413).json({ error: 'too large' });
      let updatedAt = Number(body?.updatedAt);
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) return res.status(400).json({ error: 'bad updatedAt' });
      updatedAt = Math.min(Math.round(updatedAt), Date.now() + MAX_SKEW_MS);

      const _id = `${user.sub}:${kind}`;
      let applied = true;
      try {
        // Matches only an older document (or none, and then inserts). A newer
        // one makes the upsert collide on _id: that write lost.
        await docs.updateOne(
          { _id, updatedAt: { $lt: updatedAt } },
          { $set: { userId: user.sub, kind, data, updatedAt } },
          { upsert: true },
        );
      } catch (e) {
        if (e?.code !== 11000) throw e;
        applied = false;
      }
      const doc = await docs.findOne({ _id });
      return res.status(200).json({ applied, doc: plain(doc) });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server error' });
  }
}
