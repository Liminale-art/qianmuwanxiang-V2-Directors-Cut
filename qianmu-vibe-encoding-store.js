import {isStAccountStorageConfigured} from './qianmu-st-account-storage.js';
import {createLocalVibeEncodingStore} from './qianmu-vibe-local-encoding-store.js';
import {createNativeVibeEncodingStore} from './qianmu-vibe-native-encoding-store.js';
export {createLocalVibeEncodingStore} from './qianmu-vibe-local-encoding-store.js';
export {validateVibeEncodingIdentity,validateVibeEncodingReceipt,validateVibeEncodingDelivery,validateVibeServiceDelivery,matchesVibeServiceDelivery,VIBE_ENCODING_RECEIPT_LIMIT,VIBE_ENCODING_ARCHIVE_LIMIT} from './qianmu-vibe-encoding-contract.js';

export function createVibeEncodingStore(options={}){
  const {native,...local}=options,legacy=createLocalVibeEncodingStore(local);
  if(native===false||native===undefined&&(Object.hasOwn(options,'indexedDB')||Object.hasOwn(options,'dbName')||!isStAccountStorageConfigured()))return legacy;
  return createNativeVibeEncodingStore({legacy,...(native&&typeof native==='object'?native:{})});
}
