# Minarrador sync server

A single serverless function between the app and MongoDB. The app signs in with Google and sends its **ID token**. The server verifies that token with Google and stores the caller's light data under their Google `sub`. The app never holds database credentials.

What it stores, one document per user per kind (`docs` collection, `_id = "<sub>:<kind>"`):

| kind | contents |
|---|---|
| `settings` | The portable settings only (`SYNCED_SETTINGS` in `src-tauri/src/cloud.rs`). No paths, devices or per-machine values. |
| `snippets` | Quick copy |
| `todos` | The to-do list |
| `dictations` | Dictation text (never audio) |

Plus one `users` document per account (email, name, first and last seen). Audio, transcripts, meeting notes and PDFs never reach it.

## Set up (about 15 minutes)

1. **MongoDB Atlas**: create a cluster (M0 is free) and a database user. Under *Network Access*, allow `0.0.0.0/0`, because Vercel's egress IPs are not fixed. Copy the `mongodb+srv://…` connection string.
2. **Google Cloud Console** → *APIs & Services*:
   - Set up the *OAuth consent screen* (External; scopes `openid`, `email`, `profile`). Add yourself as a test user while it is in testing.
   - Under *Credentials* → *Create credentials* → *OAuth client ID* → application type **Desktop app**. Note the client id and client secret. Google does not treat a Desktop client's secret as confidential; PKCE protects the flow.
3. **Deploy this folder** to Vercel:
   ```sh
   cd server
   npm install
   npx vercel link          # once
   npx vercel env add MONGODB_URI
   npx vercel env add GOOGLE_CLIENT_ID
   npx vercel deploy --prod
   ```
   `MONGODB_DB` is optional (default `minarrador`). See `.env.example`.
4. **Build the app pointing at it.** The three values are compiled in:
   ```powershell
   $env:MINARRADOR_SYNC_URL = "https://<your-project>.vercel.app"
   $env:MINARRADOR_GOOGLE_CLIENT_ID = "<client id>"
   $env:MINARRADOR_GOOGLE_CLIENT_SECRET = "<client secret>"
   npm run dist        # or: npm start, for a dev run
   ```
   A build made without them shows no sync section at all. The same variables are also read at run time, which overrides the compiled values and is handy for development. `http://localhost` (for `vercel dev`) is accepted only by debug builds; release builds require `https://`.

## API

```
GET  /api/sync               Authorization: Bearer <Google ID token>
  → { docs: { <kind>: { data, updatedAt } } }

PUT  /api/sync?kind=<kind>   { data, updatedAt }
  → { applied, doc: { data, updatedAt } }
```

A `PUT` is stored only if its `updatedAt` is newer than the stored one, and the filter decides that atomically. Otherwise `applied` is `false` and the newer stored document comes back for the app to adopt. A clock running more than 5 minutes ahead is clamped, so it cannot pin a document for ever. Bodies over 4 MB are refused.
