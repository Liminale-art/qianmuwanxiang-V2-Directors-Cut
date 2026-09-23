import {CHAT_GALLERY_RECEIPT_LIMITS,chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';

// Match the chat-gallery collection count and metadata budgets, not the media
// budget. A whole storyboard package still supports at most 400 image records.
export const GALLERY_PACKAGE_COLLECTION_LIMIT=CHAT_GALLERY_RECEIPT_LIMITS.records;
export function assertGalleryPackageCollections(rows=[]){
  if(!Array.isArray(rows)||rows.length>GALLERY_PACKAGE_COLLECTION_LIMIT)throw Error(`阅片室合集超过 ${GALLERY_PACKAGE_COLLECTION_LIMIT} 项或不是列表，未裁剪资料`);
  const seen=new Set();
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string'||!row.id.trim()||row.id.length>160||/[\u0000-\u001f\u007f]/.test(row.id)||seen.has(row.id))throw Error('阅片室合集编号无效或重复，未裁剪资料');
    if(typeof row.name!=='string'||!row.name.trim()||row.name.length>80)throw Error('阅片室合集名称无效或超长，未裁剪资料');
    seen.add(row.id);
  }
  chatGalleryReceiptText(rows); // Complete unknown fields are retained or refused.
  return rows;
}
