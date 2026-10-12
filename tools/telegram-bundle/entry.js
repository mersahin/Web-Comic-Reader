// Browser entry for the GramJS (MTProto) client used by "Search Telegram".
// Build: cd tools/telegram-bundle && npm ci && npm run build
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';

window.GramJS = { TelegramClient, Api, StringSession };
