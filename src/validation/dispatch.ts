import { z } from "zod";

/**
 * Webhook dispatch request body.
 *
 * Note: this file is imported by tsc with skipLibCheck, but zod v4 has native
 * types - we keep the schema here so both runtime validation and future tests
 * share one definition.
 *
 * destinationUrl is syntactically validated here; DNS/IP policy lives in
 * src/security/ssrf.ts (production blocks private/loopback targets).
 */
export const dispatchSchema = z.object({
  destinationUrl: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "destinationUrl must be a valid absolute http(s) URL" }
    ),
  eventId: z.string().trim().min(1).max(255),
  payload: z.record(z.string(), z.unknown()),
});

export type DispatchInput = z.infer<typeof dispatchSchema>;
