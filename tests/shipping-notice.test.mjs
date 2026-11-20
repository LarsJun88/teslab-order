import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { getWeeklyShippingNotice, nextKoreaMidnight } from '../assets/shipping-notice.mjs';

test('weekly notice uses the same Friday and Monday through the weekend', () => {
    for (const date of ['2026-11-20T00:00:00+09:00', '2026-11-21T12:00:00+09:00', '2026-11-22T12:00:00+09:00', '2026-11-23T23:59:59+09:00']) {
        const notice = getWeeklyShippingNotice(new Date(date));
        assert.match(notice.message, /11월 20일\(금\)/);
        assert.match(notice.message, /11월 23일\(월\)/);
        assert.equal(notice.version, 'weekly-2026-11-20');
    }
});

test('weekly notice is hidden Tuesday through Thursday in Korea', () => {
    for (const date of ['2026-11-24T00:00:00+09:00', '2026-11-25T12:00:00+09:00', '2026-11-26T23:59:59+09:00']) {
        assert.equal(getWeeklyShippingNotice(new Date(date)), null);
    }
    assert.ok(getWeeklyShippingNotice(new Date('2026-11-26T15:00:00Z')));
});

test('weekly dates cross years and dismissal resets at Korea midnight', () => {
    const notice = getWeeklyShippingNotice(new Date('2027-01-01T10:00:00+09:00'));
    assert.match(notice.message, /1월 1일\(금\)/);
    assert.match(notice.message, /1월 4일\(월\)/);
    const crossing = getWeeklyShippingNotice(new Date('2028-12-31T12:00:00+09:00'));
    assert.match(crossing.message, /12월 29일\(금\)/);
    assert.match(crossing.message, /1월 1일\(월\)/);
    assert.equal(new Date(nextKoreaMidnight(new Date('2026-11-20T12:00:00Z'))).toISOString(), '2026-11-20T15:00:00.000Z');
});

test('storefront respects the weekly switch and prioritizes manual notices', () => {
    const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const source = html.slice(html.indexOf('    function normalizeShippingNoticeConfig('), html.indexOf('    function renderNoticeUI(', html.indexOf('    function normalizeShippingNoticeConfig(')));
    const nodes = new Map();
    const document = { getElementById(id) {
        if (!nodes.has(id)) {
            const classes = new Set();
            nodes.set(id, { textContent: '', checked: false, classList: {
                toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
                add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
                contains(name) { return classes.has(name); }
            } });
        }
        return nodes.get(id);
    } };
    const storage = new Map();
    const context = vm.createContext({ document, window: {}, Date,
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        getWeeklyShippingNotice: () => getWeeklyShippingNotice(new Date('2026-11-20T12:00:00+09:00')),
        nextKoreaMidnight, localShippingNotice: { enabled: false, weeklyEnabled: true } });
    vm.runInContext(source, context);
    vm.runInContext('renderShippingNoticePopup()', context);
    assert.equal(document.getElementById('shipping-notice-modal').classList.contains('flex'), true);
    assert.match(document.getElementById('shipping-notice-message').textContent, /11월 20일/);
    vm.runInContext('localShippingNotice.weeklyEnabled = false; renderShippingNoticePopup()', context);
    assert.equal(document.getElementById('shipping-notice-modal').classList.contains('hidden'), true);
    vm.runInContext("localShippingNotice = { enabled: true, weeklyEnabled: true, title: '휴가', message: '수동 공지', version: 'manual' }; renderShippingNoticePopup()", context);
    assert.equal(document.getElementById('shipping-notice-message').textContent, '수동 공지');
});
