"""Offline MOOC integration checks using current public-template selectors.

All course pages, media and API calls belong to isolated fixtures.
"""
import argparse
import io
import json
import wave
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from browser_support import browser_options
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
HOST='https://www.icourse163.org'
BASE='<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif;margin:25px}a,button,li{cursor:pointer;padding:8px}iframe{width:800px;height:350px}video{width:400px;height:180px}label{display:block;padding:8px}</style>'
Q='''<div class="u-questionItem m-choiceQuestion"><div class="j-title"><div class="j-richTxt">【单选题】2+2等于多少？</div></div><div class="j-choicebox"><label class="answer-item"><input class="u-tbi" type="radio" name="q" value="A">A. 3</label><label class="answer-item"><input class="u-tbi" type="radio" name="q" value="B">B. 4</label></div></div>'''
FORM='<div class="m-learnunitUI">'+Q+'''<a class="j-submit" onclick="this.hidden=true;this.parentElement.querySelectorAll('input').forEach(e=>e.disabled=true);this.parentElement.querySelector('.j-replay').hidden=false;document.body.dataset.submitted='yes'">提交</a><a class="j-replay" hidden>重新作答</a></div>'''
def card(title,slug):
 return f'''<div class="course-card-wrapper"><div class="title"><div class="text">{title}</div></div><a class="j-course-card-box" onclick="window.open('/learn/{slug}#/learn/content?type=detail&id=1&cid=1')"><span>进入课程</span></a></div>'''
fixtures={
 '/home.htm':BASE+card('大学物理','fixture-handoff')+card('高等数学','wrong-course'),
 '/learn/fixture-handoff':BASE+'<title>大学物理_中国大学MOOC</title><video muted controls src="/sample.wav"></video><a data-study-next href="/arrived">下一节</a>',
 '/learn/wrong-course':BASE+'<p id="wrong">不得自动选择此课程</p>',
 '/arrived':BASE+'<p id="arrived">后续内容已打开</p>',
 '/learn/image':BASE+FORM.replace('【单选题】2+2等于多少？','【单选题】识别图片算式<img src="/marker.svg">'),
 '/learn/existing':BASE+FORM.replace('value="A"','value="A" checked'),
 '/learn/login':BASE+'<div class="j-loginBar">请登录后继续学习</div>'+FORM,
 '/learn/exam':BASE+FORM,
 '/learn/empty-document':BASE+'<div class="m-learnunitUI"><div class="unitctBox f-richEditorText"></div></div><a data-study-next href="/arrived">下一节</a>',
 '/learn/catalog-resume':BASE+'''<div id="view"><div class="u-learnLesson normal"><div class="lsicon learned" data-cid="1" onclick="document.body.dataset.wrong='yes'">平台已学内容</div><div class="lsicon" data-cid="2" onclick="location.hash='/learn/content?type=detail&id=1&cid=2';document.getElementById('view').innerHTML='<video muted controls src=/sample.wav></video>';document.body.dataset.resumed='yes'">下一未学内容</div></div></div><a data-study-next href="/arrived">下一节</a>''',
 '/learn/integrity-gate':BASE+'''<a data-mooc-catalog onclick="location.hash='/learn/content';document.getElementById('view').innerHTML='<div class=u-learnLesson><h4 class=j-name>单元检测</h4></div><div class=u-learnLesson><div class=lsicon data-cid=2 onclick=playVideo()>后续视频</div></div>'">课件</a><div id="view"><div class="m-quizDoing"><h2 class="j-title">单元检测</h2><label><input type="checkbox" class="j-agree">依照学术诚信条款，我保证本测验答案是我独立完成的。</label><a class="j-startBtn u-btn-disabled">开始测验</a></div></div><a data-study-next href="/arrived">下一节</a><script>function playVideo(){document.body.dataset.video='yes';location.hash='/learn/content?type=detail&id=1&cid=2';document.getElementById('view').innerHTML='<video muted controls src=/sample.wav></video>';}</script>''',
 '/learn/discussion-pending':BASE+'''<div id="view"><div class="u-learnLesson"><div class="lsicon" data-cid="1">讨论 案例分析与讨论</div><div class="lsicon" data-cid="2" onclick="location.hash='/learn/content?type=detail&id=1&cid=2';document.getElementById('view').innerHTML='<video muted controls src=/sample.wav></video>';document.body.dataset.video='yes'">后续视频</div></div></div><a data-study-next href="/arrived">下一节</a>''',
 '/learn/discussion-inline':BASE+'''<div id="view"><ul class="j-unitslist"><li class="current" data-id="1" title="讨论：主题讨论">案例分析</li></ul><a class="j-forumEnter">老师发起的主题讨论</a><a data-mooc-catalog onclick="location.hash='/learn/content';document.getElementById('view').innerHTML='<div class=u-learnLesson><div class=lsicon data-cid=1>讨论 案例分析</div><div class=lsicon data-cid=2 onclick=playVideo()>后续视频</div></div>'">课件</a></div><a data-study-next href="/arrived">下一节</a><script>function playVideo(){location.hash='/learn/content?type=detail&id=2&cid=2';document.getElementById('view').innerHTML='<video muted controls src=/sample.wav></video>';document.body.dataset.video='yes';}</script>''',
 '/learn/lazy-chapter':BASE+'''<div id="view"></div><script>function catalog(){location.hash='/learn/content';document.getElementById('view').innerHTML='<div class=m-learnChapterNormal><div class=j-titleBox><h3 class=j-titleName>第一章</h3></div><div class=j-lessoBox><div class=u-learnLesson><div class=lsicon data-cid=1 onclick=play(1)>视频一</div></div></div></div><div class=m-learnChapterNormal><div class=j-titleBox onclick=loadNext()><h3 class=j-titleName>第二章</h3></div><div class=j-lessoBox id=lazily></div></div>';}function loadNext(){document.getElementById('lazily').innerHTML='<div class=u-learnLesson><div class=lsicon data-cid=2 onclick=play(2)>视频二</div></div>';document.body.dataset.expanded='yes';}function play(id){location.hash='/learn/content?type=detail&id='+id+'&cid='+id;document.getElementById('view').innerHTML='<div class=j-chapter>'+ (id===1?'第一章':'第二章')+'</div><ul class=j-unitslist><li class=current data-id='+id+'>视频</li></ul><video muted controls src=/sample.wav></video><div class=u-learnBCUI><a class=link onclick=catalog()>课件</a></div>';document.body.dataset.video=id;}catalog();</script>''',
 '/learn/locked':BASE+'<ul class="j-unitslist"><li data-id="1" class="current">视频</li><li data-id="2" class="locked" onclick="document.body.dataset.bad=\'yes\'">未开放内容</li></ul><video muted controls src="/sample.wav"></video>',
 '/learn/parent-confirm':BASE+'''<iframe id="work" src="/question-frame"></iframe><div class="ux-modal" hidden id="confirmation">确认提交？<a onclick="this.parentElement.hidden=true;document.getElementById('work').contentWindow.document.body.innerHTML='<div class=m-learnunitUI><a class=j-replay>重新作答</a></div>';document.body.dataset.confirmed='yes'">提交</a></div><a data-study-next href="/arrived">下一节</a>''',
 '/question-frame':BASE+'<div class="m-learnunitUI">'+Q+'''<a class="j-submit" onclick="parent.document.getElementById('confirmation').hidden=false">提交</a></div>''',
 '/learn/inline':BASE+'''<video controls muted src="/long.wav"></video><div data-mooc-inset>'''+Q+'''<a class="j-submit" onclick="this.hidden=true;this.parentElement.querySelectorAll('input').forEach(e=>e.disabled=true);this.parentElement.querySelector('.j-continue').hidden=false;document.body.dataset.submitted='yes'">提交</a><a class="j-continue" hidden onclick="this.parentElement.remove();document.body.dataset.inline='done';document.querySelector('video').play()">继续学习</a></div><a data-study-next href="/arrived">下一节</a>''',
 '/learn/persistent-media':BASE+'''<ul class="j-unitslist"><li data-id="1" class="current">第一单元</li><li data-id="2" onclick="document.querySelector('li.current').className='';this.className='current';location.hash='/learn/content?type=detail&id=1&cid=2';document.querySelector('iframe').contentWindow.document.querySelector('video').src='/long.wav';document.body.dataset.second='yes'">第二单元</li></ul><iframe src="/player-persistent"></iframe><a data-study-next href="/arrived">下一节</a>''',
 '/learn/delayed-unit':BASE+'''<ul class="j-unitslist"><li data-id="1" class="current">已完成测验</li><li data-id="2" onclick="document.querySelector('li.current').className='';this.className='current';location.hash='/learn/content?type=detail&id=1&cid=2';document.body.dataset.second='yes';setTimeout(()=>document.getElementById('content').innerHTML='<video muted controls src=/long.wav></video>',9000)">视频</li></ul><div id="content"><div class="m-learnunitUI"><a class="j-replay">重新作答</a></div></div><a data-study-next href="/arrived">下一节</a>''',
 '/player-persistent':BASE+'<video muted controls src="/sample.wav"></video>',
 '/learn/lesson-flow':BASE+'''<input class="j-autoNext" type="checkbox" checked><div id="view"></div><script>
let unit=1;const names={1:'视频',2:'随堂测试',3:'文档',4:'下一个课时视频'};
function catalog(){location.hash='/learn/content';document.getElementById('view').innerHTML='<div class="m-learnChapterList"><div class="u-learnLesson normal"><h4 class="j-name">第一课时</h4>'+[1,2,3].map(id=>`<div class="lsicon" data-cid="${id}" onclick="openUnit(${id})">${names[id]}</div>`).join('')+'</div><div class="u-learnLesson normal"><h4 class="j-name">第二课时</h4><div class="lsicon" data-cid="4" onclick="openUnit(4)">下一个课时视频</div></div></div>';}
function openUnit(id){unit=id;location.hash='/learn/content?type=detail&id='+(id===4?2:1)+'&cid='+id;let ids=id===4?[4]:[1,2,3];document.getElementById('view').innerHTML='<ul class="j-unitslist">'+ids.map(i=>`<li data-id="${i}" class="${id===i?'current':''}" onclick="openUnit(${i})">${names[i]}</li>`).join('')+'</ul><div class="content"></div><div class="u-learnBCUI"><a class="link" data-mooc-catalog onclick="catalog()">课件</a></div>';let content=document.querySelector('.content');if(id===2)content.innerHTML=window.quizHtml;else if(id===3)content.innerHTML='<div class="m-learnunitUI"><div class="unitctBox f-richEditorText">这是完整的课程阅读内容。请正常浏览课件，扩展只在浏览结束后继续下一单元，不会写入伪造的课程任务或成绩记录。这段内容用于检查文档浏览与后续导航。</div></div>';else content.innerHTML='<video muted controls src="/sample.wav"></video>';document.body.dataset.lastUnit=id;}
window.quizHtml=QUIZ_HTML;const originalOpen=openUnit;openUnit=function(id){originalOpen(id);document.querySelectorAll('.j-unitslist li').forEach(n=>n.dataset.id+='"');};openUnit(1);
</script>'''.replace('QUIZ_HTML',json.dumps(FORM,ensure_ascii=False)),
}
for pdf_case in ['pdf-pages','pdf-stuck']:
 fixtures['/learn/'+pdf_case]=BASE+'''<ul class="j-unitslist"><li class="current" data-id="1" title="文档：教学课件">文档</li></ul><div class="ux-h5pdfreader"><div class="ux-h5pdfreader_container_viewer"><canvas width="300" height="150"></canvas></div><input class="ux-h5pdfreader_container_footer_pages_in" value="1"><span class="ux-h5pdfreader_container_footer_pages_total">/ 3</span><a class="ux-h5pdfreader_container_bignext">大箭头</a><a class="ux-h5pdfreader_container_footer_pages_next" onmouseup="if(!location.pathname.endsWith('pdf-stuck')){let p=document.querySelector('input');p.value=Number(p.value)+1;window.visited.push(Number(p.value));}">→</a></div><button data-study-next onclick="document.body.dataset.arrived='yes'">下一节</button><script>window.visited=[1]</script>'''
CASES=['list-handoff','list-activation','list-noopener','list-double','list-ambiguous','list-select','lesson-flow','inline','parent-confirm','image','existing','login','exam','locked','empty-document','catalog-resume','persistent-media','delayed-unit','integrity-gate','discussion-pending','discussion-inline','lazy-chapter','pdf-pages','pdf-stuck']
parser=argparse.ArgumentParser();parser.add_argument('--only',choices=CASES);args=parser.parse_args()
results=[]
with sync_playwright() as p:
 profile=ROOT/'.test-profiles'/('mooc-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f'));extension=ROOT/'extension'
 context=p.chromium.launch_persistent_context(str(profile),headless=True,**browser_options(),args=[f'--disable-extensions-except={extension}',f'--load-extension={extension}'])
 audio={}
 for name,seconds in [('sample',1),('long',8)]:
  stream=io.BytesIO()
  with wave.open(stream,'wb') as wav:wav.setparams((1,2,8000,0,'NONE','not compressed'));wav.writeframes(b'\x00\x00'*8000*seconds)
  audio[name]=stream.getvalue()
 def route(r):
  path=urlparse(r.request.url).path
  if path in ['/sample.wav','/long.wav']:r.fulfill(content_type='audio/wav',body=audio[path[1:-4]])
  elif path=='/marker.svg':r.fulfill(content_type='image/svg+xml',body='<svg xmlns="http://www.w3.org/2000/svg" width="140" height="60"><text x="5" y="40" font-size="24">2+2=?</text></svg>')
  else:
   body=fixtures.get(path,BASE)
   if path=='/home.htm' and 'activation=1' in r.request.url:body=body.replace('onclick="window.open(','''onclick="if(!navigator.userActivation.isActive){document.body.dataset.popupBlocked='yes';return;}window.open(''')
   if path=='/home.htm' and 'noopener=1' in r.request.url:body=body.replace("window.open('/learn/fixture-handoff#/learn/content?type=detail&id=1&cid=1')","window.open('/learn/fixture-handoff#/learn/content?type=detail&id=1&cid=1','_blank','noopener')")
   if path=='/home.htm' and 'double=1' in r.request.url:body=body.replace("window.open('/learn/fixture-handoff#/learn/content?type=detail&id=1&cid=1')","window.open('/learn/fixture-handoff#/learn/content?type=detail&id=1&cid=1');window.open('/learn/fixture-handoff?copy=2#/learn/content?type=detail&id=1&cid=1')")
   r.fulfill(content_type='text/html; charset=utf-8',body=body)
 context.route('https://*.icourse163.org/**',route)
 worker=context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
 worker.evaluate('''()=>{globalThis.planCalls=0;globalThis.images=0;globalThis.fetch=async(url,opts)=>{const b=JSON.parse(opts.body),c=b.messages[1].content,q=JSON.parse(Array.isArray(c)?c.find(x=>x.type==='text').text:c);if(Array.isArray(c))images++;if(q.controls)planCalls++;const data=q.controls?{action:'pause',confidence:1,reason:'MOOC must use deterministic controls'}:{answers:['B'],explanation:'2+2=4',confidence:1};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(data)},finish_reason:'stop'}],usage:{total_tokens:1}}),{status:200});};}''')
 options=context.new_page();options.goto('chrome-extension://'+worker.url.split('/')[2]+'/options.html')
 def msg(kind,**extra):
  response=options.evaluate('(m)=>chrome.runtime.sendMessage(m)',{'type':kind,**extra});assert response['ok'],response;return response['data']
 def tabid(page):return options.evaluate('(url)=>chrome.tabs.query({}).then(tabs=>tabs.find(t=>t.url===url).id)',page.url)
 def until(check,timeout=18000):
  deadline=datetime.now().timestamp()+timeout/1000
  while datetime.now().timestamp()<deadline:
   if check():return
   options.wait_for_timeout(150)
  raise AssertionError('Condition timed out')
 for name in ([args.only] if args.only else CASES):
  settings=msg('KP_GET_SETTINGS');settings.update(endpoint='https://maas.qianwenaiapi.com/compatible-mode/v1',visionModel='fixture-vision',apiKey='fixture-mooc-only',model='fixture-mooc-'+name,courseName='数学大观',moocCourseName='' if name in ['list-ambiguous','list-select'] else '大学物理',keepActive=False,readingInterval=1000,autoSubmit=True,autoConfirm=True,requestGap=2000,visualAgent=True)
  msg('KP_SAVE_SETTINGS',settings=settings);worker.evaluate('()=>{planCalls=0;images=0}')
  page=context.new_page();url=HOST+('/home.htm'+('?activation=1' if name=='list-activation' else '?noopener=1' if name=='list-noopener' else '?double=1' if name=='list-double' else '')+'#/home/course' if name.startswith('list-') else '/learn/'+name+('#/learn/exam?id=1' if name=='exam' else '#/learn/content?type=detail&id=1&cid=1'))
  page.goto(url);page.wait_for_load_state('networkidle');tab=tabid(page);before=set(context.pages);msg('KP_START',tabId=tab);child=None
  try:
   if name in ['list-handoff','list-select','list-activation','list-noopener','list-double']:
    if name=='list-select':
     page.wait_for_timeout(2500);assert len(context.pages)==len(before),'Multiple courses must wait for selection'
     chosen=options.evaluate('(tabId)=>chrome.scripting.executeScript({target:{tabId},func:()=>chrome.runtime.sendMessage({type:"KP_MOOC_SELECT_COURSE",title:"大学物理"})})',tab)
     assert chosen[0]['result']['ok'],chosen
    until(lambda:any('/learn/fixture-handoff' in p.url for p in context.pages if p not in before),timeout=8000 if name=='list-activation' else 18000)
    if name=='list-double':
     until(lambda:sum(msg('KP_STATUS',tabId=tabid(p))['running'] for p in context.pages if p not in before and '/learn/fixture-handoff' in p.url)==1)
     child=next(p for p in context.pages if p not in before and '/learn/fixture-handoff' in p.url and msg('KP_STATUS',tabId=tabid(p))['running'])
    else:child=next(p for p in context.pages if p not in before and '/learn/fixture-handoff' in p.url)
    child_tab=tabid(child)
    until(lambda:msg('KP_STATUS',tabId=child_tab)['running'])
    assert not msg('KP_STATUS',tabId=tab)['running'],'The source list must stop when the child is taken over'
    child.locator('#arrived').wait_for(timeout=18000)
    assert not any('/learn/wrong-course' in p.url for p in context.pages),'Do not open a different course'
   elif name=='list-ambiguous':
    page.wait_for_timeout(7000);st=msg('KP_STATUS',tabId=tab)
    assert st['running'] and st['calls']==0 and len(context.pages)==len(before)
    assert any('选择' in f.get('waiting','') for f in st['frames'].values())
   elif name=='lesson-flow':
    until(lambda:msg('KP_STATUS',tabId=tab).get('completed'),timeout=52000)
    st=msg('KP_STATUS',tabId=tab);assert st['calls']==1 and not st.get('blocked')
    assert page.locator('body').get_attribute('data-last-unit')=='4'
    assert not page.locator('.j-autoNext').is_checked(),'Platform auto-next must not skip the intervening quiz and document'
   elif name=='inline':
    page.locator('body[data-inline=done]').wait_for(timeout=16000)
    assert page.url.find('/arrived')<0,'Do not leave before the video is completed'
    page.locator('#arrived').wait_for(timeout=18000)
   elif name=='parent-confirm':
    page.locator('#arrived').wait_for(timeout=25000)
   elif name=='image':
    page.locator('body[data-submitted=yes]').wait_for(timeout=18000);assert worker.evaluate('images')==1
   elif name in ['existing','login','exam']:
    until(lambda:not msg('KP_STATUS',tabId=tab)['running'])
    st=msg('KP_STATUS',tabId=tab)
    if name=='existing':assert page.locator('input[value=A]').is_checked() and '复核' in st['blocked']
    else:assert st['calls']==0 and st['blocked']
   elif name=='locked':
    page.wait_for_timeout(9500);assert page.locator('body').get_attribute('data-bad') is None
    assert 'unit:1' in msg('KP_STATUS',tabId=tab)['progress']['doneCards']
   elif name=='empty-document':
    page.wait_for_timeout(6500);st=msg('KP_STATUS',tabId=tab)
    assert '/empty-document' in page.url and not st['progress']['doneCards'] and st['calls']==0
   elif name=='pdf-pages':
    page.locator('body[data-arrived=yes]').wait_for(timeout=18000)
    assert page.evaluate('window.visited')==[1,2,3],'Read every PDF page before advancing'
    assert msg('KP_STATUS',tabId=tab)['progress']['doneCards'].get('unit:1')
   elif name=='pdf-stuck':
    until(lambda:not msg('KP_STATUS',tabId=tab)['running'],timeout=18000)
    st=msg('KP_STATUS',tabId=tab)
    assert '翻页未响应' in st['blocked'] and not st['progress']['doneCards']
    assert page.locator('body').get_attribute('data-arrived') is None
    page.locator('.ux-h5pdfreader_container_footer_pages_next').evaluate("(n)=>n.onmouseup=()=>{let p=document.querySelector('input');p.value=Number(p.value)+1;window.visited.push(Number(p.value));}")
    msg('KP_START',tabId=tab)
    page.locator('body[data-arrived=yes]').wait_for(timeout=18000)
    assert page.evaluate('window.visited')==[1,2,3],'Restart after repairing the reader must clear the previous stall count'
   elif name=='catalog-resume':
    page.locator('body[data-resumed=yes]').wait_for(timeout=12000)
    assert page.locator('body').get_attribute('data-wrong') is None
    page.locator('#arrived').wait_for(timeout=16000)
   elif name in ['integrity-gate','discussion-pending','discussion-inline']:
    page.locator('body[data-video=yes]').wait_for(timeout=18000)
    st=msg('KP_STATUS',tabId=tab)
    assert len(st.get('moocManualTasks',[]))==1 and st['calls']==0,'Manual tasks must remain pending while other content continues'
    assert not page.locator('input[type=checkbox]:checked').count(),'Do not confirm the independent-work declaration'
    page.locator('#arrived').wait_for(timeout=16000)
   elif name=='lazy-chapter':
    page.locator('body[data-video="2"]').wait_for(timeout=22000)
    assert page.locator('body').get_attribute('data-expanded')=='yes'
    until(lambda:msg('KP_STATUS',tabId=tab).get('completed'),timeout=22000)
   elif name=='persistent-media':
    page.locator('body[data-second=yes]').wait_for(timeout=20000);page.wait_for_timeout(5000)
    assert '/arrived' not in page.url,'A persistent iframe must not reuse the previous unit completion'
    page.locator('#arrived').wait_for(timeout=20000)
   elif name=='delayed-unit':
    page.locator('body[data-second=yes]').wait_for(timeout=16000);page.wait_for_timeout(14500)
    assert '/arrived' not in page.url,'Old inline quiz content must not complete a newly selected video'
    assert page.locator('video').evaluate('(v)=>!v.paused&&v.currentTime>0&&!v.ended')
    page.locator('#arrived').wait_for(timeout=12000)
   assert worker.evaluate('planCalls')==0,'A visual planner must not interrupt deterministic MOOC control'
   results.append({'case':name,'passed':True});print('PASS:',name,flush=True)
  except Exception as error:
   st=msg('KP_STATUS',tabId=tab);results.append({'case':name,'passed':False,'error':str(error).splitlines()[0],'blocked':st.get('blocked'),'calls':st['calls'],'context':st.get('context'),'progress':st.get('progress'),'frames':st['frames'],'logs':[entry['text'] for entry in st['logs'][:8]]});print('FAIL:',json.dumps(results[-1],ensure_ascii=False),flush=True)
  for current in [child,page]:
   if current and not current.is_closed():
    try:msg('KP_STOP',tabId=tabid(current))
    except Exception:pass
    current.close()
  for extra_page in list(context.pages):
   if extra_page not in before and extra_page not in [page,child] and not extra_page.is_closed():
    try:msg('KP_STOP',tabId=tabid(extra_page))
    except Exception:pass
    extra_page.close()
 context.close()
report={'platform':'中国大学MOOC','checks':results,'passed':sum(row['passed'] for row in results),'all_passed':all(row['passed'] for row in results),'complete_suite':not bool(args.only),'real_course_tested':False,'real_api_tested':False}
(ROOT/'test-results'/'mooc-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
raise SystemExit(0 if report['all_passed'] else 1)
