/* Presentation-only additions; gateway and host handlers stay in app.js. */
(()=>{const $=id=>document.getElementById(id),app=$('app'),settings=$('settings');let previousFocus;
document.querySelectorAll('[data-prompt]').forEach(b=>b.addEventListener('click',()=>{$('input').value=b.dataset.prompt;$('input').focus()}));
function sync(){const busy=app.dataset.state==='busy';$('input').disabled=app.dataset.state!=='connected';$('providerSelect').disabled=busy;$('modelSelect').disabled=busy;const scene=$('attachScene').checked;$('contextLabel').textContent=(window.Stultus&&window.Stultus.contextText)?window.Stultus.contextText(scene):(scene?'Контекст сцены':'Без контекста');}
new MutationObserver(sync).observe(app,{attributes:true,attributeFilter:['data-state']});$('attachScene').addEventListener('change',sync);sync();
new MutationObserver(()=>{if(!settings.hidden){previousFocus=document.activeElement;$('setGateway').focus()}else if(previousFocus&&previousFocus.isConnected){previousFocus.focus()}}).observe(settings,{attributes:true,attributeFilter:['hidden']});
settings.addEventListener('keydown',e=>{if(e.key==='Escape'){$('btnCloseSettings').click();e.preventDefault()}if(e.key==='Tab'){const focus=[...settings.querySelectorAll('button,input')].filter(el=>!el.disabled&&el.offsetParent!==null),first=focus[0],last=focus[focus.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});
})();
