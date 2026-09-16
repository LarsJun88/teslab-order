const PENDING_KEY = 'teslab_pending_order_v2';
const ORDER_ID_PATTERN = /^ORD-\d{6}-[a-f0-9]{32}$/;

export function createOrderId(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const suffix = globalThis.crypto.randomUUID().replace(/-/g, '');
    return `ORD-${values.year}${values.month}${values.day}-${suffix}`;
}

export function createOrderSubmitter(send, storageProvider = () => globalThis.sessionStorage) {
    let pending = null;

    function readPending() {
        if (pending) return pending;
        try {
            const saved = JSON.parse(storageProvider()?.getItem(PENDING_KEY) || 'null');
            if (ORDER_ID_PATTERN.test(saved?.orderId) && /^[a-f0-9]{64}$/.test(saved?.key)) pending = saved;
        } catch (_) {}
        return pending;
    }

    function remember(value) {
        pending = value;
        try {
            if (value) storageProvider()?.setItem(PENDING_KEY, JSON.stringify(value));
            else storageProvider()?.removeItem(PENDING_KEY);
        } catch (_) {}
    }

    return {
        clear() { remember(null); },
        async submit(payload) {
            const { orderId: ignoredId, timestamp, createdAt, ...content } = payload;
            const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(content)));
            const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            if (readPending()?.key !== key) remember({ key, orderId: createOrderId() });

            // Keep the same ID after an uncertain response, including across page reloads.
            for (let attempt = 0; attempt < 3; attempt++) {
                const orderId = pending.orderId;
                try {
                    const result = await send({ ...payload, orderId });
                    const receipt = result?.data?.receipt;
                    if (result?.data?.orderId !== orderId || receipt?.orderId !== orderId ||
                        !Array.isArray(receipt.cart) || !Number.isFinite(receipt.finalTotal)) {
                        throw new Error('Order storage confirmation is missing.');
                    }
                    return receipt;
                } catch (error) {
                    const code = String(error?.code || '').replace(/^functions\//, '');
                    if (code === 'already-exists') {
                        remember({ key, orderId: createOrderId() });
                        if (attempt < 2) continue;
                    }
                    // These errors confirm that the server did not accept this submission.
                    if (['invalid-argument', 'failed-precondition', 'unauthenticated', 'permission-denied'].includes(code)) {
                        remember(null);
                    }
                    throw error;
                }
            }
        }
    };
}
