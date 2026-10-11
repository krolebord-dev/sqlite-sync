import { beforeEach, describe, expect, it, vi } from "vitest";
import { getUserIdFromRequest, userCanAccessList } from "./auth-request";
import { requireListAccess } from "./list-access-guard";

vi.mock("./auth-request", () => ({
  getUserIdFromRequest: vi.fn(),
  userCanAccessList: vi.fn(),
}));

const request = new Request("https://watchlist.test/list-db/list-db-server/list-abc");

describe("requireListAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserIdFromRequest).mockResolvedValue("user-1");
    vi.mocked(userCanAccessList).mockImplementation(async (_userId, listId) => listId === "abc");
  });

  it.each([
    [{ className: "ListDbServer", name: "list-abc" }, "ListDbServer"],
    [{ className: "ChatAgent", name: "list-abc:main" }, "ChatAgent"],
  ] as const)("admits list members to %o", async (lobby, className) => {
    expect(await requireListAccess(request, lobby, className)).toBeUndefined();
    expect(userCanAccessList).toHaveBeenCalledWith("user-1", "abc");
  });

  it("rejects requests without a session", async () => {
    vi.mocked(getUserIdFromRequest).mockResolvedValue(null);

    const response = await requireListAccess(request, { className: "ListDbServer", name: "list-abc" }, "ListDbServer");

    expect(response?.status).toBe(401);
  });

  it("rejects users who are not members of the list", async () => {
    const response = await requireListAccess(request, { className: "ListDbServer", name: "list-xyz" }, "ListDbServer");

    expect(response?.status).toBe(401);
  });

  it.each([
    [{ className: "ChatAgent", name: "list-abc:main" }, "ListDbServer"],
    [{ className: "ListDbServer", name: "list-abc" }, "ChatAgent"],
    [{ className: "ListDbServer", name: "list-abc:main" }, "ListDbServer"],
    [{ className: "ChatAgent", name: "list-abc" }, "ChatAgent"],
    [{ className: "ListDbServer", name: "abc" }, "ListDbServer"],
    [{ className: "ListDbServer", name: "list-" }, "ListDbServer"],
  ] as const)("rejects %o on the %s route before checking the session", async (lobby, className) => {
    const response = await requireListAccess(request, lobby, className);

    expect(response?.status).toBe(404);
    expect(getUserIdFromRequest).not.toHaveBeenCalled();
  });
});
