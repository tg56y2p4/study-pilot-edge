"""Pending-task regressions, with optional red check against the released v0.5."""
import argparse
import json
import zipfile
from datetime import datetime
from pathlib import Path
from browser_support import browser_options
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];HOST='https://www.icourse163.org'
CASES=['stopped-quiz','own-discussion','review-lazy','review-saved']
parser=argparse.ArgumentParser();parser.add_argument('--only',choices=CASES);parser.add_argument('--legacy',action='store_true');args=parser.parse_args()
BASE='<!doctype html><meta charset=utf-8><style>body{font:16px sans-serif}button,a{display:inline-block;padding:10px;cursor:pointer}.f-dn{display:none}</style>'
INTRO='<div class="m-quizDoing"><h2 class="j-title">第二章单元检测</h2><label><input type="checkbox">我保证本测验答案独立完成</label><a class="j-startBtn u-btn-disabled" onclick="document.body.dataset.started=1">开始测验</a></div>'
FIXTURES={
 'stopped-quiz':BASE+'<div class="m-quizDoing"><h2 class="j-title">单元检测</h2><div class="j-waitForScore">已提交，等待评分</div></div>',
 'own-discussion':BASE+'''<ul class=j-unitslist><li class=current data-id=1 title="讨论：案例讨论">案例讨论</li></ul><div class=m-learnunitUI><div class=j-reply-all><div class=m-detailInfoItem><div class=j-content>其他同学的回复</div><a class="j-delBtn f-dn">删除</a></div></div></div><button id=post onclick="document.querySelector('.j-reply-all').insertAdjacentHTML('beforeend','<div class=m-detailInfoItem><div class=j-content>本人已由平台确认的回复</div><a class=j-delBtn>删除</a></div>')">模拟平台收到本人回复</button>''',
 'review-lazy':BASE+'''<div id=view><div class=m-learnChapterNormal><div class=j-titleBox><h3 class=j-titleName>第一章</h3></div><div class=u-learnLesson><span class=lsicon data-cid=1>旧视频</span></div></div><div class=m-learnChapterNormal><div class=j-titleBox onclick="document.getElementById('lazy').innerHTML='<div class=&quot;u-learnLesson quiz&quot; onclick=openQuiz()><h4 class=j-name>第二章单元检测</h4></div>'"><h3 class=j-titleName>第二章</h3></div><div id=lazy></div></div></div><script>function openQuiz(){location.hash='/learn/quiz?id=2';document.getElementById('view').innerHTML=INTRO_HTML;}</script>'''.replace('INTRO_HTML',json.dumps(INTRO,ensure_ascii=False)),
 'review-saved':BASE+'''<div id=view>课件目录</div><script>onhashchange=()=>{if(location.hash.startsWith('#/learn/quiz'))document.getElementById('view').innerHTML=INTRO_HTML;};</script>'''.replace('INTRO_HTML',json.dumps(INTRO,ensure_ascii=False))
}
results=[]
with sync_playwright() as p:
 profile=ROOT/'.test-profiles'/('pending-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f'));extension=ROOT/'extension'
 if args.legacy:
  extension=profile/'released-v050';extension.mkdir(parents=True)
  with zipfile.ZipFile(ROOT/'课伴-Edge-学习通-MOOC-v0.5.0.zip') as archive:
   for name in archive.namelist():
    if name.endswith(('.js','.mjs','.json','.html','.css')) and not any(part in name for part in ['检查报告','回归报告']):
     destination=(extension/name).resolve();assert destination.is_relative_to(extension.resolve());destination.parent.mkdir(exist_ok=True,parents=True);destination.write_bytes(archive.read(name))
 context=p.chromium.launch_persistent_context(str(profile/'edge'),headless=True,**browser_options(),args=[f'--disable-extensions-except={extension}',f'--load-extension={extension}'])
 context.route(HOST+'/**',lambda r:r.fulfill(content_type='text/html',body=FIXTURES.get(r.request.url.split('/learn/')[-1].split('#')[0],BASE)))
 worker=context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker');worker.evaluate('()=>{globalThis.apiCalls=0;globalThis.fetch=async()=>{apiCalls++;throw new Error("No API calls allowed during stopped review")}}')
 options=context.new_page();options.goto('chrome-extension://'+worker.url.split('/')[2]+'/options.html')
 def msg(kind,**extra):
  r=options.evaluate('(m)=>chrome.runtime.sendMessage(m)',{'type':kind,**extra});assert r['ok'],r;return r['data']
 def until(check,timeout=18000):
  deadline=datetime.now().timestamp()+timeout/1000
  while datetime.now().timestamp()<deadline:
   if check():return
   options.wait_for_timeout(120)
  raise AssertionError('Condition timed out')
 for case in ([args.only] if args.only else CASES):
  page=context.new_page();page_errors=[];page.on('pageerror',lambda e:page_errors.append(str(e)));course=HOST+'/learn/'+case;page.goto(course+('#/learn/quiz?id=1' if case=='stopped-quiz' else '#/learn/content?type=detail&id=1&cid=1'));page.wait_for_load_state('networkidle');page.wait_for_timeout(700)
  tab=options.evaluate('(url)=>chrome.tabs.query({}).then(ts=>ts.find(t=>t.url===url).id)',page.url)
  state=msg('KP_STATUS',tabId=tab);key='unit:1' if case=='own-discussion' else 'lesson:'+('单元检测' if case=='stopped-quiz' else '第二章单元检测')
  task={'course':course,'key':key,'title':key.split(':',1)[1],'reason':'需要本人处理'}
  if case=='review-saved':task['url']=course+'#/learn/quiz?id=3'
  state={k:v for k,v in state.items() if k not in ['settings','hasKey']};state.update(running=False,moocManualTasks=[task],moocAutoFinishedCourse=course,blocked='视频和课件已处理，仍有待处理项。')
  if case=='own-discussion':state['moocManualTasks'].append({**task,'course':course+'2'})
  options.evaluate('({id,state})=>chrome.storage.session.set({["tab:"+id]:state})',{'id':tab,'state':state})
  try:
   if case=='stopped-quiz':
    until(lambda:not msg('KP_STATUS',tabId=tab).get('moocManualTasks'),timeout=9000);assert msg('KP_STATUS',tabId=tab).get('completed')
   elif case=='own-discussion':
    page.wait_for_timeout(4000);assert len(msg('KP_STATUS',tabId=tab)['moocManualTasks'])==2,'Viewing others replies is not personal participation'
    page.locator('#post').click();until(lambda:len(msg('KP_STATUS',tabId=tab)['moocManualTasks'])==1)
    assert msg('KP_STATUS',tabId=tab)['moocManualTasks'][0]['course']==course+'2'
   else:
    result=options.evaluate('({tabId,key})=>chrome.scripting.executeScript({target:{tabId},func:key=>chrome.runtime.sendMessage({type:"KP_MOOC_REVIEW",key}),args:[key]})',{'tabId':tab,'key':key});assert result[0]['result']['ok'],result
    page.locator('.m-quizDoing .j-title').wait_for(timeout=18000);page.wait_for_timeout(2500)
    assert not page.locator('input[type=checkbox]').is_checked();assert page.locator('body').get_attribute('data-started') is None
    st=msg('KP_STATUS',tabId=tab);assert not st['running'];assert st['moocManualTasks'][0].get('url','').startswith(course+'#/learn/quiz?')
    if case=='review-lazy':assert st['moocManualTasks'][0].get('chapter')=='第二章'
   assert worker.evaluate('apiCalls')==0
   results.append({'case':case,'passed':True});print('PASS:',case,flush=True)
  except Exception as e:
   st=msg('KP_STATUS',tabId=tab);results.append({'case':case,'passed':False,'error':str(e).splitlines()[0],'page_errors':page_errors,'review':st.get('moocReview'),'tasks':st.get('moocManualTasks'),'frames':st.get('frames')});print('FAIL:',results[-1],flush=True)
  page.close()
 context.close()
report={'checks':results,'passed':sum(row['passed'] for row in results),'all_passed':all(row['passed'] for row in results),'complete_suite':not args.only,'legacy':args.legacy,'real_api_tested':False,'real_course_tested':False}
(ROOT/'test-results'/('mooc-pending-legacy-report.json' if args.legacy else 'mooc-pending-report.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
raise SystemExit(0 if report['all_passed'] else 1)
