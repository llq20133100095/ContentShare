'use strict';

const docFileInputEl = document.getElementById('doc-file-input');
const btnPickDocEl = document.getElementById('btn-pick-doc');
const dropZoneEl = document.getElementById('drop-zone');
const fileMetaEl = document.getElementById('file-meta');
const sourcePreviewEl = document.getElementById('source-preview');

const titleEl = document.getElementById('title');
const coverPreview = document.getElementById('cover-preview');
const coverUrlEl = document.getElementById('cover-url');
const editorContainer = document.getElementById('editor-container');
const btnSync = document.getElementById('btn-sync');
const statusEl = document.getElementById('status');

// 富文本工具栏
document.querySelectorAll('.editor-toolbar [data-cmd]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const cmd = btn.getAttribute('data-cmd');
    document.execCommand(cmd, false, null);
    editorContainer.focus();
  });
});

coverUrlEl.addEventListener('input', () => {
  const url = coverUrlEl.value.trim();
  if (url) {
    coverPreview.src = url;
    coverPreview.style.display = 'block';
  } else {
    coverPreview.removeAttribute('src');
    coverPreview.style.display = 'none';
  }
});

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (isError ? ' error' : text ? ' success' : '');
}

function getSelectedPlatforms() {
  return Array.from(document.querySelectorAll('input[name="platform"]:checked')).map((el) => el.value);
}

function getBodyHtml() {
  return normalizeImageMarkup(editorContainer.innerHTML || '');
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseInline(md) {
  let line = escapeHtml(md);
  line = line.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g, '<img src="$2" alt="$1" />');
  line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  line = line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  line = line.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  line = line.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  line = line.replace(/_([^_]+)_/g, '<em>$1</em>');
  line = line.replace(/`([^`]+)`/g, '<code>$1</code>');
  return line;
}

function markdownToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let inUl = false;
  let inOl = false;
  let inCode = false;

  const closeLists = () => {
    if (inUl) {
      html += '</ul>';
      inUl = false;
    }
    if (inOl) {
      html += '</ol>';
      inOl = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith('```')) {
      closeLists();
      if (!inCode) html += '<pre><code>';
      else html += '</code></pre>';
      inCode = !inCode;
      continue;
    }

    if (inCode) {
      html += `${escapeHtml(line)}\n`;
      continue;
    }

    if (!line.trim()) {
      closeLists();
      html += '<p><br/></p>';
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      html += `<h${level}>${parseInline(heading[2])}</h${level}>`;
      continue;
    }

    const ul = line.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      if (inOl) {
        html += '</ol>';
        inOl = false;
      }
      if (!inUl) {
        html += '<ul>';
        inUl = true;
      }
      html += `<li>${parseInline(ul[1])}</li>`;
      continue;
    }

    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      if (inUl) {
        html += '</ul>';
        inUl = false;
      }
      if (!inOl) {
        html += '<ol>';
        inOl = true;
      }
      html += `<li>${parseInline(ol[1])}</li>`;
      continue;
    }

    closeLists();
    html += `<p>${parseInline(line)}</p>`;
  }

  closeLists();
  if (inCode) html += '</code></pre>';
  return html || '<p></p>';
}

function plainTextToHtml(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return lines.map((line) => line.trim() ? `<p>${escapeHtml(line)}</p>` : '<p><br/></p>').join('');
}

function extractTitle(text, fileName) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const l of lines) {
    const t = l.trim();
    const h = t.match(/^#\s+(.+)$/);
    if (h && h[1]) return h[1].trim();
  }
  for (const l of lines) {
    const t = l.trim();
    if (t) return t.replace(/^[-*#\d.\s]+/, '').slice(0, 60);
  }
  return String(fileName || '未命名文档').replace(/\.[a-z0-9]+$/i, '');
}

function extractCoverFromMarkdown(md) {
  const m = md.match(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]+")?\)/);
  return m && m[1] ? m[1].trim() : '';
}

function extractCoverFromHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const img = doc.querySelector('img');
    return img?.getAttribute('src') || '';
  } catch (_) {
    return '';
  }
}

function detectType(file) {
  const name = (file?.name || '').toLowerCase();
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'html';
  if (name.endsWith('.txt')) return 'text';
  if (name.endsWith('.docx')) return 'docx';
  return 'unsupported';
}

async function readFileAsText(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}

async function readFileAsArrayBuffer(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取二进制文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

const INLINE_IMAGE_MAX_WIDTH = 1280;
const INLINE_IMAGE_MAX_HEIGHT = 1280;
const INLINE_IMAGE_QUALITY_STEPS = [0.86, 0.8, 0.72];
const INLINE_IMAGE_TARGET_MAX_BYTES = 450 * 1024;

function dataUrlToBlob(dataUrl) {
  try {
    const arr = String(dataUrl || '').split(',');
    const mimeMatch = arr[0]?.match(/:(.*?);/);
    if (!mimeMatch || !arr[1]) return null;
    const mime = mimeMatch[1];
    const bstr = atob(arr[1]);
    const u8 = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
    return new Blob([u8], { type: mime });
  } catch (_) {
    return null;
  }
}

async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Blob 转 dataURL 失败'));
    reader.readAsDataURL(blob);
  });
}

async function canvasToBlob(canvas, type, quality) {
  return await new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob || null), type, quality);
  });
}

async function compressInlineDataImage(dataUrl) {
  if (!/^data:image\//i.test(String(dataUrl || ''))) return dataUrl;
  const rawBlob = dataUrlToBlob(dataUrl);
  if (!rawBlob) return dataUrl;

  try {
    const bitmap = await createImageBitmap(rawBlob);
    const origW = bitmap.width || 0;
    const origH = bitmap.height || 0;
    if (!origW || !origH) {
      bitmap.close();
      return dataUrl;
    }

    let targetW = origW;
    let targetH = origH;
    if (targetW > INLINE_IMAGE_MAX_WIDTH) {
      targetH = Math.round(targetH * INLINE_IMAGE_MAX_WIDTH / targetW);
      targetW = INLINE_IMAGE_MAX_WIDTH;
    }
    if (targetH > INLINE_IMAGE_MAX_HEIGHT) {
      targetW = Math.round(targetW * INLINE_IMAGE_MAX_HEIGHT / targetH);
      targetH = INLINE_IMAGE_MAX_HEIGHT;
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return dataUrl;
    }
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close();

    const outputTypes = rawBlob.type === 'image/png'
      ? ['image/webp', 'image/jpeg']
      : ['image/jpeg', 'image/webp'];

    let bestBlob = null;
    for (const outType of outputTypes) {
      for (const q of INLINE_IMAGE_QUALITY_STEPS) {
        const candidate = await canvasToBlob(canvas, outType, q);
        if (!candidate) continue;
        if (!bestBlob || candidate.size < bestBlob.size) {
          bestBlob = candidate;
        }
        if (candidate.size <= INLINE_IMAGE_TARGET_MAX_BYTES) {
          bestBlob = candidate;
          break;
        }
      }
      if (bestBlob && bestBlob.size <= INLINE_IMAGE_TARGET_MAX_BYTES) break;
    }

    if (!bestBlob) return dataUrl;

    const resized = targetW !== origW || targetH !== origH;
    const enoughSmaller = bestBlob.size < rawBlob.size * 0.92;
    if (!resized && !enoughSmaller) return dataUrl;
    if (bestBlob.size >= rawBlob.size) return dataUrl;
    return await blobToDataUrl(bestBlob);
  } catch (_) {
    return dataUrl;
  }
}

function normalizeImageMarkup(html) {
  if (!html) return html;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('img').forEach((img) => {
      img.removeAttribute('width');
      img.removeAttribute('height');
      const prevStyle = img.getAttribute('style') || '';
      const cleanedStyle = prevStyle
        .replace(/(^|;)\s*width\s*:[^;]*/gi, '')
        .replace(/(^|;)\s*height\s*:[^;]*/gi, '')
        .replace(/(^|;)\s*max-width\s*:[^;]*/gi, '')
        .trim();
      const baseStyle = 'max-width:100%;height:auto;display:block;margin:8px 0;';
      img.setAttribute('style', cleanedStyle ? `${cleanedStyle};${baseStyle}` : baseStyle);
    });
    return doc.body.innerHTML || html;
  } catch (_) {
    return html;
  }
}

async function parseDocumentFile(file) {
  const kind = detectType(file);
  if (kind === 'unsupported') {
    throw new Error('暂仅支持 .md .markdown .txt .html .htm .docx 文档');
  }

  const text = kind === 'docx' ? '' : await readFileAsText(file);
  let bodyHtml = '';
  let coverUrl = '';
  let previewText = text;

  if (kind === 'markdown') {
    bodyHtml = markdownToHtml(text);
    coverUrl = extractCoverFromMarkdown(text);
  } else if (kind === 'html') {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    bodyHtml = doc.body?.innerHTML || '';
    coverUrl = extractCoverFromHtml(text);
    previewText = (doc.body?.textContent || '').trim();
  } else if (kind === 'docx') {
    if (typeof mammoth === 'undefined') {
      throw new Error('docx 解析库未加载，请刷新扩展后重试');
    }
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const result = await mammoth.convertToHtml(
      { arrayBuffer },
      {
        convertImage: mammoth.images.inline(async (image) => {
          const base64 = await image.read('base64');
          const rawDataUrl = `data:${image.contentType};base64,${base64}`;
          const optimizedDataUrl = await compressInlineDataImage(rawDataUrl);
          return { src: optimizedDataUrl };
        })
      }
    );
    bodyHtml = result.value || '<p></p>';
    const textDoc = new DOMParser().parseFromString(bodyHtml, 'text/html');
    previewText = (textDoc.body?.textContent || '').trim();
    coverUrl = extractCoverFromHtml(bodyHtml);
  } else {
    bodyHtml = plainTextToHtml(text);
  }

  return {
    fileName: file.name,
    text: previewText || text,
    title: extractTitle(previewText || text, file.name),
    coverUrl,
    bodyHtml: normalizeImageMarkup(bodyHtml || '<p></p>')
  };
}

function renderParsedDoc(parsed) {
  fileMetaEl.textContent = `已加载：${parsed.fileName}（${Math.round(parsed.text.length / 1024)} KB）`;
  sourcePreviewEl.value = parsed.text.slice(0, 8000);
  titleEl.value = parsed.title || '';
  coverUrlEl.value = parsed.coverUrl || '';
  if (parsed.coverUrl) {
    coverPreview.src = parsed.coverUrl;
    coverPreview.style.display = 'block';
  } else {
    coverPreview.style.display = 'none';
  }
  editorContainer.innerHTML = parsed.bodyHtml;
  setStatus('文档解析完成');
}

async function handleFile(file) {
  if (!file) return;
  try {
    setStatus('正在解析文档…');
    const parsed = await parseDocumentFile(file);
    renderParsedDoc(parsed);
  } catch (err) {
    setStatus(`文档解析失败：${err?.message || '未知错误'}`, true);
  }
}

btnPickDocEl.addEventListener('click', () => docFileInputEl.click());

docFileInputEl.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  await handleFile(file);
  docFileInputEl.value = '';
});

dropZoneEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZoneEl.classList.add('drag-over');
});

dropZoneEl.addEventListener('dragleave', () => {
  dropZoneEl.classList.remove('drag-over');
});

dropZoneEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZoneEl.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  await handleFile(file);
});

btnSync.addEventListener('click', () => {
  const platforms = getSelectedPlatforms();
  if (platforms.length === 0) {
    setStatus('请至少选择一个平台', true);
    return;
  }
  const title = titleEl.value.trim();
  const bodyHtml = getBodyHtml();
  const coverUrl = coverUrlEl.value.trim() || undefined;
  setStatus('正在打开平台并填充…');
  btnSync.disabled = true;
  chrome.runtime.sendMessage(
    { type: 'SYNC', title, bodyHtml, coverUrl, platforms },
    (response) => {
      btnSync.disabled = false;
      if (!response) {
        setStatus('同步未响应', true);
        return;
      }
      if (response.type === 'SYNC_RESULT') {
        if (response.results) {
          const fails = Object.entries(response.results).filter(([, r]) => !r.success);
          if (fails.length === 0) {
            setStatus('已打开平台页面，请检查是否已自动填充；若未填充可手动粘贴。');
          } else {
            setStatus('部分平台填充可能失败：' + fails.map(([p, r]) => p + ': ' + (r.error || '')).join('；'), true);
          }
        } else {
          setStatus(response.error || '同步失败', true);
        }
        return;
      }
      setStatus(response.error || '同步失败', true);
    }
  );
});
