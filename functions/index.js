"use strict";

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const sharp = require("sharp");
const { randomUUID } = require("crypto");

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = defineSecret("TELEGRAM_CHAT_ID");
const APP_ID = "tkc-co-order-2026";
const MAX_PRODUCT_STOCK = 999;
const DEFAULT_PRODUCT_STOCK = 999;
const DETAIL_IMAGE_MAX_DIMENSION = 720;
const DETAIL_IMAGE_QUALITY = 68;

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

function normalizePhoneDigits(value) {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

function normalizeLookupName(value) {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

function buildOrderLookupKey(name, phone) {
  return normalizeLookupName(name) + "_" + normalizePhoneDigits(phone);
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


function getProductOriginalExtraImageUrls(product) {
  return String(product?.extraImgs || '')
    .split(/[\r\n,]+/)
    .map((url) => url.trim())
    .filter(Boolean);
}

function getFirebaseStorageObjectPath(imageUrl) {
  const parsedUrl = new URL(String(imageUrl || ''));
  if (parsedUrl.hostname !== 'firebasestorage.googleapis.com') return null;

  const marker = '/o/';
  const markerIndex = parsedUrl.pathname.indexOf(marker);
  if (markerIndex === -1) return null;

  return decodeURIComponent(parsedUrl.pathname.slice(markerIndex + marker.length));
}

function buildFirebaseDownloadUrl(bucketName, objectPath, token) {
  return 'https://firebasestorage.googleapis.com/v0/b/' +
    encodeURIComponent(bucketName) +
    '/o/' +
    encodeURIComponent(objectPath) +
    '?alt=media&token=' +
    encodeURIComponent(token);
}

function safeStoragePathSegment(value) {
  return String(value || 'product')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'product';
}

async function downloadProductImageBuffer(imageUrl) {
  const storageBucket = getStorage().bucket();
  const objectPath = getFirebaseStorageObjectPath(imageUrl);

  if (objectPath) {
    const [buffer] = await storageBucket.file(objectPath).download();
    return buffer;
  }

  const response = await fetch(String(imageUrl), {
    headers: { 'User-Agent': 'TeslabOrderImageOptimizer/1.0' }
  });

  if (!response.ok) {
    throw new Error('Image download failed with HTTP ' + response.status + '.');
  }

  return Buffer.from(await response.arrayBuffer());
}

async function storeOptimizedProductImage(sourceBuffer, productId, imageIndex) {
  const optimizedBuffer = await sharp(sourceBuffer, {
    limitInputPixels: 40000000,
    failOn: 'none'
  })
    .rotate()
    .resize({
      width: DETAIL_IMAGE_MAX_DIMENSION,
      height: DETAIL_IMAGE_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp({ quality: DETAIL_IMAGE_QUALITY, effort: 4 })
    .toBuffer();

  const storageBucket = getStorage().bucket();
  const objectPath = 'artifacts/' + APP_ID + '/public/data/images/optimized/' +
    Date.now() + '_' + randomUUID() + '_' + safeStoragePathSegment(productId) +
    '_' + imageIndex + '_detail_720.webp';
  const downloadToken = randomUUID();

  await storageBucket.file(objectPath).save(optimizedBuffer, {
    resumable: false,
    metadata: {
      contentType: 'image/webp',
      cacheControl: 'public,max-age=31536000,immutable',
      metadata: {
        firebaseStorageDownloadTokens: downloadToken
      }
    }
  });

  return {
    url: buildFirebaseDownloadUrl(storageBucket.name, objectPath, downloadToken),
    bytes: optimizedBuffer.length
  };
}

async function optimizeProductImageSource(imageUrl, productId, imageIndex) {
  const sourceBuffer = await downloadProductImageBuffer(imageUrl);
  return storeOptimizedProductImage(sourceBuffer, productId, imageIndex);
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
        ordererNameNormalized: normalizeLookupName(order.ordererName),
        ordererPhoneDigits: normalizePhoneDigits(order.ordererPhone),
        orderLookupKey: buildOrderLookupKey(order.ordererName, order.ordererPhone),
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

exports.optimizeProductDetailImages = onCall(
  { region: 'asia-northeast3' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in is required to optimize product images.');
    }

    const productId = String(request.data?.productId || '').trim();
    if (!productId) {
      throw new HttpsError('invalid-argument', 'A product ID is required.');
    }

    const db = getFirestore();
    const catalogRef = db.doc('artifacts/' + APP_ID + '/public/data/config/catalog');
    const initialCatalogSnap = await catalogRef.get();
    const initialProducts = initialCatalogSnap.exists && Array.isArray(initialCatalogSnap.data().products)
      ? initialCatalogSnap.data().products
      : [];
    const initialProduct = initialProducts.find((product) => product.id === productId);

    if (!initialProduct || !String(initialProduct.img || '').trim()) {
      throw new HttpsError('not-found', 'The product or its main image could not be found.');
    }

    const originalMainImageUrl = String(initialProduct.img).trim();
    const originalExtraImageUrls = getProductOriginalExtraImageUrls(initialProduct);

    let optimizedMainImage;
    const optimizedExtraImages = [];

    try {
      optimizedMainImage = await optimizeProductImageSource(originalMainImageUrl, productId, 0);

      for (let index = 0; index < originalExtraImageUrls.length; index += 1) {
        optimizedExtraImages.push(
          await optimizeProductImageSource(originalExtraImageUrls[index], productId, index + 1)
        );
      }
    } catch (error) {
      logger.error('Product detail image optimization failed.', {
        productId,
        error: error?.message || String(error)
      });
      throw new HttpsError(
        'internal',
        'The server could not read or convert one of the original images.'
      );
    }

    const optimizationResult = await db.runTransaction(async (transaction) => {
      const currentCatalogSnap = await transaction.get(catalogRef);
      const currentProducts = currentCatalogSnap.exists && Array.isArray(currentCatalogSnap.data().products)
        ? currentCatalogSnap.data().products
        : [];
      const currentProduct = currentProducts.find((product) => product.id === productId);

      if (!currentProduct) {
        throw new HttpsError('not-found', 'The product was removed while images were being optimized.');
      }

      const currentMainImageUrl = String(currentProduct.img || '').trim();
      const currentExtraImageUrls = getProductOriginalExtraImageUrls(currentProduct);

      if (currentMainImageUrl !== originalMainImageUrl ||
          currentExtraImageUrls.join('\n') !== originalExtraImageUrls.join('\n')) {
        throw new HttpsError(
          'aborted',
          'The product images changed while optimization was running. Reload and try again.'
        );
      }

      const updatedProducts = currentProducts.map((product) => product.id === productId
        ? {
            ...product,
            detailImageUrl: optimizedMainImage.url,
            detailExtraImgs: optimizedExtraImages.map((image) => image.url),
            detailImageOptimizationVersion: 3,
            detailImagesOptimizedAt: new Date().toISOString()
          }
        : product);

      transaction.update(catalogRef, { products: updatedProducts });

      return {
        detailImageUrl: optimizedMainImage.url,
        detailExtraImgs: optimizedExtraImages.map((image) => image.url),
        optimizedImageCount: optimizedExtraImages.length + 1,
        optimizedBytes: optimizedMainImage.bytes +
          optimizedExtraImages.reduce((total, image) => total + image.bytes, 0)
      };
    });

    logger.info('Product detail images optimized.', {
      productId,
      optimizedImageCount: optimizationResult.optimizedImageCount,
      optimizedBytes: optimizationResult.optimizedBytes
    });

    return optimizationResult;
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
