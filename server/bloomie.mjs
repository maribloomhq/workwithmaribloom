import { createHmac } from "node:crypto";
import { isIP } from "node:net";

const REQUEST_LIMIT = 4096;
const REPLY_LIMIT = 16384;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATE_LIMIT = `
for i, key in ipairs(KEYS) do
  local count = tonumber(redis.call("GET", key) or "0")
  if count >= tonumber(ARGV[i * 2 - 1]) then
    return math.max(1, redis.call("TTL", key))
  end
end
for i, key in ipairs(KEYS) do
  if redis.call("INCR", key) == 1 then
    redis.call("EXPIRE", key, tonumber(ARGV[i * 2]))
  end
end
return 0
`;

function json(status, body, headers = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

async function readJson(message, limit) {
  if (Number(message.headers.get("content-length")) > limit) throw new RangeError("Body too large");
  if (!message.body) throw new SyntaxError("Missing body");
  const reader = message.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return JSON.parse(text + decoder.decode());
    bytes += value.byteLength;
    if (bytes > limit) {
      void reader.cancel().catch(() => {});
      throw new RangeError("Body too large");
    }
    text += decoder.decode(value, { stream: true });
  }
}

function httpsEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid HTTPS endpoint");
  }
  return url.href;
}

function hash(secret, value) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

async function reserveRequest(ip, env, fetchImpl) {
  const clientKey = hash(env.BLOOMIE_HASH_SECRET, "client:"+ip);
  const response = await fetchImpl(httpsEndpoint(env.UPSTASH_REDIS_REST_URL), {
    method: "POST",
    headers: {
      Authorization: "Bearer "+env.UPSTASH_REDIS_REST_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      "EVAL", RATE_LIMIT, 3,
      "bloomie:client:"+clientKey, "bloomie:site:minute", "bloomie:site:day",
      8, 60, 60, 60, 300, 86400,
    ]),
    signal: AbortSignal.timeout(2500),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Rate limit service failed");
  const { result } = await readJson(response, 1024);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid rate limit response");
  return result;
}

export async function handleBloomie(request, clientIp, env = process.env, fetchImpl = fetch) {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return json(403, { error: "origin_not_allowed" });
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return json(415, { error: "json_required" });
  }

  let input;
  try {
    input = await readJson(request, REQUEST_LIMIT);
  } catch (error) {
    return error instanceof RangeError ? json(413, { error: "request_too_large" }) : json(400, { error: "invalid_request" });
  }
  const sessionId = input?.sessionId;
  const message = typeof input?.message === "string" ? input.message.trim() : "";
  if (typeof sessionId !== "string" || !UUID_V4.test(sessionId) || !message || message.length > 500) {
    return json(400, { error: "invalid_request" });
  }

  const unavailable = () => json(503, { error: "chat_unavailable" });
  if (!isIP(clientIp) || !env.BLOOMIE_N8N_USERNAME || env.BLOOMIE_N8N_USERNAME.includes(":")
    || !env.BLOOMIE_N8N_PASSWORD || !env.UPSTASH_REDIS_REST_TOKEN || (env.BLOOMIE_HASH_SECRET?.length ?? 0) < 32) {
    return unavailable();
  }

  try {
    const upstreamUrl = httpsEndpoint(env.BLOOMIE_N8N_URL);
    const retryAfter = await reserveRequest(clientIp, env, fetchImpl);
    if (retryAfter) return json(429, { error: "rate_limited" }, { "Retry-After": String(retryAfter) });

    const credentials = Buffer.from(env.BLOOMIE_N8N_USERNAME+":"+env.BLOOMIE_N8N_PASSWORD).toString("base64");
    const response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: { Authorization: "Basic "+credentials, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        action: "sendMessage",
        sessionId: hash(env.BLOOMIE_HASH_SECRET, "session:"+sessionId.toLowerCase()),
        chatInput: message,
      }),
      signal: AbortSignal.timeout(17000),
      redirect: "error",
    });
    if (!response.ok) return json(502, { error: "assistant_unavailable" });

    const body = await readJson(response, REPLY_LIMIT);
    const item = Array.isArray(body) ? body[0] : body;
    const reply = item?.output ?? item?.text;
    if (typeof reply !== "string" || !reply.trim() || reply.length > 4000) {
      return json(502, { error: "invalid_assistant_reply" });
    }
    return json(200, { reply: reply.trim() });
  } catch {
    return unavailable();
  }
}
