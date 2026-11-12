import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { openImport } from '../assets/hanjin-import.mjs';

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
