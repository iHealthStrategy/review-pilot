import assert from "node:assert/strict";
import { test } from "node:test";
import {
  looksLikeSkillToken,
  skillTokenFor,
  verifySkillToken,
} from "../src/auth/skill-token.js";

test("skill-token: derive → recognize → verify round-trip", () => {
  const secret = "s3cr3t-signing-key";
  const tok = skillTokenFor("usr_abc-123", secret);
  assert.ok(tok.startsWith("rsk_usr_abc-123."));
  assert.ok(looksLikeSkillToken(tok));
  assert.equal(verifySkillToken(tok, secret), "usr_abc-123");
});

test("skill-token: stable for the same (userId, secret); rotates with the secret", () => {
  assert.equal(skillTokenFor("usr_x", "A"), skillTokenFor("usr_x", "A"));
  assert.notEqual(skillTokenFor("usr_x", "A"), skillTokenFor("usr_x", "B"));
});

test("skill-token: wrong secret / tampered sig / non-skill / no secret → null|empty", () => {
  const tok = skillTokenFor("usr_x", "A");
  assert.equal(verifySkillToken(tok, "B"), null); // wrong secret
  assert.equal(verifySkillToken(tok.slice(0, -2) + "zz", "A"), null); // tampered sig
  assert.equal(verifySkillToken("rpat_whatever", "A"), null); // not a skill token
  assert.equal(looksLikeSkillToken("rpat_x"), false);
  assert.equal(skillTokenFor("usr_x", ""), ""); // no secret → no token
  assert.equal(verifySkillToken(tok, ""), null);
});
