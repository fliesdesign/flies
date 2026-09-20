import { createHash, randomBytes } from "node:crypto";

import { WorkOS } from "@workos-inc/node";
import { and, eq, gt, lt, isNull, isNotNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";

import type { Config } from "./config";
import type { Database } from "./db/client";
import { loginAttempts, sessions } from "./db/schema";
import { ensureWorkspace, type Identity } from "./files";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");
const ttl = 30 * 24 * 60 * 60;
const sessionCookie = "flies_session";
const flowCookie = "flies_login";
const proofSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
export type AuthEnv = {
  Variables: { user: Identity; workspace: { id: string; name: string }; sessionHash: string };
};
export interface AuthProvider {
  authorizationUrl(state: string, verifier: string): string;
  exchange(code: string, verifier: string): Promise<{ user: Identity; sealedSession: string }>;
  verify(sealedSession: string): Promise<{ user: Identity; sealedSession: string } | null>;
  revoke(sealedSession: string): Promise<void>;
}

const identity = (user: {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}): Identity => ({
  id: user.id,
  email: user.email,
  name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
});

export function workosProvider(config: Config): AuthProvider {
  const workos = new WorkOS(config.WORKOS_API_KEY, { clientId: config.WORKOS_CLIENT_ID });

  const load = (sessionData: string) =>
    workos.userManagement.loadSealedSession({
      sessionData,
      cookiePassword: config.WORKOS_COOKIE_PASSWORD,
    });

  return {
    authorizationUrl(state, verifier) {
      return workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        redirectUri: config.WORKOS_REDIRECT_URI,
        state,
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
        codeChallengeMethod: "S256",
      });
    },
    async exchange(code, codeVerifier) {
      const result = await workos.userManagement.authenticateWithCode({
        code,
        codeVerifier,
        session: { sealSession: true, cookiePassword: config.WORKOS_COOKIE_PASSWORD },
      });

      if (!result.sealedSession) throw new Error("WorkOS did not return a sealed session");

      return { user: identity(result.user), sealedSession: result.sealedSession };
    },
    async verify(sealedSession) {
      const session = load(sealedSession);
      const auth = await session.authenticate();
      if (auth.authenticated) return { user: identity(auth.user), sealedSession };
      const refreshed = await session.refresh();

      if (!refreshed.authenticated) {
        if (refreshed.retryable)
          throw new HTTPException(503, {
            message: "Sign-in service is temporarily unavailable. Please retry.",
          });

        return null;
      }

      if (!refreshed.sealedSession) return null;

      return { user: identity(refreshed.user), sealedSession: refreshed.sealedSession };
    },
    async revoke(sealedSession) {
      const auth = await load(sealedSession).authenticate();
      if (auth.authenticated)
        await workos.userManagement.revokeSession({ sessionId: auth.sessionId });
    },
  };
}

export function authService(db: Database, config: Config, provider: AuthProvider) {
  const secure = new URL(config.API_URL).protocol === "https:";
  const cookieOptions = { httpOnly: true, secure, sameSite: "Lax" as const, path: "/" };

  function credential(c: Context) {
    const authorization = c.req.header("Authorization");

    return authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : getCookie(c, sessionCookie);
  }

  async function createSession(user: Identity, sealedSession: string) {
    await ensureWorkspace(db, user);
    const token = randomToken();
    await db.insert(sessions).values({
      tokenHash: hash(token),
      userId: user.id,
      sealedSession,
      expiresAt: new Date(Date.now() + ttl * 1000),
    });

    return token;
  }

  async function authenticate(c: Context<AuthEnv>) {
    const token = credential(c);
    if (!token || !v.safeParse(proofSchema, token).success)
      throw new HTTPException(401, { message: "Sign in to continue." });
    const tokenHash = hash(token);

    // Serialize refresh-token rotation across concurrent requests and API instances.
    const auth = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
        .for("update");

      if (!row) return null;
      const result = await provider.verify(row.sealedSession);

      if (!result || result.user.id !== row.userId) {
        await tx.delete(sessions).where(eq(sessions.tokenHash, tokenHash));

        return null;
      }

      if (result.sealedSession !== row.sealedSession)
        await tx
          .update(sessions)
          .set({ sealedSession: result.sealedSession })
          .where(eq(sessions.tokenHash, tokenHash));

      return result;
    });

    if (!auth) throw new HTTPException(401, { message: "Your session expired. Sign in again." });
    c.set("user", auth.user);
    c.set("sessionHash", tokenHash);
    c.set("workspace", await ensureWorkspace(db, auth.user));
  }

  const routes = new Hono<AuthEnv>();
  routes.get("/login", async (c) => {
    const challenge = c.req.query("desktop");
    if (challenge && !/^[a-f0-9]{64}$/.test(challenge)) throw new HTTPException(400);
    const state = randomToken();
    const browserToken = randomToken();
    const verifier = randomToken();
    await db.delete(loginAttempts).where(lt(loginAttempts.expiresAt, new Date()));
    await db.insert(loginAttempts).values({
      state,
      verifier,
      browserHash: hash(browserToken),
      desktopChallenge: challenge ?? null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    setCookie(c, flowCookie, browserToken, { ...cookieOptions, maxAge: 600 });

    return c.redirect(provider.authorizationUrl(state, verifier));
  });
  routes.get("/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    const browser = getCookie(c, flowCookie);
    if (!state || !code || !browser)
      throw new HTTPException(400, {
        message: "Sign-in could not be completed. Start again in Flies.",
      });

    const [attempt] = await db
      .delete(loginAttempts)
      .where(
        and(
          eq(loginAttempts.state, state),
          isNull(loginAttempts.sessionToken),
          eq(loginAttempts.browserHash, hash(browser)),
          gt(loginAttempts.expiresAt, new Date()),
        ),
      )
      .returning();

    if (!attempt)
      throw new HTTPException(400, { message: "Sign-in expired. Start again in Flies." });
    deleteCookie(c, flowCookie, cookieOptions);
    const result = await provider.exchange(code, attempt.verifier);
    const token = await createSession(result.user, result.sealedSession);

    if (attempt.desktopChallenge) {
      await db
        .insert(loginAttempts)
        .values({ ...attempt, sessionToken: token, expiresAt: new Date(Date.now() + 60_000) });

      return c.html(
        "<!doctype html><html><head><title>Signed in · Flies</title><meta name='viewport' content='width=device-width,initial-scale=1'></head><body style='background:#181818;color:#e8e8e8;font:18px system-ui;display:grid;place-content:center;min-height:90vh'><h1>You’re signed in.</h1><p>Return to Flies. You can close this tab.</p></body></html>",
      );
    }

    setCookie(c, sessionCookie, token, { ...cookieOptions, maxAge: ttl });

    return c.redirect(config.WEB_URL);
  });
  routes.post("/desktop/complete", async (c) => {
    const { verifier } = v.parse(v.object({ verifier: proofSchema }), await c.req.json());

    const [attempt] = await db
      .delete(loginAttempts)
      .where(
        and(
          eq(loginAttempts.desktopChallenge, hash(verifier)),
          gt(loginAttempts.expiresAt, new Date()),
          /* only consume completed logins */ isNotNull(loginAttempts.sessionToken),
        ),
      )
      .returning();

    return c.json({ token: attempt?.sessionToken ?? null });
  });
  routes.post("/logout", async (c) => {
    const token = credential(c);

    if (token) {
      const [session] = await db
        .delete(sessions)
        .where(eq(sessions.tokenHash, hash(token)))
        .returning();

      if (session) await provider.revoke(session.sealedSession);
    }

    deleteCookie(c, sessionCookie, cookieOptions);

    return c.json({ signedOut: true });
  });

  return { routes, authenticate, createSession };
}
