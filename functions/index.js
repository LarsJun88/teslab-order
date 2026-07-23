"use strict";

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const sharp = require("sharp");
const { randomUUID, createHash } = require("crypto");

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = defineSecret("TELEGRAM_CHAT_ID");
const APP_ID = "tkc-co-order-2026";
const MAX_PRODUCT_STOCK = 999;
const DEFAULT_PRODUCT_STOCK = 999;
const DETAIL_IMAGE_MAX_DIMENSION = 720;
const DETAIL_IMAGE_QUALITY = 68;
const THUMBNAIL_IMAGE_MAX_WIDTH = 320;
const THUMBNAIL_IMAGE_MAX_HEIGHT = 240;
const THUMBNAIL_IMAGE_QUALITY = 58;
const THUMBNAIL_OPTIMIZATION_VERSION = 2;
const VISITOR_ANALYTICS_MAX_DAYS = 90;

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

function getKstDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return [values.year, values.month, values.day].join("-");
}

function hashVisitorUid(uid) {
  return createHash("sha256").update(String(uid)).digest("hex");
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

async function storeOptimizedProductImage(sourceBuffer, productId, imageIndex, options = {}) {
  const {
    maxWidth = DETAIL_IMAGE_MAX_DIMENSION,
    maxHeight = DETAIL_IMAGE_MAX_DIMENSION,
    quality = DETAIL_IMAGE_QUALITY,
    suffix = 'detail_720'
  } = options;

  const optimizedBuffer = await sharp(sourceBuffer, {
    limitInputPixels: 40000000,
    failOn: 'none'
  })
    .rotate()
    .resize({
      width: maxWidth,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp({ quality, effort: 4 })
    .toBuffer();

  const storageBucket = getStorage().bucket();
  const objectPath = 'artifacts/' + APP_ID + '/public/data/images/optimized/' +
    Date.now() + '_' + randomUUID() + '_' + safeStoragePathSegment(productId) +
    '_' + imageIndex + '_' + suffix + '.webp';
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

async function optimizeProductImageSource(imageUrl, productId, imageIndex, options = {}) {
  const sourceBuffer = await downloadProductImageBuffer(imageUrl);
  return storeOptimizedProductImage(sourceBuffer, productId, imageIndex, options);
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

function isOptionManuallySoldOut(option) {
  return /\(\s*품절\s*\)/.test(String(option || ""));
}

function parseOptionExtraCost(option) {
  const match = String(option || "").match(/\(([+-])\s*([\d,]+)원\)/);
  if (!match) return 0;
  const amount = Number(match[2].replace(/,/g, ""));
  return match[1] === "-" ? -amount : amount;
}

function normalizeOptionLabel(option) {
  return String(option || "").replace(/\s*\([+-]\s*[\d,]+원\)\s*$/, "").trim();
}

function normalizeEditableText(value, fieldName, required = false) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new HttpsError("invalid-argument", fieldName + "을(를) 입력해 주세요.");
  if (normalized.length > 500) throw new HttpsError("invalid-argument", fieldName + "이(가) 너무 깁니다.");
  return normalized;
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

exports.recordVisit = onCall(
  { region: "asia-northeast3", invoker: "public" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in is required to record a visit.");

    const db = getFirestore();
    const dateKey = getKstDateKey();
    const visitorHash = hashVisitorUid(request.auth.uid);
    const now = new Date().toISOString();
    const summaryRef = db.doc("artifacts/" + APP_ID + "/private/analytics");
    const dailyRef = db.doc("artifacts/" + APP_ID + "/private/analytics/daily/" + dateKey);
    const allTimeVisitorRef = db.doc("artifacts/" + APP_ID + "/private/analytics/visitors/" + visitorHash);
    const dailyVisitorRef = db.doc("artifacts/" + APP_ID + "/private/analytics/daily/" + dateKey + "/visitors/" + visitorHash);

    return db.runTransaction(async (transaction) => {
      const snapshots = await Promise.all([
        transaction.get(summaryRef), transaction.get(dailyRef),
        transaction.get(allTimeVisitorRef), transaction.get(dailyVisitorRef)
      ]);
      const summarySnap = snapshots[0];
      const dailySnap = snapshots[1];
      const allTimeVisitorSnap = snapshots[2];
      const dailyVisitorSnap = snapshots[3];

      if (!dailyVisitorSnap.exists) {
        transaction.set(dailyVisitorRef, { firstSeenAt: now });
        transaction.set(dailyRef, {
          date: dateKey,
          visitors: FieldValue.increment(1),
          firstRecordedAt: dailySnap.exists ? dailySnap.data().firstRecordedAt || now : now,
          lastRecordedAt: now
        }, { merge: true });
      }

      const summaryUpdate = { lastRecordedAt: now, lastRecordedDate: dateKey };
      if (!summarySnap.exists) {
        summaryUpdate.totalVisitors = 0;
        summaryUpdate.firstRecordedAt = now;
        summaryUpdate.firstRecordedDate = dateKey;
      }
      if (!allTimeVisitorSnap.exists) {
        transaction.set(allTimeVisitorRef, { firstSeenAt: now });
        summaryUpdate.totalVisitors = FieldValue.increment(1);
      }

      transaction.set(summaryRef, summaryUpdate, { merge: true });
      return { date: dateKey, countedToday: !dailyVisitorSnap.exists, countedTotal: !allTimeVisitorSnap.exists };
    });
  }
);

exports.getVisitorAnalytics = onCall(
  { region: "asia-northeast3", invoker: "public" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in is required to view visitor analytics.");

    const requestedDays = Math.floor(Number(request.data?.days || 30));
    const days = Number.isFinite(requestedDays) ? Math.max(7, Math.min(VISITOR_ANALYTICS_MAX_DAYS, requestedDays)) : 30;
    const db = getFirestore();
    const summaryRef = db.doc("artifacts/" + APP_ID + "/private/analytics");
    const dailyRef = db.collection("artifacts/" + APP_ID + "/private/analytics/daily");
    const snapshots = await Promise.all([summaryRef.get(), dailyRef.orderBy("date", "desc").limit(days).get()]);
    const summary = snapshots[0].exists ? snapshots[0].data() || {} : {};
    const daily = snapshots[1].docs.map((entry) => {
      const data = entry.data() || {};
      return { date: String(data.date || entry.id), visitors: Math.max(0, Number(data.visitors || 0)) };
    }).sort((left, right) => left.date.localeCompare(right.date));
    const today = getKstDateKey();
    const todayEntry = daily.find((entry) => entry.date === today);

    return {
      totalVisitors: Math.max(0, Number(summary.totalVisitors || 0)),
      todayVisitors: todayEntry ? todayEntry.visitors : 0,
      firstRecordedDate: String(summary.firstRecordedDate || ""),
      daily
    };
  }
);
exports.submitOrderWithInventory = onCall(
  { region: "asia-northeast3", invoker: "public" },
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

exports.updateOrderWithInventory = onCall(
  { region: "asia-northeast3", invoker: "public" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "로그인 연결 후 주문을 수정할 수 있습니다.");

    const orderId = String(request.data?.orderId || "").trim();
    const draftCart = request.data?.cart;
    const details = request.data?.details;
    if (!/^ORD-\d{6}-\d{4}$/.test(orderId)) throw new HttpsError("invalid-argument", "주문번호 형식이 올바르지 않습니다.");
    if (!Array.isArray(draftCart) || draftCart.length === 0 || draftCart.length > 100) throw new HttpsError("invalid-argument", "최소 한 개 이상의 주문 품목이 필요합니다.");
    if (!details || typeof details !== "object") throw new HttpsError("invalid-argument", "수정할 주문 정보가 없습니다.");

    const normalizedDetails = {
      ordererName: normalizeEditableText(details.ordererName, "주문자 이름", true),
      ordererPhone: normalizeEditableText(details.ordererPhone, "주문자 연락처", true),
      ordererNickname: normalizeEditableText(details.ordererNickname, "카페 닉네임", true),
      ordererCarInfo: normalizeEditableText(details.ordererCarInfo, "차량 정보", true),
      shipName: normalizeEditableText(details.shipName, "수령인 이름", true),
      shipPhone: normalizeEditableText(details.shipPhone, "수령인 연락처", true),
      postalCode: normalizeEditableText(details.postalCode, "우편번호", true),
      addressBasic: normalizeEditableText(details.addressBasic, "기본 주소", true),
      addressDetail: normalizeEditableText(details.addressDetail, "상세 주소", true),
      shippingMemo: normalizeEditableText(details.shippingMemo, "배송 메모") || "없음",
      depositorName: normalizeEditableText(details.depositorName, "입금자 이름", true),
      isIslandShipping: Boolean(details.isIslandShipping)
    };
    if (normalizePhoneDigits(normalizedDetails.ordererPhone).length < 7 || normalizePhoneDigits(normalizedDetails.shipPhone).length < 7) throw new HttpsError("invalid-argument", "연락처를 다시 확인해 주세요.");

    const db = getFirestore();
    const catalogRef = db.doc("artifacts/" + APP_ID + "/public/data/config/catalog");
    const orderRef = db.doc("artifacts/" + APP_ID + "/public/data/orders/" + orderId);

    return db.runTransaction(async (transaction) => {
      const snapshots = await Promise.all([transaction.get(catalogRef), transaction.get(orderRef)]);
      const catalogSnap = snapshots[0];
      const orderSnap = snapshots[1];
      if (!catalogSnap.exists || !orderSnap.exists) throw new HttpsError("not-found", "주문 또는 상품 정보를 찾을 수 없습니다.");

      const catalogProducts = Array.isArray(catalogSnap.data()?.products) ? catalogSnap.data().products : [];
      const storedOrder = orderSnap.data() || {};
      const originalCart = Array.isArray(storedOrder.cart) ? storedOrder.cart : [];
      const usedSourceIndexes = new Set();
      const nextCart = [];

      for (const draftItem of draftCart) {
        const productId = String(draftItem?.productId || "").trim();
        const quantity = Number(draftItem?.quantity);
        const sourceIndex = draftItem?.sourceIndex;
        if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PRODUCT_STOCK) throw new HttpsError("invalid-argument", "주문 품목 또는 수량이 올바르지 않습니다.");

        if (Number.isInteger(sourceIndex)) {
          const originalItem = originalCart[sourceIndex];
          if (!originalItem || usedSourceIndexes.has(sourceIndex) || String(originalItem.productId) !== productId) throw new HttpsError("failed-precondition", "기존 주문 품목이 변경되었습니다. 주문 목록을 다시 확인해 주세요.");
          usedSourceIndexes.add(sourceIndex);
          nextCart.push({ productId, optionName: String(originalItem.optionName || "품목"), unitPrice: Number(originalItem.unitPrice || 0), quantity });
          continue;
        }

        const product = catalogProducts.find((item) => item.id === productId);
        const optionValue = String(draftItem?.optionValue || "").trim();
        const options = Array.isArray(product?.options) && product.options.length > 0 ? product.options : ["기본형"];
        if (!product || isProductManuallySoldOut(product) || !options.includes(optionValue) || isOptionManuallySoldOut(optionValue)) throw new HttpsError("failed-precondition", "추가할 수 없는 품목 또는 옵션입니다.");
        nextCart.push({ productId, optionName: String(product.name) + " (" + normalizeOptionLabel(optionValue) + ")", unitPrice: Number(product.price || 0) + parseOptionExtraCost(optionValue), quantity });
      }

      const originalByProduct = new Map();
      const nextByProduct = new Map();
      originalCart.forEach((item) => originalByProduct.set(String(item?.productId || ""), (originalByProduct.get(String(item?.productId || "")) || 0) + Number(item?.quantity || 0)));
      nextCart.forEach((item) => nextByProduct.set(item.productId, (nextByProduct.get(item.productId) || 0) + item.quantity));
      const deltaByProduct = new Map();
      new Set([...originalByProduct.keys(), ...nextByProduct.keys()]).forEach((productId) => deltaByProduct.set(productId, (nextByProduct.get(productId) || 0) - (originalByProduct.get(productId) || 0)));

      for (const [productId, delta] of deltaByProduct) {
        if (delta <= 0) continue;
        const product = catalogProducts.find((item) => item.id === productId);
        const availableStock = product ? getProductStock(product) : 0;
        if (!product || isProductManuallySoldOut(product) || availableStock < delta) throw new HttpsError("failed-precondition", "재고가 부족하여 주문을 수정할 수 없습니다.", { reason: "insufficient-stock", productId, productName: product?.name || "판매 종료 상품", availableStock, requestedQuantity: delta });
      }

      const updatedProducts = catalogProducts.map((product) => {
        const delta = deltaByProduct.get(product.id) || 0;
        return delta === 0 ? product : { ...product, stock: Math.max(0, Math.min(MAX_PRODUCT_STOCK, getProductStock(product) - delta)) };
      });
      const productTotal = nextCart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
      const shippingFee = 4000 + (normalizedDetails.isIslandShipping ? 3000 : 0);
      const publicOrderUpdate = {
        ...normalizedDetails,
        cart: nextCart,
        productTotal,
        shippingFee,
        finalTotal: productTotal + shippingFee,
        ordererNameNormalized: normalizeLookupName(normalizedDetails.ordererName),
        ordererPhoneDigits: normalizePhoneDigits(normalizedDetails.ordererPhone),
        orderLookupKey: buildOrderLookupKey(normalizedDetails.ordererName, normalizedDetails.ordererPhone)
      };
      if (Array.from(deltaByProduct.values()).some((delta) => delta !== 0)) transaction.update(catalogRef, { products: updatedProducts });
      transaction.update(orderRef, { ...publicOrderUpdate, adminUpdatedAt: FieldValue.serverTimestamp(), adminUpdatedBy: request.auth.uid });
      return { orderId, order: publicOrderUpdate, remainingStock: Object.fromEntries(updatedProducts.filter((product) => deltaByProduct.has(product.id)).map((product) => [product.id, getProductStock(product)])) };
    });
  }
);

exports.optimizeProductThumbnails = onCall(
  {
    region: 'asia-northeast3',
    invoker: 'public',
    timeoutSeconds: 540,
    memory: '1GiB'
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in is required to optimize product thumbnails.');
    }

    const requestedProductIds = Array.isArray(request.data?.productIds)
      ? request.data.productIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const requestedProductIdSet = new Set(requestedProductIds);
    const force = request.data?.force !== false;

    const db = getFirestore();
    const catalogRef = db.doc('artifacts/' + APP_ID + '/public/data/config/catalog');
    const initialCatalogSnap = await catalogRef.get();
    const initialProducts = initialCatalogSnap.exists && Array.isArray(initialCatalogSnap.data().products)
      ? initialCatalogSnap.data().products
      : [];

    const targets = initialProducts.filter((product) => {
      if (!String(product?.img || '').trim()) return false;
      if (requestedProductIdSet.size > 0) return requestedProductIdSet.has(product.id);

      const hasCurrentThumbnail = Boolean(String(product.thumbnailUrl || '').trim()) &&
        Number(product.thumbnailOptimizationVersion || 0) >= THUMBNAIL_OPTIMIZATION_VERSION;
      return force || !hasCurrentThumbnail;
    });

    if (targets.length === 0) {
      return {
        requestedProductCount: 0,
        optimizedProductCount: 0,
        failedProductIds: [],
        optimizedBytes: 0
      };
    }

    const optimizedByProductId = new Map();
    const failedProductIds = [];

    for (const product of targets) {
      try {
        const sourceUrl = String(product.img).trim();
        const sourceBuffer = await downloadProductImageBuffer(sourceUrl);
        const thumbnail = await storeOptimizedProductImage(sourceBuffer, product.id, 0, {
          maxWidth: THUMBNAIL_IMAGE_MAX_WIDTH,
          maxHeight: THUMBNAIL_IMAGE_MAX_HEIGHT,
          quality: THUMBNAIL_IMAGE_QUALITY,
          suffix: 'listing_320'
        });

        optimizedByProductId.set(product.id, {
          sourceUrl,
          thumbnailUrl: thumbnail.url,
          bytes: thumbnail.bytes
        });
      } catch (error) {
        logger.warn('Product thumbnail optimization failed.', {
          productId: product.id,
          error: error?.message || String(error)
        });
        failedProductIds.push(product.id);
      }
    }

    if (optimizedByProductId.size === 0) {
      throw new HttpsError('internal', 'The server could not read or convert the selected product images.');
    }

    const optimizationResult = await db.runTransaction(async (transaction) => {
      const currentCatalogSnap = await transaction.get(catalogRef);
      const currentProducts = currentCatalogSnap.exists && Array.isArray(currentCatalogSnap.data().products)
        ? currentCatalogSnap.data().products
        : [];

      let updatedProductCount = 0;
      const updatedProducts = currentProducts.map((product) => {
        const optimized = optimizedByProductId.get(product.id);
        if (!optimized || String(product.img || '').trim() !== optimized.sourceUrl) return product;

        updatedProductCount += 1;
        return {
          ...product,
          thumbnailUrl: optimized.thumbnailUrl,
          thumbnailOptimizationVersion: THUMBNAIL_OPTIMIZATION_VERSION,
          thumbnailOptimizedAt: new Date().toISOString()
        };
      });

      transaction.update(catalogRef, { products: updatedProducts });

      return {
        updatedProductCount,
        optimizedBytes: Array.from(optimizedByProductId.values())
          .reduce((total, thumbnail) => total + thumbnail.bytes, 0)
      };
    });

    logger.info('Product thumbnails optimized.', {
      requestedProductCount: targets.length,
      optimizedProductCount: optimizationResult.updatedProductCount,
      failedProductCount: failedProductIds.length,
      optimizedBytes: optimizationResult.optimizedBytes
    });

    return {
      requestedProductCount: targets.length,
      optimizedProductCount: optimizationResult.updatedProductCount,
      failedProductIds,
      optimizedBytes: optimizationResult.optimizedBytes
    };
  }
);

exports.optimizeProductDetailImages = onCall(
  { region: 'asia-northeast3', invoker: 'public' },
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
