import type { User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { getAuthedUser } from "./authCache";

type UserWithEmail = Pick<User, "email">;
export type InventoryUserResolver = (
  req: NextRequest,
) => Promise<User | null>;

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
  resolveUser: InventoryUserResolver = getAuthedUser,
): Promise<User | null> {
  return resolveUser(req);
}

export async function requireInventoryOwner(
  req: NextRequest,
  resolveUser: InventoryUserResolver = getAuthedUser,
): Promise<User | null> {
  const user = await requireInventoryUser(req, resolveUser);
  return isInventoryOwner(user) ? user : null;
}
