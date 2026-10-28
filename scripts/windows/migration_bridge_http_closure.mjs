// Close HTTP admission without cancelling accepted work or disposing Node.
// HTTP closure is never evidence that a disconnected handler has completed.
export function installBridgeHttpClosure({server,fence,token,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}) {
  const marker=Symbol.for('village.currentMigrationProducerFence');
  const httpMarker=Symbol.for('village.currentMigrationHttpClosure');
  if(Object.hasOwn(server,httpMarker))throw Error('HTTP closure already has an owner');
  if(typeof token!=='string'||token.length<8||typeof setIntervalImpl!=='function'
      || typeof clearIntervalImpl!=='function'||server[marker]!==fence||typeof fence.snapshot!=='function') throw Error('Invalid owned HTTP closure contract');
  const address=server.address(),listeners=server.listeners('request');
  if(!server.listening||address?.address!=='127.0.0.1'||!Number.isSafeInteger(address.port)
      || address.port<1||listeners.length!==1)throw Error('Owned loopback HTTP listener required');
  const originalListener=listeners[0];
  let mode='open',httpClosed=false,hold=null,error=null;
  const ownsFence=()=>server[httpMarker]===control && server[marker]===fence && server.listeners('request').length===1
    && server.listeners('request')[0]===originalListener && fence.snapshot().mode==='fenced'
    && fence.snapshot().producers_owned===true;
  const assertOwner=value=>{if(value!==token)throw Error('HTTP closure owner mismatch');};
  const snapshot=()=>({schema:'village-current-bridge-http-closure/v1',mode,http_closed:httpClosed,
    port:address.port,producer_fence_owned:ownsFence(),verification_hold_active:hold!==null && hold.hasRef()===true,
    error,preexisting_work_verified:false,stop_authorized:false,drained:false});
  const control={snapshot,
    begin(value) {
      assertOwner(value);
      if(mode!=='open'||!ownsFence()||!server.listening)throw Error('Owned producer fence required before HTTP close');
      hold=setIntervalImpl(()=>{},1000);
      if(typeof hold?.hasRef!=='function'||!hold.hasRef()) {
        if(hold)clearIntervalImpl(hold);hold=null;throw Error('Referenced verification hold required');
      }
      mode='closing';
      try {
        server.close(failure=>{
          if(failure){error=failure.code||'HTTP_CLOSE_FAILED';mode='close_failed';return;}
          httpClosed=true;mode='closed';
        });
      } catch(failure) {error=failure.code||'HTTP_CLOSE_FAILED';mode='close_failed';throw Error('Owned HTTP close failed; verification hold retained');}
      return snapshot();
    },
    async abort(value) {
      assertOwner(value);
      if(!httpClosed||server.listening||!['closed','reopen_failed'].includes(mode)||!ownsFence())throw Error('Completed owned HTTP close required for reopen');
      if(mode==='reopen_failed' && error!=='EADDRINUSE')throw Error('Uncertain HTTP reopen requires independent readback');
      mode='reopening';
      await new Promise((resolve,reject)=>{
        const cleanup=()=>{server.removeListener('error',onError);server.removeListener('listening',onListening);};
        const onError=failure=>{cleanup();error=failure.code||'HTTP_REOPEN_FAILED';mode='reopen_failed';reject(Error('HTTP reopen failed: '+error));};
        const onListening=()=>{cleanup();resolve();};
        server.once('error',onError);server.once('listening',onListening);
        try {server.listen(address.port,'127.0.0.1');}catch(failure){onError(failure);}
      });
      const current=server.address();
      if(current?.address!=='127.0.0.1'||current.port!==address.port||!ownsFence()) {
        mode='reopen_failed';error='HTTP_REOPEN_OWNER_CHANGED';throw Error('HTTP reopen ownership changed; verification hold retained');
      }
      httpClosed=false;mode='open_fenced';error=null;clearIntervalImpl(hold);hold=null;
      return snapshot();
    },
    release(value) {
      assertOwner(value);
      if(mode!=='open_fenced'||!server.listening||!ownsFence()||hold!==null)throw Error('Verified HTTP reopen required before release');
      delete server[httpMarker];mode='released';return snapshot();
    }
  };
  Object.defineProperty(server,httpMarker,{value:control,configurable:true});
  return control;
}
