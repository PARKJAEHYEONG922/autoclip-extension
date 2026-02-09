# AutoClip Marketing Helper Chrome Extension

## 설치 방법

1. Chrome에서 `chrome://extensions/` 접속
2. 우측 상단 "개발자 모드" 활성화
3. "압축해제된 확장 프로그램을 로드합니다" 클릭
4. 이 폴더 선택

## 아이콘 추가

`icons` 폴더에 다음 파일들을 추가해주세요:
- icon16.png (16x16)
- icon48.png (48x48)
- icon128.png (128x128)

## 기능

### 네이버 쇼핑
- `getNaverShoppingTags`: 키워드 검색 결과에서 판매자 태그(manutag) 수집
- `getNaverShoppingData`: 전체 검색 데이터 가져오기

### 로그인 체크
- `naverLoginCheck`: 네이버 로그인 상태 확인

## 웹페이지 연동

프론트엔드에서 `extensionBridge.ts` 사용:

```typescript
import { extensionBridge } from '@/services/extensionBridge';

// 확장프로그램 설치 확인
const isInstalled = await extensionBridge.checkInstalled();

// 네이버 태그 가져오기
const tags = await extensionBridge.getNaverShoppingTags("키워드");
```
