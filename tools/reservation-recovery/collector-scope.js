(async()=>{
 if(new URLSearchParams(location.search).get('village_collector')!=='1'||!location.pathname.endsWith('/chats'))return {ok:false,reason:'not_owned_list'};
 const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
 const label=e=>(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
 let current=[...document.querySelectorAll('button')].find(e=>visible(e)&&['전체 상담','진행 중 상담','읽지 않은 상담','답변하지 않은 상담','답변한 상담','완료된 상담'].includes(label(e)));
 if(!current)return {ok:false,reason:'consultation_scope_unknown'};
 if(label(current)==='전체 상담')return {ok:true,scope:'all'};
 current.click();await new Promise(r=>setTimeout(r,100));
 const exact=[...document.querySelectorAll('button,a,[role="option"],li')].filter(e=>visible(e)&&label(e)==='전체 상담');
 if(!exact.length)return {ok:false,reason:'all_consultations_option_missing'};
 exact.at(-1).click();await new Promise(r=>setTimeout(r,300));
 current=[...document.querySelectorAll('button')].find(e=>visible(e)&&label(e)==='전체 상담');
 return {ok:!!current,scope:current?'all':'unknown'};
})()
