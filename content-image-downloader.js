(() => {
    if (window.__AUTOCLIP_IMAGEDOWN_LOADED__) return;
    window.__AUTOCLIP_IMAGEDOWN_LOADED__ = true;

    let shadow = null;
    let isOpen = false;
    let isScanning = false;
    let hasScanned = false;
    let allImages = [];
    let selected = new Set();
    let minW = 300;
    let minH = 300;
    const DEFAULT_MIN_W = 300;
    const DEFAULT_MIN_H = 300;

    function close() {
        if (!isOpen) return;
        isOpen = false;
        shadow.host.style.display = 'none';
    }

    // ===== 사이트 감지 =====
    const isCoupang = /coupang\.com/.test(location.host);
    const isSmartStore = /smartstore\.naver\.com|brand\.naver\.com/.test(location.host);

    // ===== 페이지 스크롤 + 더보기 클릭 (lazy load 트리거) =====
    async function scrollAndExpand() {
        showProgress(true);
        updateBar(0);

        let clicked = false;
        let lastPos = -1;

        await new Promise((resolve) => {
            const timer = setInterval(() => {
                const el = document.scrollingElement || document.documentElement || document.body;
                const max = el.scrollHeight - el.clientHeight;
                const cur = el.scrollTop;

                // 쿠팡 "상품정보 더보기" 버튼 클릭
                if (!clicked && isCoupang) {
                    const btn = [...document.querySelectorAll('h4')].find(
                        (h) => h.textContent.replace(/\s+/g, ' ').includes('상품정보 더보기')
                    );
                    if (btn) {
                        btn.click();
                        clicked = true;
                    }
                }

                // 스마트스토어 "상세정보 펼쳐보기" 버튼 클릭
                if (!clicked && isSmartStore) {
                    const btn = [...document.querySelectorAll('button')].find(
                        (b) => b.textContent.replace(/\s+/g, ' ').includes('상세정보 펼쳐보기')
                    );
                    if (btn) {
                        btn.click();
                        clicked = true;
                    }
                }

                el.scrollTop = Math.min(max, cur + 1000);
                updateBar(Math.min(99, Math.floor((el.scrollTop / Math.max(1, max)) * 100)));

                if (el.scrollTop === lastPos || el.scrollTop >= max) {
                    clearInterval(timer);
                    // 스크롤 원위치
                    new Promise((done) => {
                        const back = setInterval(() => {
                            const s = document.scrollingElement || document.documentElement || document.body;
                            const pos = s.scrollTop;
                            s.scrollTop = Math.max(0, pos - 1500);
                            if (s.scrollTop <= 1) {
                                s.scrollTop = 0;
                                clearInterval(back);
                                done();
                            }
                        }, 50);
                    }).then(() => {
                        updateBar(100);
                        resolve();
                    });
                }
                lastPos = el.scrollTop;
            }, 100);
        });
    }

    // ===== 이미지 수집 =====
    async function collectImages() {
        const map = new Map();

        function addUrl(rawUrl) {
            try {
                const u = new URL(rawUrl, location.href);
                u.searchParams.delete('type');
                const href = u.href;
                if (!map.has(href)) map.set(href, { url: href });
            } catch {}
        }

        function parseSrcset(attr) {
            if (!attr) return [];
            return attr.split(',').map((e) => e.trim().split(/\s+/)[0]).filter(Boolean);
        }

        // img 태그
        document.querySelectorAll('img[src], img[srcset]').forEach((img) => {
            const fromSrcset = parseSrcset(img.getAttribute('srcset'));
            const sources = fromSrcset.length ? fromSrcset : [img.currentSrc || img.src].filter(Boolean);
            sources.forEach(addUrl);
        });

        // source 태그
        document.querySelectorAll('source[src], source[srcset]').forEach((src) => {
            const fromSrcset = parseSrcset(src.getAttribute('srcset'));
            const sources = fromSrcset.length ? fromSrcset : [src.src].filter(Boolean);
            sources.forEach(addUrl);
        });

        // background-image (computed style)
        document.querySelectorAll('*').forEach((el) => {
            const bg = getComputedStyle(el).backgroundImage;
            if (bg && bg !== 'none') {
                for (const m of bg.matchAll(/url\((["']?)(.*?)\1\)/gi)) {
                    addUrl(m[2]);
                }
            }
        });

        // preload link
        document.querySelectorAll('link[rel*="image"][href], link[rel="preload"][as="image"][href]').forEach((link) => {
            addUrl(link.href);
        });

        // SVG 필터
        let images = [...map.values()].filter((i) => !/\.svg(\?|$)/i.test(i.url));

        // 이미지 크기 로드 (동시 8개)
        const results = new Array(images.length);
        let idx = 0;
        const workers = Array(Math.min(8, images.length)).fill(0).map(async () => {
            while (idx < images.length) {
                const i = idx++;
                const dim = await new Promise((resolve) => {
                    const img = new Image();
                    img.onload = () => resolve({ w: img.naturalWidth || img.width || null, h: img.naturalHeight || img.height || null });
                    img.onerror = () => resolve({ w: null, h: null });
                    img.referrerPolicy = 'no-referrer';
                    img.decoding = 'async';
                    img.src = images[i].url;
                });
                results[i] = { ...images[i], width: dim.w, height: dim.h };
            }
        });
        await Promise.all(workers);

        allImages = results.filter(Boolean);
        // 기존 선택 중 없어진 이미지 제거
        selected = new Set([...selected].filter((url) => allImages.some((img) => img.url === url)));
    }

    // ===== UI 유틸 =====
    function showProgress(show) {
        shadow.getElementById('progress').style.display = show ? 'block' : 'none';
    }

    function updateBar(pct) {
        shadow.getElementById('pbar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
    }

    function showSpinner(show) {
        shadow.getElementById('pspin').style.display = show ? 'block' : 'none';
    }

    // 이미지 분류: 상세(원본) > 상품사진 > 썸네일 > 리뷰 > 기타
    function getImageCategory(url) {
        if (isSmartStore) {
            const isShopPhinf = /shop-phinf\.pstatic\.net/i.test(url);
            const isReview = /checkout\.phinf\//i.test(url);

            if (isShopPhinf) {
                // 파일명 추출해서 판별: 숫자_숫자.ext = 상품사진(썸네일), 그 외 = 상세
                try {
                    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
                    const isNumericName = /^\d+_\d+\.\w+$/.test(filename);
                    if (isNumericName) return 1;  // 상품사진
                    return 0;                     // 상세
                } catch {
                    return 0;
                }
            }
            if (isReview) return 3;        // 리뷰
            return 4;
        }

        // 쿠팡
        const isFullSize = /\/remote\/q\d+\//i.test(url);
        const isThumbnail = /\/remote\/\d+x\d+/i.test(url);
        const isRetail = /\/image\/retail\/images\//i.test(url);
        const isReview = /\/PRODUCTREVIEW\//i.test(url);
        const isProduct = /\/image\/vendor_inventory\//i.test(url) || /\/vendoritem\//i.test(url);

        if (isFullSize) return 0;                     // q89 등 원본 품질 = 상세
        if (isRetail && !isThumbnail) return 0;       // retail 원본
        if (isProduct) return 1;                      // 상품사진 (썸네일 크기)
        if (isRetail && isThumbnail) return 2;        // 상세 썸네일
        if (isReview) return 3;                       // 리뷰
        return 4;                                     // 기타
    }

    function getFiltered() {
        return allImages
            .filter((img) => (img.width ?? 0) >= minW && (img.height ?? 0) >= minH)
            .sort((a, b) => getImageCategory(a.url) - getImageCategory(b.url));
    }

    function updateCounts() {
        shadow.getElementById('counts').innerHTML = `총 <strong>${getFiltered().length}</strong>, 선택 <strong>${selected.size}</strong>`;
    }

    // ===== 그리드 렌더 =====
    function renderGrid() {
        const grid = shadow.getElementById('grid');
        grid.innerHTML = '';
        const filtered = getFiltered();

        for (const img of filtered) {
            const card = document.createElement('div');
            card.className = 'card' + (selected.has(img.url) ? ' selected' : '');
            card.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                if (selected.has(img.url)) selected.delete(img.url);
                else selected.add(img.url);
                updateCounts();
                updateSelection();
            });

            const thumb = document.createElement('div');
            thumb.className = 'thumb';
            const imgEl = document.createElement('img');
            imgEl.src = img.url;
            imgEl.loading = 'lazy';
            imgEl.decoding = 'async';
            imgEl.referrerPolicy = 'no-referrer';
            thumb.appendChild(imgEl);

            const badge = document.createElement('div');
            badge.className = 'badge';
            badge.textContent = `${img.width ?? '-'}×${img.height ?? '-'}`;
            thumb.appendChild(badge);

            const cat = getImageCategory(img.url);
            if (cat <= 3) {
                const catMap = {
                    0: ['detail', '상세'],
                    1: ['product', '상품'],
                    2: ['thumb-resize', '썸네일'],
                    3: ['review', '리뷰']
                };
                const [cls, text] = catMap[cat];
                const catBadge = document.createElement('div');
                catBadge.className = `cat-badge ${cls}`;
                catBadge.textContent = text;
                thumb.appendChild(catBadge);
            }

            const checkMark = document.createElement('div');
            checkMark.className = 'check-mark';
            checkMark.textContent = '\u2713';
            thumb.appendChild(checkMark);

            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.title = img.url;
            meta.textContent = img.url;

            const controls = document.createElement('div');
            controls.className = 'controls';

            const dlBtn = document.createElement('button');
            dlBtn.textContent = '다운로드';
            dlBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                chrome.runtime.sendMessage({ type: 'downloadImage', payload: { url: img.url, filename: getFilename(img.url) } });
            });

            const openBtn = document.createElement('button');
            openBtn.textContent = '새창으로';
            openBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.open(img.url, '_blank', 'noopener');
            });

            controls.appendChild(dlBtn);
            controls.appendChild(openBtn);
            card.appendChild(thumb);
            card.appendChild(meta);
            card.appendChild(controls);
            grid.appendChild(card);
        }

        updateCounts();
        updateSelection();
    }

    function updateSelection() {
        shadow.querySelectorAll('.card').forEach((card) => {
            const url = card.querySelector('.meta')?.title;
            if (url) card.classList.toggle('selected', selected.has(url));
        });
    }

    function handleDownload() {
        const items = getFiltered().filter((img) => selected.has(img.url));
        if (items.length === 0) {
            alert('선택된 이미지가 없습니다.');
            return;
        }
        const images = items.map((img, i) => ({ url: img.url, filename: getFilename(img.url, i + 1) }));
        chrome.runtime.sendMessage({ type: 'downloadImages', payload: { images } });
    }

    function getFilename(url, index) {
        const folder = isSmartStore ? 'smartstore_images' : 'coupang_images';
        try {
            const u = new URL(url);
            const parts = u.pathname.split('/');
            const last = parts[parts.length - 1];
            if (last && last.includes('.')) {
                const prefix = index ? `${String(index).padStart(3, '0')}_` : '';
                return `${folder}/${prefix}${last}`;
            }
        } catch {}
        const ext = url.match(/\.(jpe?g|png|gif|webp|bmp)/i)?.[0] || '.jpg';
        const prefix = index ? `${String(index).padStart(3, '0')}` : Date.now();
        return `${folder}/${prefix}${ext}`;
    }

    // ===== Shadow DOM + UI 생성 =====
    function createUI() {
        const host = document.createElement('div');
        Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647', display: 'none' });
        document.documentElement.appendChild(host);
        shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            :host { all: initial; }
            * { box-sizing: border-box; font-family: 'Pretendard', system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans KR', sans-serif; }
            .backdrop {
                position: fixed; inset: 0;
                background: rgba(0,0,0,0.35);
                display: flex; align-items: center; justify-content: center;
                backdrop-filter: blur(6px);
            }
            .modal {
                width: min(1240px, 96vw);
                height: min(92vh, 960px);
                background: #fff;
                color: #1e1e2e;
                border-radius: 16px;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                box-shadow: 0 24px 80px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.06);
            }

            /* 헤더 */
            .header {
                padding: 12px 18px;
                display: flex;
                gap: 8px;
                align-items: center;
                background: #fff;
                border-bottom: 1px solid #eee;
                flex-wrap: wrap;
            }
            .header .logo {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-right: 4px;
                font-weight: 700;
                font-size: 14px;
                color: #7c3aed;
            }
            .header .logo-icon {
                width: 26px; height: 26px;
                background: linear-gradient(135deg, #7c3aed, #a78bfa);
                border-radius: 7px;
                display: flex; align-items: center; justify-content: center;
                font-size: 13px; color: #fff;
            }
            .header .sep {
                width: 1px; height: 20px;
                background: #e5e5e5;
                margin: 0 4px;
            }
            .header input[type="number"] {
                width: 70px;
                padding: 5px 8px;
                border-radius: 8px;
                border: 1px solid #ddd;
                background: #f9f9fb;
                color: #333;
                text-align: center;
                font-size: 12px;
                outline: none;
                transition: border-color 0.2s;
            }
            .header input[type="number"]:focus {
                border-color: #7c3aed;
                box-shadow: 0 0 0 2px rgba(124,58,237,0.1);
            }
            .header label {
                font-size: 12px;
                color: #888;
                display: flex;
                align-items: center;
                gap: 5px;
            }
            .header button {
                padding: 6px 13px;
                border-radius: 8px;
                border: 1px solid #ddd;
                background: #fff;
                color: #555;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: all 0.15s;
            }
            .header button:hover {
                background: #f5f3ff;
                border-color: #c4b5fd;
                color: #7c3aed;
            }
            .header button.primary {
                background: linear-gradient(135deg, #7c3aed, #6d28d9);
                border: none;
                color: #fff;
                font-weight: 600;
                padding: 7px 16px;
            }
            .header button.primary:hover {
                background: linear-gradient(135deg, #6d28d9, #5b21b6);
                box-shadow: 0 4px 14px rgba(124,58,237,0.3);
            }
            .header button.reset {
                font-size: 11px;
                padding: 5px 10px;
                color: #aaa;
                border-color: #e8e8ee;
                background: #f9f9fb;
            }
            .header button.reset:hover {
                color: #7c3aed;
                border-color: #c4b5fd;
                background: #f5f3ff;
            }
            .header button.close {
                color: #999;
                border-color: transparent;
                background: transparent;
            }
            .header button.close:hover {
                color: #333;
                background: #f5f5f5;
            }
            .counts {
                margin-left: auto;
                font-size: 12px;
                white-space: nowrap;
                color: #888;
            }
            .counts strong {
                color: #7c3aed;
                font-weight: 600;
            }

            /* 진행바 */
            .progress {
                position: relative;
                height: 3px;
                background: #f0f0f0;
                display: none;
            }
            .progress .bar {
                height: 100%;
                width: 0%;
                background: linear-gradient(90deg, #7c3aed, #a78bfa);
                transition: width 0.15s linear;
                border-radius: 0 2px 2px 0;
            }
            .progress .spin {
                position: absolute;
                right: 10px;
                top: -22px;
                width: 14px; height: 14px;
                border: 2px solid #e0d4fc;
                border-top-color: #7c3aed;
                border-radius: 50%;
                animation: sp 0.6s linear infinite;
                display: none;
            }
            @keyframes sp { to { transform: rotate(360deg); } }

            /* 바디 */
            .body {
                flex: 1;
                overflow: auto;
                padding: 16px 18px;
                background: #f7f7fa;
            }
            .body::-webkit-scrollbar { width: 6px; }
            .body::-webkit-scrollbar-track { background: transparent; }
            .body::-webkit-scrollbar-thumb { background: #d5d0e6; border-radius: 3px; }
            .body::-webkit-scrollbar-thumb:hover { background: #b8b0d0; }

            /* 그리드 */
            .grid {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 12px;
            }

            /* 카드 */
            .card {
                position: relative;
                border: 1.5px solid #e8e8ee;
                border-radius: 12px;
                overflow: hidden;
                background: #fff;
                cursor: pointer;
                transition: all 0.2s;
            }
            .card:hover {
                border-color: #c4b5fd;
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(124,58,237,0.08);
            }
            .card.selected {
                border-color: #7c3aed;
                box-shadow: 0 0 0 1px rgba(124,58,237,0.2), 0 4px 16px rgba(124,58,237,0.1);
                background: #faf8ff;
            }
            .thumb {
                aspect-ratio: 1/1;
                display: flex;
                align-items: center;
                justify-content: center;
                background: #f5f5f8;
                overflow: hidden;
                position: relative;
            }
            .thumb img {
                max-width: 100%;
                max-height: 100%;
                transition: transform 0.2s;
            }
            .card:hover .thumb img {
                transform: scale(1.03);
            }
            .badge {
                position: absolute;
                left: 7px;
                top: 7px;
                background: rgba(0,0,0,0.55);
                padding: 2px 7px;
                border-radius: 5px;
                font-size: 10px;
                color: #fff;
                font-weight: 500;
                backdrop-filter: blur(8px);
            }
            .cat-badge {
                position: absolute;
                left: 7px;
                bottom: 7px;
                padding: 2px 7px;
                border-radius: 5px;
                font-size: 10px;
                font-weight: 600;
                backdrop-filter: blur(8px);
            }
            .cat-badge.detail {
                background: rgba(124,58,237,0.85);
                color: #fff;
            }
            .cat-badge.product {
                background: rgba(37,99,235,0.75);
                color: #fff;
            }
            .cat-badge.thumb-resize {
                background: rgba(100,100,100,0.65);
                color: #fff;
            }
            .cat-badge.review {
                background: rgba(234,88,12,0.8);
                color: #fff;
            }
            .card.selected .check-mark {
                opacity: 1;
                transform: scale(1);
            }
            .check-mark {
                position: absolute;
                top: 7px;
                right: 7px;
                width: 22px; height: 22px;
                background: #7c3aed;
                border-radius: 6px;
                display: flex; align-items: center; justify-content: center;
                font-size: 12px; color: #fff; font-weight: 700;
                opacity: 0;
                transform: scale(0.6);
                transition: all 0.15s;
            }
            .meta {
                font-size: 10px;
                color: #999;
                padding: 6px 9px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                border-top: 1px solid #f0f0f3;
            }
            .controls {
                display: flex;
                border-top: 1px solid #f0f0f3;
            }
            .controls button {
                flex: 1;
                padding: 7px 6px;
                border: none;
                background: transparent;
                color: #777;
                font-size: 11px;
                cursor: pointer;
                transition: all 0.15s;
            }
            .controls button:hover {
                background: #f5f3ff;
                color: #7c3aed;
            }
            .controls button + button {
                border-left: 1px solid #f0f0f3;
            }

            /* 풋터 */
            .footer {
                border-top: 1px solid #eee;
                padding: 10px 18px;
                display: flex;
                gap: 10px;
                align-items: center;
                background: #fff;
            }
            .brand {
                font-size: 11px;
                padding: 3px 10px;
                border-radius: 6px;
                color: #7c3aed;
                background: #f5f3ff;
                font-weight: 600;
                letter-spacing: 0.3px;
            }
            .tip {
                color: #aaa;
                font-size: 11px;
            }

            @media (max-width: 1000px) { .grid { grid-template-columns: repeat(3, 1fr); } }
            @media (max-width: 680px) { .grid { grid-template-columns: repeat(2, 1fr); } }
        `;
        shadow.appendChild(style);

        const backdrop = document.createElement('div');
        backdrop.className = 'backdrop';
        backdrop.innerHTML = `
            <div class="modal" role="dialog" aria-modal="true">
                <div class="header">
                    <div class="logo"><div class="logo-icon">\u{1F4F7}</div>AutoClip</div>
                    <div class="sep"></div>
                    <button id="refreshBtn">\u21BB 새로고침</button>
                    <div class="sep"></div>
                    <label>가로 <input id="minW" type="number" min="0" value="300"></label>
                    <label>세로 <input id="minH" type="number" min="0" value="300"></label>
                    <button id="resetFilterBtn" class="reset">초기화</button>
                    <div class="sep"></div>
                    <button id="selectAllBtn">전체선택</button>
                    <button id="clearSelBtn">선택해제</button>
                    <div class="counts" id="counts">총 <strong>0</strong>, 선택 <strong>0</strong></div>
                    <button id="downloadBtn" class="primary">\u2B07 선택 다운로드</button>
                    <button id="closeBtn" class="close">\u2715 닫기</button>
                </div>
                <div class="progress" id="progress"><div class="bar" id="pbar"></div><div class="spin" id="pspin"></div></div>
                <div class="body"><div id="grid" class="grid"></div></div>
                <div class="footer">
                    <span class="brand">AutoClip</span>
                    <div style="flex:1"></div>
                    <span class="tip">카드 클릭으로 선택 \u00B7 하단 버튼으로 개별 다운로드 \u00B7 ESC로 닫기</span>
                </div>
            </div>
        `;
        shadow.appendChild(backdrop);

        // 이벤트 바인딩
        shadow.getElementById('closeBtn').addEventListener('click', close);
        shadow.getElementById('refreshBtn').addEventListener('click', async () => {
            showProgress(true);
            showSpinner(true);
            await collectImages();
            renderGrid();
            showProgress(false);
            showSpinner(false);
        });
        shadow.getElementById('selectAllBtn').addEventListener('click', () => {
            getFiltered().forEach((img) => selected.add(img.url));
            updateCounts();
            updateSelection();
        });
        shadow.getElementById('clearSelBtn').addEventListener('click', () => {
            selected.clear();
            updateCounts();
            updateSelection();
        });
        shadow.getElementById('downloadBtn').addEventListener('click', handleDownload);
        shadow.getElementById('minW').addEventListener('change', (e) => {
            minW = +e.target.value || 0;
            renderGrid();
        });
        shadow.getElementById('minH').addEventListener('change', (e) => {
            minH = +e.target.value || 0;
            renderGrid();
        });
        shadow.getElementById('resetFilterBtn').addEventListener('click', () => {
            minW = DEFAULT_MIN_W;
            minH = DEFAULT_MIN_H;
            shadow.getElementById('minW').value = DEFAULT_MIN_W;
            shadow.getElementById('minH').value = DEFAULT_MIN_H;
            renderGrid();
        });
        window.addEventListener('keydown', (e) => {
            if (isOpen && e.key === 'Escape') close();
        }, { capture: true });
    }

    // ===== 메시지 리스너 =====
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === 'PICKER_TOGGLE') {
            if (isScanning) return;

            if (isOpen) {
                close();
            } else {
                (async () => {
                    if (isScanning) return;
                    isScanning = true;
                    try {
                        isOpen = true;
                        if (!shadow) createUI();
                        shadow.host.style.display = 'block';

                        if (!hasScanned) {
                            await scrollAndExpand();
                            hasScanned = true;
                        }

                        showProgress(true);
                        showSpinner(true);
                        await collectImages();
                        renderGrid();
                    } finally {
                        showProgress(false);
                        showSpinner(false);
                        isScanning = false;
                    }
                })();
            }
        }
    });
})();
