/**
 * CF Blog CMS - Main Cloudflare Pages Function
 * Handles SSR blog pages + Admin + API
 */

// ═══════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════

async function hashPassword(password) {
  const enc = new TextEncoder();
  const data = enc.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || '0.0.0.0';
}

function getSessionToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/cf_session=([^;]+)/);
  return match ? match[1] : null;
}

async function validateSession(env, token) {
  if (!token) return null;
  try {
    const data = await env.SESSIONS.get(`session:${token}`, { type: 'json' });
    if (!data) return null;
    if (Date.now() > data.expires) {
      await env.SESSIONS.delete(`session:${token}`);
      return null;
    }
    return data;
  } catch { return null; }
}

async function createSession(env, username) {
  const token = crypto.randomUUID();
  const data = { username, expires: Date.now() + 86400 * 1000 * 7 }; // 7 days
  await env.SESSIONS.put(`session:${token}`, JSON.stringify(data), { expirationTtl: 86400 * 7 });
  return token;
}

async function getSetting(db, key, defaultVal = '') {
  try {
    const r = await db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
    return r ? r.value : defaultVal;
  } catch { return defaultVal; }
}

async function getSettings(db, keys) {
  const results = {};
  for (const key of keys) { results[key] = await getSetting(db, key); }
  return results;
}

async function setSetting(db, key, value) {
  await db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind(key, String(value)).run();
}

function slugify(text) {
  return text.toString().toLowerCase().trim()
    .replace(/\s+/g, '-').replace(/[^\w\-가-힣]/g, '').replace(/\-\-+/g, '-')
    .replace(/^-+/, '').replace(/-+$/, '') || String(Date.now());
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function formatDate(ts, locale = 'ko-KR') {
  if (!ts) return '';
  const d = new Date(typeof ts === 'string' ? parseInt(ts) * 1000 : ts * 1000);
  return d.toLocaleDateString(locale, { year:'numeric', month:'long', day:'numeric' });
}

function formatDateISO(ts) {
  if (!ts) return '';
  return new Date(parseInt(ts) * 1000).toISOString();
}

// Track stats
async function trackPageview(db, ip, page) {
  const today = new Date().toISOString().slice(0, 10);
  await db.prepare('INSERT INTO stats (ip,page,date) VALUES (?,?,?)').bind(ip, page, today).run();
}

// ═══════════════════════════════════════════════
// TABLE OF CONTENTS GENERATOR
// ═══════════════════════════════════════════════

function generateTOC(html) {
  const items = [];
  const regex = /<(h[234])[^>]*>(.*?)<\/h[234]>/gi;
  let match;
  let counter = 0;
  let processedHtml = html;

  // Collect headings and add IDs
  const allMatches = [];
  while ((match = regex.exec(html)) !== null) {
    counter++;
    const level = parseInt(match[1][1]);
    const text = match[2].replace(/<[^>]+>/g, '');
    const id = `toc-${counter}-${slugify(text).slice(0, 40)}`;
    allMatches.push({ full: match[0], tag: match[1], text, id, level });
  }

  for (const m of allMatches) {
    items.push({ text: m.text, id: m.id, level: m.level });
    const newTag = m.full.replace(`<${m.tag}`, `<${m.tag} id="${m.id}"`);
    processedHtml = processedHtml.replace(m.full, newTag);
  }

  if (items.length < 2) return { toc: '', html: processedHtml };

  let tocHtml = `<div class="cf-toc" id="cf-toc-container">
  <div class="cf-toc-header" onclick="document.getElementById('cf-toc-list').classList.toggle('cf-toc-collapsed')">
    <span>📋 목차</span><span class="cf-toc-toggle">▲</span>
  </div>
  <div id="cf-toc-list" class="cf-toc-list">
    <ol>`;

  let prevLevel = items[0].level;
  for (const item of items) {
    if (item.level > prevLevel) tocHtml += '<ol>';
    else if (item.level < prevLevel) tocHtml += '</ol>';
    tocHtml += `<li><a href="#${item.id}">${escHtml(item.text)}</a></li>`;
    prevLevel = item.level;
  }
  tocHtml += `</ol></div></div>`;

  return { toc: tocHtml, html: processedHtml };
}

// ═══════════════════════════════════════════════
// ADSENSE INVALID TRAFFIC BLOCKING
// ═══════════════════════════════════════════════

async function checkAdBlock(db, ip) {
  try {
    const row = await db.prepare('SELECT * FROM adsense_clicks WHERE ip=?').bind(ip).first();
    if (!row) return false;
    if (row.blocked && row.unblock_at && parseInt(row.unblock_at) > Math.floor(Date.now() / 1000)) {
      return true;
    }
    if (row.blocked && row.unblock_at && parseInt(row.unblock_at) <= Math.floor(Date.now() / 1000)) {
      await db.prepare('UPDATE adsense_clicks SET blocked=0,blocked_at=NULL,unblock_at=NULL,click_count=0 WHERE ip=?').bind(ip).run();
      return false;
    }
    return false;
  } catch { return false; }
}

async function recordAdClick(db, ip, maxClicks, timeWindow) {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare('SELECT * FROM adsense_clicks WHERE ip=?').bind(ip).first();

  if (!row) {
    await db.prepare('INSERT INTO adsense_clicks (ip,click_count,first_click,last_click) VALUES (?,1,?,?)').bind(ip, now, now).run();
    return false;
  }

  const windowSec = parseInt(timeWindow) * 60;
  const resetNeeded = (now - parseInt(row.first_click)) > windowSec;

  if (resetNeeded) {
    await db.prepare('UPDATE adsense_clicks SET click_count=1,first_click=?,last_click=? WHERE ip=?').bind(now, now, ip).run();
    return false;
  }

  const newCount = parseInt(row.click_count) + 1;
  await db.prepare('UPDATE adsense_clicks SET click_count=?,last_click=? WHERE ip=?').bind(newCount, now, ip).run();

  if (newCount >= parseInt(maxClicks)) {
    const unblockAt = now + (7 * 24 * 3600);
    await db.prepare('UPDATE adsense_clicks SET blocked=1,blocked_at=?,unblock_at=? WHERE ip=?').bind(now, unblockAt, ip).run();
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════
// HTML TEMPLATES
// ═══════════════════════════════════════════════

async function getBaseSettings(db) {
  return getSettings(db, ['site_title','site_description','adsense_client','adsense_slot','header_code','toc_enabled','naver_verification','google_verification','analytics_id']);
}

function renderHead(settings, title, meta = {}) {
  const pageTitle = title ? `${escHtml(title)} - ${escHtml(settings.site_title)}` : escHtml(settings.site_title);
  const desc = meta.description || escHtml(settings.site_description);
  const canonical = meta.canonical || '';
  const thumbnail = meta.thumbnail || '';

  return `<!DOCTYPE html>
<html lang="ko" class="${meta.bodyClass || 'home'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${pageTitle}</title>
${desc ? `<meta name="description" content="${escHtml(desc)}">` : ''}
${meta.keywords ? `<meta name="keywords" content="${escHtml(meta.keywords)}">` : ''}
${canonical ? `<link rel="canonical" href="${escHtml(canonical)}">` : ''}
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">
${settings.google_verification ? `<meta name="google-site-verification" content="${escHtml(settings.google_verification)}">` : ''}
${settings.naver_verification ? `<meta name="naver-site-verification" content="${escHtml(settings.naver_verification)}">` : ''}
${meta.og ? `
<meta property="og:type" content="${meta.og.type || 'website'}">
<meta property="og:url" content="${escHtml(canonical)}">
<meta property="og:title" content="${escHtml(meta.og.title || pageTitle)}">
<meta property="og:description" content="${escHtml(meta.og.description || desc)}">
<meta property="og:site_name" content="${escHtml(settings.site_title)}">
${thumbnail ? `<meta property="og:image" content="${escHtml(thumbnail)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(meta.og.title || pageTitle)}">
<meta name="twitter:description" content="${escHtml(meta.og.description || desc)}">
${thumbnail ? `<meta name="twitter:image" content="${escHtml(thumbnail)}">` : ''}
` : ''}
${meta.articleMeta || ''}
${meta.schemas || ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Gowun+Dodum&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/generatepress.css">
<link rel="stylesheet" href="/assets/theme.css">
${settings.header_code || ''}
${settings.analytics_id ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${escHtml(settings.analytics_id)}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${escHtml(settings.analytics_id)}');</script>` : ''}
</head>`;
}

function renderHeader(settings, currentPath = '/') {
  const navItems = [
    { href: '/', label: '홈' },
    { href: '/category', label: '카테고리' },
  ];
  const navHtml = navItems.map(item =>
    `<li class="menu-item${currentPath === item.href ? ' current-menu-item' : ''}"><a href="${item.href}">${item.label}</a></li>`
  ).join('');

  return `<header class="site-header">
  <div class="inside-header grid-container grid-parent">
    <div class="site-branding">
      <a href="/" class="custom-logo-link" title="${escHtml(settings.site_title)}">
        <span class="site-title"><a href="/">${escHtml(settings.site_title)}</a></span>
      </a>
    </div>
  </div>
</header>
<nav class="main-navigation" id="primary-navigation" aria-label="기본 내비게이션">
  <div class="inside-navigation grid-container grid-parent">
    <div class="navigation-branding"></div>
    <button class="menu-toggle" aria-controls="primary-menu" aria-expanded="false" onclick="this.setAttribute('aria-expanded',this.getAttribute('aria-expanded')==='true'?'false':'true');document.getElementById('primary-menu').classList.toggle('toggled')">
      <span class="screen-reader-text">메뉴</span>
      <div class="menu-toggle-icon"><span></span><span></span><span></span></div>
    </button>
    <ul id="primary-menu" class="sf-menu">
      ${navHtml}
    </ul>
    <div class="nav-search">
      <button class="search-toggle" onclick="document.getElementById('cf-search-modal').classList.toggle('active')" aria-label="검색">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      </button>
    </div>
  </div>
</nav>
<div id="cf-search-modal" class="cf-search-modal">
  <div class="cf-search-inner">
    <input type="text" id="cf-search-input" placeholder="검색어 입력..." oninput="cfSearch(this.value)">
    <button onclick="document.getElementById('cf-search-modal').classList.remove('active')">✕</button>
  </div>
  <div id="cf-search-results"></div>
</div>`;
}

function renderFooter(settings) {
  const year = new Date().getFullYear();
  return `<footer class="site-footer">
  <div class="inside-site-info grid-container grid-parent">
    <div class="copyright-bar">
      <span>© ${year} <a href="/">${escHtml(settings.site_title)}</a>. All Rights Reserved.</span>
    </div>
  </div>
</footer>
<button class="back-to-top" id="back-to-top" onclick="window.scrollTo({top:0,behavior:'smooth'})">↑</button>
<script>
window.addEventListener('scroll',function(){
  document.getElementById('back-to-top').classList.toggle('visible', window.scrollY > 300);
});
function cfSearch(q) {
  if (q.length < 2) { document.getElementById('cf-search-results').innerHTML=''; return; }
  fetch('/api/search?q=' + encodeURIComponent(q))
    .then(r=>r.json()).then(d=>{
      const el = document.getElementById('cf-search-results');
      if (!d.results || !d.results.length) { el.innerHTML='<p class="no-results">검색 결과가 없습니다.</p>'; return; }
      el.innerHTML = d.results.map(p=>\`<a href="/\${p.slug}" class="cf-search-result-item"><strong>\${p.title}</strong><span>\${p.excerpt||''}</span></a>\`).join('');
    });
}
// TOC toggle
document.addEventListener('DOMContentLoaded',function(){
  const toc = document.getElementById('cf-toc-container');
  if (toc) {
    const toggle = toc.querySelector('.cf-toc-toggle');
    const list = document.getElementById('cf-toc-list');
    toc.querySelector('.cf-toc-header').addEventListener('click',function(){
      const collapsed = list.classList.toggle('cf-toc-collapsed');
      if (toggle) toggle.textContent = collapsed ? '▼' : '▲';
    });
  }
});
</script>`;
}

function renderAdsense(settings, adBlocked) {
  if (adBlocked || !settings.adsense_client || !settings.adsense_slot) return '';
  return `<div class="cf-adsense-wrap">
<ins class="adsbygoogle" style="display:block" data-ad-client="${escHtml(settings.adsense_client)}" data-ad-slot="${escHtml(settings.adsense_slot)}" data-ad-format="auto" data-full-width-responsive="true"></ins>
<script>(adsbygoogle=window.adsbygoogle||[]).push({});</script>
</div>`;
}

// Blog index page
async function renderBlogIndex(db, settings, page = 1, categoryId = null, adBlocked = false) {
  const perPage = 9;
  const offset = (page - 1) * perPage;

  let query, countQuery;
  if (categoryId) {
    query = db.prepare('SELECT * FROM posts WHERE status="publish" AND category_id=? ORDER BY published_at DESC LIMIT ? OFFSET ?').bind(categoryId, perPage, offset);
    countQuery = db.prepare('SELECT COUNT(*) as cnt FROM posts WHERE status="publish" AND category_id=?').bind(categoryId);
  } else {
    query = db.prepare('SELECT * FROM posts WHERE status="publish" ORDER BY published_at DESC LIMIT ? OFFSET ?').bind(perPage, offset);
    countQuery = db.prepare('SELECT COUNT(*) as cnt FROM posts WHERE status="publish"');
  }

  const [posts, countRow] = await Promise.all([query.all(), countQuery.first()]);
  const total = countRow?.cnt || 0;
  const totalPages = Math.ceil(total / perPage);

  let catName = '';
  if (categoryId) {
    const cat = await db.prepare('SELECT name FROM categories WHERE id=?').bind(categoryId).first();
    catName = cat?.name || '';
  }

  const adsenseScript = (settings.adsense_client && !adBlocked) ?
    `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${escHtml(settings.adsense_client)}" crossorigin="anonymous"></script>` : '';

  const postsHtml = (posts.results || []).map(p => {
    const thumb = p.thumbnail_url ? `<div class="post-image"><a href="/${escHtml(p.slug)}"><img src="${escHtml(p.thumbnail_url)}" alt="${escHtml(p.title)}" loading="lazy" width="700" height="400"></a></div>` : '';
    const excerpt = p.excerpt || p.content.replace(/<[^>]+>/g, '').slice(0, 80) + '...';
    const date = formatDate(p.published_at);
    return `<article class="post type-post has-post-thumbnail">
  <div class="inside-article">
    ${thumb}
    <header class="entry-header">
      <h2 class="entry-title"><a href="/${escHtml(p.slug)}">${escHtml(p.title)}</a></h2>
      <div class="entry-meta"><span class="posted-on">${date}</span></div>
    </header>
    <div class="entry-summary"><p>${escHtml(excerpt)}</p></div>
    <footer class="entry-footer">
      <a class="read-more" href="/${escHtml(p.slug)}">더 읽기</a>
    </footer>
  </div>
</article>`;
  }).join('\n');

  // Pagination
  let paginationHtml = '';
  if (totalPages > 1) {
    const base = categoryId ? `/category/${categoryId}` : '';
    paginationHtml = `<nav id="nav-below" class="paging-navigation"><div class="page-numbers-wrapper">`;
    for (let i = 1; i <= totalPages; i++) {
      if (i === page) paginationHtml += `<span class="page-numbers current">${i}</span>`;
      else paginationHtml += `<a class="page-numbers" href="${base}?page=${i}">${i}</a>`;
    }
    paginationHtml += `</div></nav>`;
  }

  const head = renderHead(settings, catName || '', { bodyClass: 'home separate-containers' });
  const header = renderHeader(settings, '/');
  const footer = renderFooter(settings);

  return `${head}
<body class="home separate-containers">
${adsenseScript}
${header}
<div class="site grid-container container hfeed" id="page">
  <div class="site-content" id="content">
    <div class="content-area" id="primary">
      ${catName ? `<header class="page-header"><h1 class="page-title">${escHtml(catName)}</h1></header>` : ''}
      <div class="blog-layout-column-3">
        ${postsHtml || '<p class="no-posts">게시물이 없습니다.</p>'}
      </div>
      ${paginationHtml}
    </div>
  </div>
</div>
${renderAdsense(settings, adBlocked)}
${footer}
<script>
// Adsense click tracking
document.addEventListener('click', function(e) {
  const ad = e.target.closest('ins.adsbygoogle');
  if (ad) {
    fetch('/api/adsense-click', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({}) });
  }
});
</script>
</body></html>`;
}

// Single post page
async function renderSinglePost(db, settings, post, prevPost, nextPost, adBlocked = false) {
  const adsenseScript = (settings.adsense_client && !adBlocked) ?
    `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${escHtml(settings.adsense_client)}" crossorigin="anonymous"></script>` : '';

  // TOC
  let tocHtml = '';
  let content = post.content;
  if (settings.toc_enabled === '1') {
    const result = generateTOC(content);
    tocHtml = result.toc;
    content = result.html;
  }

  // Schema markup
  let schemasHtml = '';
  try {
    const schemas = JSON.parse(post.schemas || '[]');
    for (const s of schemas) {
      if (s.json) schemasHtml += `<script type="application/ld+json">\n${s.json}\n</script>`;
    }
  } catch {}

  // Date meta
  const pubDate = formatDateISO(post.published_at);
  const articleMeta = pubDate ? `<meta property="article:published_time" content="${pubDate}">` : '';

  const head = renderHead(settings, post.seo_title || post.title, {
    bodyClass: 'single separate-containers',
    description: post.meta_desc,
    keywords: post.focus_keyword,
    canonical: `${settings.site_url || ''}/${post.slug}`,
    thumbnail: post.thumbnail_url,
    schemas: schemasHtml,
    articleMeta,
    og: {
      type: 'article',
      title: post.seo_title || post.title,
      description: post.meta_desc,
    }
  });

  const header = renderHeader(settings, `/${post.slug}`);
  const footer = renderFooter(settings);

  const thumb = post.thumbnail_url ?
    `<div class="post-thumbnail"><img src="${escHtml(post.thumbnail_url)}" alt="${escHtml(post.title)}" width="900" height="500" loading="eager"></div>` : '';

  const navHtml = `<nav id="nav-below" class="post-navigation">
    <div class="nav-previous">${prevPost ? `<div class="prev"><a href="/${escHtml(prevPost.slug)}">${escHtml(prevPost.title)}</a></div>` : ''}</div>
    <div class="nav-next">${nextPost ? `<div class="next"><a href="/${escHtml(nextPost.slug)}">${escHtml(nextPost.title)}</a></div>` : ''}</div>
  </nav>`;

  return `${head}
<body class="single separate-containers">
${adsenseScript}
${header}
<div class="site grid-container container" id="page">
  <div class="site-content" id="content">
    <div class="content-area" id="primary">
      <main id="main" class="site-main">
        <article class="post type-post status-publish">
          <div class="inside-article">
            ${thumb}
            <header class="entry-header">
              <h1 class="entry-title single-content-title">${escHtml(post.title)}</h1>
              <div class="entry-meta">
                <span class="posted-on">${formatDate(post.published_at)}</span>
              </div>
            </header>
            ${renderAdsense(settings, adBlocked)}
            ${tocHtml}
            <div class="entry-content">
              ${content}
            </div>
            ${renderAdsense(settings, adBlocked)}
            ${navHtml}
          </div>
        </article>
      </main>
    </div>
  </div>
</div>
${footer}
<script>
document.addEventListener('click', function(e) {
  const ad = e.target.closest('ins.adsbygoogle');
  if (ad) {
    fetch('/api/adsense-click', { method: 'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
  }
});
</script>
</body></html>`;
}

// ═══════════════════════════════════════════════
// ADMIN HTML TEMPLATES
// ═══════════════════════════════════════════════

function renderAdminShell(title, content, activePage = '') {
  const nav = [
    { href: '/cf-admin', icon: '📊', label: '대시보드', key: 'dashboard' },
    { href: '/cf-admin/stats', icon: '📈', label: '통계', key: 'stats' },
    { href: '/cf-admin/posts', icon: '📝', label: '글 목록', key: 'posts' },
    { href: '/cf-admin/posts/new', icon: '✏️', label: '글 추가', key: 'new-post' },
    { href: '/cf-admin/categories', icon: '🗂️', label: '카테고리', key: 'categories' },
    { href: '/cf-admin/aibp-settings', icon: '🤖', label: 'AIBP 설정', key: 'aibp' },
    { href: '/cf-admin/settings', icon: '⚙️', label: '설정', key: 'settings' },
    { href: '/cf-admin/adsense', icon: '🛡️', label: '애드센스 차단', key: 'adsense' },
  ];
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)} - 관리자</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/admin.css">
<link rel="stylesheet" href="/assets/aibp-pro.css">
</head>
<body class="admin-body">
<div class="admin-wrap">
  <aside class="admin-sidebar">
    <div class="admin-logo"><a href="/cf-admin">⚡ CF Blog</a></div>
    <nav class="admin-nav">
      ${nav.map(n => `<a href="${n.href}" class="admin-nav-item${activePage === n.key ? ' active' : ''}"><span>${n.icon}</span>${n.label}</a>`).join('')}
    </nav>
    <div class="admin-sidebar-bottom">
      <a href="/" class="admin-nav-item" target="_blank"><span>🌐</span>블로그 보기</a>
      <a href="/cf-admin/logout" class="admin-nav-item"><span>🚪</span>로그아웃</a>
    </div>
  </aside>
  <main class="admin-main">
    <div class="admin-topbar"><h1 class="admin-page-title">${escHtml(title)}</h1></div>
    <div class="admin-content">
      ${content}
    </div>
  </main>
</div>
<script src="/assets/admin.js"></script>
</body></html>`;
}

// Login page
function renderLoginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow">
<title>관리자 로그인</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/admin.css">
</head>
<body class="login-body">
<div class="login-wrap">
  <div class="login-box">
    <div class="login-logo">⚡ CF Blog</div>
    <h1>관리자 로그인</h1>
    ${error ? `<div class="login-error">⚠️ ${escHtml(error)}</div>` : ''}
    <form method="POST" action="/cf-login">
      <div class="login-field">
        <label>사용자명</label>
        <input type="text" name="username" autofocus required>
      </div>
      <div class="login-field">
        <label>비밀번호</label>
        <input type="password" name="password" required>
      </div>
      <button type="submit" class="login-btn">로그인</button>
    </form>
  </div>
</div>
</body></html>`;
}

// Dashboard page content
async function renderDashboard(db) {
  const today = new Date().toISOString().slice(0, 10);
  const [publishedCount, draftCount, trashCount, catCount, todayViews, totalViews] = await Promise.all([
    db.prepare('SELECT COUNT(*) as c FROM posts WHERE status="publish"').first(),
    db.prepare('SELECT COUNT(*) as c FROM posts WHERE status="draft"').first(),
    db.prepare('SELECT COUNT(*) as c FROM posts WHERE status="trash"').first(),
    db.prepare('SELECT COUNT(*) as c FROM categories').first(),
    db.prepare('SELECT COUNT(*) as c FROM stats WHERE date=?').bind(today).first(),
    db.prepare('SELECT COUNT(*) as c FROM stats').first(),
  ]);
  const recentPosts = await db.prepare('SELECT id,title,slug,status,published_at FROM posts WHERE status!="trash" ORDER BY updated_at DESC LIMIT 5').all();

  return `
<div class="admin-cards">
  <div class="admin-card"><div class="card-icon">📝</div><div class="card-info"><span class="card-num">${publishedCount?.c||0}</span><span class="card-label">발행된 글</span></div></div>
  <div class="admin-card"><div class="card-icon">📋</div><div class="card-info"><span class="card-num">${draftCount?.c||0}</span><span class="card-label">임시글</span></div></div>
  <div class="admin-card"><div class="card-icon">👁️</div><div class="card-info"><span class="card-num">${todayViews?.c||0}</span><span class="card-label">오늘 조회수</span></div></div>
  <div class="admin-card"><div class="card-icon">🗂️</div><div class="card-info"><span class="card-num">${catCount?.c||0}</span><span class="card-label">카테고리</span></div></div>
  <div class="admin-card"><div class="card-icon">📊</div><div class="card-info"><span class="card-num">${totalViews?.c||0}</span><span class="card-label">전체 페이지뷰</span></div></div>
</div>
<div class="admin-section">
  <h2>최근 글</h2>
  <table class="admin-table">
    <thead><tr><th>제목</th><th>상태</th><th>발행일</th><th>작업</th></tr></thead>
    <tbody>
      ${(recentPosts.results||[]).map(p=>`
      <tr>
        <td><a href="/cf-admin/posts/${p.id}/edit">${escHtml(p.title)}</a></td>
        <td><span class="status-badge status-${p.status}">${p.status==='publish'?'발행':'임시저장'}</span></td>
        <td>${formatDate(p.published_at)}</td>
        <td>
          <a href="/cf-admin/posts/${p.id}/edit" class="btn-sm">편집</a>
          <a href="/${escHtml(p.slug)}" class="btn-sm" target="_blank">보기</a>
        </td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>`;
}

// Stats page
async function renderStats(db) {
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  const thisYear = today.slice(0, 4);

  const [todayPv, todayV, monthPv, monthV, yearPv, yearV, totalPv, totalV, recent] = await Promise.all([
    db.prepare('SELECT COUNT(*) as c FROM stats WHERE date=?').bind(today).first(),
    db.prepare('SELECT COUNT(DISTINCT ip) as c FROM stats WHERE date=?').bind(today).first(),
    db.prepare('SELECT COUNT(*) as c FROM stats WHERE date LIKE ?').bind(thisMonth+'%').first(),
    db.prepare('SELECT COUNT(DISTINCT ip) as c FROM stats WHERE date LIKE ?').bind(thisMonth+'%').first(),
    db.prepare('SELECT COUNT(*) as c FROM stats WHERE date LIKE ?').bind(thisYear+'%').first(),
    db.prepare('SELECT COUNT(DISTINCT ip) as c FROM stats WHERE date LIKE ?').bind(thisYear+'%').first(),
    db.prepare('SELECT COUNT(*) as c FROM stats').first(),
    db.prepare('SELECT COUNT(DISTINCT ip) as c FROM stats').first(),
    db.prepare('SELECT date, COUNT(*) as pv, COUNT(DISTINCT ip) as uv FROM stats GROUP BY date ORDER BY date DESC LIMIT 30').all(),
  ]);

  const tableRows = (recent.results||[]).map(r=>
    `<tr><td>${r.date}</td><td>${r.pv}</td><td>${r.uv}</td></tr>`
  ).join('');

  return `
<div class="admin-cards">
  <div class="admin-card"><div class="card-icon">📅</div><div class="card-info"><span class="card-num">${todayPv?.c||0}</span><span class="card-label">오늘 페이지뷰</span></div></div>
  <div class="admin-card"><div class="card-icon">👥</div><div class="card-info"><span class="card-num">${todayV?.c||0}</span><span class="card-label">오늘 방문자</span></div></div>
  <div class="admin-card"><div class="card-icon">📆</div><div class="card-info"><span class="card-num">${monthPv?.c||0}</span><span class="card-label">이번달 페이지뷰</span></div></div>
  <div class="admin-card"><div class="card-icon">👤</div><div class="card-info"><span class="card-num">${monthV?.c||0}</span><span class="card-label">이번달 방문자</span></div></div>
  <div class="admin-card"><div class="card-icon">🗓️</div><div class="card-info"><span class="card-num">${yearPv?.c||0}</span><span class="card-label">연간 페이지뷰</span></div></div>
  <div class="admin-card"><div class="card-icon">👫</div><div class="card-info"><span class="card-num">${yearV?.c||0}</span><span class="card-label">연간 방문자</span></div></div>
  <div class="admin-card"><div class="card-icon">📊</div><div class="card-info"><span class="card-num">${totalPv?.c||0}</span><span class="card-label">전체 페이지뷰</span></div></div>
  <div class="admin-card"><div class="card-icon">🌍</div><div class="card-info"><span class="card-num">${totalV?.c||0}</span><span class="card-label">전체 방문자</span></div></div>
</div>
<div class="admin-section">
  <h2>최근 30일 통계</h2>
  <table class="admin-table">
    <thead><tr><th>날짜</th><th>페이지뷰</th><th>순 방문자</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
</div>`;
}

// Posts list page
async function renderPostsList(db, status = 'all', page = 1) {
  const perPage = 20;
  const offset = (page - 1) * perPage;
  let where = status !== 'all' ? `WHERE p.status='${status}'` : `WHERE p.status != 'trash'`;
  let countWhere = status !== 'all' ? `WHERE status='${status}'` : `WHERE status != 'trash'`;

  const [posts, countRow, cats] = await Promise.all([
    db.prepare(`SELECT p.*, c.name as cat_name FROM posts p LEFT JOIN categories c ON p.category_id=c.id ${where} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`).bind(perPage, offset).all(),
    db.prepare(`SELECT COUNT(*) as cnt FROM posts ${countWhere}`).first(),
    db.prepare('SELECT id,name FROM categories').all(),
  ]);

  const total = countRow?.cnt || 0;
  const totalPages = Math.ceil(total / perPage);

  const tabs = [
    { s: 'all', label: '전체' },
    { s: 'publish', label: '발행됨' },
    { s: 'draft', label: '임시저장' },
    { s: 'scheduled', label: '예약됨' },
    { s: 'trash', label: '휴지통' },
  ];

  let pagination = '';
  if (totalPages > 1) {
    pagination = '<div class="pagination">';
    for (let i = 1; i <= totalPages; i++) {
      pagination += `<a href="/cf-admin/posts?status=${status}&page=${i}" class="${i===page?'active':''}">${i}</a>`;
    }
    pagination += '</div>';
  }

  return `
<div class="admin-tabs">
  ${tabs.map(t=>`<a href="/cf-admin/posts?status=${t.s}" class="admin-tab${status===t.s||(!status&&t.s==='all')?' active':''}">${t.label}</a>`).join('')}
</div>
<div class="admin-toolbar">
  <a href="/cf-admin/posts/new" class="btn-primary">+ 새 글 작성</a>
</div>
<table class="admin-table">
  <thead><tr><th>제목</th><th>카테고리</th><th>상태</th><th>발행일</th><th>작업</th></tr></thead>
  <tbody>
    ${(posts.results||[]).map(p=>`
    <tr>
      <td><a href="/cf-admin/posts/${p.id}/edit">${escHtml(p.title)||'(제목 없음)'}</a></td>
      <td>${escHtml(p.cat_name||'-')}</td>
      <td><span class="status-badge status-${p.status}">${{publish:'발행',draft:'임시저장',scheduled:'예약',trash:'휴지통'}[p.status]||p.status}</span></td>
      <td>${formatDate(p.published_at||p.updated_at)}</td>
      <td class="actions">
        ${p.status!=='trash'?`<a href="/cf-admin/posts/${p.id}/edit" class="btn-sm">편집</a>
        <a href="/${p.slug}" class="btn-sm" target="_blank">보기</a>
        <button onclick="trashPost(${p.id})" class="btn-sm btn-danger">삭제</button>`
        :`<button onclick="restorePost(${p.id})" class="btn-sm">복원</button>
        <button onclick="deletePost(${p.id})" class="btn-sm btn-danger">영구삭제</button>`}
      </td>
    </tr>`).join('')}
  </tbody>
</table>
${pagination}
<script>
function trashPost(id){if(confirm('휴지통으로 이동할까요?'))fetch('/api/admin/posts/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'trash'})}).then(()=>location.reload());}
function restorePost(id){fetch('/api/admin/posts/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'draft'})}).then(()=>location.reload());}
function deletePost(id){if(confirm('영구 삭제할까요? 복구할 수 없습니다.'))fetch('/api/admin/posts/'+id,{method:'DELETE'}).then(()=>location.reload());}
</script>`;
}

// Post editor page
async function renderPostEditor(db, postId = null) {
  let post = { id: null, title: '', slug: '', content: '', excerpt: '', status: 'draft',
    category_id: 0, thumbnail_url: '', seo_title: '', meta_desc: '', focus_keyword: '',
    custom_slug: '', schemas: '[]', scheduled_at: null };

  if (postId) {
    const row = await db.prepare('SELECT * FROM posts WHERE id=?').bind(postId).first();
    if (row) post = row;
  }

  const cats = await db.prepare('SELECT id,name FROM categories').all();
  const catOptions = (cats.results||[]).map(c=>
    `<option value="${c.id}" ${post.category_id==c.id?'selected':''}>${escHtml(c.name)}</option>`
  ).join('');

  const scheduledVal = post.scheduled_at ?
    new Date(parseInt(post.scheduled_at)*1000).toISOString().slice(0,16) : '';

  let schemasJson = '[]';
  try { JSON.parse(post.schemas || '[]'); schemasJson = post.schemas || '[]'; } catch {}

  return `
<div class="editor-wrap">
  <div class="editor-main">
    <input type="text" id="post-title" class="editor-title" placeholder="제목 입력" value="${escHtml(post.title)}">
    <div class="editor-toolbar">
      <button class="editor-mode-btn active" id="visual-btn" onclick="switchEditor('visual')">비주얼</button>
      <button class="editor-mode-btn" id="code-btn" onclick="switchEditor('code')">코드</button>
    </div>
    <div id="visual-editor" class="editor-visual">
      <div class="visual-toolbar">
        <button onclick="execCmd('bold')" title="굵게"><b>B</b></button>
        <button onclick="execCmd('italic')" title="이탤릭"><i>I</i></button>
        <button onclick="execCmd('underline')" title="밑줄"><u>U</u></button>
        <button onclick="execCmd('strikeThrough')" title="취소선"><s>S</s></button>
        <select onchange="execCmd('formatBlock',this.value);this.value=''">
          <option value="">서식</option>
          <option value="p">단락</option>
          <option value="h2">H2</option>
          <option value="h3">H3</option>
          <option value="h4">H4</option>
          <option value="blockquote">인용</option>
          <option value="pre">코드</option>
        </select>
        <button onclick="execCmd('insertOrderedList')">1.</button>
        <button onclick="execCmd('insertUnorderedList')">•</button>
        <button onclick="insertLink()">🔗</button>
        <button onclick="insertImage()">🖼</button>
        <button onclick="execCmd('justifyLeft')">◀</button>
        <button onclick="execCmd('justifyCenter')">■</button>
        <button onclick="execCmd('justifyRight')">▶</button>
        <button onclick="execCmd('undo')">↩</button>
        <button onclick="execCmd('redo')">↪</button>
      </div>
      <div id="visual-content" class="editor-content" contenteditable="true" spellcheck="false">${post.content}</div>
    </div>
    <textarea id="code-editor" class="editor-code" style="display:none">${escHtml(post.content)}</textarea>
    
    <div class="editor-excerpt">
      <label>요약 (자동생성됩니다. 비워도 됩니다)</label>
      <textarea id="post-excerpt" rows="3">${escHtml(post.excerpt)}</textarea>
    </div>
  </div>
  
  <aside class="editor-sidebar">
    <!-- 발행 메타박스 -->
    <div class="metabox">
      <div class="metabox-header">📤 발행</div>
      <div class="metabox-body">
        <div class="field-row">
          <label>상태</label>
          <select id="post-status">
            <option value="draft" ${post.status==='draft'?'selected':''}>임시저장</option>
            <option value="publish" ${post.status==='publish'?'selected':''}>발행</option>
            <option value="scheduled" ${post.status==='scheduled'?'selected':''}>예약</option>
          </select>
        </div>
        <div class="field-row" id="schedule-row" style="display:${post.status==='scheduled'?'block':'none'}">
          <label>예약 날짜/시간</label>
          <input type="datetime-local" id="scheduled-at" value="${scheduledVal}">
        </div>
        <div class="field-row">
          <label>썸네일 URL</label>
          <input type="text" id="thumbnail-url" value="${escHtml(post.thumbnail_url)}" placeholder="https://...">
        </div>
        <div class="field-row">
          <label>카테고리</label>
          <select id="post-category">
            <option value="0">카테고리 없음</option>
            ${catOptions}
          </select>
        </div>
        <div class="field-row">
          <label>슬러그 (URL)</label>
          <input type="text" id="post-slug" value="${escHtml(post.custom_slug || post.slug)}" placeholder="post-url-slug">
        </div>
        <div class="metabox-actions">
          <button id="save-draft-btn" onclick="savePost('draft')" class="btn-secondary">임시저장</button>
          <button id="publish-btn" onclick="savePost(document.getElementById('post-status').value)" class="btn-primary">발행</button>
        </div>
      </div>
    </div>
    
    <!-- AIBP 메타박스 -->
    <div class="metabox" id="aibp-metabox">
      <div class="metabox-header">🤖 AI 블로그 작성기 Pro</div>
      <div class="metabox-body" id="ai-blog-writer-container">
        <!-- 탭 헤더 -->
        <div class="ai-blog-tabs">
          <button type="button" class="ai-blog-tab active" data-tab="content">AI 글쓰기</button>
          <button type="button" class="ai-blog-tab" data-tab="thumbnail">AI 썸네일</button>
        </div>
        
        <!-- AI 글쓰기 탭 -->
        <div class="ai-blog-tab-content active" data-content="content">
          <div class="ai-blog-input-group">
            <label for="ai-blog-topic">주제 키워드</label>
            <input type="text" id="ai-blog-topic" class="ai-blog-input" placeholder="예: 민생회복지원금">
          </div>
          <div class="ai-blog-input-group">
            <label for="ai-blog-type">글 유형</label>
            <select id="ai-blog-type" class="ai-blog-select">
              <option value="informational">정보성</option>
              <option value="utility">유틸리티</option>
              <option value="pasona">수익형</option>
              <option value="policy_guide">정책·공공</option>
              <option value="review_comparison">리뷰·비교</option>
            </select>
          </div>
          <div style="text-align:left;margin-top:6px;">
            <button type="button" id="ai-blog-generate-btn" class="ai-blog-button ai-blog-button--primary">AI 콘텐츠 생성</button>
          </div>
          <div id="ai-blog-progress" class="ai-blog-progress" style="display:none;">
            <div class="ai-blog-progress-bar"><div class="ai-blog-progress-fill"></div></div>
            <div class="ai-blog-progress-text">
              <span class="progress-label">AI 처리 시작 중</span>
              <span class="progress-percent">0%</span>
            </div>
          </div>
          <input type="hidden" id="ai_seo_title" name="ai_seo_title" value="${escHtml(post.seo_title)}">
          <input type="hidden" id="ai_meta_desc" name="ai_meta_desc" value="${escHtml(post.meta_desc)}">
          <input type="hidden" id="ai_slug" name="ai_slug" value="${escHtml(post.custom_slug)}">
          <input type="hidden" id="ai_focus_keyword" name="ai_focus_keyword" value="${escHtml(post.focus_keyword)}">
        </div>
        
        <!-- AI 썸네일 탭 -->
        <div class="ai-blog-tab-content" data-content="thumbnail">
          <div class="ai-blog-input-group">
            <label for="ai-thumb-topic">썸네일 주제</label>
            <input type="text" id="ai-thumb-topic" class="ai-blog-input" placeholder="예: 다이어트 방법">
          </div>
          <div class="ai-blog-input-group">
            <label for="ai-thumb-style">이미지 스타일</label>
            <select id="ai-thumb-style" class="ai-blog-select">
              <option value="poster">포스터</option>
              <option value="minimal">미니멀</option>
              <option value="infographic">인포그래픽</option>
              <option value="photo_realistic">사실적 사진</option>
              <option value="illustration">일러스트</option>
              <option value="typography">타이포그래피</option>
              <option value="bright_gradient">밝은 그라데이션</option>
              <option value="branding">브랜딩</option>
            </select>
          </div>
          <div style="text-align:left;margin-top:6px;">
            <button type="button" id="ai-thumb-generate-btn" class="ai-blog-button ai-blog-button--primary">🖼️ 썸네일 생성</button>
          </div>
          <div id="ai-thumb-progress" style="display:none;margin-top:10px;text-align:center;padding:12px;background:#f7f9ff;border-radius:8px;">
            <div class="aibp-spin-loader"></div>
            <div id="ai-thumb-progress-text" style="margin:8px 0 0;font-size:12px;color:#555;">🔍 Gemini가 주제를 분석 중...</div>
          </div>
          <div id="ai-thumb-preview" style="display:none;margin-top:12px;">
            <img id="ai-thumb-img" src="" alt="썸네일 미리보기" style="width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.15);">
            <p style="font-size:11px;color:#888;margin:6px 0 0;text-align:center;">✅ 대표 이미지 설정 완료</p>
          </div>
          <span id="ai-thumb-status" style="display:block;margin-top:8px;font-size:12px;min-height:16px;"></span>
        </div>
        
        <!-- 스키마 섹션 -->
        <hr style="border:none;border-top:2px solid #f0f0f0;margin:0;">
        <div id="ai-schema-section" style="padding:16px 0 0;">
          <div style="font-size:14px;font-weight:700;color:#262626;margin-bottom:10px;">⭐ AI 스키마 마크업</div>
          <div class="ai-blog-input-group" style="margin-bottom:8px;">
            <select id="ai-schema-type" class="ai-blog-select">
              <option value="">스키마 유형 선택</option>
              <option value="article">기사 (Article)</option>
              <option value="faq">FAQ</option>
              <option value="product_review">상품리뷰</option>
            </select>
          </div>
          <div style="text-align:left;margin-top:6px;">
            <button type="button" id="ai-schema-generate-btn" class="ai-blog-button ai-blog-button--primary" style="margin-top:0;">➕ 스키마 추가 생성</button>
          </div>
          <div id="ai-schema-progress" style="display:none;margin-top:10px;padding:12px;background:#f0f7ff;border-radius:8px;border:1px solid #b3d4f5;">
            <div id="ai-schema-step" style="font-size:12px;font-weight:600;color:#0066cc;">⏳ 스키마 분석 중...</div>
            <div style="margin-top:6px;height:4px;background:#ddeeff;border-radius:4px;overflow:hidden;">
              <div id="ai-schema-progress-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#0095f6,#00d4ff);border-radius:4px;transition:width 0.6s ease;"></div>
            </div>
          </div>
          <div id="ai-schema-list" style="margin-top:10px;"></div>
          <span id="ai-schema-status" style="display:block;margin-top:8px;font-size:12px;min-height:16px;"></span>
        </div>
        
        <div id="ai-blog-result" class="ai-blog-result" style="display:none;margin:0 0 16px;"></div>
      </div>
    </div>
    
    <!-- SEO 메타박스 -->
    <div class="metabox">
      <div class="metabox-header">🔍 SEO 설정</div>
      <div class="metabox-body">
        <div class="field-row">
          <label>SEO 제목 <small class="char-count" id="seo-title-count">0/60</small></label>
          <input type="text" id="seo-title" maxlength="70" value="${escHtml(post.seo_title)}" oninput="countChars(this,'seo-title-count',60)" placeholder="검색결과 제목">
        </div>
        <div class="field-row">
          <label>메타 설명 <small class="char-count" id="meta-desc-count">0/160</small></label>
          <textarea id="meta-desc" rows="3" maxlength="200" oninput="countChars(this,'meta-desc-count',160)" placeholder="검색결과 설명">${escHtml(post.meta_desc)}</textarea>
        </div>
        <div class="field-row">
          <label>포커스 키워드</label>
          <input type="text" id="focus-keyword" value="${escHtml(post.focus_keyword)}" placeholder="메인 키워드">
        </div>
        <div class="seo-preview" id="seo-preview">
          <div class="seo-preview-title" id="seo-preview-title">${escHtml(post.seo_title || post.title)}</div>
          <div class="seo-preview-url" id="seo-preview-url">example.com/${escHtml(post.slug)}</div>
          <div class="seo-preview-desc" id="seo-preview-desc">${escHtml(post.meta_desc)}</div>
        </div>
      </div>
    </div>
  </aside>
</div>

<script>
var POST_ID = ${post.id || 'null'};
var aiBlogWriter = {
  ajaxUrl: '/api/aibp',
  nonce: '${crypto.randomUUID()}',
  postId: ${post.id || 0}
};
</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>
<script src="/assets/aibp-pro.js"></script>
<script src="/assets/editor.js"></script>`;
}

// Categories page
async function renderCategories(db) {
  const cats = await db.prepare('SELECT c.*, COUNT(p.id) as cnt FROM categories c LEFT JOIN posts p ON p.category_id=c.id AND p.status="publish" GROUP BY c.id ORDER BY c.name').all();
  return `
<div class="admin-toolbar"><button onclick="document.getElementById('cat-form').style.display='block'" class="btn-primary">+ 카테고리 추가</button></div>
<div id="cat-form" class="admin-box" style="display:none;margin-bottom:20px;">
  <h3>새 카테고리</h3>
  <div class="field-row"><label>이름</label><input type="text" id="cat-name" placeholder="카테고리 이름"></div>
  <div class="field-row"><label>슬러그</label><input type="text" id="cat-slug" placeholder="category-slug"></div>
  <div class="field-row"><label>설명</label><textarea id="cat-desc" rows="2"></textarea></div>
  <button onclick="addCategory()" class="btn-primary">추가</button>
</div>
<table class="admin-table">
  <thead><tr><th>이름</th><th>슬러그</th><th>글 수</th><th>작업</th></tr></thead>
  <tbody>
    ${(cats.results||[]).map(c=>`
    <tr>
      <td>${escHtml(c.name)}</td>
      <td>${escHtml(c.slug)}</td>
      <td>${c.cnt||0}</td>
      <td>
        <button onclick="editCat(${c.id},'${escHtml(c.name)}')" class="btn-sm">편집</button>
        <button onclick="deleteCat(${c.id})" class="btn-sm btn-danger">삭제</button>
      </td>
    </tr>`).join('')}
  </tbody>
</table>
<script>
function addCategory(){
  const name=document.getElementById('cat-name').value.trim();
  const slug=document.getElementById('cat-slug').value.trim();
  const desc=document.getElementById('cat-desc').value.trim();
  if(!name){alert('이름을 입력하세요');return;}
  fetch('/api/admin/categories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,slug,description:desc})})
  .then(r=>r.json()).then(d=>{if(d.ok)location.reload();else alert(d.error||'오류');});
}
function deleteCat(id){
  if(confirm('삭제할까요?'))
  fetch('/api/admin/categories/'+id,{method:'DELETE'}).then(()=>location.reload());
}
function editCat(id,name){
  const n=prompt('새 이름:',name);
  if(n)fetch('/api/admin/categories/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})}).then(()=>location.reload());
}
</script>`;
}

// Settings page
async function renderSettingsPage(db) {
  const s = await getSettings(db, ['site_title','site_description','adsense_client','adsense_slot',
    'adsense_max_clicks','adsense_time_window','header_code','toc_enabled',
    'naver_verification','google_verification','analytics_id','site_url']);
  return `
<form onsubmit="saveSettings(event)">
  <div class="admin-section">
    <h2>기본 설정</h2>
    <div class="field-row"><label>사이트 제목</label><input type="text" name="site_title" value="${escHtml(s.site_title)}"></div>
    <div class="field-row"><label>사이트 설명</label><input type="text" name="site_description" value="${escHtml(s.site_description)}"></div>
    <div class="field-row"><label>사이트 URL</label><input type="text" name="site_url" value="${escHtml(s.site_url)}" placeholder="https://yourblog.com"></div>
    <div class="field-row"><label>목차(TOC) 자동 생성</label>
      <select name="toc_enabled"><option value="1" ${s.toc_enabled==='1'?'selected':''}>활성화</option><option value="0" ${s.toc_enabled!=='1'?'selected':''}>비활성화</option></select>
    </div>
  </div>
  <div class="admin-section">
    <h2>SEO / Analytics</h2>
    <div class="field-row"><label>Google Analytics ID</label><input type="text" name="analytics_id" value="${escHtml(s.analytics_id)}" placeholder="G-XXXXXXXXXX"></div>
    <div class="field-row"><label>Google 사이트 인증 코드</label><input type="text" name="google_verification" value="${escHtml(s.google_verification)}"></div>
    <div class="field-row"><label>네이버 사이트 인증 코드</label><input type="text" name="naver_verification" value="${escHtml(s.naver_verification)}"></div>
  </div>
  <div class="admin-section">
    <h2>헤더 코드 삽입</h2>
    <p class="desc">모든 페이지 &lt;head&gt; 바로 뒤에 삽입됩니다 (AdSense 코드, 픽셀 등)</p>
    <div class="field-row"><textarea name="header_code" rows="6" style="font-family:monospace">${escHtml(s.header_code)}</textarea></div>
  </div>
  <div class="admin-section">
    <h2>애드센스 설정</h2>
    <div class="field-row"><label>AdSense Client ID</label><input type="text" name="adsense_client" value="${escHtml(s.adsense_client)}" placeholder="ca-pub-XXXXXXXXXXXXXXXX"></div>
    <div class="field-row"><label>Ad Slot ID</label><input type="text" name="adsense_slot" value="${escHtml(s.adsense_slot)}" placeholder="XXXXXXXXXX"></div>
    <div class="field-row"><label>최대 클릭 수 (무효트래픽 감지)</label><input type="number" name="adsense_max_clicks" value="${escHtml(s.adsense_max_clicks)}" min="1" max="100"></div>
    <div class="field-row"><label>감지 시간 (분)</label><input type="number" name="adsense_time_window" value="${escHtml(s.adsense_time_window)}" min="1" max="1440"></div>
  </div>
  <button type="submit" class="btn-primary">설정 저장</button>
</form>
<script>
function saveSettings(e){
  e.preventDefault();
  const form=e.target;
  const data={};
  new FormData(form).forEach((v,k)=>data[k]=v);
  fetch('/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
  .then(r=>r.json()).then(d=>{if(d.ok)showAdminNotice('설정이 저장되었습니다.');else alert(d.error||'오류');});
}
</script>`;
}

// AIBP settings page
async function renderAIBPSettings(db) {
  const s = await getSettings(db, ['gemini_api_key','ai_horde_api_key']);
  const hasGemini = s.gemini_api_key && s.gemini_api_key.length > 0;
  const hasHorde = s.ai_horde_api_key && s.ai_horde_api_key.length > 0;
  return `
<div class="admin-box" style="background:#e8f5e9;border:1px solid #a5d6a7;padding:16px;margin-bottom:20px;border-radius:6px;">
  <h3 style="margin:0 0 8px;color:#2e7d32;">🚀 AIBP Pro v3.7.0 — 자동 적용 기능</h3>
  <ul style="margin:0;padding-left:18px;color:#333;">
    <li>✅ <strong>유사문서 완전 차단</strong> — 매 생성마다 고유 시드로 100% 독창적 콘텐츠</li>
    <li>✅ <strong>3대 검색엔진 SEO 자동 출력</strong> — title/description/OG/canonical 태그 자동 삽입</li>
    <li>✅ <strong>멀티 스키마 완전 지원</strong> — Article+FAQ+Product 동시 누적 적용</li>
    <li>✅ <strong>수익화 최적화</strong> — 애드센스 승인+고단가 광고 문맥 자동 최적화</li>
    <li>✅ <strong>Gemini API 1개 입력</strong> — 내부 자동 재시도로 Rate Limit 극복</li>
  </ul>
</div>
<form onsubmit="saveAIBPSettings(event)">
  <div class="admin-section">
    <h2>🔑 Gemini API 설정</h2>
    <p style="background:#e7f3ff;border-left:4px solid #2271b1;padding:12px;border-radius:4px;">
      <strong>gemini-2.5-flash-lite</strong> 모델 사용<br>
      <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>에서 <strong>무료 API 키 발급</strong>
    </p>
    <div class="field-row">
      <label>Gemini API 키 <span style="color:#d32f2f;">*필수</span></label>
      <input type="text" name="gemini_api_key" value="${escHtml(s.gemini_api_key)}" placeholder="AIzaSy..." style="font-family:monospace">
      ${hasGemini ? '<span style="color:#4caf50;font-weight:600;margin-left:8px;">✅ 설정됨</span>' : '<span style="color:#f44336;font-weight:600;margin-left:8px;">⚠️ 미설정</span>'}
    </div>
  </div>
  <div class="admin-section">
    <h2>🖼️ AI Horde 이미지 생성 설정</h2>
    <p style="background:#e7f3ff;border-left:4px solid #2271b1;padding:12px;border-radius:4px;">
      <a href="https://stablehorde.net/register" target="_blank">AI Horde</a>에서 무료 API 키 발급 (없으면 익명 키로 자동 사용)
    </p>
    <div class="field-row">
      <label>AI Horde API 키 <small>(선택)</small></label>
      <input type="text" name="ai_horde_api_key" value="${escHtml(s.ai_horde_api_key)}" placeholder="AI Horde API 키" style="font-family:monospace">
      ${hasHorde ? '<span style="color:#4caf50;font-weight:600;margin-left:8px;">✅ 설정됨</span>' : '<span style="color:#ff9800;font-weight:600;margin-left:8px;">⚠️ 익명 키 사용 중</span>'}
    </div>
  </div>
  <button type="submit" class="btn-primary">설정 저장</button>
</form>
<script>
function saveAIBPSettings(e){
  e.preventDefault();
  const data={};
  new FormData(e.target).forEach((v,k)=>data[k]=v);
  fetch('/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
  .then(r=>r.json()).then(d=>{if(d.ok)showAdminNotice('AIBP 설정이 저장되었습니다.');else alert(d.error||'오류');});
}
</script>`;
}

// AdSense block management page
async function renderAdsensePage(db) {
  const blocked = await db.prepare('SELECT * FROM adsense_clicks WHERE blocked=1 ORDER BY blocked_at DESC').all();
  const now = Math.floor(Date.now() / 1000);
  const rows = (blocked.results||[]).map(r => {
    const unblockDate = r.unblock_at ? new Date(parseInt(r.unblock_at)*1000).toLocaleString('ko-KR') : '-';
    return `<tr>
      <td>${escHtml(r.ip)}</td>
      <td>${r.click_count}</td>
      <td>${r.blocked_at ? new Date(parseInt(r.blocked_at)*1000).toLocaleString('ko-KR') : '-'}</td>
      <td>${unblockDate}</td>
      <td><button onclick="unblockIP('${escHtml(r.ip)}')" class="btn-sm">차단 해제</button></td>
    </tr>`;
  }).join('');
  return `
<div class="admin-section">
  <h2>🛡️ 무효트래픽 차단 IP 목록</h2>
  <p>차단된 IP에서는 AdSense 광고가 표시되지 않습니다. 7일 후 자동 해제됩니다.</p>
  <table class="admin-table">
    <thead><tr><th>IP</th><th>클릭 수</th><th>차단 시각</th><th>자동 해제</th><th>작업</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" style="text-align:center">차단된 IP 없음</td></tr>'}</tbody>
  </table>
</div>
<script>
function unblockIP(ip){
  fetch('/api/admin/adsense-unblock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip})})
  .then(()=>location.reload());
}
</script>`;
}

// ═══════════════════════════════════════════════
// API HANDLERS
// ═══════════════════════════════════════════════

// Gemini API call via Cloudflare Worker
async function callGemini(apiKey, prompt, timeout = 30000) {
  const model = 'gemini-2.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 8192 }
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`Gemini API error: ${resp.status}`);
    const data = await resp.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function getContentGenerationPrompt(topic, type) {
  const seed = Math.random().toString(36).slice(2);
  const typePrompts = {
    informational: `정보성 블로그 글`,
    utility: `실용적인 가이드 글`,
    pasona: `수익형 블로그 글 (문제-공감-해결-제안 구조)`,
    policy_guide: `정책/공공정보 안내 글`,
    review_comparison: `리뷰/비교 글`,
  };
  const typeDesc = typePrompts[type] || '정보성 블로그 글';
  return `아래 주제로 한국어 ${typeDesc}을 작성해주세요. (시드: ${seed})
주제: ${topic}

요구사항:
- H2, H3, H4 태그를 적절히 사용
- 최소 1500자 이상
- SEO 최적화된 구조
- 독창적이고 고품질 콘텐츠
- 완전한 HTML 형식으로 반환 (body 내용만, html/head/body 태그 제외)
- 마지막에 JSON 형식으로 다음 메타정보 포함:
<!-- META_JSON
{
  "seo_title": "SEO 최적화 제목 (60자 이내)",
  "meta_desc": "메타 설명 (160자 이내)",
  "focus_keyword": "포커스 키워드",
  "slug": "url-slug-in-english"
}
-->`;
}

async function handleAIBPRequest(request, db, env) {
  const body = await request.json().catch(() => ({}));
  const action = body.action || '';
  const geminiKey = await getSetting(db, 'gemini_api_key');

  if (!geminiKey && ['ai_blog_generate','ai_blog_generate_schema','ai_blog_generate_image_prompt'].includes(action)) {
    return Response.json({ success: false, data: { message: 'Gemini API 키가 설정되지 않았습니다.' } });
  }

  if (action === 'ai_blog_generate') {
    const topic = body.topic || '';
    const type = body.type || 'informational';
    const postId = body.post_id;
    if (!topic) return Response.json({ success: false, data: { message: '주제를 입력해주세요.' } });

    try {
      const prompt = getContentGenerationPrompt(topic, type);
      const raw = await callGemini(geminiKey, prompt, 120000);

      // Extract meta JSON
      let meta = {};
      const metaMatch = raw.match(/<!-- META_JSON\s*([\s\S]*?)\s*-->/);
      if (metaMatch) {
        try { meta = JSON.parse(metaMatch[1]); } catch {}
      }
      const content = raw.replace(/<!-- META_JSON[\s\S]*?-->/g, '').trim();

      // Auto-save to post if postId provided
      if (postId) {
        const slug = meta.slug || slugify(topic);
        await db.prepare(`UPDATE posts SET content=?,seo_title=?,meta_desc=?,focus_keyword=?,custom_slug=?,updated_at=? WHERE id=?`)
          .bind(content, meta.seo_title||'', meta.meta_desc||'', meta.focus_keyword||'', slug, Math.floor(Date.now()/1000), postId).run();
      }

      return Response.json({ success: true, data: { content, meta } });
    } catch (e) {
      return Response.json({ success: false, data: { message: e.message } });
    }
  }

  if (action === 'ai_blog_expand_content') {
    const content = body.content || '';
    const postId = body.post_id;
    try {
      const prompt = `아래 블로그 글을 더 풍부하고 상세하게 확장해주세요. 기존 내용을 유지하되 새 섹션을 추가하세요. HTML 형식 유지.\n\n${content}`;
      const expanded = await callGemini(geminiKey, prompt, 120000);
      if (postId) {
        await db.prepare('UPDATE posts SET content=?,updated_at=? WHERE id=?')
          .bind(expanded, Math.floor(Date.now()/1000), postId).run();
      }
      return Response.json({ success: true, data: { content: expanded } });
    } catch (e) {
      return Response.json({ success: false, data: { message: e.message } });
    }
  }

  if (action === 'ai_blog_generate_schema') {
    const content = body.content || '';
    const schemaType = body.schema_type || 'article';
    const postId = body.post_id;
    try {
      const schemaPrompts = {
        article: `다음 블로그 글에 맞는 Article 스키마 마크업 JSON-LD를 생성해주세요. JSON 객체만 반환하세요 (script 태그 없이).`,
        faq: `다음 블로그 글의 FAQ 섹션에 맞는 FAQPage 스키마 마크업 JSON-LD를 생성해주세요. JSON 객체만 반환하세요.`,
        product_review: `다음 블로그 글에 맞는 Product Review 스키마 JSON-LD를 생성해주세요. JSON 객체만 반환하세요.`,
      };
      const prompt = `${schemaPrompts[schemaType]||schemaPrompts.article}\n\n글 내용:\n${content.slice(0,3000)}`;
      const raw = await callGemini(geminiKey, prompt, 60000);
      const clean = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
      let json;
      try { json = JSON.parse(clean); } catch { return Response.json({ success: false, data: { message: '스키마 JSON 파싱 오류' } }); }

      const newSchema = { type: schemaType, json: JSON.stringify(json, null, 2) };

      // Merge with existing schemas
      if (postId) {
        const post = await db.prepare('SELECT schemas FROM posts WHERE id=?').bind(postId).first();
        let schemas = [];
        try { schemas = JSON.parse(post?.schemas || '[]'); } catch {}
        schemas.push(newSchema);
        await db.prepare('UPDATE posts SET schemas=?,updated_at=? WHERE id=?')
          .bind(JSON.stringify(schemas), Math.floor(Date.now()/1000), postId).run();
      }

      return Response.json({ success: true, data: { schema: newSchema } });
    } catch (e) {
      return Response.json({ success: false, data: { message: e.message } });
    }
  }

  if (action === 'ai_blog_save_schema_markup') {
    const schemas = body.schemas || [];
    const postId = body.post_id;
    if (postId) {
      await db.prepare('UPDATE posts SET schemas=?,updated_at=? WHERE id=?')
        .bind(JSON.stringify(schemas), Math.floor(Date.now()/1000), postId).run();
    }
    return Response.json({ success: true });
  }

  if (action === 'ai_blog_delete_schema') {
    const index = parseInt(body.index);
    const postId = body.post_id;
    if (postId) {
      const post = await db.prepare('SELECT schemas FROM posts WHERE id=?').bind(postId).first();
      let schemas = [];
      try { schemas = JSON.parse(post?.schemas || '[]'); } catch {}
      schemas.splice(index, 1);
      await db.prepare('UPDATE posts SET schemas=?,updated_at=? WHERE id=?')
        .bind(JSON.stringify(schemas), Math.floor(Date.now()/1000), postId).run();
    }
    return Response.json({ success: true });
  }

  if (action === 'ai_blog_save_seo_meta') {
    const postId = body.post_id;
    if (postId) {
      await db.prepare('UPDATE posts SET seo_title=?,meta_desc=?,focus_keyword=?,custom_slug=?,updated_at=? WHERE id=?')
        .bind(body.seo_title||'', body.meta_desc||'', body.focus_keyword||'', body.slug||'', Math.floor(Date.now()/1000), postId).run();
    }
    return Response.json({ success: true });
  }

  if (action === 'ai_blog_generate_image_prompt') {
    const topic = body.topic || '';
    const style = body.style || 'poster';
    try {
      const prompt = `블로그 썸네일 이미지 생성을 위한 영어 프롬프트를 만들어주세요.
주제: ${topic}
스타일: ${style}
요구: 영어로 된 이미지 프롬프트 1개만 반환. 50단어 이내.`;
      const imagePrompt = await callGemini(geminiKey, prompt, 30000);
      return Response.json({ success: true, data: { prompt: imagePrompt.trim() } });
    } catch (e) {
      return Response.json({ success: false, data: { message: e.message } });
    }
  }

  if (action === 'aibp_pollinations_generate') {
    const imagePrompt = body.prompt || '';
    const width = body.width || 1280;
    const height = body.height || 720;
    if (!imagePrompt) return Response.json({ success: false, data: { message: '프롬프트 없음' } });

    const encodedPrompt = encodeURIComponent(imagePrompt);
    const seed = Math.floor(Math.random() * 99999);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&seed=${seed}&nologo=true&enhance=true`;

    // Set as post thumbnail if postId provided
    const postId = body.post_id;
    if (postId) {
      await db.prepare('UPDATE posts SET thumbnail_url=?,updated_at=? WHERE id=?')
        .bind(imageUrl, Math.floor(Date.now()/1000), postId).run();
    }

    return Response.json({ success: true, data: { url: imageUrl, attachment_id: 0 } });
  }

  if (action === 'ai_blog_generate_thumbnail') {
    const topic = body.topic || '';
    const style = body.style || 'poster';
    const postId = body.post_id;

    try {
      // Step 1: Generate prompt with Gemini
      const promptForGemini = `블로그 썸네일을 위한 영어 이미지 생성 프롬프트를 만들어주세요.
주제: ${topic}, 스타일: ${style}
50단어 이내 영어 프롬프트만 반환.`;
      const imagePrompt = await callGemini(geminiKey, promptForGemini, 30000);
      const cleanPrompt = imagePrompt.trim();

      const seed = Math.floor(Math.random() * 99999);
      const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=1280&height=720&seed=${seed}&nologo=true&enhance=true`;

      if (postId) {
        await db.prepare('UPDATE posts SET thumbnail_url=?,updated_at=? WHERE id=?')
          .bind(imageUrl, Math.floor(Date.now()/1000), postId).run();
      }

      return Response.json({ success: true, data: { url: imageUrl, attachment_id: 0 } });
    } catch (e) {
      return Response.json({ success: false, data: { message: e.message } });
    }
  }

  return Response.json({ success: false, data: { message: `Unknown action: ${action}` } });
}

// ═══════════════════════════════════════════════
// MAIN REQUEST HANDLER
// ═══════════════════════════════════════════════

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;
  const ip = getClientIP(request);

  // ─── STATIC ASSETS (pass-through) ───────────
  if (path.startsWith('/assets/') || path.startsWith('/favicon')) {
    return context.next();
  }

  // ─── CF-LOGIN ────────────────────────────────
  if (path === '/cf-login' || path === '/cf-login/') {
    if (method === 'POST') {
      const formData = await request.formData().catch(() => new FormData());
      const username = formData.get('username') || '';
      const password = formData.get('password') || '';
      const adminUser = env.ADMIN_USERNAME || 'jiwunin';
      const adminPass = env.ADMIN_PASSWORD || 'Swsh120327!';

      if (username === adminUser && password === adminPass) {
        const token = await createSession(env, username);
        return new Response('', {
          status: 302,
          headers: {
            'Location': '/cf-admin',
            'Set-Cookie': `cf_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`
          }
        });
      }
      return new Response(renderLoginPage('아이디 또는 비밀번호가 틀렸습니다.'), {
        status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    const token = getSessionToken(request);
    const session = await validateSession(env, token);
    if (session) return new Response('', { status: 302, headers: { 'Location': '/cf-admin' } });
    return new Response(renderLoginPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // ─── CF-ADMIN LOGOUT ──────────────────────────
  if (path === '/cf-admin/logout') {
    const token = getSessionToken(request);
    if (token) await env.SESSIONS.delete(`session:${token}`).catch(() => {});
    return new Response('', {
      status: 302,
      headers: {
        'Location': '/cf-login',
        'Set-Cookie': 'cf_session=; Path=/; HttpOnly; Max-Age=0'
      }
    });
  }

  // ─── CF-ADMIN (require auth) ──────────────────
  if (path.startsWith('/cf-admin')) {
    const token = getSessionToken(request);
    const session = await validateSession(env, token);
    if (!session) {
      return new Response('', { status: 302, headers: { 'Location': '/cf-login' } });
    }

    // Admin routing
    const adminPath = path.replace('/cf-admin', '') || '/';

    // Dashboard
    if (adminPath === '/' || adminPath === '') {
      const content = await renderDashboard(db);
      return new Response(renderAdminShell('대시보드', content, 'dashboard'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Stats
    if (adminPath === '/stats') {
      const content = await renderStats(db);
      return new Response(renderAdminShell('통계', content, 'stats'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Posts list
    if (adminPath === '/posts' || adminPath === '/posts/') {
      const status = url.searchParams.get('status') || 'all';
      const page = parseInt(url.searchParams.get('page') || '1');
      const content = await renderPostsList(db, status, page);
      return new Response(renderAdminShell('글 목록', content, 'posts'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // New post
    if (adminPath === '/posts/new') {
      const content = await renderPostEditor(db, null);
      return new Response(renderAdminShell('새 글 작성', content, 'new-post'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Edit post
    const editMatch = adminPath.match(/^\/posts\/(\d+)\/edit$/);
    if (editMatch) {
      const postId = parseInt(editMatch[1]);
      const content = await renderPostEditor(db, postId);
      return new Response(renderAdminShell('글 편집', content, 'posts'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Categories
    if (adminPath === '/categories' || adminPath === '/categories/') {
      const content = await renderCategories(db);
      return new Response(renderAdminShell('카테고리', content, 'categories'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // AIBP settings
    if (adminPath === '/aibp-settings') {
      const content = await renderAIBPSettings(db);
      return new Response(renderAdminShell('AIBP 설정', content, 'aibp'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Settings
    if (adminPath === '/settings') {
      const content = await renderSettingsPage(db);
      return new Response(renderAdminShell('설정', content, 'settings'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Adsense block management
    if (adminPath === '/adsense') {
      const content = await renderAdsensePage(db);
      return new Response(renderAdminShell('애드센스 차단 관리', content, 'adsense'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    return new Response('Not found', { status: 404 });
  }

  // ─── API ROUTES ──────────────────────────────
  if (path.startsWith('/api/')) {
    // Check admin auth for protected API routes
    const isProtectedApi = path.startsWith('/api/admin/') || path.startsWith('/api/aibp');
    if (isProtectedApi) {
      const token = getSessionToken(request);
      const session = await validateSession(env, token);
      if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Public: adsense click tracking
    if (path === '/api/adsense-click' && method === 'POST') {
      const maxClicks = await getSetting(db, 'adsense_max_clicks', '5');
      const timeWindow = await getSetting(db, 'adsense_time_window', '60');
      const blocked = await recordAdClick(db, ip, maxClicks, timeWindow);
      return Response.json({ blocked });
    }

    // Public: search
    if (path === '/api/search') {
      const q = url.searchParams.get('q') || '';
      if (q.length < 2) return Response.json({ results: [] });
      const results = await db.prepare('SELECT title,slug,excerpt FROM posts WHERE status="publish" AND (title LIKE ? OR content LIKE ?) LIMIT 10')
        .bind(`%${q}%`, `%${q}%`).all();
      return Response.json({ results: results.results || [] });
    }

    // AIBP API (protected)
    if (path === '/api/aibp' && method === 'POST') {
      return handleAIBPRequest(request, db, env);
    }

    // Admin: Save post
    if (path === '/api/admin/posts' && method === 'POST') {
      const body = await request.json();
      const { title, content, excerpt, status, category_id, thumbnail_url,
        seo_title, meta_desc, focus_keyword, custom_slug, scheduled_at } = body;

      const rawSlug = custom_slug || slugify(title);
      const slug = rawSlug || String(Date.now());
      const now = Math.floor(Date.now() / 1000);
      let publishedAt = null;
      let scheduledAtTs = null;

      if (status === 'publish') publishedAt = now;
      else if (status === 'scheduled' && scheduled_at) scheduledAtTs = Math.floor(new Date(scheduled_at).getTime() / 1000);

      // Ensure unique slug
      const existing = await db.prepare('SELECT id FROM posts WHERE slug=?').bind(slug).first();
      const finalSlug = existing ? `${slug}-${now}` : slug;

      const result = await db.prepare(`INSERT INTO posts (title,slug,content,excerpt,status,category_id,thumbnail_url,seo_title,meta_desc,focus_keyword,custom_slug,schemas,published_at,scheduled_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'[]',?,?,?,?)`)
        .bind(title||'', finalSlug, content||'', excerpt||'', status||'draft',
          category_id||0, thumbnail_url||'', seo_title||'', meta_desc||'',
          focus_keyword||'', custom_slug||'', publishedAt, scheduledAtTs, now, now).run();

      return Response.json({ ok: true, id: result.meta.last_row_id, slug: finalSlug });
    }

    // Admin: Update post
    const updateMatch = path.match(/^\/api\/admin\/posts\/(\d+)$/);
    if (updateMatch && method === 'PUT') {
      const postId = parseInt(updateMatch[1]);
      const body = await request.json();
      const { title, content, excerpt, status, category_id, thumbnail_url,
        seo_title, meta_desc, focus_keyword, custom_slug, scheduled_at, schemas } = body;

      const now = Math.floor(Date.now() / 1000);
      const existing = await db.prepare('SELECT * FROM posts WHERE id=?').bind(postId).first();
      if (!existing) return Response.json({ error: 'Not found' }, { status: 404 });

      const rawSlug = custom_slug || existing.slug;
      let publishedAt = existing.published_at;
      let scheduledAtTs = existing.scheduled_at;

      if (status === 'publish' && !publishedAt) publishedAt = now;
      else if (status === 'scheduled' && scheduled_at) scheduledAtTs = Math.floor(new Date(scheduled_at).getTime() / 1000);

      // Check slug uniqueness (exclude self)
      const slugConflict = await db.prepare('SELECT id FROM posts WHERE slug=? AND id!=?').bind(rawSlug, postId).first();
      const finalSlug = slugConflict ? `${rawSlug}-${now}` : rawSlug;

      await db.prepare(`UPDATE posts SET title=?,slug=?,content=?,excerpt=?,status=?,category_id=?,thumbnail_url=?,seo_title=?,meta_desc=?,focus_keyword=?,custom_slug=?,schemas=?,published_at=?,scheduled_at=?,updated_at=? WHERE id=?`)
        .bind(title||existing.title, finalSlug, content||existing.content, excerpt||existing.excerpt,
          status||existing.status, category_id||existing.category_id, thumbnail_url||existing.thumbnail_url,
          seo_title||existing.seo_title, meta_desc||existing.meta_desc, focus_keyword||existing.focus_keyword,
          custom_slug||existing.custom_slug, schemas||existing.schemas,
          publishedAt, scheduledAtTs, now, postId).run();

      return Response.json({ ok: true, slug: finalSlug });
    }

    // Admin: Patch post (status change)
    if (updateMatch && method === 'PATCH') {
      const postId = parseInt(updateMatch[1]);
      const body = await request.json();
      const now = Math.floor(Date.now() / 1000);
      if (body.status) {
        await db.prepare('UPDATE posts SET status=?,updated_at=? WHERE id=?').bind(body.status, now, postId).run();
      }
      return Response.json({ ok: true });
    }

    // Admin: Delete post permanently
    if (updateMatch && method === 'DELETE') {
      const postId = parseInt(updateMatch[1]);
      await db.prepare('DELETE FROM posts WHERE id=?').bind(postId).run();
      return Response.json({ ok: true });
    }

    // Admin: Get post
    if (updateMatch && method === 'GET') {
      const postId = parseInt(updateMatch[1]);
      const post = await db.prepare('SELECT * FROM posts WHERE id=?').bind(postId).first();
      if (!post) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json({ ok: true, post });
    }

    // Admin: Categories
    if (path === '/api/admin/categories' && method === 'POST') {
      const body = await request.json();
      const name = body.name || '';
      const slug = body.slug || slugify(name);
      const desc = body.description || '';
      if (!name) return Response.json({ error: '이름을 입력하세요' }, { status: 400 });
      const existing = await db.prepare('SELECT id FROM categories WHERE slug=?').bind(slug).first();
      if (existing) return Response.json({ error: '이미 존재하는 슬러그입니다' }, { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      const r = await db.prepare('INSERT INTO categories (name,slug,description,created_at) VALUES (?,?,?,?)').bind(name, slug, desc, now).run();
      return Response.json({ ok: true, id: r.meta.last_row_id });
    }

    const catMatch = path.match(/^\/api\/admin\/categories\/(\d+)$/);
    if (catMatch && method === 'DELETE') {
      await db.prepare('DELETE FROM categories WHERE id=?').bind(parseInt(catMatch[1])).run();
      return Response.json({ ok: true });
    }
    if (catMatch && method === 'PATCH') {
      const body = await request.json();
      await db.prepare('UPDATE categories SET name=? WHERE id=?').bind(body.name, parseInt(catMatch[1])).run();
      return Response.json({ ok: true });
    }

    // Admin: Settings
    if (path === '/api/admin/settings' && method === 'POST') {
      const body = await request.json();
      for (const [key, value] of Object.entries(body)) {
        await setSetting(db, key, value);
      }
      return Response.json({ ok: true });
    }

    // Admin: Adsense unblock
    if (path === '/api/admin/adsense-unblock' && method === 'POST') {
      const body = await request.json();
      await db.prepare('UPDATE adsense_clicks SET blocked=0,blocked_at=NULL,unblock_at=NULL,click_count=0 WHERE ip=?').bind(body.ip).run();
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  // ─── PUBLIC BLOG ROUTES ──────────────────────

  // Check scheduled posts and publish them
  const nowTs = Math.floor(Date.now() / 1000);
  await db.prepare('UPDATE posts SET status="publish",published_at=? WHERE status="scheduled" AND scheduled_at<=? AND scheduled_at IS NOT NULL')
    .bind(nowTs, nowTs).run().catch(() => {});

  // Check if IP is blocked for adsense
  const adBlocked = await checkAdBlock(db, ip);

  // Get site settings
  const settings = await getBaseSettings(db);

  // Homepage
  if (path === '/' || path === '') {
    const page = parseInt(url.searchParams.get('page') || '1');
    await trackPageview(db, ip, '/');
    const html = await renderBlogIndex(db, settings, page, null, adBlocked);
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
        'CF-Cache-Status': 'DYNAMIC',
      }
    });
  }

  // Category page
  const catMatch = path.match(/^\/category\/([^\/]+)\/?$/);
  if (catMatch) {
    const catSlug = catMatch[1];
    const cat = await db.prepare('SELECT * FROM categories WHERE slug=? OR id=?').bind(catSlug, parseInt(catSlug)||0).first();
    if (!cat) return new Response('카테고리를 찾을 수 없습니다.', { status: 404 });
    const page = parseInt(url.searchParams.get('page') || '1');
    await trackPageview(db, ip, path);
    const html = await renderBlogIndex(db, settings, page, cat.id, adBlocked);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // Category listing
  if (path === '/category' || path === '/category/') {
    const cats = await db.prepare('SELECT c.*, COUNT(p.id) as cnt FROM categories c LEFT JOIN posts p ON p.category_id=c.id AND p.status="publish" GROUP BY c.id').all();
    const head = renderHead(settings, '카테고리', { bodyClass: 'archive' });
    const header = renderHeader(settings, '/category');
    const footer = renderFooter(settings);
    const listHtml = (cats.results||[]).map(c=>
      `<div class="cat-item"><a href="/category/${escHtml(c.slug)}">${escHtml(c.name)} <span>(${c.cnt||0})</span></a></div>`
    ).join('');
    return new Response(`${head}<body class="archive">${header}<div class="site grid-container"><div class="site-content"><h1>카테고리</h1><div class="cat-list">${listHtml}</div></div></div>${footer}</body></html>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // Single post (slug)
  const slug = path.slice(1).replace(/\/$/, '');
  if (slug && !slug.includes('/')) {
    const post = await db.prepare('SELECT * FROM posts WHERE slug=? AND status="publish"').bind(slug).first();
    if (post) {
      await trackPageview(db, ip, path);
      const [prev, next] = await Promise.all([
        db.prepare('SELECT title,slug FROM posts WHERE status="publish" AND published_at < ? ORDER BY published_at DESC LIMIT 1').bind(post.published_at).first(),
        db.prepare('SELECT title,slug FROM posts WHERE status="publish" AND published_at > ? ORDER BY published_at ASC LIMIT 1').bind(post.published_at).first(),
      ]);
      const html = await renderSinglePost(db, settings, post, prev, next, adBlocked);
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
        }
      });
    }
  }

  // 404
  const head = renderHead(settings, '페이지를 찾을 수 없습니다', { bodyClass: 'error404' });
  const header = renderHeader(settings);
  const footer = renderFooter(settings);
  return new Response(`${head}<body class="error404">${header}<div class="site grid-container"><div class="site-content"><h1>404 - 페이지를 찾을 수 없습니다.</h1><p><a href="/">홈으로 돌아가기</a></p></div></div>${footer}</body></html>`, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
