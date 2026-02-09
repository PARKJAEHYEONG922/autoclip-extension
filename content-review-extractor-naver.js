(() => {
    if (window.__AUTOCLIP_NAVER_REVIEW_LOADED__) return;
    window.__AUTOCLIP_NAVER_REVIEW_LOADED__ = true;

    let isRunning = false;
    let overlay = null;
    let cachedProductData = null; // 백그라운드에서 MAIN world로 추출한 데이터

    function removeOverlay() {
        if (overlay) {
            overlay.remove();
            overlay = null;
        }
    }

    // URL에서 productId 추출
    function getProductIdFromUrl() {
        const m = window.location.pathname.match(/\/products\/(\d+)/);
        return m ? Number(m[1]) : null;
    }

    // URL에서 스토어명 추출 후 API로 storeNo 조회 (폴백)
    async function fetchStoreNoFromAPI() {
        const pathMatch = window.location.pathname.match(/^\/([^/]+)\//);
        if (!pathMatch) return null;
        const shopName = pathMatch[1];
        const isBrand = /brand\.naver\.com/.test(location.host);
        const prefix = isBrand ? '/n' : '/i';

        const endpoints = [
            `${prefix}/v1/stores/${shopName}`,
            `${prefix}/v1/channels/${shopName}`,
            `${prefix}/v1/smart-stores/${shopName}`,
        ];

        for (const ep of endpoints) {
            try {
                const res = await fetch(ep, {
                    headers: { 'accept': 'application/json, text/plain, */*' }
                });
                if (!res.ok) continue;
                const data = await res.json();
                const str = JSON.stringify(data);
                for (const k of ['storeNo', 'checkoutMerchantNo', 'merchantNo', 'channelNo']) {
                    const m = str.match(new RegExp(`"${k}"\\s*:\\s*"?(\\d+)"?`));
                    if (m && Number(m[1]) > 0) {
                        console.log(`[AutoClip] storeNo found via API ${ep}:`, m[1]);
                        return Number(m[1]);
                    }
                }
            } catch (e) {
                console.log(`[AutoClip] API fallback ${ep} failed:`, e.message);
            }
        }
        return null;
    }

    // 설정 화면 표시
    function showSettingsDialog() {
        if (overlay) return;

        const isProductPage = /\/products\/\d+/.test(window.location.pathname);
        if (!isProductPage) {
            alert('스마트스토어 상품 페이지에서만 사용할 수 있습니다.');
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
                <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">페이지당 20개씩 수집 (10~5000)</div>
            </div>
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button id="autoclip-review-cancel" style="padding: 8px 20px; border: 1px solid #cbd5e1; border-radius: 6px; background: white; color: #475569; font-size: 14px; cursor: pointer;">
                    취소
                </button>
                <button id="autoclip-review-start" style="padding: 8px 20px; border: none; border-radius: 6px; background: #03c75a; color: white; font-size: 14px; font-weight: 600; cursor: pointer;">
                    추출 시작
                </button>
            </div>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

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
                <div id="autoclip-review-bar" style="width: 0%; height: 100%; background: #03c75a; border-radius: 3px; transition: width 0.3s;"></div>
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

    // 메시지 수신 - 백그라운드에서 MAIN world 추출 데이터 포함
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'START_REVIEW_EXTRACT') {
            if (message.productData) {
                cachedProductData = message.productData;
                console.log('[AutoClip] 백그라운드에서 상품 데이터 수신:', cachedProductData);
            }
            if (!isRunning) showSettingsDialog();
        }
    });

    async function startExtract(maxReviews) {
        const pageSize = 20;
        const maxPages = Math.ceil(maxReviews / pageSize);
        if (isRunning) return;
        isRunning = true;

        showProgressOverlay();
        updateProgress('상품 정보 수집 중...', 0);

        // 백그라운드에서 받은 MAIN world 데이터 사용
        let originProductNo = cachedProductData?.originProductNo || null;
        let checkoutMerchantNo = cachedProductData?.checkoutMerchantNo || null;
        let productName = cachedProductData?.productName || '';
        let salePrice = cachedProductData?.salePrice || '';

        // URL에서 productId 폴백
        if (!originProductNo) {
            originProductNo = getProductIdFromUrl();
        }

        // 상품명 폴백
        if (!productName) {
            productName = document.title.replace(/ : .*$/, '').trim() || '';
        }

        // checkoutMerchantNo 폴백: 스토어 API 조회
        if (!checkoutMerchantNo) {
            updateProgress('스토어 정보 조회 중...', 5);
            checkoutMerchantNo = await fetchStoreNoFromAPI();
            console.log('[AutoClip] API 폴백 결과 checkoutMerchantNo:', checkoutMerchantNo);
        }

        if (!originProductNo || !checkoutMerchantNo) {
            console.error('[AutoClip] 상품 정보 추출 실패:', {
                originProductNo, checkoutMerchantNo,
                debugKeys: cachedProductData?.debugKeys,
                debugProductKeys: cachedProductData?.debugProductKeys
            });
            updateProgress(
                `정보 부족 (product: ${originProductNo || 'X'}, merchant: ${checkoutMerchantNo || 'X'}) - F12 콘솔 확인`,
                0
            );
            setTimeout(() => { removeOverlay(); isRunning = false; }, 4000);
            return;
        }

        console.log('[AutoClip] 리뷰 추출 시작:', { originProductNo, checkoutMerchantNo, productName });

        // 배송 유형
        let deliveryType = '스마트스토어';
        const deliveryText = document.querySelector('[class*="delivery"]')?.textContent || '';
        if (deliveryText.includes('무료배송')) deliveryType = '무료배송';
        else if (deliveryText.includes('착불')) deliveryType = '착불배송';

        // 리뷰 수집
        const apiBase = location.origin;
        const isBrand = /brand\.naver\.com/.test(location.host);
        const apiPath = isBrand ? '/n/v1/contents/reviews/query-pages' : '/i/v1/contents/reviews/query-pages';
        const allReviews = [];

        for (let page = 1; page <= maxPages; page++) {
            updateProgress(`${page} 페이지 수집 중... (${allReviews.length}개)`, Math.min(95, Math.floor((page / maxPages) * 100)));

            try {
                const res = await fetch(`${apiBase}${apiPath}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'accept': 'application/json, text/plain, */*',
                        'x-client-version': '20260203185811',
                    },
                    credentials: 'include',
                    body: JSON.stringify({
                        checkoutMerchantNo: Number(checkoutMerchantNo),
                        originProductNo: Number(originProductNo),
                        page: page,
                        pageSize: pageSize,
                        reviewSearchSortType: 'REVIEW_SCORE_ASC'
                    })
                });

                if (!res.ok) {
                    if (page === 1) {
                        updateProgress(`리뷰 API 오류 (${res.status})`, 0);
                        setTimeout(() => { removeOverlay(); isRunning = false; }, 2000);
                        return;
                    }
                    break;
                }

                const json = await res.json();
                const contents = json?.contents || [];
                if (contents.length === 0) break;

                for (const item of contents) {
                    const content = (item.reviewContent || item.body || '').trim();
                    if (!content) continue;

                    allReviews.push({
                        option: item.productOptionContent || '',
                        rating: item.reviewScore || 0,
                        content
                    });

                    if (allReviews.length >= maxReviews) break;
                }

                if (allReviews.length >= maxReviews) break;
                if (contents.length < pageSize) break;
            } catch (e) {
                console.error(`[AutoClip] ${page}페이지 리뷰 오류:`, e);
                if (page === 1) {
                    updateProgress('리뷰 수집 실패', 0);
                    setTimeout(() => { removeOverlay(); isRunning = false; }, 2000);
                    return;
                }
                break;
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
            `판매가:,${esc(String(salePrice))}`,
            '',
            '옵션,별점수(최대5점),리뷰내용',
            ...allReviews.map(r =>
                `${esc(r.option)},${esc(r.rating)},${esc(r.content)}`
            )
        ].join('\n');

        // 다운로드
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${productName || 'smartstore'}_리뷰.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        updateProgress(`완료! ${allReviews.length}개 리뷰 다운로드`, 100);
        setTimeout(() => { removeOverlay(); isRunning = false; }, 2000);
    }
})();
