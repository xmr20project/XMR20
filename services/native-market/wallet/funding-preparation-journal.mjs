// Private conversion preparation storage. The surrounding signature journal
// supplies its one database, wallet scope, encryption and strict transactions.
// No signing, network I/O or automatic expiry. The fixed private verifier may
// retire unused stage holds after canonical completion; signatures stay held.
const enc = new TextEncoder(), dec = new TextDecoder();
const need = (ok, text) => { if (!ok) throw Error(text); };
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const exact = (value, keys) => need(value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'Unexpected funding preparation fields');
const roles = ['issuance', 'publication', 'recovery'];
const steps = ['holder-authorization', 'cancellation-authorization', 'custody-authorization'];
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const bounded = (bytes, limit) => need(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= limit, 'Bounded preparation bytes required');
const boxSize = (row, field, limit) => bounded(row?.[field]?.data, limit + 16);

export function createFundingPreparations({db, wallet, scopeHash, active, hash, encrypt, decrypt, transaction}) {
  function binding(value) {
    exact(value, ['scope', 'operationId', 'checkpoint', 'funding', 'payloadHash', ...(value.purpose ? ['purpose'] : [])]);
    exact(value.scope, ['address', 'genesis']);
    need(value.scope.address === wallet.address && value.scope.genesis === wallet.genesis, 'Funding preparation wallet changed');
    need(digest(value.operationId) && digest(value.payloadHash), 'Invalid funding preparation identity');
    exact(value.checkpoint, ['height', 'hash']);
    need(Number.isSafeInteger(value.checkpoint.height) && value.checkpoint.height >= 0 && digest(value.checkpoint.hash), 'Invalid preparation checkpoint');
    let purpose;
    if (value.purpose?.kind === 'operator-credit') {
      exact(value.purpose, ['kind', 'manifest']);need(digest(value.purpose.manifest),'Pinned operator manifest required');
      purpose = {...value.purpose};
    } else if (value.purpose) {
      exact(value.purpose, ['kind', 'parentId', 'conversionId']);
      need(value.purpose.kind === 'cancellation-retry' && digest(value.purpose.conversionId), 'Unknown recovery preparation purpose');
      identifier(value.purpose.parentId);
      need(value.purpose.parentId === scopeHash + ':preparation:' + value.purpose.conversionId && value.operationId !== value.purpose.conversionId, 'Recovery must reference its original conversion');
      purpose = {...value.purpose};
    }
    const expectedRoles = purpose?.kind === 'operator-credit' ? ['issuance'] : purpose ? ['recovery'] : roles;
    need(Array.isArray(value.funding) && value.funding.length === expectedRoles.length, 'Reserve complete conversion or recovery funding');
    const images = new Set();
    const funding = expectedRoles.map(role => {
      const row = value.funding.find(row => row?.role === role);
      exact(row, ['role', 'keyImages']);
      need(Array.isArray(row.keyImages) && row.keyImages.length > 0 && row.keyImages.length <= 16 && row.keyImages.every(digest), 'Invalid reserved funding inputs');
      const keyImages = [...row.keyImages].sort();
      for (const image of keyImages) { need(!images.has(image), 'Conversion stages must use separate funding'); images.add(image); }
      return {role, keyImages};
    });
    return {scope: {...wallet}, operationId: value.operationId, checkpoint: {...value.checkpoint}, funding, payloadHash: value.payloadHash, ...(purpose ? {purpose} : {})};
  }
  const identifier = id => need(typeof id === 'string' && id.startsWith(scopeHash + ':preparation:') && digest(id.slice(scopeHash.length + 13)), 'Wrong preparation scope');
  const allImages = b => b.funding.flatMap(row => row.keyImages);
  async function authenticate(row) {
    need(row?.scopeHash === scopeHash, 'Funding preparation missing'); identifier(row.id);
    let body, payload;
    try {
      boxSize(row, 'preparation', 16384); boxSize(row, 'payload', 256 * 1024);
      body = await decrypt(row, 'preparation');
      const b = binding(JSON.parse(dec.decode(body)));
      need(await hash(enc.encode(JSON.stringify(b))) === row.approvalHash &&
        row.id === scopeHash + ':preparation:' + b.operationId, 'Funding preparation bindings changed');
      let completion=null;
      if(row.completion){
        boxSize(row,'completion',8192);const data=await decrypt(row,'completion');
        try{completion=JSON.parse(dec.decode(data));exact(completion,['evidence','released']);validateCompletion(completion.evidence,b);need(Array.isArray(completion.released)&&new Set(completion.released).size===completion.released.length&&completion.released.every(r=>b.funding.some(p=>p.role===r)),'Invalid released preparation stages');}finally{data.fill(0);}
      }
      const held=b.funding.filter(part=>!completion?.released.includes(part.role)).flatMap(part=>part.keyImages);
      need(JSON.stringify(row.inputs)===JSON.stringify(held.map(image=>scopeHash+':'+image)),'Funding preparation input index changed');
      payload = await decrypt(row, 'payload'); bounded(payload, 256 * 1024);
      need(await hash(payload) === b.payloadHash, 'Funding preparation payload changed');
      active(); return {row, binding: b, payload, completion};
    } catch (error) { payload?.fill(0); throw error; }
    finally { body?.fill(0); }
  }
  async function read(id) {
    active(); identifier(id);
    const row = await transaction(db, 'readonly', ({get, done}) => get('preparations', id, done), ['preparations']);
    const saved = await authenticate(row);
    try {
      // Each complete stage is held either by this preparation or by exactly
      // one native signature reservation. Splitting a stage is never valid.
      const claims = await transaction(db, 'readonly', ({get, done}) => {
        const held=saved.binding.funding.filter(part=>!saved.completion?.released.includes(part.role));
        let remaining = held.reduce((n,p)=>n+p.keyImages.length,0); const byRole = new Map((saved.completion?.released??[]).map(role=>[role,null]));
        if(!remaining){done(byRole);return;}
        for (const part of held) for (const image of part.keyImages) get('locks', scopeHash + ':' + image, lock => {
          need(lock?.recordId, 'Preparation funding lock is missing');
          const owner = byRole.get(part.role);
          need(!owner || owner === lock.recordId, 'Preparation funding stage was split'); byRole.set(part.role, lock.recordId);
          if (--remaining === 0) done(byRole);
        });
      }, ['locks']);
      for (const part of saved.binding.funding) {
        const owner = claims.get(part.role); if (owner === id || owner===null) continue;
        const native = await transaction(db, 'readonly', ({get, done}) => get('records', owner, done), ['records']);
        need(native?.scopeHash === scopeHash && ['reserved', 'signed'].includes(native.state), 'Preparation signature claim is missing');
        boxSize(native, 'funding', 1024);
        const bytes = await decrypt(native, 'funding');
        try {
          const link = JSON.parse(dec.decode(bytes));
          need(JSON.stringify(link) === JSON.stringify({preparationId: id, approvalHash: row.approvalHash, role: part.role}) &&
            JSON.stringify(native.keyImages) === JSON.stringify(part.keyImages), 'Preparation signature claim changed');
        } finally { bytes.fill(0); }
      }
      active(); return {...saved, claims};
    } catch (error) { saved.payload.fill(0); throw error; }
  }
  async function list() {
    active();
    const ids = await transaction(db, 'readonly', ({tx, done}) => {
      const ids = [], request = tx.objectStore('preparations').openCursor();
      request.onsuccess = () => { const c = request.result; if (!c) { done(ids); return; }
        if (typeof c.key === 'string' && c.key.startsWith(scopeHash + ':preparation:')) ids.push(c.key); c.continue(); };
    }, ['preparations']);
    const rows = [];
    try { for (const id of ids) rows.push(await read(id)); return rows; }
    catch (error) { for (const row of rows) row.payload.fill(0); throw error; }
  }
  function validateCompletion(value,b){
    if(b.purpose?.kind==='operator-credit'){
      exact(value,['operationId','status','receipt','checkpoint']);exact(value.checkpoint,['height','hash']);
      need(value.operationId===b.operationId&&value.status==='refunded'&&typeof value.receipt==='string'&&
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.receipt)&&Number.isSafeInteger(value.checkpoint.height)&&
        value.checkpoint.height>=b.checkpoint.height&&digest(value.checkpoint.hash),'Verified custody refund completion required');
      return;
    }
    exact(value,['operationId','status','conversionTxid','resolutionTxid','checkpoint']);exact(value.checkpoint,['height','hash']);
    need(value.operationId===(b.purpose?.conversionId??b.operationId)&&['issued','cancelled'].includes(value.status)&&digest(value.conversionTxid)&&digest(value.resolutionTxid)&&
      Number.isSafeInteger(value.checkpoint.height)&&value.checkpoint.height>=b.checkpoint.height&&digest(value.checkpoint.hash),'Canonical preparation completion required');
  }
  return Object.freeze({read, list,
    async complete({preparationId,evidence}){
      const saved=await read(preparationId);let data;
      try{
        validateCompletion(evidence,saved.binding);
        if(saved.completion){need(JSON.stringify(saved.completion.evidence)===JSON.stringify(evidence),'Preparation completion is immutable');return saved.completion;}
        const completion={evidence,released:saved.binding.funding.map(p=>p.role).filter(role=>saved.claims.get(role)===preparationId)};
        data=enc.encode(JSON.stringify(completion));const box=await encrypt(saved.row.id,saved.row.approvalHash,'completion',data);active();
        const held=saved.binding.funding.filter(p=>!completion.released.includes(p.role)).flatMap(p=>p.keyImages.map(image=>scopeHash+':'+image));
        await transaction(db,'readwrite',({tx,get,done})=>get('preparations',preparationId,row=>{
          need(row?.approvalHash===saved.row.approvalHash&&!row.completion,'Preparation changed during completion');
          const release=saved.binding.funding.filter(p=>completion.released.includes(p.role)).flatMap(p=>p.keyImages);let remaining=release.length;
          const finish=()=>{tx.objectStore('preparations').put({...row,inputs:held,completion:box});done();};
          if(!remaining){finish();return;}
          for(const image of release)get('locks',scopeHash+':'+image,lock=>{
            need(lock?.recordId===preparationId,'Preparation stage was claimed during completion');
            tx.objectStore('locks').delete(scopeHash+':'+image);if(--remaining===0)finish();
          });
        }),['preparations','locks']);
        active();return completion;
      }finally{saved.payload.fill(0);data?.fill(0);}
    },
    async prepare(value) {
      active(); exact(value, ['operationId', 'checkpoint', 'funding', 'payload', ...(value.purpose ? ['purpose'] : [])]); bounded(value.payload, 256 * 1024);
      const payload = value.payload.slice(); let body;
      try {
        const b = binding({scope: wallet, operationId: value.operationId, checkpoint: value.checkpoint,
          funding: value.funding, payloadHash: await hash(payload), ...(value.purpose ? {purpose: value.purpose} : {})});
        let parent;
        if (b.purpose?.kind === 'cancellation-retry') {
          const saved = await read(b.purpose.parentId);
          try { need(!saved.binding.purpose && !saved.completion && saved.row['cancellation-authorization'], 'Original cancellation authorization required'); parent = saved.row; }
          finally { saved.payload.fill(0); }
        }
        body = enc.encode(JSON.stringify(b)); const approvalHash = await hash(body), id = scopeHash + ':preparation:' + b.operationId;
        const row = {id, scopeHash, approvalHash, inputs: allImages(b).map(image => scopeHash + ':' + image),
          preparation: await encrypt(id, approvalHash, 'preparation', body), payload: await encrypt(id, approvalHash, 'payload', payload)};
        active();
        await transaction(db, 'readwrite', ({tx, get, done}) => get('preparations', id, existing => {
          if (existing) { need(existing.approvalHash === approvalHash, 'Conversion preparation is immutable'); done(); return; }
          const reserve = () => { let remaining = row.inputs.length;
          for (const input of row.inputs) get('locks', input, lock => {
            need(!lock, 'Conversion funding already reserved');
            get('recipients', input, recipient => {
              need(!recipient, 'Pending token recipient cannot fund a conversion');
              const request = tx.objectStore('records').index('inputs').get(input);
              request.onsuccess = () => {
                if (request.result) { tx.abort(); return; }
                if (--remaining !== 0) return;
                tx.objectStore('preparations').add(row);
                for (const id of row.inputs) tx.objectStore('locks').add({id, recordId: row.id}); done();
              };
            });
          });
          };
          if (parent) get('preparations', parent.id, current => {
            need(current?.approvalHash === parent.approvalHash && !current.completion && current['cancellation-authorization'], 'Original conversion changed before recovery funding'); reserve();
          }); else reserve();
        }), ['preparations', 'records', 'locks', 'recipients']);
        const restored = await read(id);
        try { need(same(restored.payload, payload), 'Preparation payload is immutable'); return {preparationId: id}; }
        finally { restored.payload.fill(0); }
      } finally { body?.fill(0); payload.fill(0); }
    },
    async saveStep({preparationId, step, bytes}) {
      need(steps.includes(step), 'Unknown conversion preparation step'); bounded(bytes, 16 * 1024);
      const copy = bytes.slice(), prior = await read(preparationId); let restored;
      try {
        need(!prior.completion,'Conversion preparation is complete');
        need(prior.binding.purpose?.kind==='operator-credit'?step==='custody-authorization':step!=='custody-authorization','Authorization belongs to another preparation protocol');
        const box = await encrypt(prior.row.id, prior.row.approvalHash, step, copy); active();
        const saved = await transaction(db, 'readwrite', ({tx, get, done}) => get('preparations', preparationId, row => {
          need(row?.approvalHash === prior.row.approvalHash && !row.completion, 'Preparation changed before authorization save');
          if (Object.hasOwn(row, step)) done(row);
          else { const next = {...row, [step]: box}; tx.objectStore('preparations').put(next); done(next); }
        }), ['preparations']);
        boxSize(saved, step, 16 * 1024);
        restored = await decrypt(saved, step); need(same(restored, copy), 'Saved conversion authorization is immutable'); active();
      } finally { prior.payload.fill(0); copy.fill(0); restored?.fill(0); }
    },
    async recover(id) {
      const saved = await read(id), authorizations = {};
      try {
        for (const step of steps) if (Object.hasOwn(saved.row, step)) { boxSize(saved.row, step, 16 * 1024); const bytes = await decrypt(saved.row, step); authorizations[step] = bytes; bounded(bytes, 16 * 1024); }
        active(); return {preparationId: id, binding: saved.binding, payload: saved.payload,
          claims: Object.fromEntries(saved.claims), authorizations,completion:saved.completion};
      } catch (error) { saved.payload.fill(0); for (const bytes of Object.values(authorizations)) bytes.fill(0); throw error; }
    }
  });
}
