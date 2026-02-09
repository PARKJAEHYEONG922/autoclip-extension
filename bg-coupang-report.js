// 쿠팡 광고 보고서 자동 가져오기 핸들러

import { startKeepAlive, stopKeepAlive, waitForTabLoad } from './bg-utils.js';

export async function handleFetchCoupangAdsReport(message, sendResponse) {
    // 서비스 워커 유지 시작
    startKeepAlive();

    let incognitoWindowId = null;

    try {
        const { id, password, startDate, endDate } = message.payload;
        console.log("[Background] Starting Coupang Ads report fetch:", { startDate, endDate });

        const reportUrl = "https://advertising.coupang.com/marketing-reporting/billboard/reports/pa";
        const loginPageUrl = "https://advertising.coupang.com/user/login";

        // 1. 시크릿 모드에서 쿠팡 쿠키 삭제 (깨끗한 세션 보장)
        console.log("[Background] Clearing Coupang cookies from incognito...");

        const coupangDomains = [
            "coupang.com",
            ".coupang.com",
            "advertising.coupang.com",
            "xauth.coupang.com"
        ];

        for (const domain of coupangDomains) {
            try {
                const cookies = await chrome.cookies.getAll({ domain: domain });
                for (const cookie of cookies) {
                    const url = `https://${cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain}${cookie.path}`;
                    await chrome.cookies.remove({
                        url: url,
                        name: cookie.name,
                        storeId: "1" // 시크릿 모드 쿠키 스토어
                    });
                }
                console.log(`[Background] Cleared ${cookies.length} cookies for ${domain}`);
            } catch (e) {
                console.log(`[Background] Cookie clear for ${domain}:`, e.message);
            }
        }

        // 2. 시크릿 모드 윈도우 생성
        console.log("[Background] Creating incognito window...");
        console.log("[Background] Login URL:", loginPageUrl);

        let incognitoWindow;
        try {
            incognitoWindow = await chrome.windows.create({
                url: loginPageUrl,
                incognito: true,
                focused: false
            });
            console.log("[Background] chrome.windows.create returned:", JSON.stringify(incognitoWindow, null, 2));
        } catch (windowErr) {
            console.error("[Background] Incognito window creation error:", windowErr);
            console.error("[Background] Error name:", windowErr?.name);
            console.error("[Background] Error message:", windowErr?.message);
            throw new Error("시크릿 모드 윈도우를 생성할 수 없습니다. 확장프로그램 설정에서 '시크릿 모드에서 허용'을 활성화해주세요.");
        }

        console.log("[Background] incognitoWindow:", incognitoWindow);
        console.log("[Background] incognitoWindow.id:", incognitoWindow?.id);
        console.log("[Background] incognitoWindow.incognito:", incognitoWindow?.incognito);
        console.log("[Background] incognitoWindow.tabs:", incognitoWindow?.tabs);

        if (!incognitoWindow || !incognitoWindow.id) {
            console.error("[Background] Window object is invalid:", {
                hasWindow: !!incognitoWindow,
                hasId: !!incognitoWindow?.id,
                windowKeys: incognitoWindow ? Object.keys(incognitoWindow) : []
            });
            throw new Error("시크릿 모드 윈도우 생성 실패. 확장프로그램을 다시 로드해주세요.");
        }

        incognitoWindowId = incognitoWindow.id;

        // 탭이 바로 채워지지 않을 수 있으므로 대기
        let tabId = incognitoWindow.tabs?.[0]?.id;
        if (!tabId) {
            console.log("[Background] Waiting for incognito tab to be created...");
            // 윈도우 내 탭을 쿼리로 찾기
            for (let i = 0; i < 10; i++) {
                await new Promise(resolve => setTimeout(resolve, 500));
                const tabs = await chrome.tabs.query({ windowId: incognitoWindowId });
                if (tabs && tabs.length > 0 && tabs[0].id) {
                    tabId = tabs[0].id;
                    console.log("[Background] Found tab via query:", tabId);
                    break;
                }
            }
        }

        if (!tabId) {
            throw new Error("시크릿 모드 탭을 찾을 수 없습니다. 확장프로그램을 다시 로드해주세요.");
        }

        console.log("[Background] Using tabId:", tabId);

        await waitForTabLoad(tabId, 30000);
        await new Promise(resolve => setTimeout(resolve, 1500));

        // 2. 현재 URL 확인
        let tab = await chrome.tabs.get(tabId);
        let currentUrl = tab.url || "";

        // 로그인 페이지에서 시작 (시크릿 모드이므로 항상 로그인 필요)
        if (currentUrl.includes("/user/login") || currentUrl.includes("/login")) {
            console.log("[Background] Login page detected, clicking login button...");

            // "로그인하기" 버튼 클릭 (xauth로 이동)
            const clickResult = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                world: "MAIN",
                func: async () => {
                    const loginLink = document.querySelector('a[href*="/user/wing/authorization"]');
                    if (loginLink) {
                        loginLink.click();
                        return { success: true };
                    }
                    // 버튼 텍스트로 찾기
                    const buttons = document.querySelectorAll('a.ant-btn, button');
                    for (const btn of buttons) {
                        if (btn.textContent.includes('로그인')) {
                            btn.click();
                            return { success: true };
                        }
                    }
                    return { success: false, error: "로그인하기 버튼을 찾을 수 없습니다" };
                },
                args: []
            });

            if (!clickResult[0]?.result?.success) {
                throw new Error(clickResult[0]?.result?.error || "로그인 버튼 클릭 실패");
            }

            // xauth 페이지 로드 대기
            await new Promise(resolve => setTimeout(resolve, 3000));
            await waitForTabLoad(tabId, 30000);
            await new Promise(resolve => setTimeout(resolve, 1500));

            // 3. xauth 페이지에서 로그인 폼 입력
            tab = await chrome.tabs.get(tabId);
            currentUrl = tab.url || "";

            if (currentUrl.includes("xauth.coupang.com")) {
                console.log("[Background] xauth page loaded, filling login form...");

                const loginResult = await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    world: "MAIN",
                    func: async (userId, userPassword) => {
                        // xauth 페이지의 로그인 폼 찾기 (다양한 selector 시도)
                        const idSelectors = [
                            '#username', '#login-username', 'input[name="username"]',
                            'input[type="text"]', 'input[type="email"]',
                            'input[placeholder*="아이디"]', 'input[placeholder*="이메일"]'
                        ];
                        const pwSelectors = [
                            '#password', '#login-password', 'input[name="password"]',
                            'input[type="password"]'
                        ];
                        const btnSelectors = [
                            '#kc-login', 'button[type="submit"]', 'input[type="submit"]',
                            'button[name="login"]', '.btn-login', '.login-btn'
                        ];

                        let idInput = null;
                        for (const sel of idSelectors) {
                            idInput = document.querySelector(sel);
                            if (idInput && idInput.type !== 'password') break;
                        }

                        let pwInput = null;
                        for (const sel of pwSelectors) {
                            pwInput = document.querySelector(sel);
                            if (pwInput) break;
                        }

                        if (!idInput) {
                            return { success: false, error: "아이디 입력 필드를 찾을 수 없습니다" };
                        }
                        if (!pwInput) {
                            return { success: false, error: "비밀번호 입력 필드를 찾을 수 없습니다" };
                        }

                        // 입력 필드에 값 설정
                        idInput.value = userId;
                        idInput.dispatchEvent(new Event("input", { bubbles: true }));
                        idInput.dispatchEvent(new Event("change", { bubbles: true }));

                        pwInput.value = userPassword;
                        pwInput.dispatchEvent(new Event("input", { bubbles: true }));
                        pwInput.dispatchEvent(new Event("change", { bubbles: true }));

                        await new Promise(r => setTimeout(r, 500));

                        // 로그인 버튼 찾기 및 클릭
                        let loginBtn = null;
                        for (const sel of btnSelectors) {
                            loginBtn = document.querySelector(sel);
                            if (loginBtn) break;
                        }

                        // 버튼 텍스트로 찾기
                        if (!loginBtn) {
                            const buttons = document.querySelectorAll('button, input[type="submit"]');
                            for (const btn of buttons) {
                                if (btn.textContent.includes('로그인') || btn.value?.includes('로그인') || btn.textContent.includes('Login')) {
                                    loginBtn = btn;
                                    break;
                                }
                            }
                        }

                        if (loginBtn) {
                                loginBtn.click();
                                return { success: true };
                            }

                            return { success: false, error: "로그인 버튼을 찾을 수 없습니다" };
                        },
                    args: [id, password]
                });

                if (!loginResult[0]?.result?.success) {
                    throw new Error(loginResult[0]?.result?.error || "로그인 폼 입력 실패");
                }

                // 로그인 완료 또는 2차 인증 대기 (최대 120초)
                console.log("[Background] Waiting for login completion or 2FA...");
                const loginTimeout = 120000; // 2분
                const loginStartTime = Date.now();
                let requires2FA = false;

                while (Date.now() - loginStartTime < loginTimeout) {
                    await new Promise(resolve => setTimeout(resolve, 1500));

                    tab = await chrome.tabs.get(tabId);
                    currentUrl = tab.url || "";

                    // 로그인 성공 (광고센터로 이동)
                    if (currentUrl.includes("advertising.coupang.com")) {
                        console.log("[Background] Login successful!");
                        break;
                    }

                    // 2차 인증 페이지 감지 (인증번호 입력 필요)
                    const pageCheck = await chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        world: "MAIN",
                        func: () => {
                            // 인증번호 입력 필드가 있는지 확인
                            const otpInput = document.querySelector('input[type="text"][maxlength="6"], input[name*="otp"], input[name*="code"], input[placeholder*="인증"], input[id*="otp"], input[id*="code"]');
                            const pageText = document.body?.innerText || "";
                            const has2FAText = pageText.includes("인증번호") || pageText.includes("인증 코드") || pageText.includes("확인 코드") || pageText.includes("보안 코드");

                            // 로그인 에러 체크
                            const errorEl = document.querySelector('.error-message, .login-error, [class*="error"]');
                            const errorText = errorEl?.innerText || "";

                            return {
                                is2FA: otpInput !== null || has2FAText,
                                hasError: errorText.length > 0,
                                errorText: errorText
                            };
                        },
                        args: []
                    });

                    const checkResult = pageCheck[0]?.result;

                    // 2차 인증 감지
                    if (checkResult?.is2FA && !requires2FA) {
                        requires2FA = true;
                        console.log("[Background] 2FA detected! Activating tab for user input...");
                        // 탭 활성화 (사용자가 직접 입력할 수 있도록)
                        await chrome.tabs.update(tabId, { active: true });
                        // 윈도우도 포커스
                        const tabInfo = await chrome.tabs.get(tabId);
                        if (tabInfo.windowId) {
                            await chrome.windows.update(tabInfo.windowId, { focused: true });
                        }
                    }

                    // 로그인 실패 감지
                    if (checkResult?.hasError && checkResult?.errorText) {
                        throw new Error("로그인 실패: " + checkResult.errorText);
                    }
                }

                // 타임아웃 체크
                tab = await chrome.tabs.get(tabId);
                if (!tab.url?.includes("advertising.coupang.com")) {
                    if (requires2FA) {
                        throw new Error("로그인 시간 초과 (2분). 인증번호를 입력하고 로그인을 완료한 후 다시 시도해주세요.");
                    } else {
                        throw new Error("로그인 시간 초과. 다시 시도해주세요.");
                    }
                }

            } else {
                // xauth가 아닌 다른 로그인 페이지인 경우 에러
                throw new Error("예상치 못한 로그인 페이지입니다: " + currentUrl);
            }
        } // end of if (login page)

        // 보고서 페이지로 이동 (로그인 후 또는 이미 로그인된 경우)
        tab = await chrome.tabs.get(tabId);
        if (!tab.url?.includes("/reports/pa")) {
            console.log("[Background] Navigating to report page...");
            await chrome.tabs.update(tabId, { url: reportUrl });
            await waitForTabLoad(tabId, 30000);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // 3. 보고서 생성 페이지에서 옵션 설정 및 보고서 만들기
        console.log("[Background] Setting report options...");

        const reportResult = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: "MAIN",
            func: async (start, end) => {
                const delay = (ms) => new Promise(r => setTimeout(r, ms));

                // 요소가 나타날 때까지 대기하는 함수
                const waitForElement = async (selector, timeout = 30000) => {
                    const startTime = Date.now();
                    while (Date.now() - startTime < timeout) {
                        const el = document.querySelector(selector);
                        if (el) return el;
                        await delay(500);
                    }
                    return null;
                };

                try {
                    // 페이지 로딩 대기 - 캠페인 선택 버튼이 나타날 때까지
                    console.log("[Report] Waiting for page to load...");
                    const campaignBtn = await waitForElement('.campaign-picker-dropdown-btn');
                    if (!campaignBtn) {
                        return { success: false, error: "페이지 로딩 시간 초과 - 캠페인 선택 버튼을 찾을 수 없습니다" };
                    }
                    console.log("[Report] Page loaded, setting options...");

                    // 0. 날짜 범위 설정 (RangePicker 사용)
                    console.log("[Report] Setting date range:", start, "~", end);

                    // "기간 설정" 라디오 버튼 클릭 (value가 빈 문자열)
                    const customDateRadio = document.querySelector('input.ant-radio-input[value=""]');
                    if (customDateRadio) {
                        customDateRadio.click();
                        console.log("[Report] Clicked '기간 설정' radio");
                        await delay(500);
                    } else {
                        console.log("[Report] '기간 설정' radio not found, trying text search...");
                        // 텍스트로 찾기
                        const radioLabels = document.querySelectorAll('.ant-radio-wrapper');
                        for (const label of radioLabels) {
                            if (label.textContent.includes('기간 설정') || label.textContent.includes('기간설정')) {
                                const radio = label.querySelector('input.ant-radio-input');
                                if (radio) {
                                    radio.click();
                                    console.log("[Report] Clicked '기간 설정' via text search");
                                    await delay(500);
                                    break;
                                }
                            }
                        }
                    }

                    // 날짜 선택기 찾기 (ant-picker-range 사용)
                    const rangePicker = document.querySelector('.ant-picker.ant-picker-range');
                    if (rangePicker) {
                        // RangePicker 클릭하여 달력 열기
                        rangePicker.click();
                        console.log("[Report] Clicked RangePicker to open calendar");
                        await delay(800);

                        // 이전 달로 이동하는 함수
                        const goToPrevMonth = async () => {
                            // visibility: hidden이 아닌 prev 버튼 찾기
                            const prevBtns = document.querySelectorAll('.ant-picker-header-prev-btn');
                            for (const btn of prevBtns) {
                                const style = window.getComputedStyle(btn);
                                if (style.visibility !== 'hidden') {
                                    btn.click();
                                    await delay(300);
                                    return true;
                                }
                            }
                            return false;
                        };

                        // 시작일 셀 찾아서 클릭
                        const clickDate = async (dateStr) => {
                            // 최대 3번 이전 달로 이동 시도
                            for (let i = 0; i < 3; i++) {
                                const cell = document.querySelector(`td[title="${dateStr}"]:not(.ant-picker-cell-disabled)`);
                                if (cell) {
                                    cell.click();
                                    console.log("[Report] Clicked date:", dateStr);
                                    await delay(400);
                                    return true;
                                }
                                console.log("[Report] Date not found, going to prev month...");
                                const moved = await goToPrevMonth();
                                if (!moved) break;
                            }
                            return false;
                        };

                        // 시작일 클릭
                        const startClicked = await clickDate(start);
                        if (startClicked) {
                            // 종료일 클릭 (시작일 클릭 후 달력이 종료일 선택 모드로 변경됨)
                            await delay(500);
                            const endClicked = await clickDate(end);
                            if (endClicked) {
                                console.log("[Report] Date range set successfully:", start, "~", end);
                            } else {
                                console.log("[Report] Failed to click end date:", end);
                            }
                        } else {
                            console.log("[Report] Failed to click start date:", start);
                        }
                        await delay(500);
                    } else {
                        console.log("[Report] RangePicker not found");
                    }

                    // 1. 기간 구분: 일별 선택 (먼저 선택해야 보고서 구조가 나타남)
                    console.log("[Report] Selecting daily period...");
                    const dailyRadio = document.querySelector('input[value="daily"]');
                    if (dailyRadio) {
                        dailyRadio.click();
                        await delay(500);
                    }

                    // 2. 보고서 구조: 캠페인 > 광고그룹 > 상품 > 키워드 선택
                    console.log("[Report] Selecting keyword structure...");
                    const keywordRadio = document.querySelector('input[value="keyword"]');
                    if (keywordRadio) {
                        keywordRadio.click();
                        await delay(300);
                    } else {
                        console.log("[Report] Keyword radio not found, trying to find by text...");
                        // 텍스트로 찾기
                        const radioLabels = document.querySelectorAll('.ant-radio-wrapper');
                        for (const label of radioLabels) {
                            if (label.textContent.includes('키워드')) {
                                const radio = label.querySelector('input[type="radio"]');
                                if (radio) {
                                    radio.click();
                                    await delay(300);
                                    break;
                                }
                            }
                        }
                    }

                    // 3. 캠페인 선택 드롭다운 클릭
                    console.log("[Report] Opening campaign selector...");
                    campaignBtn.click();
                    await delay(800);

                    // "전체선택" 체크박스 찾기
                    const selectAllLabels = document.querySelectorAll('.ant-checkbox-wrapper');
                    let selectAllCheckbox = null;
                    for (const label of selectAllLabels) {
                        if (label.textContent.includes('전체선택')) {
                            selectAllCheckbox = label.querySelector('.ant-checkbox-input');
                            break;
                        }
                    }

                    if (selectAllCheckbox && !selectAllCheckbox.checked) {
                        console.log("[Report] Selecting all campaigns...");
                        selectAllCheckbox.click();
                        await delay(300);
                    }

                    // "확인" 버튼 클릭
                    const confirmButtons = document.querySelectorAll('button.confirm-button, button.ant-btn-primary');
                    for (const btn of confirmButtons) {
                        if (btn.textContent.includes('확인')) {
                            btn.click();
                            break;
                        }
                    }
                    await delay(500);

                    // 4. 보고서 만들기 버튼이 활성화될 때까지 대기
                    console.log("[Report] Waiting for create button...");
                    let createButton = null;
                    const buttonWaitStart = Date.now();
                    while (Date.now() - buttonWaitStart < 10000) {
                        const buttons = document.querySelectorAll("button.ant-btn-primary");
                        for (const btn of buttons) {
                            if (btn.textContent.includes("보고서 만들기")) {
                                if (!btn.disabled) {
                                    createButton = btn;
                                    break;
                                }
                            }
                        }
                        if (createButton) break;
                        await delay(500);
                    }

                    if (createButton) {
                        console.log("[Report] Clicking create button...");
                        createButton.click();
                        return { success: true, step: "report_created" };
                    }

                    return { success: false, error: "보고서 만들기 버튼이 비활성화 상태입니다. 캠페인을 선택해주세요." };
                } catch (e) {
                    return { success: false, error: String(e) };
                }
            },
            args: [startDate, endDate]
        });

        console.log("[Background] Report creation result:", reportResult);

        if (!reportResult[0]?.result?.success) {
            throw new Error(reportResult[0]?.result?.error || "보고서 생성 실패");
        }

        // 4. 보고서 생성 완료 대기 및 다운로드
        // "요청한 보고서" 탭에서 정확한 보고서 찾아서 다운로드
        console.log("[Background] Waiting for report to be generated...");

        // 오늘 날짜 계산 (YYYY-MM-DD)
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        // 프론트엔드에서 전달받은 날짜 범위 사용
        const expectedDateRange = `${startDate} ~ ${endDate}`;

        console.log("[Background] Looking for report:", { todayStr, expectedDateRange, startDate, endDate });

        const downloadResult = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: "MAIN",
            func: async (expectedRequestDate, expectedPeriod) => {
                const delay = (ms) => new Promise(r => setTimeout(r, ms));

                // 보고서가 생성될 때까지 대기 (최대 90초)
                const maxWait = 90000;
                const startTime = Date.now();

                while (Date.now() - startTime < maxWait) {
                    // AG Grid 테이블의 모든 행 검색
                    const rows = document.querySelectorAll('.ag-row');

                    for (const row of rows) {
                        // 요청일 확인
                        const requestDateCell = row.querySelector('[col-id="requestDate"]');
                        const requestDate = requestDateCell?.textContent?.trim();

                        // 보고서 기간 확인
                        const dateRangeCell = row.querySelector('[col-id="dateRange"]');
                        const dateRange = dateRangeCell?.textContent?.trim();

                        // 보고서 구조 확인 (키워드 포함 여부)
                        const structureCell = row.querySelector('[col-id="dateGroupGranularity"]');
                        const structure = structureCell?.textContent || '';
                        const hasKeyword = structure.includes('키워드');

                        // 상태 확인
                        const statusCell = row.querySelector('[col-id="status"]');
                        const isComplete = statusCell?.textContent?.includes('생성 완료');

                        console.log("[Report] Checking row:", { requestDate, dateRange, hasKeyword, isComplete, structure });

                        // 모든 조건 확인: 요청일(오늘), 보고서 기간, 구조(키워드), 상태(생성 완료)
                        if (requestDate === expectedRequestDate &&
                            dateRange === expectedPeriod &&
                            hasKeyword &&
                            isComplete) {

                            console.log("[Report] Found matching report!");

                            // row-id에서 reportId 추출 (AG Grid row의 row-id 속성)
                            const reportId = row.getAttribute('row-id');
                            console.log("[Report] Report ID from row-id:", reportId);

                            if (reportId) {
                                // 다운로드 URL 직접 생성
                                const downloadUrl = `/marketing-reporting/v2/api/excel-report?id=${reportId}`;
                                console.log("[Report] Generated download URL:", downloadUrl);
                                return { success: true, downloadUrl: downloadUrl, reportId: reportId };
                            }

                            return { success: false, error: "Report ID를 찾을 수 없습니다" };
                        }
                    }

                    await delay(3000);
                }

                return { success: false, error: `일치하는 보고서를 찾지 못했습니다. (요청일: ${expectedRequestDate}, 기간: ${expectedPeriod})` };
            },
            args: [todayStr, expectedDateRange]
        });

        console.log("[Background] Download result:", downloadResult);

        const result = downloadResult[0]?.result;

        if (!result?.success) {
            throw new Error(result?.error || "보고서를 찾지 못했습니다");
        }

        // 다운로드 URL이 있으면 직접 fetch로 파일 가져오기
        let fileData = null;
        let fileName = null;

        if (result.downloadUrl) {
            console.log("[Background] Fetching file from URL:", result.downloadUrl);

            // 탭 내에서 fetch 실행 (쿠키 포함)
            const fileResult = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                world: "MAIN",
                func: async (url) => {
                    try {
                        const response = await fetch(url, { credentials: 'include' });
                        if (!response.ok) {
                            return { success: false, error: `HTTP ${response.status}` };
                        }

                        // Content-Disposition 헤더에서 파일명 추출
                        const contentDisposition = response.headers.get('Content-Disposition');
                        let filename = 'report.xlsx';
                        if (contentDisposition) {
                            const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                            if (match) {
                                filename = decodeURIComponent(match[1].replace(/['"]/g, ''));
                            }
                        }

                        const blob = await response.blob();
                        const arrayBuffer = await blob.arrayBuffer();

                        // ArrayBuffer를 Base64로 변환 (메시지 전달용)
                        const uint8Array = new Uint8Array(arrayBuffer);
                        let binary = '';
                        for (let i = 0; i < uint8Array.length; i++) {
                            binary += String.fromCharCode(uint8Array[i]);
                        }
                        const base64 = btoa(binary);

                        return {
                            success: true,
                            data: base64,
                            fileName: filename,
                            size: arrayBuffer.byteLength
                        };
                    } catch (e) {
                        return { success: false, error: String(e) };
                    }
                },
                args: [result.downloadUrl]
            });

            const fetchResult = fileResult[0]?.result;
            if (fetchResult?.success) {
                fileData = fetchResult.data;
                fileName = fetchResult.fileName;
                console.log("[Background] File fetched:", fileName, fetchResult.size, "bytes");
            } else {
                console.error("[Background] Failed to fetch file:", fetchResult?.error);
            }
        }

        stopKeepAlive();

        // 시크릿 윈도우 닫기
        if (incognitoWindowId) {
            try {
                await chrome.windows.remove(incognitoWindowId);
                console.log("[Background] Incognito window closed");
            } catch (e) {
                console.log("[Background] Failed to close incognito window:", e);
            }
        }

        if (fileData) {
            sendResponse({
                success: true,
                fileData: fileData,
                fileName: fileName,
                message: "보고서를 성공적으로 가져왔습니다."
            });
        } else {
            sendResponse({
                success: false,
                error: "보고서는 생성되었지만 파일을 가져오지 못했습니다."
            });
        }

    } catch (e) {
        stopKeepAlive();
        console.error("[Background] fetchCoupangAdsReport error:", e);

        // 에러 시에도 시크릿 윈도우 닫기
        if (incognitoWindowId) {
            try {
                await chrome.windows.remove(incognitoWindowId);
            } catch (closeErr) {
                console.log("[Background] Failed to close incognito window on error:", closeErr);
            }
        }

        sendResponse({
            success: false,
            error: String(e)
        });
    }
}
