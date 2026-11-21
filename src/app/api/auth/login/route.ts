import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { getCachedSettings } from "@/lib/db/settings";
import { ResponseCookieJar, applyCookies, type CookieStore } from "@/lib/api/cookieJar";
import {
  ensurePersistentManagementPasswordHash,
  getStoredManagementPassword,
  isKnownInsecureManagementPassword,
  verifyManagementPassword,
} from "@/lib/auth/managementPassword";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";
import { loginSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  beginLoginAttempt,
  clearLoginAttempts,
  endLoginAttempt,
  recordLoginFailure,
} from "@/server/auth/loginGuard";
import { AUTHZ_HEADER_TRUSTED_PEER_IP } from "@/server/authz/headers";
import {
  getDashboardJwtSecret,
  mintDashboardSessionToken,
} from "@/shared/utils/dashboardSessionToken";
import {
  getLoginLockoutKey,
  getLoginSourceScope,
  isHostOperatorRequest,
} from "@/server/auth/loginPeer";
import { getRequestPeerLocality } from "@/shared/utils/apiAuth";

/**
 * Whether the module-level missing-JWT_SECRET warning should fire. The POST handler
 * fails closed when the secret is missing.
 */
function shouldWarnMissingJwtSecret(): boolean {
  return !process.env.JWT_SECRET;
}

// SECURITY: No hardcoded fallback — JWT_SECRET must be configured.
if (shouldWarnMissingJwtSecret()) {
  console.error("[SECURITY] FATAL: JWT_SECRET is not set. Login authentication is disabled.");
}

// Test seam for cookie store injection without affecting runtime behavior.
export const authRouteInternals = {
  getCookieStore: (request: Request): CookieStore | Promise<CookieStore> =>
    new ResponseCookieJar(request),
  /** True when the module-level missing-JWT_SECRET warning should fire (#16320). */
  shouldWarnMissingJwtSecret,
};

export async function POST(request: Request) {
  const auditContext = getAuditRequestContext(request);
  // Slot reserved by the guard while the password is verified; released on every exit.
  let heldSlotKey: string | null | undefined;
  let holdsSlot = false;

  try {
    // Fail-fast if JWT_SECRET is not configured
    if (!process.env.JWT_SECRET) {
      await logAuditEvent({
        action: "auth.login.misconfigured",
        actor: "system",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { reason: "missing_jwt_secret" },
      });
      return Response.json(
        { error: "Server misconfigured: JWT_SECRET not set. Contact administrator." },
        { status: 500 }
      );
    }

    let rawBody;
    try {
      rawBody = await request.json();
    } catch {
      return Response.json(
        {
          error: {
            message: "Invalid request",
            details: [{ field: "body", message: "Invalid JSON body" }],
          },
        },
        { status: 400 }
      );
    }

    // Zod validation
    const validation = validateBody(loginSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    const password = typeof validation.data.password === "string" ? validation.data.password : "";
    if (!password) {
      return Response.json({ error: "Invalid password payload" }, { status: 400 });
    }
    const settings = await getCachedSettings();
    const trustedPeerIp = process.env.OMNIROUTE_PEER_STAMP_TOKEN
      ? request.headers.get(AUTHZ_HEADER_TRUSTED_PEER_IP)
      : null;
    const clientIp = trustedPeerIp || auditContext.ipAddress || null;
    const lockoutKey = getLoginLockoutKey(request, auditContext.ipAddress);
    const oidcDisabledPassword =
      settings.oidcEnabled === true &&
      (settings.oidcDisablePasswordLogin === true ||
        isFeatureFlagEnabled("OMNIROUTE_OIDC_DISABLE_PASSWORD_LOGIN") ||
        process.env.OMNIROUTE_OIDC_DISABLE_PASSWORD_LOGIN === "true" ||
        process.env.OIDC_DISABLE_PASSWORD_LOGIN === "true");

    if (oidcDisabledPassword) {
      await logAuditEvent({
        action: "auth.login.password_disabled_by_oidc",
        actor: "anonymous",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: clientIp || undefined,
        requestId: auditContext.requestId,
        metadata: { reason: "password_login_disabled_when_oidc_active" },
      });
      return Response.json(
        { error: "Password login is disabled when OIDC is active. Please sign in with OIDC." },
        { status: 403 }
      );
    }

    const bruteForceEnabled = settings.bruteForceProtection !== false;

    const guardCheck = beginLoginAttempt(lockoutKey, { enabled: bruteForceEnabled });
    if (!guardCheck.allowed) {
      await logAuditEvent({
        action: "auth.login.locked",
        actor: "anonymous",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: clientIp || undefined,
        requestId: auditContext.requestId,
        metadata: { retryAfterSeconds: guardCheck.retryAfterSeconds || 0 },
      });
      return Response.json(
        { error: "Too many failed attempts. Try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(guardCheck.retryAfterSeconds || 60) },
        }
      );
    }

    holdsSlot = true;
    heldSlotKey = lockoutKey;

    const passwordState = await ensurePersistentManagementPasswordHash({
      settings,
      source: "auth.login",
    });
    const storedHash = getStoredManagementPassword(passwordState.settings);

    if (!storedHash) {
      await logAuditEvent({
        action: "auth.login.setup_required",
        actor: "anonymous",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { reason: "missing_persisted_password" },
      });
      return Response.json(
        { error: "No password configured. Complete onboarding first.", needsSetup: true },
        { status: 403 }
      );
    }

    const isValid = await verifyManagementPassword(password, storedHash);

    // #8336: tag the origin scope so the audit view can distinguish a mistyped
    // password from the host itself / the LAN (loopback / private) from a
    // genuinely external attempt, instead of every failure reading as intrusion.
    const sourceScope = getLoginSourceScope(request, auditContext.ipAddress);

    // #13679 (PR D, item #5): the well-known INITIAL_PASSWORD placeholder shipped
    // in .env.example / contrib/podman/omniroute.container / docker deploy
    // manifests is a public, guessable credential. Anyone who knows it (i.e.
    // everyone) can otherwise sign in from anywhere the dashboard is reachable.
    // `ensurePersistentManagementPasswordHash()` already warns loudly on boot,
    // but that is a log line, not a control — refuse the login here instead
    // whenever it matches AND the request is not loopback, forcing the operator
    // to rotate the password from a trusted local console first. Locality comes
    // from the socket peer the authz pipeline stamped, not from forwarding
    // headers: a remote caller can send `X-Forwarded-For: 127.0.0.1` at will.
    if (isValid && isKnownInsecureManagementPassword(password) && !isHostOperatorRequest(request)) {
      await logAuditEvent({
        action: "auth.login.insecure_default_blocked",
        actor: "anonymous",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: {
          reason: "well_known_default_password_non_loopback",
          sourceScope,
          peerLocality: getRequestPeerLocality(request),
        },
      });
      return Response.json(
        {
          error:
            "The management password is still set to the well-known default. " +
            "Log in from localhost and change it before signing in remotely.",
        },
        { status: 403 }
      );
    }

    if (isValid) {
      const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
      const forwardedProtoHeader = request.headers.get("x-forwarded-proto") || "";
      const forwardedProto = forwardedProtoHeader.split(",")[0].trim().toLowerCase();
      const isHttpsRequest =
        forwardedProto === "https" || new URL(request.url).protocol === "https:";
      const useSecureCookie = forceSecureCookie || isHttpsRequest;

      const token = await mintDashboardSessionToken(getDashboardJwtSecret()!);

      const cookieStore = await authRouteInternals.getCookieStore(request);
      cookieStore.set("auth_token", token, {
        httpOnly: true,
        secure: useSecureCookie,
        sameSite: "lax",
        path: "/",
        // 30 days — bound the cookie lifetime to the JWT's 30d expiry so the browser
        // drops it on the same schedule the token stops being valid (Seg3 hardening).
        maxAge: 60 * 60 * 24 * 30,
      });

      await logAuditEvent({
        action: "auth.login.success",
        actor: "admin",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "success",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: {
          hasStoredPassword: Boolean(storedHash),
          passwordMigrated: passwordState.migrated,
          secureCookie: useSecureCookie,
        },
      });

      clearLoginAttempts(lockoutKey);
      return applyCookies(cookieStore, Response.json({ success: true }));
    }

    const failureDecision = recordLoginFailure(lockoutKey, { enabled: bruteForceEnabled });

    await logAuditEvent({
      action: "auth.login.failed",
      actor: "anonymous",
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: {
        reason: "invalid_password",
        lockedOut: failureDecision.allowed === false,
        sourceScope,
        internalOrigin: sourceScope === "loopback" || sourceScope === "private",
      },
    });

    if (!failureDecision.allowed) {
      return Response.json(
        { error: "Too many failed attempts. Try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(failureDecision.retryAfterSeconds || 60) },
        }
      );
    }

    return Response.json({ error: "Invalid password" }, { status: 401 });
  } catch (error) {
    console.error("[AUTH] Login failed:", error);
    await logAuditEvent({
      action: "auth.login.error",
      actor: "system",
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: {
        message: error instanceof Error ? error.message : "unknown_error",
      },
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  } finally {
    if (holdsSlot) endLoginAttempt(heldSlotKey);
  }
}
