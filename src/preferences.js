export const AUTO_LOCK_OPTIONS=[5,15,30,60];
export const DEFAULT_AUTO_LOCK_MINUTES=15;
export function normalizePreferences(value){return {autoLockMinutes:AUTO_LOCK_OPTIONS.includes(value?.autoLockMinutes)?value.autoLockMinutes:DEFAULT_AUTO_LOCK_MINUTES};}
export function idleExpired(lastActivity,now,minutes){return now-lastActivity>=normalizePreferences({autoLockMinutes:minutes}).autoLockMinutes*60000;}
export function timeoutLabel(minutes){return minutes===60?'1 hour':minutes+' minutes';}
