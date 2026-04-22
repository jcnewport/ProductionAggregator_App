/**
 * Security middleware — Task #78 (Phase 3 hardening).
 * ----------------------------------------------------
 *
 * Three small pieces stitched together here so index.ts stays tidy:
 *
 *   1.  buildCorsOptions()
 *       Locks CORS to an allowlist of known origins instead of the
 *       wide-open `cors()` default. In production we serve the React
 *       app from the same Express process so CORS is barely exercised,
 *       but during local dev the React dev server runs on a different
 *       port (Vite, 5173) and DOES make cross-origin requests — those
 *       still need to succeed.
 *
 *   2.  globalLimiter / adminLimiter
 *       Two express-rate-limit instances. `globalLimiter` is a generous
 *       baseline applied everywhere (prevents a single bad actor from
 *       carpet-bombing the API). `adminLimiter` is much tighter and
 *       scoped to /api/admin/* because those endpoints can trigger
 *       expensive reprocessing work.
 *
 *   3.  requireAuth
 *       Very small JWT middleware. Parses the Authorization: Bearer
 *       token, validates it against Supabase Auth, and rejects if it
 *       doesn't resolve to a real user. Mounted on /api/admin so a
 *       leaked Railway URL can't be used by anyone without a valid
 *       Supabase session.
 *
 * WHY keep these together in one file?
 *   They all configure the same security boundary and they're all tiny.
 *   Splitting them would make it harder to see the policy at a glance.
 */

import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { CorsOptions } from 'cors';
import { supabase } from '../services/supabase.js';

/* ────────────────────────────────────────────────────────────────
 * CORS allowlist
 * ──────────────────────────────────────────────────────────────── */

/**
 * Origins that are allowed to call the API cross-origin.
 *
 * Anything served from the same origin as the API (i.e. the compiled
 * React build mounted on /api/../web/dist) never triggers a CORS
 * preflight — those requests don't have an Origin header the browser
 * treats as "cross-origin". So the list below only matters for:
 *
 *   • Local development (Vite on http://localhost:5173)
 *   • The custom domain where the production UI lives
 *
 * Adding/removing an origin is a one-line edit. Keep it short.
 */
const ALLOWED_ORIGINS = new Set<string>([
  // Local dev — Vite default port
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  // Custom production domain
  'https://productionaggregator.stewardship.is',
  // Railway-assigned default domain (useful as a fallback if DNS
  // propagates late or the custom domain is down)
  'https://productionaggregator-production.up.railway.app',
]);

/**
 * Build the CORS options object.
 *
 * We use a function form for `origin` so we can accept:
 *   • No-origin requests (same-origin browser, curl, server-to-server)
 *   • Any origin present in ALLOWED_ORIGINS
 * and reject anything else with a CORS error.
 */
export function buildCorsOptions(): CorsOptions {
  return {
    origin: (origin, callback) => {
      // `!origin` covers same-origin browser requests, curl, Railway
      // health checks, Postman, etc. Those are safe.
      if (!origin || ALLOWED_ORIGINS.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS: origin "${origin}" is not allowed.`));
    },
    credentials: true,
    // Allow the Authorization header (Supabase Bearer token) and
    // content-type (needed for JSON body POSTs).
    allowedHeaders: ['Authorization', 'Content-Type'],
    // Expose custom response headers to the browser JS — without these,
    // fetch() cannot read X-Export-Id etc. even though the server sent
    // them.
    exposedHeaders: [
      'X-Export-Id',
      'X-Export-Row-Count',
      'X-Export-Well-Count',
      'Content-Disposition',
    ],
  };
}

/* ────────────────────────────────────────────────────────────────
 * Rate limiters
 *
 * Numbers chosen pragmatically for a single-user app today:
 *   • Global:   300 req / 15 min per IP   (~20/min)
 *   • Admin:    30 req / 15 min per IP    (~2/min)
 *
 * If the app grows to multiple users, bump the numbers — they're
 * per-IP, not per-user, so a shared NAT could trip the global limiter.
 * ──────────────────────────────────────────────────────────────── */

/**
 * Baseline rate limit applied to every API route. Generous enough
 * that normal UI usage never trips it, strict enough that a bot
 * hammering endpoints gets shed.
 */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true, // RateLimit-* headers (RFC standard)
  legacyHeaders: false,  // no X-RateLimit-* (deprecated)
  message: {
    ok: false,
    error: 'Too many requests. Please wait a few minutes and try again.',
  },
});

/**
 * Tighter rate limit for /api/admin/*. These endpoints can trigger
 * bulk email reprocessing, retry passes, and manual alert sends —
 * all of which do real work against Gmail and Supabase. Keep the
 * ceiling low so an accidental double-click (or a mis-aimed script)
 * can't chew through quota or flood a recipient's inbox.
 */
export const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'Too many admin requests. Wait 15 minutes before retrying.',
  },
});

/* ────────────────────────────────────────────────────────────────
 * JWT middleware for /api/admin
 *
 * The frontend attaches `Authorization: Bearer <supabase-access-token>`
 * on every admin call (see dashboardApi.ts and ExportHistoryPage.tsx).
 * This middleware validates the token against Supabase Auth and
 * rejects if it's missing, malformed, expired, or revoked.
 *
 * We deliberately do NOT hit the DB on every request — Supabase's
 * getUser(token) uses the token's signature alone, which is fast.
 * ──────────────────────────────────────────────────────────────── */

/**
 * Extend Express's Request so downstream handlers can read the
 * authenticated user without re-parsing the token.
 *
 * Phase 4 multi-tenancy: we also attach a `tenant` bag whenever the
 * `requireTenant` middleware has run successfully. Routes that scope
 * by tenant should pull from there and never re-query user_tenants.
 */
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string | null;
  };
  tenant?: {
    /**
     * The tenant the caller's login belongs to. Stamped on every write
     * and used as a filter on every read unless the caller is a
     * super-admin (which bypasses tenant scoping).
     */
    tenantId: string;
    /**
     * True if the caller has user_tenants.is_super_admin=true. Super-admins
     * see and write across all tenants. Currently only Caleb.
     */
    isSuperAdmin: boolean;
  };
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({
      ok: false,
      error: 'Missing Authorization header. Sign in and try again.',
    });
    return;
  }

  const token = match[1];

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({
        ok: false,
        error: 'Invalid or expired session. Sign in and try again.',
      });
      return;
    }
    req.user = {
      id: data.user.id,
      email: data.user.email ?? null,
    };
    next();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      ok: false,
      error: `Auth check failed: ${msg}`,
    });
  }
}

/**
 * Escape hatch for development. When `ADMIN_AUTH_DISABLED=true` is
 * set in env, requireAuth is replaced with a pass-through. Useful when
 * running the API standalone (curl, Postman) without a live frontend
 * session. NEVER set this in production — the default is "enabled".
 */
export function requireAuthMaybe(): (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => void | Promise<void> {
  if (process.env.ADMIN_AUTH_DISABLED === 'true') {
    console.warn(
      '[security] ADMIN_AUTH_DISABLED=true — /api/admin is UNAUTHENTICATED. ' +
        'Only acceptable in local dev.'
    );
    return (_req, _res, next) => next();
  }
  return requireAuth;
}

/* ────────────────────────────────────────────────────────────────
 * Tenant resolution middleware (Phase 4 multi-tenancy)
 *
 * Runs AFTER requireAuth. Looks up the caller's user_tenants row and
 * attaches `req.tenant = { tenantId, isSuperAdmin }`. Fails closed —
 * a user with no user_tenants row gets a 403. This is the belt-and-
 * suspenders layer that sits on top of RLS: every tenant-scoped /api
 * route reads req.tenant and filters its queries by tenant_id unless
 * the caller is a super-admin.
 *
 * Why not just rely on RLS? Because our /api routes use the service_role
 * key (RLS bypass) so the worker can parse incoming email. Phase 4 keeps
 * service_role writes but adds an explicit tenant filter on reads so we
 * cannot accidentally leak cross-tenant data via an /api response.
 * ──────────────────────────────────────────────────────────────── */

export async function requireTenant(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // requireAuth must run first — without req.user we have nothing to look up.
  if (!req.user?.id) {
    res.status(401).json({
      ok: false,
      error:
        'requireTenant called without an authenticated user. Chain requireAuth before this middleware.',
    });
    return;
  }
  try {
    const { data, error } = await supabase
      .from('user_tenants')
      .select('tenant_id, is_super_admin')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ ok: false, error: `Tenant lookup failed: ${error.message}` });
      return;
    }
    if (!data) {
      res.status(403).json({
        ok: false,
        error:
          'Your account is not linked to a tenant. Contact your administrator to be added.',
      });
      return;
    }
    req.tenant = {
      tenantId: data.tenant_id,
      isSuperAdmin: data.is_super_admin === true,
    };
    next();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: `Tenant resolve failed: ${msg}` });
  }
}

/**
 * Dev escape hatch mirroring requireAuthMaybe. With ADMIN_AUTH_DISABLED=true
 * we skip the tenant lookup AND pretend the caller is a super-admin for the
 * Frio tenant. Pulled from env so we can test tenant scoping locally with a
 * different seed tenant if needed.
 */
export function requireTenantMaybe(): (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => void | Promise<void> {
  if (process.env.ADMIN_AUTH_DISABLED === 'true') {
    console.warn(
      '[security] ADMIN_AUTH_DISABLED=true — tenant resolution bypassed, caller is treated as super-admin.'
    );
    const fakeTenantId = process.env.DEV_FAKE_TENANT_ID || '';
    return (req, _res, next) => {
      (req as AuthenticatedRequest).tenant = {
        tenantId: fakeTenantId,
        isSuperAdmin: true,
      };
      next();
    };
  }
  return requireTenant;
}

/**
 * Super-admin-only gate. Rejects unless req.tenant.isSuperAdmin is true.
 * Chain as: requireAuth → requireTenant → requireSuperAdmin. Used for the
 * Phase 5 onboarding endpoints (create tenant + user), the manual /api/poll
 * trigger, and the bulk reprocess-failed endpoint — operations a regular
 * tenant user should never be able to invoke.
 */
export function requireSuperAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.tenant) {
    res.status(401).json({
      ok: false,
      error:
        'requireSuperAdmin called without req.tenant. Chain requireTenant before this middleware.',
    });
    return;
  }
  if (!req.tenant.isSuperAdmin) {
    res.status(403).json({
      ok: false,
      error: 'This endpoint requires super-admin privileges.',
    });
    return;
  }
  next();
}
