import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderId, createOrderSubmitter } from '../assets/order-submission.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { log() {}, warn() {}, error() {}, info() {} };
const catalogPath = 'artifacts/tkc-co-order-2026/public/data/config/catalog';
const orderPath = 'artifacts/tkc-co-order-2026/public/data/orders/';
const fixtureProducts = () => Array.from({ length: 4 }, (_, i) => ({
    id: 'test-product-' + i, name: 'Test Product ' + i, price: 12000, stock: 999,
    options: ['Black', 'Red'], optionStocks: { Black: 999, Red: 999 }
}));
const fixtureOrder = (i = 0, orderId = createOrderId()) => ({
    orderId, timestamp: new Date(Date.UTC(2026, 8, 6, 0, 0, i)).toISOString(), createdAt: '2026-09-06',
    ordererName: 'Test Buyer ' + i, ordererPhone: '010' + String(i).padStart(8, '0'),
    ordererNickname: 'test-nick-' + i, ordererCarInfo: 'Test Car',
    shipName: 'Test Receiver', shipPhone: '01000000000', postalCode: '00000',
    addressBasic: 'Synthetic Address', addressDetail: 'Test', shippingMemo: 'Synthetic memo',
    depositorName: 'Test Depositor', isIslandShipping: false, status: '입금대기',
    courier: '한진택배', trackingNumber: '', finalTotal: 16000,
    cart: [{ productId: 'test-product-' + i % 4, optionValue: 'Black', optionName: 'Test Product ' + i % 4 + ' (Black)', quantity: 1, unitPrice: 12000 }]
});
const memoryStorage = () => {
    const entries = new Map();
    return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
};

// SDK substitutes cannot access production. Transactions are serialized and commit atomically.
function backendHarness() {
    const records = new Map([[catalogPath, { products: fixtureProducts() }]]);
    let queue = Promise.resolve();
    const db = { doc: name => name, failCommit: false, runTransaction(callback) {
        const execution = queue.then(async () => {
            const pending = [];
            const result = await callback({
                async get(name) { return name?.get ? name.get() : { exists: records.has(name), data: () => structuredClone(records.get(name)) }; },
                update(name, value) { pending.push([name, { ...records.get(name), ...structuredClone(value) }]); },
                set(name, value) { pending.push([name, structuredClone(value)]); }
            });
            if (db.failCommit) throw Error('Simulated commit failure');
            for (const [name, value] of pending) records.set(name, value);
            return result;
        });
        queue = execution.catch(() => {});
        return execution;
    } };
    db.collection = base => ({
        doc: id => base + '/' + id,
        where: (field, op, value) => {
            const query = { limit: () => query, async get() {
                const docs = [...records].filter(([path, order]) => path.startsWith(base + '/') && order[field] === value)
                    .map(([path, order]) => ({ id: path.split('/').pop(), data: () => order }));
                return { docs, empty: docs.length === 0 };
            } };
            return query;
        }
    });
    class HttpsError extends Error {
        constructor(code, message, details) { super(message); this.code = code; this.details = details; }
    }
    const modules = {
        'firebase-functions/v2/firestore': { onDocumentCreated: (_, fn) => fn },
        'firebase-functions/v2/https': { onCall: (_, fn) => fn, HttpsError },
        'firebase-functions/params': { defineSecret: () => ({ value() { throw Error('No real secrets'); } }) },
        'firebase-functions/logger': quiet,
        'firebase-admin/app': { initializeApp() {} },
        'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'test-server-time' } },
        'firebase-admin/storage': {}, sharp: {}, crypto
    };
    const context = vm.createContext({ exports: {}, console: quiet, require(name) {
        assert.ok(Object.hasOwn(modules, name), 'Unexpected dependency: ' + name);
        return modules[name];
    } });
    vm.runInContext(fs.readFileSync(path.join(repo, 'functions/index.js'), 'utf8'), context);
    return { db, records, context, submit: (order, uid = 'test-user') => context.exports.submitOrderWithInventory({ auth: { uid }, data: { order } }) };
}

function pageHarness(file) {
    const elements = new Map();
    const timers = new Map();
    let nextTimerId = 0;
    const element = () => {
        const classes = new Set();
        return { innerHTML: '', textContent: '', value: '', checked: true, style: {}, dataset: {},
            classList: { add(...names) { names.forEach(n => classes.add(n)); }, remove(...names) { names.forEach(n => classes.delete(n)); }, contains(n) { return classes.has(n); }, toggle(n, force) { const on = force ?? !classes.has(n); on ? classes.add(n) : classes.delete(n); } },
            setAttribute() {}, removeAttribute() {}, appendChild() {}, removeChild() {}, click() {}, remove() {}, reset() {}, querySelectorAll() { return []; }
        };
    };
    const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
        createElement: element, querySelectorAll: () => [], addEventListener() {}, body: element(), documentElement: element()
    };
    const capture = { authFails: false, authCalls: 0, receipts: [], toasts: [], blobs: [], queryOrders: [], failRead: false, readCalls: 0, sends: [] };
    capture.send = async order => ({ data: { orderId: order.orderId, receipt: order } });
    const sandbox = {
        console: quiet, document, navigator: {},
        setTimeout(callback) { const id = ++nextTimerId; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
        TextEncoder, Blob, crypto: crypto.webcrypto,
        URL: { createObjectURL(blob) { capture.blobs.push(blob); return 'blob:synthetic'; } },
        createOrderSubmitter: send => createOrderSubmitter(send, () => storage),
        localStorage: memoryStorage(), sessionStorage: memoryStorage(), addEventListener() {},
        initializeApp: () => ({}), getAuth: () => ({}), getFirestore: () => ({}), getStorage: () => ({}), getFunctions: () => ({}),
        httpsCallable: (_, name) => async ({ order } = {}) => {
            if (name === 'lookupCustomerOrders') {
                if (capture.failRead) throw Error('Query failure');
                return { data: { orders: [] } };
            }
            if (name !== 'submitOrderWithInventory') return { data: {} };
            capture.sends.push(order); return capture.send(order);
        },
        async signInAnonymously() { capture.authCalls++; if (capture.authFails) throw Error('Auth failure'); return { user: { uid: 'test-user' } }; },
        collection: (_, ...parts) => ({ path: parts.join('/') }),
        query: (ref, ...filters) => ({ ...ref, filters }), where: (field, op, value) => ({ field, op, value }),
        async getDocsFromServer(ref) {
            capture.readCalls++;
            if (capture.failRead) throw Error('Query failure');
            const entries = capture.queryOrders.filter(o => (ref.filters || []).every(f => o[f.field] === f.value));
            return { forEach: fn => entries.forEach(data => fn({ id: data.orderId, data: () => data })) };
        },
        getDoc: async () => { throw Error('Unexpected document read'); }, onSnapshot: () => () => {}
    };
    const storage = memoryStorage();
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    const html = fs.readFileSync(path.join(repo, file), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import[\s\S]*?from\s+["'][^"']+["'];?/g, '');
    vm.runInContext(source, context, { filename: file });
    context.testCapture = capture;
    context.testProducts = fixtureProducts();
    const run = code => vm.runInContext(code, context);
    document.getElementById('admin-section-completed').classList.add('hidden');
    run('products = testProducts; initCatalogAndNotice = async () => {}; showToast = message => testCapture.toasts.push(message); renderSuccessReceipt = receipt => testCapture.receipts.push(receipt);');
    if (file.startsWith('admin/')) run('loadVisitorAnalytics = async () => {};');
    const order = fixtureOrder();
    const fields = { postal_code: 'postalCode', address_basic: 'addressBasic', orderer_name: 'ordererName', orderer_phone: 'ordererPhone', orderer_nickname: 'ordererNickname', orderer_car_info: 'ordererCarInfo', ship_name: 'shipName', ship_phone: 'shipPhone', address_detail: 'addressDetail', shipping_memo: 'shippingMemo', depositor_name: 'depositorName' };
    for (const [id, field] of Object.entries(fields)) document.getElementById(id).value = order[field];
    context.testCart = order.cart;
    run('cart = testCart;');
    return { context, capture, document, run,
        flushTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
        submit: () => context.handleFormSubmit({ preventDefault() {} }) };
}

test('1,500 unique five-digit IDs and sequential orders cross the 1,000 boundary', async () => {
    const app = backendHarness();
    const ids = new Set();
    for (let i = 0; i < 1500; i++) {
        const order = fixtureOrder(i, `ORD-260906-${String(i).padStart(5, '0')}`);
        assert.match(order.orderId, /^ORD-\d{6}-\d{5}$/);
        ids.add(order.orderId);
        const result = await app.submit(order);
        assert.equal(result.receipt.orderId, order.orderId);
        if ([999, 1000, 1001, 1500].includes(i + 1)) assert.equal(app.records.size - 1, i + 1);
    }
    assert.equal(ids.size, 1500);
    assert.equal(app.records.get(catalogPath).products.reduce((sum, p) => sum + p.optionStocks.Black, 0), 4 * 999 - 1500);
});

test('retry returns stored receipt without a second write, even after stock or prices change', async () => {
    const app = backendHarness();
    const order = fixtureOrder();
    const first = await app.submit(order);
    app.records.get(catalogPath).products[0].optionStocks.Black = 0;
    app.records.get(catalogPath).products[0].price = 99999;
    const before = JSON.stringify([...app.records]);
    const result = await app.submit({ ...order, timestamp: 'later' });
    assert.equal(result.receipt.finalTotal, first.receipt.finalTotal);
    assert.equal(JSON.stringify([...app.records]), before);
    await assert.rejects(app.submit(order, 'other-user'), e => e.code === 'already-exists');
    await assert.rejects(app.submit({ ...order, ordererName: 'Changed' }), e => e.code === 'already-exists');
});

test('five-digit IDs do not reuse a legacy four-digit number and keep retry receipts', async () => {
    const app = backendHarness();
    const legacy = fixtureOrder(1, 'ORD-260906-1234');
    await app.submit(legacy);
    await assert.rejects(app.submit(fixtureOrder(2, 'ORD-260906-01234')), error => error.code === 'already-exists');

    const fiveDigit = fixtureOrder(3, 'ORD-260906-54321');
    const first = await app.submit(fiveDigit);
    const retry = await app.submit({ ...fiveDigit, timestamp: 'retry' });
    assert.equal(retry.orderId, first.orderId);
    assert.equal(app.records.size - 1, 2);
});

test('admin-only cancellation restores the exact option once and excludes shipped orders', async () => {
    const app = backendHarness();
    const order = fixtureOrder();
    await app.submit(order);
    const cancel = (admin, orderId = order.orderId) => app.context.exports.cancelOrderWithInventory({
        auth: { uid: 'staff', token: { admin } }, data: { orderId, reason: '중복 접수' }
    });
    await assert.rejects(cancel(false), e => e.code === 'permission-denied');
    const shipped = fixtureOrder(1);
    await app.submit(shipped);
    app.records.get(orderPath + shipped.orderId).status = '배송중';
    await assert.rejects(cancel(true, shipped.orderId), e => e.code === 'failed-precondition');
    await Promise.all([cancel(true), cancel(true)]);
    const product = app.records.get(catalogPath).products[0];
    assert.equal(product.optionStocks.Black, 999);
    assert.equal(product.optionStocks.Red, 999);
    assert.equal(app.records.get(orderPath + order.orderId).status, '주문취소');
    await assert.rejects(app.context.exports.updateOrderWithInventory({ auth: { uid: 'buyer' }, data: {} }), e => e.code === 'permission-denied');
});

test('Hanjin preview rejects duplicate, unmatched, shipped and conflicting rows', async () => {
    const { matchRows } = await import('../assets/hanjin-import.mjs');
    const ids = Array.from({ length: 6 }, (_, i) => 'ORD-261112-0000' + i);
    const orders = ids.slice(0, 5).map(orderId => ({ orderId, status: '입금완료' }));
    orders[3].status = '주문취소';
    orders[4].trackingNumber = '123456789099';
    const rows = [['ID','번호'], ...ids.map((id, i) => [id, '12345678900' + (i === 2 ? 1 : i)])];
    const result = matchRows(rows, 0, 0, 1, orders);
    assert.deepEqual(result.filter(r => !r.reason).map(r => r.orderId), [ids[0]]);
});

test('customer lookup matches both fields and omits private order fields', async () => {
    const app = backendHarness();
    const order = fixtureOrder();
    await app.submit(order);
    const lookup = name => app.context.exports.lookupCustomerOrders({ auth: { uid: 'buyer' }, data: { name, phone: order.ordererPhone } });
    assert.equal((await lookup('Other')).orders.length, 0);
    const result = (await lookup(order.ordererName)).orders;
    assert.equal(result.length, 1);
    assert.equal(result[0].orderId, order.orderId);
    assert.equal(result[0].depositorName, undefined);
    assert.equal(result[0].inventoryCommittedBy, undefined);
});

test('waybill commit rechecks status and conflicts and handles retries', async () => {
    const app = backendHarness();
    const a = fixtureOrder(0), b = fixtureOrder(1);
    await app.submit(a);
    await app.submit(b);
    const save = (orderId, admin = true) => app.context.exports.importHanjinWaybill({
        auth: { uid: 'staff', token: { admin } }, data: { orderId, trackingNumber: '123456789012' }
    });
    await assert.rejects(save(a.orderId, false), e => e.code === 'permission-denied');
    await assert.rejects(save(a.orderId), e => e.code === 'failed-precondition');
    for (const id of [a.orderId, b.orderId]) app.records.get(orderPath + id).status = '입금완료';
    await assert.rejects(app.context.exports.importHanjinWaybill({
        auth: { uid: 'staff', token: { admin: true } },
        data: { orderId: a.orderId, trackingNumber: '123456789012', expected: { shipName: '다른 수령인' } }
    }), e => e.code === 'failed-precondition');
    assert.equal(app.records.get(orderPath + a.orderId).trackingNumber, '');
    assert.equal((await save(a.orderId)).changed, true);
    assert.equal(app.records.get(orderPath + a.orderId).status, '배송중');
    assert.equal((await save(a.orderId)).changed, false);
    await assert.rejects(save(b.orderId), e => e.code === 'already-exists');
});

test('legacy IDs stay valid and modern IDs remain editable', async () => {
    const app = backendHarness();
    for (const orderId of ['ORD-260906-1234', createOrderId()]) {
        const order = { ...fixtureOrder(), orderId };
        await app.submit(order);
        const details = { ...order, shippingMemo: 'Updated memo' };
        const result = await app.context.exports.updateOrderWithInventory({ auth: { uid: 'staff', token: { admin: true } }, data: { orderId, details, cart: [{ productId: order.cart[0].productId, quantity: 1, sourceIndex: 0 }] } });
        assert.equal(result.order.shippingMemo, 'Updated memo');
    }
});

test('failed transaction commits neither order nor stock; simultaneous requests cannot oversell', async () => {
    const app = backendHarness();
    const order = fixtureOrder();
    app.db.failCommit = true;
    await assert.rejects(app.submit(order));
    assert.equal(app.records.size, 1);
    assert.equal(app.records.get(catalogPath).products[0].optionStocks.Black, 999);
    app.db.failCommit = false;
    app.records.get(catalogPath).products[0].optionStocks.Black = 2;
    const outcomes = await Promise.allSettled(Array.from({ length: 3 }, () => app.submit(fixtureOrder())));
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 2);
    assert.equal(app.records.size - 1, 2);
    assert.equal(app.records.get(catalogPath).products[0].optionStocks.Black, 0);
});

test('client retries ID collision automatically and preserves pending ID across lost response/reload', async () => {
    const storage = memoryStorage();
    const app = backendHarness();
    const seen = [];
    let collision = true;
    let loseResponse = true;
    const send = async order => {
        seen.push(order.orderId);
        if (collision) { collision = false; throw Object.assign(Error('collision'), { code: 'functions/already-exists' }); }
        const result = await app.submit(order);
        if (loseResponse) { loseResponse = false; throw Object.assign(Error('offline'), { code: 'functions/unavailable' }); }
        return { data: result };
    };
    const payload = fixtureOrder();
    await assert.rejects(createOrderSubmitter(send, () => storage).submit(payload));
    const result = await createOrderSubmitter(send, () => storage).submit({ ...payload, timestamp: 'retry time' });
    assert.notEqual(seen[0], seen[1]);
    assert.equal(seen[1], seen[2]);
    assert.equal(result.orderId, seen[2]);
    assert.equal(app.records.size - 1, 1);
});

for (const file of ['index.html', 'admin/index.html']) {
    test(file + ': failed auth cannot show success; reconnect works', async () => {
        const page = pageHarness(file);
        page.capture.authFails = true;
        await page.submit();
        assert.equal(page.capture.receipts.length, 0);
        assert.equal(page.capture.sends.length, 0);
        assert.equal(page.run('localOrders.length'), 0);
        assert.equal(page.run('cart.length'), 1);
        assert.equal(page.run('isSubmittingOrder'), false);
        page.capture.authFails = false;
        await page.submit();
        assert.equal(page.capture.receipts.length, 1);
        assert.equal(page.capture.sends.length, 1);
    });
    test(file + ': server failure or unconfirmed response never shows success', async () => {
        const page = pageHarness(file);
        page.capture.send = async () => { throw Error('Commit failed'); };
        await page.submit();
        assert.equal(page.capture.receipts.length, 0);
        page.capture.send = async order => ({ data: { orderId: order.orderId } });
        await page.submit();
        assert.equal(page.capture.receipts.length, 0);
        assert.equal(page.capture.sends[0].orderId, page.capture.sends[1].orderId);
        assert.equal(page.run('cart.length'), 1);
    });
    test(file + ': lost acknowledgement retries stored order even with stale zero-stock catalog', async () => {
        const page = pageHarness(file);
        const app = backendHarness();
        let lose = true;
        page.capture.send = async order => {
            const result = await app.submit(order);
            if (lose) { lose = false; throw Error('Lost response'); }
            return { data: result };
        };
        await page.submit();
        page.run('products[0].optionStocks.Black = 0;');
        await page.submit();
        assert.equal(app.records.size - 1, 1);
        assert.equal(page.capture.receipts.length, 1);
    });
    test(file + ': failed lookup shows error and successful empty lookup shows no orders', async () => {
        const page = pageHarness(file);
        page.document.getElementById('track_name').value = 'Test Buyer';
        page.document.getElementById('track_phone').value = '01000000000';
        page.capture.failRead = true;
        await page.context.lookupOrder();
        assert.match(page.document.getElementById('track-result-container').innerHTML, /role="alert"/);
        page.capture.failRead = false;
        await page.context.lookupOrder();
        assert.doesNotMatch(page.document.getElementById('track-result-container').innerHTML, /role="alert"/);
    });
}

test('admin preserves 1,500 loaded orders, totals and filters after read failure; retry recovers', async () => {
    const page = pageHarness('admin/index.html');
    const statuses = ['입금대기', '입금완료', '배송준비', '배송중', '배송완료'];
    page.capture.queryOrders = Array.from({ length: 1500 }, (_, i) => ({ ...fixtureOrder(i), status: statuses[i % 5] }));
    assert.equal(await page.run('loadAdminOrders()'), true);
    assert.equal(page.run('globalOrders.length'), 1500);
    page.run("setAdminOrderStatusFilter('전체')");
    assert.equal((page.document.getElementById('admin-table-body').innerHTML.match(/<tr class=/g) || []).length, 1200);
    assert.equal((page.document.getElementById('completed-table-body').innerHTML.match(/<tr class=/g) || []).length, 0);
    page.run('isAdminAuthenticated = true; switchAdminSubTab("completed")');
    assert.equal((page.document.getElementById('completed-table-body').innerHTML.match(/<tr class=/g) || []).length, 50);
    assert.equal(page.capture.readCalls, 1);
    const previousRows = page.document.getElementById('admin-table-body').innerHTML;
    page.capture.failRead = true;
    assert.equal(await page.run('loadAdminOrders()'), false);
    assert.equal(page.run('globalOrders.length'), 1500);
    assert.equal(page.document.getElementById('admin-table-body').innerHTML, previousRows);
    assert.equal(page.document.getElementById('admin-orders-error').classList.contains('hidden'), false);
    await page.run('renderAdminStatistics()');
    assert.equal(page.document.getElementById('stats-summary-orders').textContent, '1,500건 주문');
    page.run('downloadExcelCSV()');
    assert.equal((await page.capture.blobs[0].text()).split('\n').length, 1501);
    page.capture.failRead = false;
    assert.equal(await page.run('loadAdminOrders()'), true);
    assert.equal(page.document.getElementById('admin-orders-error').classList.contains('hidden'), true);
});

test('admin first-load failure and failed statistics never render false zero counts', async () => {
    const page = pageHarness('admin/index.html');
    page.capture.failRead = true;
    assert.equal(await page.run('loadAdminOrders()'), false);
    assert.equal(page.run('hasLoadedAdminOrders'), false);
    assert.equal(page.document.getElementById('stat-total-orders').textContent, '-');
    const errorRows = page.document.getElementById('admin-table-body').innerHTML;
    page.run('filterAdminOrders()');
    assert.equal(page.document.getElementById('admin-table-body').innerHTML, errorRows);
    await page.run('renderAdminStatistics()');
    assert.equal(page.document.getElementById('stats-summary-orders').textContent, '-');
    page.capture.failRead = false;
    assert.equal(await page.run('loadAdminOrders()'), true);
    assert.equal(page.document.getElementById('stat-total-orders').textContent, '0건');
});

test('paid and preparation orders appear in their own tabs and counts', async () => {
    const page = pageHarness('admin/index.html');
    page.capture.queryOrders = [
        { ...fixtureOrder(0), status: '입금대기' },
        { ...fixtureOrder(1), status: '입금완료' },
        { ...fixtureOrder(2), status: '배송준비' },
        { ...fixtureOrder(3), status: '배송중' },
        { ...fixtureOrder(4), status: '주문취소' }
    ];
    await page.run('loadAdminOrders()');
    const counts = page.document.getElementById('order-status-counts').innerHTML;
    assert.match(counts, /입금완료<\/span><strong[^>]*>1건/);
    assert.match(counts, /배송준비<\/span><strong[^>]*>1건/);
    assert.match(counts, /주문취소<\/span><strong[^>]*>1건/);
    const body = page.document.getElementById('admin-table-body');
    assert.match(body.innerHTML, /입금완료<\/button>/);
    assert.doesNotMatch(body.innerHTML, /<select onchange="updateOrderStatus/);
    page.run("setAdminOrderStatusFilter('입금완료')");
    assert.match(body.innerHTML, /Test Buyer 1/);
    assert.doesNotMatch(body.innerHTML, /Test Buyer 2/);
    page.run("setAdminOrderStatusFilter('배송준비')");
    assert.doesNotMatch(body.innerHTML, /Test Buyer 1/);
    assert.match(body.innerHTML, /Test Buyer 2/);
    assert.doesNotMatch(body.innerHTML, /Test Buyer 0/);
    assert.doesNotMatch(body.innerHTML, /Test Buyer 3/);
});

test('select all toggles only visible eligible shipping orders', async () => {
    const page = pageHarness('admin/index.html');
    page.capture.queryOrders = [
        { ...fixtureOrder(0), status: '배송준비' },
        { ...fixtureOrder(1), status: '입금완료' },
        { ...fixtureOrder(2), status: '입금대기' }
    ];
    await page.run('loadAdminOrders()');
    page.run("setAdminOrderStatusFilter('전체'); selectVisibleHanjinOrders()");
    assert.equal(page.run('selectedHanjinOrders.size'), 2);
    assert.equal(page.document.getElementById('hanjin-select-all').textContent, '전체선택 해제');
    page.document.getElementById('admin-order-search').value = 'Buyer 0';
    page.run('filterAdminOrders(); selectVisibleHanjinOrders()');
    assert.equal(page.run('selectedHanjinOrders.size'), 1);
    page.document.getElementById('admin-order-search').value = '';
    page.run('filterAdminOrders(); selectVisibleHanjinOrders()');
    assert.equal(page.run('selectedHanjinOrders.size'), 2);
    page.run('selectVisibleHanjinOrders()');
    assert.equal(page.run('selectedHanjinOrders.size'), 0);
});

test('completed search debounces input, finds older orders and renders bounded batches', async () => {
    const page = pageHarness('admin/index.html');
    page.capture.queryOrders = Array.from({ length: 1500 }, (_, i) => ({
        ...fixtureOrder(i), status: '배송완료',
        ordererName: i === 25 ? 'Older Unique Buyer' : 'Regular Buyer'
    }));
    assert.equal(await page.run('loadAdminOrders()'), true);
    page.run('isAdminAuthenticated = true; switchAdminSubTab("completed")');
    const body = page.document.getElementById('completed-table-body');
    assert.equal((body.innerHTML.match(/<tr class=/g) || []).length, 50);
    assert.equal(page.document.getElementById('completed-order-result-count').textContent, '1,500건 중 50건 표시');
    assert.equal(page.capture.readCalls, 1);

    page.run('loadMoreCompletedOrders()');
    assert.equal((body.innerHTML.match(/<tr class=/g) || []).length, 100);
    const beforeSearch = body.innerHTML;
    page.document.getElementById('completed-order-search').value = 'not-found';
    page.run('filterCompletedOrders()');
    page.document.getElementById('completed-order-search').value = 'older unique';
    page.run('filterCompletedOrders()');
    assert.equal(body.innerHTML, beforeSearch);
    page.flushTimers();
    assert.match(body.innerHTML, /Older Unique Buyer/);
    assert.equal((body.innerHTML.match(/<tr class=/g) || []).length, 1);
    assert.equal(page.document.getElementById('completed-order-result-count').textContent, '1건 중 1건 표시');
    assert.equal(page.document.getElementById('completed-order-load-more').classList.contains('hidden'), true);

    page.document.getElementById('completed-order-search').value = 'regular';
    page.run('filterCompletedOrders()');
    page.flushTimers();
    assert.equal((body.innerHTML.match(/<tr class=/g) || []).length, 50);
    assert.equal(page.document.getElementById('completed-order-result-count').textContent, '1,499건 중 50건 표시');
    assert.equal(page.document.getElementById('completed-order-load-more').classList.contains('hidden'), false);
});

test('daily statistics use the selected calendar date in Korea time', () => {
    const page = pageHarness('admin/index.html');
    page.run(`globalOrders = [
        { ...testCapture.queryOrders[0], ...(${JSON.stringify(fixtureOrder(1))}), timestamp: '2026-09-06T14:30:00.000Z' },
        { ...testCapture.queryOrders[0], ...(${JSON.stringify(fixtureOrder(2))}), timestamp: '2026-09-07T01:00:00.000Z' }
    ]; activeStatsMode = 'day'; activeStatsPeriod = ''; renderStatsControls(globalOrders);`);
    assert.equal(page.document.getElementById('stats-day-input').value, '2026-09-07');
    assert.equal(page.run('getCurrentStatsLabel()'), '2026년 9월 7일');
    assert.equal(page.run('getOrdersForActiveStatsMode(globalOrders).length'), 1);
    page.document.getElementById('stats-day-input').value = '2026-09-06';
    page.run("changeStatsDay('2026-09-06')");
    assert.equal(page.run('getOrdersForActiveStatsMode(globalOrders).length'), 1);
});
