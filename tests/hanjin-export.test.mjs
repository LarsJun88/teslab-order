import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHanjinWorkbook, markHanjinOrdersPreparing } from '../assets/hanjin-export.mjs';

const context = { setTimeout, clearTimeout, setImmediate, TextEncoder, TextDecoder, ArrayBuffer, Uint8Array };
context.window = context.self = context;
vm.runInNewContext(readFileSync(new URL('../assets/exceljs.min.js', import.meta.url), 'utf8'), context);

test('Hanjin workbook preserves column positions and text identifiers', async () => {
    const orders = [{ orderId: 'ORD-261117-00123', shipName: '수령인', shipPhone: '010-1234-5678',
        postalCode: '01234', addressBasic: '서울 주소', addressDetail: '101호', shippingMemo: '문 앞',
        cart: [{ optionName: '도어도크 (블랙)', quantity: 2 }, { optionName: '클립 (레드)', quantity: 1 }] }];
    const bytes = await createHanjinWorkbook(orders, context.ExcelJS);
    const workbook = new context.ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const sheet = workbook.getWorksheet('Sheet1');
    assert.equal(sheet.getCell('A1').value, '출고번호');
    assert.equal(sheet.getCell('I1').value, '받으시는 분');
    assert.equal(sheet.getCell('M1').value, '메모');
    assert.equal(sheet.getCell('A2').value, orders[0].orderId);
    assert.equal(sheet.getCell('J2').value, orders[0].shipPhone);
    assert.equal(sheet.getCell('K2').value, '[01234] 서울 주소 101호');
    assert.equal(sheet.getCell('L2').value, '도어도크 (블랙) x2 | 클립 (레드) x1');
    assert.equal(sheet.getCell('M2').value, '문 앞');
});

test('export changes only paid orders, and rejects changed orders before any writes', async () => {
    const orders = [
        { orderId: 'ORD-261117-00123', status: '입금완료', shipName: '가', cart: [] },
        { orderId: 'ORD-261117-00124', status: '배송준비', shipName: '나', cart: [] }
    ];
    const writes = [];
    const transaction = {
        async get(index) { return { exists: () => true, data: () => orders[index] }; },
        update(index, patch) { writes.push([index, patch.status]); }
    };
    await markHanjinOrdersPreparing(transaction, [0, 1], orders);
    assert.deepEqual(writes, [[0, '배송준비']]);
    writes.length = 0;
    const original = structuredClone(orders);
    orders[1].shipName = '수정됨';
    await assert.rejects(markHanjinOrdersPreparing(transaction, [0, 1], original), /주문 정보가 변경/);
    assert.equal(writes.length, 0);
});
