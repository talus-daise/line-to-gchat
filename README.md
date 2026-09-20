# line-to-gchat

LINEグループ（または複数人トーク）の投稿を、Google Chat のスペースへ自動転送する Cloudflare Worker です。

**R2 / KV / D1 などのストレージは使いません。** クレジットカード登録が不要な Cloudflare の無料プラン（Workers Free）だけで動きます。

```
LINEグループ ─▶ LINE公式アカウント(Messaging API)
                     │ Webhook (署名検証)
                     ▼
              Cloudflare Worker ─────▶ Google Chat スペース (Incoming Webhook)
                     ▲                         │ 画像/ファイルのリンクを開く
                     └── 署名付きURLで中継 ◀─────┘
                         (開かれた時にLINEから取得してそのまま返す)
```

## 転送できるもの

| LINEの種類 | Google Chat での表示 |
| --- | --- |
| テキスト | `*送信者*  ·  グループ名` + 本文 (長文は自動分割) |
| 画像 | カード（アイコン付き）に画像を表示 + 「開く」「ダウンロード」 |
| 動画 / 音声 | カード + 「再生」「ダウンロード」ボタン |
| ファイル | カード（ファイル名・サイズ）+ 「ダウンロード」ボタン |
| スタンプ | スタンプ画像 + キーワードのカード |
| 位置情報 | 住所 + Googleマップのリンク |

### 仕組み上の注意

- **Google Chat の Incoming Webhook はファイルを直接添付できません。** そのため Chat には「このWorkerの署名付きURL」を渡し、**URLが開かれた瞬間にLINEからデータを取得して中継**します（サイズ上限はWorker側にはありません）。
- **LINE側のコンテンツは一定期間で自動削除されます**（期間はLINEの仕様で、公式ドキュメントに具体的な日数の記載はありません）。削除後は、Chat上のリンクを開いても「保存期間が過ぎた」と表示されます。長期保存したい資料は、期限内にダウンロードしてください。
- URL を知っている人は誰でも開けます（HMAC署名付きで、署名なしでは開けません）。共有先には注意してください。
- Bot が参加した **後** のメッセージだけが対象です。過去ログの取得はできません。
- LINEのグループにはBotが参加していることが見えます。**転送を始めることをメンバーに伝えておく**ことをおすすめします。

## セットアップ

### 0. インストール

```bash
npm install
```

### 1. Google Chat の Webhook URL を作る

1. 転送先のスペースを開く
2. スペース名の横の「▼」→ **アプリと統合** → **Webhookを追加**
3. 名前（例: `LINE転送`）を付けて保存し、**Webhook URL をコピー**

> URL にはキーとトークンが含まれます。公開リポジトリやチャットに貼らないでください。
> 組織の管理者設定によっては Webhook を追加できない場合があります。

### 2. LINE Developers で Messaging API チャネルを作る

1. [LINE Developers Console](https://developers.line.biz/console/) でプロバイダーを作成 → **Messaging API チャネル**を作成
2. **チャネルシークレット**（チャネル基本設定）を控える
3. Messaging API設定で **チャネルアクセストークン（長期）** を発行して控える
4. [LINE Official Account Manager](https://manager.line.biz/) → 設定 → 応答設定 で
   - **グループトーク・複数人トークへの参加を許可する** を ON
   - Webhook を ON
   - あいさつメッセージ・応答メッセージは OFF（グループでBotが勝手に喋らないように）
5. Messaging API設定の「Webhookの再送」は **OFF のまま**にしてください（重複転送の原因になります）

### 3. デプロイして Secrets を登録

```bash
npx wrangler login      # 初回のみ (無料アカウントでOK)
npx wrangler deploy

npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put GOOGLE_CHAT_WEBHOOK_URL
npx wrangler secret put MEDIA_SIGNING_SECRET      # 例: openssl rand -base64 32 の出力
```

デプロイ後に表示される URL（`https://line-to-gchat.<あなたのサブドメイン>.workers.dev`）を使い、
LINE Developers の **Webhook URL** に `https://…workers.dev/webhook` を設定して **検証** を押します（成功すれば OK）。
「Webhookの利用」も ON にしてください。

> カスタムドメインで配信する場合は `wrangler.jsonc` に `"vars": { "PUBLIC_BASE_URL": "https://example.com" }` を追加できます。
> `MEDIA_SIGNING_SECRET` を変更すると、過去に発行したメディアURLは無効になります。

### 4. 転送対象のグループIDを登録する

1. LINE公式アカウントを転送したいグループに招待する
2. そのグループで何か1件投稿する
3. ログを見る

   ```bash
   npx wrangler tail --format pretty
   ```

   `[line] skipped (not in TARGET_LINE_GROUP_IDS): group Cxxxxxxxx…` と出るので、`C…` の部分がグループIDです。
   （招待直後は `[line] bot joined: group C…` も出ます）
4. 登録する（複数ある場合はカンマ区切り。複数人トークは `R…` のroomId）

   ```bash
   npx wrangler secret put TARGET_LINE_GROUP_IDS
   # → Cxxxxxxxx,Cyyyyyyyy
   ```

これで、対象グループの投稿が Google Chat に流れ始めます。**IDを登録するまでは何も転送されません**（安全側の挙動）。

## ローカル開発とテスト

```bash
cp .dev.vars.example .dev.vars   # 値を埋める
npm run dev                      # wrangler dev

npm run typecheck
npm test                         # 署名検証・転送ロジック・メディア中継などのテスト
```

## 設定一覧

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `LINE_CHANNEL_SECRET` | Secret | Webhook署名の検証に使用 |
| `LINE_CHANNEL_ACCESS_TOKEN` | Secret | 表示名・グループ名・メディア取得のLINE API呼び出し |
| `GOOGLE_CHAT_WEBHOOK_URL` | Secret | 転送先スペースの Incoming Webhook |
| `MEDIA_SIGNING_SECRET` | Secret | メディアURLの署名鍵 |
| `TARGET_LINE_GROUP_IDS` | Secret | 転送対象のグループID/ルームID（カンマ区切り） |
| `PUBLIC_BASE_URL` | Var (任意) | メディアURLの origin を固定したい場合 |

## エンドポイント

| パス | 用途 |
| --- | --- |
| `POST /webhook` | LINE からの Webhook（`x-line-signature` を検証。不正なら 401） |
| `GET /media/:kind/:messageId/:signature/:filename` | 署名付きメディア中継（`?dl=1` で強制ダウンロード。LINEがRangeに対応していれば中継） |
| `GET /` | 動作確認用 |

## トラブルシューティング

- **何も転送されない**: `wrangler tail` を確認。`skipped` が出ていれば `TARGET_LINE_GROUP_IDS` の未設定/不一致です。`missing bindings/secrets` が出ていれば Secret の登録漏れです。
- **LINEのWebhook検証が失敗する**: URL末尾が `/webhook` か、`LINE_CHANNEL_SECRET` が正しいかを確認。
- **送信者が「LINEユーザー」になる**: ユーザーがプロフィール情報の利用に同意していない場合、LINE側から表示名が取れません。
- **画像がChatに表示されない / リンクが開けない**: 「保存期間が過ぎた」と出る場合はLINE側で削除済みです。カスタムドメインを使う場合は、WAF/Bot Fight Mode が Google の画像プロキシを弾いていないかも確認してください。
- **429 が続く**: Google Chat の書き込みレート制限（スペースあたり約1件/秒）。Worker側で自動再試行しますが、大量投稿が続くと遅延することがあります。

## 無料プランの目安

- Workers Free は 1日10万リクエストまで。LINEの投稿1件につきWebhook 1回、Chatが画像を読み込むたびにメディア中継が1回です。
- 1回のWebhookで処理するイベントが多い（十数件以上）場合、無料プランの「1リクエストあたり外部通信50回」に近づくことがあります。通常のグループチャットでは問題になりません。

## 今後の拡張の候補

- **長期保存**: LINEの保持期間に左右されたくない場合は、Workers KV（無料枠あり・1ファイル25MBまで）に保存する方式や、Google Drive へ保存してリンクを貼る方式に拡張できます。
- スタンプ画像は LINE の公式CDN（非公式パス）を参照しています。画像が表示できない場合でも、スタンプのキーワードはテキストで残ります。
- 転送は一方向（LINE → Google Chat）です。
