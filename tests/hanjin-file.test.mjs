import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { openImport, matchPickingRows } from '../assets/hanjin-import.mjs';

function reader(name) {
    const source = readFileSync(new URL('../assets/' + name + '.min.js', import.meta.url), 'utf8');
    const context = { setTimeout, clearTimeout, setImmediate, TextEncoder, TextDecoder, ArrayBuffer, Uint8Array };
    context.window = context.self = context;
    vm.runInNewContext(source, context);
    return context;
}
const { ExcelJS } = reader('exceljs');
const { Papa } = reader('papaparse');

test('XLSX and quoted CSV files preview and submit only matched rows', async () => {
    const id = 'ORD-261112-12345';
    const rows = [['주문번호', '운송장번호', '메모'], [id, '001234567890', '합포장, 요청'], ['없음', '123456789011', '']];
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('출고');
    rows.forEach((row, i) => row.forEach((value, j) => { sheet.getCell(i + 1, j + 1).value = value; }));
    const xlsx = await book.xlsx.writeBuffer();
    const files = [
        new File([xlsx], '출고.xlsx'),
        new File([Papa.unparse(rows)], '출고.csv')
    ];
    globalThis.window = { ExcelJS, Papa };
    globalThis.Option = class { constructor(text, value) { this.text = text; this.value = String(value); } };
    for (const file of files) {
        const elements = new Map();
        const el = key => {
            if (!elements.has(key)) elements.set(key, { classList: { add() {}, remove() {} },
                replaceChildren(first) { this.value = first.value; }, add() {} });
            return elements.get(key);
        };
        globalThis.document = { getElementById: el, createElement: () => ({}), head: { append: script => script.onload() } };
        const saved = [];
        await openImport(file, () => [{ orderId: id, status: '배송준비' }],
            async row => { saved.push(row); return { data: { changed: true } }; }, async () => true);
        assert.equal(el('hanjin-summary').textContent, '일치 1건 · 확인 필요 1건');
        await el('hanjin-apply').onclick();
        assert.deepEqual(saved, [{ orderId: id, trackingNumber: '001234567890' }]);
    }
});

test('masked Hanjin picking rows only match a unique recipient, postcode, address and items', () => {
    const columns = { waybill: 1, name: 2, zip: 6, address: 7, items: 10 };
    const row = ['1', '123456789012', '홍길*', '', '', '', '01234', '서울 강남로 10 *****', '', '', '도어도크 (블랙) x1 '];
    const order = { orderId: 'ORD-261117-12345', status: '배송준비', shipName: '홍길동',
        postalCode: '01234', addressBasic: '서울 강남로 10', addressDetail: '101호',
        cart: [{ optionName: '도어도크 (블랙)', quantity: 1 }] };
    const match = orders => matchPickingRows([[], row], 0, columns, orders);
    assert.equal(match([order])[0].orderId, order.orderId);
    assert.equal(match([order])[0].reason, '');
    assert.match(match([order, { ...order, orderId: 'ORD-261117-12346' }])[0].reason, /여러 건/);
    assert.match(match([{ ...order, cart: [{ optionName: '다른 상품', quantity: 1 }] }])[0].reason, /없음/);
    assert.match(match([{ ...order, status: '배송중' }])[0].reason, /없음/);
    assert.match(matchPickingRows([[], row, row], 0, columns, [order])[0].reason, /중복/);
});
