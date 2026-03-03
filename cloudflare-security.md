# =====================================================
# Cloudflare WAF & Security Rules for CF Blog
# Terraform/Cloudflare Dashboard 설정 가이드
# =====================================================

# ─── Custom WAF Rules (Cloudflare Dashboard → Security → WAF → Custom Rules) ───

# Rule 1: 관리자 페이지 봇 차단
Name: Block bots on admin
Expression: (http.request.uri.path contains "/cf-admin" or http.request.uri.path contains "/cf-login") and (cf.client.bot or http.user_agent contains "curl" or http.user_agent contains "wget" or http.user_agent contains "python-requests" or http.user_agent contains "scrapy")
Action: Block

# Rule 2: 관리자 IP 제한 (선택사항 - 자신의 IP로 교체)
# Name: Admin IP restriction
# Expression: (http.request.uri.path contains "/cf-admin") and not (ip.src in {203.0.113.0/24})
# Action: Block

# Rule 3: API 엔드포인트 봇 차단
Name: Block bots on API
Expression: http.request.uri.path contains "/api/" and cf.client.bot and not http.request.uri.path contains "/api/search"
Action: Block

# Rule 4: SQL Injection 차단
Name: Block SQLi
Expression: (http.request.uri.query contains "UNION" and http.request.uri.query contains "SELECT") or (http.request.body contains "UNION SELECT") or (http.request.uri.query contains "' OR '1'='1") or (http.request.uri.query contains "DROP TABLE")
Action: Block

# Rule 5: XSS 차단
Name: Block XSS
Expression: (http.request.uri.query contains "<script") or (http.request.body contains "<script") or (http.request.uri.query contains "javascript:") or (http.request.uri.query contains "onerror=")
Action: Block

# Rule 6: 과도한 API 요청 차단 (Rate Limiting 대신)
Name: Block excessive requests
Expression: http.request.uri.path contains "/api/" and not http.request.uri.path eq "/api/search"
Action: Managed Challenge (또는 Rate Limit으로 대체)

# Rule 7: 알려진 공격 User-Agents 차단
Name: Block malicious UAs
Expression: (http.user_agent contains "sqlmap") or (http.user_agent contains "nikto") or (http.user_agent contains "nmap") or (http.user_agent contains "masscan") or (http.user_agent contains "havij") or (http.user_agent contains "acunetix")
Action: Block

# ─── Rate Limiting Rules (Security → WAF → Rate Limiting Rules) ───

# Rule: API Rate Limit
Name: API Rate Limit
Path: /api/*
Method: POST
Threshold: 30 requests per 1 minute per IP
Action: Block for 1 hour

# Rule: Admin Login Rate Limit  
Name: Login Rate Limit
Path: /cf-login
Method: POST
Threshold: 5 requests per 5 minutes per IP
Action: Block for 24 hours

# ─── Cache Rules (Caching → Cache Rules) ───

# Rule 1: Admin pages - no cache
Expression: starts_with(http.request.uri.path, "/cf-admin") or starts_with(http.request.uri.path, "/cf-login") or starts_with(http.request.uri.path, "/api/")
Cache: Bypass

# Rule 2: Static assets - long cache
Expression: ends_with(http.request.uri.path, ".css") or ends_with(http.request.uri.path, ".js") or ends_with(http.request.uri.path, ".woff2") or ends_with(http.request.uri.path, ".ico")
Edge TTL: 30 days
Browser TTL: 7 days

# Rule 3: Blog posts - short cache
Expression: not starts_with(http.request.uri.path, "/cf-admin") and not starts_with(http.request.uri.path, "/api/")
Edge TTL: 5 minutes
Browser TTL: 1 minute

# ─── Page Shield / Content Security Policy ───
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://pagead2.googlesyndication.com https://www.googletagmanager.com https://www.google-analytics.com https://fonts.googleapis.com;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data: https: http:;
  connect-src 'self' https://pagead2.googlesyndication.com https://www.google-analytics.com;
  frame-src https://googleads.g.doubleclick.net;

# ─── Cloudflare Bot Management Settings ───
# Security → Bots:
# - Bot Fight Mode: ON
# - Super Bot Fight Mode: ON (Enterprise)

# ─── Firewall Settings ───
# Security → Settings:
# - Security Level: Medium
# - Browser Integrity Check: ON
# - Hotlink Protection: ON
# - Email Address Obfuscation: ON

# ─── DDoS Protection ───
# Security → DDoS:
# - HTTP DDoS Attack Protection: Enabled (High)
# - Network-layer DDoS Attack Protection: Enabled

# ─── Speed Optimization Settings ───
# Speed → Optimization → Content:
# - Auto Minify: HTML ✓, CSS ✓, JavaScript ✓
# - Brotli: ON
# - HTTP/2: ON
# - HTTP/3 (QUIC): ON
# - 0-RTT Connection Resumption: ON
# Speed → Optimization → Images:
# - Polish: Lossless
# - WebP: ON
# - Mirage: ON (Pro+)
