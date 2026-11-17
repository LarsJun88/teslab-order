const loads = new Map();
function loadReader(name) {
    if (!loads.has(name)) {
        loads.set(name, new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = new URL(name + '.min.js', import.meta.url);
            script.onload = resolve;
            script.onerror = () => { loads.delete(name); reject(new Error('파일 읽기 도구 로드 실패')); };
            document.head.append(script);
        }));
    }
    return loads.get(name);
}

async function readSheets(file) {
    const bytes = await file.arrayBuffer();
    if (/\.xlsx$/i.test(file.name)) {
        await loadReader('exceljs');
        const book = new window.ExcelJS.Workbook();
        await book.xlsx.load(bytes);
        return book.worksheets.map(sheet => {
            const rows = [];
            sheet.eachRow((row, number) => {
                rows[number - 1] = row.values.slice(1).map((_, i) => row.getCell(i + 1).text.trim());
            });
            return { name: sheet.name, rows };
        });
    }
    if (!/\.(csv|tsv)$/i.test(file.name)) throw new Error('XLSX, CSV 또는 TSV 파일을 선택해 주세요.');
    await loadReader('papaparse');
    let csv;
    try { csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { csv = new TextDecoder('euc-kr').decode(bytes); }
    const parsed = window.Papa.parse(csv, { delimitersToGuess: [',', '\t', ';'] });
    if (parsed.errors.length) throw new Error('열 구분 또는 따옴표 형식을 확인해 주세요.');
    return [{ name: file.name, rows: parsed.data }];
}

export function matchRows(rows, header, idCol, numberCol, orders) {
    const index = new Map(orders.map(o => [o.orderId, o]));
    const used = new Map(orders.filter(o => o.trackingNumber).map(o => [String(o.trackingNumber).replace(/[\s-]/g, ''), o.orderId]));
    const entries = [];
    const ids = new Set(), numbers = new Set(), duplicates = new Set();
    rows.forEach((row, i) => {
        if (i <= header || !row.some(cell => String(cell ?? '').trim())) return;
        const orderId = String(row[idCol] ?? '').trim();
        const trackingNumber = String(row[numberCol] ?? '').replace(/[\s-]/g, '');
        entries.push({ line: i + 1, orderId, trackingNumber });
        if (ids.has(orderId)) duplicates.add('id:' + orderId);
        if (numbers.has(trackingNumber)) duplicates.add('num:' + trackingNumber);
        ids.add(orderId);
        numbers.add(trackingNumber);
    });
    return entries.map(entry => {
        const { orderId, trackingNumber } = entry;
        const order = index.get(orderId);
        let reason = '';
        if (!order) reason = '주문번호 불일치';
        else if (!/^\d{10,14}$/.test(trackingNumber)) reason = '송장번호 형식 확인';
        else if (duplicates.has('id:' + orderId) || duplicates.has('num:' + trackingNumber)) reason = '파일 내 중복';
        else if (used.has(trackingNumber) && used.get(trackingNumber) !== orderId) reason = '다른 주문에 등록된 송장';
        else if (order.trackingNumber) reason = '기존 송장 있음';
        else if (!['입금완료', '배송준비'].includes(order.status)) reason = '주문 상태 확인';
        return { ...entry, reason };
    });
}

function normalizeText(value) {
    return String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function matchesMasked(value, pattern) {
    const text = normalizeText(value);
    const pieces = normalizeText(pattern).split(/\*+/);
    if (!pieces.join('') || pieces[0].length < 2) return false;
    const escaped = pieces.map(piece => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp('^' + escaped + '$').test(text);
}

export function matchPickingRows(rows, header, columns, orders) {
    const entries = [];
    const waybills = new Map();
    rows.forEach((row, index) => {
        if (index <= header || !row || !row.some(cell => String(cell ?? '').trim())) return;
        const trackingNumber = String(row[columns.waybill] ?? '').replace(/[\s-]/g, '');
        const name = String(row[columns.name] ?? '').trim();
        const zip = String(row[columns.zip] ?? '').trim();
        const address = String(row[columns.address] ?? '').trim();
        const items = normalizeText(row[columns.items]);
        const candidates = orders.filter(order => {
            const orderItems = normalizeText((order.cart || []).map(item => String(item.optionName || '') + ' x' + Number(item.quantity || 0)).join(' | '));
            const fullAddress = [order.addressBasic, order.addressDetail].filter(Boolean).join(' ');
            return ['입금완료', '배송준비'].includes(order.status) && !order.trackingNumber &&
                /^\d{5}$/.test(zip) && String(order.postalCode || '') === zip &&
                matchesMasked(order.shipName, name) && matchesMasked(fullAddress, address) &&
                items && orderItems === items;
        });
        const candidate = candidates.length === 1 ? candidates[0] : null;
        entries.push({ line: index + 1, trackingNumber, orderId: candidate?.orderId || '',
            expected: candidate ? { shipName: candidate.shipName || '', postalCode: candidate.postalCode || '',
                addressBasic: candidate.addressBasic || '', addressDetail: candidate.addressDetail || '',
                cart: (candidate.cart || []).map(item => ({ optionName: item.optionName || '', quantity: Number(item.quantity || 0) })) } : null,
            reason: !/^\d{10,14}$/.test(trackingNumber) ? '송장번호 형식 확인' :
                candidates.length === 0 ? '일치하는 주문 없음' : candidates.length > 1 ? '일치하는 주문 여러 건' : '' });
        waybills.set(trackingNumber, (waybills.get(trackingNumber) || 0) + 1);
    });
    const orderCounts = new Map();
    entries.forEach(entry => { if (entry.orderId) orderCounts.set(entry.orderId, (orderCounts.get(entry.orderId) || 0) + 1); });
    const used = new Set(orders.map(order => String(order.trackingNumber || '').replace(/[\s-]/g, '')).filter(Boolean));
    return entries.map(entry => ({ ...entry, reason: entry.reason ||
        (waybills.get(entry.trackingNumber) > 1 || orderCounts.get(entry.orderId) > 1 ? '파일 내 중복' :
            used.has(entry.trackingNumber) ? '이미 등록된 송장' : '') }));
}

export async function openImport(file, getOrders, save, refresh) {
    const el = id => document.getElementById('hanjin-' + id);
    const fields = el('fields'), columns = el('columns'), sheet = el('sheet'), header = el('header');
    const order = el('order'), number = el('waybill'), apply = el('apply'), summary = el('summary'), preview = el('preview');
    fields.disabled = true;
    apply.disabled = true;
    columns.classList.add('hidden');
    summary.textContent = '읽는 중…';
    preview.textContent = '';
    try {
        const sheets = await readSheets(file);
        if (!sheets.length) throw new Error('시트가 없습니다.');
        sheet.replaceChildren(...sheets.map((s, i) => new Option(s.name, i)));
        header.value = 1;
        let entries = [];
        let pickingColumns = null;
        function render() {
            entries = pickingColumns ? matchPickingRows(sheets[sheet.value].rows, Number(header.value) - 1, pickingColumns, getOrders()) :
                order.value && number.value && order.value !== number.value
                ? matchRows(sheets[sheet.value].rows, Number(header.value) - 1, order.value, number.value, getOrders()) : [];
            const count = entries.filter(row => !row.reason).length;
            summary.textContent = (pickingColumns ? '피킹리스트 자동 대조 · ' : '') +
                '일치 ' + count + '건 · 확인 필요 ' + (entries.length - count) + '건';
            preview.textContent = entries.map(row => [row.line + '행', row.orderId, row.expected?.shipName || '', row.trackingNumber, row.reason || '배송중 적용 예정'].filter(Boolean).join('  ')).join('\n');
            apply.disabled = count === 0;
        }
        function selectColumns() {
            const names = sheets[sheet.value].rows[Number(header.value) - 1] || [];
            const find = label => names.findIndex(name => String(name || '').replace(/\s/g, '') === label);
            const columnsFound = { waybill: find('운송장번호'), name: find('받는분'), zip: find('받는분우편번호'),
                address: find('받는분주소'), items: find('품목명') };
            pickingColumns = Object.values(columnsFound).every(index => index >= 0) ? columnsFound : null;
            for (const [select, pattern] of [[order, /주문번호|고객주문번호/], [number, /송장번호|운송장번호/]]) {
                select.replaceChildren(new Option('열 선택', ''));
                Array.from(names).forEach((name, i) => select.add(new Option(name || (i + 1) + '열', i)));
                const found = names.findIndex(name => pattern.test(String(name).replace(/\s/g, '')));
                if (found >= 0) select.value = String(found);
            }
            order.disabled = Boolean(pickingColumns);
            number.disabled = Boolean(pickingColumns);
            render();
        }
        sheet.onchange = header.onchange = selectColumns;
        order.onchange = number.onchange = render;
        selectColumns();
        columns.classList.remove('hidden');
        apply.onclick = async () => {
            fields.disabled = true;
            apply.disabled = true;
            const failures = [];
            let changed = 0, skipped = 0;
            try {
                const reviewed = entries.filter(row => !row.reason);
                if (!await refresh()) throw new Error('최신 주문을 불러오지 못했습니다. 다시 시도해 주세요.');
                render();
                const ready = reviewed.filter(previous => {
                    const current = entries.find(row => row.line === previous.line);
                    const unchanged = current && !current.reason && current.orderId === previous.orderId &&
                        current.trackingNumber === previous.trackingNumber &&
                        JSON.stringify(current.expected) === JSON.stringify(previous.expected);
                    if (!unchanged) failures.push(previous.line + '행 주문 정보가 변경되어 다시 확인 필요');
                    return unchanged;
                });
                for (const row of ready) {
                    try {
                        const { data } = await save({ orderId: row.orderId, trackingNumber: row.trackingNumber, ...(row.expected ? { expected: row.expected } : {}) });
                        if (data.changed) changed++; else skipped++;
                    } catch (err) { failures.push(row.line + '행 ' + row.orderId + ' ' + err.message); }
                }
                const refreshed = await refresh();
                summary.textContent = '저장 ' + changed + '건 · 이미 등록 ' + skipped + '건 · 실패 ' + failures.length + '건'
                    + (refreshed ? '' : ' · 주문 목록 새로고침 필요');
                preview.textContent = failures.concat(entries.filter(r => r.reason).map(r => r.line + '행 ' + r.reason)).join('\n');
            } catch (err) {
                summary.textContent = err.message || '송장 적용 실패';
            } finally { fields.disabled = false; apply.disabled = true; el('file').value = ''; }
        };
    } catch (err) { summary.textContent = err.message; el('file').value = ''; }
    finally { fields.disabled = false; }
}
