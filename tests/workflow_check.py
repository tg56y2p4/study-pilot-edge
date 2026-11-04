"""Regression checks for submission/navigation races. Entirely offline."""
import argparse
import json
import io
import wave
import base64
from PIL import Image
from pathlib import Path
from datetime import datetime
from urllib.parse import urlparse
from browser_support import browser_options
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
HOST='https://mooc1.chaoxing.com'
Q='<div class="TiMu"><h3 class="Zy_TItle">【单选题】流程题：2+2？</h3><label><input type="radio" name="one" value="A">3</label><label><input type="radio" name="one" value="B">4</label></div>'
FORM=Q+'''<button id="submit" onclick="top.openConfirm()">提交</button>'''
CONFIRM='''<div id="confirmation" class="popDiv" hidden>确认提交？<button id="confirm" onclick="this.parentElement.hidden=true;document.body.dataset.selection=document.querySelector('#work').contentWindow.document.querySelector('input:checked')?.value;document.querySelector('#work').contentWindow.document.body.innerHTML='<div class=testTit_status_complete>已完成</div>';document.body.dataset.submitted='yes'">提交</button></div>'''
BASE='<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif;margin:25px}iframe{width:700px;height:320px}button{padding:8px}li{cursor:pointer}</style>'
fixtures={
 '/slow':BASE+'''<iframe id="work" src="/form"></iframe>'''+CONFIRM+'''<script>window.openConfirm=()=>document.getElementById('confirmation').hidden=false</script>''',
 '/existing':BASE+'''<iframe id="work" src="/filled"></iframe>'''+CONFIRM+'''<script>window.openConfirm=()=>document.getElementById('confirmation').hidden=false</script>''',
 '/retry':BASE+'''<iframe id="work" src="/form"></iframe>'''+CONFIRM+'''<script>let clicks=0;window.openConfirm=()=>{document.body.dataset.clicks=String(++clicks);if(clicks>=2)document.getElementById('confirmation').hidden=false}</script>''',
 '/form':BASE+FORM,
 '/filled':BASE+FORM.replace('value="B"','value="B" checked'),
 '/transient':BASE+'''<iframe id="work" src="/form"></iframe>'''+CONFIRM+'''<script>window.openConfirm=()=>document.getElementById('confirmation').hidden=false</script>''',
 '/mismatch':BASE+'''<iframe id="work" src="/wrong-filled"></iframe>'''+CONFIRM+'''<script>window.openConfirm=()=>document.getElementById('confirmation').hidden=false</script>''',
 '/wrong-filled':BASE+FORM.replace('value="A"','value="A" checked'),
 '/audio':BASE+'<audio controls src="/sample.wav"></audio><a href="/arrived" data-study-next>下一节</a>',
 '/document':BASE+'<div class="ans-job-icon ans-job-doc" aria-label="任务点已完成"></div><a href="/arrived" data-study-next>下一节</a>',
 '/late-hello':BASE+'<input id="chapterIdid" type="hidden" value="777"><div class="ans-job-icon ans-job-doc" aria-label="任务点已完成"></div><a href="/arrived" data-study-next>下一节</a>',
 '/stale-frame':BASE+'''<input id="chapterIdid" type="hidden" value="777"><li id="dct1" onclick="document.getElementById('dct2').className='';this.className='active';document.body.dataset.video='requested';setTimeout(()=>document.getElementById('work').src='/long-media',9000)">1视频</li><li id="dct2" class="active">2章节测验</li><iframe id="work" src="/completed-form"></iframe><a href="/arrived" data-study-next>下一节</a>''',
 '/completed-form':BASE+'<div class="testTit_status_complete">已完成</div>',
 '/long-media':BASE+'<video controls muted src="/long.wav"></video>',
 '/terminal':BASE+'<input id="chapterIdid" type="hidden" value="777"><div class="ans-job-icon ans-job-video" aria-label="任务点已完成"></div><video></video><div id="coursetree"><div id="cur777" class="posCatalog_active"><a class="clicktitle">1.1 最后一章</a></div></div>',
 '/catalog':BASE+'<input id="chapterIdid" type="hidden" value="777"><div class="ans-job-icon ans-job-video" aria-label="任务点已完成"></div><video></video><div id="prevNextFocusNext" role="button">下一节</div><div id="coursetree"><div id="cur777" class="posCatalog_active"><a class="clicktitle">1.1 当前章节</a></div><div id="cur778"><a class="clicktitle" href="/arrived">1.2 下一章节</a></div></div>',
 '/reading':BASE+'<input id="chapterIdid" type="hidden" value="read777"><iframe src="/coursedata/readjobv2/show"></iframe><a href="/arrived" data-study-next>下一节</a>',
 '/reading-missing':BASE+'<input id="chapterIdid" type="hidden" value="read777"><iframe src="/coursedata/readjobv2/show-missing"></iframe>',
 '/coursedata/readjobv2/show':BASE+'<a href="/zt/portal/broken">阅读一</a><a href="/zt/portal/good">阅读二</a>',
 '/coursedata/readjobv2/show-missing':BASE+'<a href="/zt/portal/broken">阅读一</a><a href="/zt/portal/broken2">阅读二</a>',
 '/zt/portal/broken':BASE+'<title>404</title><p>页面不存在 404</p>',
 '/zt/portal/broken2':BASE+'<title>404</title><p>页面不存在 404</p>',
 '/zt/portal/good':BASE+'<h1>阅读第一页</h1><p>这是一段用于验证阅读器正常翻页的课程内容，实际浏览页面后才能返回课程，资源失效不会被记成已阅读。</p><button onclick="document.querySelector(\'h1\').textContent=\'阅读最后一页\';this.remove()">下一页</button>',
 '/arrived':BASE+'<p id="arrived">已进入下一节</p>',
 '/autosave':BASE+Q+'<p role="status">答案已保存</p>',
 '/capture-layout':BASE+'<style>body{min-width:1300px}header{position:fixed;top:0;left:0;right:0;height:70px;background:#883333;z-index:99}iframe{width:900px;height:1800px}</style><header>固定课程标题</header><div style="height:500px"></div><iframe src="/capture-long"></iframe>',
 '/capture-long':BASE+Q.replace('流程题：2+2？','<span style="display:block;background:rgb(255,220,0);height:50px">完整题干</span><img src="/marker.svg"><span style="display:block;height:1100px">很长的题目</span><span style="display:block;background:rgb(0,220,90);height:50px">题目末尾</span>'),
 '/spa':BASE+'''<input type="hidden" id="chapterIdid" value="stage1"><div id="lesson"></div><div id="confirmation" class="popDiv" hidden>确认提交？<button onclick="this.parentElement.hidden=true;document.getElementById('work').contentWindow.document.body.innerHTML='<div class=testTit_status_complete>已完成</div>';submitted++;document.body.dataset.submissions=submitted">提交</button></div><script>
let stage=1,submitted=0;window.openConfirm=()=>document.getElementById('confirmation').hidden=false;
function render(){document.getElementById('chapterIdid').value='stage'+stage;document.getElementById('lesson').innerHTML=`<ul><li id="dct1" class="active">1视频</li><li id="dct2" onclick="quiz()">2章节测验</li></ul><div id="card"><div class="ans-job-icon ans-job-video" aria-label="任务点已完成"></div><video></video></div><div id="prevNextFocusNext" role="button" onclick="next()">下一节</div>`;}
function quiz(){document.getElementById('dct1').className='';document.getElementById('dct2').className='active';document.getElementById('card').innerHTML='<iframe id="work" src="/form?stage='+stage+'"></iframe>';}
function next(){if(stage===2){document.getElementById('lesson').innerHTML='<p id="arrived">连续两章完成</p>';return;}stage++;render();}
render();</script>''',
}
CASES=['slow','existing','retry','spa','autosave','audio','document','terminal','catalog','transient','mismatch','reading','reading-missing','capture-layout','late-hello','stale-frame']
parser=argparse.ArgumentParser();parser.add_argument('--only',choices=CASES);args=parser.parse_args()
results=[]
with sync_playwright() as p:
 profile=ROOT/'.test-profiles'/('workflow-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
 ext=ROOT/'extension'
 c=p.chromium.launch_persistent_context(str(profile),headless=True,**browser_options(),args=[f'--disable-extensions-except={ext}',f'--load-extension={ext}'])
 if args.only:print('TRACE: isolated Edge ready',flush=True)
 audio=io.BytesIO()
 with wave.open(audio,'wb') as wav:
  wav.setparams((1,2,8000,0,'NONE','not compressed'));wav.writeframes(b'\x00\x00'*8000)
 long_audio=io.BytesIO()
 with wave.open(long_audio,'wb') as wav:
  wav.setparams((1,2,8000,0,'NONE','not compressed'));wav.writeframes(b'\x00\x00'*8000*30)
 def route(r):
  path=urlparse(r.request.url).path
  if path=='/sample.wav':r.fulfill(content_type='audio/wav',body=audio.getvalue())
  elif path=='/long.wav':r.fulfill(content_type='audio/wav',body=long_audio.getvalue())
  elif path=='/marker.svg':r.fulfill(content_type='image/svg+xml',body='<svg xmlns="http://www.w3.org/2000/svg" width="50" height="30"><text y="20">2+2</text></svg>')
  else:r.fulfill(content_type='text/html; charset=utf-8',body=fixtures.get(path,BASE))
 c.route('https://*.chaoxing.com/**',route)
 w=c.service_workers[0] if c.service_workers else c.wait_for_event('serviceworker')
 if args.only:print('TRACE: worker ready',flush=True)
 w.evaluate('''()=>{globalThis.mode='ok';globalThis.planCalls=0;globalThis.attempts=0;globalThis.fetch=async(url,opts)=>{let b=JSON.parse(opts.body),content=b.messages[1].content;globalThis.lastImage=Array.isArray(content)?content.find(x=>x.type==='image_url')?.image_url?.url:null;let q=JSON.parse(Array.isArray(content)?content.find(x=>x.type==='text').text:content);let result;if(q.controls){planCalls++;result={action:'pause',confidence:1,reason:'Regression: planner must not run during exercises'};}else{if(mode==='slow')await new Promise(r=>setTimeout(r,10500));if(mode==='transient'&&++attempts===1)return new Response('{"error":{"code":"TemporarilyUnavailable"}}',{status:500});result={answers:['B'],explanation:'4',confidence:1};}return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}],usage:{total_tokens:1}}),{status:200});};}''')
 o=c.new_page();o.goto('chrome-extension://'+w.url.split('/')[2]+'/options.html')
 if args.only:print('TRACE: options ready',flush=True)
 def msg(kind,**extra):
  r=o.evaluate('(m)=>chrome.runtime.sendMessage(m)',{'type':kind,**extra});assert r['ok'],r;return r['data']
 s=msg('KP_GET_SETTINGS');s.update(confidenceGate=True, reviewEnabled=False,reviewProfiles=[],endpoint='https://maas.qianwenaiapi.com/compatible-mode/v1',visionModel='fixture-vision',apiKey='fixture-workflow-only',autoSubmit=True,autoConfirm=True,visualAgent=True,agentInterval=8000,requestGap=2000,readingInterval=1000);msg('KP_SAVE_SETTINGS',settings=s)
 for name in ([args.only] if args.only else CASES):
  s=msg('KP_GET_SETTINGS');s['model']='fixture-'+name;msg('KP_SAVE_SETTINGS',settings=s)
  page=c.new_page();page.goto(HOST+'/'+name);page.wait_for_load_state('networkidle')
  if args.only:print('TRACE: fixture loaded',flush=True)
  tab=o.evaluate('(url)=>chrome.tabs.query({}).then(ts=>ts.find(t=>t.url===url).id)',page.url)
  w.evaluate('(m)=>{mode=m;planCalls=0;attempts=0;lastImage=null}', name if name in ['slow','transient'] else 'ok')
  msg('KP_START',tabId=tab)
  if args.only:print('TRACE: workflow started',flush=True)
  if name=='late-hello':
   page.wait_for_timeout(2000)
   o.evaluate('(tabId)=>chrome.scripting.executeScript({target:{tabId},func:()=>chrome.runtime.sendMessage({type:"KP_HELLO"})})',tab)
  try:
   if name=='stale-frame':
    page.locator('body[data-video=requested]').wait_for(timeout=16000)
    page.wait_for_timeout(14500)
    assert page.url.endswith('/stale-frame'),'Old quiz reports must not complete the newly selected video'
    st=msg('KP_STATUS',tabId=tab);assert st['progress']['doneCards'].get('dct2') and not st['progress']['doneCards'].get('dct1'),st['progress']
    video=page.frame(url=HOST+'/long-media').locator('video')
    assert video.evaluate('(v)=>!v.paused&&v.currentTime>0&&!v.ended'),'The pending video must continue playing'
   elif name=='capture-layout':
    page.frame(url=HOST+'/capture-long').locator('input[value=B]:checked').wait_for(timeout=25000)
    image_data=w.evaluate('lastImage')
    assert image_data,'The model must receive the screenshot'
    image_bytes=base64.b64decode(image_data.split(',')[1]);(ROOT/'test-results'/'capture-layout.jpg').write_bytes(image_bytes)
    picture=Image.open(io.BytesIO(image_bytes)).convert('RGB')
    pixels=list(picture.get_flattened_data())
    assert sum(r>220 and 180<g<245 and b<40 for r,g,b in pixels)>1000,'The full stem must remain visible above a sticky header'
    assert sum(r<40 and g>180 and 50<b<130 for r,g,b in pixels)>1000,'The bottom of a tall question must also be captured'
   elif name=='spa':
    page.locator('#arrived').wait_for(timeout=40000)
    assert page.locator('body').get_attribute('data-submissions')=='2','Both chapters must submit, without skipping the second quiz'
   elif name=='autosave':
    page.wait_for_timeout(4000);st=msg('KP_STATUS',tabId=tab)
    assert any(f.get('questions')==1 and not f.get('completed') for f in st['frames'].values()),'Saving a draft is not submission completion'
   elif name in ['audio','document','catalog','reading','late-hello']:
    page.locator('#arrived').wait_for(timeout=40000)
    if name=='reading':
     st=msg('KP_STATUS',tabId=tab);assert any('阅读资源不可用' in x['text'] for x in st['logs']);assert any('已浏览当前阅读页面' in x['text'] for x in st['logs'])
   elif name in ['terminal','reading-missing']:
    deadline=datetime.now().timestamp()+35
    while msg('KP_STATUS',tabId=tab)['running'] and datetime.now().timestamp()<deadline:page.wait_for_timeout(200)
    st=msg('KP_STATUS',tabId=tab);assert not st['running'],st
    if name=='terminal':assert st.get('completed') and not st.get('blocked')
    else:assert '专题阅读资源均无法打开' in st['blocked']
   else:
    page.locator('body[data-submitted=yes]').wait_for(timeout=28000)
    assert w.evaluate('planCalls')==0,'Planner ran while a course exercise was being processed'
    if name=='mismatch':assert page.get_attribute('body','data-selection')=='B', 'Replace the previous A and submit the reviewed B'
    if name=='transient':assert msg('KP_STATUS',tabId=tab)['calls']==2
   results.append({'case':name,'passed':True});print('PASS:',name,flush=True)
  except Exception as e:
   st=msg('KP_STATUS',tabId=tab);results.append({'case':name,'passed':False,'reason':str(e).splitlines()[0],'blocked':st.get('blocked'),'calls':st['calls'],'frames':st['frames'],'media':page.locator('video,audio').evaluate_all('(media)=>media.map(v=>({paused:v.paused,ended:v.ended,ready:v.readyState,time:v.currentTime,duration:Number.isFinite(v.duration)?v.duration:null,error:v.error?.code}))')});print('FAIL:',name,results[-1],flush=True)
  msg('KP_STOP',tabId=tab);page.close()
 c.close()
(ROOT/'test-results'/'workflow-report.json').write_text(json.dumps({'checks':results,'passed':sum(r['passed'] for r in results),'all_passed':all(r['passed'] for r in results),'complete_suite':not bool(args.only),'real_course_tested':False,'real_api_tested':False},ensure_ascii=False,indent=2),encoding='utf-8')
raise SystemExit(0 if all(r['passed'] for r in results) else 1)
