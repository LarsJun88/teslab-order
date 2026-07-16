"use strict";

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = defineSecret("TELEGRAM_CHAT_ID");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatWon(value) {
  const amount = Number(value || 0);
  return `${amount.toLocaleString("ko-KR")}원`;
}

function buildTelegramMessage(order) {
  const ordererName = order.ordererName || "주문자";
  const finalTotal = formatWon(order.finalTotal);
  const orderId = order.orderId || "주문번호 없음";

  return [
    "<b>새 주문 접수</b>",
    `주문자: ${escapeHtml(ordererName)}`,
    `총 금액: ${escapeHtml(finalTotal)}`,
    `주문번호: ${escapeHtml(orderId)}`
  ].join("\n");
}

exports.notifyTelegramOnOrderCreated = onDocumentCreated(
  {
    document: "artifacts/{appId}/public/data/orders/{orderId}",
    region: "asia-northeast3",
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
  },
  async (event) => {
    const order = event.data?.data();

    if (!order) {
      logger.warn("Order document had no data.", event.params);
      return;
    }

    const botToken = TELEGRAM_BOT_TOKEN.value();
    const chatId = TELEGRAM_CHAT_ID.value();
    const message = buildTelegramMessage(order);
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("Telegram sendMessage failed.", {
        status: response.status,
        errorText,
        orderId: order.orderId || event.params.orderId
      });
      throw new Error(`Telegram sendMessage failed with ${response.status}`);
    }

    logger.info("Telegram order notification sent.", {
      orderId: order.orderId || event.params.orderId,
      ordererName: order.ordererName || null,
      finalTotal: order.finalTotal || null
    });
  }
);
