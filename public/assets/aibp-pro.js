/**
 * AIBP Pro v3.7.0 - CF Blog Edition
 * Adapted from WordPress version for Cloudflare Pages
 * Changes: jQuery dependency handled via CDN, AJAX → CF /api/aibp
 */

// ── CF Blog AJAX adapter (WordPress $.ajax compatibility) ──
// Loaded AFTER jQuery from CDN in admin shell

(function($) {
    'use strict';

    // Override ajaxUrl to point to CF API
    if (typeof aiBlogWriter !== 'undefined') {
        aiBlogWriter.ajaxUrl = '/api/aibp';
    }

    $(document).ready(function() {
        initTabs();
        initContentGenerator();
        initSchemaGenerator();
        initContentExpander();
        initThumbnailGenerator();
    });

    /* ══════════════════════════════════════
       탭 초기화
    ══════════════════════════════════════ */
    function initTabs() {
        $('.ai-blog-tab').on('click', function() {
            var tab = $(this).data('tab');
            $('.ai-blog-tab').removeClass('active');
            $(this).addClass('active');
            $('.ai-blog-tab-content').removeClass('active');
            $('[data-content="' + tab + '"]').addClass('active');
        });
    }

    /* ══════════════════════════════════════
       콘텐츠 생성기
    ══════════════════════════════════════ */
    function initContentGenerator() {
        $('#ai-blog-generate-btn').on('click', function(e) {
            e.preventDefault();
            var topic = $('#ai-blog-topic').val().trim();
            if (!topic) { showResult('주제 키워드를 입력해주세요.', 'error'); return; }
            var type = $('#ai-blog-type').val();
            generateContent(topic, type);
        });
    }

    function generateContent(topic, type) {
        var $btn = $('#ai-blog-generate-btn');
        var $progress = $('#ai-blog-progress');
        $btn.prop('disabled', true).addClass('loading');
        $('#ai-blog-result').hide();
        showProgress($progress, '주제 분석 중...', 0);

        var _progCur = 0, _progDone = false, _progTimer = null;
        var _msgs = [
            { at: 800,   msg: '주제 분석 중...' },
            { at: 4000,  msg: 'AI 글 작성 중...' },
            { at: 10000, msg: '문장 다듬는 중...' },
            { at: 16000, msg: 'SEO 최적화 중...' },
        ];
        _msgs.forEach(function(m) {
            setTimeout(function() { if (!_progDone) $progress.find('.progress-label').text(m.msg); }, m.at);
        });
        _progTimer = setInterval(function() {
            if (_progDone) { clearInterval(_progTimer); return; }
            if (_progCur >= 90) { clearInterval(_progTimer); return; }
            _progCur = Math.min(90, _progCur + 0.45);
            safeProgress($progress, Math.round(_progCur), null);
        }, 100);

        $.ajax({
            url: aiBlogWriter.ajaxUrl, type: 'POST', timeout: 200000,
            contentType: 'application/json',
            data: JSON.stringify({
                action: 'ai_blog_generate', nonce: aiBlogWriter.nonce,
                post_id: aiBlogWriter.postId, topic: topic, type: type
            }),
            success: function(response) {
                _progDone = true; clearInterval(_progTimer);
                safeProgress($progress, 100, '완료!');
                setTimeout(function() {
                    hideProgress($progress);
                    if (response.success && response.data) {
                        var d = response.data;
                        var meta = d.meta || {};

                        // Insert into editor
                        insertContentToEditor(d.content, meta.seo_title, meta);

                        // Update SEO fields
                        if (meta.seo_title)       $('#ai_seo_title').val(meta.seo_title);
                        if (meta.meta_desc)        $('#ai_meta_desc').val(meta.meta_desc);
                        if (meta.slug)             $('#ai_slug').val(meta.slug);
                        if (meta.focus_keyword)    $('#ai_focus_keyword').val(meta.focus_keyword);
                        // Also update visible SEO fields
                        if (meta.seo_title)       $('#seo-title').val(meta.seo_title);
                        if (meta.meta_desc)        $('#meta-desc').val(meta.meta_desc);
                        if (meta.focus_keyword)    $('#focus-keyword').val(meta.focus_keyword);
                        if (meta.slug)             { $('#post-slug').val(meta.slug); $('#post-slug').data('manual', 1); }

                        var msg = '✅ 콘텐츠가 에디터에 삽입되었습니다!';
                        if (meta.seo_title)        msg += '<br>📝 <strong>SEO 제목:</strong> ' + escHtml(meta.seo_title);
                        if (meta.meta_desc)        msg += '<br>📄 <strong>메타 설명:</strong> ' + escHtml((meta.meta_desc||'').substring(0,60)) + '...';
                        if (meta.focus_keyword)    msg += '<br>🎯 <strong>키워드:</strong> ' + escHtml(meta.focus_keyword);
                        if (meta.slug)             msg += '<br>🔗 <strong>슬러그:</strong> ' + escHtml(meta.slug);
                        showResult(msg, 'success');
                    } else {
                        showResult('❌ ' + ((response.data && response.data.message) ? response.data.message : '생성 실패'), 'error');
                    }
                }, 500);
            },
            error: function(xhr, status) {
                _progDone = true; clearInterval(_progTimer);
                hideProgress($progress);
                showResult('❌ ' + (status === 'timeout' ? '시간 초과. 다시 시도해주세요.' : '오류가 발생했습니다.'), 'error');
            },
            complete: function() { $btn.prop('disabled', false).removeClass('loading'); }
        });
    }

    /* ══════════════════════════════════════
       스키마 마크업 생성기 (멀티 스키마)
    ══════════════════════════════════════ */
    function initSchemaGenerator() {
        if (!window._aibpSchemaMap) window._aibpSchemaMap = {};
        $('#ai-schema-list .aibp-schema-item').each(function() {
            var idx = parseInt($(this).attr('data-index'));
            var type = $(this).attr('data-type') || 'schema';
            var jsonStr = this.getAttribute('data-json') || '';
            window._aibpSchemaMap[idx] = { json: jsonStr, type: type };
        });

        // Edit modal injection
        if (!$('#aibp-schema-modal').length) {
            $('body').append(
                '<div id="aibp-schema-modal" style="display:none;position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.55);align-items:center;justify-content:center;">' +
                    '<div style="background:#fff;border-radius:10px;width:92%;max-width:680px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.28);">' +
                        '<div style="padding:16px 20px;border-bottom:1px solid #e0e0e0;display:flex;align-items:center;justify-content:space-between;">' +
                            '<strong style="font-size:15px;">스키마 편집</strong>' +
                            '<button id="aibp-schema-modal-close" type="button" style="background:none;border:none;font-size:20px;cursor:pointer;color:#555;line-height:1;">✕</button>' +
                        '</div>' +
                        '<div style="padding:16px 20px;flex:1;overflow:auto;">' +
                            '<p style="font-size:12px;color:#888;margin:0 0 8px;">JSON을 직접 편집하세요.</p>' +
                            '<textarea id="aibp-schema-modal-textarea" spellcheck="false" style="width:100%;height:340px;font-family:monospace;font-size:12px;line-height:1.6;border:1px solid #ccd0d4;border-radius:6px;padding:10px;box-sizing:border-box;resize:vertical;"></textarea>' +
                            '<p id="aibp-schema-modal-error" style="color:#c62828;font-size:12px;margin:6px 0 0;min-height:16px;"></p>' +
                        '</div>' +
                        '<div style="padding:12px 20px;border-top:1px solid #e0e0e0;display:flex;gap:10px;justify-content:flex-end;">' +
                            '<button id="aibp-schema-modal-format" type="button" class="aibp-small-btn" style="margin-right:auto;">🔧 JSON 정렬</button>' +
                            '<button id="aibp-schema-modal-save" type="button" class="ai-blog-button ai-blog-button--primary" style="padding:8px 24px;font-size:13px;">저장</button>' +
                            '<button id="aibp-schema-modal-cancel" type="button" class="aibp-small-btn" style="padding:8px 16px;">취소</button>' +
                        '</div>' +
                    '</div>' +
                '</div>'
            );
        }

        $('#ai-schema-generate-btn').on('click', function() {
            var schemaType = $('#ai-schema-type').val();
            if (!schemaType) { setSchemaStatus('⚠️ 스키마 유형을 먼저 선택해주세요.', 'warn'); return; }
            generateSchema(schemaType);
        });

        $(document).on('click', '#ai-schema-delete-all-btn', function() {
            if (!confirm('모든 스키마를 삭제하시겠습니까?')) return;
            deleteSchema(-1);
        });

        $(document).on('click', '.aibp-schema-delete-single', function() {
            var idx = parseInt($(this).data('index'));
            if (!confirm('이 스키마를 삭제하시겠습니까?')) return;
            deleteSchema(idx);
        });

        $(document).on('click', '.aibp-schema-edit-single', function() {
            var $item = $(this).closest('.aibp-schema-item');
            var idx = parseInt($item.attr('data-index'));
            var type = $item.attr('data-type') || 'schema';
            var jsonStr = window._aibpSchemaMap[idx] ? window._aibpSchemaMap[idx].json : ($item.attr('data-json') || '');

            $('#aibp-schema-modal-textarea').val('');
            $('#aibp-schema-modal-error').text('');
            if (jsonStr) {
                try {
                    var pretty = JSON.stringify(JSON.parse(jsonStr), null, 2);
                    $('#aibp-schema-modal-textarea').val(pretty);
                } catch(e) {
                    $('#aibp-schema-modal-textarea').val(jsonStr);
                }
            }
            $('#aibp-schema-modal').css('display', 'flex').data('editing-idx', idx).data('editing-type', type);
        });

        // Modal close
        $(document).on('click', '#aibp-schema-modal-close, #aibp-schema-modal-cancel', function() {
            $('#aibp-schema-modal').hide().removeData('editing-idx');
        });
        $(document).on('click', '#aibp-schema-modal', function(e) {
            if ($(e.target).is('#aibp-schema-modal')) $(this).hide().removeData('editing-idx');
        });

        // Format JSON
        $(document).on('click', '#aibp-schema-modal-format', function() {
            var $ta = $('#aibp-schema-modal-textarea');
            try {
                $ta.val(JSON.stringify(JSON.parse($ta.val()), null, 2));
                $('#aibp-schema-modal-error').text('');
            } catch(e) {
                $('#aibp-schema-modal-error').text('JSON 파싱 오류: ' + e.message);
            }
        });

        // Save schema edit
        $(document).on('click', '#aibp-schema-modal-save', function() {
            var $modal = $('#aibp-schema-modal');
            var idx = $modal.data('editing-idx');
            var type = $modal.data('editing-type') || 'schema';
            var jsonStr = $('#aibp-schema-modal-textarea').val().trim();

            try { JSON.parse(jsonStr); } catch(e) {
                $('#aibp-schema-modal-error').text('유효하지 않은 JSON: ' + e.message); return;
            }

            // Update _aibpSchemaMap
            window._aibpSchemaMap[idx] = { json: jsonStr, type: type };

            // Update DOM item
            var $item = $('#ai-schema-list .aibp-schema-item[data-index="' + idx + '"]');
            if ($item.length) $item.attr('data-json', jsonStr);

            // Save to server
            saveAllSchemas(function() {
                $modal.hide();
                setSchemaStatus('✅ 스키마가 수정되었습니다.');
            });
        });
    }

    function generateSchema(schemaType) {
        var $btn = $('#ai-schema-generate-btn');
        var $progress = $('#ai-schema-progress');
        var $bar = $('#ai-schema-progress-bar');
        var $step = $('#ai-schema-step');

        $btn.prop('disabled', true);
        $progress.show();
        setSchemaStatus('');

        var steps = ['⏳ 스키마 분석 중...', '📝 구조 생성 중...', '✅ 마무리 중...'];
        var pct = 0, stepIdx = 0;
        var timer = setInterval(function() {
            pct = Math.min(90, pct + 2);
            $bar.css('width', pct + '%');
            if (pct % 30 === 0 && stepIdx < steps.length - 1) {
                stepIdx++;
                $step.text(steps[stepIdx]);
            }
        }, 200);

        // Get editor content for context
        var content = '';
        var vcEl = document.getElementById('visual-content');
        var ceEl = document.getElementById('code-editor');
        var ve = document.getElementById('visual-editor');
        if (ve && ve.style.display !== 'none' && vcEl) content = vcEl.innerHTML;
        else if (ceEl) content = ceEl.value;

        $.ajax({
            url: aiBlogWriter.ajaxUrl, type: 'POST', timeout: 90000,
            contentType: 'application/json',
            data: JSON.stringify({
                action: 'ai_blog_generate_schema', nonce: aiBlogWriter.nonce,
                post_id: aiBlogWriter.postId, schema_type: schemaType, content: content
            }),
            success: function(response) {
                clearInterval(timer);
                $bar.css('width', '100%');
                $step.text('✅ 완료!');
                setTimeout(function() {
                    $progress.hide(); $bar.css('width', '0%');
                    if (response.success && response.data && response.data.schema) {
                        var s = response.data.schema;
                        var newIdx = Object.keys(window._aibpSchemaMap).length;
                        window._aibpSchemaMap[newIdx] = s;
                        appendSchemaItem(newIdx, s.type, s.json);
                        // Show delete all button
                        if (!$('#ai-schema-delete-all-btn').length) {
                            $('#ai-schema-list').after('<button type="button" id="ai-schema-delete-all-btn" class="aibp-small-btn aibp-btn-danger" style="margin-top:8px;width:100%;">🗑 전체 스키마 삭제</button>');
                        }
                        setSchemaStatus('✅ ' + schemaType.toUpperCase() + ' 스키마가 추가되었습니다.');
                    } else {
                        setSchemaStatus('❌ ' + (response.data && response.data.message ? response.data.message : '스키마 생성 실패'));
                    }
                }, 600);
            },
            error: function() {
                clearInterval(timer);
                $progress.hide();
                setSchemaStatus('❌ 오류가 발생했습니다.');
            },
            complete: function() { $btn.prop('disabled', false); }
        });
    }

    function appendSchemaItem(idx, type, jsonStr) {
        var html = '<div class="aibp-schema-item" data-index="' + idx + '" data-type="' + escHtml(type) + '" data-json="' + escHtml(jsonStr) + '">' +
            '<div class="aibp-schema-item-header">' +
            '<span class="aibp-schema-item-label">✅ ' + type.toUpperCase() + ' 스키마</span>' +
            '<div class="aibp-schema-item-actions">' +
            '<button type="button" class="aibp-small-btn aibp-btn-edit aibp-schema-edit-single" data-index="' + idx + '">✏️ 편집</button>' +
            '<button type="button" class="aibp-small-btn aibp-btn-danger aibp-schema-delete-single" data-index="' + idx + '">🗑 삭제</button>' +
            '</div></div></div>';
        $('#ai-schema-list').append(html);
    }

    function deleteSchema(index) {
        var postId = aiBlogWriter.postId;
        if (index === -1) {
            // Delete all
            window._aibpSchemaMap = {};
            $.ajax({
                url: aiBlogWriter.ajaxUrl, type: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ action: 'ai_blog_save_schema_markup', nonce: aiBlogWriter.nonce, post_id: postId, schemas: [] }),
                success: function() {
                    $('#ai-schema-list').empty();
                    $('#ai-schema-delete-all-btn').remove();
                    setSchemaStatus('🗑 모든 스키마가 삭제되었습니다.');
                }
            });
        } else {
            delete window._aibpSchemaMap[index];
            $('[data-index="' + index + '"]').remove();
            saveAllSchemas(function() { setSchemaStatus('🗑 스키마가 삭제되었습니다.'); });
        }
    }

    function saveAllSchemas(callback) {
        var schemas = Object.values(window._aibpSchemaMap).filter(function(s) { return s && (s.json || s.type); });
        $.ajax({
            url: aiBlogWriter.ajaxUrl, type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ action: 'ai_blog_save_schema_markup', nonce: aiBlogWriter.nonce, post_id: aiBlogWriter.postId, schemas: schemas }),
            success: function() { if (callback) callback(); }
        });
    }

    /* ══════════════════════════════════════
       콘텐츠 확장기
    ══════════════════════════════════════ */
    function initContentExpander() {
        // Not rendering expand button in CF version, but keeping logic
    }

    /* ══════════════════════════════════════
       썸네일 생성기
    ══════════════════════════════════════ */
    function initThumbnailGenerator() {
        $('#ai-thumb-generate-btn').on('click', function() {
            var topic = $('#ai-thumb-topic').val().trim() || $('#ai-blog-topic').val().trim();
            var style = $('#ai-thumb-style').val();
            if (!topic) { $('#ai-thumb-status').text('주제를 입력하세요.'); return; }
            generateThumbnail(topic, style);
        });
    }

    function generateThumbnail(topic, style) {
        var $btn = $('#ai-thumb-generate-btn');
        var $progress = $('#ai-thumb-progress');
        var $preview = $('#ai-thumb-preview');
        var $img = $('#ai-thumb-img');
        var $status = $('#ai-thumb-status');

        $btn.prop('disabled', true);
        $progress.show(); $preview.hide(); $status.text('');

        var msgs = ['🔍 Gemini가 주제를 분석 중...', '🎨 이미지 프롬프트 생성 중...', '🖼️ Pollinations AI로 이미지 생성 중...', '⏳ 이미지 렌더링 중...'];
        var msgIdx = 0;
        var msgTimer = setInterval(function() {
            if (msgIdx < msgs.length - 1) {
                msgIdx++;
                $('#ai-thumb-progress-text').text(msgs[msgIdx]);
            }
        }, 3000);

        $.ajax({
            url: aiBlogWriter.ajaxUrl, type: 'POST', timeout: 180000,
            contentType: 'application/json',
            data: JSON.stringify({ action: 'ai_blog_generate_thumbnail', nonce: aiBlogWriter.nonce, post_id: aiBlogWriter.postId, topic: topic, style: style }),
            success: function(response) {
                clearInterval(msgTimer);
                $progress.hide();
                if (response.success && response.data && response.data.url) {
                    var imgUrl = response.data.url;
                    $img.attr('src', imgUrl);
                    $preview.show();
                    $status.css('color', '#4caf50').text('✅ 썸네일이 생성되었습니다!');
                    // Also update thumbnail URL field
                    $('#thumbnail-url').val(imgUrl);
                } else {
                    $status.css('color', '#f44336').text('❌ ' + (response.data && response.data.message ? response.data.message : '생성 실패'));
                }
            },
            error: function() {
                clearInterval(msgTimer);
                $progress.hide();
                $status.css('color', '#f44336').text('❌ 오류가 발생했습니다.');
            },
            complete: function() { $btn.prop('disabled', false); }
        });
    }

    /* ══════════════════════════════════════
       유틸리티
    ══════════════════════════════════════ */
    function insertContentToEditor(html, title, meta) {
        // Set title if available
        if (title) {
            var $title = $('#post-title');
            if ($title.length && !$title.val()) $title.val(title);
        }
        // Insert HTML into visual editor
        var vcEl = document.getElementById('visual-content');
        var ceEl = document.getElementById('code-editor');
        var ve = document.getElementById('visual-editor');
        if (ve && ve.style.display !== 'none' && vcEl) {
            vcEl.innerHTML = html;
        } else if (ceEl) {
            ceEl.value = html;
        }
    }

    function showProgress($el, msg, pct) {
        $el.show();
        $el.find('.progress-label').text(msg || '');
        safeProgress($el, pct || 0, null);
    }

    function safeProgress($el, pct, label) {
        if (typeof pct === 'number') {
            $el.find('.ai-blog-progress-fill').css('width', Math.max(0, Math.min(100, pct)) + '%');
            $el.find('.progress-percent').text(Math.round(pct) + '%');
        }
        if (label !== null && label !== undefined) $el.find('.progress-label').text(label);
    }

    function hideProgress($el) { $el.hide(); }

    function showResult(msg, type) {
        var $result = $('#ai-blog-result');
        $result.html(msg);
        $result.attr('class', 'ai-blog-result ai-blog-result--' + (type || 'success'));
        $result.show();
    }

    function setSchemaStatus(msg) { $('#ai-schema-status').text(msg); }

    function escHtml(s) {
        if (!s) return '';
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

})(window.jQuery || (function() {
    // Minimal jQuery-like shim if jQuery not loaded
    console.warn('AIBP: jQuery not found, using shim');
    function $(sel) { /* minimal shim - jQuery CDN should be loaded */ }
    return $;
})());
