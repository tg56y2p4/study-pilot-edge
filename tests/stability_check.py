"""Offline regressions for answer protection, completion and explicit low-score retry."""
import argparse
import json
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

from browser_support import browser_options
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CASES = ['unsaved', 'unsaved-frame', 'confirmation-wait', 'video-confirm', 'video-manual-confirm',
         'chaoxing-gap', 'mooc-gap', 'mooc-lazy-gap', 'mooc-all-done', 'mooc-pending',
         'retry-low', 'retry-limit', 'retry-start', 'retry-invalid', 'mooc-accordion', 'stale-finish']
BASE = '<!doctype html><meta charset=utf-8><style>body{font:18px Arial;padding:20px}label,button{display:block;padding:10px}iframe{width:800px;height:400px}[role=dialog]{position:fixed;top:100px;left:50px;padding:25px;background:white;z-index:20;border:1px solid blue}</style>'
QUESTION = '<div class=TiMu><h3 class=Zy_TItle>【单选题】低分题2+2等于多少？</h3><label><input type=radio name=q value=A>A.3</label><label><input type=radio name=q value=B>B.4</label></div>'
FORM = QUESTION + '''<button id=submit onclick="document.getElementById('dialog').hidden=false">提交答案</button><div id=dialog role=dialog hidden>确认提交？<button id=confirm onclick="document.body.dataset.confirmed='yes';document.getElementById('work').remove();document.getElementById('done').hidden=false">确认提交</button></div>'''
CATALOG = '''<div class=m-learnChapterNormal><div class=j-titleName>第一章</div><div class=u-learnLesson><span class=lsicon data-cid=early onclick="document.body.dataset.opened='early';this.classList.add('learned')">未学完内容</span></div><div class=u-learnLesson><span class="lsicon learned" data-cid=last>已学完内容</span></div></div>'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', action='append', choices=CASES)
    parser.add_argument('--report', choices=['current', 'red'], default='current')
    args = parser.parse_args()
    hits, results = {}, []

    def route(request):
        path = urlparse(request.request.url).path
        hits[path] = hits.get(path, 0) + 1
        name = path.split('/')[-1]
        body = QUESTION
        if name == 'unsaved-frame':
            body = '<iframe src=/frame-question></iframe>'
        elif name in ['confirmation-wait', 'video-confirm', 'video-manual-confirm']:
            cls = 'ans-videoquiz' if name.startswith('video-') else ''
            body = f'<div id=work class="{cls}">{FORM}</div><p id=done role=status data-study-submitted hidden>提交成功</p>'
        elif name == 'chaoxing-gap':
            body = '''<input id=chapterIdid type=hidden value=102><div id=coursetree><div id=cur101><a class=clicktitle onclick="document.body.dataset.opened='early'">1.1 未完成</a></div><div id=cur102 class=posCatalog_active><span class=icon_Completed></span><a class=clicktitle>1.2 当前已完成</a></div><div id=cur103><span class=icon_Completed></span><a class=clicktitle>1.3 后续已完成</a></div></div>'''
        elif name.startswith('mooc-'):
            body = CATALOG
            if name == 'mooc-lazy-gap':
                body = '''<div class=m-learnChapterNormal><div class=j-titleBox onclick="document.getElementById('lazy').innerHTML='<div class=u-learnLesson><span class=lsicon data-cid=early onclick=opened(this)>前面未完成</span></div>';document.body.dataset.expanded='yes'"><div class=j-titleName>第一章</div></div><div id=lazy></div></div><div class=m-learnChapterNormal><div class=j-titleName>第二章</div><div class=u-learnLesson><span class="lsicon learned" data-cid=last>最后已完成</span></div></div><script>function opened(n){document.body.dataset.opened='early';n.classList.add('learned')}</script>'''
            elif name == 'mooc-all-done':
                body = CATALOG.replace('class=lsicon data-cid=early', 'class="lsicon learned" data-cid=early')
            elif name == 'mooc-pending':
                body = CATALOG.replace('data-cid=early', 'data-cid=discussion')
            elif name == 'mooc-accordion':
                body = '''<div class=m-learnChapterNormal><div class=j-titleBox onclick=load(1)><div class=j-titleName>第一章</div></div><div id=one></div></div><div class=m-learnChapterNormal><div class=j-titleBox onclick=load(2)><div class=j-titleName>第二章</div></div><div id=two></div></div><script>window.visits=[];function load(n){document.getElementById('one').innerHTML='';document.getElementById('two').innerHTML='';document.getElementById(n===1?'one':'two').innerHTML='<div class=u-learnLesson><span class=lsicon data-cid='+n+' onclick=learn(this,'+n+')>课时'+n+'</span></div>'}function learn(el,n){visits.push(n);el.classList.add('learned')}load(1)</script>'''
        elif name == 'stale-finish':
            body = '<p>未取得目录完成证据</p>'
        elif name == 'retry-low':
            body += QUESTION.replace('低分题', '高分题').replace('name=q', 'name=high')
        request.fulfill(status=200, content_type='text/html; charset=utf-8', body=BASE + body)

    with tempfile.TemporaryDirectory(prefix='study-pilot-stability-') as profile, sync_playwright() as p:
        extension = ROOT / 'extension'
        context = p.chromium.launch_persistent_context(profile, headless=True, **browser_options(),
            args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'])
        try:
            context.route('https://*.chaoxing.com/**', route)
            context.route('https://*.icourse163.org/**', route)
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            worker.evaluate('''()=>{globalThis.stabilityCase='';globalThis.requests={};globalThis.fetch=async(url,opts)=>{
                const body=JSON.parse(opts.body),q=JSON.parse(body.messages[1].content),key=q.text.includes('高分题')?'high':'low';
                requests[key]=(requests[key]||0)+1;
                const low=stabilityCase.startsWith('retry-')&&key==='low'&&(requests[key]===1||stabilityCase==='retry-limit');
                return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({answers:['B'],confidence:low?(stabilityCase==='retry-invalid'?'0.99':0.85):0.99,explanation:'offline fixture'})},finish_reason:'stop'}],usage:{total_tokens:1}}));
            }}''')
            options = context.new_page()
            options.goto(worker.url.rsplit('/', 1)[0] + '/options.html')
            options.locator('#apiKey').wait_for()

            def msg(kind, **extra):
                result = options.evaluate('(m)=>chrome.runtime.sendMessage(m)', {'type': kind, **extra})
                assert result['ok'], result
                return result['data']

            def until(predicate, timeout=12000):
                deadline = time.monotonic() + timeout / 1000
                while time.monotonic() < deadline:
                    if predicate():
                        return
                    options.wait_for_timeout(120)
                raise AssertionError('Expected state did not appear')

            for name in args.only or CASES:
                page, popup, tab = None, None, None
                try:
                    settings = msg('KP_GET_SETTINGS')
                    settings.update(reviewEnabled=False, reviewProfiles=[], endpoint='https://maas.qianwenaiapi.com/compatible-mode/v1', apiKey='offline-fixture-key', model='stability-' + name,
                        useVision=False, visualAgent=False, keepActive=False, autoFill=True, autoSolve=True, autoSubmit=True, autoConfirm=True,
                        autoRefresh=True, stallTimeout=15000, minConfidence=0.9, maxCalls=20)
                    if name.startswith('unsaved') or name.startswith('mooc-') or name in ['stale-finish', 'chaoxing-gap']:
                        settings.update(autoSolve=False, autoFill=False, autoSubmit=False)
                    if name.startswith('video-'):
                        settings['autoSubmit'] = False
                    if name in ['confirmation-wait', 'video-manual-confirm']:
                        settings['autoConfirm'] = False
                    if name == 'retry-limit':
                        settings['maxCalls'] = 1
                    msg('KP_SAVE_SETTINGS', settings=settings)
                    worker.evaluate('(name)=>{stabilityCase=name;requests={}}', name)
                    previous_tabs = options.evaluate('()=>chrome.tabs.query({}).then(ts=>ts.map(t=>t.id))')
                    page = context.new_page()
                    tab = options.evaluate('(previous)=>chrome.tabs.query({}).then(ts=>ts.find(t=>!previous.includes(t.id)).id)', previous_tabs)
                    mooc = name.startswith('mooc-') or name == 'stale-finish'
                    url = ('https://www.icourse163.org/learn/' if mooc else 'https://mooc1.chaoxing.com/') + name
                    # Seed before navigation: content scripts serialize their state writes,
                    # while a test-only storage write after page load can race KP_CONTEXT.
                    if mooc and name not in ['mooc-all-done', 'mooc-accordion']:
                        state = msg('KP_STATUS', tabId=tab)
                        state.pop('settings', None)
                        state.pop('hasKey', None)
                        state['moocResume'] = {'course': url, 'key': 'unit:last', 'chapter': '第二章' if name == 'mooc-lazy-gap' else '第一章'}
                        if name == 'mooc-pending':
                            state['moocManualTasks'] = [{'course': url, 'key': 'unit:discussion', 'title': '本人讨论', 'reason': '需本人处理'}]
                        options.evaluate('({id,s})=>chrome.storage.session.set({["tab:"+id]:s})', {'id': tab, 's': state})
                    page.goto(url)
                    msg('KP_START', tabId=tab)
                    if name.startswith('unsaved'):
                        frame = page if name == 'unsaved' else page.frame(url='https://mooc1.chaoxing.com/frame-question')
                        frame.locator('input[value=A]').check()
                        page.wait_for_timeout(21000)
                        assert frame.locator('input[value=A]').is_checked(), 'A refresh must not erase manual answers'
                        assert hits[urlparse(url).path] == 1, 'An unfinished exercise must not be reloaded'
                        assert worker.evaluate('Object.keys(requests).length') == 0
                    elif name in ['confirmation-wait', 'video-confirm', 'video-manual-confirm']:
                        if name == 'video-confirm':
                            until(lambda: page.get_attribute('body', 'data-confirmed') == 'yes')
                        else:
                            page.locator('#dialog').wait_for(state='visible', timeout=12000)
                            page.wait_for_timeout(21000 if name == 'confirmation-wait' else 2200)
                            assert page.get_attribute('body', 'data-confirmed') is None
                            assert hits[urlparse(url).path] == 1, 'Pending confirmation must survive timeout'
                            if name == 'confirmation-wait':
                                settings['autoConfirm'] = True
                                msg('KP_SAVE_SETTINGS', settings=settings)
                                until(lambda: page.get_attribute('body', 'data-confirmed') == 'yes')
                            else:
                                page.locator('#confirm').click()
                    elif name in ['chaoxing-gap', 'mooc-gap', 'mooc-lazy-gap']:
                        until(lambda: page.get_attribute('body', 'data-opened') == 'early')
                        if name == 'mooc-lazy-gap':
                            assert page.get_attribute('body', 'data-expanded') == 'yes'
                    elif name in ['mooc-all-done', 'mooc-accordion']:
                        until(lambda: msg('KP_STATUS', tabId=tab).get('completed'))
                        if name == 'mooc-accordion':
                            assert page.evaluate('visits') == [1, 2], 'A closing accordion must not replay verified chapters'
                    elif name == 'mooc-pending':
                        until(lambda: not msg('KP_STATUS', tabId=tab)['running'])
                        state = msg('KP_STATUS', tabId=tab)
                        assert not state.get('completed') and len(state.get('moocManualTasks', [])) == 1, (
                            f"Pending task must remain: completed={state.get('completed')}, "
                            f"pending={len(state.get('moocManualTasks', []))}")
                    elif name == 'stale-finish':
                        generation = msg('KP_STATUS', tabId=tab)['generation']
                        options.evaluate('({id,g})=>chrome.scripting.executeScript({target:{tabId:id},func:g=>chrome.runtime.sendMessage({type:"KP_MOOC_FINISH",generation:g,allLearned:false}),args:[g]})', {'id': tab, 'g': generation})
                        assert msg('KP_STATUS', tabId=tab)['running'], 'A resume cursor is not completion proof'
                    else:
                        until(lambda: bool(msg('KP_STATUS', tabId=tab).get('blocked')))
                        if name in ['retry-low', 'retry-invalid']:
                            expected = '数值自评分' if name == 'retry-invalid' else '85%'
                            assert expected in msg('KP_STATUS', tabId=tab)['blocked'], 'Report the actual blocking reason'
                            popup = context.new_page()
                            popup.add_init_script('chrome.tabs.query=async()=>'+json.dumps([{'id':tab,'url':url}]))
                            popup.goto(worker.url.rsplit('/',1)[0]+'/popup.html')
                            popup.locator('#retry').click()
                            until(lambda: worker.evaluate('requests.low') == 2)
                            until(lambda: msg('KP_STATUS', tabId=tab)['results'][0]['confidence'] >= 0.9)
                            if name == 'retry-low':
                                assert worker.evaluate('requests.high') == 1, 'Keep reliable answers and avoid rebilling them'
                            assert not page.locator('input[name=q]:checked').count(), 'Manual retry must not submit or fill'
                            if name == 'retry-low':
                                assert page.locator('input[name=high][value=B]').is_checked()
                            msg('KP_FILL', tabId=tab)
                            until(lambda: page.locator('input[name=q][value=B]').is_checked())
                        elif name == 'retry-start':
                            msg('KP_START', tabId=tab)
                            until(lambda: page.locator('input[name=q][value=B]').is_checked())
                            assert worker.evaluate('requests.low') == 2
                        else:
                            response = options.evaluate('(id)=>chrome.scripting.executeScript({target:{tabId:id},func:()=>chrome.runtime.sendMessage({type:"KP_RETRY_LOW"})})', tab)
                            assert response[0]['result']['ok'], response
                            until(lambda: '上限' in (msg('KP_STATUS', tabId=tab).get('blocked') or ''))
                            assert worker.evaluate('requests.low') == 1
                    results.append({'case': name, 'passed': True})
                    print('PASS:', name, flush=True)
                except Exception as error:
                    error_lines = str(error).splitlines()
                    results.append({'case': name, 'passed': False,
                        'error': error_lines[0] if error_lines else type(error).__name__})
                    print('FAIL:', json.dumps(results[-1]), flush=True)
                finally:
                    if tab is not None:
                        msg('KP_STOP', tabId=tab)
                    if page:
                        page.close()
                    if popup:
                        popup.close()
        finally:
            context.close()
    report = {'checks': results, 'passed': sum(row['passed'] for row in results), 'all_passed': all(row['passed'] for row in results),
              'complete_suite': not args.only, 'real_api_tested': False, 'real_course_tested': False}
    output = ROOT / 'test-results' / ('stability-red-report.json' if args.report == 'red' else 'stability-report.json')
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    return 0 if report['all_passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
