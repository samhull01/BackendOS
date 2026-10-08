// Browser integration model only. Actual authorization is tested in PostgreSQL.
module.exports = `
window.calls=[]; window.tables={workspaces:[
 {id:'A',name:'Hotel A',business:{},enabled_apps:['tax-tracker','documents']},
 {id:'B',name:'Hotel B',business:{},enabled_apps:['tax-tracker','customers']}
],workspace_members:[{workspace_id:'A',user_id:'user-a',role:'owner'},{workspace_id:'A',user_id:'user-b',role:'member'},{workspace_id:'B',user_id:'user-b',role:'owner'}],workspace_homes:[],user_preferences:[{user_id:'user-a',appearance:{accent:'#c56740',theme:'dark'}}],hotel_tax_settings:[],hotel_tax_entries:[]};
let current=null, callback;
window.supabaseClient={auth:{onAuthStateChange(fn){callback=fn;setTimeout(()=>fn('INITIAL_SESSION',current),0)},async getSession(){return {data:{session:current}}},async signInWithPassword(v){current={user:{id:v.email==='a@example.com'?'user-a':'user-b',email:v.email}};callback('SIGNED_IN',current);return {}},async signOut(){current=null;callback('SIGNED_OUT',null);return {}}},
 async rpc(name,args){calls.push({name,args});if(window.failWrite){window.failWrite=false;return {error:{message:'Write denied'}}}if(name==='restore_hotel_tax'){const {backup,target_workspace:wid}=args;tables.hotel_tax_entries=tables.hotel_tax_entries.filter(e=>e.workspace_id!==wid);tables.hotel_tax_entries.push(...backup.entries.map(e=>({...e,id:crypto.randomUUID(),workspace_id:wid})));tables.hotel_tax_settings=tables.hotel_tax_settings.filter(e=>e.workspace_id!==wid);tables.hotel_tax_settings.push({...backup.settings,workspace_id:wid});return {data:null}}},
 from(table){let op='select',payload,filters=[],single=false,range=null,signal;
 const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},gte(k,v){filters.push(r=>r[k]>=v);return q},lt(k,v){filters.push(r=>r[k]<v);return q},order(){return q},range(a,b){range=[a,b];return q},abortSignal(s){signal=s;return q},maybeSingle(){single=true;return q},single(){single=true;return q},insert(v){op='insert';payload=v;return q},update(v){op='update';payload=v;return q},upsert(v){op='upsert';payload=v;return q},delete(){op='delete';return q},
 async then(resolve){const uid=current?.user.id;calls.push({table,op,payload:structuredClone(payload)});
 const role=wid=>tables.workspace_members.find(m=>m.workspace_id===wid&&m.user_id===uid)?.role;
 const allowed=r=>table==='user_preferences'||table==='workspace_homes'?r.user_id===uid:table==='workspaces'?!!role(r.id):!!role(r.workspace_id);
 let rows=tables[table], selected=rows.filter(allowed).filter(r=>filters.every(f=>f(r)));
 if(window.failWrite&&op!=='select'){window.failWrite=false;return resolve({error:{message:'Write denied'}})}
 if(window.failLoad&&table==='hotel_tax_entries'&&op==='select'){window.failLoad=false;return resolve({error:{message:'Load denied'}})}
 let data=selected;
 if(op==='insert'){const r={id:crypto.randomUUID(),...payload};rows.push(r);data=[r]}
 if(op==='update'){selected.forEach(r=>Object.assign(r,payload));data=selected}
 if(op==='upsert'){let r=rows.find(r=>r.workspace_id===payload.workspace_id&&(table==='hotel_tax_settings'||r.user_id===payload.user_id));if(!r){r={...payload};rows.push(r)}else Object.assign(r,payload);data=[r]}
 if(op==='delete')tables[table]=rows.filter(r=>!selected.includes(r));
 if(range)data=data.slice(range[0],range[1]+1);if(single)data=data[0]||null;
 const snapshot=structuredClone(data);
 if(table==='hotel_tax_entries'&&op==='select'&&window.delayEntries){await new Promise(r=>setTimeout(r,window.delayEntries))}
 // Deliberately ignores aborts, to exercise stale-result rejection even for an uncooperative transport.
 return resolve({data:snapshot});
 }};return q}
};`;
