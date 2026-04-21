/**
 * Unit tests for notifications.composeAlertEmail (Task #63).
 *
 * Covers:
 *   • Subject has the right prefix + outcome tag
 *   • Plain-text body includes all the required sections
 *   • HTML body escapes special characters in user-supplied fields
 *   • Flagged-records footer appears only when non-empty
 *   • Missing fields (no sender / no subject) render as "—" gracefully
 *
 * Run: npx tsx scripts/test-notification-composer.ts
 * No database access, no Gmail send, fully offline.
 */

import { composeAlertEmail, type EmailLogForAlert } from '../src/services/notifications.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function expect(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    const msg = `[FAIL] ${name}${detail ? ' — ' + detail : ''}`;
    failures.push(msg);
    console.log(msg);
  }
}

/* ── Fixtures ─────────────────────────────────────────────────── */

const base: EmailLogForAlert = {
  id: 'email-log-abc',
  gmail_message_id: 'gmail-xyz',
  sender: 'Operator Bot <ops@example.com>',
  subject: '2026.04 Monthly — LINK VJ RANCH',
  received_at: '2026-04-21T14:03:00Z',
  status: 'failed',
  attachments_found: 1,
  attachments_processed: 0,
  error_messages: [
    '[report.pdf] Parser error: Expected header row at line 1',
    '[report.pdf] Unrecognized format — flagged for manual review',
  ],
  retry_count: 0,
  max_retries: 5,
  last_retry_outcome: 'permanent_failure',
  alert_sent_at: null,
};

/* ── Subject line ────────────────────────────────────────────── */
console.log('\n── Subject line ──');

{
  const { subject } = composeAlertEmail({
    row: base,
    flagged: [],
    dashboardUrl: 'https://d.test',
  });
  expect(
    'subject starts with [ProductionAggregator]',
    subject.startsWith('[ProductionAggregator]'),
    subject
  );
  expect(
    'subject says "permanent failure" for permanent_failure outcome',
    subject.toLowerCase().includes('permanent failure'),
    subject
  );
  expect(
    'subject includes email subject snippet',
    subject.includes('LINK VJ RANCH'),
    subject
  );
}

{
  const exhausted = { ...base, last_retry_outcome: 'exhausted' as const };
  const { subject } = composeAlertEmail({
    row: exhausted,
    flagged: [],
    dashboardUrl: 'https://d.test',
  });
  expect(
    'subject says "exhausted failure" for exhausted outcome',
    subject.toLowerCase().includes('exhausted failure'),
    subject
  );
}

/* ── Text body sections ──────────────────────────────────────── */
console.log('\n── Text body ──');

{
  const { textBody } = composeAlertEmail({
    row: base,
    flagged: [],
    dashboardUrl: 'https://d.test',
  });
  expect('text body mentions "Outcome:"', textBody.includes('Outcome:'));
  expect('text body mentions "EMAIL"', textBody.includes('EMAIL'));
  expect('text body mentions "ERRORS"', textBody.includes('ERRORS'));
  expect('text body includes the sender', textBody.includes('ops@example.com'));
  expect('text body includes the subject', textBody.includes('LINK VJ RANCH'));
  expect(
    'text body includes at least one error',
    textBody.includes('Parser error: Expected header row')
  );
  expect('text body has dashboard URL', textBody.includes('https://d.test'));
  expect(
    'text body says 0/5 attempts for fresh permanent failure',
    textBody.includes('Attempts: 0/5')
  );
}

/* ── HTML escaping ───────────────────────────────────────────── */
console.log('\n── HTML escaping ──');

{
  const tricky: EmailLogForAlert = {
    ...base,
    sender: 'Alice <alice+"evil"@example.com>',
    subject: '<script>alert(1)</script> & bad chars',
    error_messages: ['Parser error: <unterminated> & "bad"'],
  };
  const { htmlBody } = composeAlertEmail({
    row: tricky,
    flagged: [],
    dashboardUrl: 'https://d.test',
  });
  expect(
    'HTML escapes the sender angle brackets',
    !htmlBody.includes('<alice+"evil"@example.com>')
  );
  expect(
    'HTML escapes the <script> tag in subject',
    !htmlBody.includes('<script>alert(1)</script>') &&
      htmlBody.includes('&lt;script&gt;')
  );
  expect(
    'HTML escapes ampersand in error',
    htmlBody.includes('&amp;') && !htmlBody.includes('& "bad"')
  );
}

/* ── Flagged-records footer ──────────────────────────────────── */
console.log('\n── Flagged-records footer ──');

{
  const { textBody, htmlBody } = composeAlertEmail({
    row: base,
    flagged: [],
    dashboardUrl: 'https://d.test',
  });
  expect(
    'empty flagged → text body does NOT include "ROW-LEVEL"',
    !textBody.includes('ROW-LEVEL REJECTIONS')
  );
  expect(
    'empty flagged → html body does NOT include "Row-level rejections"',
    !htmlBody.includes('Row-level rejections')
  );
}

{
  const flagged = [
    {
      file: 'Feb_2026_WIO.pdf',
      reason: 'api10 missing — fell back to name lookup',
      created_at: '2026-04-21T12:00:00Z',
    },
    {
      file: 'March_2026_Daily.xlsx',
      reason: 'well name "Hideout 1H" not found in wells',
      created_at: '2026-04-21T13:00:00Z',
    },
  ];
  const { textBody, htmlBody } = composeAlertEmail({
    row: base,
    flagged,
    dashboardUrl: 'https://d.test',
  });
  expect(
    'non-empty flagged → text body includes section',
    textBody.includes('ROW-LEVEL REJECTIONS')
  );
  expect(
    'non-empty flagged → html body includes section',
    htmlBody.includes('Row-level rejections')
  );
  expect(
    'flagged footer shows file names',
    textBody.includes('Feb_2026_WIO.pdf') && textBody.includes('March_2026_Daily.xlsx')
  );
}

/* ── Missing fields render gracefully ────────────────────────── */
console.log('\n── Missing fields ──');

{
  const stripped: EmailLogForAlert = {
    ...base,
    sender: null,
    subject: null,
    received_at: null,
    error_messages: null,
    retry_count: null,
    max_retries: null,
  };
  const { textBody } = composeAlertEmail({
    row: stripped,
    flagged: [],
    dashboardUrl: 'https://d.test',
  });
  expect('null sender → "—"', textBody.includes('From: —'));
  expect('null subject → "—"', textBody.includes('Subject: —'));
  expect('null received_at → "—"', textBody.includes('Received: —'));
  expect(
    'no error messages → "(none recorded)"',
    textBody.includes('(none recorded)')
  );
  expect('null retry_count → "Attempts: —"', textBody.includes('Attempts: —'));
}

/* ── Summary ──────────────────────────────────────────────────── */
console.log(`\n── Summary: ${pass} passed, ${fail} failed ──`);
if (fail > 0) {
  for (const f of failures) console.log(f);
  process.exit(1);
}
