"use strict";

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = defineSecret("TELEGRAM_CHAT_ID");
const APP_ID = "tkc-co-order-2026";
const MAX_PRODUCT_STOCK = 999;
const DEFAULT_PRODUCT_STOCK = 999;

initializeApp();

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

function formatCartItems(cart) {
  if (!Array.isArray(cart) || cart.length === 0) {
    return "주문 품목 없음";
  }

  return cart.map((item) => {
    const optionName = item.optionName || "품목명 없음";
    const quantity = Number(item.quantity || 0);
    const itemTotal = Number(item.unitPrice || 0) * quantity;

    return `- ${escapeHtml(optionName)} x${quantity} (${escapeHtml(formatWon(itemTotal))})`;
  }).join("\n");
}

function buildTelegramMessage(order) {
  const ordererName = order.ordererName || "주문자";
  const finalTotal = formatWon(order.finalTotal);
  const orderId = order.orderId || "주문번호 없음";
  const cartItems = formatCartItems(order.cart);

  return [
    "<b>새 주문 접수</b>",
    `주문자: ${escapeHtml(ordererName)}`,
    `총 금액: ${escapeHtml(finalTotal)}`,
    "",
    "<b>주문 품목</b>",
    cartItems,
    "",
    `주문번호: ${escapeHtml(orderId)}`
  ].join("\n");
}


function getProductStock(product) {
  const stock = Number(product?.stock);
  if (!Number.isFinite(stock)) return DEFAULT_PRODUCT_STOCK;
  return Math.max(0, Math.min(MAX_PRODUCT_STOCK, Math.floor(stock)));
}

function isProductManuallySoldOut(product) {
  return /\(\s*품절\s*\)/.test(String(product?.name || "")) ||
    /\(\s*품절\s*\)/.test(String(product?.itemNo || ""));
}

function validateOrderForInventory(order) {
  if (!order || typeof order !== "object") {
    throw new HttpsError("invalid-argument", "주문 정보가 없습니다.");
  }

  if (!/^ORD-\d{6}-\d{4}$/.test(String(order.orderId || ""))) {
    throw new HttpsError("invalid-argument", "주문번호 형식이 올바르지 않습니다.");
  }

  if (!Array.isArray(order.cart) || order.cart.length === 0 || order.cart.length > 100) {
    throw new HttpsError("invalid-argument", "주문 품목이 올바르지 않습니다.");
  }

  for (const item of order.cart) {
    const quantity = Number(item?.quantity);
    const unitPrice = Number(item?.unitPrice);

    if (!String(item?.productId || "").trim() ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PRODUCT_STOCK ||
        !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new HttpsError("invalid-argument", "주문 수량 또는 품목 정보가 올바르지 않습니다.");
    }
  }

  if (!Number.isFinite(Number(order.finalTotal)) || Number(order.finalTotal) < 0) {
    throw new HttpsError("invalid-argument", "주문 금액이 올바르지 않습니다.");
  }
}

exports.submitOrderWithInventory = onCall(
  { region: "asia-northeast3" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "로그인 연결 후 주문할 수 있습니다.");
    }

    const order = request.data?.order;
    validateOrderForInventory(order);

    const db = getFirestore();
    const catalogRef = db.doc(`artifacts/${APP_ID}/public/data/config/catalog`);
    const orderRef = db.doc(`artifacts/${APP_ID}/public/data/orders/${order.orderId}`);

    return db.runTransaction(async (transaction) => {
      const catalogSnap = await transaction.get(catalogRef);
      const existingOrderSnap = await transaction.get(orderRef);

      if (!catalogSnap.exists) {
        throw new HttpsError("failed-precondition", "상품 정보를 찾을 수 없습니다.");
      }

      if (existingOrderSnap.exists) {
        throw new HttpsError("already-exists", "이미 접수된 주문번호입니다.");
      }

      const catalogData = catalogSnap.data() || {};
      const catalogProducts = Array.isArray(catalogData.products) ? catalogData.products : [];
      const requestedByProduct = new Map();

      for (const item of order.cart) {
        const productId = String(item.productId);
        const quantity = Number(item.quantity);
        requestedByProduct.set(productId, (requestedByProduct.get(productId) || 0) + quantity);
      }

      for (const [productId, requestedQuantity] of requestedByProduct) {
        const product = catalogProducts.find((item) => item.id === productId);
        const availableStock = product ? getProductStock(product) : 0;

        if (!product || isProductManuallySoldOut(product) || availableStock < requestedQuantity) {
          throw new HttpsError(
            "failed-precondition",
            "재고가 부족하여 주문을 완료할 수 없습니다.",
            {
              reason: "insufficient-stock",
              productId,
              productName: product?.name || "판매 종료 상품",
              availableStock,
              requestedQuantity
            }
          );
        }
      }

      const updatedProducts = catalogProducts.map((product) => {
        const requestedQuantity = requestedByProduct.get(product.id) || 0;
        if (requestedQuantity === 0) return product;

        return {
          ...product,
          stock: getProductStock(product) - requestedQuantity
        };
      });

      const storedOrder = {
        ...order,
        cart: order.cart.map((item) => ({
          ...item,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice)
        })),
        inventoryCommittedAt: FieldValue.serverTimestamp(),
        inventoryCommittedBy: request.auth.uid
      };

      transaction.update(catalogRef, { products: updatedProducts });
      transaction.set(orderRef, storedOrder);

      return {
        orderId: order.orderId,
        remainingStock: Object.fromEntries(
          updatedProducts
            .filter((product) => requestedByProduct.has(product.id))
            .map((product) => [product.id, getProductStock(product)])
        )
      };
    });
  }
);

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
