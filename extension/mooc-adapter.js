(() => {
  if (globalThis.__KEBAN_ADAPTER__) return;
  const clean = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const all = (selector, root = document) => {
    try {
      return [...root.querySelectorAll(selector)];
    } catch {
      return [];
    }
  };
  const visible = (node) =>
    !!node &&
    !node.closest('[hidden]') &&
    getComputedStyle(node).display !== 'none' &&
    getComputedStyle(node).visibility !== 'hidden' &&
    !!node.getClientRects().length;
  const allowed = (node) =>
    visible(node) &&
    !node.disabled &&
    node.getAttribute('aria-disabled') !== 'true' &&
    !node.closest('.locked,.disabled,.z-dis,.u-btn-disabled,[data-locked=true]');
  const text = (node) => clean(node?.innerText || node?.getAttribute('aria-label') || node?.title);
  const unitNodes = () => all('.j-unitslist li[data-id], [data-mooc-unit]');
  const activeUnit = () =>
    unitNodes().find((node) => node.matches('.current,.active,.selected,[aria-current=true]'));
  // Some live MOOC templates leave a trailing quote inside data-id.
  const unitId = (node) =>
    String(node?.dataset.id || node?.dataset.moocUnit || '').replace(/^[\s"']+|[\s"']+$/g, '');
  const unitKey = (node) => 'unit:' + unitId(node);
  const lessonNodes = () => all('.u-learnLesson,[data-mooc-lesson]');
  const sameTarget = (item, ref) =>
    !!ref &&
    item.key.replace(/["']+$/, '') === String(ref.key || '').replace(/["']+$/, '') &&
    (!item.chapterName || !ref.chapter || item.chapterName === ref.chapter);
  let lastClick = '',
    clickedAt = 0,
    clickAttempts = 0,
    lastRead = 0,
    readStarted = 0,
    readContext = '',
    readSteps = 0,
    pendingReadPage = 0,
    readPageStalls = 0;
  let lastMediaSource = '';
  let catalogRun = '';
  const catalogSnapshot = new Map();
  const catalogChapters = new Set();
  const taskMetaSent = new Map();
  let reviewStarted = 0,
    reviewSeen = new Set(),
    reviewChapterAt = 0;
  let contentContext = '',
    lastContentNode = null,
    lastContentSignature = '',
    transitionNode = null,
    transitionSignature = '',
    transitionAt = 0;
  function mediaSource() {
    return all('video,audio')
      .map((node) => {
        try {
          const url = new URL(node.currentSrc);
          return url.origin + url.pathname;
        } catch {
          return node.currentSrc;
        }
      })
      .filter(Boolean)
      .join('|');
  }
  function contentState() {
    const media = all('video,audio').find(visible),
      question = all('.u-questionItem,[data-mooc-question]').find(visible),
      doc = all(
        '.m-learnunitUI .unitctBox.f-richEditorText,[data-mooc-document],.ux-h5pdfreader'
      ).find(visible),
      result = all('.m-learnunitUI > .j-replay').find(visible);
    const node = media || question || doc || result?.parentElement || null;
    return {
      node,
      kind: media ? 'media' : question || result ? 'quiz' : doc ? 'document' : '',
      signature: media
        ? mediaSource()
        : node
          ? text(node).slice(0, 2500) +
            '|' +
            all('input:not(:disabled),textarea:not(:disabled)', node).length
          : '',
    };
  }
  function readyContent(state) {
    const key = JSON.stringify(state.context),
      content = contentState();
    if (contentContext && key !== contentContext) {
      transitionNode = lastContentNode;
      transitionSignature = lastContentSignature;
      transitionAt = Date.now();
    }
    contentContext = key;
    if (
      transitionNode &&
      content.node === transitionNode &&
      content.signature === transitionSignature
    )
      return false;
    const active = activeUnit(),
      clue =
        (active?.title || '') +
        ' ' +
        text(active) +
        ' ' +
        all('[class]', active || document.createElement('div'))
          .map((node) => node.className)
          .join(' ');
    const expected = /视频|音频|icon-video|icon-music-video/.test(clue)
      ? 'media'
      : /文档|文本|icon-doc|icon-text/.test(clue)
        ? 'document'
        : /测验|测试|icon-test/.test(clue)
          ? 'quiz'
          : '';
    // A media iframe is reported separately by its own content script.
    if (expected && content.kind && expected !== content.kind) {
      transitionAt = transitionAt || Date.now();
      return false;
    }
    transitionNode = null;
    transitionAt = 0;
    lastContentNode = content.node;
    lastContentSignature = content.signature;
    return true;
  }
  function context() {
    const url = new URL(location.href),
      route = url.hash || '',
      active = activeUnit();
    const params = new URLSearchParams(route.split('?')[1] || url.search);
    const lesson = params.get('id') || params.get('lessonId') || '',
      unit = params.get('cid') || params.get('unitId') || unitId(active);
    return {
      chapter: (
        url.origin +
        url.pathname +
        '#' +
        (lesson || route.split('?')[0] || 'course')
      ).slice(0, 300),
      card: unit ? 'unit:' + unit : 'page',
    };
  }
  function courses() {
    const cards = all('.course-card-wrapper,[data-mooc-course],.m-courseCard');
    const found = cards
      .map((card) => ({
        title: clean(
          card.querySelector('.title .text .text,.title .text,.course-name,[data-course-title]')
            ?.innerText || card.querySelector('.title')?.innerText
        ),
        node:
          card.querySelector('.course-progress-text-span') ||
          card.querySelector('.j-course-card-box,a[href*="/learn/"]') ||
          card.querySelector('[data-course-open]'),
      }))
      .filter((item) => item.title && item.node && visible(item.node));
    if (found.length) return found;
    return all('a[href*="/learn/"]')
      .filter(visible)
      .map((node) => ({ title: text(node), node }))
      .filter((item) => item.title);
  }
  function listTargets() {
    return lessonNodes().flatMap((lesson) => {
      const units = all('.lsicon[data-cid]', lesson),
        chapter = lesson.closest('.m-learnChapterNormal'),
        chapterName = text(chapter?.querySelector('.j-titleName'));
      if (units.length)
        return units.map((node) => ({
          key: 'unit:' + node.dataset.cid,
          node,
          chapter,
          chapterName,
        }));
      return [
        {
          key: 'lesson:' + clean(lesson.querySelector('.j-name')?.innerText || lesson.innerText),
          node: lesson,
          chapter,
          chapterName,
        },
      ];
    });
  }
  async function click(node, key, api, browserActivation = false) {
    if (!allowed(node)) return false;
    const signature = JSON.stringify(api.state.context) + '|' + key;
    if (lastClick === signature && Date.now() - clickedAt < (browserActivation ? 25000 : 10000))
      return true;
    if (lastClick !== signature) {
      lastClick = signature;
      clickAttempts = 0;
    }
    if (++clickAttempts > 3) {
      clickAttempts = 0;
      await api.send('KP_SELF_CHECK', {
        generation: api.state.generation,
        reason: 'MOOC控件连续三次未切换页面，请检查课程开放状态或页面提示。',
      });
      return true;
    }
    clickedAt = Date.now();
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (browserActivation) {
      await api.send('KP_MOOC_OPEN_INTENT', {
        title: key.startsWith('course:')
          ? key.slice(7)
          : api.state.targetCourse || api.state.settings.moocCourseName,
      });
      const controlId = crypto.randomUUID();
      node.setAttribute('data-keban-course-control', controlId);
      await api.send('KP_MOOC_ACTIVATE_COURSE', { controlId, generation: api.state.generation });
    } else node.click();
    return true;
  }
  function blockReason() {
    if (/#\/learn\/(?:exam|homework|forum)|\/(?:exam|peer-assessment)(?:\/|$)/.test(location.href))
      return '当前内容为考试、互评作业或讨论，请本人处理后再继续课程托管。';
    if (all('.j-loginBar,.playPause .j-login,[data-mooc-login-required]').some(visible))
      return 'MOOC需要登录或当前登录已失效，请在MOOC窗口完成登录。';
    if (all('.j-enroll,[data-mooc-enroll-required]').some(visible))
      return '这门MOOC课程尚未加入，请先在平台正常选课，再开始托管。';
    return '';
  }
  function isComplete() {
    return all('.m-learnunitUI > .j-replay,.m-quizResult,.quiz-result,[data-study-submitted]').some(
      visible
    );
  }
  function inspectRoot(root) {
    return all('input,textarea,[contenteditable=true],[role=radio],[role=checkbox]', root).some(
      (node) =>
        !node.disabled && !node.readOnly && visible(node.closest('label,.answer-item') || node)
    );
  }
  async function observe(api) {
    if (window !== window.top) return;
    const { state, send } = api,
      course = location.origin + location.pathname,
      pending = (state.moocManualTasks || []).filter((task) => task.course === course);
    if (!pending.length) return;
    const meta = async (data) => {
      const signature = JSON.stringify([state.generation, data]);
      if (taskMetaSent.get(data.key) !== signature) {
        taskMetaSent.set(data.key, signature);
        await send('KP_MOOC_TASK_META', { generation: state.generation, ...data });
      }
    };
    for (const target of listTargets())
      if (pending.some((task) => sameTarget(target, task)))
        await meta({
          key: target.key,
          title: target.key.startsWith('lesson:')
            ? target.key.slice(7)
            : text(target.node).replace(/^讨论\s*/, ''),
          chapter: target.chapterName,
        });
    const intro = all('.m-quizDoing,[data-mooc-quiz-intro]').find(visible),
      quizTitle =
        text(intro?.querySelector('h2.j-title,h3.j-title,h2,h3')) ||
        text(all('.m-quizResult h2,.m-quizResult h3').find(visible));
    const quiz = pending.find((task) => task.key === 'lesson:' + quizTitle);
    if (quiz && /^#\/learn\/quiz(?:\?|$)/.test(location.hash)) {
      await meta({
        key: quiz.key,
        title: quiz.title,
        chapter: quiz.chapter || '',
        url: location.origin + location.pathname + location.hash,
      });
      if (
        Date.now() - (state.pageStarted || 0) > 2000 &&
        all('.m-quizResult,.m-quizDoing .j-waitForScore,[data-study-submitted]').some(visible)
      )
        await send('KP_MOOC_MANUAL_CLEARED', {
          generation: state.generation,
          key: quiz.key,
          title: quiz.title,
          proof: 'quiz-submitted',
        });
    }
    const unit = activeUnit(),
      key = unit ? 'unit:' + unitId(unit) : '',
      discussion = pending.find((task) => task.key.replace(/["']+$/, '') === key);
    if (discussion && (/讨论/.test(unit?.title || '') || unit?.querySelector('.u-icon-discuss2'))) {
      await meta({
        key,
        title: discussion.title,
        chapter: text(document.querySelector('.j-chapter')) || discussion.chapter || '',
        url: location.origin + location.pathname + location.hash,
      });
      // The platform shows this control only on the current user's own reply.
      if (
        all('.m-learnunitUI .j-reply-all .m-detailInfoItem .j-delBtn,[data-mooc-own-reply]').some(
          visible
        )
      )
        await send('KP_MOOC_MANUAL_CLEARED', {
          generation: state.generation,
          key,
          title: discussion.title,
          proof: 'discussion-own-post',
        });
    }
  }
  async function review(api) {
    const { state, send } = api,
      request = state.moocReview,
      course = location.origin + location.pathname;
    if (
      window !== window.top ||
      !request ||
      request.course !== course ||
      request.phase !== 'locate'
    )
      return {};
    const task = (state.moocManualTasks || []).find(
      (task) => task.course === course && task.key === request.key
    );
    if (!task) {
      await send('KP_MOOC_REVIEW_READY', { generation: state.generation, key: request.key });
      return {};
    }
    if (reviewStarted !== request.started) {
      reviewStarted = request.started;
      reviewSeen = new Set();
      reviewChapterAt = 0;
    }
    if (task.url) {
      try {
        const url = new URL(task.url);
        if (url.origin + url.pathname === course && /^#\/learn\/(quiz|content)\?/.test(url.hash)) {
          await send('KP_MOOC_REVIEW_READY', { generation: state.generation, key: task.key });
          location.hash = url.hash;
          return { handled: true, waiting: '已打开待处理项，请按平台要求完成后点击“复查本页”。' };
        }
      } catch {}
    }
    const targets = listTargets(),
      target = targets.find((item) => sameTarget(item, task));
    if (target && allowed(target.node)) {
      await send('KP_MOOC_TASK_META', {
        generation: state.generation,
        key: task.key,
        title: task.title,
        chapter: target.chapterName,
      });
      await send('KP_MOOC_REVIEW_READY', { generation: state.generation, key: task.key });
      await click(target.node, 'review:' + task.key, api);
      return { handled: true, waiting: '正在打开：' + task.title };
    }
    if ((!targets.length && unitNodes().length) || /^#\/learn\/quiz/.test(location.hash)) {
      const back = all('.u-learnBCUI a.link,[data-mooc-catalog],a').find(
        (node) => allowed(node) && text(node) === '课件'
      );
      if (back) await click(back, 'review-catalog', api);
      else location.hash = '/learn/content';
      return { handled: true, waiting: '正在返回课件目录，定位待处理项。' };
    }
    if (Date.now() - reviewChapterAt < 2500)
      return { handled: true, waiting: '正在加载待处理项所在章节。' };
    const chapters = all('.m-learnChapterNormal'),
      preferred =
        task.chapter ||
        (task.key.startsWith('lesson:') ? task.title.replace(/单元检测.*$/, '') : '');
    const chapter =
      chapters.find(
        (node) =>
          text(node.querySelector('.j-titleName')) === preferred && !reviewSeen.has(preferred)
      ) || chapters.find((node) => !reviewSeen.has(text(node.querySelector('.j-titleName'))));
    if (chapter) {
      const title = text(chapter.querySelector('.j-titleName'));
      reviewSeen.add(title);
      reviewChapterAt = Date.now();
      await click(chapter.querySelector('.j-titleBox'), 'review-chapter:' + title, api);
      return { handled: true, waiting: '正在目录中定位：' + task.title };
    }
    if (Date.now() - request.started > 30000) {
      await send('KP_MOOC_REVIEW_READY', { generation: state.generation, key: task.key });
      return {
        handled: true,
        waiting: '未找到该项目的可用入口，请检查目录开放状态；待处理记录保留。',
      };
    }
    return { handled: true, waiting: '等待课程目录加载，定位待处理入口。' };
  }
  async function run(api) {
    const { state, send } = api;
    if (!state.running || window !== window.top) return {};
    const path = location.pathname,
      route = location.hash;
    if (path === '/home.htm' || path === '/u/home') {
      if (
        !/\/home\/course/.test(route) &&
        !document.querySelector('.course-card-wrapper,[data-mooc-course]')
      ) {
        const mine = all('a,button,[role=button]').find(
          (node) => visible(node) && /^(我的课程|我的学习)$/.test(text(node))
        );
        if (mine) await click(mine, 'my-courses', api);
        else location.hash = '/home/course';
        return { handled: true, waiting: '正在打开个人中心的“我的课程”。' };
      }
      const entries = courses();
      api.setCourses(entries.map((item) => item.title));
      const targetName = state.targetCourse || state.settings.moocCourseName;
      const target = targetName
        ? entries.find((item) => item.title === targetName) ||
          entries.find((item) => item.title.includes(targetName))
        : entries.length === 1
          ? entries[0]
          : null;
      if (!target)
        return {
          handled: true,
          waiting: entries.length
            ? '请在课伴面板选择一门MOOC课程，然后点击“选择课程”。'
            : targetName
              ? '正在加载课程列表；若目标课程不在当前页，请切换课程列表页。'
              : '请登录MOOC并打开“我的课程”，等待课程列表加载。',
        };
      await click(target.node, 'course:' + target.title, api, true);
      return { handled: true, waiting: '正在进入课程：' + target.title };
    }
    if (/^\/(?:spoc\/)?course\//.test(path)) {
      const enter = all('a,button,[role=button]').find(
        (node) => allowed(node) && /^(继续学习|开始学习|进入学习|进入课程)$/.test(text(node))
      );
      if (enter) {
        await click(enter, 'enter-course', api, true);
        return { handled: true, waiting: '正在打开MOOC学习页。' };
      }
      return { handled: true, waiting: '请进入已加入课程的学习页；课伴不会自动加入新课程。' };
    }
    const quizIntro = all('.m-quizDoing,[data-mooc-quiz-intro]').find(visible);
    if (quizIntro) {
      const title = text(quizIntro.querySelector('h2.j-title,h3.j-title,h2,h3')) || '单元测验',
        key = 'lesson:' + title;
      const start = all('.j-startBtn,[data-mooc-start-quiz]', quizIntro).find(visible),
        consent = quizIntro.querySelector('input[type=checkbox]');
      if (
        start &&
        /独立完成|学术诚信|诚信承诺/.test(text(quizIntro)) &&
        (!consent || !consent.checked)
      ) {
        await send('KP_MOOC_MANUAL_TASK', {
          generation: state.generation,
          key,
          title,
          chapter: state.moocSelected?.chapter,
          url: location.origin + location.pathname + location.hash,
          reason: '需要本人确认测验独立完成声明',
        });
        const catalog =
          all('a[href*="#/learn/content"],[data-mooc-catalog]').find(allowed) ||
          all('a,button,[role=button]').find((node) => allowed(node) && text(node) === '课件');
        if (catalog) {
          await click(catalog, 'return-from-consent:' + title, api);
          return { handled: true, waiting: '已保留需本人处理的测验，继续其他视频和课件。' };
        }
        await send('KP_BLOCK', {
          reason: '该测验要求本人确认独立完成声明；请处理后进入课程继续学习。',
        });
        return { handled: true };
      }
      if (start && allowed(start) && state.settings.autoSolve) {
        await click(start, 'start-quiz:' + title, api);
        return { handled: true, waiting: '正在打开单元测验题目。' };
      }
    }
    if (!readyContent(state)) {
      if (transitionAt && Date.now() - transitionAt > 45000) {
        transitionAt = Date.now();
        await send('KP_SELF_CHECK', {
          generation: state.generation,
          reason: 'MOOC新单元超过45秒仍未加载出对应内容，请检查网络或课程页面。',
        });
      }
      return { handled: true, waiting: '正在等待新单元加载，旧单元结果不计入当前任务。' };
    }
    const auto = all('input.j-autoNext').find((node) => node.checked);
    if (auto && state.settings.autoNext) {
      auto.click();
      await send('KP_LOG', { text: '已由课伴按单元顺序继续，视频、文档和随堂测试依次处理。' });
    }
    const cont = all('.j-continue').find(visible);
    if (cont) {
      if (state.submission)
        await send('KP_INLINE_DONE', {
          generation: state.generation,
          nonce: state.submission.nonce,
        });
      await click(cont, 'continue-video', api);
      return {};
    }
    const units = unitNodes();
    const currentUnit = activeUnit();
    if (
      currentUnit &&
      (/讨论/.test(currentUnit.title || '') || currentUnit.querySelector('.u-icon-discuss2'))
    ) {
      const key = unitKey(currentUnit),
        title = text(currentUnit),
        chapter = text(document.querySelector('.j-chapter')) || state.moocSelected?.chapter;
      await send('KP_MOOC_MANUAL_TASK', {
        generation: state.generation,
        key,
        title,
        chapter,
        url: location.origin + location.pathname + location.hash,
        reason: '课程讨论发言需要本人处理',
      });
      const back =
        all('.u-learnBCUI a.link,[data-mooc-catalog]').find(allowed) ||
        all('a,button').find((node) => allowed(node) && text(node) === '课件');
      if (back) {
        await click(back, 'return-from-discussion:' + key, api);
        return { handled: true, waiting: '已保留课程讨论，返回目录继续其他学习内容。' };
      }
      return { handled: true, waiting: '该单元需要本人参与讨论，可返回课件目录继续其他内容。' };
    }
    if (!units.length && (lessonNodes().length || all('.m-learnChapterNormal').length)) {
      const runKey = location.origin + location.pathname + '|' + state.started;
      if (catalogRun !== runKey) {
        catalogRun = runKey;
        catalogSnapshot.clear();
        catalogChapters.clear();
      }
      const rendered = listTargets();
      for (const item of rendered) {
        catalogSnapshot.set(item.chapterName + '|' + item.key.replace(/["']+$/, ''), item);
        if (item.chapterName) catalogChapters.add(item.chapterName);
      }
      const targets = [...catalogSnapshot.values()],
        resume = state.moocResume,
        pending = (state.moocManualTasks || []).filter(
          (task) => task.course === location.origin + location.pathname
        );
      const index =
        resume?.course === location.origin + location.pathname
          ? targets.findIndex((item) => sameTarget(item, resume))
          : -1;
      if (index < 0 && resume?.chapter) {
        const previousChapter = all('.m-learnChapterNormal').find(
          (node) => text(node.querySelector('.j-titleName')) === resume.chapter
        );
        if (previousChapter && !targets.some((item) => item.chapter === previousChapter)) {
          const heading = previousChapter.querySelector('.j-titleBox');
          if (heading && allowed(heading)) {
            await click(heading, 'restore-chapter:' + resume.chapter, api);
            return { handled: true, waiting: '正在恢复当前学习章节的目录。' };
          }
        }
      }
      const remaining = (
        index >= 0 ? [...targets.slice(index + 1), ...targets.slice(0, index + 1)] : targets
      ).filter((item) => !pending.some((task) => sameTarget(item, task)));
      const chapters = all('.m-learnChapterNormal'),
        unexpandedChapter = chapters.find((node) => {
          const title = text(node.querySelector('.j-titleName'));
          return title
            ? !catalogChapters.has(title)
            : !rendered.some((item) => item.chapter === node);
        });
      const isLearned = (item) =>
        item.node.matches('.learned,[data-completed=true]') ||
        !!item.node.querySelector('.tag.learned,.u-icon-check,[data-completed=true]');
      const course = location.origin + location.pathname;
      const isCovered = (item) =>
        isLearned(item) ||
        (state.moocCompletedUnits || []).some(
          (proof) => proof.course === course && sameTarget(item, proof)
        );
      const next = remaining.find((item) => !isCovered(item));
      if (!next) {
        const nextChapter = unexpandedChapter;
        if (nextChapter) {
          const heading = nextChapter.querySelector('.j-titleBox');
          if (heading && allowed(heading)) {
            await click(heading, 'expand:' + text(heading), api);
            return { handled: true, waiting: '正在加载下一章课时。' };
          }
          return { handled: true, waiting: '章节尚未开放或被锁定，请检查课程安排。' };
        }
        const allLearned = targets.length > 0 && targets.every(isCovered);
        if (
          targets.length &&
          targets.every((item) => isCovered(item) || pending.some((task) => sameTarget(item, task)))
        ) {
          await send('KP_MOOC_FINISH', {
            generation: state.generation,
            catalogChecked: true,
            allLearned,
            reason:
              allLearned && !pending.length
                ? '自检确认该MOOC课程所有章节课时均已学完，托管已结束。'
                : '',
          });
          return { handled: true, waiting: '可自动处理的学习内容已结束，请核对待本人处理项。' };
        }
      }
      if (next) {
        if ((!next.node.isConnected || !visible(next.node)) && next.chapter) {
          const chapter =
            chapters.find(
              (node) => text(node.querySelector('.j-titleName')) === next.chapterName
            ) || next.chapter;
          const heading = chapter.querySelector('.j-titleBox');
          if (heading && allowed(heading)) {
            await click(heading, 'expand:' + next.chapterName, api);
            return { handled: true, waiting: '正在展开后续课时所在章节。' };
          }
        }
        if (!allowed(next.node))
          return { handled: true, waiting: '后续课时尚未开放或被平台锁定，请检查课程安排。' };
        if (/^讨论/.test(text(next.node))) {
          await send('KP_MOOC_MANUAL_TASK', {
            generation: state.generation,
            key: next.key,
            chapter: next.chapterName,
            title: text(next.node),
            reason: '课程讨论发言需要本人处理',
          });
          return { handled: true, waiting: '已保留课程讨论，继续其他视频与课件。' };
        }
        await send('KP_MOOC_SELECT_UNIT', {
          generation: state.generation,
          key: next.key,
          chapter: next.chapterName,
        });
        await click(next.node, next.key, api);
        return { handled: true, waiting: '正在进入后续课时。' };
      }
    }
    const documentRoot = document.querySelector(
      '.m-learnunitUI .unitctBox.f-richEditorText,[data-mooc-document],.ux-h5pdfreader'
    );
    if (
      documentRoot &&
      visible(documentRoot) &&
      !document.querySelector('.u-questionItem input:not(:disabled),video,audio')
    ) {
      const key = JSON.stringify([state.context, state.started]);
      if (key !== readContext) {
        readContext = key;
        readStarted = Date.now();
        lastRead = 0;
        readSteps = 0;
        pendingReadPage = 0;
        readPageStalls = 0;
      }
      if (state.progress?.doneCards?.[state.context.card]) return {};
      if (!state.settings.autoRead)
        return { waiting: '当前为文档内容，可在设置中开启自动阅读后继续。' };
      if (
        Date.now() - lastRead < state.settings.readingInterval ||
        Date.now() - readStarted < state.settings.readingInterval
      )
        return { waiting: '正在浏览当前课件。' };
      lastRead = Date.now();
      readSteps++;
      if (readSteps > 200) {
        await send('KP_BLOCK', { reason: 'MOOC阅读达到本轮翻页上限，请检查阅读器。' });
        return { handled: true };
      }
      const pdf = documentRoot.matches('.ux-h5pdfreader')
        ? documentRoot
        : documentRoot.querySelector('.ux-h5pdfreader');
      if (pdf) {
        const page = Number(pdf.querySelector('.ux-h5pdfreader_container_footer_pages_in')?.value),
          total = Number(
            text(pdf.querySelector('.ux-h5pdfreader_container_footer_pages_total')).match(
              /\d+/
            )?.[0]
          );
        if (
          !Number.isInteger(page) ||
          !Number.isInteger(total) ||
          page < 1 ||
          total < page ||
          !all('canvas,img', pdf).some(
            (node) =>
              visible(node) &&
              (node.tagName === 'CANVAS'
                ? node.width > 0 && node.height > 0
                : node.complete && node.naturalWidth > 0)
          )
        )
          return { handled: true, waiting: '正在等待PDF页码和课件内容加载。' };
        if (pendingReadPage && page === pendingReadPage) {
          if (++readPageStalls >= 3) {
            await send('KP_BLOCK', { reason: 'MOOC PDF连续三次翻页未响应，请检查课件阅读器。' });
            return { handled: true };
          }
        } else {
          pendingReadPage = 0;
          readPageStalls = 0;
        }
        const scrolling = all('.ux-h5pdfreader_container_viewer,.ux-edu-pdfviewer', pdf).find(
          (node) =>
            node.scrollHeight > node.clientHeight + 20 &&
            node.scrollTop + node.clientHeight < node.scrollHeight - 20
        );
        if (scrolling) {
          scrolling.scrollTop += Math.max(100, scrolling.clientHeight * 0.8);
          return { handled: true, waiting: '正在向下浏览当前PDF页面。' };
        }
        if (page < total) {
          const next =
            all('.ux-h5pdfreader_container_footer_pages_next', pdf).find(allowed) ||
            all('.ux-h5pdfreader_container_bignext', pdf).find(allowed);
          if (next) {
            pendingReadPage = page;
            for (const type of ['mousedown', 'mouseup', 'click'])
              next.dispatchEvent(
                new MouseEvent(type, {
                  view: window,
                  bubbles: true,
                  cancelable: true,
                  button: 0,
                  buttons: type === 'mousedown' ? 1 : 0,
                })
              );
            return {
              handled: true,
              waiting: '正在翻阅PDF课件：第' + page + ' / ' + total + '页。',
            };
          }
          return { handled: true, waiting: 'PDF尚有未浏览页面，正在等待下一页控件。' };
        }
      }
      const next = pdf
        ? null
        : all('[title="下一页"],[aria-label="下一页"],.j-next-page,[data-mooc-next-page]').find(
            allowed
          );
      if (next) {
        next.click();
        return { waiting: '正在翻阅课件的下一页。' };
      }
      const scrolling = [
        documentRoot,
        ...all('.viewerContainer,.pdfViewerContainer', documentRoot),
        document.scrollingElement,
      ].find(
        (node) =>
          node &&
          node.scrollHeight > node.clientHeight + 20 &&
          node.scrollTop + node.clientHeight < node.scrollHeight - 20
      );
      if (scrolling) {
        scrolling.scrollTop += Math.max(100, scrolling.clientHeight * 0.8);
        return { waiting: '正在向下浏览课件。' };
      }
      if (text(documentRoot).length < 40 && !documentRoot.querySelector('canvas,img'))
        return { waiting: '阅读器尚未加载出可以浏览的内容。' };
      await send('KP_MOOC_DOCUMENT_DONE', {
        generation: state.generation,
        context: state.context,
        readingMs: Date.now() - readStarted,
      });
      return {};
    }
    return {};
  }
  async function nextTarget(api) {
    const units = unitNodes(),
      active = activeUnit();
    const index = units.indexOf(active),
      key = active ? unitKey(active) : api.state.moocSelected?.key || api.state.context.card;
    if (active || /^(?:unit|lesson):/.test(key))
      await api.send('KP_MOOC_CURSOR', {
        generation: api.state.generation,
        key,
        chapter: text(document.querySelector('.j-chapter')),
      });
    if (index >= 0 && units[index + 1])
      return allowed(units[index + 1])
        ? { target: units[index + 1], label: '正在进入下一个MOOC学习单元。' }
        : { waiting: '后续学习单元尚未开放或被锁定，请检查课程安排。' };
    const next = all('[data-study-next],a,button,[role=button]').find(
      (node) => allowed(node) && /^(下一节|下一课|下一课时|下一单元|下一章节)$/.test(text(node))
    );
    if (next) return { target: next, label: '正在进入下一课时。' };
    const back = all('.u-learnBCUI a.link,a[data-mooc-catalog]').find(allowed);
    if (back) return { target: back, label: '本课时单元已处理，正在返回课程目录。' };
    return { waiting: '当前内容已处理，正在等待后续课时控件加载。' };
  }
  globalThis.__KEBAN_ADAPTER__ = {
    name: '中国大学MOOC',
    questionSelector: '.u-questionItem,[data-mooc-question]',
    titleSelector: '.j-title,.j-richTxt,.question-title,.stem',
    optionSelector: '.j-choicebox .answer-item,[data-option],[role=radio],[role=checkbox]',
    context,
    courses,
    run,
    observe,
    review,
    nextTarget,
    blockReason,
    isComplete,
    inspectRoot,
    workflowManaged: () => true,
    mediaHeld: () =>
      all('.j-insetCt,[data-mooc-inset]').some(
        (node) => visible(node) && node.querySelector('.u-questionItem input:not(:disabled)')
      ),
    allowFrameRebind() {
      const source = mediaSource();
      if (!lastMediaSource) {
        lastMediaSource = source;
        return false;
      }
      return (
        !!source && source !== lastMediaSource && !all('video,audio').every((node) => node.ended)
      );
    },
    bindFrame() {
      lastMediaSource = mediaSource() || lastMediaSource;
    },
  };
})();
