export const USER_ROLES = ["user", "admin"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function isAdmin(role: UserRole): boolean {
  return role === "admin";
}
