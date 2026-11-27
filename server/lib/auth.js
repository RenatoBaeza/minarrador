// Who is calling: the Google ID token in the Authorization header, verified
// against Google's keys and this app's client id. The user id is the token's
// `sub` — the client never says whose data it is touching.

import { OAuth2Client } from 'google-auth-library';

const google = new OAuth2Client();

export async function userFrom(req) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const audience = (process.env.GOOGLE_CLIENT_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!audience.length) throw new Error('GOOGLE_CLIENT_ID is not set');
  try {
    const ticket = await google.verifyIdToken({ idToken: token, audience });
    const p = ticket.getPayload();
    if (!p?.sub) return null;
    return { sub: p.sub, email: p.email ?? '', name: p.name ?? '' };
  } catch {
    return null;
  }
}
