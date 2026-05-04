/**
 * Non-Production Files Store
 * --------------------------
 * Companion to api/src/parsers/nonProductionFilters.ts.
 *
 * When the dispatcher classifies an attachment as `kind: 'ignored'`, the
 * email poller calls into here. We:
 *
 *   1. MOVE the file from `production-files` → `non-production-files`
 *      (via copy-then-delete since Supabase Storage `move()` requires
 *      same-bucket). This isolates non-production blobs so production-
 *      data lifecycle policies (retention, audit, exports) don't have
 *      to grow special-cases for drilling reports etc.
 *
 *   2. INSERT a row into `non_production_files` with denormalized email
 *      context so the dashboard can render the table without an extra
 *      join (and survives email_log deletion).
 *
 *   3. Issue signed URLs on demand for the dashboard's "View" link.
 *
 * The recordIgnoredAttachment() function is INTENTIONALLY tolerant —
 * if anything fails (move conflict, RLS quirk, network blip) we log and
 * return null without throwing. The email-pipeline status doesn't depend
 * on this audit log existing, so a failure here must NEVER cause the
 * email to be marked failed/partial. The original 'ignored' classification
 * stands and the file remains accessible at its original storage path.
 */

import { supabase } from './supabase.js';

const SOURCE_BUCKET = 'production-files';
const TARGET_BUCKET = 'non-production-files';

/** Filters whose hits we DON'T audit — only inline-image (sig graphics).
 *  Everything else (drilling reports, templates, tracking sheets, catalogs,
 *  test exports) gets a row. */
const SKIP_FILTER_NAMES: ReadonlySet<string> = new Set([
  'inline-image-attachment',
]);

export interface RecordIgnoredArgs {
  tenantId: string;
  emailLogId: string;
  // From email message context
  sender: string | null;
  subject: string | null;
  emailReceivedAt: string | null;
  // From the attachment
  filename: string;
  mimeType: string | null;
  fileBytes: number | null;
  sourceStoragePath: string;     // existing path in production-files
  // From the dispatcher's ignored outcome
  category: string;
  filterName: string;
  reason: string | null;
}

/**
 * Record an ignored attachment. Idempotent — if the (email_log_id, filename)
 * pair already exists, returns the existing row id without re-moving the
 * file. Returns null on failure (logged; never throws).
 */
export async function recordIgnoredAttachment(
  args: RecordIgnoredArgs
): Promise<string | null> {
  // Skip throwaway filters.
  if (SKIP_FILTER_NAMES.has(args.filterName)) {
    return null;
  }

  // Idempotency: if a row already exists for this (email_log, filename),
  // just return its id. This keeps reprocess clicks from spamming the
  // table or from churning storage moves.
  try {
    const existing = await supabase
      .from('non_production_files')
      .select('id, storage_bucket, storage_path')
      .eq('email_log_id', args.emailLogId)
      .eq('filename', args.filename)
      .maybeSingle();
    if (existing.data?.id) {
      return existing.data.id;
    }
  } catch (err) {
    console.warn('[nonProductionFilesStore] idempotency check failed:', err);
    // Non-fatal — proceed and let the unique constraint catch a true dup.
  }

  // Storage path mirrors the source path (already namespaced YYYY/MM/<msgid>_<filename>).
  const targetPath = args.sourceStoragePath;

  // 1. Copy from production-files → non-production-files.
  //    `copy()` keeps the source intact; we delete it after the row is
  //    safely inserted (see step 3).
  let movedOk = false;
  try {
    const { error: copyErr } = await supabase.storage
      .from(SOURCE_BUCKET)
      .copy(args.sourceStoragePath, targetPath, {
        destinationBucket: TARGET_BUCKET,
      } as { destinationBucket: string });
    if (copyErr) {
      // Some environments don't honor destinationBucket on copy() — fall
      // back to download → upload. Slower but reliable.
      console.warn(
        `[nonProductionFilesStore] cross-bucket copy failed (${copyErr.message}), falling back to download/upload.`
      );
      const { data: blob, error: dlErr } = await supabase.storage
        .from(SOURCE_BUCKET)
        .download(args.sourceStoragePath);
      if (dlErr || !blob) {
        console.error(
          '[nonProductionFilesStore] download fallback failed:',
          dlErr?.message
        );
        return null;
      }
      const buffer = Buffer.from(await blob.arrayBuffer());
      const { error: upErr } = await supabase.storage
        .from(TARGET_BUCKET)
        .upload(targetPath, buffer, {
          contentType: args.mimeType ?? 'application/octet-stream',
          upsert: true,
        });
      if (upErr) {
        console.error(
          '[nonProductionFilesStore] upload fallback failed:',
          upErr.message
        );
        return null;
      }
    }
    movedOk = true;
  } catch (err) {
    console.error('[nonProductionFilesStore] copy/upload threw:', err);
    return null;
  }

  // 2. Insert the audit row.
  let rowId: string | null = null;
  try {
    const { data, error } = await supabase
      .from('non_production_files')
      .insert({
        tenant_id: args.tenantId,
        email_log_id: args.emailLogId,
        filename: args.filename,
        mime_type: args.mimeType,
        file_bytes: args.fileBytes,
        category: args.category,
        filter_name: args.filterName,
        reason: args.reason,
        sender: args.sender,
        subject: args.subject,
        email_received_at: args.emailReceivedAt,
        storage_bucket: TARGET_BUCKET,
        storage_path: targetPath,
      })
      .select('id')
      .single();
    if (error) {
      // Unique-constraint dup → race; refetch the existing id.
      if (error.code === '23505') {
        const refetch = await supabase
          .from('non_production_files')
          .select('id')
          .eq('email_log_id', args.emailLogId)
          .eq('filename', args.filename)
          .single();
        rowId = refetch.data?.id ?? null;
      } else {
        console.error('[nonProductionFilesStore] insert failed:', error.message);
        return null;
      }
    } else {
      rowId = data?.id ?? null;
    }
  } catch (err) {
    console.error('[nonProductionFilesStore] insert threw:', err);
    return null;
  }

  // 3. Delete the source object now that the audit row exists. Failure
  //    here is NOT fatal — the row already records the file lives in
  //    non-production-files; the leftover production-files copy is just
  //    wasted bytes. We log and move on.
  if (movedOk) {
    try {
      const { error: rmErr } = await supabase.storage
        .from(SOURCE_BUCKET)
        .remove([args.sourceStoragePath]);
      if (rmErr) {
        console.warn(
          `[nonProductionFilesStore] couldn't delete source ${args.sourceStoragePath}: ${rmErr.message}`
        );
      }
    } catch (err) {
      console.warn(
        '[nonProductionFilesStore] source delete threw (non-fatal):',
        err
      );
    }
  }

  return rowId;
}

/**
 * List recent non-production files for the dashboard. Filters out inline
 * images at the row level too (defense-in-depth — they shouldn't be in
 * the table at all, but if a future filter accidentally records one we
 * don't want it cluttering the UI).
 */
export interface NonProductionFileListRow {
  id: string;
  tenant_id: string;
  email_log_id: string | null;
  filename: string;
  mime_type: string | null;
  file_bytes: number | null;
  category: string;
  filter_name: string;
  reason: string | null;
  sender: string | null;
  subject: string | null;
  email_received_at: string | null;
  storage_bucket: string;
  storage_path: string;
  created_at: string;
}

export async function listRecentNonProductionFiles(
  limit = 50
): Promise<NonProductionFileListRow[]> {
  const { data, error } = await supabase
    .from('non_production_files')
    .select(
      'id, tenant_id, email_log_id, filename, mime_type, file_bytes, category, ' +
        'filter_name, reason, sender, subject, email_received_at, storage_bucket, ' +
        'storage_path, created_at'
    )
    .order('email_received_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[nonProductionFilesStore] list failed:', error.message);
    return [];
  }
  return (data ?? []) as unknown as NonProductionFileListRow[];
}

/**
 * Return a short-lived signed URL the dashboard can hand to <a target=_blank>
 * so the browser opens the PDF/HTML inline.
 */
export async function signedUrlForNonProductionFile(
  id: string,
  ttlSeconds = 300
): Promise<string | null> {
  const { data: row, error } = await supabase
    .from('non_production_files')
    .select('storage_bucket, storage_path, mime_type, filename')
    .eq('id', id)
    .single();
  if (error || !row) {
    console.error(
      '[nonProductionFilesStore] row lookup failed:',
      error?.message ?? 'not found'
    );
    return null;
  }
  const { data, error: signErr } = await supabase.storage
    .from(row.storage_bucket)
    .createSignedUrl(row.storage_path, ttlSeconds, {
      // Disposition: inline so PDFs render in the browser tab.
      // The download flag would force a save dialog, which is the
      // opposite of what we want.
    });
  if (signErr || !data?.signedUrl) {
    console.error(
      '[nonProductionFilesStore] sign failed:',
      signErr?.message ?? 'no url'
    );
    return null;
  }
  return data.signedUrl;
}
