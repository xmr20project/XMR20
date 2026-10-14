import {XMR20_PRESET,curveParameters,METEORA_PROGRAM,XMR20_MINT} from './preset.js';
export const PLATFORM_FEE_OWNER='5drd6SQcjiY3pYhwpCowahaqsp7ybqQjHQv6Uy3Bp7QE';
export function createLaunchBuilders({web3,token,metadata,sdk,BN,Decimal,hash}){
const pk=s=>new web3.PublicKey(s);
function accounts({owner,mint,creatorNft,platformNft,quoteMint=XMR20_MINT,platformOwner=PLATFORM_FEE_OWNER}){
  const a={owner:pk(owner),mint:pk(mint),creatorNft:pk(creatorNft),platformNft:pk(platformNft),quote:pk(quoteMint),platformOwner:pk(platformOwner)};
  if(new Set(Object.values(a).map(k=>k.toBase58())).size!==6)throw Error('Launch accounts must be distinct.');
  if(!web3.PublicKey.isOnCurve(a.owner.toBytes())||!web3.PublicKey.isOnCurve(a.platformOwner.toBytes()))throw Error('Fee owners must be wallet addresses.');
  a.pool=sdk.deriveCustomizablePoolAddress(a.mint,a.quote);
  a.creatorPosition=sdk.derivePositionAddress(a.creatorNft);a.platformPosition=sdk.derivePositionAddress(a.platformNft);
  a.creatorNftAccount=sdk.derivePositionNftAccount(a.creatorNft);a.platformNftAccount=sdk.derivePositionNftAccount(a.platformNft);
  a.baseVault=sdk.deriveTokenVaultAddress(a.mint,a.pool);a.quoteVault=sdk.deriveTokenVaultAddress(a.quote,a.pool);
  a.ownerBase=token.getAssociatedTokenAddressSync(a.mint,a.owner,false,token.TOKEN_2022_PROGRAM_ID);
  a.ownerQuote=token.getAssociatedTokenAddressSync(a.quote,a.owner,false,token.TOKEN_2022_PROGRAM_ID);
  return a;
}
function encodeInstruction(ix){return {programId:ix.programId.toBase58(),keys:ix.keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable})),data:Buffer.from(ix.data).toString('base64')};}
function planHash(ixs){return hash?.(JSON.stringify(ixs.map(encodeInstruction)))||null;}
function priceBounds(){
  const p=curveParameters(),decimal=r=>new Decimal(r.numerator.toString()).div(r.denominator.toString()).toFixed(40);
  return {sqrtMinPrice:sdk.getSqrtPriceFromPrice(decimal(p.initialPrice),6,6),sqrtMaxPrice:sdk.getSqrtPriceFromPrice(decimal(p.maxPrice),6,6)};
}
function mintInstructions(ids,{name,symbol,uri,rentLamports}){
  const a=accounts(ids),program=token.TOKEN_2022_PROGRAM_ID;
  if(typeof name!=='string'||!name.trim()||Buffer.byteLength(name)>32||!/^[A-Z][A-Z0-9]{0,9}$/.test(symbol)||typeof uri!=='string'||uri.length>200||!uri.startsWith('https://'))throw Error('Invalid token metadata.');
  const meta={mint:a.mint,name,symbol,uri,additionalMetadata:[],updateAuthority:a.owner};
  const space=token.getMintLen([token.ExtensionType.MetadataPointer]);
  const rentSize=space+token.TYPE_SIZE+token.LENGTH_SIZE+metadata.pack(meta).length;
  if(!Number.isSafeInteger(rentLamports)||rentLamports<=0||rentLamports>20_000_000)throw Error('Mint rent exceeds the reviewed limit.');
  const ixs=[web3.SystemProgram.createAccount({fromPubkey:a.owner,newAccountPubkey:a.mint,lamports:rentLamports,space,programId:program}),
    token.createInitializeMetadataPointerInstruction(a.mint,null,a.mint,program),token.createInitializeMint2Instruction(a.mint,6,a.owner,null,program),
    metadata.createInitializeInstruction({programId:program,metadata:a.mint,updateAuthority:a.owner,mint:a.mint,mintAuthority:a.owner,name,symbol,uri}),
    metadata.createUpdateAuthorityInstruction({programId:program,metadata:a.mint,oldAuthority:a.owner,newAuthority:null}),
    token.createAssociatedTokenAccountIdempotentInstruction(a.owner,a.ownerBase,a.owner,a.mint,program),
    token.createMintToInstruction(a.mint,a.ownerBase,a.owner,BigInt(XMR20_PRESET.supplyRaw),[],program),
    token.createSetAuthorityInstruction(a.mint,a.owner,token.AuthorityType.MintTokens,null,[],program)];
  return {instructions:ixs,rentSize,hash:planHash(ixs)};
}
// Pool creation, the permanent lock, fee split and platform custody transfer
// must be one atomic transaction. A partial split is never a launched token.
async function poolInstructions(cp,ids){
  if(sdk.CP_AMM_PROGRAM_ID.toBase58()!==METEORA_PROGRAM)throw Error('Wrong Meteora program.');
  const a=accounts(ids),{sqrtMinPrice,sqrtMaxPrice}=priceBounds();
  const liquidityDelta=cp.preparePoolCreationSingleSide({tokenAAmount:new BN(XMR20_PRESET.supplyRaw),minSqrtPrice:sqrtMinPrice,maxSqrtPrice:sqrtMaxPrice,initSqrtPrice:sqrtMinPrice,collectFeeMode:sdk.CollectFeeMode.OnlyB});
  const poolFees={baseFee:sdk.getBaseFeeParams({baseFeeMode:sdk.BaseFeeMode.FeeTimeSchedulerLinear,feeTimeSchedulerParam:{startingFeeBps:100,endingFeeBps:100,numberOfPeriod:0,totalDuration:0}}),compoundingFeeBps:0,padding:0,dynamicFee:null};
  const created=await cp.createCustomPool({payer:a.owner,creator:a.owner,positionNft:a.creatorNft,tokenAMint:a.mint,tokenBMint:a.quote,
    tokenAAmount:new BN(XMR20_PRESET.supplyRaw),tokenBAmount:new BN(0),sqrtMinPrice,sqrtMaxPrice,initSqrtPrice:sqrtMinPrice,liquidityDelta,poolFees,
    hasAlphaVault:false,activationType:sdk.ActivationType.Timestamp,activationPoint:null,collectFeeMode:sdk.CollectFeeMode.OnlyB,
    tokenAProgram:token.TOKEN_2022_PROGRAM_ID,tokenBProgram:token.TOKEN_2022_PROGRAM_ID,isLockLiquidity:true});
  const second=await cp.createPosition({owner:a.owner,payer:a.owner,pool:a.pool,positionNft:a.platformNft});
  const split=await cp.splitPosition({firstPositionOwner:a.owner,secondPositionOwner:a.owner,pool:a.pool,
    firstPosition:a.creatorPosition,firstPositionNftAccount:a.creatorNftAccount,secondPosition:a.platformPosition,secondPositionNftAccount:a.platformNftAccount,
    permanentLockedLiquidityPercentage:50,unlockedLiquidityPercentage:0,feeAPercentage:50,feeBPercentage:50,reward0Percentage:50,reward1Percentage:50,innerVestingLiquidityPercentage:0});
  const transfer=token.createSetAuthorityInstruction(a.platformNftAccount,a.owner,token.AuthorityType.AccountOwner,a.platformOwner,[],token.TOKEN_2022_PROGRAM_ID);
  const instructions=[...created.tx.instructions,...second.instructions,...split.instructions,transfer];
  return {instructions,liquidityDelta,hash:planHash(instructions),accounts:a};
}
function compilePlan({owner,blockhash,instructions,lookupTables=[],priorityMicroLamports}){
  const tx=new web3.VersionedTransaction(new web3.TransactionMessage({payerKey:pk(owner),recentBlockhash:blockhash,instructions:[web3.ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),...(priorityMicroLamports===undefined?[]:[web3.ComputeBudgetProgram.setComputeUnitPrice({microLamports:priorityMicroLamports})]),...instructions]}).compileToV0Message(lookupTables));
  let bytes;try{bytes=tx.serialize();}catch{throw Error('A confirmed lookup table is required for this launch.');}
  if(bytes.length>1232)throw Error('A confirmed lookup table is required for this launch.');
  return tx;
}

return {accounts,encodeInstruction,planHash,priceBounds,mintInstructions,poolInstructions,compilePlan};
}
