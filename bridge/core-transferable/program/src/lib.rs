//! ABI 3 local candidate: pooled backing with user-owned balances.
//! No administrator withdrawal, ownership replacement or Monero consensus.
//! Registration, transfers and releases require owner AND verifier approval.
use solana_program::{account_info::{next_account_info,AccountInfo},entrypoint,entrypoint::ProgramResult,program::{invoke,invoke_signed},program_error::ProgramError,pubkey::Pubkey,rent::Rent,system_instruction,system_program,sysvar::Sysvar,program_option::COption,clock::Clock};
use spl_token_2022::extension::{BaseStateWithExtensions,StateWithExtensions,ExtensionType,transfer_fee::TransferFeeConfig};
entrypoint!(process_instruction);
const POSITION:usize=169;const POOL:usize=105;const LINK:usize=129;const RECEIPT:usize=153;
const LIMIT:u64=50_000_000_000_000;const SUPPLY:u64=1_000_000_000_000_000;
fn bad()->ProgramError{ProgramError::InvalidArgument}
fn require(ok:bool)->ProgramResult{if ok{Ok(())}else{Err(bad())}}
fn key(d:&[u8],n:usize)->Pubkey{Pubkey::new_from_array(d[n..n+32].try_into().unwrap())}
fn num(d:&[u8],n:usize)->u64{u64::from_le_bytes(d[n..n+8].try_into().unwrap())}
fn nonzero(d:&[u8])->bool{d.iter().any(|v|*v!=0)}
fn mint_check(m:&AccountInfo,t:&AccountInfo)->ProgramResult{
 require(*t.key==spl_token_2022::id()&&t.executable&&m.owner==t.key)?;
 let b=m.try_borrow_data()?;let a=StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&b)?;
 require(a.base.decimals==6&&a.base.supply>0&&a.base.supply<=SUPPLY&&a.base.mint_authority==COption::None&&a.base.freeze_authority==COption::None)?;
 for e in a.get_extension_types()?{require(matches!(e,ExtensionType::TransferFeeConfig|ExtensionType::MetadataPointer|ExtensionType::TokenMetadata))?;}
 Ok(())
}
fn balance(a:&AccountInfo,m:&Pubkey,o:&Pubkey,t:&AccountInfo)->Result<u64,ProgramError>{
 require(a.owner==t.key)?;let b=a.try_borrow_data()?;let a=StateWithExtensions::<spl_token_2022::state::Account>::unpack(&b)?;
 for e in a.get_extension_types()?{require(matches!(e,ExtensionType::ImmutableOwner|ExtensionType::TransferFeeAmount))?;}
 require(a.base.mint==*m&&a.base.owner==*o&&a.base.delegate==COption::None&&a.base.close_authority==COption::None&&a.base.state==spl_token_2022::state::AccountState::Initialized)?;Ok(a.base.amount)
}
fn create<'a>(payer:&AccountInfo<'a>,a:&AccountInfo<'a>,s:&AccountInfo<'a>,p:&Pubkey,len:usize,seeds:&[&[u8]])->ProgramResult{
 require(payer.is_signer&&payer.is_writable&&a.is_writable&&*s.key==system_program::id()&&s.executable&&a.owner==&system_program::id()&&a.data_is_empty())?;
 let top=Rent::get()?.minimum_balance(len).saturating_sub(a.lamports());
 if top>0{invoke(&system_instruction::transfer(payer.key,a.key,top),&[payer.clone(),a.clone(),s.clone()])?;}
 invoke_signed(&system_instruction::allocate(a.key,len as u64),&[a.clone(),s.clone()],&[seeds])?;
 invoke_signed(&system_instruction::assign(a.key,p),&[a.clone(),s.clone()],&[seeds])
}
fn position(a:&AccountInfo,p:&Pubkey,mint:&Pubkey)->Result<(Pubkey,Pubkey,u64),ProgramError>{
 require(a.owner==p&&a.data_len()==POSITION)?;let b=a.try_borrow_data()?;
 let owner=key(&b,1);let verifier=key(&b,33);
 let expected=Pubkey::find_program_address(&[b"joint-v3-position",mint.as_ref(),verifier.as_ref(),owner.as_ref()],p).0;
 require(b[0]==3&&key(&b,65)==*mint&&*a.key==expected&&owner!=verifier&&verifier!=Pubkey::default()&&nonzero(&b[97..129])&&nonzero(&b[129..161]))?;
 Ok((owner,verifier,num(&b,161)))
}
fn pool(a:&AccountInfo,p:&Pubkey,mint:&Pubkey,verifier:&Pubkey,vault:&AccountInfo)->Result<(u64,u8),ProgramError>{
 let (expected,bump)=Pubkey::find_program_address(&[b"joint-v3-pool",mint.as_ref(),verifier.as_ref()],p);
 require(*a.key==expected&&a.owner==p&&a.data_len()==POOL)?;let b=a.try_borrow_data()?;
 require(b[0]==3&&key(&b,1)==*mint&&key(&b,33)==*verifier&&key(&b,65)==*vault.key&&*vault.key==spl_associated_token_account::get_associated_token_address_with_program_id(a.key,mint,&spl_token_2022::id()))?;
 Ok((num(&b,97),bump))
}
fn transfer<'a>(from:&AccountInfo<'a>,m:&AccountInfo<'a>,to:&AccountInfo<'a>,auth:&AccountInfo<'a>,t:&AccountInfo<'a>,n:u64,fee:u64,seeds:Option<&[&[u8]]>)->ProgramResult{
 let b=m.try_borrow_data()?;let a=StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&b)?;
 let taxed=a.get_extension_types()?.contains(&ExtensionType::TransferFeeConfig);
 let actual=if taxed{a.get_extension::<TransferFeeConfig>()?.calculate_epoch_fee(Clock::get()?.epoch,n).ok_or(bad())?}else{0};
 require(n>actual&&fee==actual)?;drop(b);
 let ix=if taxed{spl_token_2022::extension::transfer_fee::instruction::transfer_checked_with_fee(t.key,from.key,m.key,to.key,auth.key,&[],n,6,fee)?}else{spl_token_2022::instruction::transfer_checked(t.key,from.key,m.key,to.key,auth.key,&[],n,6)?};
 let accounts=[from.clone(),m.clone(),to.clone(),auth.clone(),t.clone()];
 if let Some(s)=seeds{invoke_signed(&ix,&accounts,&[s])}else{invoke(&ix,&accounts)}
}
fn receipt<'a>(payer:&AccountInfo<'a>,r:&AccountInfo<'a>,system:&AccountInfo<'a>,program:&Pubkey,pos:&Pubkey,d:&[u8],from:&Pubkey,to:&Pubkey,net:u64,fee:u64)->ProgramResult{
 let nonce=&d[9..41];let (expected,bump)=Pubkey::find_program_address(&[b"joint-v3-receipt",pos.as_ref(),nonce],program);
 require(*r.key==expected)?;create(payer,r,system,program,RECEIPT,&[b"joint-v3-receipt",pos.as_ref(),nonce,&[bump]])?;
 let mut b=r.try_borrow_mut_data()?;b[0]=d[0];b[1..33].copy_from_slice(from.as_ref());b[33..65].copy_from_slice(to.as_ref());b[65..97].copy_from_slice(nonce);b[97..129].copy_from_slice(&d[41..73]);b[129..137].copy_from_slice(&d[1..9]);b[137..145].copy_from_slice(&net.to_le_bytes());b[145..153].copy_from_slice(&fee.to_le_bytes());Ok(())
}
pub fn process_instruction(p:&Pubkey,accounts:&[AccountInfo],d:&[u8])->ProgramResult{
 require(!d.is_empty())?;
 if d[0]==1{
  require(d.len()==65&&nonzero(&d[1..33])&&nonzero(&d[33..65]))?;
  let mut it=accounts.iter();let owner=next_account_info(&mut it)?;let verifier=next_account_info(&mut it)?;let pos=next_account_info(&mut it)?;let link=next_account_info(&mut it)?;let pool_account=next_account_info(&mut it)?;let mint=next_account_info(&mut it)?;let vault=next_account_info(&mut it)?;let token=next_account_info(&mut it)?;let system=next_account_info(&mut it)?;
  require(it.next().is_none()&&owner.is_signer&&owner.is_writable&&verifier.is_signer&&owner.key!=verifier.key&&*verifier.key!=Pubkey::default())?;mint_check(mint,token)?;
  let (pa,pb)=Pubkey::find_program_address(&[b"joint-v3-pool",mint.key.as_ref(),verifier.key.as_ref()],p);
  require(*pool_account.key==pa&&*vault.key==spl_associated_token_account::get_associated_token_address_with_program_id(&pa,mint.key,token.key))?;
  let available=balance(vault,mint.key,&pa,token)?;
  if pool_account.data_is_empty(){
   create(owner,pool_account,system,p,POOL,&[b"joint-v3-pool",mint.key.as_ref(),verifier.key.as_ref(),&[pb]])?;
   let mut b=pool_account.try_borrow_mut_data()?;b[0]=3;b[1..33].copy_from_slice(mint.key.as_ref());b[33..65].copy_from_slice(verifier.key.as_ref());b[65..97].copy_from_slice(vault.key.as_ref());b[97..105].copy_from_slice(&0u64.to_le_bytes());
  }
  let (locked,_)=pool(pool_account,p,mint.key,verifier.key,vault)?;require(available>=locked)?;
  let (position_key,position_bump)=Pubkey::find_program_address(&[b"joint-v3-position",mint.key.as_ref(),verifier.key.as_ref(),owner.key.as_ref()],p);
  let (link_key,link_bump)=Pubkey::find_program_address(&[b"joint-v3-link",mint.key.as_ref(),verifier.key.as_ref(),&d[1..33]],p);
  require(*pos.key==position_key&&*link.key==link_key)?;
  create(owner,pos,system,p,POSITION,&[b"joint-v3-position",mint.key.as_ref(),verifier.key.as_ref(),owner.key.as_ref(),&[position_bump]])?;
  create(owner,link,system,p,LINK,&[b"joint-v3-link",mint.key.as_ref(),verifier.key.as_ref(),&d[1..33],&[link_bump]])?;
  let mut b=pos.try_borrow_mut_data()?;b[0]=3;b[1..33].copy_from_slice(owner.key.as_ref());b[33..65].copy_from_slice(verifier.key.as_ref());b[65..97].copy_from_slice(mint.key.as_ref());b[97..129].copy_from_slice(&d[1..33]);b[129..161].copy_from_slice(&d[33..65]);b[161..169].copy_from_slice(&0u64.to_le_bytes());drop(b);
  let mut b=link.try_borrow_mut_data()?;b[0]=3;b[1..33].copy_from_slice(&d[1..33]);b[33..65].copy_from_slice(owner.key.as_ref());b[65..97].copy_from_slice(pos.key.as_ref());b[97..129].copy_from_slice(&d[33..65]);return Ok(());
 }
 require(matches!(d[0],2|3|4|5)&&d.len()==if d[0]==4{73}else{81}&&nonzero(&d[9..41])&&nonzero(&d[41..73]))?;
 let n=num(d,1);require(n>0&&n<=LIMIT)?;
 let mut it=accounts.iter();let actor=next_account_info(&mut it)?;let pos=next_account_info(&mut it)?;let pool_account=next_account_info(&mut it)?;let mint=next_account_info(&mut it)?;let vault=next_account_info(&mut it)?;let token=next_account_info(&mut it)?;let system=next_account_info(&mut it)?;let ata=next_account_info(&mut it)?;let r=next_account_info(&mut it)?;
 require(actor.is_signer&&actor.is_writable&&pos.is_writable&&pool_account.is_writable&&vault.is_writable&&ata.is_writable)?;mint_check(mint,token)?;
 let (owner,verifier,holding)=position(pos,p,mint.key)?;let (locked,bump)=pool(pool_account,p,mint.key,&verifier,vault)?;
 let before=balance(vault,mint.key,pool_account.key,token)?;require(before>=locked)?;
 require(*ata.key==spl_associated_token_account::get_associated_token_address_with_program_id(actor.key,mint.key,token.key))?;
 let actor_before=balance(ata,mint.key,actor.key,token)?;
 if d[0]==2||d[0]==5{
  require(it.next().is_none()&&(d[0]==5||*actor.key==owner))?;let fee=num(d,73);require(n>fee&&actor_before>=n)?;let net=n-fee;
  // A gift needs no recipient signature, so its credit must be reconstructible
  // from public state. A donor cannot install an arbitrary unusable commitment.
  let credit_hash=solana_program::hash::hashv(&[b"XMR20-JOINT-CREDIT-V3\n",p.as_ref(),mint.key.as_ref(),pos.key.as_ref(),actor.key.as_ref(),&d[9..41],&net.to_le_bytes()]);
  require(credit_hash.as_ref()==&d[41..73])?;
  receipt(actor,r,system,p,pos.key,d,actor.key,pos.key,net,fee)?;
  transfer(ata,mint,vault,actor,token,n,fee,None)?;
  require(balance(vault,mint.key,pool_account.key,token)?==before.checked_add(net).ok_or(bad())?&&balance(ata,mint.key,actor.key,token)?==actor_before-n)?;
  let next=locked.checked_add(net).ok_or(bad())?;require(next<=SUPPLY)?;
  pool_account.try_borrow_mut_data()?[97..105].copy_from_slice(&next.to_le_bytes());pos.try_borrow_mut_data()?[161..169].copy_from_slice(&holding.checked_add(net).ok_or(bad())?.to_le_bytes());return Ok(());
 }
 let signer=next_account_info(&mut it)?;require(*actor.key==owner&&signer.is_signer&&*signer.key==verifier&&holding>=n&&locked>=n)?;
 if d[0]==4{
  let dest=next_account_info(&mut it)?;require(it.next().is_none()&&dest.is_writable&&dest.key!=pos.key)?;
  let (_,dest_verifier,dest_balance)=position(dest,p,mint.key)?;require(dest_verifier==verifier)?;
  receipt(actor,r,system,p,pos.key,d,pos.key,dest.key,n,0)?;
  pos.try_borrow_mut_data()?[161..169].copy_from_slice(&(holding-n).to_le_bytes());dest.try_borrow_mut_data()?[161..169].copy_from_slice(&dest_balance.checked_add(n).ok_or(bad())?.to_le_bytes());return Ok(());
 }
 require(it.next().is_none())?;let fee=num(d,73);require(n>fee)?;let net=n-fee;
 receipt(actor,r,system,p,pos.key,d,pos.key,actor.key,net,fee)?;
 let seeds:&[&[u8]]=&[b"joint-v3-pool",mint.key.as_ref(),verifier.as_ref(),&[bump]];transfer(vault,mint,ata,pool_account,token,n,fee,Some(seeds))?;
 require(balance(vault,mint.key,pool_account.key,token)?==before-n&&balance(ata,mint.key,actor.key,token)?==actor_before.checked_add(net).ok_or(bad())?)?;
 pool_account.try_borrow_mut_data()?[97..105].copy_from_slice(&(locked-n).to_le_bytes());pos.try_borrow_mut_data()?[161..169].copy_from_slice(&(holding-n).to_le_bytes());Ok(())
}
