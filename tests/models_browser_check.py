"""Model setup UI integration in an isolated Edge profile; all API calls mocked."""
import json
from datetime import datetime
from pathlib import Path
from browser_support import browser_options
from playwright.sync_api import sync_playwright,expect

ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'test-results';results=[]
def record(name):results.append({'case':name,'passed':True});print('PASS:',name,flush=True)
with sync_playwright() as p:
 profile=ROOT/'.test-profiles'/('models-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f'));ext=ROOT/'extension'
 context=p.chromium.launch_persistent_context(str(profile),headless=True,**browser_options(),args=[f'--disable-extensions-except={ext}',f'--load-extension={ext}'])
 worker=context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
 worker.evaluate('''()=>{globalThis.requests=[];globalThis.mode='standard';globalThis.cancelled=0;globalThis.fetch=async(url,opts)=>{const body=opts.body?JSON.parse(opts.body):null;requests.push({url,method:opts.method,model:body?.model,hasKey:!!opts.headers.Authorization});if(opts.method==='GET'){if(mode==='slow')await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,1800);opts.signal.addEventListener('abort',()=>{clearTimeout(timer);cancelled++;reject(new DOMException('Aborted','AbortError'));},{once:true});});if(mode==='unsupported')return new Response('{}',{status:404});if(mode==='unauthorized')return new Response(JSON.stringify({error:{message:'fixture-private-key-not-for-display'}}),{status:401});if(mode==='empty')return new Response('{"data":[]}');if(mode==='native')return new Response(JSON.stringify({output:{total:1,models:[{model:'native-vision',capabilities:['TG','VU']}]}}));return new Response(JSON.stringify({data:[{id:'text-standard',input_modalities:['text'],output_modalities:['text']},{id:'vision-opaque',input_modalities:['text','image'],output_modalities:['text']},{id:'unknown-capability'},{id:'image-only',output_modalities:['image']},{id:'text-standard'}]}));}const content=Array.isArray(body.messages[1].content)?{answers:['4'],confidence:1,explanation:'4'}:{ok:true};return new Response(JSON.stringify({model:body.model,choices:[{message:{content:JSON.stringify(content)}}]}));};}''')
 page=context.new_page();page.goto('chrome-extension://'+worker.url.split('/')[2]+'/options.html');page.wait_for_load_state('networkidle')
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 def msg(kind,**extra):
  r=page.evaluate('(m)=>chrome.runtime.sendMessage(m)',{'type':kind,**extra});assert r['ok'],r;return r['data']
 def pull():page.locator('#fetchModels').click();expect(page.locator('#fetchModels')).to_be_enabled(timeout=10000)
 try:
  expect(page.locator('#endpoint')).to_have_value('');expect(page.locator('#model')).to_have_value('');expect(page.locator('#apiKey')).to_have_value('');record('Fresh installation contains no personal endpoint, model or Key')
  page.set_viewport_size({'width':1240,'height':1800});bounds=page.locator('.setup-layout').bounding_box();page.screenshot(path=str(OUT/'settings-empty-v060.png'),clip={'x':0,'y':0,'width':1240,'height':bounds['y']+bounds['height']+20})
  page.locator('#endpoint').fill('https://api.chaoxing.com/proxy/v1');page.locator('#apiKey').fill('fixture-models-only');pull();expect(page.locator('#modelMessage')).to_contain_text('4 个模型')
  assert page.locator('#modelSelect option[value="text-standard"]').count()==1
  assert page.locator('#modelSelect option[value="image-only"]').count()==0
  assert not msg('KP_GET_SETTINGS')['hasKey'];record('Fetch reads and deduplicates the selected service without saving the draft Key')
  page.locator('#modelSearch').fill('vision');assert page.locator('#modelSelect option').count()==2;page.locator('#modelSearch').fill('')
  page.locator('#modelSelect').select_option('text-standard');expect(page.locator('#model')).to_have_value('text-standard');expect(page.locator('#visionModel')).to_have_value('text-standard');record('Searchable selection updates model IDs and supports one model for both tasks')
  page.locator('#visionModelSelect').select_option('vision-opaque');expect(page.locator('#sameModel')).not_to_be_checked();page.locator('#test').click();expect(page.locator('#connectionMessage')).to_contain_text('连接成功',timeout=10000)
  page.locator('#testVision').click();expect(page.locator('#connectionMessage')).to_contain_text('图片识别通过',timeout=10000)
  posts=worker.evaluate('requests.filter(r=>r.method==="POST")');assert [r['model'] for r in posts[-2:]]==['text-standard','vision-opaque'];expect(page.locator('#apiKey')).to_have_value('');record('Text and image tests actually call the independently selected models')
  page.set_viewport_size({'width':1240,'height':1100});page.evaluate('window.scrollTo(0,0)');page.wait_for_timeout(150);page.screenshot(path=str(OUT/'settings-v050-desktop.png'),full_page=True)
  page.set_viewport_size({'width':1240,'height':2000});page.evaluate('window.scrollTo(0,0)');setup_bottom=page.locator('.setup-layout').bounding_box();page.screenshot(path=str(OUT/'settings-v050-setup.png'),clip={'x':0,'y':0,'width':1240,'height':setup_bottom['y']+setup_bottom['height']+25})
  page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');page.screenshot(path=str(OUT/'settings-v050-mobile.png'),full_page=True);page.set_viewport_size({'width':1240,'height':1000});record('Desktop and narrow settings layouts have no horizontal overflow')
  count=worker.evaluate('requests.length');page.locator('#endpoint').fill('https://maas.qianwenaiapi.com/compatible-mode/v1');pull();expect(page.locator('#modelMessage')).to_contain_text('填写这个服务');assert worker.evaluate('requests.length')==count
  r=page.evaluate('()=>chrome.runtime.sendMessage({type:"KP_LIST_MODELS",connection:{endpoint:"https://maas.qianwenaiapi.com/compatible-mode/v1"}})');assert not r['ok'] and '旧Key不会' in r['error'];assert worker.evaluate('requests.length')==count;record('Changing service cannot forward the old saved Key through UI or background')
  page.locator('#apiKey').fill('fixture-new-models-only');pull();expect(page.locator('#modelMessage')).to_contain_text('已读取');record('A new service can fetch its models with an explicitly supplied new Key')
  worker.evaluate('mode="unsupported"');pull();expect(page.locator('#modelMessage')).to_contain_text('手动填写');page.locator('#model').fill('manual-text');page.locator('#visionModel').fill('manual-vision');page.locator('#test').click();expect(page.locator('#connectionMessage')).to_contain_text('连接成功',timeout=10000);assert msg('KP_GET_SETTINGS')['model']=='manual-text';record('Services without a model-list endpoint still work with a manual model ID')
  worker.evaluate('mode="unauthorized"');pull();expect(page.locator('#modelMessage')).to_contain_text('401');assert 'fixture-private-key' not in page.locator('#modelMessage').inner_text();record('Authentication errors do not echo service response bodies')
  worker.evaluate('mode="empty"');pull();expect(page.locator('#modelMessage')).to_contain_text('空目录');record('An empty directory stays empty and keeps the manual-entry path')
  worker.evaluate('mode="slow"');before=worker.evaluate('requests.length');page.locator('#fetchModels').click()
  for _ in range(60):
   if worker.evaluate('requests.length')>before:break
   page.wait_for_timeout(50)
  assert worker.evaluate('requests.length')>before
  page.locator('#endpoint').fill('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');expect(page.locator('#fetchModels')).to_be_enabled(timeout=10000);assert page.locator('#modelSelect option[value="text-standard"]').count()==0;assert worker.evaluate('cancelled')==1;record('Changing connection cancels the old request and prevents stale model results')
  page.locator('#apiKey').fill('fixture-native-models-only');worker.evaluate('mode="native"');pull();expect(page.locator('#modelMessage')).to_contain_text('1 个模型');page.locator('#modelSelect').select_option('native-vision');record('Aliyun native model catalog and capability labels populate the same selector')
  page.evaluate('()=>{globalThis.originalRequest=chrome.permissions.request;chrome.permissions.request=async()=>false;}');count=worker.evaluate('requests.length');pull();expect(page.locator('#modelMessage')).to_contain_text('未获得');assert worker.evaluate('requests.length')==count;page.evaluate('()=>chrome.permissions.request=originalRequest');record('Denied site access prevents network requests and explains how to retry')
  page.locator('#clearKey').click();expect(page.locator('#message')).to_contain_text('删除');assert not msg('KP_GET_SETTINGS')['hasKey'];record('Deleting the Key works even while the form targets a different service')
  context.route('https://mooc1.chaoxing.com/models-denied',lambda r:r.fulfill(content_type='text/html',body='<html><body>Fixture course</body></html>'))
  course=context.new_page();course.goto('https://mooc1.chaoxing.com/models-denied');course.wait_for_load_state('networkidle');tab=page.evaluate('(url)=>chrome.tabs.query({}).then(ts=>ts.find(t=>t.url===url).id)',course.url);count=worker.evaluate('requests.length')
  denied=page.evaluate('(tabId)=>chrome.scripting.executeScript({target:{tabId},func:()=>chrome.runtime.sendMessage({type:"KP_LIST_MODELS",connection:{endpoint:"https://dashscope-intl.aliyuncs.com/compatible-mode/v1"}})})',tab)
  assert not denied[0]['result']['ok'];assert worker.evaluate('requests.length')==count;course.close();record('Course content scripts cannot invoke the privileged model-list operation')
  assert not errors,errors;record('No uncaught browser errors during configuration')
 except Exception:
  page.screenshot(path=str(OUT/'models-failure.png'),full_page=True);raise
 finally:context.close()
report={'checks':results,'passed':len(results),'all_passed':True,'real_api_tested':False,'real_course_tested':False}
(OUT/'models-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
