# ⚡ CF Blog CMS

> **GitHub + Cloudflare Pages로 구동하는 완전한 블로그 CMS**
> GeneratePress 자식 테마 + AIBP Pro v3.7.0 내장 + 고급 SEO + 무효트래픽 차단

---

## ✨ 주요 기능

| 기능 | 설명 |
|------|------|
| 🎨 **GeneratePress 테마** | 업로드된 자식 테마 100% 동일 스킨 |
| 🔐 **관리자 시스템** | `/cf-admin` 대시보드, `/cf-login` 로그인 |
| 🤖 **AIBP Pro 내장** | Gemini AI 글쓰기 + AI 썸네일 + 멀티 스키마 |
| 🛡️ **무효트래픽 차단** | AdSense 클릭 과다 IP 자동 광고 숨김 (7일 후 자동 해제) |
| 📋 **자동 목차** | H2~H4 기반 TOC, 접기/펼치기 가능 |
| 🔍 **SEO 최적화** | RankMath 동일 수준 메타태그, OG, Twitter Card, Schema |
| ✏️ **비주얼/코드 에디터** | 워드프레스와 100% 동일 방식 |
| 📅 **예약발행 / 임시저장 / 휴지통** | 완전한 글 라이프사이클 |
| 🚀 **CDN / 속도 최적화** | CF Pages 엣지 캐시, Brotli, HTTP/3 |
| 🛡️ **자동 WAF** | CF WAF 규칙, Rate Limiting, Bot 차단 |

---

## 📁 프로젝트 구조

```
cf-blog/
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions 자동 배포
├── functions/
│   └── [[path]].js             # Cloudflare Pages Function (SSR + API 전체)
├── migrations/
│   └── 0001_init.sql           # D1 데이터베이스 스키마
├── public/
│   └── assets/
│       ├── generatepress.css   # GeneratePress 기본 레이아웃 CSS
│       ├── theme.css           # Adsensefarm 자식 테마 CSS (업로드된 파일 그대로)
│       ├── aibp-pro.css        # AIBP Pro 플러그인 CSS
│       ├── aibp-pro.js         # AIBP Pro 플러그인 JS (CF 포팅)
│       ├── admin.css           # 관리자 패널 CSS
│       ├── admin.js            # 관리자 패널 JS
│       └── editor.js           # 비주얼/코드 에디터 JS
├── cloudflare-security.md      # WAF/보안 설정 가이드
├── wrangler.toml               # Cloudflare 설정
└── package.json
```

---

## 🚀 설치 가이드

### 1단계: Cloudflare 리소스 생성

```bash
# Wrangler 설치
npm install -g wrangler

# Cloudflare 로그인
wrangler login

# D1 데이터베이스 생성
wrangler d1 create cf-blog-db
# → 출력된 database_id를 wrangler.toml에 입력

# KV Namespace 생성 (세션용)
wrangler kv namespace create SESSIONS
# → 출력된 id를 wrangler.toml에 입력

# KV Namespace 생성 (캐시용)
wrangler kv namespace create CACHE
# → 출력된 id를 wrangler.toml에 입력
```

### 2단계: wrangler.toml 수정

```toml
[[d1_databases]]
binding = "DB"
database_name = "cf-blog-db"
database_id = "실제_D1_ID_입력"  # ← 여기 변경

[[kv_namespaces]]
binding = "SESSIONS"
id = "실제_SESSIONS_KV_ID"       # ← 여기 변경

[[kv_namespaces]]
binding = "CACHE"
id = "실제_CACHE_KV_ID"          # ← 여기 변경
```

### 3단계: 데이터베이스 초기화

```bash
# 로컬 개발용
wrangler d1 execute cf-blog-db --file=./migrations/0001_init.sql

# 프로덕션
wrangler d1 execute cf-blog-db --remote --file=./migrations/0001_init.sql
```

### 4단계: 관리자 비밀번호 설정

```bash
# 비밀번호를 환경 변수로 안전하게 설정
wrangler pages secret put ADMIN_PASSWORD
# 입력: Swsh120327!
```

### 5단계: Cloudflare Pages 프로젝트 생성

**방법 A: GitHub 연결 (권장)**
1. Cloudflare Dashboard → Pages → Create Project
2. GitHub 리포지토리 연결
3. Build settings:
   - Framework: None
   - Build command: (비워두기)
   - Build output directory: `public`
4. Environment Variables에서 D1, KV 바인딩 설정

**방법 B: Wrangler CLI**
```bash
wrangler pages deploy public --project-name=cf-blog
```

### 6단계: GitHub Actions 시크릿 설정

GitHub 리포지토리 → Settings → Secrets and variables → Actions:
- `CLOUDFLARE_API_TOKEN`: Cloudflare API 토큰 (Edit Cloudflare Workers 권한)
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare 계정 ID

---

## 🔑 관리자 접속

| 항목 | 값 |
|------|-----|
| 로그인 URL | `https://yourblog.com/cf-login` |
| 사용자명 | `jiwunin` |
| 비밀번호 | `Swsh120327!` (환경변수로 설정) |
| 관리자 패널 | `https://yourblog.com/cf-admin` |

---

## 🤖 AIBP 설정

1. 관리자 패널 → **AIBP 설정**
2. Gemini API 키 입력 (https://aistudio.google.com/apikey 에서 무료 발급)
3. AI Horde API 키 입력 (선택, https://stablehorde.net/register)
4. 글 작성 시 우측 메타박스에서 AI 기능 사용

### AIBP 기능
- 🤖 **AI 콘텐츠 생성**: 키워드 입력 → 자동 SEO 최적화 글 작성
- 🖼️ **AI 썸네일**: Gemini + Pollinations AI로 썸네일 자동 생성
- ⭐ **멀티 스키마**: Article / FAQ / Product Review 스키마 자동 생성
- 🔍 **SEO 자동**: 제목/메타설명/포커스키워드/슬러그 자동 설정

---

## 🛡️ WAF 설정 (cloudflare-security.md 참고)

Cloudflare Dashboard에서 설정:
1. **Security → WAF → Custom Rules**: `cloudflare-security.md` 내 규칙 적용
2. **Security → WAF → Rate Limiting**: 로그인/API 요청 제한
3. **Caching → Cache Rules**: 정적 파일 캐시, 관리자 캐시 무효화
4. **Speed → Optimization**: Minify, Brotli, HTTP/3 활성화

---

## 📊 애드센스 무효트래픽 차단

- **관리자 패널 → 설정 → 애드센스 설정**에서 차단 조건 설정
  - 최대 클릭 수: `5` (기본)
  - 감지 시간: `60분` (기본)
- 조건 도달 시 해당 IP에서만 광고 자동 숨김
- **7일 후 자동 해제**
- **관리자 패널 → 애드센스 차단**에서 수동 해제 가능

---

## 🌐 서울 리전 최적화

- Cloudflare의 인천(ICN) 서울 PoP 자동 사용
- `CF-Cache-Status` 헤더로 캐시 확인 가능
- D1 데이터베이스 리전은 `wrangler.toml`에서 `database_id` 생성 시 선택

---

## 💡 로컬 개발

```bash
# 의존성 설치
npm install

# 로컬 개발 서버 시작
npm run dev
# http://localhost:8788 에서 확인
```

---

## 📝 라이선스

이 프로젝트는 개인 사용 목적으로 제작되었습니다.
- GeneratePress 테마: GPL v2+
- AIBP Pro: 원 개발자 라이선스 준수
