const KOREA_OFFSET = 9 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

export function getWeeklyShippingNotice(now = new Date()) {
    const korea = new Date(now.getTime() + KOREA_OFFSET);
    const day = korea.getUTCDay();
    if (![5, 6, 0, 1].includes(day)) return null;

    const midnight = Date.UTC(korea.getUTCFullYear(), korea.getUTCMonth(), korea.getUTCDate());
    const friday = new Date(midnight - (day === 0 ? 2 : day === 1 ? 3 : day - 5) * DAY);
    const monday = new Date(friday.getTime() + 3 * DAY);
    const format = date => `${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일`;

    return {
        title: '배송 일정 안내',
        message: `토요일은 택배 수거를 하지 않으므로\n\n${format(friday)}(금) 주문건은 당일 접수가 불가합니다.\n\n해당 기간 주문건은 ${format(monday)}(월)부터 순차발송됩니다.\n\n참고바랍니다.\n\n감사합니다.`,
        version: `weekly-${friday.toISOString().slice(0, 10)}`
    };
}

export function nextKoreaMidnight(now = new Date()) {
    const korea = new Date(now.getTime() + KOREA_OFFSET);
    return Date.UTC(korea.getUTCFullYear(), korea.getUTCMonth(), korea.getUTCDate() + 1) - KOREA_OFFSET;
}
