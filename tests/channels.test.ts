import { expect, test } from "bun:test";
import { ConfigSchema } from "../src/config.ts";
import { buildChannels } from "../src/gateway/channels.ts";

const build = (channels: object) => buildChannels(ConfigSchema.parse({ channels }));

test("nothing configured means no channels and no errors", () => {
  expect(build({})).toEqual({ channels: [], errors: [] });
});

test("credentials turn a channel on; the allowlist is required", () => {
  expect(build({ telegram: { token: "t" } }).errors[0]).toContain("TELEGRAM_ALLOWED_USERS");
  const ok = build({ telegram: { token: "t", allowedUsers: [42] } });
  expect(ok.channels.map((c) => c.name)).toEqual(["telegram"]);
  expect(ok.channels[0]!.isAllowed("42")).toBe(true);
});

test("WhatsApp Cloud lists every missing secret", () => {
  const { errors } = build({ whatsapp: { enabled: true, allowedNumbers: ["91"] } });
  expect(errors[0]).toBe(
    "WhatsApp Cloud API: set WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN in .env.",
  );
});

test("WhatsApp Web is only on when explicitly enabled", () => {
  expect(build({ whatsappWeb: { allowedNumbers: ["91"] } }).channels).toHaveLength(0);
  expect(build({ whatsappWeb: { enabled: true, allowedNumbers: ["91"] } }).channels.map((c) => c.name)).toEqual(["whatsapp-web"]);
});
