import type { User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { getAuthedUser } from "./authCache";

type UserWithEmail = Pick<User, "email">;

export function parseInventoryOwnerEmails(
  raw: string | undefined,
): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isInventoryOwner(
  user: UserWithEmail | null,
  rawOwners: string | undefined = process.env.INVENTORY_OWNER_EMAILS,
): boolean {
  const email = user?.email?.trim().toLowerCase();
  if (!email) return false;
  return parseInventoryOwnerEmails(rawOwners).has(email);
}

export async function requireInventoryUser(
  req: NextRequest,
): Promise<User | null> {
  return getAuthedUser(req);
}

export async function requireInventoryOwner(
  req: NextRequest,
): Promise<User | null> {
  const user = await requireInventoryUser(req);
  return isInventoryOwner(user) ? user : null;
}
