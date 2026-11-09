import assert from "node:assert/strict";
import { test } from "node:test";
import { handleBloomie } from "../server/bloomie.mjs";

const origin = "https://preview.example.test";
const env = {
  BLOOMIE_N8N_URL: "https://n8n.example.test/chat",
  BLOOMIE_N8N_USERNAME: "test",
  BLOOMIE_N8N_PASSWORD: "test-password",
  BLOOMIE_HASH_SECRET: "local-test-placeholder-length-over-32",
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "local-test-token",
};
const sessionId = "439f7b0b-de66-423f-9e9e-b0ca64f44cbb";
const validBody = { sessionId, message: " What do you do? " };
const makeRequest = ({ body = validBody, method = "POST", site = origin, type = "application/json" } = {}) =>
  new Request(origin+"/api/bloomie", {
    method,
    headers: { Origin: site, "Content-Type": type },
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const ip = "192.0.2.10";
const noFetch = () => assert.fail("No outbound request should be made");

test("rejects cross-origin, invalid, unsupported and oversized requests before network use", async () => {
  for (const [options, status] of [
    [{ method: "GET" }, 405],
    [{ site: "https://attacker.example.test" }, 403],
    [{ type: "text/plain" }, 415],
    [{ body: "bad JSON" }, 400],
    [{ body: null }, 400],
    [{ body: { ...validBody, message: " " } }, 400],
    [{ body: { ...validBody, message: "x".repeat(501) } }, 400],
    [{ body: { ...validBody, sessionId: "not-a-session" } }, 400],
    [{ body: "x".repeat(4097) }, 413],
  ]) {
    const response = await handleBloomie(makeRequest(options), ip, env, noFetch);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("fails closed when configuration or trusted IP is missing", async () => {
  assert.equal((await handleBloomie(makeRequest(), ip, {}, noFetch)).status, 503);
  assert.equal((await handleBloomie(makeRequest(), "", env, noFetch)).status, 503);
  assert.equal((await handleBloomie(makeRequest(), ip, { ...env, BLOOMIE_N8N_URL: "http://example.test" }, noFetch)).status, 503);
});

test("enforces the distributed limit and never calls n8n if the limit is exceeded or unavailable", async () => {
  let requests = 0;
  const limited = await handleBloomie(makeRequest(), ip, env, async (url, options) => {
    requests++;
    assert.equal(url, env.UPSTASH_REDIS_REST_URL+"/");
    assert.equal(options.headers.Authorization, "Bearer "+env.UPSTASH_REDIS_REST_TOKEN);
    assert.equal(JSON.parse(options.body)[0], "EVAL");
    assert.ok(!options.body.includes(ip));
    assert.ok(!options.body.includes(validBody.message));
    return Response.json({ result: 42 });
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "42");
  assert.equal(requests, 1);
  const failed = await handleBloomie(makeRequest(), ip, env, async () => Response.json({ error: "private details" }, { status: 500 }));
  assert.deepEqual(await failed.json(), { error: "chat_unavailable" });
});

test("uses server authentication and a stable opaque session and returns only the answer", async () => {
  const sessions = [];
  const stub = async (url, options) => {
    if (url.startsWith(env.UPSTASH_REDIS_REST_URL)) return Response.json({ result: 0 });
    assert.equal(url, env.BLOOMIE_N8N_URL);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Basic "+Buffer.from("test:test-password").toString("base64"));
    const payload = JSON.parse(options.body);
    assert.deepEqual(Object.keys(payload), ["action", "sessionId", "chatInput"]);
    assert.equal(payload.chatInput, "What do you do?");
    assert.match(payload.sessionId, /^[a-f0-9]{64}$/);
    sessions.push(payload.sessionId);
    return Response.json([{ output: "Test answer", ignored: "upstream metadata" }]);
  };
  for (let i = 0; i < 2; i++) {
    const result = await handleBloomie(makeRequest(), ip, env, stub);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { reply: "Test answer" });
  }
  assert.equal(sessions[0], sessions[1]);
});

test("rejects upstream failures, malformed success and oversized answers", async () => {
  for (const [upstream, status] of [
    [new Response("private upstream error", { status: 401 }), 502],
    [Response.json({ message: "Error object" }), 502],
    [Response.json({ output: "x".repeat(4001) }), 502],
    [new Response("<html>not JSON</html>"), 503],
  ]) {
    const result = await handleBloomie(makeRequest(), ip, env,
      async url => url.startsWith(env.UPSTASH_REDIS_REST_URL) ? Response.json({ result: 0 }) : upstream);
    assert.equal(result.status, status);
    assert.ok(!("reply" in await result.json()));
  }
});
