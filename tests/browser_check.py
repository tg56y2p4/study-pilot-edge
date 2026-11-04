"""Offline fixture integration checks. No requests go to the real course/API.

Run: python tests/browser_check.py --browser edge
Requires Python Playwright. Use a separate fresh test profile for each run.
"""
import argparse
import io
import json
import struct
import wave
import base64
import time
from urllib.parse import urlparse
from datetime import datetime
from pathlib import Path
from browser_support import browser_options
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)
EXT = ROOT / 'extension'
HOST = 'https://mooc1.chaoxing.com'
parser = argparse.ArgumentParser()
parser.add_argument('--browser', choices=['edge','chromium'], default='chromium')
args = parser.parse_args()

QUESTION = '''<div class="TiMu" data-id="one"><h3 class="Zy_TItle">【单选题】以下哪一项等于 2 + 2？</h3>
<ul class="Zy_ulTop"><li><label><input type="radio" name="one" value="A">A. 3</label></li><li><label><input type="radio" name="one" value="B">B. 4</label></li></ul></div>'''
def page_html(content):
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>课伴离线课程夹具</title><style>body{font:16px Microsoft YaHei;padding:30px;color:#192d47}li{margin:15px}iframe{width:750px;height:350px;border:1px solid #ccc}video{width:320px;height:160px;background:#123}button,a{font:inherit;padding:10px;display:inline-block}</style><h1>课程测试页</h1>' + content

fixtures = {
    '/course': page_html('<iframe src="/questions"></iframe>'),
    '/questions': page_html(QUESTION),
    '/image': page_html('<div class="TiMu"><h3 class="Zy_TItle">请回答下图问题<img src="/pixel.svg"></h3><textarea></textarea></div>'),
    '/low': page_html(QUESTION.replace('以下哪一项等于 2 + 2？','信息不足的低置信度题？')),
    '/budget': page_html(QUESTION.replace('以下哪一项等于 2 + 2？','不同的题目一？') + QUESTION.replace('以下哪一项等于 2 + 2？','不同的题目二？').replace('name="one"','name="two"')),
    '/captcha': page_html('<div data-study-captcha>请输入验证码</div>' + QUESTION),
    '/exam/test': page_html(QUESTION),
    '/video': page_html('<iframe src="/video-frame"></iframe><a data-study-next href="/next">下一章节</a>'),
    '/video-frame': page_html('<video controls src="/sample.wav"></video>'),
    '/next': page_html('<p id="arrived">已到下一章节</p>'),
    '/mixed': page_html('<iframe src="/mixed-frame"></iframe><a data-study-next href="/next">下一章节</a>'),
    '/mixed-frame': page_html('<video controls src="/sample.wav"></video>'+QUESTION),
    '/cross-image': page_html('<iframe style="margin:20px 0 0 30px" src="https://ananas.chaoxing.com/image"></iframe>'),
    '/agent': page_html('<p>《数学入门》课程已打开。请点击“进入本节”继续学习。</p><button data-study-action onclick="document.body.dataset.operated=\'yes\';this.remove()">进入本节</button>'),
    '/confirm': page_html('<video controls src="/sample.wav"></video>'+QUESTION+'''<button onclick="document.getElementById('confirmation').hidden=false">提交答案</button><div id="confirmation" role="dialog" hidden>确认提交本次章节练习？<button onclick="document.querySelector('.TiMu').remove();document.getElementById('confirmation').remove();document.getElementById('success').hidden=false">确认提交</button></div><p id="success" role="status" data-study-submitted hidden>提交成功</p><a data-study-next href="/next">下一章节</a>'''),
    '/types': page_html('''<div class="TiMu"><h3 class="Zy_TItle">【多选题】选择两个偶数</h3><ul><li><label><input type="checkbox" name="multi">A. 2</label></li><li><label><input type="checkbox" name="multi">B. 3</label></li><li><label><input type="checkbox" name="multi">C. 4</label></li></ul></div>
<div class="TiMu"><h3 class="Zy_TItle">选择两个偶数（自定义多选框）</h3><ul class="Zy_ulTop"><li onclick="this.querySelector('.num_option_dx').classList.toggle('check_answer')"><span class="num_option_dx">A</span> 2</li><li onclick="this.querySelector('.num_option_dx').classList.toggle('check_answer')"><span class="num_option_dx">B</span> 3</li><li onclick="this.querySelector('.num_option_dx').classList.toggle('check_answer')"><span class="num_option_dx">C</span> 4</li></ul></div>
<div class="TiMu"><h3 class="Zy_TItle">【判断题】地球绕太阳运行</h3><label><input type="radio" name="judge">A. 正确</label><label><input type="radio" name="judge">B. 错误</label></div>
<div class="TiMu"><h3 class="Zy_TItle">【填空题】依次填写 1+1 与 2+2</h3><input type="text"><input type="text"></div>
<div class="TiMu"><h3 class="Zy_TItle">【简答题】解释加法的含义</h3><textarea id="plain-short"></textarea></div>
<div class="TiMu"><h3 class="Zy_TItle">【简答题】富文本解释加法的含义</h3><textarea style="display:none"></textarea><iframe id="ueditor_0" srcdoc="<!doctype html><html><body contenteditable='true'></body></html>" style="width:300px;height:80px"></iframe></div>'''),
    '/submit': page_html(QUESTION + '<button id="submit" onclick="document.body.dataset.submitted=\'yes\';this.remove()">提交答案</button>'),
    '/existing': page_html(QUESTION.replace('value="A"','value="A" checked')),
    '/secret-font': page_html('''<div class="TiMu"><h3 class="Zy_TItle font-cxsecret">【单选题】特殊字体壈壋</h3><ul class="Zy_ulTop" aria-hidden="true"><li onclick="this.parentNode.querySelectorAll('.num_option').forEach(e=>e.classList.remove('check_answer'));this.querySelector('.num_option').classList.add('check_answer')"><span class="num_option">A</span> 3</li><li onclick="this.parentNode.querySelectorAll('.num_option').forEach(e=>e.classList.remove('check_answer'));this.querySelector('.num_option').classList.add('check_answer')"><span class="num_option">B</span> 4</li></ul></div>'''),
    '/portal': page_html('''<div style="display:none" class="commitment-content-dialog">在线学习诚信承诺书</div><a class="clicktitle" href="javascript:void(0)">1.4 数学爱我们（四）</a><button id="covered" data-study-action style="position:absolute;left:50px;top:200px">进入课程</button><div style="position:absolute;left:50px;top:200px;width:250px;height:150px;background:white;z-index:20">页面弹窗</div>'''),
    '/commitment': page_html('<div class="commitment-content-dialog">在线学习诚信承诺书</div>'+QUESTION),
    '/task-tabs': page_html('''<ul><li id="dct1" class="active">1视频</li><li id="dct2" onclick="document.getElementById('media').remove();document.getElementById('quiz').hidden=false;this.className='active';document.getElementById('dct1').className=''">2章节测验</li></ul><video id="media" controls src="/sample.wav"></video><div id="quiz" hidden>'''+QUESTION+'''<button onclick="document.getElementById('confirmation').hidden=false">提交答案</button><div id="confirmation" role="dialog" hidden>确认提交本次章节练习？<button onclick="document.getElementById('quiz').remove();document.getElementById('success').hidden=false">确认提交</button></div></div><p id="success" role="status" data-study-submitted hidden>提交成功</p><a data-study-next href="/next">下一章节</a>'''),
    '/outer-confirm': page_html('''<iframe id="exercise" src="/outer-questions"></iframe><div class="popDiv" id="confirmation" hidden>提示：确认提交？<a onclick="document.getElementById('confirmation').remove();document.getElementById('exercise').remove();document.body.dataset.confirmed='yes'">提交</a><a>取消</a></div>'''),
    '/outer-questions': page_html(QUESTION+'''<a onclick="parent.document.getElementById('confirmation').hidden=false">提交</a>'''),
    '/graded': page_html('<div class="testTit_status testTit_status_complete">已完成</div><p>第1次作答 本次成绩100分</p><div class="TiMu"><h3 class="Zy_TItle">已经批阅的题目</h3><p>我的答案：A</p></div>'),
    '/completed-video': page_html('<div class="ans-job-icon ans-job-video" aria-label="任务点已完成"></div><video controls src="/long.wav"></video><a data-study-next href="/next">下一章节</a>'),
    '/all-done-catalog': page_html('<input id="chapterIdid" type="hidden" value="101"><div id="coursetree"><div id="cur101" class="posCatalog_active"><span class="icon_Completed"></span><a class="clicktitle">1.1 第一章</a></div><div id="cur102"><span class="icon_Completed"></span><a class="clicktitle">1.2 第二章</a></div></div>'),
    '/video-quiz': page_html('<iframe src="/video-quiz-frame"></iframe><a data-study-next href="/next">下一章节</a>'),
    '/video-quiz-frame': page_html('''<video id="v" controls src="/sample.wav" onplay="if(!window.quizDone){this.pause();document.getElementById('vquiz').hidden=false}"></video>
<div id="vquiz" style="border:1px solid #ccc;padding:12px;background:#fff" hidden>
  <div>判断题</div>
  <div>九格算术，中间数字为最小数才能够横竖、交叉和为相等。</div>
  <div>
    <div class="vq-opt" onclick="this.classList.add('on')">A、对</div>
    <div class="vq-opt" onclick="this.classList.add('on')">B、错</div>
  </div>
  <div class="tkTopic_btn" style="display:inline-block;padding:6px 14px;background:#3b82f6;color:#fff;cursor:pointer" onclick="if(document.querySelector('.vq-opt.on')){this.textContent='继续';this.onclick=()=>{window.quizDone=true;document.getElementById('vquiz').remove();document.getElementById('v').play()}}">提交</div>
</div>'''),
}
stalled_hits = 0
audio = io.BytesIO()
with wave.open(audio,'wb') as stream:
    stream.setparams((1,2,8000,0,'NONE','not compressed'))
    stream.writeframes(struct.pack('<h',0)*8000)
long_audio=io.BytesIO()
with wave.open(long_audio,'wb') as stream:
    stream.setparams((1,2,8000,0,'NONE','not compressed'))
    stream.writeframes(struct.pack('<h',0)*8000*30)

def fixture_route(route):
    global stalled_hits
    path = urlparse(route.request.url).path
    if path == '/sample.wav': route.fulfill(status=200, content_type='audio/wav', body=audio.getvalue())
    elif path == '/long.wav': route.fulfill(status=200, content_type='audio/wav', body=long_audio.getvalue())
    elif path == '/pixel.svg': route.fulfill(status=200, content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><text y="20">?</text></svg>')
    elif path == '/stalled-reload':
        stalled_hits += 1
        body = page_html('<input id="chapterIdid" type="hidden" value="202"><p>首次加载卡住的空白章节</p>') if stalled_hits == 1 else page_html('<input id="chapterIdid" type="hidden" value="202"><div class="ans-job-icon ans-job-doc" aria-label="任务点已完成"></div><div id="coursetree"><div id="cur202" class="posCatalog_active"><a class="clicktitle">1.1 恢复章节</a></div></div>')
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=body)
    else: route.fulfill(status=200, content_type='text/html; charset=utf-8', body=fixtures.get(path,page_html('<p>fixture</p>')))

checks=[]
def record(name):
    checks.append(name)
    print('PASS:',name,flush=True)

with sync_playwright() as p:
    profile = ROOT / '.test-profiles' / (args.browser + '-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    options = dict(headless=True,args=[f'--disable-extensions-except={EXT}',f'--load-extension={EXT}'])
    options.update(browser_options(args.browser))
    context = p.chromium.launch_persistent_context(str(profile), **options)
    context.route('https://*.chaoxing.com/**',fixture_route)
    worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker',timeout=15000)
    extension_id = worker.url.split('/')[2]
    browser_errors=[]
    context.on('weberror',lambda error: browser_errors.append(str(error.error)))
    # Replace fetch only inside this dedicated test-profile worker: preserve actual MV3
    # messaging/storage/content execution while keeping test calls fully offline.
    worker.evaluate('''() => {
      globalThis.fixtureRequests=[];
      globalThis.fixtureMode='ok';
      globalThis.fixtureSenders=[];
      chrome.runtime.onMessage.addListener((m,s)=>{fixtureSenders.push({type:m.type,url:s.url,tabId:s.tab?.id,sameId:s.id===chrome.runtime.id})});
      globalThis.fetch=async (url,options) => {
        const body=JSON.parse(options.body);
        fixtureRequests.push({url,body,hasAuthorization:!!options.headers.Authorization});
        if(fixtureMode==='delay') await new Promise((resolve,reject)=>{const t=setTimeout(resolve,15000); options.signal.addEventListener('abort',()=>{clearTimeout(t);reject(new DOMException('Aborted','AbortError'))},{once:true})});
        if(fixtureMode==='401') return new Response(JSON.stringify({error:{code:'InvalidApiKey',message:'not echoed'}}),{status:401});
        let q;try{q=JSON.parse(Array.isArray(body.messages[1].content)?body.messages[1].content.find(p=>p.type==='text').text:body.messages[1].content)}catch{}
        let answers=['B'];
        if(q?.type==='multiple') answers=['A','C'];
        if(q?.type==='boolean') answers=['A'];
        if(q?.type==='fill') answers=['2','4'];
        if(q?.type==='text') answers=['加法用于合并数量。'];
        if(q?.text?.includes('算式')) answers=['4'];
        const target=q?.controls?.find(control=>control.label==='进入本节');
        const result=q?.controls?(target?{action:'click',target:target.id,confidence:0.98,reason:'进入当前章节'}:{action:'wait',confidence:0.98,reason:'等待当前课程加载'}):q?{answers,explanation:'离线夹具解析：2 + 2 = 4。',confidence:q.text.includes('低置信度')?0.4:0.98}:{ok:true};
        return new Response(JSON.stringify({model:body.model,choices:[{message:{content:JSON.stringify(result)},finish_reason:'stop'}],usage:{total_tokens:42}}),{status:200});
      };
    }''')
    # A background connection must not determine whether the settings UI is ready.
    readiness_pending=[]
    readiness_complete=False
    def readiness_route(request):
        if readiness_complete:
            request.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*'},body='')
        else:readiness_pending.append(request)
    context.route('https://readiness.example.test/hold',readiness_route)
    options_page=context.new_page()
    options_page.add_init_script("fetch('https://readiness.example.test/hold',{credentials:'omit'}).catch(()=>{})")
    options_page.goto(f'chrome-extension://{extension_id}/options.html')
    options_page.locator('#apiKey').wait_for()
    expect(options_page.locator('#keyStatus')).to_contain_text('请填写',timeout=30000)
    deadline=time.monotonic()+5
    while not readiness_pending and time.monotonic()<deadline:options_page.wait_for_timeout(50)
    assert readiness_pending,'The offline readiness fixture must intercept the pending connection'
    readiness_complete=True
    for request in readiness_pending:request.abort()
    try:
        expect(options_page.locator('#model')).to_have_value('')
    except AssertionError:
        print('Options error:',options_page.locator('#message').inner_text(),flush=True)
        print('Sender diagnostics:',worker.evaluate('()=>fixtureSenders'),flush=True)
        raise
    record('MV3 extension loaded in '+args.browser+'; options connect to worker')
    def msg(type_,**extra):
        response=options_page.evaluate('(m)=>chrome.runtime.sendMessage(m)',{'type':type_,**extra})
        assert response['ok'], response
        return response['data']
    def save(**extra):
        s=msg('KP_GET_SETTINGS'); s.update(extra); msg('KP_SAVE_SETTINGS',settings=s)
    def tabid(page):
        return options_page.evaluate('(url)=>chrome.tabs.query({}).then(tabs=>tabs.find(t=>t.url===url).id)',page.url)
    def status(tab): return msg('KP_STATUS',tabId=tab)
    def until(check,timeout=15000):
        deadline=datetime.now().timestamp()+timeout/1000
        while datetime.now().timestamp()<deadline:
            if check(): return
            options_page.wait_for_timeout(150)
        raise AssertionError('Timed out waiting for condition')
    course_counter=0
    def course(path):
        global course_counter
        course_counter+=1
        page=context.new_page();page.goto(HOST+path+'?fixture='+str(course_counter));page.wait_for_load_state('networkidle');return page,tabid(page)
    def start(tab): msg('KP_START',tabId=tab)
    def stop(tab): msg('KP_STOP',tabId=tab)

    options_page.locator('#endpoint').fill('https://maas.qianwenaiapi.com/compatible-mode/v1')
    options_page.locator('#model').fill('qwen3.7-plus')
    options_page.locator('#apiKey').fill('fixture-not-a-real-key')
    options_page.locator('#reviewEnabled').uncheck()
    options_page.locator('#autoAssessments').uncheck()
    options_page.locator('#autoSubmit').uncheck()
    options_page.locator('#visualAgent').uncheck()
    options_page.locator('#maxCalls').fill('30')
    options_page.locator('#test').click()
    options_page.locator('#connectionMessage').filter(has_text='连接成功').wait_for()
    assert options_page.locator('#apiKey').input_value()==''
    store=worker.evaluate('async()=>({local:(await chrome.storage.local.get("settings")).settings.apiKey,session:!!(await chrome.storage.session.get("apiKey")).apiKey})')
    assert not store['local'] and store['session']
    record('Save/test UI works; key cleared from input and remains session-only')
    options_page.locator('#testVision').click()
    options_page.locator('#connectionMessage').filter(has_text='图片识别通过').wait_for()
    record('Vision test UI sends a real generated image to the mocked API')
    options_page.set_viewport_size({'width':1150,'height':1000})
    options_page.screenshot(path=str(OUT/(args.browser+'-settings.png')),full_page=True)

    page,tab=course('/course'); start(tab)
    frame=page.frame(url=HOST+'/questions')
    frame.locator('input[value="B"]').wait_for(state='attached')
    until(lambda: frame.locator('input[value="B"]').is_checked())
    assert status(tab)['calls']==1
    page.wait_for_timeout(2500)
    assert status(tab)['calls']==1
    record('Nested-frame question parsed and filled once; repeated ticks do not bill again')
    # The content-script isolated world cannot read local/session areas.
    access=worker.evaluate('''async tabId=>chrome.scripting.executeScript({target:{tabId},func:async()=>{
      const result={};for(const area of ['local','session']){try{await chrome.storage[area].get(null);result[area]='accessible'}catch{result[area]='denied'}}return result;
    }})''',tab)
    assert access[0]['result']=={'local':'denied','session':'denied'},access
    record('API key storage is denied to the content-script world')
    popup=context.new_page()
    # Simulate the toolbar popup's active course tab; all other popup code,
    # including its messages, state rendering and buttons, runs unchanged.
    popup.add_init_script('chrome.tabs.query=async()=>'+json.dumps([{'id':tab,'url':HOST+'/course'}]))
    popup.goto(f'chrome-extension://{extension_id}/popup.html');popup.wait_for_load_state('networkidle')
    expect(popup.locator('#statusTitle')).to_have_text('正在托管')
    expect(popup.locator('#answer')).to_have_text('B')
    record('Popup renders live worker state and most recent answer')
    popup.set_viewport_size({'width':392,'height':900});popup.screenshot(path=str(OUT/(args.browser+'-popup.png')),full_page=True)
    page.screenshot(path=str(OUT/(args.browser+'-course.png')),full_page=True)
    stop(tab)

    page,tab=course('/course');start(tab)
    frame=page.frame(url=HOST+'/questions')
    until(lambda:frame.locator('input[value="B"]').is_checked())
    assert status(tab)['calls']==0
    assert len(status(tab)['results'])==1,'Cached answers must remain visible in this tab popup'
    record('Cross-tab cached answers appear in results without another API request');stop(tab)

    page,tab=course('/types');start(tab)
    until(lambda: page.frame_locator('#ueditor_0').locator('body').inner_text()!='')
    assert page.locator('#plain-short').input_value()!=''
    assert page.locator('input[name="multi"]').nth(0).is_checked()
    assert not page.locator('input[name="multi"]').nth(1).is_checked()
    assert page.locator('input[name="multi"]').nth(2).is_checked()
    assert 'check_answer' in (page.locator('.num_option_dx').nth(0).get_attribute('class') or '')
    assert 'check_answer' not in (page.locator('.num_option_dx').nth(1).get_attribute('class') or '')
    assert 'check_answer' in (page.locator('.num_option_dx').nth(2).get_attribute('class') or '')
    assert page.locator('input[name="judge"]').nth(0).is_checked()
    assert page.locator('input[type="text"]').nth(0).input_value()=='2'
    assert page.locator('input[type="text"]').nth(1).input_value()=='4'
    record('Multiple choice (native & custom .num_option_dx), boolean, two blanks, textarea and UEditor iframe fill correctly');stop(tab)

    page,tab=course('/low');start(tab)
    until(lambda: len(status(tab)['results'])==1)
    until(lambda:page.locator('input[value="B"]').is_checked())
    record('Low self-rating does not prevent automatic selection');stop(tab)

    page,tab=course('/image');start(tab)
    until(lambda:page.locator('textarea').input_value()!='')
    assert status(tab)['results'][0]['visual'] is True
    image=worker.evaluate('()=>fixtureRequests.filter(r=>Array.isArray(r.body.messages[1].content)).at(-1).body.messages[1].content.find(p=>p.type==="image_url").image_url.url')
    (OUT/(args.browser+'-question-crop.jpg')).write_bytes(base64.b64decode(image.split(',')[1]))
    record('Image question captured through Edge debugger and filled from multimodal response');stop(tab)

    page,tab=course('/cross-image');start(tab)
    frame=page.frame(url='https://ananas.chaoxing.com/image')
    until(lambda:frame.locator('textarea').input_value()!='')
    assert status(tab)['results'][0]['visual'] is True
    record('Cross-origin course iframe image crop is captured and solved');stop(tab)

    page,tab=course('/secret-font');start(tab)
    until(lambda:page.locator('.num_option').nth(1).get_attribute('class').endswith('check_answer'))
    assert status(tab)['results'][0]['visual'] is True
    record('Encoded-font questions use screenshots and fill visible aria-hidden custom options');stop(tab)

    page,tab=course('/portal')
    snapshots=worker.evaluate('async tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>globalThis.__KEBAN_SNAPSHOT__()})',tab)
    snapshot=snapshots[0]['result']
    assert '在线学习诚信承诺书' not in snapshot['text']
    assert any('数学爱我们' in control['label'] for control in snapshot['controls'])
    assert not any(control['label']=='进入课程' for control in snapshot['controls'])
    record('Planner excludes hidden text and covered controls while exposing actual chapter links')

    page,tab=course('/graded');start(tab)
    until(lambda:any(frame.get('completed') for frame in status(tab).get('frames',{}).values()))
    assert status(tab)['calls']==0
    assert all(frame['pending']==0 for frame in status(tab)['frames'].values())
    record('Actual graded-work completion marker prevents solving readonly result questions');stop(tab)

    page,tab=course('/existing');start(tab);page.wait_for_timeout(2500)
    assert page.locator('input[value="A"]').is_checked() and status(tab)['calls']==0
    record('User-existing answer preserved');stop(tab)

    for path in ['/captcha','/exam/test','/commitment']:
        page,tab=course(path);start(tab)
        until(lambda: bool(status(tab).get('blocked')))
        assert not status(tab)['running'] and status(tab)['calls']==0
        record(path+' pauses before answering')

    save(maxCalls=1)
    page,tab=course('/budget');start(tab)
    until(lambda: not status(tab)['running'])
    assert status(tab)['calls']==1
    assert any('上限' in row['text'] for row in status(tab)['logs'])
    record('Per-run request cap stops extra calls across questions')
    save(maxCalls=30)

    page,tab=course('/submit');start(tab)
    until(lambda: page.locator('input[value="B"]').is_checked());page.wait_for_timeout(2000)
    assert page.locator('body').get_attribute('data-submitted') is None
    record('Disabled submission preserves filled answers without clicking submit');stop(tab)
    save(autoSubmit=True)
    page,tab=course('/submit');start(tab)
    until(lambda: page.locator('body').get_attribute('data-submitted')=='yes')
    record('Opt-in chapter-exercise submit uses filled model answers');stop(tab);save(autoSubmit=False)

    save(autoSubmit=True,autoConfirm=True)
    page,tab=course('/confirm');start(tab)
    page.locator('#arrived').wait_for(timeout=20000)
    record('Submit, explicit confirmation, success detection and next chapter complete continuously');stop(tab);save(autoSubmit=False)

    save(autoSubmit=True,autoConfirm=True)
    page,tab=course('/task-tabs');start(tab)
    page.locator('#arrived').wait_for(timeout=25000)
    assert any('打开本章章节测验' in row['text'] for row in status(tab)['logs'])
    record('Video natural end opens the quiz task tab, submits it, then advances with video iframe removed');stop(tab);save(autoSubmit=False)

    save(autoSubmit=True,autoConfirm=True)
    page,tab=course('/outer-confirm');start(tab)
    until(lambda:page.locator('body').get_attribute('data-confirmed')=='yes')
    record('An exercise iframe authorizes exactly its submission confirmation in the parent frame');stop(tab);save(autoSubmit=False)

    save(visualAgent=True,agentInterval=8000)
    page,tab=course('/agent');start(tab)
    until(lambda:page.locator('body').get_attribute('data-operated')=='yes',timeout=20000)
    until(lambda:status(tab).get('actions',0)==1)
    record('Screenshot planner selects a fresh DOM control and executes one verified click');stop(tab);save(visualAgent=False)

    page,tab=course('/video');start(tab)
    page.locator('#arrived').wait_for(timeout=20000)
    record('Real media natural playback in iframe reaches ended and advances chapter');stop(tab)

    page,tab=course('/video-quiz');start(tab)
    page.locator('#arrived').wait_for(timeout=25000)
    assert status(tab)['calls']==1
    record('Chaoxing in-video popup quiz detected by polling, answered, submitted, and video resumes to next chapter');stop(tab)

    page,tab=course('/completed-video');start(tab)
    page.locator('#arrived').wait_for(timeout=12000)
    assert any('平台已标记' in row['text'] for row in status(tab)['logs'])
    record('Platform-completed video tasks advance without replaying the full video');stop(tab)

    page,tab=course('/all-done-catalog');start(tab)
    until(lambda:status(tab).get('completed') and not status(tab)['running'],timeout=12000)
    assert any('全部章节均已完成' in row['text'] for row in status(tab)['logs'])
    record('Self-check finishes immediately when all catalog chapters are already completed');stop(tab)

    save(stallTimeout=15000,autoRefresh=True)
    page,tab=course('/stalled-reload');start(tab)
    until(lambda:status(tab).get('completed') and not status(tab)['running'],timeout=30000)
    assert stalled_hits>=2 and any('正在自动刷新页面恢复' in row['text'] for row in status(tab)['logs'])
    record('Unresponsive page triggers self-check auto-refresh and resumes to completion');stop(tab);save(stallTimeout=45000)

    page,tab=course('/mixed');start(tab)
    frame=page.frame(url=HOST+'/mixed-frame')
    until(lambda:frame.locator('input[value="B"]').is_checked())
    page.wait_for_timeout(8500)
    assert '/mixed?' in page.url,'Do not navigate away from filled but unsubmitted exercises'
    record('Filled exercises awaiting submission prevent chapter navigation');stop(tab)

    page,tab=course('/course')
    msg('KP_SCAN',tabId=tab)
    frame=page.frame(url=HOST+'/questions')
    until(lambda:frame.locator('input[value="B"]').is_checked())
    assert status(tab)['running']
    stop(tab)
    save(autoFill=False)
    page,tab=course('/course')
    msg('KP_SCAN',tabId=tab)
    frame=page.frame(url=HOST+'/questions')
    until(lambda:len(status(tab)['results'])==1)
    assert not frame.locator('input[value="B"]').is_checked()
    msg('KP_FILL',tabId=tab)
    until(lambda:frame.locator('input[value="B"]').is_checked())
    record('Parse automatically selects answers; explicit fill remains available when automatic filling is disabled');stop(tab)
    save(autoFill=True)

    worker.evaluate("() => {fixtureMode='401'}")
    msg('KP_SAVE_SETTINGS',settings={**msg('KP_GET_SETTINGS'),'model':'qwen-turbo'})
    page,tab=course('/course');start(tab)
    until(lambda:not status(tab)['running'])
    assert any('401' in x['text'] for x in status(tab)['logs'])
    record('HTTP 401 stops automation with actionable message')
    worker.evaluate("() => {fixtureMode='delay'}")
    page,tab=course('/course');start(tab)
    until(lambda:status(tab)['calls']==1)
    stop(tab);worker.evaluate("() => {fixtureMode='ok'}");page.wait_for_timeout(2000)
    frame=page.frame(url=HOST+'/questions')
    assert not frame.locator('input[value="B"]').is_checked()
    record('Stopping cancels in-flight answer and prevents filling')

    worker.evaluate("() => {fixtureMode='delay'}")
    page,tab=course('/course');start(tab)
    until(lambda:status(tab)['calls']==1)
    frame=page.frame(url=HOST+'/questions')
    frame.evaluate('''()=>{const captcha=document.createElement('div');captcha.setAttribute('data-study-captcha','');captcha.textContent='请输入验证码';document.body.append(captcha)}''')
    until(lambda:bool(status(tab).get('blocked')))
    assert not status(tab)['running'] and not frame.locator('input[value="B"]').is_checked()
    worker.evaluate("() => {fixtureMode='ok'}")
    record('CAPTCHA appearing during an API request cancels it before filling')

    save(rememberKey=True)
    store=worker.evaluate('async()=>({local:!!(await chrome.storage.local.get("settings")).settings.apiKey,session:!!(await chrome.storage.session.get("apiKey")).apiKey})')
    assert store=={'local':True,'session':False}
    msg('KP_SAVE_SETTINGS',settings=msg('KP_GET_SETTINGS'),clearKey=True)
    store=worker.evaluate('async()=>({local:!!(await chrome.storage.local.get("settings")).settings.apiKey,session:!!(await chrome.storage.session.get("apiKey")).apiKey})')
    assert store=={'local':False,'session':False}
    record('Remember/delete moves and removes the key from both storage areas')
    assert not browser_errors,browser_errors
    record('No uncaught browser page errors')
    result={'browser':args.browser,'version':context.browser.version,'checks':checks,'passed':len(checks),'real_course_tested':False,'real_api_tested':False}
    (OUT/(args.browser+'-report.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    context.close()
    print('TOTAL:',len(checks),'passed',flush=True)
