export interface Env {
  // ---- Secrets ----
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  GOOGLE_CHAT_WEBHOOK_URL: string;
  /** メディアURLの署名用。推測不能なランダム文字列 */
  MEDIA_SIGNING_SECRET: string;
  /** 転送対象のグループID/ルームID (カンマ区切り)。空なら何も転送せずログのみ */
  TARGET_LINE_GROUP_IDS?: string;

  // ---- Vars ----
  /** カスタムドメインを使う場合などに公開URLの origin を固定する (省略時はリクエストの origin) */
  PUBLIC_BASE_URL?: string;
}

export type LineSource =
  | { type: "user"; userId?: string }
  | { type: "group"; groupId: string; userId?: string }
  | { type: "room"; roomId: string; userId?: string };

export interface LineEmoji {
  index: number;
  length: number;
  productId: string;
  emojiId: string;
}

export type LineMessage =
  | { id: string; type: "text"; text: string; emojis?: LineEmoji[] }
  | {
      id: string;
      type: "image";
      imageSet?: { id: string; index: number; total: number };
    }
  | { id: string; type: "video"; duration?: number }
  | { id: string; type: "audio"; duration?: number }
  | { id: string; type: "file"; fileName: string; fileSize: number }
  | {
      id: string;
      type: "location";
      title?: string;
      address?: string;
      latitude: number;
      longitude: number;
    }
  | {
      id: string;
      type: "sticker";
      packageId: string;
      stickerId: string;
      keywords?: string[];
    };

export interface LineEvent {
  type: string;
  source?: LineSource;
  message?: LineMessage;
  webhookEventId?: string;
}

export interface LineWebhookBody {
  destination?: string;
  events: LineEvent[];
}

export interface LineProfile {
  displayName: string;
  userId?: string;
  pictureUrl?: string;
}
