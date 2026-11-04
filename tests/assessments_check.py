"""Offline assessment forms and real browser-world editor synchronization."""
import argparse
import json
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from browser_support import browser_options
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CASES = ['work-plain', 'work-rich', 'work-sync', 'work-multiple', 'work-minlength',
    'work-draft-only', 'work-user-edit', 'work-editor-wait', 'work-editor-stop',
    'exam-text', 'exam-pages', 'exam-intro', 'exam-disabled', 'work-submitted', 'work-editor-race', 'work-sync-string', 'work-existing-sync', 'work-existing-sync-fill', 'exam-local-save', 'work-sync-stop-race', 'work-manual-rich-fill']
LONG = ('这是离线材料的第一段，用于检验文本框实际保存内容和字数要求。' * 32
    + '\n\n' + '第二段保留换行与字面符号 & <script>window.answerInjected=true</script>。' * 4)
SHORT = '这是离线文本框作答。\n\n第二段保留换行和字面符号 & <script>window.answerInjected=true</script>。'
BASE = '<!doctype html><meta charset=utf-8><title>离线作业作答</title><style>body{font:16px sans-serif;padding:20px}textarea{width:600px;height:120px}iframe{width:650px;height:240px}button{padding:8px;margin:8px}.mark_item{padding:12px;border:1px solid #ccc} [contenteditable]{min-height:100px}</style>'


def fixture(name):
    title = '【简答题】离线第一题，请在文本框作答。'
    root = 'TiMu' if name == 'work-sync' else 'mark_item'
    rich = name in ['work-sync', 'work-sync-string', 'work-existing-sync', 'work-existing-sync-fill', 'work-multiple', 'work-draft-only', 'work-editor-wait', 'work-editor-stop', 'work-sync-stop-race', 'work-manual-rich-fill']
    if rich or name == 'work-minlength':
        title += '字数不少于800字。'
    if rich:
        field = '<div class=edui-editor><div class=edui-editor-toolbarbox role=toolbar><input class=font-picker value=字体><svg width=20 height=10></svg></div><iframe class=editor-frame srcdoc="<!doctype html><html><body contenteditable=true><p>&#8203;<br></p></body></html>"></iframe></div><textarea class=payload hidden name=answer></textarea>'
        if name=='work-sync':
            field=field.replace('<input class=font-picker value=字体>','<span>字体</span>').replace('<svg width=20 height=10></svg>','')
    elif name in ['work-rich','work-editor-race']:
        field = '<div id=answer role=textbox contenteditable=true></div>'
    else:
        field = '<textarea id=answer></textarea>'
    question = '<div class="' + root + '"><h3 class=mark_name>' + title + '</h3>' + field + '</div>'
    if name == 'work-multiple':
        question += question.replace('第一题', '第二题').replace('name=answer', 'name=second')
    buttons = '<button id=submit>' + ('交卷' if name.startswith('exam-') else '提交') + '</button>'
    script = r"""
    window.submitClicks=0;window.confirmClicks=0;window.editorWrites=0;window.editorChecks=0;window.editorSyncs=0;window.serverAnswers=[];window.paperAnswers={};
    const scenario=SCENARIO;
    function textOf(node){return (node?.value ?? node?.innerText ?? '').trim();}
    function finish(){confirmClicks++;document.getElementById('confirmation').hidden=true;document.getElementById('done').hidden=false;document.body.dataset.submitted='yes';}
    function submit(){
      submitClicks++;
      const payloads=[...document.querySelectorAll('.payload')];
      const values=payloads.length?payloads.map(n=>n.value):[textOf(document.getElementById('answer'))];
      serverAnswers=values;
      if(scenario==='exam-pages'||scenario==='exam-local-save'){paperAnswers[pageIndex]=scenario==='exam-local-save'?(pageSaved[pageIndex]||''):values[0];if(!paperAnswers[1]||!paperAnswers[2])return;}
      if(values.some(v=>!v.trim()))return;
      document.getElementById('confirmation').hidden=false;
    }
    document.getElementById('submit').onclick=submit;
    window.UE={instants:{}};
    function mountEditors(){
      const frames=[...document.querySelectorAll('.editor-frame')];
      if(frames.some(frame=>!frame.contentDocument?.body?.isContentEditable)){setTimeout(mountEditors,40);return;}
      window.editorReady=!/editor-(wait|stop)/.test(scenario);
      frames.forEach((frame,index)=>{
        const payload=frame.parentElement.parentElement.querySelector('.payload');
        const editor={body:frame.contentDocument.body,iframe:frame,container:frame.parentElement,textarea:frame.parentElement.parentElement.querySelector('.payload'),
          setContent(html){if(!editorReady)throw Error('not ready');editorWrites++;this.body.innerHTML=html;},
          getContent(){return this.body.innerHTML;},getContentTxt(){return this.body.textContent;},
          fireEvent(){},sync(){editorSyncs++;payload.value=this.getContent();}};
        if(scenario==='work-sync-string'){payload.id='ueditor_textarea_answer'+index;editor.textarea='answer'+index;editor.options={textarea:'answer'+index};}
        Object.defineProperty(editor,'isReady',{get(){editorChecks++;return editorReady;}});
        UE.instants['fixture'+index]=editor;
        if(scenario.startsWith('work-existing-sync')){
          const initial=INITIAL_ANSWER;
          editor.body.replaceChildren();
          initial.split('\n').forEach(line=>{const paragraph=editor.body.ownerDocument.createElement('p');const bold=editor.body.ownerDocument.createElement('strong');bold.textContent=line;paragraph.append(bold);editor.body.append(paragraph);});
          window.initialEditorHtml=editor.body.innerHTML;
        }
      });
      if(scenario==='work-editor-wait')setTimeout(()=>editorReady=true,1800);
    }
    mountEditors();
    """
    if name in ['exam-pages','exam-local-save']:
        script += r"""
        let pageIndex=1;window.pageSaved={};window.localSaveClicks=0;
        function render(index){
          pageIndex=index;
          const root=document.querySelector('.mark_item');
          root.querySelector('.mark_name').textContent='【简答题】离线第'+index+'题，请回答。';
          root.querySelector('#answer').value=paperAnswers[index]||'';
          document.getElementById('next-question').hidden=index===2;
          const status=root.querySelector('.save-status');if(status)status.textContent='';
        }
        document.getElementById('next-question').onclick=()=>{if(scenario==='exam-local-save'&&!pageSaved[pageIndex])return;paperAnswers[pageIndex]=document.getElementById('answer').value;render(2);};
        render(1);
        """
        buttons += '<button id=next-question>下一题</button>'
        if name=='exam-local-save':
            question=question.replace('</textarea>','</textarea><div class=savebtndiv><button class=saveButtonClass onclick="pageSaved[pageIndex]=document.getElementById(\'answer\').value;localSaveClicks++;this.nextElementSibling.textContent=\'保存成功\'">保存</button><span class=save-status role=status></span></div>')
    if name == 'exam-intro':
        question = '<div id=intro><button id=begin>开始考试</button></div><section id=paper hidden>' + question + '</section>'
        script += "document.getElementById('begin').onclick=()=>{document.getElementById('intro').remove();document.getElementById('paper').hidden=false;};"
    if name == 'work-submitted':
        question = question.replace('<textarea id=answer>', '<textarea id=answer readonly>本人已提交的原稿')
        question += '<div class=work-status>已提交</div>'
    dialog = '<div id=confirmation role=dialog hidden>确认' + ('交卷？考试提交后不能修改。' if name.startswith('exam-') else '提交作业？') + '<button id=confirm onclick=finish()>' + ('确认交卷' if name.startswith('exam-') else '提交') + '</button></div><p id=done data-study-submitted hidden>提交成功</p>'
    return BASE + question + buttons + dialog + '<script>' + script.replace('SCENARIO', json.dumps(name)).replace('INITIAL_ANSWER',json.dumps(LONG).replace('<',r'\u003c')) + '</script>'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', action='append', choices=CASES)
    parser.add_argument('--red', action='store_true')
    args = parser.parse_args()
    results = []
    with tempfile.TemporaryDirectory(prefix='study-pilot-assessments-') as profile, sync_playwright() as p:
        extension = ROOT / 'extension'
        context = p.chromium.launch_persistent_context(profile, headless=True, **browser_options(),
            args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'])
        def route(request):
            name = parse_qs(urlparse(request.request.url).query).get('case', [''])[0]
            request.fulfill(content_type='text/html; charset=utf-8', body=fixture(name))
        context.route('https://*.chaoxing.com/**', route)
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        worker.evaluate(r"""()=>{globalThis.assessmentCalls=[];globalThis.assessmentMode='';globalThis.fetch=async(url,opts)=>{
          const body=JSON.parse(opts.body),raw=body.messages[1].content;
          const data=JSON.parse(Array.isArray(raw)?raw.find(p=>p.type==='text').text:raw);
          assessmentCalls.push(data);
          if(assessmentMode==='work-user-edit')await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,3000);opts.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Stopped','AbortError'));},{once:true});});
          const long=LONG,short=SHORT;
          let text=/work-(sync|multiple|draft-only|editor-)/.test(assessmentMode)||['work-minlength','work-existing-sync','work-existing-sync-fill','work-manual-rich-fill'].includes(assessmentMode)?long:short;
          if(data.text?.includes('第二题'))text=text.replaceAll('离线','第二');
          if(assessmentMode==='work-sync')text=text.replaceAll('\n',' ');
          if(assessmentMode==='work-minlength'&&data.review?.phase==='solve')text='过短的离线样例';
          return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({answers:[text],confidence:0.96,explanation:'offline text fixture'})},finish_reason:'stop'}],usage:{total_tokens:2}}));
        }}""".replace('LONG', json.dumps(LONG)).replace('SHORT', json.dumps(SHORT)))
        options = context.new_page()
        options.goto(worker.url.rsplit('/', 1)[0] + '/options.html')
        options.locator('#apiKey').wait_for()
        def msg(kind, **extra):
            response = options.evaluate('(m)=>chrome.runtime.sendMessage(m)', {'type':kind, **extra})
            assert response['ok'], response
            return response['data']
        def until(check, timeout=20000):
            deadline = time.monotonic() + timeout/1000
            while time.monotonic() < deadline:
                if check():
                    return
                options.wait_for_timeout(100)
            raise AssertionError('Expected assessment state did not appear')
        try:
            for name in args.only or CASES:
                page = context.new_page()
                tab = None
                try:
                    settings = msg('KP_GET_SETTINGS')
                    settings.update(endpoint='https://api.chaoxing.com/v1', apiKey='offline-assessment-key',
                        model='fixture-assessment-'+name, visionModel='fixture-vision', reviewEnabled=name=='work-minlength',
                        reviewProfiles=[], confidenceGate=False, autoAssessments=name!='exam-disabled',
                        autoFill=name not in ['work-existing-sync','work-manual-rich-fill'], autoSolve=True, autoSubmit=name!='work-draft-only', autoConfirm=True,
                        autoRefresh=False, visualAgent=False, keepActive=False, useVision=True, maxCalls=30, requestGap=2000)
                    msg('KP_SAVE_SETTINGS', settings=settings)
                    worker.evaluate('(name)=>{assessmentMode=name;assessmentCalls=[]}', name)
                    path = '/exam-ans/exam/test' if name.startswith('exam-') else '/mooc-ans/mooc2/work/dowork'
                    page.goto('https://mooc1.chaoxing.com' + path + '?case=' + name)
                    if name.startswith('work-existing-sync'):until(lambda:bool(page.evaluate('window.initialEditorHtml')))
                    tab = options.evaluate('(url)=>chrome.tabs.query({}).then(tabs=>tabs.find(tab=>tab.url===url).id)', page.url)
                    if name in ['work-editor-race','work-sync-stop-race']:
                        worker.evaluate("""()=>{globalThis.originalEditorWrite=chrome.scripting.executeScript;const execute=chrome.scripting.executeScript.bind(chrome.scripting);
                          globalThis.editorWritePaused=false;globalThis.releaseEditorWrite=null;
                          chrome.scripting.executeScript=async(spec)=>{if(spec.world==='MAIN'){editorWritePaused=true;await new Promise(resolve=>releaseEditorWrite=resolve);}return execute(spec);};}""")
                    msg('KP_START', tabId=tab)
                    if name=='work-manual-rich-fill':
                        until(lambda:len(msg('KP_STATUS',tabId=tab)['results'])>0);msg('KP_FILL',tabId=tab)
                    if name in ['exam-disabled', 'work-submitted']:
                        if name=='exam-disabled':
                            until(lambda:not msg('KP_STATUS',tabId=tab)['running'])
                        else:
                            until(lambda:msg('KP_STATUS',tabId=tab).get('completed'))
                        assert not worker.evaluate('assessmentCalls.length') and page.evaluate('submitClicks')==0
                    elif name=='work-user-edit':
                        until(lambda:worker.evaluate('assessmentCalls.length')>0)
                        page.locator('#answer').fill('本人正在编辑的新文字')
                        until(lambda:not msg('KP_STATUS',tabId=tab)['running'])
                        assert page.locator('#answer').input_value()=='本人正在编辑的新文字' and page.evaluate('submitClicks')==0
                    elif name=='work-sync-stop-race':
                        until(lambda:worker.evaluate('editorWritePaused'))
                        msg('KP_STOP',tabId=tab);worker.evaluate('()=>releaseEditorWrite()');page.wait_for_timeout(900)
                        assert page.evaluate('editorWrites')==0 and not page.locator('.payload').input_value() and page.evaluate('submitClicks')==0, 'Stopping must cancel a queued write into a nested rich editor'
                    elif name=='work-editor-race':
                        until(lambda:worker.evaluate('editorWritePaused'))
                        page.locator('#answer').fill('本人在编辑器写入前更改了内容')
                        worker.evaluate('()=>releaseEditorWrite()')
                        until(lambda:not msg('KP_STATUS',tabId=tab)['running'])
                        assert page.locator('#answer').inner_text()=='本人在编辑器写入前更改了内容' and page.evaluate('submitClicks')==0
                    elif name=='work-editor-stop':
                        until(lambda:page.evaluate('editorChecks')>0)
                        msg('KP_STOP',tabId=tab)
                        page.evaluate('editorReady=true');page.wait_for_timeout(1200)
                        assert page.evaluate('editorWrites')==0 and not page.locator('.payload').input_value()
                    elif name=='work-draft-only':
                        until(lambda:bool(page.locator('.payload').input_value()))
                        assert page.evaluate('submitClicks')==0 and page.evaluate('editorWrites')==1
                    else:
                        until(lambda:page.get_attribute('body','data-submitted')=='yes' or not msg('KP_STATUS',tabId=tab)['running'], timeout=10000 if args.red else 25000)
                        assert page.get_attribute('body','data-submitted')=='yes', 'The answer must reach the platform submission fields and finish submission'
                        until(lambda:msg('KP_STATUS',tabId=tab).get('completed') and not msg('KP_STATUS',tabId=tab)['running'])
                        assert msg('KP_STATUS',tabId=tab).get('assessmentCompleted')==('exam' if name.startswith('exam-') else 'homework')
                        assert page.evaluate('window.answerInjected') is None
                        if name in ['work-sync','work-sync-string','work-multiple','work-editor-wait']:
                            assert page.evaluate('editorWrites')==(2 if name=='work-multiple' else 1)
                            assert all(len(value)>800 for value in page.evaluate('serverAnswers'))
                            if page.locator('.font-picker').count():assert page.locator('.font-picker').first.input_value()=='字体'
                        if name=='work-multiple':
                            assert '第二' in page.evaluate('serverAnswers[1]') and '离线' in page.evaluate('serverAnswers[0]')
                        if name=='work-minlength':
                            assert len(worker.evaluate('assessmentCalls'))==2
                            assert worker.evaluate('assessmentCalls[0].minLength')==800
                            assert len(page.evaluate('serverAnswers[0]'))>=800
                        if name=='work-rich':
                            assert page.evaluate('window.answerInjected') is None
                            assert '\n' in page.evaluate('serverAnswers[0]')
                        if name.startswith('work-existing-sync'):
                            assert page.evaluate('editorWrites')==0 and page.evaluate('editorSyncs')>=1
                            assert page.frame_locator('.editor-frame').locator('body').inner_html()==page.evaluate('initialEditorHtml'), 'Existing rich formatting must survive synchronization'
                            page.screenshot(path=str(ROOT/'test-results/assessment-existing-v083.png'),full_page=True)
                        if name=='exam-local-save':assert page.evaluate('localSaveClicks')==2 and page.evaluate('Boolean(paperAnswers[1]&&paperAnswers[2])'), 'Save each page before next/submit, even when both model answers are identical'
                        if name=='exam-pages':
                            assert all(page.evaluate('paperAnswers').get(str(index)) for index in [1,2])
                        assert page.evaluate('submitClicks')==1 and page.evaluate('confirmClicks')==1
                    results.append({'case':name,'passed':True})
                    print('PASS:',name,flush=True)
                except Exception as error:
                    status = msg('KP_STATUS',tabId=tab) if tab is not None else {}
                    results.append({'case':name,'passed':False,'error':str(error),'blocked':status.get('blocked'),'calls':status.get('calls')})
                    if name in ['work-sync','work-existing-sync','work-existing-sync-fill']:
                        results[-1].update(editor_length=len(page.frame_locator('.editor-frame').locator('body').inner_text()),
                            stored_length=len(page.locator('.payload').input_value()), editor_api_writes=page.evaluate('window.editorWrites ?? null'), submit_clicks=page.evaluate('window.submitClicks ?? null'))
                    print('FAIL:',json.dumps(results[-1],ensure_ascii=False),flush=True)
                finally:
                    if name in ['work-editor-race','work-sync-stop-race']:
                        worker.evaluate('()=>{chrome.scripting.executeScript=originalEditorWrite;releaseEditorWrite?.()}')
                    if tab is not None:
                        msg('KP_STOP',tabId=tab)
                    page.close()
        finally:
            context.close()
    report = {'checks':results,'passed':sum(row['passed'] for row in results),'all_passed':all(row['passed'] for row in results),
        'complete_suite':not args.only and not args.red,'real_api_tested':False,'real_course_tested':False}
    (ROOT/'test-results'/('assessments-red-report.json' if args.red else 'assessments-report.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    return 0 if report['all_passed'] else 1


if __name__=='__main__':
    raise SystemExit(main())
