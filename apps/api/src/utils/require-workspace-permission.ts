import { type BuiltInRoleName, builtInRoles } from "@kaneo/permissions";
import { and, eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { isInstanceAdmin } from "./is-instance-admin";

type PermissionMap = Record<string, string[]>;
type PermissionDatabase =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Recheck mutable user, membership and role grants while mutation holds locks. */
export async function hasLockedWorkspacePermission(
  database: PermissionDatabase,
  userId: string,
  workspaceId: string,
  permissions: PermissionMap,
) {
  const [user] = await database
    .select({ role: schema.userTable.role })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId))
    .for("share");
  if (user?.role === "admin") return true;
  const [member] = await database
    .select({ role: schema.workspaceUserTable.role })
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    )
    .for("share");
  if (!member) return false;
  for (const name of splitRoles(member.role)) {
    const [role] = await database
      .select({ permission: schema.workspaceRoleTable.permission })
      .from(schema.workspaceRoleTable)
      .where(
        and(
          eq(schema.workspaceRoleTable.workspaceId, workspaceId),
          eq(schema.workspaceRoleTable.role, name),
        ),
      )
      .for("share");
    const statements = role
      ? parsePermissionStatements(role.permission)
      : builtInRoleStatements(name);
    if (statements && satisfies(statements, permissions)) return true;
  }
  return false;
}

/** Better Auth stores several roles comma-separated; any one of them may grant access. */
function splitRoles(role: string | null | undefined): string[] {
  if (typeof role !== "string") return [];
  return [
    ...new Set(
      role
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

function builtInRoleStatements(
  role: string,
): Record<string, readonly string[]> | null {
  if (role in builtInRoles) {
    return builtInRoles[role as BuiltInRoleName].statements as Record<
      string,
      readonly string[]
    >;
  }
  return null;
}

function parsePermissionStatements(
  raw: string,
): Record<string, readonly string[]> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  // Only keep entries shaped like { [resource: string]: string[] }.
  // Anything malformed is dropped so `satisfies()` never calls
  // `.includes()` on a non-array.
  const result: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!Array.isArray(actions)) continue;
    const filtered = actions.filter(
      (action): action is string => typeof action === "string",
    );
    if (filtered.length > 0) {
      result[resource] = filtered;
    }
  }
  return result;
}

async function customRoleStatements(
  workspaceId: string,
  role: string,
): Promise<Record<string, readonly string[]> | null> {
  const [row] = await db
    .select({ permission: schema.workspaceRoleTable.permission })
    .from(schema.workspaceRoleTable)
    .where(
      and(
        eq(schema.workspaceRoleTable.workspaceId, workspaceId),
        eq(schema.workspaceRoleTable.role, role),
      ),
    )
    .limit(1);

  if (!row?.permission) return null;

  return parsePermissionStatements(row.permission);
}

function satisfies(
  statements: Record<string, readonly string[]>,
  required: PermissionMap,
): boolean {
  for (const [resource, actions] of Object.entries(required)) {
    const granted = statements[resource];
    if (!granted) return false;
    for (const action of actions) {
      if (!granted.includes(action)) return false;
    }
  }
  return true;
}

export async function hasWorkspacePermission(
  c: Context,
  permissions: PermissionMap,
) {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) return false;

  const apiKey = c.get("apiKey") as
    | { permissions?: Record<string, string[]> | null }
    | undefined;
  if (apiKey?.permissions && !satisfies(apiKey.permissions, permissions)) {
    return false;
  }

  if (await isInstanceAdmin(c)) {
    return true;
  }

  const userId = c.get("userId");
  if (!userId) return false;

  const [member] = await db
    .select({ role: schema.workspaceUserTable.role })
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    )
    .limit(1);

  if (!member?.role) return false;

  // Prefer the DB row when present so admin-edited defaults
  // (viewer/member/admin) take effect immediately. Falls back to the
  // compiled-in static definitions only when no row exists, which protects
  // viewer/member/admin users from a 403 if their workspace somehow
  // missed the seed (e.g., seed failed during workspace creation and
  // the boot-time backfill hasn't run yet).
  for (const name of splitRoles(member.role)) {
    const statements =
      (await customRoleStatements(workspaceId, name)) ??
      builtInRoleStatements(name);
    if (statements && satisfies(statements, permissions)) return true;
  }
  return false;
}

export function requireWorkspacePermission(permissions: PermissionMap) {
  return async (c: Context, next: Next) => {
    if (!c.get("workspaceId")) {
      throw new HTTPException(500, {
        message: "workspaceId not set in context",
      });
    }

    const apiKey = c.get("apiKey") as
      | { permissions?: Record<string, string[]> | null }
      | undefined;
    if (apiKey?.permissions && !satisfies(apiKey.permissions, permissions)) {
      throw new HTTPException(403, { message: "Insufficient API key scope" });
    }

    if (!(await hasWorkspacePermission(c, permissions))) {
      if (!c.get("userId")) {
        throw new HTTPException(401, { message: "Unauthorized" });
      }
      throw new HTTPException(403, { message: "Insufficient permissions" });
    }

    return next();
  };
}
