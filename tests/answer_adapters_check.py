"""Offline answer adapters: page variants, model output and numbered blanks."""
import argparse
import json
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright
from browser_support import browser_options

ROOT = Path(__file__).resolve().parents[1]
CASES = ['chapter-single', 'chapter-multiple', 'work-single', 'work-multiple',
    'boolean-icon', 'boolean-type', 'choice-format', 'unsupported-type',
    'fill-count', 'fill-empty', 'fill-cache', 'fill-rich', 'fill-mixed', 'option-text', 'root-multiple', 'root-multiple-edit', 'fill-feedback',
    'select-match', 'select-chosen', 'select-repeat', 'select-feedback', 'select-race',
    'fill-accounting', 'fill-materials', 'slow-multiple', 'slow-single',
    'fill-local-save', 'fill-local-save-hide', 'fill-local-save-retry', 'fill-local-save-disabled', 'fill-local-save-stop', 'fill-local-save-edit', 'select-review-edit', 'select-stop-race', 'select-write-disabled', 'fill-local-save-noack', 'select-delayed', 'select-manual-fill', 'select-image']
BASE = '<!doctype html><meta charset=utf-8><title>离线适配器</title><style>body{font:17px sans-serif;padding:20px}.option,label{display:block;padding:10px}textarea{width:500px;height:65px}iframe{width:550px;height:100px}.check_answer,.check_answer_dx{color:blue}button{padding:12px}</style>'


def fixture(name, count=2):
    multiple = name.endswith('multiple') or name.startswith('root-multiple') or name == 'choice-format'
    metadata = 1 if multiple else 3 if name.startswith('boolean-') else 11 if name == 'unsupported-type' else 0
    title = '离线题干，请根据材料作答。'
    root = 'singleQuesId' if name.startswith('chapter-') else 'questionLi' if name.startswith('work-') else 'TiMu'
    hidden = '<input type=hidden id=answertype1 value=' + str(metadata) + '>'
    if name.startswith('work-'):
        hidden = '<input type=hidden name=questionId1 value=123><input type=hidden name=type123 value=' + str(metadata) + '>'
    if name == 'boolean-icon': title = '【判断题】离线命题是否成立？'
    if name == 'boolean-type': title = '离线材料中的“多选”一词是否符合定义？'
    if name.startswith('select-'):
        root='mark_item';hidden='<input type=hidden id=answertype1 value=11>'
        title='【连线题】将离线左侧材料与右侧定义对应。'
        content='<div class=B_stem><div class=order_answer>(1) 第一个材料</div><div class=order_answer>(2) 第二个材料</div></div><div class=beautiSelect><ul class=thirdUlList>'
        for index in range(2):
            content+='<li index="'+str(index+1)+'"><select data-blank'+(' style="display:none"' if name=='select-chosen' else '')+' onchange="this.dataset.changed=String(Number(this.dataset.changed||0)+1)"><option value="">请选择</option><option value=A>A. 第一个定义</option><option value=B>B. 第二个定义</option></select><a class=chosen-single><span>请选择</span></a></li>'
        content+='</ul></div>'
        if name=='select-image':content='<img width=120 height=40 src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27120%27 height=%2740%27%3E%3Ctext y=%2725%27%3Eoffline%3C/text%3E%3C/svg%3E">'+content
    elif name.startswith('fill-'):
        root = 'mark_item'
        hidden = '<input type=hidden id=answertype1 value='+('9' if name=='fill-accounting' else '10' if name=='fill-materials' else '2')+'>'
        title = '【填空题】按顺序填写离线材料中的词语。'
        count = 3 if name == 'fill-empty' else count
        fields = ''.join('<div class=blankItemDiv><textarea data-blank name=blank' + str(i) + '></textarea></div>' for i in range(count))
        if name in ['fill-rich','fill-materials'] or name.startswith('fill-local-save'):
            fields = ''.join('<div class=blankItemDiv><iframe data-blank srcdoc="<body contenteditable=true></body>"></iframe><textarea class=payload hidden></textarea></div>' for _ in range(count))
        if name.startswith('fill-local-save'):
            fields=fields.replace('</textarea></div>','</textarea><div class=savebtndiv><button class=saveButtonClass onclick="saveLocal(this)">保存</button><span class=save-status role=status></span></div></div>')
        if name == 'fill-mixed':
            fields = '<div class=blankItemDiv><iframe data-blank srcdoc="<body contenteditable=true></body>"></iframe><textarea class=payload hidden></textarea></div><div class=blankItemDiv><textarea data-blank></textarea></div>'
        content = fields
    else:
        rows = []
        for index, letter in enumerate('CBDA' if multiple else 'BA'):
            if name.startswith('chapter-'):
                cls = 'before-after-checkbox' if multiple else 'before-after'
                marker = 'answercheck' if multiple else 'answer'
                rows.append('<div class="option ' + cls + '" data-letter=' + letter + ' onclick="choose(this)"><span name=' + marker + str(index) + '>' + letter + '</span> 选项' + letter + '</div>')
            elif name.startswith('work-'):
                cls = 'num_option_dx' if multiple else 'num_option'
                rows.append('<div class="option answerBg" data-letter=' + letter + ' onclick="choose(this)"><span class=' + cls + '>' + letter + '</span> 选项' + letter + '</div>')
            else:
                text = ('<i class=u-icon-wrong></i>' if letter == 'A' else '<i class=u-icon-correct></i>') if name == 'boolean-icon' else '选项' + letter
                if name == 'option-text':text='.'+('Apple' if letter=='A' else 'Beta')
                kind = 'checkbox' if multiple else 'radio'
                rows.append('<label data-letter=' + letter + '><input type=' + kind + ' name=q value=' + letter + ' onchange="choose(this.parentElement,true)"><span class=num_option>' + letter + '</span>' + text + '</label>')
        content = ''.join(rows)
        if name == 'chapter-single':content='<ul class=Zy_ulTop>'+''.join('<li>'+row+'</li>' for row in rows)+'</ul>'
    question = '<section id=paper><div class=' + root + '>' + hidden + '<h3 class=' + ('mark_name' if root == 'mark_item' else 'Zy_TItle') + '>' + title + '</h3>' + content + '</div><span id=feedback class=ans-videoquiz-error></span><button id=submit>提交</button></section>'
    script = r'''
    window.submissions=[];window.selected=new Set();window.UE={instants:{}};window.savedRows=[];window.saveCalls=[0,0];window.chosenUpdates=0;
    const multiple=MULTIPLE;
    function choose(row,native=false){
      if(location.pathname.includes('/slow-')){row.setAttribute('aria-busy','true');setTimeout(()=>{row.removeAttribute('aria-busy');chooseNow(row,native);},1700);return;}
      chooseNow(row,native);}
    function chooseNow(row,native=false){const letter=row.dataset.letter;if(!multiple)selected.clear();
      if(native){if(row.querySelector('input').checked)selected.add(letter);else selected.delete(letter);}
      else if(multiple&&selected.has(letter))selected.delete(letter);else selected.add(letter);
      if(!native)document.querySelectorAll('[data-letter]').forEach(el=>el.querySelector('span').classList.toggle(multiple?'check_answer_dx':'check_answer',selected.has(el.dataset.letter)));
      if(location.pathname.includes('root-multiple')){const node=document.querySelector('.TiMu');node.replaceWith(node.cloneNode(true));document.querySelectorAll('[data-letter]').forEach(el=>el.querySelector('input').checked=selected.has(el.dataset.letter));}}
    function mount(){const frames=[...document.querySelectorAll('iframe[data-blank]')];
      if(frames.some(f=>!f.contentDocument?.body?.isContentEditable)){setTimeout(mount,40);return;}
      frames.forEach((frame,index)=>{const payload=frame.parentElement.querySelector('.payload');
        UE.instants['blank'+index]={isReady:true,body:frame.contentDocument.body,iframe:frame,container:frame.parentElement,textarea:payload,
          setContent(html){this.body.innerHTML=html;},getContent(){return this.body.innerHTML;},getContentTxt(){return this.body.innerText;},fireEvent(){},sync(){payload.value=this.body.innerText;}};});}
    mount();document.getElementById('submit').onclick=()=>{
      const blanks=[...document.querySelectorAll('.blankItemDiv')];
      const selects=[...document.querySelectorAll('select[data-blank]')];
      submissions.push(selects.length?selects.map(n=>n.value):location.pathname.includes('fill-local-save')?savedRows.slice():blanks.length?blanks.map(n=>n.querySelector('.payload,textarea[data-blank]').value):[...selected].sort());
      if(selects.length){window.lastSelectChanges=selects.map(n=>Number(n.dataset.changed||0));window.lastChosenLabels=selects.map(n=>n.parentElement.querySelector('.chosen-single span').textContent);}
      if((location.pathname.endsWith('fill-feedback')||location.pathname.endsWith('select-feedback'))&&submissions.length===1){document.getElementById('feedback').textContent='回答错误';return;}
      document.getElementById('paper').remove();document.body.innerHTML+='<p data-study-submitted>提交成功</p>';};
    function saveLocal(button){const row=button.closest('.blankItemDiv'),index=[...document.querySelectorAll('.blankItemDiv')].indexOf(row);saveCalls[index]++;
      const status=row.querySelector('.save-status');button.setAttribute('aria-busy','true');
      setTimeout(()=>{button.removeAttribute('aria-busy');if(location.pathname.endsWith('retry')&&saveCalls[index]===1){status.textContent='保存失败，请重试';return;}
        savedRows[index]=row.querySelector('.payload').value;if(!location.pathname.endsWith('noack')){status.textContent='保存成功';button.disabled=true;}
        if(location.pathname.endsWith('hide'))row.querySelector('iframe').style.display='none';},/save-(stop|edit)$/.test(location.pathname)?1500:220);}
    if(location.pathname.endsWith('select-chosen'))window.jQuery=field=>({trigger(name){if(name==='chosen:updated'){chosenUpdates++;field.parentElement.querySelector('.chosen-single span').textContent=field.selectedOptions[0].textContent;}}});
    if(location.pathname.endsWith('select-delayed'))document.querySelectorAll('select').forEach((field,index)=>field.addEventListener('change',()=>{field.disabled=true;field.parentElement.setAttribute('aria-busy','true');setTimeout(()=>{field.disabled=false;field.parentElement.removeAttribute('aria-busy');},index===0?2800:400);}));
    '''.replace('MULTIPLE', json.dumps(multiple))
    return BASE + question + '<script>' + script + '</script>'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', action='append', choices=CASES)
    parser.add_argument('--red', action='store_true')
    args = parser.parse_args()
    results = []
    with tempfile.TemporaryDirectory(prefix='study-pilot-adapters-') as profile, sync_playwright() as p:
        extension = ROOT / 'extension'
        context = p.chromium.launch_persistent_context(profile, headless=True, **browser_options(),
            args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'])
        def route(request):
            parsed = urlparse(request.request.url)
            name = parsed.path.rsplit('/', 1)[-1]
            count = int(parse_qs(parsed.query).get('count', ['2'])[0])
            request.fulfill(content_type='text/html; charset=utf-8', body=fixture(name, count))
        context.route('https://mooc1.chaoxing.com/adapter/**', route)
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        worker.evaluate(r'''()=>{globalThis.adapterCalls=[];globalThis.adapterProofIds=[];globalThis.scenario='';
          const setSession=chrome.storage.session.set.bind(chrome.storage.session);
          chrome.storage.session.set=async(data)=>{for(const state of Object.values(data))if(state?.submission?.proofs)adapterProofIds=state.submission.proofs.map(p=>p.questionId);return setSession(data);};
          globalThis.fetch=async(url,opts)=>{
          const body=JSON.parse(opts.body),content=body.messages[1].content,q=JSON.parse(Array.isArray(content)?content.find(item=>item.type==='text').text:content),phase=q.review?.phase||'solve';adapterCalls.push(q);
          if(scenario==='select-review-edit'&&phase==='self-check')await new Promise(resolve=>setTimeout(resolve,1800));
          let answers=scenario.endsWith('multiple')||scenario.startsWith('root-multiple')?['A','C','D']:['B'];
          if(scenario==='choice-format')answers=['ａ，Ｃ，Ｄ','A'];
          if(scenario==='boolean-icon')answers=['正确'];
          if(scenario.startsWith('select-'))answers=scenario==='select-repeat'?['A','A']:scenario==='select-feedback'&&!q.review?.feedback?['A','B']:['B','A'];
          if(scenario.startsWith('fill-')){
            const full=['first','second','third'].slice(0,scenario==='fill-mixed'?2:q.blankCount||1);
            answers=scenario==='fill-empty'&&phase!=='assistant'?['first','','third']:scenario==='fill-count'&&phase==='solve'?['first']:full;
            if(scenario==='fill-feedback'&&!q.review?.feedback)answers=['wrong-first','wrong-second'];
          }
          return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({answers,confidence:0.95,explanation:'offline fixture'})}}],usage:{total_tokens:1}}));};}''')
        options = context.new_page()
        options.goto(worker.url.rsplit('/', 1)[0] + '/options.html')
        options.locator('#apiKey').wait_for()
        def msg(kind, **extra):
            response = options.evaluate('(m)=>chrome.runtime.sendMessage(m)', {'type':kind, **extra})
            assert response['ok'], response
            return response['data']
        def until(predicate):
            end = time.monotonic() + (8 if args.red else 25)
            while time.monotonic() < end:
                if predicate(): return
                options.wait_for_timeout(80)
            raise AssertionError('Expected adapter result did not appear')
        try:
            for name in args.only or CASES:
                pages = []
                tabs = []
                try:
                    settings = msg('KP_GET_SETTINGS')
                    settings.update(endpoint='https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey='offline-adapter-key',model='adapter-'+name,
                        reviewEnabled=True, reviewProfiles=[{'id':'helper','model':'adapter-helper-'+name}],
                        useVision=name=='select-image',visionModel='adapter-vision-'+name,visualAgent=False,keepActive=False,autoSolve=True,autoFill=name not in ['select-write-disabled','select-manual-fill'],autoSubmit=name!='fill-local-save-disabled',autoConfirm=True,autoRefresh=False,requestGap=2000,maxCalls=25)
                    msg('KP_SAVE_SETTINGS', settings=settings)
                    worker.evaluate('(name)=>{scenario=name;adapterCalls=[];adapterProofIds=[]}', name)
                    for count in ([1,2] if name == 'fill-cache' else [2]):
                        page = context.new_page();pages.append(page)
                        page.goto('https://mooc1.chaoxing.com/adapter/'+name+'?count='+str(count))
                        tab = options.evaluate('(u)=>chrome.tabs.query({}).then(ts=>ts.find(t=>t.url===u).id)',page.url);tabs.append(tab)
                        before = worker.evaluate('adapterCalls.length')
                        if name in ['select-race','select-stop-race']:
                            worker.evaluate('''()=>{globalThis.originalSelectExecute=chrome.scripting.executeScript;const execute=originalSelectExecute.bind(chrome.scripting);globalThis.selectPaused=false;globalThis.selectRelease=null;
                              chrome.scripting.executeScript=async(spec)=>{if(spec.world==='MAIN'){selectPaused=true;await new Promise(r=>selectRelease=r);}return execute(spec);};}''')
                        msg('KP_START',tabId=tab)
                        if name=='select-manual-fill':
                            until(lambda:worker.evaluate('adapterCalls.length')>=2);msg('KP_FILL',tabId=tab)
                        if name == 'select-write-disabled':
                            until(lambda:worker.evaluate('adapterCalls.length')>=2)
                            page.locator('select').first.evaluate("el=>el.setAttribute('data-keban-select','offline-select-token')")
                            generation=msg('KP_STATUS',tabId=tab)['generation']
                            denied=options.evaluate('''({tab,generation})=>chrome.scripting.executeScript({target:{tabId:tab},args:[generation],func:async(generation)=>chrome.runtime.sendMessage({type:'KP_SELECT_WRITE',generation,fieldToken:'offline-select-token',value:'B',expected:'',syncOnly:true})})''',{'tab':tab,'generation':generation})
                            assert denied[0]['result']['data'].get('stopped') and page.locator('select').first.input_value()==''
                        elif name == 'select-stop-race':
                            until(lambda:worker.evaluate('selectPaused'))
                            msg('KP_STOP',tabId=tab);worker.evaluate('()=>selectRelease?.()');page.wait_for_timeout(800)
                            assert page.locator('select').first.input_value()=='' and page.evaluate('submissions')==[], 'A queued page-world select write must not run after stop'
                        elif name == 'select-race':
                            until(lambda:worker.evaluate('selectPaused'))
                            page.locator('select').first.select_option('A')
                            worker.evaluate('()=>selectRelease?.()')
                            until(lambda:not msg('KP_STATUS',tabId=tab)['running'])
                            assert page.locator('select').first.input_value()=='A' and page.evaluate('submissions')==[], 'Preserve a select changed while the page-world write is pending'
                        elif name == 'fill-local-save-noack':
                            until(lambda:not msg('KP_STATUS',tabId=tab)['running'])
                            assert page.evaluate('saveCalls')==[1,0] and page.evaluate('submissions')==[], 'An unconfirmed local save must not be repeated or followed by global submission'
                        elif name in ['fill-local-save-stop','fill-local-save-edit']:
                            until(lambda:page.evaluate('saveCalls[0]')>0)
                            if name.endswith('stop'):msg('KP_STOP',tabId=tab)
                            else:page.frame_locator('iframe').first.locator('body').fill('人工修改的正文')
                            page.wait_for_timeout(1700)
                            assert page.evaluate('submissions')==[] and page.evaluate('saveCalls')==[1,0], 'Do not continue saving or submitting after stop or an intervening edit'
                            if name.endswith('edit'):assert page.frame_locator('iframe').first.locator('body').inner_text()=='人工修改的正文'
                        elif name == 'select-review-edit':
                            until(lambda:worker.evaluate('adapterCalls.some(q=>q.review?.phase==="self-check")'))
                            page.locator('select').first.select_option('A')
                            until(lambda:not msg('KP_STATUS',tabId=tab)['running'])
                            assert page.locator('select').first.input_value()=='A' and page.evaluate('submissions')==[], 'A partially edited matching question must not be overwritten after model review'
                        elif name == 'fill-local-save-disabled':
                            until(lambda:page.frame_locator('iframe').first.locator('body').inner_text()!='')
                            page.wait_for_timeout(1000)
                            assert page.evaluate('saveCalls')==[0,0] and page.evaluate('submissions')==[], 'Do not save to the server when automatic submission is disabled'
                        elif name == 'root-multiple-edit':
                            until(lambda:page.evaluate('selected.size')>0)
                            page.locator('[data-letter=D] input').check()
                            until(lambda: not msg('KP_STATUS',tabId=tab)['running'])
                            assert page.evaluate('submissions')==[] and page.evaluate('[...selected].sort()')==['A','D'], 'Preserve human edits even when the whole question root was replaced'
                        elif name == 'unsupported-type':
                            page.wait_for_timeout(2600)
                            assert worker.evaluate('adapterCalls.length') == 0 and page.evaluate('submissions') == [], 'Do not treat unsupported numeric question types as a single choice'
                        else:
                            until(lambda:page.locator('[data-study-submitted]').count() or bool(msg('KP_STATUS',tabId=tab)['blocked']))
                            state=msg('KP_STATUS',tabId=tab)
                            expected = ['A','A'] if name=='select-repeat' else ['B','A'] if name.startswith('select-') else ['first','second','third'] if name=='fill-empty' else ['first','second'][:count] if name.startswith('fill-') else ['A','C','D'] if name.endswith('multiple') or name=='choice-format' else ['B']
                            expected_submissions=[['A','B'],expected] if name=='select-feedback' else [['wrong-first','wrong-second'],expected] if name=='fill-feedback' else [expected]
                            assert page.evaluate('submissions') == expected_submissions, 'Wrong submitted answer or missing fill: '+str(state.get('blocked'))
                            calls=worker.evaluate('adapterCalls')
                            if name.startswith('fill-'):
                                expected_count=3 if name=='fill-empty' else count
                                assert calls[before]['blankCount']==expected_count, 'The model must receive the exact number of blanks'
                                assert worker.evaluate('adapterProofIds')==[state['results'][0]['questionId']], 'Solving, submission proofs and wrong-answer feedback must use the same blank-count identity'
                                if name=='fill-cache': assert len(calls)>before, 'Different blank counts must not reuse another answer cache entry'
                            if name.startswith('boolean-'):assert calls[0]['type']=='boolean', 'Use the explicit question type before guessing from stem words'
                            if name.startswith('select-'):
                                assert calls[0]['type']=='fill' and len(calls[0]['slots'])==2 and calls[0]['blankCount']==2
                                assert worker.evaluate('adapterProofIds')==[state['results'][0]['questionId']], 'Matching choices must keep the same identity in submission proofs'
                                assert page.evaluate('lastSelectChanges')==([2,2] if name=='select-feedback' else [1,1]), 'Do not replay a change event on an already selected matching value'
                                if name=='select-chosen': assert page.evaluate('chosenUpdates')>=2 and all('请选择' not in text for text in page.evaluate('lastChosenLabels'))
                                if name=='select-delayed':assert len(calls)==2, 'Temporarily disabled dropdowns must not create another question or bill another model review'
                                if name=='select-image':assert calls[0]['slots'][0]['options'][0]['text']=='A. 第一个定义', 'Image matching must still provide the descriptions of closed native dropdown choices'
                            if name.startswith('fill-local-save'):
                                assert page.evaluate('saveCalls')==([2,2] if name.endswith('retry') else [1,1]), 'Save each changed answer once, with bounded retries after a reported failure'
                            if name == 'option-text':assert calls[0]['options']==[{'label':'A','text':'Apple'},{'label':'B','text':'Beta'}], 'Strip the printed marker exactly once without losing the first character of the option'
                        msg('KP_STOP',tabId=tab)
                    results.append({'case':name,'passed':True});print('PASS:',name,flush=True)
                except Exception as error:
                    result={'case':name,'passed':False,'error':str(error),'calls':worker.evaluate('adapterCalls.length')}
                    if tabs:result['blocked']=msg('KP_STATUS',tabId=tabs[-1])['blocked']
                    results.append(result);print('FAIL:',json.dumps(result),flush=True)
                finally:
                    if name in ['select-race','select-stop-race']:worker.evaluate('()=>{chrome.scripting.executeScript=originalSelectExecute;selectRelease?.();}')
                    for tab in tabs:msg('KP_STOP',tabId=tab)
                    for page in pages:page.close()
        finally:
            context.close()
    report={'checks':results,'passed':sum(r['passed'] for r in results),'all_passed':all(r['passed'] for r in results),
        'complete_suite':not args.only and not args.red,'real_api_tested':False,'real_course_tested':False}
    (ROOT/'test-results'/('answer-adapters-red-report.json' if args.red else 'answer-adapters-report.json')).write_text(json.dumps(report,indent=2),encoding='utf-8')
    return 0 if report['all_passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
