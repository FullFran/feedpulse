export const TELEGRAM_DELIVERY_MODES = ['instant', 'digest_10m'] as const;

export type TelegramDeliveryMode = (typeof TELEGRAM_DELIVERY_MODES)[number];

export const DEFAULT_TELEGRAM_DELIVERY_MODE: TelegramDeliveryMode = 'instant';
