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
    [{ party: "list-db-server", name: "list-abc" }, "list-db-server"],
    [{ party: "chat-agent", name: "list-abc:main" }, "chat-agent"],
  ] as const)("admits list members to %o", async (lobby, party) => {
    expect(await requireListAccess(request, lobby, party)).toBeUndefined();
    expect(userCanAccessList).toHaveBeenCalledWith("user-1", "abc");
  });

  it("rejects requests without a session", async () => {
    vi.mocked(getUserIdFromRequest).mockResolvedValue(null);

    const response = await requireListAccess(request, { party: "list-db-server", name: "list-abc" }, "list-db-server");

    expect(response?.status).toBe(401);
  });

  it("rejects users who are not members of the list", async () => {
    const response = await requireListAccess(request, { party: "list-db-server", name: "list-xyz" }, "list-db-server");

    expect(response?.status).toBe(401);
  });

  it.each([
    [{ party: "chat-agent", name: "list-abc:main" }, "list-db-server"],
    [{ party: "list-db-server", name: "list-abc" }, "chat-agent"],
    [{ party: "list-db-server", name: "list-abc:main" }, "list-db-server"],
    [{ party: "chat-agent", name: "list-abc" }, "chat-agent"],
    [{ party: "list-db-server", name: "abc" }, "list-db-server"],
    [{ party: "list-db-server", name: "list-" }, "list-db-server"],
  ] as const)("rejects %o on the %s route before checking the session", async (lobby, party) => {
    const response = await requireListAccess(request, lobby, party);

    expect(response?.status).toBe(404);
    expect(getUserIdFromRequest).not.toHaveBeenCalled();
  });
});
