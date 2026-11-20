// A just-enough IndexedDB for the App icon store: open (with upgrade), one object store, get/put/delete/clear in transactions.
// Operations run in call order; callbacks arrive in microtasks, the way a real database answers.
export function fakeIndexedDB({fail=false}={}) {
  const databases=new Map(),log=[];
  const state={fail,log,databases,opens:0};
  const answer=(run)=>{const request={};queueMicrotask(()=>{try{request.result=run();}catch(error){request.error=error;request.onerror?.({});return;}request.onsuccess?.({});});return request;};
  function database(data){
    return {
      createObjectStore(){},close(){},onversionchange:null,
      transaction(name,mode){
        const transaction={mode,error:undefined,oncomplete:null,onerror:null,onabort:null};
        const finish=()=>queueMicrotask(()=>queueMicrotask(()=>transaction.oncomplete?.({})));
        transaction.objectStore=()=>{
          const op=(kind,work)=>{log.push([kind]);const request=answer(work);finish();return request;};
          return {
            get:key=>{log.push(['get',key]);const request=answer(()=>data.has(key)?structuredClone(data.get(key)):undefined);finish();return request;},
            put:(value,key)=>{log.push(['put',key]);const request=answer(()=>{data.set(key,structuredClone(value));return key;});finish();return request;},
            delete:key=>{log.push(['delete',key]);const request=answer(()=>{data.delete(key);});finish();return request;},
            clear:()=>op('clear',()=>{data.clear();}),
          };
        };
        return transaction;
      },
    };
  }
  state.open=(name)=>{
    state.opens++;
    const request={};
    queueMicrotask(()=>{
      if(state.fail){request.error=Error('blocked');request.onerror?.({});return;}
      let data=databases.get(name);
      if(!data){data=new Map();databases.set(name,data);request.result=database(data);request.onupgradeneeded?.({});}
      request.result=database(data);request.onsuccess?.({});
    });
    return request;
  };
  // The records of the one store, for assertions.
  state.records=()=>databases.get('keyln-app-icons')??new Map();
  return state;
}
