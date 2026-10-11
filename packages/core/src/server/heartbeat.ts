// Plain text, not JSON: Cloudflare's `setWebSocketAutoResponse` matches the exact message, so a hibernating Durable
// Object can answer pings without waking up.
export const HEARTBEAT_PING = "ping";
export const HEARTBEAT_PONG = "pong";
