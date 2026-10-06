import {readFileSync} from 'node:fs';
import {compareReports} from './verification.mjs';
try{
 if(process.argv.length!==4)throw Error();
 const reports=process.argv.slice(2).map(p=>{const s=readFileSync(p,'utf8');if(s.length>64*1024*1024)throw Error();return JSON.parse(s);});
 const result=compareReports(...reports);console.log(JSON.stringify(result,null,2));
 process.exitCode=result.status==='MATCH'?0:['NOT_COMPARABLE','LEDGER_MATCH_BACKING_NOT_COMPARABLE'].includes(result.status)?2:1;
}catch{console.error('Usage: npm run compare -- first-report.json second-report.json');process.exitCode=1;}
