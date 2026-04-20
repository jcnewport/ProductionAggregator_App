/**
 * One-shot script: generate a Gmail refresh token for ProductionAggregator
 * ---------------------------------------------------------------------------
 * Run locally ONCE. You:
 *   1. Put the downloaded Google OAuth JSON at  ../gmail-credentials.json  (repo root)
 *   2. Run:                                     npx tsx api/scripts/get-gmail-refresh-token.ts
 *   3. A URL prints in the terminal — open it, sign in as S.IS_AD_Prod@stewardship.is,
 *      and grant the scopes.
 *   4. Google redirects to http://localhost:53682/callback?code=XYZ — this script's
 *      local server grabs the code, exchanges it for a refresh token, and prints it.
 *   5. Copy the refresh token into Railway as the env var GMAIL_REFRESH_TOKEN.
 *
 * Why this flow? We use Google's "Desktop app" OAuth type with a loopback redirect.
 * It means no need to host a public callback URL — Google sends the auth code right
 * to this script's local server. Safe, simple, one-time.
 */

import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

// Gmail scopes we need:
//   gmail.readonly    — list/read messages
//   gmail.modify      — mark messages as read after processing
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

// The port we'll run our local callback server on
const CALLBACK_PORT = 53682;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;

async function main(): Promise<void> {
  // Locate the credentials JSON
  const repoRoot = path.resolve(__dirname, '..', '..');
  const credsPath = path.join(repoRoot, 'gmail-credentials.json');

  if (!fs.existsSync(credsPath)) {
    console.error(
      `\n  ERROR: Credentials file not found at:\n    ${credsPath}\n\n` +
        `  Steps:\n` +
        `    1. In Google Cloud Console, download the OAuth Desktop client JSON\n` +
        `    2. Rename it to: gmail-credentials.json\n` +
        `    3. Put it at the repo root (next to package.json)\n` +
        `    4. Re-run this script.\n`
    );
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  const { client_id, client_secret } = credentials.installed || credentials.web || {};
  if (!client_id || !client_secret) {
    console.error('Credentials file is missing client_id or client_secret.');
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(client_id, client_secret, CALLBACK_URL);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',  // Critical — this is what returns a refresh_token
    prompt: 'consent',       // Force re-consent so we always get a fresh refresh_token
    scope: SCOPES,
  });

  console.log('\n==========================================================');
  console.log(' Step 1 — Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n Step 2 — Sign in as: S.IS_AD_Prod@stewardship.is');
  console.log(' Step 3 — Grant the permissions Google shows you.');
  console.log(' Step 4 — Google will redirect back to this script automatically.');
  console.log('==========================================================\n');

  // Spin up a tiny HTTP server to catch the redirect
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) return;
      const url = new URL(req.url, CALLBACK_URL);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400).end('Missing "code" query parameter');
        return;
      }

      const { tokens } = await oauth2.getToken(code);
      const refresh = tokens.refresh_token;

      if (!refresh) {
        res.writeHead(500).end(
          'No refresh_token returned. Try revoking access at https://myaccount.google.com/permissions and run this script again.'
        );
        console.error('\nERROR: No refresh_token in token response.');
        console.error('Tokens:', tokens);
        process.exit(1);
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family:system-ui;padding:40px;max-width:600px">
          <h2>Success!</h2>
          <p>Your refresh token has been captured. You can close this tab and return to your terminal.</p>
        </body></html>
      `);

      console.log('\n==========================================================');
      console.log(' SUCCESS — Refresh token generated.\n');
      console.log(' Copy the following values into Railway environment variables:\n');
      console.log(`   GMAIL_CLIENT_ID     = ${client_id}`);
      console.log(`   GMAIL_CLIENT_SECRET = ${client_secret}`);
      console.log(`   GMAIL_REFRESH_TOKEN = ${refresh}`);
      console.log(`   GMAIL_MONITORED_EMAIL = S.IS_AD_Prod@stewardship.is`);
      console.log('==========================================================\n');

      // Also write to a local .env.local.generated for convenience (gitignored)
      const envPath = path.join(repoRoot, 'api', '.env.local.generated');
      fs.writeFileSync(
        envPath,
        [
          `GMAIL_CLIENT_ID=${client_id}`,
          `GMAIL_CLIENT_SECRET=${client_secret}`,
          `GMAIL_REFRESH_TOKEN=${refresh}`,
          `GMAIL_MONITORED_EMAIL=S.IS_AD_Prod@stewardship.is`,
          '',
        ].join('\n')
      );
      console.log(`(Also saved to ${envPath} — gitignored)\n`);

      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 1000);
    } catch (err) {
      console.error('Callback error:', err);
      res.writeHead(500).end('Error — see terminal');
    }
  });

  server.listen(CALLBACK_PORT, () => {
    console.log(`Waiting for Google redirect on ${CALLBACK_URL} ...`);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
