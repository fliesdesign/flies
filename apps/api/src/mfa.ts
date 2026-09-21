import { HTTPException } from "hono/http-exception";
import * as v from "valibot";

import type { AuthProvider } from "./auth";
import type { Identity } from "./files";

export const totpCodeSchema = v.pipe(v.string(), v.regex(/^\d{6}$/));
const factorIdSchema = v.pipe(v.string(), v.regex(/^auth_factor_[A-Za-z0-9]+$/), v.maxLength(128));

const challengeIdSchema = v.pipe(
  v.string(),
  v.regex(/^auth_challenge_[A-Za-z0-9]+$/),
  v.maxLength(128),
);

export const verifyMfaSchema = v.object({
  factorId: factorIdSchema,
  challengeId: challengeIdSchema,
  code: totpCodeSchema,
});
export const removeMfaSchema = v.object({
  factorId: v.optional(factorIdSchema),
});

function fromProvider(error: unknown, fallback: string): never {
  if (error instanceof HTTPException) throw error;
  throw new HTTPException(503, { message: fallback });
}

export function mfaService(provider: AuthProvider) {
  return {
    async status(userId: string) {
      try {
        const factors = await provider.listFactors(userId);

        return { enrolled: factors.length > 0, factorId: factors[0]?.id };
      } catch (error) {
        fromProvider(error, "Could not load two-factor authentication.");
      }
    },
    async enroll(user: Identity) {
      try {
        return await provider.enrollFactor(user);
      } catch (error) {
        fromProvider(error, "Could not start two-factor authentication. Please retry.");
      }
    },
    async verify(userId: string, input: unknown) {
      const { factorId, challengeId, code } = v.parse(verifyMfaSchema, input);

      try {
        if (await provider.verifyEnrollment({ userId, factorId, challengeId, code }))
          return { enrolled: true };
      } catch (error) {
        fromProvider(error, "Could not confirm that code. Please retry.");
      }

      throw new HTTPException(400, {
        message: "That code is incorrect. Try a new one from the app.",
      });
    },
    async remove(userId: string, input: unknown) {
      const { factorId } = v.parse(removeMfaSchema, input ?? {});

      try {
        const factors = await provider.listFactors(userId);
        const removing = factorId ? factors.filter((factor) => factor.id === factorId) : factors;
        if (factorId && removing.length === 0)
          throw new HTTPException(404, { message: "Authenticator is not available." });

        await Promise.all(removing.map((factor) => provider.deleteFactor(userId, factor.id)));

        return { enrolled: false };
      } catch (error) {
        fromProvider(error, "Could not update two-factor authentication. Please retry.");
      }
    },
  };
}
