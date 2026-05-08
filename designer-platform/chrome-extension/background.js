chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.action === 'ping') {
    sendResponse({ pong: true, success: true });
    return true;
  }
  if (msg.action === 'fetchPrdContent') {
    handleFetch(msg.url).then(function(result) {
      sendResponse(result);
    }).catch(function(e) {
      sendResponse({ success: false, error: e.message });
    });
    return true;
  }
});

async function handleFetch(url) {
  console.log('[DesignPilot bg] Starting fetch for:', url);
  try {
    // Open tab as ACTIVE so React/JS renders properly
    var tab = await chrome.tabs.create({ url: url, active: true });
    console.log('[DesignPilot bg] Created active tab:', tab.id);

    // Wait for tab to load
    await new Promise(function(resolve) {
      var listener = function(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          console.log('[DesignPilot bg] Tab loaded');
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(function() {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 15000);
    });

    // Wait for React to render, then collect text while scrolling. Many cloud docs
    // virtualize the page, so text must be captured before each viewport unloads.
    console.log('[DesignPilot bg] Waiting for content to render and collecting content...');
    var scrollCollected = null;
    await new Promise(function(resolve) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function() {
          return new Promise(function(res) {
            var startedAt = Date.now();
            var maxWait = 70000;
            var seen = {};
            var chunks = [];
            var imageSeen = {};
            var imageItems = [];
            var maxImageItems = 80;
            var noiseRe = /(comment|comments|reply|remark|suggest|recommend|sidebar|aside|right.?bar|avatar|portrait|profile|user.?card|author|like|reaction|评论|回复|建议|侧边|头像|用户|作者|点赞|引用|摘要)/i;

            function sleepInPage(ms) {
              return new Promise(function(done) { setTimeout(done, ms); });
            }

            function normalizeText(text) {
              return (text || '')
                .replace(/\u00a0/g, ' ')
                .replace(/[ \t\r\f\v]+/g, ' ')
                .replace(/\n[ \t]+/g, '\n')
                .replace(/[ \t]+\n/g, '\n')
                .trim();
            }

            function addText(text) {
              text = normalizeText(text);
              if (!text || text.length < 2) return 0;

              var parts = text.split(/\n+/).map(normalizeText).filter(Boolean);
              if (parts.length <= 1 && text.length > 800) {
                parts = text
                  .split(/(?<=[。！？；.!?;])\s+/)
                  .map(normalizeText)
                  .filter(Boolean);
              }
              if (parts.length <= 1) parts = [text];

              var added = 0;
              for (var i = 0; i < parts.length; i++) {
                var part = parts[i];
                if (part.length < 2) continue;
                var key = part.replace(/\s+/g, ' ');
                if (seen[key]) continue;
                seen[key] = true;
                chunks.push(part);
                added += part.length;
              }
              return added;
            }

            function isVisible(el) {
              if (!el) return false;
              var rect = el.getBoundingClientRect();
              var style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 &&
                style.visibility !== 'hidden' &&
                style.display !== 'none' &&
                Number(style.opacity || 1) !== 0;
            }

            function collectVisibleText() {
              var added = 0;
              var selectors = [
                'main', 'article', '[role="main"]', '.doc-content', '.document-content',
                '.markdown-body', '.prose', '.content-body', '.doc-body',
                'h1', 'h2', 'h3', 'h4', 'p', 'li', 'td', 'th', 'pre', 'blockquote',
                '[data-block-id]', '[data-docx-has-block-data]', '[class*="paragraph"]',
                '[class*="Paragraph"]', '[class*="block"]', '[class*="Block"]',
                '[role="paragraph"]', '[contenteditable="true"]'
              ];

              for (var s = 0; s < selectors.length; s++) {
                var nodes = document.querySelectorAll(selectors[s]);
                for (var n = 0; n < nodes.length; n++) {
                  if (isVisible(nodes[n]) && !isNoisyNode(nodes[n])) {
                    added += addText(nodes[n].innerText || nodes[n].textContent || '');
                  }
                }
              }

              var main = findMainTextRoot();
              if (main && !isNoisyNode(main)) {
                added += addText(main.innerText || main.textContent || '');
              }
              return added;
            }

            function describeNode(el) {
              if (!el) return '';
              return [
                el.id || '',
                typeof el.className === 'string' ? el.className : '',
                el.getAttribute && (el.getAttribute('role') || ''),
                el.getAttribute && (el.getAttribute('aria-label') || '')
              ].join(' ');
            }

            function isNoisyNode(el) {
              var current = el;
              var depth = 0;
              while (current && current !== document.body && depth < 8) {
                if (noiseRe.test(describeNode(current))) return true;
                current = current.parentElement;
                depth++;
              }
              return false;
            }

            function findMainTextRoot() {
              var selectors = [
                'main', 'article', '[role="main"]', '.doc-content', '.document-content',
                '.markdown-body', '.prose', '.content-body', '.doc-body',
                '[class*="reader"]', '[class*="Reader"]', '[class*="editor"]', '[class*="Editor"]'
              ];
              var best = null;
              var bestScore = 0;
              for (var i = 0; i < selectors.length; i++) {
                var nodes = document.querySelectorAll(selectors[i]);
                for (var n = 0; n < nodes.length; n++) {
                  var el = nodes[n];
                  if (!isVisible(el) || isNoisyNode(el)) continue;
                  var rect = el.getBoundingClientRect();
                  var text = normalizeText(el.innerText || el.textContent || '');
                  var score = text.length + Math.min(rect.width * rect.height / 500, 5000);
                  if (score > bestScore) {
                    best = el;
                    bestScore = score;
                  }
                }
              }
              return best;
            }

            function collectVisibleImages() {
              if (imageItems.length >= maxImageItems) return;
              var imgs = document.querySelectorAll('img');
              for (var i = 0; i < imgs.length; i++) {
                var img = imgs[i];
                if (!isVisible(img) || isNoisyNode(img)) continue;
                var item = getDesignImageCandidate(img);
                if (!item || imageSeen[item.src]) continue;
                imageSeen[item.src] = true;
                imageItems.push(item);
                if (imageItems.length >= maxImageItems) break;
              }
            }

            function getDesignImageCandidate(img) {
              var src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || '';
              if (!src) return null;
              var lower = src.toLowerCase();
              if (/^(blob:|chrome:|extension:)/.test(lower)) return null;
              if (lower.indexOf('data:') === 0 && src.length < 8000) return null;
              if (/(avatar|portrait|profile|head|user|face|emoji|icon|logo|badge|comment|like|reaction|default)/i.test(lower)) return null;

              var rect = img.getBoundingClientRect();
              var w = img.naturalWidth || Math.round(rect.width) || parseInt(img.getAttribute('width') || '0') || 0;
              var h = img.naturalHeight || Math.round(rect.height) || parseInt(img.getAttribute('height') || '0') || 0;
              var displayW = Math.round(rect.width);
              var displayH = Math.round(rect.height);
              var effectiveW = Math.max(w, displayW);
              var effectiveH = Math.max(h, displayH);
              if (effectiveW < 260 || effectiveH < 160) return null;
              if (effectiveW * effectiveH < 90000) return null;
              var ratio = effectiveW / Math.max(effectiveH, 1);
              if (effectiveW <= 320 && effectiveH <= 320 && ratio > 0.7 && ratio < 1.45) return null;

              var alt = img.alt || '';
              var context = '';
              var parent = img.parentElement;
              for (var depth = 0; parent && parent !== document.body && depth < 4; depth++) {
                context += ' ' + describeNode(parent) + ' ' + normalizeText(parent.innerText || '').slice(0, 120);
                parent = parent.parentElement;
              }
              if (noiseRe.test(context)) return null;

              return { src: src, width: w, height: h, displayWidth: displayW, displayHeight: displayH, alt: cleanImageCaption(alt) };
            }

            function getScrollCandidates() {
              var candidates = [];
              function addCandidate(el, name) {
                if (!el) return;
                var clientH = el === document.scrollingElement ? window.innerHeight : el.clientHeight;
                var scrollH = el === document.scrollingElement ? Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) : el.scrollHeight;
                if (scrollH > clientH + 200) {
                  candidates.push({ el: el, name: name, scrollH: scrollH, clientH: clientH });
                }
              }

              addCandidate(document.scrollingElement || document.documentElement, 'document');
              var all = document.querySelectorAll('body *');
              for (var i = 0; i < all.length; i++) {
                var el = all[i];
                var style = window.getComputedStyle(el);
                var desc = describeNode(el);
                var looksLikeDocViewer = /(vodka|doc|document|reader|editor|viewer|scroll|page|content|正文|文档)/i.test(desc);
                if (!/(auto|scroll|overlay)/.test(style.overflowY || '') && !looksLikeDocViewer) continue;
                if (!isVisible(el)) continue;
                addCandidate(el, el.id ? ('#' + el.id) : (el.className ? String(el.className).slice(0, 80) : el.tagName));
              }

              candidates.sort(function(a, b) {
                return (b.scrollH - b.clientH) - (a.scrollH - a.clientH);
              });
              return candidates;
            }

            function getTop(target) {
              if (target.el === document.scrollingElement || target.name === 'document') {
                return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
              }
              return target.el.scrollTop;
            }

            function setTop(target, y) {
              if (target.el === document.scrollingElement || target.name === 'document') {
                window.scrollTo(0, y);
              } else {
                target.el.scrollTop = y;
              }
            }

            function nudgeScroll(target, delta) {
              var el = target.el === document.scrollingElement ? document.documentElement : target.el;
              var eventInit = { deltaY: delta, deltaX: 0, bubbles: true, cancelable: true, view: window };
              try { el.dispatchEvent(new WheelEvent('wheel', eventInit)); } catch(e) {}
              try { document.dispatchEvent(new WheelEvent('wheel', eventInit)); } catch(e) {}
              try { window.dispatchEvent(new WheelEvent('wheel', eventInit)); } catch(e) {}
              if (target.el === document.scrollingElement || target.name === 'document') {
                window.scrollBy(0, delta);
              } else {
                target.el.scrollTop += delta;
              }
            }

            function getMaxTop(target) {
              if (target.el === document.scrollingElement || target.name === 'document') {
                return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight;
              }
              return target.el.scrollHeight - target.el.clientHeight;
            }

            function cleanupCollectedText(text) {
              text = normalizeText(text);
              if (!text) return '';
              var lines = text.split(/\n+/);
              var noiseLineRe = /^(AI\s*摘要|本文被引用|本文引用|暂无引用|全文评论|评论\s*[（(]?\d*|共\s*\d+\s*人点赞|添加评论|跳转至首条评论|目录|C3\s*可评论|分享|开启编辑|关闭提示|页眉|页脚|文档内容为空|进行中|全部暂停|同款比价|暂时关闭此按钮|调整此按钮位置)$/;
              var noisyPhraseRe = /(AI\s*摘要|本文被引用|本文引用|全文评论|添加评论|跳转至首条评论|You need to enable JavaScript|当前在线.*?模式|速度：\d+\s*bytes\/s)/i;
              var dateLineRe = /^\d{4}年\d{1,2}月\d{1,2}日$/;
              var kept = [];
              for (var i = 0; i < lines.length; i++) {
                var line = normalizeText(lines[i]);
                if (!line) continue;
                if (noiseLineRe.test(line) || noisyPhraseRe.test(line) || dateLineRe.test(line)) continue;
                kept.push(line);
              }
              return kept.join('\n');
            }

            function cleanImageCaption(text) {
              text = normalizeText(text);
              if (!text) return '';
              if (/vodka-|embeddedobject|image-container|image-wrapper|goog-inline-block/i.test(text)) return '';
              return text.slice(0, 80);
            }

            (async function run() {
              await sleepInPage(2200);

              var candidates = getScrollCandidates();
              var targets = [];
              var docTarget = candidates.find(function(c) { return c.name === 'document'; });
              if (docTarget) targets.push(docTarget);
              for (var ci = 0; ci < candidates.length && targets.length < 8; ci++) {
                if (targets.indexOf(candidates[ci]) === -1) targets.push(candidates[ci]);
              }
              if (!targets.length) targets = [{ el: document.scrollingElement || document.documentElement, name: 'document', clientH: window.innerHeight }];
              var iterations = 0;
              var reason = 'scroll complete';

              for (var t = 0; t < targets.length && Date.now() - startedAt < maxWait; t++) {
                var target = targets[t];
                var step = Math.max(700, Math.round((target.clientH || window.innerHeight) * 0.9));
                var lastLen = chunks.join('\n').length;
                var stableRounds = 0;

                setTop(target, 0);
                await sleepInPage(350);

                while (Date.now() - startedAt < maxWait && iterations < 260) {
                  iterations++;
                  collectVisibleText();
                  collectVisibleImages();

                  var currentTop = getTop(target);
                  var maxTop = Math.max(0, getMaxTop(target));
                  var nextTop = Math.min(maxTop, currentTop + step);

                  if (nextTop <= currentTop + 2) {
                    stableRounds++;
                    nudgeScroll(target, step);
                    await sleepInPage(260);
                  } else {
                    setTop(target, nextTop);
                    nudgeScroll(target, step);
                    await sleepInPage(260);
                  }

                  collectVisibleText();
                  collectVisibleImages();

                  var currentLen = chunks.join('\n').length;
                  if (currentLen === lastLen) {
                    stableRounds++;
                  } else {
                    stableRounds = 0;
                    lastLen = currentLen;
                  }

                  if (getTop(target) >= maxTop - 2 && stableRounds >= 8) break;
                }
                setTop(target, 0);
              }

              if (Date.now() - startedAt >= maxWait) reason = 'max wait timeout';

              var text = cleanupCollectedText(normalizeText(chunks.join('\n')));
              console.log('[content] Done:', reason, '- accumulated text:', text.length, 'chars, iterations:', iterations, 'targets:', targets.map(function(x) { return x.name; }).join(', '), 'images:', imageItems.length);
              res({
                text: text,
                len: text.length,
                iterations: iterations,
                target: targets.map(function(x) { return x.name; }).join(', '),
                candidates: candidates.slice(0, 5).map(function(c) {
                  return { name: c.name, scrollH: c.scrollH, clientH: c.clientH };
                }),
                images: imageItems.slice(0, maxImageItems),
                reason: reason
              });
            })();
          });
        }
      }).then(function(results) {
        if (results && results[0]) {
          console.log('[DesignPilot bg] Render result:', results[0].result);
          scrollCollected = results[0].result || null;
        }
        resolve();
      }).catch(function(e) {
        console.log('[DesignPilot bg] Render error:', e.message);
        resolve();
      });
    });

    await sleep(1000);

    // Extract content — keep the accumulated scroll text, then supplement with
    // the longest currently mounted DOM text and images.
    console.log('[DesignPilot bg] Extracting content...');
    var content = scrollCollected && scrollCollected.text ? scrollCollected.text : '';
    var imageItems = scrollCollected && scrollCollected.images ? scrollCollected.images.slice() : [];
    var seenSrcs = {};
    for (var seenIndex = 0; seenIndex < imageItems.length; seenIndex++) {
      seenSrcs[imageItems[seenIndex].src] = true;
    }

    for (var attempt = 0; attempt < 3; attempt++) {
      var results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractAll
      });
      if (results && results[0] && results[0].result) {
        var r = results[0].result;
        console.log('[DesignPilot bg] Attempt', attempt, ': mainText=' + (r.mainText ? r.mainText.length : 0) +
          ', images=' + (r.images ? r.images.length : 0));

        content = mergeTextContent(content, r.mainText);
        content = mergeTextContent(content, r.bodyText);
        content = mergeTextContent(content, r.rawText);

        if (imageItems.length < 80 && r.images) {
          for (var k = 0; k < r.images.length; k++) {
            var img = r.images[k];
            if (!seenSrcs[img.src]) {
              seenSrcs[img.src] = true;
              imageItems.push(img);
              if (imageItems.length >= 80) break;
            }
          }
        }

        await sleep(1000);
      }
    }

    content = cleanupTextForPRD(content);
    console.log('[DesignPilot bg] Final content length:', content.length, 'images:', imageItems.length);

    // Download images
    var cookieHeader = '';
    try {
      var parsedUrl = new URL(url);
      var domain = parsedUrl.hostname;
      var cookies = await chrome.cookies.getAll({ domain: domain });
      if (cookies && cookies.length > 0) {
        cookieHeader = cookies.map(function(c) { return c.name + '=' + c.value; }).join('; ');
      }
    } catch(e) {}

    imageItems = imageItems
      .filter(isLikelyDesignImageItem)
      .sort(function(a, b) {
        return (b.width * b.height) - (a.width * a.height);
      })
      .slice(0, 60);

    console.log('[DesignPilot bg] Downloading', imageItems.length, 'images...');
    var images = await downloadImages(imageItems, cookieHeader);

    // Close the tab we opened
    chrome.tabs.remove(tab.id);

    console.log('[DesignPilot bg] Done: text=', content.length, 'chars, images=', images.length);

    if (content.length > 500) {
      return {
        success: true,
        text: content,
        images: images,
        meta: {
          textLength: content.length,
          imageCandidates: imageItems.length,
          imageCount: images.length,
          scroll: scrollCollected ? {
            len: scrollCollected.len,
            iterations: scrollCollected.iterations,
            target: scrollCollected.target,
            reason: scrollCollected.reason,
            candidates: scrollCollected.candidates
          } : null
        }
      };
    }
    var preview = content.length > 0 ? content.substring(0, 200) : '(empty)';
    return { success: false, error: '内容不足 (' + content.length + ' 字符)，预览: ' + preview };
  } catch(err) {
    console.log('[DesignPilot bg] ERROR:', err.message);
    return { success: false, error: err.message };
  }
}

async function downloadImages(imageItems, cookieHeader) {
  var images = [];
  var concurrency = 6;
  var index = 0;

  async function worker() {
    while (index < imageItems.length) {
      var item = imageItems[index++];
      try {
        var imgSrc = item.src;
        if (imgSrc.indexOf('data:') === 0) {
          images.push({ src: imgSrc, dataUrl: imgSrc, width: item.width, height: item.height, alt: item.alt, caption: item.alt || '' });
          continue;
        }
        var fetchOpts = {};
        if (cookieHeader) fetchOpts.headers = { 'Cookie': cookieHeader };
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timeoutId = controller ? setTimeout(function() { controller.abort(); }, 3500) : null;
        if (controller) fetchOpts.signal = controller.signal;
        var resp = await fetch(imgSrc, fetchOpts);
        if (timeoutId) clearTimeout(timeoutId);
        if (resp.ok) {
          var blob = await resp.blob();
          if (blob.size > 500) {
            var dataUrl = await blobToDataURL(blob);
            if (dataUrl && dataUrl.length > 500) {
              images.push({ src: imgSrc, dataUrl: dataUrl, width: item.width, height: item.height, alt: item.alt, caption: item.alt || '' });
            }
          }
        }
      } catch(e) {
        console.log('[DesignPilot bg] Image error:', e.message);
      }
    }
  }

  var workers = [];
  for (var i = 0; i < Math.min(concurrency, imageItems.length); i++) workers.push(worker());
  await Promise.all(workers);
  return images;
}

function blobToDataURL(blob) {
  return new Promise(function(resolve) {
    var reader = new FileReader();
    reader.onloadend = function() { resolve(reader.result); };
    reader.onerror = function() { resolve(''); };
    reader.readAsDataURL(blob);
  });
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function normalizeContentText(text) {
  return (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function mergeTextContent(base, next) {
  base = normalizeContentText(base);
  next = normalizeContentText(next);
  if (!next) return base;
  if (!base) return next;
  if (base.indexOf(next) !== -1) return base;
  if (next.indexOf(base) !== -1) return next;

  var seen = {};
  var merged = [];
  function addLines(text) {
    var lines = text.split(/\n+/);
    if (lines.length <= 1 && text.length > 800) {
      lines = text.split(/(?<=[。！？；.!?;])\s+/);
    }
    for (var i = 0; i < lines.length; i++) {
      var line = normalizeContentText(lines[i]);
      if (!line) continue;
      var key = line.replace(/\s+/g, ' ');
      if (seen[key]) continue;
      seen[key] = true;
      merged.push(line);
    }
  }

  addLines(base);
  addLines(next);
  return merged.join('\n');
}

function cleanupTextForPRD(text) {
  text = normalizeContentText(text);
  if (!text) return '';
  var lines = text.split(/\n+/);
  var noiseLineRe = /^(AI\s*摘要|本文被引用|本文引用|暂无引用|全文评论|评论\s*[（(]?\d*|共\s*\d+\s*人点赞|添加评论|跳转至首条评论|目录|C3\s*可评论|分享|开启编辑|关闭提示|页眉|页脚|文档内容为空|进行中|全部暂停|同款比价|暂时关闭此按钮|调整此按钮位置)$/;
  var noisyPhraseRe = /(AI\s*摘要|本文被引用|本文引用|全文评论|添加评论|跳转至首条评论|You need to enable JavaScript|当前在线.*?模式|速度：\d+\s*bytes\/s)/i;
  var dateLineRe = /^\d{4}年\d{1,2}月\d{1,2}日$/;
  var kept = [];
  for (var i = 0; i < lines.length; i++) {
    var line = normalizeContentText(lines[i]);
    if (!line) continue;
    if (noiseLineRe.test(line) || noisyPhraseRe.test(line) || dateLineRe.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

function isLikelyDesignImageItem(item) {
  if (!item || !item.src) return false;
  var lower = String(item.src).toLowerCase();
  if (/(avatar|portrait|profile|head|user|face|emoji|icon|logo|badge|comment|like|reaction|default)/i.test(lower)) return false;
  var w = item.width || item.displayWidth || 0;
  var h = item.height || item.displayHeight || 0;
  var dw = item.displayWidth || 0;
  var dh = item.displayHeight || 0;
  var effectiveW = Math.max(w, dw);
  var effectiveH = Math.max(h, dh);
  if (effectiveW < 260 || effectiveH < 160) return false;
  if (effectiveW * effectiveH < 90000) return false;
  var ratio = effectiveW / Math.max(effectiveH, 1);
  if (effectiveW <= 320 && effectiveH <= 320 && ratio > 0.7 && ratio < 1.45) return false;
  if (/(comment|comments|reply|remark|suggest|recommend|sidebar|aside|avatar|portrait|profile|评论|回复|建议|侧边|头像|用户|作者|点赞)/i.test(item.context || '')) return false;
  return true;
}

function extractAll() {
  // Method 1: Find main content container
  var mainText = '';
  var selectors = ['main', 'article', '[role="main"]', '.content', '.doc-content', '.markdown-body', '.prose', '.article-content', '.document-content', '.content-body', '.doc-body', '.page-content', '#content', '#main-content', '#page-content', '[class*="content"]', '[class*="doc"]', '[class*="article"]', '[class*="markdown"]'];
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el) {
      var t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > mainText.length) mainText = t;
    }
  }

  // Method 2: Body innerText
  var bodyText = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim();

  // Method 3: Parse raw HTML
  var rawText = document.documentElement.outerHTML
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Collect images from the currently mounted main page, but filter aggressively.
  var images = [];
  var seen = {};
  var allImgs = document.querySelectorAll('img');
  console.log('[extract] Found', allImgs.length, 'total <img> tags');

  function addImg(src, w, h, alt) {
    if (!src || seen[src]) return;
    if (src.indexOf('blob:') === 0 || src.indexOf('chrome:') === 0 || src.indexOf('extension:') === 0) return;
    if (src.indexOf('data:') === 0 && src.length < 2000) return;
    var lower = src.toLowerCase();
    if (['placeholder.com','dummyimage.com','via.placeholder.com','loremflickr.com','picsum.photos','placehold.it','placehold.co','fakeimg.pl'].some(function(h) { return lower.indexOf(h) !== -1; })) return;
    if (['tracking-pixel','analytics-pixel','beacon','/pixel','/track'].some(function(p) { return lower.indexOf(p) !== -1; })) return;
    if (w < 260 || h < 160 || w * h < 90000) return;
    var ratio = w / Math.max(h, 1);
    if (w <= 320 && h <= 320 && ratio > 0.7 && ratio < 1.45) return;
    seen[src] = true;
    images.push({ src: src, width: w || 0, height: h || 0, alt: alt || '' });
  }

  for (var j = 0; j < allImgs.length; j++) {
    var img = allImgs[j];
    var src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || '';
    var w = img.naturalWidth || parseInt(img.getAttribute('width') || '0') || 0;
    var h = img.naturalHeight || parseInt(img.getAttribute('height') || '0') || 0;
    addImg(src, w, h, img.alt || '');
  }

  // Also check picture sources
  var sources = document.querySelectorAll('picture source');
  for (var j = 0; j < sources.length; j++) {
    var srcset = sources[j].srcset || '';
    if (srcset) addImg(srcset.split(',')[0].trim().split(' ')[0], 0, 0, '');
  }

  console.log('[extract] Returning', images.length, 'images after filtering');
  return { mainText: mainText, bodyText: bodyText, rawText: rawText, images: images };
}
