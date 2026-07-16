# teslab-order
teslab order page

## Telegram order notifications

New order notifications are handled by Firebase Cloud Functions, not by the public
GitHub Pages HTML. This keeps the Telegram bot token out of the browser and out of
the GitHub repository.

The deployed function watches this Firestore path:

```text
artifacts/{appId}/public/data/orders/{orderId}
```

When a new order document is created, Telegram receives:

```text
새 주문 접수
주문자: 홍길동
총 금액: 32,000원
주문번호: ORD-260716-1234
```

### Setup

1. Create a bot with Telegram `@BotFather` and copy the bot token.
2. Send a message to the bot from the Telegram account or group that should receive order notifications.
3. Get the chat ID with:

```text
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
```

4. Install Firebase CLI and log in:

```bash
npm install -g firebase-tools
firebase login
```

5. Install function dependencies:

```bash
cd functions
npm install
cd ..
```

6. Store secrets in Firebase. Do not put these values in `index.html`.

```bash
firebase functions:secrets:set TELEGRAM_BOT_TOKEN
firebase functions:secrets:set TELEGRAM_CHAT_ID
```

7. Deploy the notification function:

```bash
firebase deploy --only functions:notifyTelegramOnOrderCreated
```

Firebase Cloud Functions may require the Firebase project to be on the Blaze plan.
