/**
 * CF Blog Admin - Core JavaScript
 */

// Global admin notice
function showAdminNotice(msg, type = 'success') {
  let el = document.getElementById('admin-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'admin-notice';
    el.className = 'admin-notice';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.borderLeftColor = type === 'success' ? '#10b981' : '#ef4444';
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// Status dropdown - show/hide schedule
document.addEventListener('DOMContentLoaded', function () {
  const statusSel = document.getElementById('post-status');
  const scheduleRow = document.getElementById('schedule-row');
  if (statusSel) {
    statusSel.addEventListener('change', function () {
      if (scheduleRow) scheduleRow.style.display = this.value === 'scheduled' ? 'block' : 'none';
    });
  }

  // SEO preview live update
  const seoTitle = document.getElementById('seo-title');
  const metaDesc = document.getElementById('meta-desc');
  const postTitleEl = document.getElementById('post-title');
  const postSlugEl = document.getElementById('post-slug');

  function updateSEOPreview() {
    const title = (seoTitle && seoTitle.value) || (postTitleEl && postTitleEl.value) || '';
    const desc = (metaDesc && metaDesc.value) || '';
    const slug = (postSlugEl && postSlugEl.value) || '';
    if (document.getElementById('seo-preview-title')) document.getElementById('seo-preview-title').textContent = title;
    if (document.getElementById('seo-preview-desc')) document.getElementById('seo-preview-desc').textContent = desc;
    if (slug && document.getElementById('seo-preview-url')) {
      document.getElementById('seo-preview-url').textContent = 'yourblog.com/' + slug;
    }
  }
  if (seoTitle) seoTitle.addEventListener('input', updateSEOPreview);
  if (metaDesc) metaDesc.addEventListener('input', updateSEOPreview);
  if (postTitleEl) postTitleEl.addEventListener('input', function () {
    // Auto-generate slug from title if slug is empty
    if (postSlugEl && !postSlugEl.dataset.manual) {
      postSlugEl.value = slugifyKo(this.value);
    }
    updateSEOPreview();
  });
  if (postSlugEl) postSlugEl.addEventListener('input', function () {
    this.dataset.manual = '1';
    updateSEOPreview();
  });

  updateSEOPreview();

  // Count chars
  if (seoTitle) countChars(seoTitle, 'seo-title-count', 60);
  if (metaDesc) countChars(metaDesc, 'meta-desc-count', 160);
});

function countChars(el, counterId, max) {
  const val = typeof el === 'string' ? (document.getElementById(el)||{}).value||'' : el.value || '';
  const len = val.length;
  const c = document.getElementById(counterId);
  if (c) {
    c.textContent = `${len}/${max}`;
    c.style.color = len > max ? '#ef4444' : (len > max * 0.9 ? '#f59e0b' : '#9ca3af');
  }
}

function slugifyKo(text) {
  return text.toString().toLowerCase().trim()
    .replace(/[\s]+/g, '-')
    .replace(/[^\w\-가-힣]/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '').replace(/-+$/, '') || String(Date.now());
}

// Save post
async function savePost(status) {
  const title = document.getElementById('post-title')?.value?.trim() || '';
  if (!title && status === 'publish') {
    alert('제목을 입력하세요.');
    return;
  }

  // Get content from active editor
  let content = '';
  const visualContent = document.getElementById('visual-content');
  const codeEditor = document.getElementById('code-editor');
  const visualEditor = document.getElementById('visual-editor');
  if (visualEditor && visualEditor.style.display !== 'none' && visualContent) {
    content = visualContent.innerHTML;
  } else if (codeEditor) {
    content = codeEditor.value;
  }

  const scheduledAtEl = document.getElementById('scheduled-at');
  const thumbnailUrlEl = document.getElementById('thumbnail-url');

  const payload = {
    title,
    content,
    excerpt: document.getElementById('post-excerpt')?.value || '',
    status: status || document.getElementById('post-status')?.value || 'draft',
    category_id: parseInt(document.getElementById('post-category')?.value || '0'),
    thumbnail_url: (thumbnailUrlEl?.value || document.getElementById('ai-thumb-img')?.src || ''),
    seo_title: document.getElementById('seo-title')?.value || document.getElementById('ai_seo_title')?.value || '',
    meta_desc: document.getElementById('meta-desc')?.value || document.getElementById('ai_meta_desc')?.value || '',
    focus_keyword: document.getElementById('focus-keyword')?.value || document.getElementById('ai_focus_keyword')?.value || '',
    custom_slug: document.getElementById('post-slug')?.value || document.getElementById('ai_slug')?.value || '',
    scheduled_at: scheduledAtEl?.value || null,
    schemas: getSchemas(),
  };

  const btn = document.getElementById('publish-btn');
  const draftBtn = document.getElementById('save-draft-btn');
  if (btn) btn.disabled = true;
  if (draftBtn) draftBtn.disabled = true;

  try {
    let url, method;
    if (typeof POST_ID !== 'undefined' && POST_ID) {
      url = '/api/admin/posts/' + POST_ID;
      method = 'PUT';
    } else {
      url = '/api/admin/posts';
      method = 'POST';
    }

    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();

    if (data.ok) {
      showAdminNotice(status === 'publish' ? '글이 발행되었습니다! ✅' : '임시저장 완료!');
      // Redirect to edit page if new post
      if (!POST_ID && data.id) {
        setTimeout(() => {
          window.location.href = '/cf-admin/posts/' + data.id + '/edit';
        }, 800);
      }
    } else {
      showAdminNotice(data.error || '오류가 발생했습니다.', 'error');
    }
  } catch (e) {
    showAdminNotice('네트워크 오류: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (draftBtn) draftBtn.disabled = false;
  }
}

function getSchemas() {
  const list = document.getElementById('ai-schema-list');
  if (!list) return '[]';
  const items = list.querySelectorAll('.aibp-schema-item');
  const schemas = [];
  items.forEach(item => {
    const type = item.dataset.type || '';
    const json = item.dataset.json || '';
    if (type || json) schemas.push({ type, json });
  });
  return JSON.stringify(schemas);
}
