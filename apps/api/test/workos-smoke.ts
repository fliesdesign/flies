// Explicit live smoke: creates a verified test user and removes it on completion.
import { WorkOS } from "@workos-inc/node";
import { eq } from "drizzle-orm";

import { createApp } from "../src/app";
import { workosProvider } from "../src/auth";
import { readConfig } from "../src/config";
import { connectDatabase } from "../src/db/client";
import { sessions, users, workspaces } from "../src/db/schema";
import { createStorage } from "../src/storage";
const config = readConfig();
if (
  !config.WORKOS_API_KEY.startsWith("sk_test_") ||
  config.DATABASE_URL !== process.env.TEST_DATABASE_URL
)
  throw new Error("Use test WorkOS credentials and TEST_DATABASE_URL.");
const workos = new WorkOS(config.WORKOS_API_KEY, { clientId: config.WORKOS_CLIENT_ID });
const { db, client } = connectDatabase(config.DATABASE_URL);
let userId: string | undefined;

try {
  const password = `${crypto.randomUUID()}aA1!`;
  const email = `flies-test-${crypto.randomUUID()}@flies-tests.invalid`;

  const user = await workos.userManagement.createUser({
    email,
    password,
    emailVerified: true,
    firstName: "Flies",
    lastName: "Test",
  });

  userId = user.id;

  const result = await workos.userManagement.authenticateWithPassword({
    email,
    password,
    session: { sealSession: true, cookiePassword: config.WORKOS_COOKIE_PASSWORD },
  });

  if (!result.sealedSession) throw new Error("Missing sealed WorkOS session");
  const provider = workosProvider(config);
  const verified = await provider.verify(result.sealedSession);
  if (verified?.user.id !== user.id) throw new Error("WorkOS session verification failed");
  const { app, auth } = createApp(db, createStorage(config), config, provider);
  const token = await auth.createSession(verified.user, result.sealedSession);
  const response = await app.request("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  if (response.status !== 200) throw new Error(`Authenticated request failed: ${response.status}`);
  console.log(
    "WorkOS authentication, sealed-session verification, default workspace, and authenticated API request passed.",
  );

  const logout = await app.request("/auth/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });

  if (
    logout.status !== 200 ||
    (await app.request("/api/me", { headers: { Authorization: `Bearer ${token}` } })).status !== 401
  )
    throw new Error("Logout failed");
  console.log("WorkOS logout and API session revocation passed.");
} catch (error) {
  console.error("WorkOS smoke failed:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
} finally {
  if (userId) {
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(workspaces).where(eq(workspaces.ownerId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await workos.userManagement.deleteUser(userId);
  }

  await client.close();
}
