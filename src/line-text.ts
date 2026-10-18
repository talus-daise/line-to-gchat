import { unicodeForLineEmoji } from "./line-emoji-map";
import type { LineEmoji, LineMessage } from "./types";

/**
 * LINE絵文字(商品絵文字)は本文中にプレースホルダで入ってくる。
 * そのままだとプレースホルダがそのまま表示されてしまうので、位置(UTF-16)を頼りに
 * 対応するUnicode絵文字へ置き換える。対応表に無いものは `□` にする。
 */
export function applyLineEmojis(text: string, emojis: LineEmoji[] | undefined): string {
  if (!emojis?.length) return text;
  let out = text;
  for (const e of [...emojis].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, e.index) + (unicodeForLineEmoji(e) ?? "□") + out.slice(e.index + e.length);
  }
  return out;
}

/** 引用元として表示する要約の最大文字数 */
const PREVIEW_LIMIT = 120;

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string): string {
  return s.length > PREVIEW_LIMIT ? `${s.slice(0, PREVIEW_LIMIT)}…` : s;
}

/**
 * 「返信で引用」の引用元に表示する1行の要約。
 * テキストは本文の先頭を、それ以外は種別の短いラベルを返す。
 */
export function previewOf(msg: LineMessage): string {
  switch (msg.type) {
    case "text":
      return truncate(collapse(applyLineEmojis(msg.text, msg.emojis)));
    case "image":
      return msg.imageSet && msg.imageSet.total > 1
        ? `[画像 ${msg.imageSet.index}/${msg.imageSet.total}]`
        : "[画像]";
    case "video":
      return "[動画]";
    case "audio":
      return "[音声メッセージ]";
    case "file":
      return `[ファイル: ${collapse(msg.fileName)}]`;
    case "location":
      return `[位置情報${msg.title ? `: ${collapse(msg.title)}` : ""}]`;
    case "sticker": {
      const kw = msg.keywords?.slice(0, 3).join(", ") ?? "";
      return `[スタンプ${kw ? `: ${kw}` : ""}]`;
    }
    default:
      return "[メッセージ]";
  }
}
