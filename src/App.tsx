import { useState } from "react";
import { useDb, useDbQuery } from "./db";

export function App() {
  const db = useDb();

  const [search, setSearch] = useState("");
  const { rows: users } = useDbQuery({
    params: [search],
    queryFn: (db, [search]) => {
      let query = db
        .selectFrom("users")
        .select(["id", "name"])
        .limit(100)
        .orderBy("name");
      if (search) {
        query = query.where("name", "like", `${search}%`);
      }
      return query.compile();
    },
  });

  const {
    rows: [totalUsers],
  } = useDbQuery({
    queryFn: (db) =>
      db
        .selectFrom("users")
        .select(({ fn }) => [fn.countAll<number>().as("total")])
        .compile(),
  });

  const [showPosts, setShowPosts] = useState(false);

  const createRandomUser = async () => {
    await db.memoryDb.kysely
      .insertInto("users")
      .values(
        Array.from({ length: 16000 }, () => ({
          name: Math.random().toString(36).substring(2, 15),
          email: Math.random().toString(36).substring(2, 15) + "@example.com",
        }))
      )
      .execute();
  };

  const clearUsers = async () => {
    await db.memoryDb.kysely.deleteFrom("users").execute();
    db.memoryDb.notifyTableSubscribers(["users"]);
  };

  const [query, setQuery] = useState("");
  const executeQuery = async () => {
    console.log("result", db.memoryDb.execute(query));
  };

  const [snapshot, setSnapshot] = useState<Uint8Array<ArrayBuffer> | null>(
    null
  );

  const createSnapshot = async () => {
    const snapshot = db.memoryDb.createSnapshot();
    setSnapshot(snapshot);
  };

  const useSnapshot = async () => {
    if (!snapshot) return;
    db.memoryDb.useSnapshot(snapshot!);
  };

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-4">SQLite Sync Demo</h1>
      <p className="text-gray-600">
        Database initialized and seeded! Check the console for sample data.
      </p>
      <div className="mt-4 p-4 bg-gray-100 rounded">
        <p className="text-sm">
          ✅ Optimistic DB (in-memory) ready
          <br />
          ✅ Sync DB (persistent) ready
          <br />✅ Sample data seeded
        </p>
      </div>

      <div className="flex gap-2 flex-col">
        <input
          className="border border-gray-300"
          type="text"
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <input
          className="border border-gray-300"
          type="text"
          placeholder="Query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <p>Total Users: {totalUsers.total}</p>

      <button className="border border-gray-300" onClick={createRandomUser}>
        Create Random User
      </button>
      <button className="border border-gray-300" onClick={clearUsers}>
        Clear Users
      </button>
      <button className="border border-gray-300" onClick={executeQuery}>
        Execute Query
      </button>
      <button className="border border-gray-300" onClick={createSnapshot}>
        Create Snapshot
      </button>
      <button
        className="border border-gray-300"
        onClick={useSnapshot}
        disabled={!snapshot}
      >
        Use Snapshot
      </button>

      <div>
        {users.map((user) => (
          <div key={user.id}>{user.name}</div>
        ))}
      </div>

      <button
        onClick={() => {
          setShowPosts(!showPosts);
        }}
      >
        {showPosts ? "Hide Posts" : "Show Posts"}
      </button>

      {showPosts && <Posts />}
    </div>
  );
}

function Posts() {
  const { rows: posts } = useDbQuery({
    queryFn: (db) => db.selectFrom("posts").selectAll().compile(),
  });

  return (
    <div>
      {posts.map((post) => (
        <div key={post.id}>{post.title}</div>
      ))}
    </div>
  );
}
