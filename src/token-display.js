// Exact mint identities from LaunchLab. Bundled images need no remote image host.
const images=Object.freeze({
 'Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR':'icons/tokens/xmr20.png',
 '8zWcEgUZvQKcHgtUoYTnaC6AHX7FmtWVV9WeM4kPuXMR':'icons/tokens/covert.png'
});
export const tokenImage=mint=>Object.hasOwn(images,mint)?images[mint]:null;
export function tokenGroups(rows){return [['monero','XMR20'],['solana','SOLANA']].map(([network,title])=>({network,title,items:rows.map((row,index)=>({row,index})).filter(({row})=>row.network===network)})).filter(group=>group.items.length);}
