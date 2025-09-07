import { SQLocalKysely } from "sqlocal/kysely";

// Define table schemas
interface Database {
  users: {
    id: number;
    name: string;
    email: string;
    created_at: string;
  };
  posts: {
    id: number;
    user_id: number;
    title: string;
    content: string;
    created_at: string;
  };
}

// Sample data
const sampleUsers = [
  { name: "Alice Johnson", email: "alice@example.com" },
  { name: "Bob Smith", email: "bob@example.com" },
  { name: "Carol Williams", email: "carol@example.com" },
];

const samplePosts = [
  {
    user_id: 1,
    title: "Getting Started with SQLite",
    content:
      "SQLite is a lightweight database engine that's perfect for local applications...",
  },
  {
    user_id: 1,
    title: "Database Synchronization Patterns",
    content:
      "When building offline-first applications, synchronization becomes crucial...",
  },
  {
    user_id: 2,
    title: "Modern Web Development",
    content:
      "The landscape of web development has evolved significantly in recent years...",
  },
  {
    user_id: 3,
    title: "Performance Optimization Tips",
    content:
      "Here are some practical tips for optimizing database performance...",
  },
];

async function createTables(db: SQLocalKysely) {
  // Create users table
  await db.sql`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // Create posts table
  await db.sql`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `;
}

async function seedUsers(db: SQLocalKysely) {
  for (const user of sampleUsers) {
    await db.sql`
      INSERT OR IGNORE INTO users (name, email)
      VALUES (${user.name}, ${user.email})
    `;
  }
}

async function seedPosts(db: SQLocalKysely) {
  for (const post of samplePosts) {
    await db.sql`
      INSERT OR IGNORE INTO posts (user_id, title, content)
      VALUES (${post.user_id}, ${post.title}, ${post.content})
    `;
  }
}

export async function seedDatabase(db: SQLocalKysely) {
  console.log("Creating tables...");
  await createTables(db);

  console.log("Seeding users...");
  await seedUsers(db);

  console.log("Seeding posts...");
  await seedPosts(db);

  console.log("Database seeding completed!");
}

export async function clearDatabase(db: SQLocalKysely) {
  console.log("Clearing database...");
  await db.sql`DROP TABLE IF EXISTS posts`;
  await db.sql`DROP TABLE IF EXISTS users`;
  console.log("Database cleared!");
}

export async function resetDatabase(db: SQLocalKysely) {
  await clearDatabase(db);
  await seedDatabase(db);
}

// Helper function to get sample data for testing
export function getSampleData() {
  return {
    users: sampleUsers,
    posts: samplePosts,
  };
}

export type { Database };
