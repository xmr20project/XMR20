import {transferableManifest,universalTransferableManifest} from '../bridge/core-transferable/mainnet-config.mjs';
// Default remains legacy. Only the coordinated release build may select this pin.
export const universalLinkEnabled=typeof __XMR20_UNIVERSAL_LINK__!=='undefined'&&__XMR20_UNIVERSAL_LINK__;
export const walletManifest=universalLinkEnabled?universalTransferableManifest:transferableManifest;
