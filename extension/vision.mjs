// The debugger connection exists only during capture. It never reads cookies,
// network traffic or credentials, and no screenshot is retained in storage.
const captures = new Map();

export async function writeChoiceSelect(tabId, frameId, token, value, expected) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    args: [token, value, expected],
    func: (token, value, expected) => {
      const field = document.querySelector('select[data-keban-select="' + token + '"]');
      if (!field?.isConnected || field.disabled) return { written: false };
      if (field.value !== expected) return { written: false, changed: true };
      const option = [...field.options].find(
        (option) => option.value === value && !option.disabled
      );
      if (!option) return { written: false };
      const win = field.ownerDocument.defaultView;
      Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set.call(
        field,
        value
      );
      field.dispatchEvent(new win.Event('input', { bubbles: true }));
      field.dispatchEvent(new win.Event('change', { bubbles: true }));
      if (typeof win.jQuery === 'function') win.jQuery(field).trigger('chosen:updated');
      else {
        const label = field.parentElement.querySelector('.chosen-single span');
        if (label) label.textContent = option.textContent;
      }
      return { written: field.value === value };
    },
  });
  return results[0]?.result || { written: false };
}

// Only the marked editable field in the requesting course frame is writable.
// Editor APIs live in the page world, outside the extension's isolated world.
export async function writeRichEditor(
  tabId,
  frameId,
  fieldToken,
  value,
  expected,
  syncOnly = false
) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    args: [fieldToken, value, expected, syncOnly],
    func: (token, text, before, synchronizeOnly) => {
      const normalize = (value) =>
        String(value || '')
          .normalize('NFKC')
          .replace(/[\u200b\ufeff]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      const documents = [document];
      for (let i = 0; i < documents.length && i < 32; i++) {
        for (const frame of documents[i].querySelectorAll('iframe')) {
          try {
            if (frame.contentDocument && !documents.includes(frame.contentDocument))
              documents.push(frame.contentDocument);
          } catch {}
        }
      }
      const target = documents
        .map((doc) => doc.querySelector('[data-keban-editor="' + token + '"]'))
        .find(Boolean);
      if (
        !target?.isConnected ||
        (!target.isContentEditable && target.ownerDocument.designMode !== 'on')
      )
        return { written: false, retryable: true };
      if (normalize(target.innerText) !== normalize(before))
        return { written: false, changed: true };
      const doc = target.ownerDocument;
      const container = doc.createElement('div');
      for (const line of text.split('\n')) {
        const paragraph = doc.createElement('p');
        if (line) paragraph.textContent = line;
        else paragraph.append(doc.createElement('br'));
        container.append(paragraph);
      }
      const html = container.innerHTML;
      let editor;
      for (const candidate of documents) {
        const instances = candidate.defaultView?.UE?.instants || {};
        editor = Object.values(instances).find((instance) => instance?.body === target);
        if (editor) break;
      }
      if (editor) {
        if (
          !editor.isReady ||
          typeof editor.setContent !== 'function' ||
          typeof editor.sync !== 'function'
        )
          return { written: false, retryable: true };
        if (!synchronizeOnly) editor.setContent(html);
        editor.sync();
        let stored = editor.textarea;
        if (typeof stored === 'string') {
          stored = documents
            .map(
              (item) =>
                item.getElementById('ueditor_textarea_' + editor.options?.textarea) ||
                item.getElementById(stored)
            )
            .find(Boolean);
        }
        if (stored?.tagName === 'TEXTAREA') {
          const copy = doc.createElement('template');
          copy.innerHTML = stored.value;
          for (const block of copy.content.querySelectorAll('p,div,li,br'))
            block.append(doc.createTextNode('\n'));
          if (normalize(copy.content.textContent) !== normalize(text))
            return { written: false, reason: '编辑器正文与提交字段尚未同步。' };
        }
      } else {
        const frame = doc.defaultView.frameElement;
        if (frame?.closest('.edui-editor')) return { written: false, retryable: true };
        if (!synchronizeOnly) target.replaceChildren(...container.childNodes);
      }
      const win = doc.defaultView;
      if (!synchronizeOnly || !editor) {
        target.dispatchEvent(
          new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
        );
        target.dispatchEvent(new win.Event('change', { bubbles: true }));
        target.dispatchEvent(new win.Event('blur', { bubbles: true }));
      }
      return {
        written: normalize(target.innerText) === normalize(text),
        editor: editor ? 'ueditor' : 'contenteditable',
      };
    },
  });
  return results[0]?.result || { written: false };
}
function descendants(node, predicate, budget = { left: 150000 }) {
  if (--budget.left < 0) return null;
  if (predicate(node)) return node;
  for (const child of [
    ...(node.children || []),
    ...(node.contentDocument ? [node.contentDocument] : []),
  ]) {
    const found = descendants(child, predicate, budget);
    if (found) return found;
  }
  return null;
}
const attribute = (node, name) => {
  const index = node.attributes?.indexOf(name);
  return index >= 0 ? node.attributes[index + 1] : null;
};
async function debuggerCommand(target, method, params = {}) {
  let timer;
  try {
    return await Promise.race([
      chrome.debugger.sendCommand(target, method, params),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('浏览器截图或播放操作超时，请重新开始托管。')),
          15000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function captureCourse(tabId, captureId = null) {
  const previous = captures.get(tabId) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const target = { tabId };
      let attached = false,
        resized = false;
      try {
        await chrome.debugger.attach(target, '1.3');
        attached = true;
        const command = (method, params = {}) => debuggerCommand(target, method, params);
        await chrome.tabs
          .sendMessage(tabId, { type: 'KP_CAPTURE_VISIBILITY', hidden: true })
          .catch(() => {});
        let imageData;
        if (captureId) {
          // Explicitly size the capture viewport before measuring the question.
          // Letting captureScreenshot resize it implicitly can reflow a nested
          // course page after its coordinates were measured and clip the stem.
          const initial = await command('Page.getLayoutMetrics');
          const viewport = initial.cssVisualViewport || initial.visualViewport;
          const captureWidth = Math.max(1300, Math.ceil(viewport.clientWidth)),
            captureHeight = Math.max(400, Math.ceil(viewport.clientHeight));
          if (viewport.clientWidth < 1300 || viewport.clientHeight < 400) {
            await command('Emulation.setDeviceMetricsOverride', {
              width: captureWidth,
              height: captureHeight,
              deviceScaleFactor: 1,
              mobile: false,
            });
            resized = true;
          }
          const { root } = await command('DOM.getDocument', { depth: -1, pierce: true });
          const node = descendants(
            root,
            (node) => attribute(node, 'data-keban-capture') === captureId
          );
          if (!node) throw new Error('题目已变化或位于不可访问的框架，请刷新后重试。');
          const { object } = await command('DOM.resolveNode', { nodeId: node.nodeId });
          try {
            await command('Runtime.callFunctionOn', {
              objectId: object.objectId,
              awaitPromise: true,
              functionDeclaration:
                'function(){this.scrollIntoView({block:"center",inline:"center",behavior:"instant"});return new Promise(resolve=>{setTimeout(resolve,300);requestAnimationFrame(()=>requestAnimationFrame(resolve));});}',
            });
          } finally {
            await command('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
          }
          let [{ model }, metrics] = await Promise.all([
            command('DOM.getBoxModel', { nodeId: node.nodeId }),
            command('Page.getLayoutMetrics'),
          ]);
          const quad = model.border,
            xs = quad.filter((_, i) => i % 2 === 0),
            ys = quad.filter((_, i) => i % 2 === 1);
          const width = Math.max(...xs) - Math.min(...xs),
            height = Math.max(...ys) - Math.min(...ys);
          if (width < 10 || height < 10 || width > 3000 || height > 4000)
            throw new Error('题目区域过小或过长，无法完整截图。');
          // Capture visible slices rather than stretching a nested-frame surface
          // to a tall screenshot. That can repeat old compositor tiles in Edge.
          const tileHeight = Math.min(600, captureHeight - 180),
            scale = Math.min(1, 1800 / Math.max(width, height));
          const canvas = new OffscreenCanvas(Math.ceil(width * scale), Math.ceil(height * scale)),
            ctx = canvas.getContext('2d');
          for (let offset = 0; offset < height; offset += tileHeight) {
            const pieceHeight = Math.min(tileHeight, height - offset);
            await command('DOM.scrollIntoViewIfNeeded', {
              nodeId: node.nodeId,
              rect: { x: 0, y: offset, width, height: pieceHeight },
            });
            await new Promise((resolve) => setTimeout(resolve, 120));
            [{ model }, metrics] = await Promise.all([
              command('DOM.getBoxModel', { nodeId: node.nodeId }),
              command('Page.getLayoutMetrics'),
            ]);
            const view = metrics.cssVisualViewport || metrics.visualViewport,
              partX = Math.min(...model.border.filter((_, i) => i % 2 === 0)),
              partY = Math.min(...model.border.filter((_, i) => i % 2 === 1)) + offset;
            if (
              partX < -2 ||
              partY < -2 ||
              partX + width > view.clientWidth + 2 ||
              partY + pieceHeight > view.clientHeight + 2
            )
              throw new Error('题目被页面容器裁切，无法取得完整截图，请展开题目后重试。');
            const clip = {
              x: Math.max(0, partX + view.pageX),
              y: Math.max(0, partY + view.pageY),
              width,
              height: pieceHeight,
              scale: 1,
            };
            const shot = await command('Page.captureScreenshot', {
              format: 'jpeg',
              quality: 90,
              captureBeyondViewport: false,
              clip,
            });
            const bytes = Uint8Array.from(atob(shot.data), (char) => char.charCodeAt(0)),
              bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
            ctx.drawImage(
              bitmap,
              0,
              Math.round(offset * scale),
              canvas.width,
              Math.ceil(pieceHeight * scale)
            );
            bitmap.close();
          }
          const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 }),
            bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          imageData = btoa(binary);
        }
        if (!imageData)
          imageData = (
            await command('Page.captureScreenshot', {
              format: 'jpeg',
              quality: 88,
              captureBeyondViewport: false,
            })
          ).data;
        if (imageData.length > 8500000) throw new Error('截图过大，请缩小课程区域后重试。');
        return `data:image/jpeg;base64,${imageData}`;
      } catch (error) {
        if (/already attached|Another debugger|Cannot attach/i.test(error.message))
          throw new Error('页面已有开发者工具或其他调试连接，请关闭后重试截图。');
        throw error;
      } finally {
        if (resized)
          await debuggerCommand(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
        await chrome.tabs
          .sendMessage(tabId, { type: 'KP_CAPTURE_VISIBILITY', hidden: false })
          .catch(() => {});
        if (attached) await chrome.debugger.detach(target).catch(() => {});
      }
    });
  captures.set(tabId, operation);
  operation
    .finally(() => {
      if (captures.get(tabId) === operation) captures.delete(tabId);
    })
    .catch(() => {});
  return operation;
}

// A narrowly scoped browser playback action for audio/video rejected by the
// autoplay policy. It can only invoke normal play() on the marked media node.
export function playCourseMedia(tabId, mediaId) {
  const previous = captures.get(tabId) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const target = { tabId };
      let attached = false;
      try {
        await chrome.debugger.attach(target, '1.3');
        attached = true;
        const command = (method, params = {}) => debuggerCommand(target, method, params);
        const { root } = await command('DOM.getDocument', { depth: -1, pierce: true });
        const node = descendants(root, (node) => attribute(node, 'data-keban-media') === mediaId);
        if (!node || !['AUDIO', 'VIDEO'].includes(node.nodeName)) return { played: false };
        const { object } = await command('DOM.resolveNode', { nodeId: node.nodeId });
        try {
          const result = await command('Runtime.callFunctionOn', {
            objectId: object.objectId,
            userGesture: true,
            awaitPromise: true,
            returnByValue: true,
            functionDeclaration:
              'function(){if(!(this instanceof HTMLMediaElement)||!this.isConnected||this.ended)return {played:false};return Promise.race([this.play().then(()=>({played:!this.paused})).catch(()=>({played:false})),new Promise(resolve=>setTimeout(()=>resolve({played:false}),2500))]);}',
          });
          return result.result?.value || { played: false };
        } finally {
          await command('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
        }
      } finally {
        if (attached) await chrome.debugger.detach(target).catch(() => {});
      }
    });
  captures.set(tabId, operation);
  operation
    .finally(() => {
      if (captures.get(tabId) === operation) captures.delete(tabId);
    })
    .catch(() => {});
  return operation;
}

// Course cards launch a new tab. Supply a browser activation only to the
// specific marked course-entry control, so popup policy cannot swallow it.
export function activateMoocCourse(tabId, controlId) {
  const previous = captures.get(tabId) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const target = { tabId };
      let attached = false;
      try {
        await chrome.debugger.attach(target, '1.3');
        attached = true;
        const command = (method, params = {}) => debuggerCommand(target, method, params);
        const { root } = await command('DOM.getDocument', { depth: -1, pierce: true });
        const node = descendants(
          root,
          (node) => attribute(node, 'data-keban-course-control') === controlId
        );
        if (!node) return { clicked: false };
        const { object } = await command('DOM.resolveNode', { nodeId: node.nodeId });
        try {
          const result = await command('Runtime.callFunctionOn', {
            objectId: object.objectId,
            userGesture: true,
            returnByValue: true,
            functionDeclaration:
              'function(){if(!this.isConnected||this.closest(".menu,.close-btn-wrapper"))return {clicked:false};const card=this.closest(".course-card-wrapper,.m-courseCard,[data-mooc-course]"),label=(this.innerText||"").trim();if(!card&&!/^(继续学习|开始学习|进入学习|进入课程)$/.test(label))return {clicked:false};this.click();return {clicked:true};}',
          });
          return result.result?.value || { clicked: false };
        } finally {
          await command('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
        }
      } finally {
        if (attached) await chrome.debugger.detach(target).catch(() => {});
      }
    });
  captures.set(tabId, operation);
  operation
    .finally(() => {
      if (captures.get(tabId) === operation) captures.delete(tabId);
    })
    .catch(() => {});
  return operation;
}
