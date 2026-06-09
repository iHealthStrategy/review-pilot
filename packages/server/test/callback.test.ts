import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverCallback } from "../src/review/callback.js";

test("deliverCallback: POSTs JSON with merged headers", async () => {
  const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const send = async (url: string, headers: Record<string, string>, body: string) => {
    sent.push({ url, headers, body });
  };

  const res = await deliverCallback(
    { url: "https://hook.example/cb", headers: { Authorization: "Bearer t" } },
    { taskId: "task_1", status: "completed", conclusion: "neutral", findings: [] },
    send,
  );

  assert.equal(res.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "https://hook.example/cb");
  assert.equal(sent[0]!.headers["Content-Type"], "application/json");
  assert.equal(sent[0]!.headers["Authorization"], "Bearer t");
  const body = JSON.parse(sent[0]!.body);
  assert.equal(body.taskId, "task_1");
  assert.equal(body.status, "completed");
});

test("deliverCallback: never throws on a failing endpoint", async () => {
  const send = async () => {
    throw new Error("connection refused");
  };
  const res = await deliverCallback(
    { url: "https://down.example" },
    { taskId: "task_2", status: "failed", error: "boom" },
    send,
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /connection refused/);
});
