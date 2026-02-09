(() => {
    if (window.__AUTOCLIP_REVIEW_LOADED__) return;
    window.__AUTOCLIP_REVIEW_LOADED__ = true;

    let isRunning = false;
    let overlay = null;

    function removeOverlay() {
        if (overlay) {
            overlay.remove();
            overlay = null;
        }
    }

    // 설정 화면 표시
    function showSettingsDialog() {
        if (overlay) return;

        const productId = window.location.href.match(/\/products\/(\d+)/)?.[1];
        if (!productId) {
            alert('쿠팡 상품 페이지에서만 사용할 수 있습니다.');
            return;
        }

        overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5); z-index: 999999;
            display: flex; align-items: center; justify-content: center;
        `;

        const box = document.createElement('div');
        box.style.cssText = `
            background: white; border-radius: 12px; padding: 32px 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            min-width: 340px;
        `;
        box.innerHTML = `
            <div style="font-size: 18px; font-weight: 700; margin-bottom: 20px; color: #1e293b;">
                AutoClip 리뷰 추출
            </div>
            <div style="margin-bottom: 24px;">
                <label style="display: block; font-size: 13px; font-weight: 600; color: #475569; margin-bottom: 6px;">
                    최대 리뷰 수
                </label>
                <input id="autoclip-max-reviews" type="number" value="1000" min="10" max="5000" step="10"
                    style="width: 100%; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; outline: none; box-sizing: border-box;">
                <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">페이지당 10개씩 수집 (10~5000)</div>
            </div>
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button id="autoclip-review-cancel" style="padding: 8px 20px; border: 1px solid #cbd5e1; border-radius: 6px; background: white; color: #475569; font-size: 14px; cursor: pointer;">
                    취소
                </button>
                <button id="autoclip-review-start" style="padding: 8px 20px; border: none; border-radius: 6px; background: #3b82f6; color: white; font-size: 14px; font-weight: 600; cursor: pointer;">
                    추출 시작
                </button>
            </div>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        // 오버레이 배경 클릭 시 닫기 (드래그 방지)
        let mouseDownTarget = null;
        overlay.addEventListener('mousedown', (e) => { mouseDownTarget = e.target; });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && mouseDownTarget === overlay) removeOverlay();
            mouseDownTarget = null;
        });

        document.getElementById('autoclip-review-cancel').addEventListener('click', removeOverlay);
        document.getElementById('autoclip-review-start').addEventListener('click', () => {
            const maxReviews = Math.max(10, Math.min(5000, parseInt(document.getElementById('autoclip-max-reviews').value) || 1000));
            removeOverlay();
            startExtract(maxReviews);
        });
    }

    function showProgressOverlay() {
        overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5); z-index: 999999;
            display: flex; align-items: center; justify-content: center;
        `;
        const box = document.createElement('div');
        box.style.cssText = `
            background: white; border-radius: 12px; padding: 32px 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center; min-width: 300px;
        `;
        box.innerHTML = `
            <div style="font-size: 18px; font-weight: 700; margin-bottom: 16px; color: #1e293b;">
                리뷰 추출 중...
            </div>
            <div id="autoclip-review-progress" style="font-size: 14px; color: #64748b; margin-bottom: 12px;">
                준비 중...
            </div>
            <div style="width: 100%; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden;">
                <div id="autoclip-review-bar" style="width: 0%; height: 100%; background: #3b82f6; border-radius: 3px; transition: width 0.3s;"></div>
            </div>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }

    function updateProgress(text, percent) {
        const el = document.getElementById('autoclip-review-progress');
        const bar = document.getElementById('autoclip-review-bar');
        if (el) el.textContent = text;
        if (bar) bar.style.width = percent + '%';
    }

    // 메시지 수신
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'START_REVIEW_EXTRACT') {
            if (!isRunning) showSettingsDialog();
        }
    });

    async function startExtract(maxReviews) {
        const maxPages = Math.ceil(maxReviews / 10);
        if (isRunning) return;
        isRunning = true;

        const productId = window.location.href.match(/\/products\/(\d+)/)?.[1];
        if (!productId) {
            alert('쿠팡 상품 페이지에서만 사용할 수 있습니다.');
            isRunning = false;
            return;
        }

        showProgressOverlay();
        updateProgress('상품 정보 수집 중...', 0);

        // 상품명
        const fullTitle = document.querySelector('.prod-buy-header__title')?.innerText?.trim()
            || document.querySelector('.product-title')?.innerText?.trim()
            || '';
        const productName = fullTitle.replace(/,\s*[^,]+$/, '');

        // 판매유형 (data-badge-id 속성으로 판별)
        let deliveryType = '일반배송';
        const badgeImgs = document.querySelectorAll('.price-badge img[data-badge-id]');
        for (const img of badgeImgs) {
            const badgeId = img.getAttribute('data-badge-id');
            if (badgeId === 'ROCKET') { deliveryType = '로켓와우'; break; }
            if (badgeId === 'ROCKET_MERCHANT') { deliveryType = '판매자로켓'; break; }
        }
        // 착불배송 체크
        if (deliveryType === '일반배송') {
            const shippingText = document.querySelector('.shipping-fee-desc')?.textContent?.trim() || '';
            if (shippingText.includes('착불')) deliveryType = '착불배송';
            else if (shippingText.includes('무료')) deliveryType = '무료배송';
        }

        // 판매가
        const priceEl = document.querySelector('.total-price strong')
            || document.querySelector('.final-price-amount');
        const finalPrice = priceEl?.innerText?.trim().replace(/\n/g, ' ') || '';

        // 리뷰 수집
        const allReviews = [];

        for (let page = 1; page <= maxPages; page++) {
            updateProgress(`${page} 페이지 수집 중... (${allReviews.length}개)`, Math.min(95, Math.floor((page / maxPages) * 100)));

            try {
                const res = await fetch(
                    `https://www.coupang.com/next-api/review?productId=${productId}&page=${page}&size=10&sortBy=ORDER_SCORE_ASC&ratingSummary=true&ratings=&market=`
                );

                if (!res.ok) {
                    if (page === 1) {
                        updateProgress('리뷰 API 오류', 0);
                        setTimeout(() => { removeOverlay(); isRunning = false; }, 2000);
                        return;
                    }
                    break;
                }

                const json = await res.json();
                const contents = json?.rData?.paging?.contents || [];
                if (contents.length === 0) break;

                for (const item of contents) {
                    const content = item.content?.trim();
                    if (!content) continue;

                    let option = '';
                    const itemName = item.itemName || '';
                    const optMatch = itemName.match(/,\s*([^,]+(?:,\s*[^,]+)*)$/);
                    if (optMatch) option = optMatch[1];

                    allReviews.push({
                        option,
                        rating: item.rating || 0,
                        title: item.title?.trim() || '',
                        content
                    });

                    if (allReviews.length >= maxReviews) break;
                }

                if (allReviews.length >= maxReviews) break;
            } catch (e) {
                console.error(`[AutoClip] ${page}페이지 리뷰 오류:`, e);
            }
        }

        if (allReviews.length === 0) {
            updateProgress('리뷰가 없습니다.', 100);
            setTimeout(() => { removeOverlay(); isRunning = false; }, 2000);
            return;
        }

        updateProgress(`${allReviews.length}개 리뷰 CSV 생성 중...`, 98);

        // CSV 생성
        const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
        const csv = [
            `상품명:,${esc(productName)}`,
            `판매유형:,${esc(deliveryType)}`,
            `판매가:,${esc(finalPrice)}`,
            '',
            '옵션,별점수(최대5점),리뷰제목,리뷰내용',
            ...allReviews.map(r =>
                `${esc(r.option)},${esc(r.rating)},${esc(r.title)},${esc(r.content)}`
            )
        ].join('\n');

        // 다운로드
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${productName || productId}_리뷰.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        updateProgress(`완료! ${allReviews.length}개 리뷰 다운로드`, 100);
        setTimeout(() => { removeOverlay(); isRunning = false; }, 2000);
    }
})();
