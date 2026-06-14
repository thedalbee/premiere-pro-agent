import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reopenUnconfirmedMessage,
  reconnectPendingMessage,
} from "../dist/commands/cut.js";

// Snapshot the exact slow-launch messages. They must read as informational
// ("note:", reassurance) rather than alarming ("WARNING", "failed").

test("reopenUnconfirmedMessage: exact informational text, no alarm words", () => {
  const msg = reopenUnconfirmedMessage("MyProject.prproj");
  assert.equal(
    msg,
    'note: could not confirm the reopen of "MyProject.prproj" yet — Premiere may still be launching. Your changes are saved (a .bak backup exists); if it is not open shortly, reopen the project manually.',
  );
  assert.ok(!/WARNING/.test(msg), "no WARNING");
  assert.ok(!/failed/i.test(msg), "no 'failed'");
});

test("reconnectPendingMessage: exact informational text, reassures no action", () => {
  const msg = reconnectPendingMessage(180000);
  assert.equal(
    msg,
    "note: the plugin has not reconnected within 180s — Premiere may still be finishing launch. Your changes are saved and will appear automatically once it reconnects; no manual action needed.",
  );
  assert.ok(!/WARNING/.test(msg), "no WARNING");
  assert.ok(/no manual action needed/.test(msg), "reassures no action");
});

test("reconnectPendingMessage: reports the actual timeout in seconds", () => {
  assert.match(reconnectPendingMessage(30000), /within 30s/);
  assert.match(reconnectPendingMessage(120000), /within 120s/);
});
