"""Offline model-review and platform rejection integration checks."""
import argparse
import json
import tempfile
import time
import io
import wave
from pathlib import Path
from urllib.parse import urlparse

from browser_support import browser_options
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
CASES = ['wrong-no-repeat', 'existing-error', 'high-self-check', 'low-assisted', 'uncertain', 'self-correction', 'disagreement-high',
    'disagreement', 'unresolved', 'wrong-repair', 'wrong-stubborn', 'stale-feedback', 'manual-edit',
    'budget', 'cancel', 'image', 'image-font', 'separate-service', 'helper-failure', 'batch-feedback',
    'slow-frame', 'video-resume', 'malformed-primary', 'budget-change', 'key-race', 'ui-shared', 'ui-independent', 'ui-multiple', 'click-reversed-native', 'click-reversed-custom',
    'click-correct-custom', 'click-no-proof', 'click-delayed-flip', 'click-before-submit', 'candidate-display', 'click-multiple-exact', 'click-duplicate-labels',
    'existing-correct', 'existing-correct-manual', 'wrong-infer', 'click-recover',
    'soft-low', 'soft-missing-score', 'soft-disagreement', 'soft-rejected', 'ui-confidence-policy', 'click-recover-stuck', 'auto-scan',
    'auto-legacy-gate', 'auto-existing', 'auto-existing-edit', 'auto-single',
    'click-multiple-dx', 'click-multiple-work-dx', 'click-multiple-redraw', 'click-multiple-delayed',
    'click-multiple-native', 'click-multiple-no-proof', 'click-multiple-stop', 'click-multiple-manual-edit']
MULTIPLE_CASES = ['click-multiple-dx', 'click-multiple-work-dx', 'click-multiple-redraw', 'click-multiple-delayed',
    'click-multiple-native', 'click-multiple-no-proof', 'click-multiple-stop', 'click-multiple-manual-edit']
BASE = '<!doctype html><meta charset=utf-8><style>body{font:18px Arial;padding:20px}label,button{display:block;padding:10px}</style>'
QUESTION = '<div class=TiMu><h3 class=Zy_TItle>【判断题】离线样例中甲概念与乙概念完全相同。</h3><label><input type=radio name=q value=A>A.对</label><label><input type=radio name=q value=B>B.错</label></div>'


def check_editor(name, page, msg, worker):
    page.reload()
    page.locator('#apiKey').wait_for()
    if name=='ui-confidence-policy':
        expect(page.locator('#confidenceGate')).to_have_count(0)
        expect(page.locator('#minConfidence')).to_have_count(0)
        assert 'confidenceGate' not in msg('KP_GET_SETTINGS')
        assert 'minConfidence' not in msg('KP_GET_SETTINGS')
        page.locator('#autoAssessments').locator('xpath=ancestor::fieldset').screenshot(path=str(ROOT/'test-results/settings-automatic-v084.png'))
        return
    page.locator('#fetchModels').click()
    expect(page.locator('#modelMessage')).to_contain_text('已读取')
    page.locator('#addReviewer').click()
    card = page.locator('.review-card').first
    if name == 'ui-independent':
        card.locator('[data-field=inheritConnection]').uncheck()
        card.locator('[data-field=endpoint]').fill('https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
        card.locator('[data-field=apiKey]').fill('offline-helper-key')
        card.locator('[data-action=fetch]').click()
        expect(card.locator('[data-message]')).to_contain_text('已读取')
    card.locator('[data-field=modelSelect]').select_option('helper-one-ui')
    card.locator('[data-field=visionSelect]').select_option('helper-vision-ui')
    if name == 'ui-multiple':
        for model in ['helper-two-ui','helper-three-ui']:
            page.locator('#addReviewer').click()
            page.locator('.review-card').last.locator('[data-field=model]').fill(model)
        expect(page.locator('#addReviewer')).to_be_disabled()
    page.get_by_role('button',name='保存并用于课程',exact=True).click()
    expect(page.locator('#message')).to_contain_text('已保存')
    saved = msg('KP_GET_SETTINGS')
    assert len(saved['reviewProfiles']) == (3 if name=='ui-multiple' else 1)
    assert all(not profile['apiKey'] for profile in saved['reviewProfiles'])
    if name == 'ui-independent':
        assert not saved['reviewProfiles'][0]['inheritConnection'] and saved['reviewProfiles'][0]['hasKey']
        stored = worker.evaluate('()=>chrome.storage.local.get("settings")')
        assert 'offline-helper-key' not in json.dumps(stored), 'Session-only helper Key must not enter local storage'
        page.reload();card=page.locator('.review-card').first
        expect(card.locator('[data-field=apiKey]')).to_have_value('')
        card.locator('[data-action=test]').click()
        expect(card.locator('[data-message]')).to_contain_text('连接成功')
        card.locator('[data-action=testVision]').click()
        expect(card.locator('[data-message]')).to_contain_text('图片识别通过')
        card.locator('[data-field=endpoint]').fill('https://dashscope-us.aliyuncs.com/compatible-mode/v1')
        before=worker.evaluate('directories.length')
        card.locator('[data-action=fetch]').click()
        expect(card.locator('[data-message]')).to_contain_text('请填写')
        assert worker.evaluate('directories.length')==before
        card.locator('[data-field=apiKey]').fill('new-offline-helper-key')
        card.locator('[data-action=fetch]').click()
        expect(card.locator('[data-message]')).to_contain_text('已读取')
        assert worker.evaluate('directories.at(-1).auth==="Bearer new-offline-helper-key"')
        card.locator('[data-action=clearKey]').click()
        expect(card.locator('[data-message]')).to_contain_text('已从本机')
        saved=msg('KP_GET_SETTINGS')
        assert saved['hasKey'] and not saved['reviewProfiles'][0]['hasKey']
    elif name == 'ui-multiple':
        page.locator('.review-card').nth(1).locator('[data-action=remove]').click()
        page.get_by_role('button',name='保存并用于课程',exact=True).click()
        expect(page.locator('#message')).to_contain_text('已保存')
        assert len(msg('KP_GET_SETTINGS')['reviewProfiles'])==2
    else:
        assert saved['reviewProfiles'][0]['inheritConnection']
        page.set_viewport_size({'width':1365,'height':900})
        page.evaluate('window.scrollTo(0,0)')
        page.screenshot(path=str(ROOT/'test-results/review-settings-desktop.png'),full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        page.evaluate('window.scrollTo(0,0)')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Settings must fit mobile width'
        page.screenshot(path=str(ROOT/'test-results/review-settings-mobile.png'),full_page=True)
        page.set_viewport_size({'width':1280,'height':720})


def check_key_race(page, msg, worker):
    changed=msg('KP_GET_SETTINGS')
    changed['reviewProfiles'][0].update(endpoint='https://dashscope-us.aliyuncs.com/compatible-mode/v1',apiKey='new-offline-helper-key')
    worker.evaluate('''()=>{globalThis.originalLocalSet=chrome.storage.local.set;const original=chrome.storage.local.set.bind(chrome.storage.local);
        globalThis.racePaused=false;globalThis.raceRelease=null;let hold=true;
        chrome.storage.local.set=async(data)=>{await original(data);if(hold&&data.settings){hold=false;racePaused=true;await new Promise(resolve=>raceRelease=resolve)}};
    }''')
    try:
        page.evaluate('(settings)=>{globalThis.raceSave=chrome.runtime.sendMessage({type:"KP_SAVE_SETTINGS",settings});return true}',changed)
        deadline=time.monotonic()+10
        while not worker.evaluate('racePaused') and time.monotonic()<deadline:page.wait_for_timeout(50)
        assert worker.evaluate('racePaused'), 'Settings write did not reach the controlled checkpoint'
        page.evaluate('''()=>{globalThis.raceList=chrome.runtime.sendMessage({type:'KP_LIST_MODELS',profileId:'one',
            connection:{endpoint:'https://dashscope-us.aliyuncs.com/compatible-mode/v1'}});return true}''')
        page.wait_for_timeout(800)
    finally:
        worker.evaluate('()=>{chrome.storage.local.set=originalLocalSet;raceRelease?.()}')
    assert page.evaluate('()=>raceSave')['ok']
    assert page.evaluate('()=>raceList')['ok']
    assert not worker.evaluate('directories.some(d=>d.url.includes("dashscope-us")&&d.auth==="Bearer offline-helper-key")'), 'A concurrent save must not forward the old helper Key to the new service'
    assert worker.evaluate('directories.at(-1).auth==="Bearer new-offline-helper-key"')
    worker.evaluate('''async()=>{const {settings}=await chrome.storage.local.get('settings');
        settings.reviewProfiles[0].endpoint='https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
        settings.endpoint='https://dashscope-us.aliyuncs.com/compatible-mode/v1';
        await chrome.storage.local.set({settings});}''')
    safe=msg('KP_GET_SETTINGS')
    assert not safe['hasKey'] and not safe['reviewProfiles'][0]['hasKey'], 'Session Keys must remain bound to their own service origin'
    before=worker.evaluate('directories.length')
    denied=page.evaluate('''()=>chrome.runtime.sendMessage({type:'KP_LIST_MODELS',profileId:'one',
        connection:{endpoint:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'}})''')
    assert not denied['ok'] and worker.evaluate('directories.length')==before


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', action='append', choices=CASES)
    parser.add_argument('--red', action='store_true')
    args = parser.parse_args()
    results = []
    with tempfile.TemporaryDirectory(prefix='study-pilot-review-') as profile, sync_playwright() as p:
        extension = ROOT / 'extension'
        context = p.chromium.launch_persistent_context(profile, headless=True, **browser_options(),
            args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'])
        audio = io.BytesIO()
        with wave.open(audio, 'wb') as wav:
            wav.setparams((1,2,8000,0,'NONE','not compressed'));wav.writeframes(b'\x00\x00'*8000*30)
        def route(request):
            path = urlparse(request.request.url).path
            name = path.split('/review-')[-1]
            if path.endswith('/long.wav'):
                request.fulfill(content_type='audio/wav',body=audio.getvalue());return
            if path.endswith('/marker.svg'):
                request.fulfill(content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><text y="25">offline</text></svg>')
                return
            question = QUESTION
            if name in ['wrong-repair','wrong-stubborn','stale-feedback','manual-edit', 'existing-correct-manual','soft-rejected']:
                question = question.replace('【判断题】', '【单选题】').replace('</div>', '<label><input type=radio name=q value=C>C.第三项</label></div>')
            if name == 'image':
                question = question.replace('</h3>', '<img src=/marker.svg></h3>')
            if name == 'image-font':
                question = question.replace('class=TiMu', 'class="TiMu font-cxsecret"')
            if name == 'click-reversed-native':
                question = '<div class=TiMu><h3 class=Zy_TItle>【判断题】可见字母与DOM顺序不一致</h3><div style="display:flex;flex-direction:column"><label style="order:2"><input type=radio name=q value=1>B.错</label><label style="order:1"><input type=radio name=q value=0>A.对</label></div></div>'
            if name in ['click-reversed-custom','click-correct-custom','click-no-proof','click-recover','click-recover-stuck']:
                rows = ['B','A'] if name == 'click-reversed-custom' else ['A','B']
                question = '<div class=TiMu><h3 class=Zy_TItle>【判断题】自定义选项准确性</h3>' + ''.join(
                    '<div role=radio aria-checked=false data-choice="'+letter+'" onclick="choose(this)">'+letter+'、'+('对' if letter=='A' else '错')+'</div>' for letter in rows) + '</div>'
                question += '<script>function choose(node){window.actualChoice=node.dataset.choice;'+('' if name=='click-no-proof' else "document.querySelectorAll('[role=radio]').forEach(el=>el.setAttribute('aria-checked',String(el===node)));")+'}</script>'
                if name in ['click-recover','click-recover-stuck']:
                    question+='''<script>window.aAttempts=0;const originalChoose=choose;choose=node=>{originalChoose(node);if(node.dataset.choice==='A'){aAttempts++;if(aAttempts===1||location.pathname.includes('stuck'))setTimeout(()=>originalChoose(document.querySelector('[data-choice=B]')),80);}}</script>'''
            if name == 'click-delayed-flip':
                question = question.replace('value=A',"""value=A onclick="setTimeout(()=>document.querySelector('input[value=B]').checked=true,80)""" + '"')
            if name == 'candidate-display':question = question.replace('value=B','value=B checked')
            if name == 'click-duplicate-labels':question = question.replace('B.错','A.错')
            if name == 'click-multiple-exact':
                question = '<div class=TiMu><h3 class=Zy_TItle>【多选题】只选择A和C</h3><ul class=Zy_ulTop>'+''.join('<li><span class=num_option_dx onclick="this.classList.toggle(&quot;check_answer&quot;)">'+letter+'</span> '+letter+'选项</li>' for letter in ['C','B','A'])+'</ul></div>'

            body = question + '<script>window.submissions=[]</script>'
            if name.startswith('auto-'):
                question='<div class=TiMu><h3 class=Zy_TItle>【单选题】离线四选项课程样例</h3>'+''.join(
                    '<label><input type=radio name=q value='+letter+(' checked' if letter=='B' and name.startswith('auto-existing') else '')+'>'+letter+'.选项'+letter+'</label>' for letter in 'ABCD')+'</div>'
                body='<div id=work>'+question+'''<button id=submit onclick="submissions.push(document.querySelector('input:checked')?.value);document.getElementById('work').remove();document.body.innerHTML+='<p data-study-submitted>提交成功</p>'">提交</button></div><script>window.submissions=[]</script>'''
            if name.startswith('click-'):
                body += """<button id=submit onclick="submissions.push(window.actualChoice||document.querySelector('input:checked')?.value)">提交</button>"""
            if name in MULTIPLE_CASES:
                work = name == 'click-multiple-work-dx'
                selected_class = 'check_answer_dx' if name.endswith('dx') else 'check_answer'
                body = ('<div id=work class=' + ('mark_item' if work else 'TiMu') + '><h3 class=' +
                    ('mark_name' if work else 'Zy_TItle') + '>【多选题】选择A、C、D，排除B</h3><ul id=options class=' +
                    ('mark_letter' if work else 'Zy_ulTop') + '></ul><input type=hidden id=saved-answer value=B>' +
                    '<button id=submit>提交</button></div><script>window.submissions=[];window.multiState=new Set(["B"]);window.multiClicks=[];' +
                    'const selectedClass=' + json.dumps(selected_class) + ';' + '''
                    function renderMulti(){document.getElementById('options').innerHTML=['C','B','D','A'].map((letter,index)=>{
                      if(location.pathname.endsWith('native'))return '<li data-letter="'+letter+'"><label><input type=checkbox style="display:none" data-letter="'+letter+'" value="'+index+'" '+(multiState.has(letter)?'checked':'')+' onchange="recordNative(this)"><span class=num_option_dx>'+letter+'</span> 选项'+letter+'</label></li>';
                      return '<li data-letter="'+letter+'" '+(location.pathname.endsWith('delayed')?'onclick="toggleMulti(this.firstElementChild)"':'')+'><span class="num_option_dx '+(multiState.has(letter)&&!location.pathname.endsWith('no-proof')?selectedClass:'')+'" '+(location.pathname.endsWith('delayed')?'':'onclick="toggleMulti(this)"')+'>'+letter+'</span> 选项'+letter+'</li>';}).join('');}
                    function recordNative(input){const letter=input.dataset.letter;multiClicks.push(letter);if(input.checked)multiState.add(letter);else multiState.delete(letter);document.getElementById('saved-answer').value=[...multiState].sort().join('');}
                    function toggleMulti(node){const letter=node.textContent;multiClicks.push(letter);const update=()=>{
                      if(multiState.has(letter))multiState.delete(letter);else multiState.add(letter);
                      document.getElementById('saved-answer').value=[...multiState].sort().join('');
                      if(location.pathname.endsWith('redraw'))renderMulti();else if(!location.pathname.endsWith('no-proof'))node.classList.toggle(selectedClass,multiState.has(letter));};
                      if(location.pathname.endsWith('delayed'))setTimeout(update,350);else update();}
                    renderMulti();document.getElementById('submit').onclick=()=>{submissions.push({visible:[...multiState].sort(),saved:document.getElementById('saved-answer').value});
                      if(JSON.stringify([...multiState].sort())==='["A","C","D"]'){document.getElementById('work').remove();document.body.innerHTML+='<p data-study-submitted>提交成功</p>';}};</script>''')
            if name in ['click-correct-custom','click-recover','click-recover-stuck']:
                body = '<div class=ans-videoquiz>'+body+"""<span id=feedback></span></div><script>document.getElementById('submit').onclick=()=>{submissions.push(actualChoice);if(actualChoice==='B')document.getElementById('feedback').textContent='回答错误';else{document.querySelector('.ans-videoquiz').remove();document.body.innerHTML+='<p data-study-submitted>提交成功</p>';}};</script>"""
            if name == 'existing-error':
                body = '<div class=ans-videoquiz>'+question.replace('value=B','value=B checked')+'<span class=ans-videoquiz-error>回答错误</span><button onclick="submissions.push(1)">提交</button></div><script>window.submissions=[]</script>'
            if name in ['existing-correct','existing-correct-manual']:
                body='<div id=work class=ans-videoquiz>'+question.replace('value=B','value=B checked')+'''<span class=ans-videoquiz-error>回答错误</span><button onclick="const choice=document.querySelector('input:checked')?.value;submissions.push(choice);if(choice==='A'){document.getElementById('work').remove();document.body.innerHTML+='<p data-study-submitted>提交成功</p>';}">提交</button></div><script>window.submissions=[]</script>'''
            if name.startswith('wrong-') or name in ['stale-feedback', 'manual-edit', 'video-resume','soft-rejected']:
                body = '<div id=work class=ans-videoquiz>' + question + '''<span id=feedback class=ans-videoquiz-error></span><button id=submit>提交</button></div><script>
                    window.submissions=[];document.getElementById('submit').onclick=()=>{
                      const choice=document.querySelector('input:checked')?.value;submissions.push(choice);
                      const finish=()=>{document.getElementById('work').remove();const done=document.createElement('p');done.setAttribute('data-study-submitted','');done.textContent='提交成功';document.body.append(done);};
                      if(choice==='A'&&!location.pathname.includes('stubborn')&&!location.pathname.includes('no-repeat')){
                        if(location.pathname.includes('video-resume')){document.getElementById('feedback').textContent='回答正确';const button=document.getElementById('submit');button.textContent='继续';button.onclick=()=>{document.getElementById('work').remove();document.body.dataset.continued='yes';};}
                        else if(location.pathname.includes('stale-feedback'))setTimeout(finish,5000);else finish();
                      }else document.getElementById('feedback').textContent='回答错误';
                    };</script>'''
                if name == 'video-resume': body = '<video id=media controls muted style="width:320px;height:180px" src=/long.wav></video>' + body
                if name == 'video-resume' and not urlparse(request.request.url).query:
                    body = '<iframe src="/review-video-resume?frame=1" style="width:850px;height:650px"></iframe>'
            if name == 'batch-feedback':
                body = question + question.replace('name=q', 'name=second').replace('甲概念', '丙概念') + '''<span id=feedback></span><button onclick="submissions.push([...document.querySelectorAll('input:checked')].map(n=>n.value));document.getElementById('feedback').textContent='回答错误'">提交</button><script>window.submissions=[]</script>'''
            if name == 'slow-frame':
                body = '<input id=chapterIdid value=701 type=hidden><div class="ans-job-icon ans-job-video" aria-label="任务点已完成"></div><video></video><iframe src=/review-frame style="width:800px;height:500px"></iframe><a data-study-next onclick="document.body.dataset.arrived=\'yes\'">下一节</a>'
            request.fulfill(content_type='text/html; charset=utf-8', body=BASE + body)
        context.route('https://*.chaoxing.com/**', route)
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            worker.evaluate('''()=>{globalThis.calls=[];globalThis.directories=[];globalThis.mode='';globalThis.fetch=async(url,opts)=>{
                const json=data=>new Response(JSON.stringify(data));
                if(!opts.body){directories.push({url,auth:opts.headers.Authorization});return json({data:[{id:'primary-ui'},{id:'helper-one-ui',input_modalities:['text','image']},{id:'helper-vision-ui',input_modalities:['text','image']}]});}
                const body=JSON.parse(opts.body),content=body.messages[1].content;
                let input;try{input=JSON.parse(Array.isArray(content)?content.find(x=>x.type==='text').text:content)}catch{input={};}
                if(!input.type)return json({choices:[{message:{content:'{"ok":true}'}}]});
                if(!input.review&&input.text.includes('识别图片'))return json({choices:[{message:{content:'{"answers":["4"],"confidence":1}'}}]});
                const phase=input.review?.phase||'solve',feedback=!!input.review?.feedback;
                calls.push({url,model:body.model,phase,input,auth:opts.headers.Authorization,image:Array.isArray(content)?content.find(x=>x.type==='image_url')?.image_url.url:null});
                const delay=ms=>new Promise((resolve,reject)=>{const timer=setTimeout(resolve,ms);opts.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Stopped','AbortError'))},{once:true});});
                if(mode==='cancel'&&phase==='self-check')await delay(10000);
                if(mode==='budget-change'&&phase==='self-check')await delay(10000);
                if(mode==='slow-frame'&&phase==='self-check')await delay(10500);
                if(mode==='auto-existing-edit'&&phase==='self-check')await delay(2200);
                if(['manual-edit','existing-correct-manual'].includes(mode)&&feedback&&phase==='solve')await delay(2200);
                if(mode==='helper-failure'&&body.model.startsWith('helper-one'))return new Response('{"error":{"message":"fixture-provider-private"}}',{status:503});
                if(mode==='malformed-primary'&&phase==='solve')return json({choices:[{message:{content:'not a JSON answer'}}],usage:{total_tokens:3}});
                let choice='A',confidence=0.96,uncertain=false;
                if(mode.startsWith('auto-')){confidence=0.85;uncertain=true;}
                if(['click-correct-custom','click-recover','click-recover-stuck','wrong-infer','wrong-no-repeat','wrong-repair','wrong-stubborn','stale-feedback','manual-edit','batch-feedback','video-resume','soft-rejected'].includes(mode))choice=feedback?'A':'B';
                if(mode==='wrong-infer'&&feedback)confidence=undefined;
                if(['soft-low','auto-scan'].includes(mode))confidence=0.85;
                if(mode==='soft-missing-score'||(mode==='soft-rejected'&&feedback))confidence=undefined;
                if(mode==='soft-disagreement'){if(phase==='solve'){confidence=0.85;uncertain=true;}if(phase==='assistant')choice='B';}
                if(mode==='candidate-display'){choice=phase==='solve'?'B':'A';if(phase!=='assistant')confidence=undefined;}
                if(mode==='wrong-stubborn')choice='B';
                if(mode==='existing-error')choice='B';
                if(phase==='solve'&&['low-assisted','disagreement','unresolved','budget','budget-change','image','image-font','separate-service','helper-failure','slow-frame'].includes(mode)){confidence=0.85;uncertain=true;}
                if(mode==='uncertain'&&phase==='solve')uncertain=true;
                if(mode==='self-correction'&&phase!=='solve')choice='B';
                if(mode==='disagreement-high'&&phase==='self-check')choice='B';
                if(['disagreement','unresolved'].includes(mode)&&phase==='assistant')choice='B';
                if(mode==='disagreement'&&phase==='final')choice='B';
                return json({choices:[{message:{content:JSON.stringify({answers:mode==='click-multiple-exact'?['A','C']:mode.startsWith('click-multiple-')?['A','C','D']:[choice],confidence,uncertain,explanation:'offline independent reasoning'})}}],usage:{total_tokens:3}});
            }}''')
            options = context.new_page()
            options.goto(worker.url.rsplit('/',1)[0]+'/options.html')
            options.locator('#apiKey').wait_for()
            def msg(kind, **extra):
                response = options.evaluate('(m)=>chrome.runtime.sendMessage(m)', {'type':kind, **extra})
                assert response['ok'], response
                return response['data']
            def until(predicate, timeout=40000):
                deadline = time.monotonic() + timeout/1000
                while time.monotonic() < deadline:
                    if predicate():
                        return
                    options.wait_for_timeout(100)
                raise AssertionError('Expected review state did not appear')
            for name in args.only or CASES:
                page = context.new_page()
                tab = None
                try:
                    settings = msg('KP_GET_SETTINGS')
                    settings.update(endpoint='https://maas.qianwenaiapi.com/compatible-mode/v1', apiKey='offline-review-key',
                        model='primary-'+name, visionModel='primary-vision-'+name, useVision=name in ['image','image-font'], visualAgent=False, keepActive=False,
                        autoSolve=True, autoFill=True, autoSubmit=True, autoConfirm=True, autoRefresh=True,
                        reviewEnabled=name not in ['wrong-no-repeat','batch-feedback'], confidenceGate=not name.startswith('soft-'), requestGap=2000, minConfidence=0.9, maxCalls=30,
                        reviewProfiles=[{'id':'one','model':'helper-one-'+name,'visionModel':'helper-vision-'+name}])
                    if name=='auto-single':settings['reviewProfiles']=[]
                    if name == 'budget': settings['maxCalls'] = 2
                    if name in ['slow-frame','click-multiple-exact']: settings['autoSubmit'] = False
                    if name.startswith('ui-'):
                        settings.update(model='primary-ui',visionModel='primary-ui',reviewProfiles=[])
                    if name in ['separate-service','key-race']: settings['reviewProfiles'][0].update(inheritConnection=False,
                        endpoint='https://dashscope-intl.aliyuncs.com/compatible-mode/v1', apiKey='offline-helper-key', rememberKey=False)
                    if name == 'helper-failure': settings['reviewProfiles'].append({'id':'two','model':'helper-two-'+name})
                    msg('KP_SAVE_SETTINGS', settings=settings)
                    worker.evaluate('(name)=>{mode=name;calls=[];directories=[]}', name)
                    if name=='key-race':
                        check_key_race(options,msg,worker)
                        results.append({'case':name,'passed':True}); print('PASS:',name,flush=True)
                        continue
                    if name.startswith('ui-'):
                        check_editor(name, options, msg, worker)
                        results.append({'case':name,'passed':True}); print('PASS:',name,flush=True)
                        continue
                    page.goto('https://mooc1.chaoxing.com/review-'+name)
                    tab = options.evaluate('(u)=>chrome.tabs.query({}).then(ts=>ts.find(t=>t.url===u).id)',page.url)
                    if name == 'click-before-submit':
                        # Simulate a page update/user change while submission permission is awaited.
                        worker.evaluate('''()=>{globalThis.originalSubmitSet=chrome.storage.session.set;const write=originalSubmitSet.bind(chrome.storage.session);
                            chrome.storage.session.set=async(data)=>{await write(data);if(Object.values(data).some(s=>s?.submission?.phase==='awaiting_confirmation'))await new Promise(r=>setTimeout(r,500));};}''')
                        page.evaluate('''()=>{const timer=setInterval(()=>{if(document.querySelector('input[value=A]:checked')){clearInterval(timer);setTimeout(()=>document.querySelector('input[value=B]').checked=true,200);}},10);}''')
                    msg('KP_SCAN' if name=='auto-scan' else 'KP_START',tabId=tab)
                    if name.startswith('auto-'):
                        if name=='auto-existing-edit':
                            until(lambda:worker.evaluate('calls.some(c=>c.phase==="self-check")'))
                            page.locator('input[value=C]').check()
                            until(lambda:not msg('KP_STATUS',tabId=tab)['running'])
                            assert page.locator('input[value=C]').is_checked() and page.evaluate('submissions')==[], 'Preserve a selection edited during review'
                        else:
                            until(lambda:page.locator('[data-study-submitted]').count() or bool(msg('KP_STATUS',tabId=tab)['blocked']))
                            assert page.evaluate('submissions')==['A'], 'A completed candidate must be selected and submitted automatically, including legacy settings, existing selections and a single model'
                            assert page.locator('[data-study-submitted]').count()
                    elif name in ['click-reversed-native','click-reversed-custom']:
                        until(lambda: len(worker.evaluate('calls')) >= 2)
                        page.wait_for_timeout(600)
                        if name=='click-reversed-native':
                            assert page.locator('input[value="0"]').is_checked(), 'Model A must select visible A even when DOM/value order differs'
                            page.screenshot(path=str(ROOT/'test-results/selection-mapping-edge.png'),full_page=True)
                        else:assert page.locator('[data-choice=A]').get_attribute('aria-checked')=='true', 'Visible A must map to the actual A control'
                    elif name in MULTIPLE_CASES:
                        if name in ['click-multiple-stop','click-multiple-manual-edit']:
                            until(lambda:page.evaluate('multiClicks.length')>0)
                            if name=='click-multiple-stop':msg('KP_STOP',tabId=tab)
                            else:page.locator('[data-letter=D] .num_option_dx').click()
                            page.wait_for_timeout(1600)
                            assert page.evaluate('submissions')==[], 'Do not submit after stop or an intervening human edit'
                            assert page.evaluate('multiClicks')==(['A'] if name=='click-multiple-stop' else ['A','D']), 'Do not continue clicking other options after cancellation or a human edit'
                            results.append({'case':name,'passed':True});print('PASS:',name,flush=True)
                            continue
                        until(lambda:page.locator('[data-study-submitted]').count() or not msg('KP_STATUS',tabId=tab)['running'])
                        state=msg('KP_STATUS',tabId=tab)
                        if name=='click-multiple-no-proof':
                            assert page.evaluate('submissions')==[] and '选项点击' in state['blocked'], 'A hidden answer value alone must not bypass selected-state verification'
                            assert len(page.evaluate('multiClicks'))<=18, 'Unresponsive multi-choice controls must have bounded retries'
                            results.append({'case':name,'passed':True});print('PASS:',name,flush=True)
                            continue
                        assert page.evaluate('submissions')==[{'visible':['A','C','D'],'saved':'ACD'}], 'Select the exact multi-choice set, clear B, sync the page field and submit once: '+str(state.get('blocked'))
                        assert page.locator('[data-study-submitted]').count() and not state['blocked']
                        assert sorted(page.evaluate('multiClicks'))==['A','B','C','D'], 'Each changed option must be clicked once without toggling it back'
                    elif name == 'click-multiple-exact':
                        until(lambda:len(worker.evaluate('calls'))>=2)
                        page.wait_for_timeout(1300)
                        assert page.locator('.check_answer').all_text_contents()==['C','A'], 'Custom multi-select must select the exact A/C set without B'
                        assert not msg('KP_STATUS',tabId=tab)['blocked']
                    elif name=='click-duplicate-labels':
                        until(lambda:not msg('KP_STATUS',tabId=tab)['running'])
                        assert not page.locator('input:checked').count() and worker.evaluate('calls.length')==0, 'Ambiguous printed letters must stop before solving or clicking'
                        assert '选项字母' in msg('KP_STATUS',tabId=tab)['blocked']
                    elif name in ['click-correct-custom','click-recover']:
                        until(lambda:page.locator('[data-study-submitted]').count() or not msg('KP_STATUS',tabId=tab)['running'])
                        assert page.evaluate('submissions')==['B','A'], 'Custom single choice must not reselect the rejected B while correcting to A'
                        assert page.locator('[data-study-submitted]').count(), 'Automatic correction must finish the platform interaction'
                        if name=='click-recover':assert page.evaluate('aAttempts')==2, 'Transient correction must automatically retry the intended option'
                    elif name=='click-recover-stuck':
                        until(lambda:not msg('KP_STATUS',tabId=tab)['running'])
                        assert page.evaluate('aAttempts')==3 and page.evaluate('submissions')==['B'], 'Broken controls must have bounded retries without resubmitting the wrong selection'
                    elif name in ['existing-correct','wrong-infer','soft-rejected']:
                        until(lambda:page.locator('[data-study-submitted]').count() or not msg('KP_STATUS',tabId=tab)['running'])
                        assert page.evaluate('submissions')==(['A'] if name=='existing-correct' else ['B','A']), 'Revised known answer must be selected and submitted without asking the user'
                        assert page.locator('[data-study-submitted]').count()
                        if name=='wrong-infer':
                            assert len(worker.evaluate('calls'))==2, 'A precise rejected alternative determines this two-option answer without another model call'
                            assert msg('KP_STATUS',tabId=tab)['results'][0]['review']['status']=='platform_inferred'
                        if name=='soft-rejected':assert msg('KP_STATUS',tabId=tab)['results'][0]['review']['status'] in ['assisted','adjudicated','best_effort']
                    elif name.startswith('soft-'):
                        until(lambda:page.locator('input[value=A]').is_checked() or not msg('KP_STATUS',tabId=tab)['running'])
                        assert page.locator('input[value=A]').is_checked(), 'Low or missing self-ratings must not block automatic selection in the default mode'
                        state=msg('KP_STATUS',tabId=tab)
                        assert state['running'] and not state['blocked'] and state['results'][0]['review']['status'] in ['best_effort','self_checked']
                    elif name=='existing-correct-manual':
                        until(lambda:worker.evaluate('calls.some(c=>c.phase==="solve"&&c.input.review?.feedback)'))
                        page.locator('input[value=C]').check()
                        until(lambda:not msg('KP_STATUS',tabId=tab)['running'])
                        assert page.locator('input[value=C]').is_checked() and page.evaluate('submissions')==[], 'Initial error recovery must preserve edits made during review'
                    elif name in ['click-no-proof','click-delayed-flip','click-before-submit']:
                        until(lambda:len(worker.evaluate('calls'))>=2)
                        page.wait_for_timeout(1800)
                        assert page.evaluate('submissions')==[], 'Never submit when the real selected state is missing or has changed after filling'
                        if name=='click-no-proof':assert not any('已填写' in x['text'] for x in msg('KP_STATUS',tabId=tab)['logs']), 'A plugin-only marker is not proof of platform selection'
                    elif name=='candidate-display':
                        until(lambda:page.locator('input[value=A]').is_checked())
                        popup=context.new_page();popup.add_init_script('chrome.tabs.query=async()=>'+json.dumps([{'id':tab,'url':page.url}]))
                        try:
                            popup.goto(worker.url.rsplit('/',1)[0]+'/popup.html')
                            expect(popup.locator('#answer')).to_contain_text('A')
                            expect(popup.locator('#retry')).to_have_count(0)
                            assert page.locator('input[value=A]').is_checked() and not msg('KP_STATUS',tabId=tab)['blocked'], 'The reviewed answer must replace the original selection'
                        finally:popup.close()
                    elif name in ['wrong-no-repeat','batch-feedback']:
                        until(lambda: page.evaluate('submissions.length') > 0)
                        page.wait_for_timeout(14000)
                        submitted=page.evaluate('submissions')
                        assert submitted==(['B','A'] if name=='wrong-no-repeat' else [['B','B'],['A','A']]), 'Submit each changed answer combination once; never repeat a rejected combination'
                        if name == 'batch-feedback':
                            state=msg('KP_STATUS',tabId=tab)
                            assert len(state['answerFeedback'])==2 and all(not item['rejected'] for item in state['answerFeedback']), 'Whole-form failure must not label every individual answer wrong'
                    elif name == 'existing-error':
                        until(lambda: page.evaluate('submissions.length')>0 or not msg('KP_STATUS',tabId=tab)['running'])
                        assert page.evaluate('submissions')==[], 'An existing error with no submission proof must not be blindly resubmitted'
                        assert worker.evaluate('calls.some(call=>call.phase==="assistant")'), 'Existing platform feedback should still trigger independent review'
                    elif name in ['wrong-repair','stale-feedback']:
                        until(lambda: page.locator('[data-study-submitted]').count()>0)
                        assert page.evaluate('submissions')==['B','A'], 'Correct a rejected answer before submitting again'
                        assert len(worker.evaluate('calls'))==5
                    elif name == 'video-resume':
                        frame=page.frame(url='https://mooc1.chaoxing.com/review-video-resume?frame=1')
                        until(lambda: frame.get_attribute('body','data-continued')=='yes')
                        until(lambda: frame.locator('video').evaluate('(v)=>!v.paused&&v.currentTime>0'))
                        assert frame.evaluate('submissions')==['B','A'] and len(worker.evaluate('calls'))==2
                    elif name == 'wrong-stubborn':
                        until(lambda: not msg('KP_STATUS',tabId=tab)['running'])
                        assert page.evaluate('submissions')==['B']
                        msg('KP_START',tabId=tab)
                        until(lambda: not msg('KP_STATUS',tabId=tab)['running'])
                        assert page.evaluate('submissions')==['B'], 'Restart must retain rejected-answer proof'
                    elif name == 'manual-edit':
                        until(lambda: worker.evaluate('calls.some(c=>c.phase==="solve"&&c.input.review?.feedback)'))
                        page.locator('input[value=C]').check()
                        until(lambda: not msg('KP_STATUS',tabId=tab)['running'])
                        assert page.locator('input[value=C]').is_checked(), 'Do not overwrite a user edit during model review'
                        assert page.evaluate('submissions')==['B']
                    elif name == 'cancel':
                        until(lambda: worker.evaluate('calls.some(c=>c.phase==="self-check")'))
                        msg('KP_STOP',tabId=tab); page.wait_for_timeout(2300)
                        assert len(worker.evaluate('calls'))==2 and not page.locator('input:checked').count()
                    elif name == 'budget-change':
                        until(lambda: worker.evaluate('calls.some(c=>c.phase==="self-check")'))
                        changed=msg('KP_GET_SETTINGS');changed['maxCalls']=2;msg('KP_SAVE_SETTINGS',settings=changed)
                        until(lambda: len(worker.evaluate('calls'))>2 or not msg('KP_STATUS',tabId=tab)['running'])
                        assert len(worker.evaluate('calls'))==2 and not page.locator('input:checked').count(), 'Honor a changed limit before the next assistant request'
                    elif name == 'unresolved':
                        until(lambda:page.locator('input[value=A]').is_checked())
                        assert not msg('KP_STATUS',tabId=tab)['blocked']
                    elif name == 'budget':
                        until(lambda: not msg('KP_STATUS',tabId=tab)['running'])
                        assert not page.locator('input:checked').count()
                        if name=='budget':
                            state=msg('KP_STATUS',tabId=tab)
                            assert state['calls']==2 and state['tokens']==6 and '上限' in state['blocked']
                            assert len(worker.evaluate('calls'))==2
                    else:
                        target=page.frame(url='https://mooc1.chaoxing.com/review-frame') if name=='slow-frame' else page
                        if name=='slow-frame':
                            until(lambda: worker.evaluate('calls.some(c=>c.phase==="self-check")'))
                            page.wait_for_timeout(10500)
                            assert page.get_attribute('body','data-arrived') is None, 'Do not navigate while a child frame is still reviewing'
                        expected='B' if name in ['self-correction','disagreement'] else 'A'
                        if name=='malformed-primary':
                            until(lambda: target.locator('input[value=A]').is_checked() or not msg('KP_STATUS',tabId=tab)['running'])
                            assert target.locator('input[value=A]').is_checked(), 'A malformed primary answer should enter review, not end the whole run'
                        until(lambda: target.locator('input[value='+expected+']').is_checked())
                        if name=='slow-frame':
                            until(lambda:any(selection['answers']==['A'] and selection['questionId']==msg('KP_STATUS',tabId=tab)['results'][0]['questionId'] for frame in msg('KP_STATUS',tabId=tab)['frames'].values() for selection in frame.get('selections',[])))
                        calls=worker.evaluate('calls'); state=msg('KP_STATUS',tabId=tab)
                        count=2 if name=='high-self-check' else 4 if name in ['disagreement','disagreement-high','helper-failure'] else 3
                        assert len(calls)==count, 'Count every solve, check and assistant request'
                        assert state['calls']==count and state['tokens']==(count-(name=='helper-failure'))*3
                        if name in ['image','image-font']:
                            assert all(call['image'] and call['image']==calls[0]['image'] for call in calls), 'All models must receive the same captured question'
                            assert calls[0]['model'].startswith('primary-vision') and calls[-1]['model'].startswith('helper-vision')
                            assert all(call['input'].get('imageIsAuthoritative') for call in calls)
                        if name=='separate-service':
                            assert calls[-1]['url'].startswith('https://dashscope-intl.aliyuncs.com/') and calls[-1]['auth']=='Bearer offline-helper-key'
                            assert all(call['auth']=='Bearer offline-review-key' for call in calls[:2])
                            safe=options.evaluate('(id)=>chrome.scripting.executeScript({target:{tabId:id},func:()=>chrome.runtime.sendMessage({type:"KP_STATE"})})',tab)
                            assert 'offline-helper-key' not in json.dumps(safe) and 'offline-review-key' not in json.dumps(safe)
                            before=len(calls)
                            denied=options.evaluate('(id)=>chrome.scripting.executeScript({target:{tabId:id},func:()=>chrome.runtime.sendMessage({type:"KP_TEST_REVIEW",profileId:"one"})})',tab)
                            assert not denied[0]['result']['ok'] and len(worker.evaluate('calls'))==before
                    results.append({'case':name,'passed':True})
                    print('PASS:',name,flush=True)
                except Exception as error:
                    results.append({'case':name,'passed':False,'error':str(error) or type(error).__name__})
                    if tab is not None:
                        state=msg('KP_STATUS',tabId=tab)
                        results[-1].update(blocked=state.get('blocked'), calls=state.get('calls'),
                            stages=worker.evaluate('calls.map(c=>({phase:c.phase,model:c.model,feedback:!!c.input.review?.feedback}))'))
                    print('FAIL:',json.dumps(results[-1]),flush=True)
                finally:
                    if name=='click-before-submit':worker.evaluate('()=>{if(globalThis.originalSubmitSet)chrome.storage.session.set=originalSubmitSet;}')
                    if tab is not None:
                        msg('KP_STOP',tabId=tab)
                    page.close()
        finally:
            context.close()
    report = {'checks':results,'passed':sum(row['passed'] for row in results),'all_passed':all(row['passed'] for row in results),
        'complete_suite':not args.only and not args.red,'real_api_tested':False,'real_course_tested':False}
    (ROOT/'test-results'/('review-red-report.json' if args.red else 'review-report.json')).write_text(json.dumps(report,indent=2),encoding='utf-8')
    return 0 if report['all_passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
