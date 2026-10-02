import { join } from "node:path";
import { TelegramChannel } from "../channels/telegram.ts";
import { WhatsAppCloudChannel } from "../channels/whatsappCloud.ts";
import { WhatsAppWebChannel } from "../channels/whatsappWeb.ts";
import type { Config } from "../config.ts";
import type { ChatChannel } from "./channel.ts";

/**
 * Builds the enabled chat channels from the config, or explains what is missing.
 * Telegram and WhatsApp Cloud turn on when their credentials are set; WhatsApp Web
 * (unofficial) only when explicitly enabled. An empty allowlist is refused, so the
 * bot can never answer strangers by accident.
 */
export function buildChannels(config: Config): { channels: ChatChannel[]; errors: string[] } {
  const { telegram, whatsapp, whatsappWeb } = config.channels;
  const channels: ChatChannel[] = [];
  const errors: string[] = [];

  if (telegram.enabled ?? !!telegram.token) {
    if (!telegram.token) errors.push("Telegram: set TELEGRAM_BOT_TOKEN in .env (create a bot with @BotFather).");
    else if (telegram.allowedUsers.length === 0) {
      errors.push("Telegram: set TELEGRAM_ALLOWED_USERS in .env to your numeric user id (ask @userinfobot).");
    } else channels.push(new TelegramChannel({ token: telegram.token, allowedUsers: telegram.allowedUsers, apiBase: telegram.apiBase }));
  }

  if (whatsapp.enabled ?? !!whatsapp.token) {
    const missing = (
      [
        ["WHATSAPP_TOKEN", whatsapp.token],
        ["WHATSAPP_PHONE_NUMBER_ID", whatsapp.phoneNumberId],
        ["WHATSAPP_APP_SECRET", whatsapp.appSecret],
        ["WHATSAPP_VERIFY_TOKEN", whatsapp.verifyToken],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length) errors.push(`WhatsApp Cloud API: set ${missing.join(", ")} in .env.`);
    else if (whatsapp.allowedNumbers.length === 0) {
      errors.push("WhatsApp Cloud API: set WHATSAPP_ALLOWED_NUMBERS in .env (your number with country code).");
    } else {
      channels.push(
        new WhatsAppCloudChannel({
          token: whatsapp.token!,
          phoneNumberId: whatsapp.phoneNumberId!,
          appSecret: whatsapp.appSecret!,
          verifyToken: whatsapp.verifyToken!,
          allowedNumbers: whatsapp.allowedNumbers,
          apiBase: whatsapp.apiBase,
        }),
      );
    }
  }

  if (whatsappWeb.enabled) {
    if (whatsappWeb.allowedNumbers.length === 0) {
      errors.push("WhatsApp Web: set WHATSAPP_WEB_ALLOWED_NUMBERS in .env (your number with country code).");
    } else {
      channels.push(
        new WhatsAppWebChannel({ authDir: join(config.paths.data, "whatsapp-auth"), allowedNumbers: whatsappWeb.allowedNumbers }),
      );
    }
  }

  return { channels, errors };
}
