// A known unavailable launch catalog should pause new launches, not disconnect
// account/receipt recovery. The backend still checks readiness before reserve,
// preparation and broadcast. This never grants permission to sign or submit.
export function launchAvailability(catalog){
 if(!catalog||typeof catalog.enabled!=='boolean'||catalog.network!=='mainnet-beta'||catalog.oneApprovalEnabled!==true)throw Error('LAUNCH_UNAVAILABLE');
 return catalog.enabled;
}
