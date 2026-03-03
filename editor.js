/**
 * CF Blog - Visual/Code Editor JavaScript
 */

function switchEditor(mode) {
  const visualEditor = document.getElementById('visual-editor');
  const codeEditor = document.getElementById('code-editor');
  const visualBtn = document.getElementById('visual-btn');
  const codeBtn = document.getElementById('code-btn');

  if (mode === 'visual') {
    // Code → Visual: sync content
    if (codeEditor && visualEditor) {
      const codeContent = codeEditor.value;
      document.getElementById('visual-content').innerHTML = codeContent;
      visualEditor.style.display = 'block';
      codeEditor.style.display = 'none';
    }
    if (visualBtn) visualBtn.classList.add('active');
    if (codeBtn) codeBtn.classList.remove('active');
  } else {
    // Visual → Code: sync content
    if (codeEditor && visualEditor) {
      const visualContent = document.getElementById('visual-content');
      codeEditor.value = visualContent ? visualContent.innerHTML : '';
      visualEditor.style.display = 'none';
      codeEditor.style.display = 'block';
    }
    if (codeBtn) codeBtn.classList.add('active');
    if (visualBtn) visualBtn.classList.remove('active');
  }
}

function execCmd(cmd, val) {
  document.getElementById('visual-content')?.focus();
  document.execCommand(cmd, false, val || null);
}

function insertLink() {
  const url = prompt('링크 URL 입력:');
  if (url) {
    document.getElementById('visual-content')?.focus();
    document.execCommand('createLink', false, url);
  }
}

function insertImage() {
  const url = prompt('이미지 URL 입력:');
  if (url) {
    document.getElementById('visual-content')?.focus();
    document.execCommand('insertImage', false, url);
  }
}

// Init editor on load
document.addEventListener('DOMContentLoaded', function () {
  // Set initial content
  const visualContent = document.getElementById('visual-content');
  const codeEditor = document.getElementById('code-editor');

  // Handle paste to clean up
  if (visualContent) {
    visualContent.addEventListener('paste', function (e) {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/html') ||
        (e.clipboardData || window.clipboardData).getData('text');
      document.execCommand('insertHTML', false, text);
    });
  }
});
