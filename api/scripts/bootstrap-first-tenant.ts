/**
 * Bootstrap the very first tenant and super-admin.
 * ---------------------------------------------------------------
 * Use ONCE on a fresh Supabase project to create:
 *   1. A `tenants` row for the initial customer
 *   2. A Supabase Auth user for the super-admin
 *   3. A `user_tenants` row linking that user to the new tenant
 *      with `is_super_admin = true`
 *
 * This solves the chicken-and-egg problem: the Admin UI is gated by
 * super-admin, so you can't make the first super-admin in the UI.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-first-tenant.ts \
 *     --tenant-name "Acme Energy"                     \
 *     --tenant-slug acme                              \
 *     --tenant-alias acme.prod@stewardship.is         \
 *     --admin-email founder@acme.example
 *
 * Env vars required:
 *   SUPABASE_URL              - your project URL
 *   SUPABASE_SERVICE_KEY      - service-role key (NOT the anon key)
 *
 * After running:
 *   - The script prints a one-time magic-link URL for the admin user
 *   - The admin clicks it, sets a password, and they're in
 *   - Subsequent users are invited from the Admin UI (no need to
 *     run this script again unless you stand up another fresh project)
 */
import { supabase } from '../src/services/supabase.js';

interface Args {
  tenantName: string;
  tenantSlug: string;
  tenantAlias: string;
  adminEmail: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0 || i + 1 >= argv.length) return undefined;
    return argv[i + 1];
  };

  const tenantName = get('--tenant-name');
  const tenantSlug = get('--tenant-slug');
  const tenantAlias = get('--tenant-alias');
  const adminEmail = get('--admin-email');

  const missing = [
    !tenantName && '--tenant-name',
    !tenantSlug && '--tenant-slug',
    !tenantAlias && '--tenant-alias',
    !adminEmail && '--admin-email',
  ].filter(Boolean);

  if (missing.length > 0) {
    console.error('Missing required flags:', missing.join(', '));
    console.error('\nUsage:');
    console.error('  npx tsx scripts/bootstrap-first-tenant.ts \\');
    console.error('    --tenant-name "Acme Energy" \\');
    console.error('    --tenant-slug acme \\');
    console.error('    --tenant-alias acme.prod@stewardship.is \\');
    console.error('    --admin-email founder@acme.example');
    process.exit(1);
  }

  // Basic validation
  if (!/^[a-z0-9-]+$/.test(tenantSlug!)) {
    console.error('Tenant slug must be lowercase alphanumeric with dashes only.');
    process.exit(1);
  }
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(adminEmail!)) {
    console.error('Admin email looks malformed.');
    process.exit(1);
  }

  return {
    tenantName: tenantName!,
    tenantSlug: tenantSlug!,
    tenantAlias: tenantAlias!,
    adminEmail: adminEmail!,
  };
}

async function main() {
  const args = parseArgs();

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Production Aggregator — bootstrap first tenant');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Tenant:        ${args.tenantName} (${args.tenantSlug})`);
  console.log(`  Email alias:   ${args.tenantAlias}`);
  console.log(`  Super-admin:   ${args.adminEmail}`);
  console.log('───────────────────────────────────────────────────────────');

  // Step 1 — Create the tenant
  console.log('\n[1/3] Creating tenant row...');
  const { data: existingTenant } = await supabase
    .from('tenants')
    .select('id, slug, name')
    .eq('slug', args.tenantSlug)
    .maybeSingle();

  let tenantId: string;
  if (existingTenant) {
    console.log(`      Tenant with slug "${args.tenantSlug}" already exists. Reusing id=${existingTenant.id}`);
    tenantId = existingTenant.id;
  } else {
    const { data, error } = await supabase
      .from('tenants')
      .insert({
        slug: args.tenantSlug,
        name: args.tenantName,
        email_alias: args.tenantAlias,
        is_active: true,
        notes: 'Created via bootstrap-first-tenant.ts',
      })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to create tenant: ${error.message}`);
    tenantId = data.id;
    console.log(`      Created tenant id=${tenantId}`);
  }

  // Step 2 — Invite the super-admin via Supabase Auth admin API
  console.log('\n[2/3] Inviting super-admin user via Supabase Auth...');
  const { data: invite, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(args.adminEmail);

  let userId: string;
  if (inviteErr) {
    // If the user already exists, look them up
    if (inviteErr.message.toLowerCase().includes('already') || inviteErr.message.toLowerCase().includes('exists')) {
      console.log(`      User ${args.adminEmail} already exists in Supabase Auth. Looking up id...`);
      const { data: users, error: listErr } = await supabase.auth.admin.listUsers();
      if (listErr) throw new Error(`Failed to list users: ${listErr.message}`);
      const existing = users.users.find((u) => u.email?.toLowerCase() === args.adminEmail.toLowerCase());
      if (!existing) throw new Error(`Could not find user ${args.adminEmail} in Auth`);
      userId = existing.id;
    } else {
      throw new Error(`Failed to invite user: ${inviteErr.message}`);
    }
  } else {
    userId = invite.user.id;
    console.log(`      Invited. user_id=${userId}`);
    console.log(`      Supabase has emailed ${args.adminEmail} a magic link.`);
  }

  // Step 3 — Link the user to the tenant with is_super_admin = true
  console.log('\n[3/3] Linking user to tenant with super-admin flag...');
  const { error: linkErr } = await supabase
    .from('user_tenants')
    .upsert(
      {
        user_id: userId,
        tenant_id: tenantId,
        is_super_admin: true,
      },
      { onConflict: 'user_id,tenant_id' }
    );
  if (linkErr) throw new Error(`Failed to link user to tenant: ${linkErr.message}`);
  console.log(`      Linked. is_super_admin=true`);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ✓  Bootstrap complete');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('\n  Next steps:');
  console.log('  1. The super-admin checks their email and clicks the magic link');
  console.log('     (or sets a password via the standard Supabase reset flow)');
  console.log(`  2. Sign in at your app domain as ${args.adminEmail}`);
  console.log('  3. Navigate to /admin to invite additional users for this tenant');
  console.log('  4. Set up the Gmail Workspace alias for', args.tenantAlias);
  console.log('     (see docs/operations/04-onboarding-new-client.md)');
  console.log('');
}

main().catch((err) => {
  console.error('\n✗ Bootstrap failed:', err.message);
  process.exit(1);
});
