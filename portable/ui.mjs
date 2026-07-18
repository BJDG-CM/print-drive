export function renderPortableUi(nonce) {
    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Print Drive 휴대형 업데이터</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#f4f7fb;color:#172033}main{max-width:780px;margin:32px auto;padding:24px}.card{background:white;border:1px solid #d8e0ec;border-radius:16px;padding:20px;margin:16px 0}h1{margin-top:0}label{display:block;margin:12px 0 6px;font-weight:650}input,select,textarea,button{font:inherit}input,select,textarea{box-sizing:border-box;width:100%;padding:10px;border:1px solid #aab6c8;border-radius:8px}button{padding:10px 14px;border:0;border-radius:8px;background:#1d4ed8;color:white;font-weight:700;cursor:pointer}button.secondary{background:#475569}button.danger{background:#b42318}.row{display:flex;gap:8px;flex-wrap:wrap}.muted{color:#5d6879;font-size:.92rem}pre{white-space:pre-wrap;background:#eef2f7;padding:12px;border-radius:8px;min-height:70px}.hidden{display:none}</style></head>
<body><main><h1>Print Drive 휴대형 업데이터</h1><p class="muted">평문과 비밀번호는 이 컴퓨터 안에서만 처리됩니다. GitHub에는 암호화된 파일만 전송합니다.</p>
<section class="card"><h2>1. Workspace 확인</h2><p id="workspace">불러오는 중…</p></section>
<section class="card"><h2>2–4. 원격 vault 가져오기 및 변경 검토</h2>
<label for="password">Vault 비밀번호</label><input id="password" type="password" autocomplete="off">
<label for="mode">업데이트 모드</label><select id="mode"><option value="add-replace">추가/교체 (권장)</option><option value="remove-selected">선택 삭제 + 추가/교체</option><option value="mirror">Workspace와 완전히 동일하게 맞추기 (고급)</option></select>
<label for="removals">삭제할 원격 상대 경로 (한 줄에 하나)</label><textarea id="removals" rows="3"></textarea>
<label><input id="empty-confirm" type="checkbox"> 빈 Workspace 전체 삭제를 한 번 더 확인합니다</label>
<button id="preview">암호화된 변경 미리보기</button></section>
<section class="card"><h2>5. GitHub 로그인</h2><p id="device-help" class="muted">저장소 관리자가 Device Flow client ID를 설정하면 기기 로그인을 사용할 수 있습니다.</p><div class="row"><button id="device">GitHub 기기 로그인</button></div>
<details><summary>고급: fine-grained token을 이번 작업에만 사용</summary><label for="pat">Token (저장되지 않음)</label><input id="pat" type="password" autocomplete="off"></details></section>
<section class="card"><h2>6–7. 암호화 업데이트 적용</h2><div class="row"><button id="apply">원격에 단일 커밋으로 적용</button><button id="fallback" class="secondary hidden">업데이트 브랜치와 PR 만들기</button></div><pre id="status" aria-live="polite">준비됨</pre></section>
</main><script nonce="${nonce}">
const query=location.search;let csrf='';const status=document.getElementById('status');
async function call(path,body){const response=await fetch(path+query,{method:body?'POST':'GET',headers:body?{'content-type':'application/json','x-print-drive-csrf':csrf}:{},body:body?JSON.stringify(body):undefined});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error||'요청 실패'),value);return value}
call('/api/session').then(v=>{csrf=v.csrf;document.getElementById('workspace').textContent=v.workspace+' → '+v.owner+'/'+v.repo+' @ '+v.branch;document.getElementById('device').disabled=!v.deviceFlowConfigured}).catch(e=>status.textContent=e.message);
document.getElementById('preview').onclick=async()=>{status.textContent='원격 snapshot을 가져와 로컬에서 암호화하는 중…';try{const v=await call('/api/preview',{passphrase:document.getElementById('password').value,token:document.getElementById('pat').value,mode:document.getElementById('mode').value,removePaths:document.getElementById('removals').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),confirmEmptyMirror:document.getElementById('empty-confirm').checked});document.getElementById('password').value='';status.textContent=JSON.stringify(v,null,2)}catch(e){status.textContent=e.message}};
document.getElementById('device').onclick=async()=>{try{const v=await call('/api/device/start',{});status.textContent='코드 '+v.userCode+' 를 '+v.verificationUri+' 에 입력하세요.\n이 창에서 승인을 기다립니다…';await call('/api/device/poll',{});status.textContent='GitHub 로그인이 완료됐습니다.'}catch(e){status.textContent=e.message}};
document.getElementById('apply').onclick=async()=>{try{status.textContent='원격 ref를 다시 확인하고 적용하는 중…';const v=await call('/api/apply',{token:document.getElementById('pat').value});status.textContent=JSON.stringify(v,null,2)}catch(e){status.textContent=e.message;if(e.canFallback)document.getElementById('fallback').classList.remove('hidden')}};
document.getElementById('fallback').onclick=async()=>{try{const v=await call('/api/fallback',{});status.textContent=JSON.stringify(v,null,2)}catch(e){status.textContent=e.message}};
</script></body></html>`;
}
