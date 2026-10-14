import {readFileSync} from 'node:fs';
import sharp from 'sharp';

// Metadata accepts bounded PNG only. Never publish the original Telegram file,
// its EXIF, filename, file ID or download URL.
export async function tokenImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 10_000_000) throw Error('IMAGE_SIZE');
  try {
    const input=sharp(bytes,{limitInputPixels:16_000_000,animated:false,failOn:'error'});
    const meta=await input.metadata();
    if (!['jpeg','png','webp'].includes(meta.format) || meta.pages > 1) throw Error();
    for(const size of [512,384,256]) {
      const png=await sharp(bytes,{limitInputPixels:16_000_000}).rotate().resize(size,size,{fit:'inside',withoutEnlargement:true}).png({compressionLevel:9,palette:true,colours:128}).toBuffer();
      if(png.length <= 262144) return png.toString('base64');
    }
  } catch {}
  throw Error('IMAGE_INVALID');
}

let fallback;
export function defaultTokenImage(){return fallback??=(tokenImage(readFileSync(new URL('../assets/default-token.png',import.meta.url))).catch(error=>{fallback=undefined;throw error;}));}
