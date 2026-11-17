export function hanjinRows(orders) {
    return [
        ['출고번호', '', '', '', '', '', '', '', '받으시는 분', '받으시는 분 전화', '받는분총주소', '특기사항', '메모'],
        ...orders.map(order => [
            String(order.orderId || ''), '', '', '', '', '', '', '',
            String(order.shipName || ''),
            String(order.shipPhone || ''),
            [order.postalCode ? '[' + order.postalCode + ']' : '', order.addressBasic, order.addressDetail].filter(Boolean).join(' '),
            (order.cart || []).map(item => String(item.optionName || '') + ' x' + Number(item.quantity || 0)).join(' | '),
            order.shippingMemo === '없음' ? '' : String(order.shippingMemo || '')
        ])
    ];
}

export async function markHanjinOrdersPreparing(transaction, refs, orders) {
    const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
    snapshots.forEach((snapshot, index) => {
        const current = snapshot.data();
        const original = orders[index];
        if (!snapshot.exists() || !['입금완료', '배송준비'].includes(current.status) ||
            current.trackingNumber || JSON.stringify(hanjinRows([{ ...current, orderId: original.orderId }])[1]) !== JSON.stringify(hanjinRows([original])[1])) {
            throw new Error('주문 정보가 변경되었습니다. 목록을 새로고침해 다시 선택해 주세요.');
        }
    });
    snapshots.forEach((snapshot, index) => {
        if (snapshot.data().status === '입금완료') transaction.update(refs[index], { status: '배송준비' });
    });
}

export async function createHanjinWorkbook(orders, ExcelJS) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    hanjinRows(orders).forEach((values, rowIndex) => {
        values.forEach((value, columnIndex) => {
            sheet.getCell(rowIndex + 1, columnIndex + 1).value = value;
        });
    });
    sheet.getColumn(1).width = 24;
    sheet.getColumn(9).width = 18;
    sheet.getColumn(10).width = 18;
    sheet.getColumn(11).width = 55;
    sheet.getColumn(12).width = 65;
    sheet.getColumn(13).width = 35;
    return workbook.xlsx.writeBuffer();
}

export async function prepareHanjinWorkbook(orders) {
    if (!window.ExcelJS) {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = new URL('exceljs.min.js', import.meta.url);
            script.onload = resolve;
            script.onerror = () => reject(new Error('엑셀 생성 도구를 불러오지 못했습니다.'));
            document.head.append(script);
        });
    }
    return createHanjinWorkbook(orders, window.ExcelJS);
}

export function downloadHanjinWorkbook(buffer) {
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = '한진_출고_' + new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) + '.xlsx';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
