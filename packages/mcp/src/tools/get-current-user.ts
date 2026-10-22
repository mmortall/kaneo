import { z } from "zod";

const currentUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string().nullish(),
});

// get-session also carries the session token; the model must only see the user.
export async function getCurrentUser(client: {
  json<T>(path: string, init?: { method: string }): Promise<T>;
}) {
  const response = await client.json<{ user: unknown } | null>(
    "/api/auth/get-session",
    { method: "GET" },
  );
  return response === null ? null : currentUserSchema.parse(response.user);
}
